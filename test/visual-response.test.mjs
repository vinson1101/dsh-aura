// Unit/fixture tests only: NO LatentSync inference, no real TTS, no paid API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createVisualResponse, pcmWave, validateVisualRequest, visualConfig, runVisualProcess } from '../visual-response.js';

const root = await mkdtemp(path.join(tmpdir(), 'aura-visual-unit-'));
const services = [];
const hash = x => createHash('sha256').update(x).digest('hex');
const request = { text: '这是本次任务的真实回复内容。', voice: 'longyan_v3', model: 'cosyvoice-v3-flash', taskId: 'task-a', sessionId: 'session-a' };
function owner() {
  let current = 'owner-a'; const resources = new Set();
  return {
    authorize(token, stop) {
      if (token !== current) return null;
      resources.add(stop); return () => resources.delete(stop);
    },
    release(reason = 'socket-close') { current = 'owner-b'; for (const stop of [...resources]) stop(reason); resources.clear(); },
    get resources() { return resources.size; },
  };
}
const pcm = Buffer.alloc(16000); // .5 second identifiable PCM fixture, not TTS.
for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(5000 * Math.sin(i / 20)), i * 2);
const fixtureMedia = Buffer.from('not-a-real-video: unit lifecycle fixture only');
function harness(extra = {}) {
  const seat = owner(), events = [], calls = { tts: 0, render: 0, verify: 0 };
  let rejection;
  const config = { enabled: true, workDir: path.join(root, 'run-' + services.length) };
  const service = createVisualResponse({
    config, instance: seat, connection: () => ({ requestRejection: () => rejection }),
    diagnostic: async evidence => events.push(evidence),
    preflight: async () => ({ source: 'unit-source', wrapper: 'unit-wrapper', engine: 'unit-engine' }),
    tts: { async stream({ onChunk, text }) { calls.tts++; assert.ok(request.text.includes(text)); onChunk(pcm.subarray(0, 4000)); onChunk(pcm.subarray(4000)); } },
    render: async (job, cfg, progress) => {
      calls.render++; progress('rendering', { step: 3, steps: 20, chunk: 1, decodedFrames: 0, renderElapsedSeconds: 8.4 });
      await writeFile(path.join(job.dir, 'ready.mp4'), fixtureMedia);
    },
    verify: async (job, file) => { calls.verify++; return { media: hash(await readFile(file)), decoded: true }; },
    ...extra,
  });
  services.push(service);
  return { service, seat, events, calls, config, deny: value => { rejection = value; } };
}
async function settled(service, id, token = 'owner-a') {
  for (let i = 0; i < 1000; i++) {
    const value = service.get(id, token);
    if (value.state !== 'preparing') return value;
    await delay(10);
  }
  assert.fail('Unit fixture did not settle');
}
try {
  const config = visualConfig({ enabled: false }, { AURA_LATENTSYNC_ENABLED: '1' });
  assert.equal(config.enabled, false, 'explicit disabled overrides env'); assert.ok(Object.isFrozen(config));
  assert.equal(visualConfig({}, { AURA_LATENTSYNC_ENABLED: '1' }).enabled, true);
  assert.throws(() => visualConfig({ workDir: '/tmp/space path' }));
  assert.throws(() => visualConfig({ envDir: 'relative/path' }));
  assert.throws(() => visualConfig({ enabled: 'true' }));
  for (const invalid of [null, [], {}, { ...request, text: '' }, { ...request, text: 'x'.repeat(241) },
    { ...request, taskId: '' }, { ...request, sessionId: 3 }, { ...request, voice: 'longanyang' },
    { ...request, voice: '--shell=bad' }, { ...request, voice: 'unknown' }, { ...request, model: 'cosyvoice-v3.5-flash' },
    { ...request, command: '/bin/sh' }, { ...request, source: '/etc/passwd' }, { ...request, text: 'a\u0000b' }]) {
    assert.throws(() => validateVisualRequest(invalid), { status: 400 });
  }
  assert.throws(() => validateVisualRequest({ ...request, voice: undefined }), { status: 400 }, 'never substitute a default for the current voice');
  const wav = pcmWave(pcm);
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1);
  assert.deepEqual(wav.subarray(44), pcm); assert.throws(() => pcmWave(Buffer.alloc(3)));
  assert.throws(() => pcmWave(Buffer.alloc(25 * 32000 + 2)));

  const disabled = harness({ config: { enabled: false, workDir: path.join(root, 'disabled') } });
  assert.throws(() => disabled.service.create(request, 'owner-a'), { status: 503 });
  assert.equal(disabled.calls.tts, 0);
  const h = harness();
  assert.throws(() => h.service.create({ ...request, path: '/etc/passwd' }, 'owner-a'), { status: 400 });
  assert.equal(h.calls.tts, 0);
  assert.throws(() => h.service.create(request, 'stale'), { status: 409 });
  const first = h.service.create(request, 'owner-a');
  assert.equal(first.state, 'preparing'); assert.equal(first.stage, 'preflight'); assert.equal(first.cacheHit, false);
  assert.equal('cancelReason' in first, false); assert.equal('cancelStage' in first, false);
  assert.equal(h.calls.tts, 0, 'POST allocation returns before paid/provider work');
  assert.equal(h.service.create(request, 'owner-a').id, first.id, 'exact duplicate returns same job');
  assert.throws(() => h.service.create({ ...request, text: '另一条回复' }, 'owner-a'), { status: 409 });
  assert.throws(() => h.service.create({ ...request, taskId: 'other' }, 'owner-a'), { status: 429 });
  assert.throws(() => h.service.get(first.id, 'owner-b'), { status: 404 });
  assert.throws(() => h.service.get('../secret', 'owner-a'), { status: 400 });
  const ready = await settled(h.service, first.id);
  assert.equal(ready.state, 'ready'); assert.equal(h.calls.tts, 1); assert.equal(h.calls.render, 1);
  assert.equal(ready.progress.step, 3); assert.equal(ready.progress.renderElapsedSeconds, 8.4, 'only actual renderer progress forwarded');
  assert.equal(ready.duration, .5); assert.ok(ready.elapsedSeconds >= 0);
  assert.ok(ready.mediaUrl.includes('ticket=')); assert.ok(!ready.mediaUrl.includes('owner-a'));
  const file = path.join(h.config.workDir, 'jobs', first.id, 'reply.wav');
  assert.deepEqual((await readFile(file)).subarray(44), pcm, 'exact buffered PCM is stored, without trims/retiming');
  const evidence = h.events.at(-1);
  assert.equal(evidence.replyText, request.text); assert.equal(evidence.taskId, request.taskId);
  assert.equal(evidence.hashes.pcm, hash(pcm)); assert.equal(evidence.hashes.media, hash(fixtureMedia));
  assert.ok(evidence.timeline.some(item => item.stage === 'rendering'));
  const serialized = JSON.stringify(h.events);
  assert.ok(!serialized.includes('owner-a')); assert.ok(!serialized.includes(new URL('http://unit' + ready.mediaUrl).searchParams.get('ticket')));
  const media = (suffix = '', options = {}, peer) => h.service.media(new Request('http://localhost' + ready.mediaUrl + suffix, options), peer);
  h.deny(403); assert.equal((await media()).status, 403); h.deny(undefined);
  assert.equal((await h.service.media(new Request('http://localhost/aura/visual/media?id=' + first.id + '&ticket=bad'))).status, 404);
  assert.equal((await media('', { method: 'POST' })).status, 405);
  let response = await media(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtureMedia);
  response = await media('', { method: 'HEAD', headers: { range: 'bytes=0-2' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), String(fixtureMedia.length));
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [['bytes=0-4', 0, 4], ['bytes=-5', fixtureMedia.length - 5, fixtureMedia.length - 1], ['bytes=3-', 3, fixtureMedia.length - 1]]) {
    response = await media('', { headers: { range } }); assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtureMedia.subarray(start, end + 1));
  }
  for (const range of ['bytes=1-2,3-4', 'bytes=9007199254740992-', 'bytes=-0', 'bytes=900-', 'bytes=2-1']) {
    response = await media('', { headers: { range } }); assert.equal(response.status, 416);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const cached = h.service.create({ ...request, taskId: 'cache-same-pcm' }, 'owner-a');
  const cachedReady = await settled(h.service, cached.id);
  assert.equal(cachedReady.state, 'ready'); assert.equal(cachedReady.cacheHit, true); assert.equal(h.calls.render, 1);
  assert.equal(h.calls.tts, 2, 'cache identity is actual new PCM, never merely text');
  const deleted = h.service.delete(first.id, 'owner-a');
  assert.equal(deleted.state, 'cancelled'); assert.equal(deleted.cancelReason, 'api-delete'); assert.equal(deleted.cancelStage, 'ready');
  assert.equal((await media()).status, 404, 'DELETE invalidates even a ready capability');
  h.seat.release();
  const ownershipCancelled = h.service.get(cached.id, 'owner-a');
  assert.equal(ownershipCancelled.state, 'cancelled', 'ready ownership stays bound beyond the POST request');
  assert.equal(ownershipCancelled.cancelReason, 'ownership-socket-close'); assert.equal(ownershipCancelled.cancelStage, 'ready');
  assert.equal((await h.service.media(new Request('http://localhost' + cachedReady.mediaUrl), { id: 'admitted-peer' })).status, 404);
  assert.equal(h.service.get(first.id, 'owner-a').cancelReason, 'api-delete', 'later owner release cannot overwrite DELETE attribution');

  let releaseRender, renderStarted;
  const entered = new Promise(resolve => { renderStarted = resolve; });
  const waiting = harness({ render: async (job, cfg, progress) => {
    progress('loading-models'); renderStarted(); await new Promise(resolve => { releaseRender = resolve; });
    // Simulate a renderer that ignores signal and tries to publish stale bytes.
    await writeFile(path.join(job.dir, 'ready.mp4'), fixtureMedia);
  } });
  const job = waiting.service.create(request, 'owner-a'); await entered;
  const cancelled = waiting.service.delete(job.id, 'owner-a');
  assert.equal(cancelled.cancelReason, 'api-delete'); assert.equal(cancelled.cancelStage, 'loading-models');
  assert.deepEqual(waiting.service.delete(job.id, 'owner-a'), cancelled, 'repeated cancellation preserves the first stage and timestamp');
  assert.throws(() => waiting.service.create({ ...request, taskId: 'new' }, 'owner-a'), { status: 429 }, 'capacity not released until owned subprocess exits');
  releaseRender(); await waiting.service.dispose();
  assert.deepEqual(waiting.service.get(job.id, 'owner-a'), cancelled, 'dispose and abort unwinding cannot overwrite the first cancellation');
  const cancellationRecords = waiting.events.filter(event => event.state === 'cancelled');
  assert.equal(cancellationRecords.length, 1); assert.equal(cancellationRecords[0].cancelReason, 'api-delete');
  assert.equal(cancellationRecords[0].cancelStage, 'loading-models');
  assert.ok(!JSON.stringify(cancellationRecords).includes('owner-a'), 'cancel diagnostics never include an instance token');
  await assert.rejects(stat(path.join(waiting.config.workDir, 'jobs', job.id)), { code: 'ENOENT' });

  for (const reason of ['socket-close', 'socket-error', 'heartbeat-timeout', 'plugin-dispose', null, 'owner-a:untrusted-reason']) {
    const revoked = harness(), allocation = revoked.service.create(request, 'owner-a');
    revoked.seat.release(reason);
    const expected = ['socket-close', 'socket-error', 'heartbeat-timeout', 'plugin-dispose'].includes(reason)
      ? `ownership-${reason}` : 'ownership-unknown';
    const result = revoked.service.get(allocation.id, 'owner-a');
    assert.equal(result.state, 'cancelled'); assert.equal(result.cancelReason, expected); assert.equal(result.cancelStage, 'preflight');
    revoked.service.delete(allocation.id, 'owner-a'); await revoked.service.dispose();
    assert.deepEqual(revoked.service.get(allocation.id, 'owner-a'), result, 'later DELETE/dispose preserve the first owner release cause');
    assert.equal(revoked.calls.tts, 0); assert.equal(revoked.calls.render, 0);
    const records = revoked.events.filter(event => event.state === 'cancelled');
    assert.equal(records.length, 1); assert.equal(records[0].cancelReason, expected); assert.equal(records[0].cancelStage, 'preflight');
    assert.ok(!JSON.stringify(records).includes('owner-a'), 'only allowlisted ownership reason enums reach diagnostics');
  }
  const stopped = harness(), stoppedJob = stopped.service.create(request, 'owner-a');
  await stopped.service.dispose();
  const stoppedStatus = stopped.service.get(stoppedJob.id, 'owner-a');
  assert.equal(stoppedStatus.cancelReason, 'plugin-dispose'); assert.equal(stoppedStatus.cancelStage, 'preflight');
  assert.equal(stopped.events.at(-1).cancelReason, 'plugin-dispose'); assert.equal(stopped.events.at(-1).cancelStage, 'preflight');
  assert.equal(stopped.seat.resources, 0); assert.equal(stopped.calls.tts, 0);

  let now = 0;
  const expiring = harness({ clock: () => now }), old = expiring.service.create(request, 'owner-a');
  const oldReady = await settled(expiring.service, old.id);
  assert.equal(oldReady.state, 'ready');
  now += 30 * 60 * 1000 + 1;
  const replacement = expiring.service.create({ ...request, taskId: 'after-expiry' }, 'owner-a');
  assert.throws(() => expiring.service.get(old.id, 'owner-a'), { status: 404 });
  await settled(expiring.service, replacement.id);
  const expiryRecord = expiring.events.find(event => event.id === old.id && event.state === 'cancelled');
  assert.equal(expiryRecord.cancelReason, 'expired'); assert.equal(expiryRecord.cancelStage, 'ready');
  assert.ok(!JSON.stringify(expiring.events).includes(new URL('http://unit' + oldReady.mediaUrl).searchParams.get('ticket')));

  let preflightTts = 0;
  const failed = harness({ preflight: async () => { throw new Error('Missing local model fixture'); }, tts: { stream: async () => { preflightTts++; } } });
  const failJob = failed.service.create(request, 'owner-a');
  const failedStatus = await settled(failed.service, failJob.id);
  assert.equal(failedStatus.state, 'failed'); assert.equal(preflightTts, 0);
  assert.equal('cancelReason' in failedStatus, false); assert.equal('cancelStage' in failedStatus, false);
  assert.equal('cancelReason' in failed.events.at(-1), false, 'ordinary preparation failure is not relabelled as cancellation');
  assert.equal(failed.service.create(request, 'owner-a').id, failJob.id, 'failed requests never silently start another generation');
  const noConnection = harness({ connection: () => undefined });
  const nc = noConnection.service.create(request, 'owner-a'), nr = await settled(noConnection.service, nc.id);
  assert.equal((await noConnection.service.media(new Request('http://localhost' + nr.mediaUrl))).status, 401);

  // Real ffmpeg/ffprobe mux+full-decode validation, still NO model/TTS calls.
  // The Python boundary is deliberately replaced by a labelled synthetic color
  // fixture with an unrelated silent audio track. Production mapping must use
  // the separately buffered current PCM WAV, never raw.mp4's audio.
  let observedMux;
  const mux = harness({ render: undefined, verify: undefined,
    run: async (command, args, options) => {
      if (command.endsWith('/python')) {
        assert.ok(args.includes('--audio')); assert.ok(args.includes('--source'));
        const output = args[args.indexOf('--output') + 1];
        await runVisualProcess('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-nostdin', '-y',
          '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=25:d=0.5', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
          '-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', output], options);
        await writeFile(path.join(options.cwd, 'render-result.json'), JSON.stringify({
          finiteDecode: true, decodedFrames: 16, stepsCompleted: 20, seed: 1247, steps: 20, guidance: 1.5,
          fixtureOnly: true, // Never production-generation evidence.
        }));
        return '';
      }
      if (args.includes('+faststart')) observedMux = args;
      return runVisualProcess(command, args, options);
    },
  });
  const muxJob = mux.service.create(request, 'owner-a');
  const muxReady = await settled(mux.service, muxJob.id);
  assert.equal(muxReady.state, 'ready');
  assert.deepEqual(observedMux.filter((value, i) => observedMux[i - 1] === '-map'), ['0:v:0', '1:a:0']);
  assert.equal(observedMux[observedMux.indexOf('-t') + 1], '0.5');
  assert.ok(observedMux.includes(path.join(mux.config.workDir, 'jobs', muxJob.id, 'reply.wav')));
  const decodedAudio = path.join(root, 'fixture-decoded.pcm');
  await runVisualProcess('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i',
    path.join(mux.config.workDir, 'jobs', muxJob.id, 'ready.mp4'), '-map', '0:a:0', '-f', 's16le', decodedAudio]);
  assert.ok((await readFile(decodedAudio)).some(byte => byte !== 0), 'current TTS PCM is audible, not the silent source track');
  const corrupt = harness({ verify: undefined });
  const corruptJob = corrupt.service.create(request, 'owner-a');
  assert.equal((await settled(corrupt.service, corruptJob.id)).state, 'failed', 'invalid fixture bytes cannot publish ready under real ffprobe/decode');

  // Real executable lifecycle only, not model inference. Abort kills this owned
  // process group and cannot signal this test runner or arbitrary external PID.
  const abort = new AbortController(); let sawReady = false;
  const child = runVisualProcess(process.execPath, ['-e', 'console.log("ready"); setInterval(()=>{},1000)'], {
    signal: abort.signal, onLine(line) { if (line === 'ready') { sawReady = true; abort.abort(); } }, timeoutMs: 10000,
  });
  await assert.rejects(child, /cancelled/); assert.equal(sawReady, true);
  assert.equal(await runVisualProcess(process.execPath, ['-e', 'process.stdout.write("alive")']), 'alive');
  console.log('visual-response.test.mjs: ok (unit fixtures only; ownership/cancellation/bounds/PCM/cache/media auth/Range/process group; no generation)');
} finally {
  for (const service of services) await service.dispose();
  const target = path.resolve(root);
  assert.ok(target.startsWith(path.join(tmpdir(), 'aura-visual-unit-')) && target !== tmpdir());
  await rm(target, { recursive: true, force: true });
}
