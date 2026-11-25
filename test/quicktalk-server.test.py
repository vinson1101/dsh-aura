"""Run with python3 test/quicktalk-server.test.py (requires ffmpeg and ffprobe)."""

import http.client
import io
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
import wave

# Load the script by its CLI filename without importing any GPU dependencies.
server_module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "tools" / "quicktalk-server.py"))
Server = server_module["Server"]
AUTH = {"Authorization": "Bearer test-local"}
JSON_TYPE = "application/json"
HEALTH = {"ready": True, "version": "quicktalk-v3", "parts": True, "engineSha256": "e" * 64, "sourceSha256": "a" * 64}


class Frame:
    shape = (16, 16, 3)

    def __init__(self, index=0):
        self.index = index

    def tobytes(self):
        return bytes((self.index * 2 % 256, 20, self.index)) * 16 * 16


class FixtureWorker:
    fps = 25
    frames = [Frame()]

    def __init__(self, release):
        self.release = release
        self.feature_calls = 0
        self.state_calls = 0
        self.frame_calls = 0
        self.cancelled = None

    def prepare_wav_features(self, audio):
        self.feature_calls += 1
        with wave.open(str(audio), "rb") as clip:
            return range(clip.getnframes() * self.fps // clip.getframerate()), 0.01

    def make_state(self):
        self.state_calls += 1
        return {"frame": 0}

    def generate_frames_from_reps(self, reps, state):
        self.frame_calls += 1
        for index in reps:
            if index == 30:
                while not self.release.wait(0.01):
                    server_module["check_cancelled"](self.cancelled)
            if state["frame"] != index:
                raise AssertionError("model state reset")
            state["frame"] += 1
            yield Frame(index)


def wav(rate=16_000, channels=1, count=None):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as audio:
        audio.setparams((channels, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x00\x00" * channels * (rate if count is None else count))
    return buffer.getvalue()


def route():
    return f"/v1/jobs/{uuid.uuid4()}"


class Contract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.mp4"
            subprocess.run(
                ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=size=16x16:rate=25",
                 "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=16000",
                 "-t", "1", "-c:v", "libx264", "-c:a", "aac", str(path)],
                check=True,
            )
            cls.media = path.read_bytes()

    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.entered = threading.Event()
        self.release = threading.Event()
        self.worker = FixtureWorker(self.release)
        self.output = self.media
        self.server = Server(0, Path(work.name), "test-local", HEALTH, self.render, render_stream=self.render_stream)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.release.set)

    def render(self, audio, output, cancelled):
        self.entered.set()
        while not self.release.wait(0.01):
            server_module["check_cancelled"](cancelled)
        self.assertTrue(audio.is_file())
        output.write_bytes(self.output)

    def render_stream(self, audio, output, cancelled, publish):
        self.worker.cancelled = cancelled
        return server_module["render_fragments"](self.worker, audio, output, cancelled, publish)

    def request(self, method, path, body=None, authenticated=True, streaming=False):
        headers = dict(AUTH) if authenticated else {}
        if body is not None:
            headers["Content-Type"] = "audio/wav"
        if streaming:
            headers["X-QuickTalk-Parts"] = "1"
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            data = response.read()
            if response.getheader("Content-Type") == JSON_TYPE:
                data = json.loads(data)
            return response.status, data
        finally:
            connection.close()

    def wait_for(self, indicator):
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if indicator():
                return
            time.sleep(0.01)
        self.fail("timed out waiting for condition")

    def test_auth_and_ready_media(self):
        job = route()
        for method, path in (("GET", "/health"), ("GET", job), ("GET", job + "/media"),
                             ("POST", job), ("DELETE", job)):
            self.assertEqual(self.request(method, path, authenticated=False)[0], 401)
        self.assertEqual(self.request("GET", "/health"), (200, HEALTH))
        self.assertEqual(self.request("POST", job, wav()), (202, {"state": "queued"}))
        self.assertTrue(self.entered.wait(1))
        self.assertEqual(self.request("GET", job), (200, {"state": "running"}))
        self.assertEqual(self.request("GET", job + "/media")[0], 404)
        self.release.set()
        self.wait_for(lambda: self.request("GET", job) == (200, {"state": "ready"}))
        self.assertEqual(self.request("GET", job + "/media"), (200, self.media))
        self.assertEqual(self.request("DELETE", job), (202, {"state": "cancelled"}))
        self.assertEqual(self.request("GET", job + "/media")[0], 404)
        self.assertFalse(list(self.server.directory.iterdir()))

    def test_rejects_nonpositive_cpu_threads_before_worker_load(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parents[1] / "tools" / "quicktalk-server.py"),
             "--asset-root", ".", "--template", ".", "--cache-dir", ".", "--work-dir", ".", "--cpu-threads", "0"],
            capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("--cpu-threads must be positive", result.stderr)

    def test_accepts_long_wav_through_five_minutes(self):
        for seconds in (26, 300):
            with self.subTest(seconds=seconds):
                self.assertEqual(self.request("POST", route(), wav(count=seconds * 16_000))[0], 202)

    def test_invalid_upload_and_unplayable_output(self):
        for invalid in (b"invalid", wav(rate=8000), wav(channels=2), wav()[:-3], wav(count=300 * 16_000 + 1)):
            self.assertEqual(self.request("POST", route(), invalid)[0], 400)
        with self.subTest("oversized Content-Length"):
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
            try:
                headers = dict(AUTH, **{"Content-Type": "audio/wav", "Content-Length": str(server_module["MAX_UPLOAD"] + 1)})
                connection.request("POST", route(), headers=headers)
                self.assertEqual(connection.getresponse().status, 413)
            finally:
                connection.close()
        self.assertEqual(self.request("POST", "/v1/jobs/../escape", wav())[0], 404)
        self.assertFalse(self.entered.is_set())
        self.output = self.media[:100]
        self.release.set()
        job = route()
        self.assertEqual(self.request("POST", job, wav())[0], 202)
        self.wait_for(lambda: self.request("GET", job)[1]["state"] == "failed")
        self.assertEqual(self.request("GET", job + "/media")[0], 404)
        self.assertFalse(list(self.server.directory.iterdir()))

    def test_cancel_before_and_during_upload(self):
        job = route()
        self.assertEqual(self.request("DELETE", job)[0], 202)
        self.assertEqual(self.request("POST", job, wav()), (409, {"state": "cancelled"}))
        job = route()
        payload = wav()
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        self.addCleanup(connection.close)
        connection.putrequest("POST", job)
        for header, value in dict(AUTH, **{"Content-Type": "audio/wav", "Content-Length": str(len(payload))}).items():
            connection.putheader(header, value)
        connection.endheaders(payload[:100])
        self.wait_for(lambda: self.request("GET", job) == (200, {"state": "queued"}))
        self.assertEqual(self.request("DELETE", job)[0], 202)
        connection.send(payload[100:])
        self.assertEqual(connection.getresponse().status, 409)
        self.assertEqual(self.request("GET", job), (200, {"state": "cancelled"}))
        self.assertFalse(self.entered.is_set())

    def test_queue_bound_and_running_cancel(self):
        jobs = [route() for _ in range(server_module["MAX_ACTIVE"])]
        for job in jobs:
            self.assertEqual(self.request("POST", job, wav())[0], 202)
        self.assertTrue(self.entered.wait(1))
        self.assertEqual(self.request("GET", jobs[1]), (200, {"state": "queued"}))
        self.assertEqual(self.request("POST", route(), wav())[0], 429)
        for job in reversed(jobs):
            self.assertEqual(self.request("DELETE", job)[0], 202)
        self.wait_for(lambda: not list(self.server.directory.iterdir()))
        self.assertEqual(self.request("GET", jobs[0]), (200, {"state": "cancelled"}))

    def test_expiry_cleans_ready_media_and_cancellation_record(self):
        ready, cancelled = route(), route()
        self.release.set()
        self.assertEqual(self.request("POST", ready, wav())[0], 202)
        self.assertEqual(self.request("DELETE", cancelled)[0], 202)
        self.wait_for(lambda: self.request("GET", ready) == (200, {"state": "ready"}))
        with self.server.lock:
            for job in self.server.jobs.values():
                job.updated -= server_module["JOB_TTL"] + 1
        self.server.service_actions()
        self.assertEqual(self.request("GET", ready + "/media")[0], 404)
        self.assertEqual(self.request("GET", cancelled)[0], 404)
        self.assertFalse(list(self.server.directory.iterdir()))

    def test_streamable_fragments_before_full_media(self):
        job = route()
        self.assertEqual(self.request("POST", job, wav(count=64_000), streaming=True)[0], 202)
        self.wait_for(lambda: len(self.request("GET", job)[1]["parts"]) == 1)
        self.assertEqual(
            self.request("GET", job),
            (200, {"state": "running", "initReady": True, "parts": [{"index": 0, "startSeconds": 0, "durationSeconds": 1}]}),
        )
        for target in ("/init", "/parts/0"):
            self.assertEqual(self.request("GET", job + target, authenticated=False)[0], 401)
        self.assertEqual(self.request("GET", job + "/parts/1")[0], 404)
        self.assertEqual(self.request("GET", job + "/media")[0], 404)
        init = self.request("GET", job + "/init")[1]
        first = self.request("GET", job + "/parts/0")[1]
        profile = init.index(b"avcC") + 4
        self.assertEqual(init[profile:profile + 4], bytes((1, 100, 0, 31)))
        self.assertEqual(first[4:8], b"moof")
        self.assertIn(b"crf=18.0", first)
        self.release.set()
        self.wait_for(lambda: self.request("GET", job)[1]["state"] == "ready")
        status = self.request("GET", job)[1]
        self.assertEqual(status["parts"], [
            {"index": 0, "startSeconds": 0, "durationSeconds": 1},
            {"index": 1, "startSeconds": 1, "durationSeconds": 2},
            {"index": 2, "startSeconds": 3, "durationSeconds": 1},
        ])
        self.assertEqual(status["metrics"]["frames"], 100)
        self.assertGreater(status["metrics"]["renderFps"], 0)
        self.assertGreater(status["metrics"]["encodingSeconds"], 0)
        self.assertGreater(status["metrics"]["firstPartSeconds"], 0)
        self.assertEqual((self.worker.feature_calls, self.worker.state_calls, self.worker.frame_calls), (1, 1, 1))
        stream = init + b"".join(self.request("GET", job + f"/parts/{i}")[1] for i in range(3))
        media = self.request("GET", job + "/media")[1]
        self.assertEqual(self.video_hash(stream), self.video_hash(media))

    def test_cancel_hides_published_fragments(self):
        job = route()
        self.assertEqual(self.request("POST", job, wav(count=64_000), streaming=True)[0], 202)
        self.wait_for(lambda: len(self.request("GET", job)[1]["parts"]) == 1)
        self.assertEqual(self.request("DELETE", job)[0], 202)
        self.assertEqual(self.request("GET", job), (200, {"state": "cancelled", "initReady": False, "parts": []}))
        self.assertEqual(self.request("GET", job + "/init")[0], 404)
        self.assertEqual(self.request("GET", job + "/parts/0")[0], 404)
        self.wait_for(lambda: not list(self.server.directory.iterdir()))

    def test_short_fragment_from_nonstandard_source_fps(self):
        self.worker.fps = 30
        job = route()
        self.assertEqual(self.request("POST", job, wav(count=12_800), streaming=True)[0], 202)
        self.wait_for(lambda: self.request("GET", job)[1]["state"] == "ready")
        status = self.request("GET", job)[1]
        self.assertEqual(status["parts"], [{"index": 0, "startSeconds": 0, "durationSeconds": 0.8}])
        self.assertEqual(status["metrics"]["frames"], 24)
        self.assertEqual(status["metrics"]["streamFps"], 25)

    def video_hash(self, media):
        return subprocess.check_output(
            ["ffmpeg", "-v", "error", "-xerror", "-i", "pipe:0", "-map", "0:v:0", "-f", "hash", "-"],
            input=media, timeout=5,
        )


if __name__ == "__main__":
    unittest.main()
