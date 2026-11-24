#!/usr/bin/env python3
"""Local-only, reproducible single-turn assets. No generation, network or model use.

Run with the bundled Python (Pillow + numpy); requires ffmpeg/ffprobe on PATH.
The source files are read-only. Only assets/runtime/short-hair is written.
"""
import argparse
import io
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/runtime/short-hair'
SOURCE = ROOT / 'assets/previews/短发直播测试/首尾衔接预演'
MASTER = ROOT / 'assets/characters/短发人物定妆/半身定妆-脸型妆容与短发.png'
SOURCES = {'turn': SOURCE / '拨号回看.mp4', 'listen': SOURCE / '正面倾听循环.mp4',
           'roundtrip': SOURCE / '侧身待机往返.mp4'}


def run(*args):
    return subprocess.run([str(a) for a in args], check=True, stdout=subprocess.PIPE).stdout


def probe(file):
    return json.loads(run('ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file))


def frame(file, t):
    return Image.open(io.BytesIO(run('ffmpeg', '-v', 'error', '-ss', t, '-i', file,
                                    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'))).convert('RGB')


def sheet(rows, filename, cell=(224, 285)):
    cols = max(len(row) for row in rows)
    w, h = cell
    image = Image.new('RGB', (cols * w, len(rows) * (h + 25)), '#252525')
    draw = ImageDraw.Draw(image)
    for r, row in enumerate(rows):
        for c, (label, img) in enumerate(row):
            fitted = img.copy()
            fitted.thumbnail((w, h), Image.Resampling.LANCZOS)
            image.paste(fitted, (c * w + (w - fitted.width) // 2, r * (h + 25)))
            draw.text((c * w + 4, r * (h + 25) + h + 4), label, fill='white')
    image.save(filename, quality=94)


def inspect():
    rows = [[('approved master', Image.open(MASTER).convert('RGB'))]]
    for name, times in [('turn', [0, 0.5, 1, 2, 3, 4, 5, 6]),
                        ('listen', [0, 0.5, 1, 2, 4, 6, 9, 11.7]),
                        ('roundtrip', [0, 1, 3, 5, 6, 8, 10, 11.733])]:
        rows.append([(f'{name} {t:.3f}s', frame(SOURCES[name], t)) for t in times])
    sheet(rows, OUT / 'inspection/source-contact.jpg')
    (OUT / 'inspection/source-metadata.json').write_text(
        json.dumps({name: probe(file) for name, file in SOURCES.items()}, ensure_ascii=False, indent=2) + '\n')


def build_video(source, target, background, start_frame=0):
    """Match a fixed empty-background patch; never reshape, mask or retouch a face.

    The previews fade from a neutral master into a slightly green/darker plate.
    A small whole-frame RGB offset, measured independently on each source frame,
    removes that cast while preserving all source geometry and performance.
    """
    width, height = 560, 712
    decoder = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-i', str(source), '-an', '-vf',
        f'trim=start_frame={start_frame},setpts=PTS-STARTPTS',
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    encoder = subprocess.Popen([
        'ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
        '-s', f'{width}x{height}', '-r', '30', '-i', '-', '-an', '-map_metadata', '-1',
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-g', '30',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(target)], stdin=subprocess.PIPE)
    offsets = []
    try:
        while True:
            data = decoder.stdout.read(width * height * 3)
            if not data:
                break
            if len(data) != width * height * 3:
                raise RuntimeError('incomplete decoded frame')
            pixels = np.frombuffer(data, np.uint8).reshape(height, width, 3).astype(np.float32)
            delta = np.clip(background - pixels[80:220, 20:120].mean(axis=(0, 1)), -8, 8)
            offsets.append(delta.tolist())
            encoder.stdin.write(np.clip(np.rint(pixels + delta), 0, 255).astype(np.uint8).tobytes())
    finally:
        decoder.stdout.close()
        encoder.stdin.close()
    if decoder.wait() or encoder.wait():
        raise RuntimeError('ffmpeg failed')
    return {'frames': len(offsets), 'global_rgb_offset_min': np.min(offsets, axis=0).tolist(),
            'global_rgb_offset_max': np.max(offsets, axis=0).tolist()}


def build():
    shutil.copyfile(MASTER, OUT / 'side.png')
    master = Image.open(MASTER).convert('RGB').resize((560, 712), Image.Resampling.LANCZOS)
    background = np.asarray(master, dtype=np.float32)[80:220, 20:120].mean(axis=(0, 1))
    # At 5.3667s the existing round trip is closest to the front listening pose.
    # It contains the already-corrected reverse motion and master-image landing.
    configs = [('turn', SOURCES['turn'], 0), ('listen', SOURCES['listen'], 0),
               ('return', SOURCES['roundtrip'], 161)]
    manifest = {'policy': 'Local reuse only; no generated faces, audio, network or paid assets.',
                'side_source': str(MASTER.relative_to(ROOT)),
                'correction': 'Whole-frame RGB offset from fixed empty patch x20:120 y80:220, capped +/-8/255; no spatial/face edits.',
                'background_target_rgb': background.tolist(), 'assets': {}}
    for name, source, start in configs:
        target = OUT / f'{name}.mp4'
        processing = build_video(source, target, background, start)
        meta = probe(target)
        video = next(s for s in meta['streams'] if s['codec_type'] == 'video')
        manifest['assets'][target.name] = {
            'source': str(source.relative_to(ROOT)), 'source_start_frame': start,
            'source_start_seconds': start / 30, 'codec': video['codec_name'],
            'pixel_format': video['pix_fmt'], 'width': video['width'], 'height': video['height'],
            'fps': video['avg_frame_rate'], 'duration_seconds': float(meta['format']['duration']),
            'audio_streams': sum(s['codec_type'] == 'audio' for s in meta['streams']),
            'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
            **processing}
    manifest['assets']['side.png'] = {'width': 1113, 'height': 1414,
        'bytes': (OUT / 'side.png').stat().st_size,
        'sha256': hashlib.sha256((OUT / 'side.png').read_bytes()).hexdigest(),
        'byte_identical_to_approved_master': (OUT / 'side.png').read_bytes() == MASTER.read_bytes()}
    rows = []
    for name, source, start in configs:
        duration = manifest['assets'][f'{name}.mp4']['duration_seconds']
        times = [0, 1, min(2, duration / 2), duration / 2, duration - 1, duration - 1 / 30]
        rows.append([(f'{name} {t:.3f}s', frame(OUT / f'{name}.mp4', t)) for t in times])
    sheet(rows, OUT / 'inspection/runtime-contact.jpg', cell=(280, 356))
    before_after = [[('approved master', master)]]
    for name, source, start in configs:
        t = 1 if name == 'turn' else 0
        before_after.append([(f'{name} before', frame(source, start / 30 + t)),
                             (f'{name} matched', frame(OUT / f'{name}.mp4', t))])
    sheet(before_after, OUT / 'inspection/color-before-after.jpg', cell=(336, 427))
    pairs = [
        ('side -> turn', master, frame(OUT / 'turn.mp4', 0)),
        ('turn -> listen', frame(OUT / 'turn.mp4', 6), frame(OUT / 'listen.mp4', 0)),
        ('listen loop', frame(OUT / 'listen.mp4', 11.7), frame(OUT / 'listen.mp4', 0)),
        ('listen -> return', frame(OUT / 'listen.mp4', 0), frame(OUT / 'return.mp4', 0)),
        ('return -> side', frame(OUT / 'return.mp4', 191 / 30), master)]
    sheet([[(label + ' A', a), (label + ' B', b)] for label, a, b in pairs],
          OUT / 'inspection/runtime-boundaries.jpg', cell=(280, 356))
    manifest['boundary_rgb_mae_255'] = {
        name: float(np.abs(np.asarray(a, dtype=float) - np.asarray(b, dtype=float)).mean())
        for name, a, b in pairs}
    (OUT / 'inspection/runtime-metadata.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


def build_response():
    """Closed-mouth, forward-only head/shoulder response, NOT stock speech lips.

    Approved runtime return f36..46 approaches a slight tilt; turn f115..125
    straightens with a small smile. The near-matching endpoint closes the loop;
    a one-second neutral hold spaces gestures. No new lips, face warp or audio.
    """
    target = OUT / 'respond.mp4'
    run('ffmpeg', '-v', 'error', '-y', '-i', OUT / 'return.mp4', '-i', OUT / 'turn.mp4',
        '-filter_complex',
        '[0:v]trim=start_frame=36:end_frame=47,setpts=PTS-STARTPTS[a];'
        '[1:v]trim=start_frame=115:end_frame=126,setpts=PTS-STARTPTS[b];'
        '[a][b]concat=n=2:v=1:a=0,setpts=2*PTS,fps=30,tpad=stop_mode=clone:stop_duration=1[v]',
        '-map', '[v]', '-an', '-map_metadata', '-1', '-c:v', 'libx264',
        '-preset', 'slow', '-crf', '18', '-g', '30', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', target)
    metadata = {'policy': 'Existing approved closed-mouth head/shoulder motion only; no phoneme lips or audio.',
                'parts': [{'runtime': 'return.mp4', 'frames_inclusive': [36, 46]},
                          {'runtime': 'turn.mp4', 'frames_inclusive': [115, 125]}],
                'duration_multiplier': 2, 'neutral_hold_seconds': 1, 'probe': probe(target),
                'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}
    (OUT / 'inspection/response-metadata.json').write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    sheet([[(f'respond {t:.2f}s', frame(target, t))
            for t in [0, .25, .5, .75, 1, 1.25, 1.75, 2.3]]],
          OUT / 'inspection/response-contact.jpg', cell=(280, 356))
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect', action='store_true')
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--response', action='store_true', help='Build the independent closed-mouth response from approved runtime clips')
    args = parser.parse_args()
    (OUT / 'inspection').mkdir(parents=True, exist_ok=True)
    if args.inspect:
        inspect()
    if args.build:
        build()
    if args.build or args.response:
        build_response()
    if not (args.inspect or args.build or args.response):
        parser.error('choose --inspect, --build and/or --response')


if __name__ == '__main__':
    main()
