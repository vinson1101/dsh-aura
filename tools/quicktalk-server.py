#!/usr/bin/env python3
"""Private, single-worker QuickTalk WAV-to-MP4 HTTP service."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import tempfile
import threading
import time
import wave

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 300
MAX_FRAMES = MAX_AUDIO_SECONDS * SAMPLE_RATE
MAX_UPLOAD = MAX_FRAMES * 2 + 4096
UPLOAD_TIMEOUT = 60
SOCKET_TIMEOUT = 15
STREAM_FPS = 25
FIRST_PART_FRAMES = 25
FOLLOWING_PART_FRAMES = 50
MAX_BOX_BYTES = 64 * 1024 * 1024
JOB_TTL = 600
MAX_ACTIVE = 4
MAX_RECORDS = 128
JOB_ROUTE = re.compile(r"/v1/jobs/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(/media|/init|/parts/([0-9]{1,5}))?")


@dataclass
class Part:
    offset: int
    size: int
    start: float = 0
    duration: float = 0


@dataclass
class Job:
    directory: Path
    state: str = "queued"
    active: bool = True
    updated: float = field(default_factory=time.monotonic)
    cancelled: threading.Event = field(default_factory=threading.Event)
    streaming: bool = False
    init: Part = None
    parts: list = field(default_factory=list)
    metrics: dict = None


class Cancelled(Exception):
    pass


def check_cancelled(cancelled):
    if cancelled.is_set():
        raise Cancelled()


def wav_frames(body):
    with wave.open(io.BytesIO(body), "rb") as audio:
        count = audio.getnframes()
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (
            1, 2, SAMPLE_RATE, "NONE"
        ) or not 0 < count <= MAX_FRAMES:
            raise ValueError("invalid WAV format")
        frames = audio.readframes(count)
    if len(frames) != count * 2:
        raise ValueError("incomplete WAV data")
    return frames


def verify_media(path):
    # Decode every frame and require both tracks. A playable header alone can hide a partial render.
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-threads", "2", "-i", str(path),
         "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"],
        check=True, timeout=120, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    details = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=format_name,duration",
         "-of", "json", str(path)],
        timeout=10, stderr=subprocess.DEVNULL,
    )
    info = json.loads(details)["format"]
    if "mp4" not in info["format_name"].split(",") or not 0 < float(info["duration"]) <= MAX_AUDIO_SECONDS + 1:
        raise ValueError("invalid MP4 format")


def read_box(source):
    header = source.read(8)
    if not header:
        return None
    if len(header) != 8:
        raise ValueError("incomplete MP4 header")
    size, kind = struct.unpack(">I4s", header)
    if size == 1:
        header += source.read(8)
        if len(header) != 16:
            raise ValueError("incomplete extended MP4 header")
        size = struct.unpack_from(">Q", header, 8)[0]
    if not len(header) <= size <= MAX_BOX_BYTES:
        raise ValueError("invalid MP4 box size")
    data = source.read(size - len(header))
    if len(data) != size - len(header):
        raise ValueError("incomplete MP4 box")
    return kind, header, data


def fragment_frames(moof):
    count = 0
    source = io.BytesIO(moof)
    while (box := read_box(source)) is not None:
        if box[0] != b"traf":
            continue
        track = io.BytesIO(box[2])
        while (child := read_box(track)) is not None:
            if child[0] == b"trun":
                count += struct.unpack_from(">I", child[2], 4)[0]
    if not 0 < count <= FOLLOWING_PART_FRAMES:
        raise ValueError("invalid number of MP4 fragment samples")
    return count


def spool_fragments(source, path, cancelled, publish):
    with path.open("wb") as spool:
        def write_box(expected, box):
            if box is None or box[0] != expected:
                raise ValueError(f"missing MP4 box {expected!r}")
            spool.write(box[1])
            spool.write(box[2])

        check_cancelled(cancelled)
        write_box(b"ftyp", read_box(source))
        write_box(b"moov", read_box(source))
        spool.flush()
        publish(Part(0, spool.tell()))
        frames = 0
        while (moof := read_box(source)) is not None:
            check_cancelled(cancelled)
            offset = spool.tell()
            write_box(b"moof", moof)
            count = fragment_frames(moof[2])
            write_box(b"mdat", read_box(source))
            spool.flush()
            publish(Part(offset, spool.tell() - offset, frames / STREAM_FPS, count / STREAM_FPS))
            frames += count
        if not frames:
            raise ValueError("missing MP4 fragments")


def encode_fragments(frames, source_fps, width, height, path, cancelled, publish):
    keyframes = f"expr:gte(n,{FIRST_PART_FRAMES}+{FOLLOWING_PART_FRAMES}*n_forced)"
    command = [
        "ffmpeg", "-nostdin", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s", f"{width}x{height}", "-framerate", str(source_fps),
        "-probesize", "32", "-analyzeduration", "0", "-i", "pipe:0",
        "-vf", f"fps={STREAM_FPS},format=yuv420p", "-c:v", "libx264",
        "-profile:v", "high", "-level:v", "3.1", "-preset", "veryfast", "-tune", "zerolatency", "-crf", "18",
        "-threads", "2", "-bf", "0", "-g", str(FOLLOWING_PART_FRAMES), "-sc_threshold", "0",
        "-force_key_frames", keyframes, "-an", "-f", "mp4", "-flush_packets", "1",
        "-movflags", "+empty_moov+default_base_moof+frag_keyframe+skip_trailer", "pipe:1",
    ]
    errors = []
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as encoder:
        def read_output():
            try:
                spool_fragments(encoder.stdout, path, cancelled, publish)
            except Exception as error:
                errors.append(error)
            finally:
                encoder.stdout.close()

        reader = threading.Thread(target=read_output)
        reader.start()
        generation = 0
        encoding = 0
        count = 0
        first_frame = None
        started = time.perf_counter()
        try:
            before_frame = started
            for frame in frames:
                after_frame = time.perf_counter()
                generation += after_frame - before_frame
                if count == 0:
                    first_frame = after_frame - started
                check_cancelled(cancelled)
                encoder.stdin.write(frame.tobytes())
                encoder.stdin.flush()
                before_frame = time.perf_counter()
                encoding += before_frame - after_frame
                count += 1
            encoding_started = time.perf_counter()
            encoder.stdin.close()
            status = encoder.wait(timeout=30)
            reader.join()
            encoding += time.perf_counter() - encoding_started
            check_cancelled(cancelled)
            if errors:
                raise errors[0]
            if status:
                raise RuntimeError("fragment encoder failed")
        finally:
            if encoder.poll() is None:
                encoder.kill()
                encoder.wait()
            reader.join()
    return {
        "frames": count, "sourceFps": source_fps, "streamFps": STREAM_FPS,
        "firstFrameSeconds": first_frame, "frameGenerationSeconds": generation,
        "renderFps": count / generation if generation > 0 else None, "encodingSeconds": encoding,
    }


def render_fragments(worker, audio, output, cancelled, publish):
    started = time.perf_counter()
    first_part = None

    def publish_timed(part):
        nonlocal first_part
        if part.duration and first_part is None:
            first_part = time.perf_counter() - started
        publish(part)

    reps, feature_seconds = worker.prepare_wav_features(audio)
    check_cancelled(cancelled)
    height, width = worker.frames[0].shape[:2]
    path = audio.parent / "video.fmp4"
    state = worker.make_state()
    metrics = encode_fragments(
        worker.generate_frames_from_reps(reps, state=state),
        worker.fps, width, height, path, cancelled, publish_timed,
    )
    check_cancelled(cancelled)
    mux_started = time.perf_counter()
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-i", str(audio),
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-movflags", "+faststart", str(output)],
        check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    metrics["audioFeatureSeconds"] = feature_seconds
    metrics["firstPartSeconds"] = first_part
    metrics["muxSeconds"] = time.perf_counter() - mux_started
    return metrics


class Server(ThreadingHTTPServer):
    def __init__(self, port, directory, token, health, render, verify=verify_media, render_stream=None):
        self.directory = directory
        self.token = token.encode()
        self.health = health
        self.render = render
        self.render_stream = render_stream
        self.verify = verify
        self.lock = threading.Lock()
        self.jobs = {}
        self.executor = ThreadPoolExecutor(max_workers=1)
        super().__init__(("127.0.0.1", port), Handler)

    def discard_files(self, job):
        shutil.rmtree(job.directory, ignore_errors=True)

    def service_actions(self):
        expiry = time.monotonic() - JOB_TTL
        with self.lock:
            for key, job in list(self.jobs.items()):
                if not job.active and job.updated < expiry:
                    self.discard_files(job)
                    del self.jobs[key]

    def finish(self, job, state):
        # Called with the lock held so DELETE can never race publication.
        job.state = "cancelled" if job.cancelled.is_set() else state
        job.active = False
        job.updated = time.monotonic()
        if job.state != "ready":
            job.init = None
            job.parts.clear()
            self.discard_files(job)

    def publish(self, job, part):
        with self.lock:
            check_cancelled(job.cancelled)
            if part.duration:
                job.parts.append(part)
            else:
                job.init = part

    def run_job(self, job):
        audio_path = job.directory / "input.wav"
        output_path = job.directory / "response.mp4"
        try:
            with self.lock:
                check_cancelled(job.cancelled)
                job.state = "running"
            metrics = None
            if job.streaming:
                metrics = self.render_stream(audio_path, output_path, job.cancelled, lambda part: self.publish(job, part))
            else:
                self.render(audio_path, output_path, job.cancelled)
            check_cancelled(job.cancelled)
            self.verify(output_path)
            audio_path.unlink()
            state = "ready"
        except Cancelled:
            state = "cancelled"
        except Exception as error:
            # Model and subprocess exceptions can contain local paths or other sensitive data.
            print(f"QuickTalk render failed ({type(error).__name__})", flush=True)
            state = "failed"
        with self.lock:
            if state == "ready" and not job.cancelled.is_set():
                job.metrics = metrics
            self.finish(job, state)

    def handle_error(self, request, client_address):
        print("QuickTalk HTTP request ended unexpectedly", flush=True)

    def server_close(self):
        with self.lock:
            for job in self.jobs.values():
                job.cancelled.set()
        super().server_close()
        self.executor.shutdown(wait=True)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(SOCKET_TIMEOUT)
        super().setup()

    def log_message(self, format, *args):
        pass

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        header = self.headers.get("Authorization", "")
        if hmac.compare_digest(header.encode(), b"Bearer " + self.server.token):
            return True
        self.reply(401, {"error": "unauthorized"})
        return False

    def route(self, allow_media=False):
        match = JOB_ROUTE.fullmatch(self.path)
        if match and (allow_media or not match[2]):
            return match
        self.reply(404, {"error": "not found"})
        return None

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == "/health":
            self.reply(200, self.server.health)
            return
        match = self.route(allow_media=True)
        if not match:
            return
        with self.server.lock:
            job = self.server.jobs.get(match[1])
            state = job.state if job else None
            media = None
            segment = None
            if match[2] == "/media" and state == "ready":
                media = (job.directory / "response.mp4").open("rb")
            if match[2] and state in ("running", "ready"):
                if match[2] == "/init":
                    segment = job.init
                elif match[3] is not None and int(match[3]) < len(job.parts):
                    segment = job.parts[int(match[3])]
                if segment:
                    media = (job.directory / "video.fmp4").open("rb")
            payload = {"state": state}
            if state == "failed":
                payload["error"] = "QuickTalk generation failed"
            if job and job.streaming:
                payload["initReady"] = job.init is not None and state in ("running", "ready")
                payload["parts"] = [
                    {"index": index, "startSeconds": part.start, "durationSeconds": part.duration}
                    for index, part in enumerate(job.parts)
                ]
                if job.metrics is not None:
                    payload["metrics"] = job.metrics
        if not job or (match[2] and not media):
            self.reply(404, {"error": "not found"})
        elif media:
            with media:
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                size = segment.size if segment else os.fstat(media.fileno()).st_size
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if segment:
                    media.seek(segment.offset)
                    while size:
                        block = media.read(min(size, 64 * 1024))
                        if not block:
                            break
                        self.wfile.write(block)
                        size -= len(block)
                else:
                    shutil.copyfileobj(media, self.wfile)
        else:
            self.reply(200, payload)

    def do_DELETE(self):
        if not self.authorized():
            return
        match = self.route()
        if not match:
            return
        with self.server.lock:
            job = self.server.jobs.get(match[1])
            if not job and len(self.server.jobs) >= MAX_RECORDS:
                status, payload = 429, {"error": "QuickTalk is busy"}
            else:
                if not job:
                    job = Job(self.server.directory / match[1], active=False)
                    self.server.jobs[match[1]] = job
                job.cancelled.set()
                job.state = "cancelled"
                job.init = None
                job.parts.clear()
                job.updated = time.monotonic()
                if not job.active:
                    self.server.discard_files(job)
                status, payload = 202, {"state": "cancelled"}
        self.reply(status, payload)

    def upload_frames(self, size, cancelled):
        body = bytearray()
        deadline = time.monotonic() + UPLOAD_TIMEOUT
        while len(body) < size:
            check_cancelled(cancelled)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError()
            self.connection.settimeout(remaining)
            chunk = self.rfile.read1(min(size - len(body), 64 * 1024))
            if not chunk:
                raise EOFError()
            body.extend(chunk)
        self.connection.settimeout(SOCKET_TIMEOUT)
        return wav_frames(body)

    def do_POST(self):
        if not self.authorized():
            return
        match = self.route()
        if not match:
            return
        if self.headers.get_content_type() != "audio/wav":
            self.reply(415, {"error": "expected audio/wav"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,10}", lengths[0]):
            self.reply(400, {"error": "expected Content-Length"})
            return
        size = int(lengths[0])
        if not 0 < size <= MAX_UPLOAD:
            self.reply(413, {"error": "WAV exceeds size limit"})
            return
        streaming = self.headers.get("X-QuickTalk-Parts") == "1"
        if streaming and self.server.render_stream is None:
            self.reply(400, {"error": "QuickTalk parts are unavailable"})
            return
        with self.server.lock:
            job = self.server.jobs.get(match[1])
            if job:
                status, payload = 409, {"state": job.state}
            elif len(self.server.jobs) >= MAX_RECORDS or sum(job.active for job in self.server.jobs.values()) >= MAX_ACTIVE:
                status, payload = 429, {"error": "QuickTalk is busy"}
            else:
                job = Job(self.server.directory / match[1], streaming=streaming)
                self.server.jobs[match[1]] = job
                status, payload = 202, {"state": "queued"}
        if status != 202:
            self.reply(status, payload)
            return

        try:
            frames = self.upload_frames(size, job.cancelled)
            with self.server.lock:
                check_cancelled(job.cancelled)
                job.directory.mkdir()
                with wave.open(str(job.directory / "input.wav"), "wb") as audio:
                    audio.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
                    audio.writeframes(frames)
                self.server.executor.submit(self.server.run_job, job)
        except Cancelled:
            with self.server.lock:
                self.server.finish(job, "cancelled")
            status, payload = 409, {"state": "cancelled"}
        except (ValueError, wave.Error, EOFError, TimeoutError):
            with self.server.lock:
                self.server.finish(job, "failed")
            status, payload = 400, {"error": f"expected complete 16 kHz mono PCM16 WAV, up to {MAX_AUDIO_SECONDS} seconds"}
        except (OSError, RuntimeError):
            with self.server.lock:
                self.server.finish(job, "failed")
            status, payload = 500, {"error": "QuickTalk could not accept the job"}
        self.reply(status, payload)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_worker(args):
    import random

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["OMP_NUM_THREADS"] = str(args.cpu_threads)
    os.environ["MKL_NUM_THREADS"] = str(args.cpu_threads)
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    import numpy as np
    import torch
    from opentalking.models.quicktalk import runtime, runtime_v2

    random.seed(0)
    np.random.seed(0)
    torch.manual_seed(0)
    torch.set_num_threads(args.cpu_threads)
    torch.set_num_interop_threads(1)
    torch.cuda.set_per_process_memory_fraction(0.028, "cuda:0")

    class CPUFaceDetector(runtime_v2.FaceDetector):
        def __init__(self, model_root, device):
            super().__init__(model_root, device="cpu")

    class Worker(runtime.RealtimeV3Worker):
        cancelled = None

        def generate_frames_from_reps(self, reps, state=None):
            if self.cancelled is not None:
                check_cancelled(self.cancelled)
            for frame in super().generate_frames_from_reps(reps, state=state):
                if self.cancelled is not None:
                    check_cancelled(self.cancelled)
                yield frame

        def render(self, audio, output, cancelled):
            self.cancelled = cancelled
            try:
                check_cancelled(cancelled)
                self.reset_state()
                self.generate_video_from_wav(audio, output)
            finally:
                self.cancelled = None

    # The upstream worker uses one device for face detection and rendering at construction.
    detector = runtime_v2.FaceDetector
    runtime_v2.FaceDetector = CPUFaceDetector
    try:
        worker = Worker(
            asset_root=args.asset_root, template_video=args.template, face_cache_dir=args.cache_dir,
            batch_size=1, device="cuda:0", hubert_device="cpu", model_backend="pth",
        )
    finally:
        runtime_v2.FaceDetector = detector
    worker.cpu_threads = torch.get_num_threads()
    inputs = [
        Path(__file__), Path(runtime.__file__), Path(runtime_v2.__file__),
        worker.v2.pth_path, worker.v2.repair_path,
        *(path for path in sorted(worker.v2.hubert_path.rglob("*")) if path.is_file()),
        *(path for path in sorted(worker.v2.aux_root.rglob("*.onnx")) if path.is_file()),
    ]
    engine_hash = hashlib.sha256("".join(sha256(path) for path in inputs).encode()).hexdigest()
    return worker, engine_hash


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("asset-root", "template", "cache-dir", "work-dir"):
        parser.add_argument(f"--{option}", required=True, type=Path)
    parser.add_argument("--port", default=18765, type=int)
    parser.add_argument("--cpu-threads", default=4, type=int, help="CPU threads for HuBERT inference (default: 4)")
    args = parser.parse_args()
    if args.cpu_threads < 1:
        parser.error("--cpu-threads must be positive")

    token = os.environ.pop("QUICKTALK_TOKEN", "")
    if not token or not token.isascii() or not token.isprintable() or " " in token:
        parser.error("QUICKTALK_TOKEN must contain a bearer token")
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            parser.error(f"{tool} was not found")
    if not (args.asset_root / "checkpoints").is_dir() and (args.asset_root / "hdModule").is_dir():
        args.asset_root /= "hdModule"
    source_hash = sha256(args.template)
    worker, engine_hash = load_worker(args)
    health = {
        "ready": True,
        "version": "quicktalk-v3",
        "parts": True,
        "cpuThreads": worker.cpu_threads,
        "engineSha256": engine_hash,
        "sourceSha256": source_hash,
    }
    args.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="quicktalk-", dir=args.work_dir) as directory:
        def stream(audio, output, cancelled, publish):
            return render_fragments(worker, audio, output, cancelled, publish)

        with Server(args.port, Path(directory), token, health, worker.render, render_stream=stream) as server:
            signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
            print(f"QuickTalk ready on 127.0.0.1:{server.server_port}", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
