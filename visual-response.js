/** Opt-in, single-turn visual preparation with LatentSync or QuickTalk.
 * Nothing invokes this path from ordinary /aura/tts. No shell commands, model
 * downloads, daemon, or request-selected paths. A ready download is fully
 * decoded. QuickTalk can also publish an owner-scoped progressive stream.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, copyFile, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textSegments } from './tts.js';

const SOURCE = fileURLToPath(new URL('./assets/previews/短发直播测试/Wan讲话-背景单独校正/Wan讲话底片-定妆棚景-10秒无声.mp4', import.meta.url));
const SOURCE_SHA256 = '620d5586a80d6507a996eae9913933b103d3154ebbb49ecef90ecf839ea7e97f';
const WRAPPER = fileURLToPath(new URL('./tools/latentsync-response.py', import.meta.url));
const ADAPTER = fileURLToPath(import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEMALE_VOICES = ['longyan_v3', 'longxiaochun_v3', 'longxiaoxia_v3', 'longwan_v3', 'longyue_v3',
  'longyuan_v3', 'longmiao_v3', 'longhua_v3', 'longanran_v3', 'longyumi_v3', 'loongbella_v3'];
const MAX_PCM = 300 * 16000 * 2;
const MAX_TEXT = 3000;
const MAX_MEDIA = 128 * 1024 * 1024;
const STREAM_MIME = 'video/mp4; codecs="avc1.64001F, mp4a.40.2"';
const QUICKTALK_METRICS = ['audioFeatureSeconds', 'firstPartSeconds', 'renderFps', 'encodingSeconds', 'muxSeconds'];
const MAX_JOBS = 16;
const TTL = 30 * 60 * 1000;
const OWNERSHIP_CANCEL_REASONS = new Set(['socket-close', 'socket-error', 'heartbeat-timeout', 'plugin-dispose']);
const SETTINGS = Object.freeze({ seed: 1247, steps: 20, guidance: 1.5, resolution: 512,
  framesPerChunk: 16, deepcacheInterval: 3, deepcacheBranch: 0, device: 'mps' });

export function visualConfig(input = {}, env = process.env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('visualResponse must be a config object');
  const defaults = {
    envDir: '/Users/vinson/Projects/local/aura-latentsync-mac-20261123',
    repoDir: '/Users/vinson/Projects/github/bytedance/LatentSync',
    vaeDir: '/Users/vinson/Projects/local/aura-musetalk-1.5/models/sd-vae',
    python: '/Users/vinson/Projects/local/aura-musetalk-1.5/.venv/bin/python',
    ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe',
    workDir: '/Users/vinson/Projects/local/aura-visual-response',
  };
  const provider = input.provider ?? env.AURA_VISUAL_PROVIDER ?? 'latentsync';
  if (!['latentsync', 'quicktalk'].includes(provider)) throw new Error('visualResponse.provider must be latentsync or quicktalk');
  const result = { provider, enabled: input.enabled === true || (input.enabled === undefined && env.AURA_LATENTSYNC_ENABLED === '1') };
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('visualResponse.enabled must be boolean');
  if (provider === 'quicktalk') {
    let url;
    try { url = new URL(input.remoteUrl ?? env.AURA_QUICKTALK_URL); } catch {}
    if (!url || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new Error('QuickTalk requires a configured HTTPS or local HTTP origin');
    }
    result.remoteUrl = url.origin;
    if (input.quickTalkStreaming !== undefined && typeof input.quickTalkStreaming !== 'boolean') {
      throw new Error('visualResponse.quickTalkStreaming must be boolean');
    }
    result.quickTalkStreaming = input.quickTalkStreaming ?? true;
  }
  for (const [name, fallback] of Object.entries(defaults)) {
    const variable = name.replace(/[A-Z]/g, x => '_' + x).toUpperCase();
    const value = input[name] ?? env['AURA_LATENTSYNC_' + variable] ?? fallback;
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) {
      throw new Error(`visualResponse.${name} must be an absolute local path`);
    }
    result[name] = path.resolve(value);
  }
  // Upstream uses a shell internally for temporary ffmpeg IO. Private generated
  // filenames and this safe root keep that code away from unquoted user input.
  if (!/^\/[A-Za-z0-9_./-]+$/.test(result.workDir) || result.workDir === '/') {
    throw new Error('visualResponse.workDir must be a non-root shell-safe local directory');
  }
  return Object.freeze(result);
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }
export function validateVisualRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'JSON object required');
  const allowed = ['text', 'voice', 'model', 'taskId', 'sessionId'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw httpError(400, 'Unknown visual request field');
  if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_TEXT || /[\x00-\x08\x0b-\x1f]/.test(value.text)) {
    throw httpError(400, `数字人回复文本须为 1–${MAX_TEXT} 字符`);
  }
  for (const key of ['taskId', 'sessionId']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 256 || /[\x00-\x1f]/.test(value[key])) {
      throw httpError(400, `${key} is required (1–256 characters)`);
    }
  }
  const voice = value.voice; // Explicit current preference only; never substitute another voice.
  const model = value.model ?? 'cosyvoice-v3-flash';
  if (typeof voice !== 'string' || !FEMALE_VOICES.includes(voice)) {
    throw httpError(400, 'Current voice must be a verified female system voice. Select it explicitly in Aura settings; no automatic substitution.');
  }
  if (model !== 'cosyvoice-v3-flash') throw httpError(400, 'Local visual replies require cosyvoice-v3-flash system voices');
  return { text: value.text.trim(), voice, model, taskId: value.taskId, sessionId: value.sessionId };
}

export function pcmWave(pcm) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > MAX_PCM) throw new Error('语音数据无效或回复时长超过 5 分钟');
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const digest = value => createHash('sha256').update(value).digest('hex');
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function filesUnder(root, suffixes) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(file, suffixes));
    else if (entry.isFile() && suffixes.some(suffix => entry.name.endsWith(suffix))) files.push(file);
  }
  return files.sort();
}

/** Spawn one owned process group. Abort never signals an unrelated process.
 * Promise settles on close, not kill(), so capacity stays occupied until exit. */
export function runVisualProcess(command, args, { cwd, env, signal, input, output: consumeOutput, onLine = () => {}, timeoutMs = 90 * 60 * 1000, maxOutput = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Visual preparation cancelled')); return; }
    const child = spawn(command, args, { cwd, env, detached: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const pipeAbort = new AbortController();
    let output = '', pending = '', failure, killer;
    const stop = () => {
      failure ??= new Error('Visual preparation cancelled or timed out');
      pipeAbort.abort();
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        killer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 2000);
        killer.unref?.();
      }
    };
    const timer = setTimeout(stop, timeoutMs); timer.unref?.();
    signal?.addEventListener('abort', stop, { once: true });
    const receive = bytes => {
      const text = bytes.toString('utf8'); output += text;
      if (output.length > maxOutput) { output = output.slice(-maxOutput); failure = new Error('Visual subprocess output limit exceeded'); stop(); }
      pending += text;
      const lines = pending.split(/[\r\n]/); pending = lines.pop();
      for (const line of lines) { try { onLine(line); } catch (error) { failure = error; stop(); } }
      if (pending.length > 65536) { pending = pending.slice(-65536); failure = new Error('Visual subprocess line limit exceeded'); stop(); }
    };
    const pipes = [];
    const monitor = promise => pipes.push(promise.catch(error => { failure ??= error; stop(); }));
    if (input) monitor(pipeline(input(pipeAbort.signal), child.stdin, { signal: pipeAbort.signal }));
    if (consumeOutput) monitor(consumeOutput(child.stdout));
    else child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', error => { failure = error; });
    child.once('close', async (code, termSignal) => {
      if (code !== 0) pipeAbort.abort();
      await Promise.all(pipes);
      clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', stop);
      // A shell/ffmpeg descendant may outlive its Python parent after SIGTERM.
      // Reap only this child's still-owned group before releasing capacity.
      if (failure && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      if (pending) { try { onLine(pending); } catch (error) { failure = error; } }
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Local visual subprocess failed (${code ?? termSignal})`));
      else resolve(output);
    });
  });
}

function byteRange(value, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) return null;
  const a = m[1] ? Number(m[1]) : undefined, b = m[2] ? Number(m[2]) : undefined;
  if ([a, b].some(n => n !== undefined && !Number.isSafeInteger(n))) return null;
  if (a === undefined) return b > 0 && size ? { start: Math.max(0, size - b), end: size - 1 } : null;
  if (a >= size || (b !== undefined && a > b)) return null;
  return { start: a, end: Math.min(b ?? size - 1, size - 1) };
}

export function createVisualResponse({ config, tts, instance, connection, diagnostic = async () => {},
  readQuickTalkToken = async () => process.env.AURA_QUICKTALK_TOKEN,
  // Dependency injection is code-only for focused tests, never a plugin option.
  run = runVisualProcess, preflight: injectedPreflight, render: injectedRender, verify: injectedVerify,
  clock = Date.now } = {}) {
  const cfg = visualConfig(config);
  const jobs = new Map(), cache = new Map();
  let active = null, disposed = false;
  const root = cfg.workDir;
  const env = Object.freeze({ ...process.env,
    PATH: path.dirname(cfg.ffmpeg) + path.delimiter + (process.env.PATH || ''),
    PYTHONPATH: [path.join(cfg.envDir, 'extra'), path.join(cfg.envDir, 'python'), cfg.repoDir].join(path.delimiter),
    PYTORCH_ENABLE_MPS_FALLBACK: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
  });
  const assertLive = job => { if (job.abort.signal.aborted || job.state !== 'preparing') throw new Error('Visual preparation cancelled'); };
  const status = job => ({ id: job.id, provider: cfg.provider, state: job.state, stage: job.stage,
    elapsedSeconds: Math.max(0, ((job.finishedAt ?? clock()) - job.createdAt) / 1000),
    taskId: job.request.taskId, sessionId: job.request.sessionId, cacheHit: job.cacheHit,
    ...(job.progress ? { progress: job.progress } : {}), ...(job.duration ? { duration: job.duration } : {}),
    ...(job.state === 'ready' ? { mediaUrl: `/aura/visual/media?id=${job.id}&ticket=${job.ticket}` } : {}),
    ...(job.streamBytes && ['preparing', 'ready'].includes(job.state) ? {
      streamUrl: `/aura/visual/media?id=${job.id}&ticket=${job.ticket}&stream=1`, streamMime: STREAM_MIME,
    } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.cancelReason ? { cancelReason: job.cancelReason, cancelStage: job.cancelStage } : {}),
  });
  const record = async job => {
    // Never write token, ticket, mediaUrl or subprocess environment to a log.
    const evidence = { event: 'visual-response', id: job.id, provider: cfg.provider, state: job.state, stage: job.stage,
      taskId: job.request.taskId, sessionId: job.request.sessionId, replyText: job.request.text,
      voice: job.request.voice, model: job.request.model, createdAt: job.createdAt,
      elapsedSeconds: (clock() - job.createdAt) / 1000, duration: job.duration,
      cacheHit: job.cacheHit, hashes: { ...job.hashes }, timeline: job.timeline.map(entry => ({ ...entry })), progress: job.progress && { ...job.progress },
      ...(job.remoteMetrics ? { remoteMetrics: { ...job.remoteMetrics } } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(job.cancelReason ? { cancelReason: job.cancelReason, cancelStage: job.cancelStage } : {}) };
    // Diffusion callbacks can arrive faster than disk logging. Preserve order
    // and avoid concurrent writeFile calls corrupting the final JSON evidence.
    job.logQueue = (job.logQueue ?? Promise.resolve()).then(async () => {
      try { await diagnostic(evidence); } catch {}
      if (job.directoryReady) await writeFile(path.join(job.dir, 'diagnostic.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 }).catch(() => {});
    });
    await job.logQueue;
  };
  const stage = (job, name, progress) => {
    if (job.abort.signal.aborted) return;
    if (job.stage !== name) job.timeline.push({ stage: name, elapsedSeconds: (clock() - job.createdAt) / 1000 });
    job.stage = name;
    if (progress) job.progress = progress;
    void record(job);
  };
  // Explicit containment check immediately before every deletion. No request
  // value participates in these paths; UUIDs are generated by this module.
  const removeJob = async job => {
    const target = path.resolve(job.dir);
    if (!UUID.test(job.id) || target !== path.join(root, 'jobs', job.id)) throw new Error('Unsafe visual cleanup target');
    await rm(target, { recursive: true, force: true });
  };
  const cancel = (job, reason) => {
    if (job.state !== 'cancelled') {
      // First cause wins: abort unwinding, DELETE, expiry or dispose may race.
      job.cancelReason = reason; job.cancelStage = job.stage;
      job.state = 'cancelled'; job.stage = 'cancelled'; job.finishedAt = clock();
      job.ticket = null; job.abort.abort(); job.detach?.(); job.detach = null;
      job.timeline.push({ stage: 'cancelled', elapsedSeconds: (clock() - job.createdAt) / 1000 });
      void record(job);
    }
    // Inflight process exits first; its finally block owns cleanup.
    if (active !== job) void removeJob(job).catch(() => {});
    return status(job);
  };
  const prune = () => {
    for (const [id, job] of jobs) if (active !== job && clock() - (job.finishedAt ?? job.createdAt) > TTL) {
      cancel(job, 'expired'); jobs.delete(id);
    }
  };
  const timer = setInterval(prune, 60000); timer.unref?.();

  async function preflight(job) {
    if (injectedPreflight) return injectedPreflight(job, cfg);
    if (cfg.provider === 'quicktalk') {
      for (const executable of [cfg.ffmpeg, cfg.ffprobe]) {
        if (!(await stat(executable)).isFile()) throw new Error('Missing configured visual executable');
      }
      const token = await readQuickTalkToken();
      if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) throw new Error('QuickTalk token is unavailable');
      job.quickTalkHeaders = { authorization: 'Bearer ' + token };
      const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(5000)]);
      const info = await quickTalkJson('/health', { headers: job.quickTalkHeaders, signal });
      if (info?.ready !== true || info.version !== 'quicktalk-v3'
        || typeof info.engineSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.engineSha256)) {
        throw new Error('QuickTalk is unavailable or missing its model identity');
      }
      if (info.sourceSha256 !== SOURCE_SHA256) throw new Error('QuickTalk is using an unapproved Wan source');
      job.quickTalkStreaming = cfg.quickTalkStreaming && info.parts === true;
      return { source: info.sourceSha256, engine: info.engineSha256 };
    }
    // Verify every required local asset before spending TTS or GPU work. Hash
    // actual code/config/model bytes, not git revision labels or fake probes.
    const inputs = [SOURCE, WRAPPER, ADAPTER, path.join(cfg.envDir, 'wan-approved-22s/run.py'),
      path.join(cfg.envDir, 'environment.json'), path.join(cfg.envDir, 'tiny.pt'), path.join(cfg.envDir, 'latentsync_unet.pt'),
      path.join(cfg.vaeDir, 'config.json'), path.join(cfg.vaeDir, 'diffusion_pytorch_model.safetensors'),
      path.join(cfg.repoDir, 'latentsync/utils/mask.png'),
      ...await filesUnder(path.join(cfg.repoDir, 'latentsync'), ['.py']),
      ...await filesUnder(path.join(cfg.envDir, 'extra'), ['.py']),
      ...await filesUnder(path.join(cfg.envDir, 'python'), ['.py']),
      ...await filesUnder(path.join(cfg.repoDir, 'configs'), ['.yaml', '.json']),
      ...['2d106det.onnx', 'det_10g.onnx'].map(name => path.join(cfg.repoDir, 'checkpoints/auxiliary/models/buffalo_l', name))];
    for (const executable of [cfg.python, cfg.ffmpeg, cfg.ffprobe]) {
      if (!(await stat(executable)).isFile()) throw new Error('Missing configured local visual executable');
    }
    const hashes = {};
    for (const file of inputs) { assertLive(job); hashes[file] = await hashFile(file); }
    if (hashes[SOURCE] !== SOURCE_SHA256) {
      throw new Error('Approved Wan source hash changed; refusing unverified base');
    }
    // Import/version/device check is explicitly not generation evidence.
    const probe = JSON.parse(await run(cfg.python, ['-c', 'import torch,cv2,diffusers,DeepCache,omegaconf,insightface; import json; print(json.dumps({"mps":torch.backends.mps.is_available(),"torch":torch.__version__,"versions":{m.__name__:getattr(m,"__version__","source-hashed") for m in (torch,cv2,diffusers,DeepCache,omegaconf,insightface)}}))'],
      { cwd: job.dir, env, signal: job.abort.signal, timeoutMs: 60000 }));
    if (probe.mps !== true) throw new Error('Configured LatentSync environment has no MPS device');
    return { source: hashes[SOURCE], wrapper: hashes[WRAPPER], engine: digest(JSON.stringify({ hashes, settings: SETTINGS, probe, paths: cfg })) };
  }

  function quickTalkRequest(route, { headers, signal, method = 'GET', body }) {
    const url = new URL(cfg.remoteUrl + route);
    const request = url.protocol === 'https:' ? requestHttps : requestHttp;
    return new Promise((resolve, reject) => {
      // Electron's Undici can fatally assert when a paused response receives an HTTP/1.0 FIN.
      const outgoing = request(url, { method, signal, agent: false,
        headers: body ? { ...headers, 'content-length': body.byteLength } : headers }, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          reject(new Error(`QuickTalk request failed (HTTP ${response.statusCode})`));
        } else resolve(response);
      });
      outgoing.once('error', () => reject(new Error('QuickTalk connection interrupted or timed out')));
      outgoing.end(body);
    });
  }

  async function quickTalkJson(route, options) {
    const response = await quickTalkRequest(route, options);
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        size += chunk.length;
        if (size > 64 * 1024) throw new Error('Oversized status response');
        chunks.push(chunk);
      }
      if (!response.complete) throw new Error('Incomplete status response');
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      throw new Error('QuickTalk returned an invalid or incomplete status response');
    }
  }

  async function* mp4Body(route, { headers, signal }, limit = MAX_MEDIA) {
    const response = await quickTalkRequest(route, { headers, signal });
    const length = response.headers['content-length'];
    if (response.headers['content-type']?.split(';')[0] !== 'video/mp4' || Number(length) > limit) {
      response.destroy();
      throw new Error('QuickTalk returned an invalid MP4 response');
    }
    let size = 0;
    try {
      for await (const chunk of response) {
        size += chunk.length;
        if (size > limit) throw new Error('QuickTalk MP4 exceeds the playback limit');
        yield chunk;
      }
    } catch (error) {
      if (error?.code === 'ECONNRESET') throw new Error('QuickTalk media transfer was interrupted');
      throw error;
    }
    if (!size) throw new Error('QuickTalk returned empty media');
    if (!response.complete || (length !== undefined && size !== Number(length))) throw new Error('QuickTalk media transfer was interrupted');
  }

  async function* quickTalkVideo(job, route, { headers, signal }) {
    let segment = 0, end = 0, received = 0, initialized = false;
    while (true) {
      const info = await quickTalkJson(route, { headers, signal });
      if (!['queued', 'running', 'ready'].includes(info?.state) || !Array.isArray(info.parts)
        || info.parts.length < segment || info.parts.length > 302) throw new Error('QuickTalk returned invalid segment status');
      const phase = info.state === 'queued' ? 'queued' : 'rendering';
      if (job.stage !== phase) stage(job, phase);
      if (info.initReady === true && !initialized) {
        yield* mp4Body(route + '/init', { headers, signal }, 1024 * 1024);
        initialized = true;
      }
      for (; initialized && segment < info.parts.length; segment++) {
        const part = info.parts[segment];
        if (!part || part.index !== segment || !Number.isFinite(part.startSeconds) || !Number.isFinite(part.durationSeconds)
          || Math.abs(part.startSeconds - end) > .002 || !(part.durationSeconds > 0 && part.durationSeconds <= 2.1)) {
          throw new Error('QuickTalk returned out-of-order video segments');
        }
        end = part.startSeconds + part.durationSeconds;
        for await (const chunk of mp4Body(route + '/parts/' + segment, { headers, signal }, 8 * 1024 * 1024)) {
          received += chunk.byteLength;
          if (received > MAX_MEDIA) throw new Error('QuickTalk MP4 exceeds the playback limit');
          yield chunk;
        }
      }
      if (info.state === 'ready') {
        if (!segment || Math.abs(job.duration - end) > .15) throw new Error('QuickTalk did not supply all video segments');
        const values = QUICKTALK_METRICS.map(key => [key, info.metrics?.[key]]);
        job.remoteMetrics = Object.fromEntries(values.filter(([, value]) => Number.isFinite(value) && value >= 0));
        return;
      }
      if (!initialized && info.parts.length) throw new Error('QuickTalk did not supply its initial video');
      await delay(120, undefined, { signal });
    }
  }

  async function publishFragments(job, source) {
    const file = await open(path.join(job.dir, 'stream.mp4'), 'wx', 0o600);
    let total = 0, offset = 0, remaining = 0, next = 'ftyp', type;
    const header = Buffer.alloc(8);
    let headerBytes = 0;
    try {
      for await (const chunk of source) {
        total += chunk.length;
        if (total > MAX_MEDIA) throw new Error('QuickTalk MP4 exceeds the playback limit');
        await file.writeFile(chunk);
        let i = 0;
        while (i < chunk.length) {
          if (remaining === 0) {
            const bytes = Math.min(8 - headerBytes, chunk.length - i);
            chunk.copy(header, headerBytes, i, i + bytes);
            i += bytes; offset += bytes; headerBytes += bytes;
            if (headerBytes < 8) break;
            headerBytes = 0;
            const size = header.readUInt32BE(0);
            type = header.toString('ascii', 4, 8);
            if (type !== next || size <= 8 || size > MAX_MEDIA) throw new Error('Invalid fragmented MP4 from local muxer');
            remaining = size - 8;
          }
          const bytes = Math.min(remaining, chunk.length - i);
          remaining -= bytes; i += bytes; offset += bytes;
          if (remaining > 0) continue;
          next = { ftyp: 'moov', moov: 'moof', moof: 'mdat', mdat: 'moof' }[type];
          if (type === 'mdat') {
            if (!job.streamBytes) {
              job.timeline.push({ stage: 'first-segment', elapsedSeconds: (clock() - job.createdAt) / 1000 });
              void record(job);
            }
            job.streamBytes = offset;
          }
        }
      }
      if (!job.streamBytes || job.streamBytes !== total || headerBytes || remaining) throw new Error('Incomplete fragmented MP4 from local muxer');
    } finally { await file.close(); }
  }

  async function renderStreamingQuickTalk(job, route, headers, signal) {
    const options = { cwd: job.dir, env, signal, timeoutMs: 15 * 60 * 1000 };
    // One encoder and one audio clock for the whole reply, including every keyframe boundary.
    await run(cfg.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-probesize', '32', '-analyzeduration', '1', '-f', 'mp4', '-i', 'pipe:0',
      '-i', path.join(job.dir, 'reply.wav'), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
      '-map_metadata', '-1', '-movflags', '+empty_moov+default_base_moof+frag_keyframe+skip_trailer',
      '-frag_duration', '500000', '-f', 'mp4', 'pipe:1'], {
      ...options, input: pipeSignal => quickTalkVideo(job, route, { headers, signal: AbortSignal.any([signal, pipeSignal]) }),
      output: source => publishFragments(job, source),
    });
    assertLive(job);
    stage(job, 'muxing');
    await run(cfg.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', path.join(job.dir, 'stream.mp4'),
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', path.join(job.dir, 'ready.mp4')], options);
  }

  async function renderQuickTalk(job, wav) {
    const route = '/v1/jobs/' + job.id;
    const headers = job.quickTalkHeaders;
    const signal = AbortSignal.any([job.abort.signal, AbortSignal.timeout(15 * 60 * 1000)]);
    try {
      stage(job, 'uploading');
      const receipt = await quickTalkRequest(route, { method: 'POST', headers: { ...headers, 'content-type': 'audio/wav',
        ...(job.quickTalkStreaming ? { 'x-quicktalk-parts': '1' } : {}) }, body: wav, signal });
      receipt.destroy();
      if (job.quickTalkStreaming) return await renderStreamingQuickTalk(job, route, headers, signal);
      for (;;) {
        const info = await quickTalkJson(route, { headers, signal });
        if (info.state === 'ready') break;
        if (!['queued', 'running'].includes(info.state)) throw new Error('QuickTalk could not prepare the current reply');
        const phase = info.state === 'queued' ? 'queued' : 'rendering';
        if (job.stage !== phase) stage(job, phase);
        await delay(500, undefined, { signal });
      }
      stage(job, 'downloading');
      const file = path.join(job.dir, 'raw.mp4');
      await pipeline(mp4Body(route + '/media', { headers, signal }), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
    } finally {
      // Independent deadline so a cancelled download can still release its remote job.
      try {
        (await quickTalkRequest(route, { method: 'DELETE', headers, signal: AbortSignal.timeout(3000) })).destroy();
      } catch {}
    }
  }

  async function verify(job, file) {
    if (injectedVerify) return injectedVerify(job, file);
    if (cfg.provider === 'quicktalk' && (await stat(file)).size > MAX_MEDIA) throw new Error('QuickTalk MP4 exceeds the playback limit');
    const options = { cwd: job.dir, env, signal: job.abort.signal, timeoutMs: 300000 };
    const probe = JSON.parse(await run(cfg.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], options));
    const videos = probe.streams?.filter(s => s.codec_type === 'video') || [];
    const audios = probe.streams?.filter(s => s.codec_type === 'audio') || [];
    const duration = Number(probe.format?.duration), ad = Number(audios[0]?.duration), vd = Number(videos[0]?.duration);
    const rate = /^(\d+)\/(\d+)$/.exec(videos[0]?.r_frame_rate || '');
    const fps = rate ? Number(rate[1]) / Number(rate[2]) : NaN;
    const frames = Number(videos[0]?.nb_frames);
    if (videos.length !== 1 || audios.length !== 1 || !Number.isFinite(duration) || !Number.isFinite(ad) || !Number.isFinite(vd)
      || Math.abs(duration - job.duration) > .15 || Math.abs(ad - job.duration) > .15 || Math.abs(vd - job.duration) > .15
      || fps !== 25 || !Number.isFinite(frames) || frames < Math.floor(job.duration * 25) - 1 || frames > Math.ceil(job.duration * 25) + 2
      || Number(audios[0].sample_rate) !== 16000 || audios[0].channels !== 1
      || !(videos[0].width > 0 && videos[0].height > 0)) throw new Error('Muxed media stream/duration validation failed');
    await run(cfg.ffmpeg, ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], options);
    return { media: await hashFile(file), duration, videoDuration: vd, audioDuration: ad, decoded: true };
  }

  async function render(job, wav) {
    if (injectedRender) return injectedRender(job, cfg, (name, value) => stage(job, name, value));
    if (cfg.provider === 'quicktalk') await renderQuickTalk(job, wav);
    else await renderLatentSync(job);
    if (job.quickTalkStreaming) return;
    stage(job, 'muxing');
    // Only the render's video and this reply's PCM enter the playback file.
    const videoCodec = cfg.provider === 'quicktalk'
      ? ['-vf', 'fps=25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p'] : ['-c:v', 'copy'];
    await run(cfg.ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-y', '-i', path.join(job.dir, 'raw.mp4'), '-i', path.join(job.dir, 'reply.wav'),
      '-map', '0:v:0', '-map', '1:a:0', ...videoCodec, '-c:a', 'aac', '-b:a', '128k', '-t', String(job.duration), '-movflags', '+faststart',
      '-map_metadata', '-1', path.join(job.dir, 'ready.mp4')], { cwd: job.dir, env, signal: job.abort.signal, timeoutMs: 300000 });
  }

  async function renderLatentSync(job) {
    await copyFile(SOURCE, path.join(job.dir, 'source.mp4'));
    // Isolate upstream's fixed `temp` directory and relative configuration. Do
    // not create/remove temp files inside the existing model repository.
    for (const name of ['configs', 'latentsync', 'checkpoints']) await symlink(path.join(cfg.repoDir, name), path.join(job.dir, name), 'dir');
    stage(job, 'loading-models');
    let log = Promise.resolve(), logError;
    try {
      await run(cfg.python, ['-u', WRAPPER, '--audio', path.join(job.dir, 'reply.wav'), '--source', path.join(job.dir, 'source.mp4'),
        '--output', path.join(job.dir, 'raw.mp4'), '--env-dir', cfg.envDir, '--vae-dir', cfg.vaeDir], {
        cwd: job.dir, env, signal: job.abort.signal,
        onLine(line) {
          if (logError) throw logError;
          log = log.then(() => appendFile(path.join(job.dir, 'render.log'), line + '\n', { mode: 0o600 }))
            .catch(error => { logError ??= error; });
          if (line.startsWith('AURA_PROGRESS ')) {
            const info = JSON.parse(line.slice(14));
            if (!['loading-models', 'rendering', 'muxing'].includes(info.stage)) throw new Error('Invalid renderer stage');
            stage(job, info.stage, Object.fromEntries(Object.entries(info).filter(([key, value]) => key !== 'stage' && Number.isFinite(value))));
          }
        },
      });
    } finally { await log; if (logError) throw logError; }
    const result = JSON.parse(await readFile(path.join(job.dir, 'render-result.json'), 'utf8'));
    if (result.finiteDecode !== true || !(result.decodedFrames >= Math.floor(job.duration * 25)) || !(result.stepsCompleted >= 20)
      || result.seed !== 1247 || result.steps !== 20 || result.guidance !== 1.5) throw new Error('Missing real finite renderer evidence');
  }

  async function execute(job) {
    let lock, lockOwned = false;
    try {
      assertLive(job);
      await mkdir(path.join(root, 'jobs'), { recursive: true, mode: 0o700 });
      assertLive(job);
      await mkdir(job.dir, { mode: 0o700 }); job.directoryReady = true;
      assertLive(job);
      // Cross-activation guard: a second Host/module cannot start another costly
      // generation. A live or ambiguous lock fails closed, never auto-retries.
      const lockPath = path.join(root, 'render.lock');
      try { lock = await open(lockPath, 'wx', 0o600); lockOwned = true; await lock.writeFile(JSON.stringify({ pid: process.pid, id: job.id })); }
      catch (error) { if (error.code === 'EEXIST') throw new Error('Local renderer lock is occupied; inspect its owner before retrying'); throw error; }
      stage(job, 'preflight');
      job.hashes = await preflight(job); assertLive(job);
      stage(job, 'tts');
      const segments = textSegments(job.request.text, 60);
      const partChunks = segments.map(() => []);
      const ttsFailure = new AbortController();
      const signal = AbortSignal.any([job.abort.signal, ttsFailure.signal]);
      let next = 0, bytes = 0;
      async function synthesizeParts() {
        try {
          while (next < segments.length) {
            signal.throwIfAborted();
            const index = next++;
            await tts.stream({ text: segments[index], voice: job.request.voice, model: job.request.model, signal,
              onChunk(chunk) {
                signal.throwIfAborted();
                bytes += chunk.length;
                if (bytes > MAX_PCM) {
                  ttsFailure.abort(new Error('数字人回复时长超过 5 分钟'));
                  signal.throwIfAborted();
                }
                partChunks[index].push(Buffer.from(chunk));
              },
            });
          }
        } catch (error) { ttsFailure.abort(error); }
      }
      const concurrency = cfg.provider === 'quicktalk' ? 2 : 1;
      await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, synthesizeParts));
      signal.throwIfAborted();
      assertLive(job);
      const pcm = Buffer.concat(partChunks.flat(), bytes); const wav = pcmWave(pcm);
      job.duration = pcm.length / 32000;
      if (job.duration < .2) throw new Error('TTS reply is too short');
      job.hashes.pcm = digest(pcm); job.hashes.wav = digest(wav);
      await writeFile(path.join(job.dir, 'reply.wav'), wav, { mode: 0o600 });
      const key = digest(JSON.stringify({ pcm: job.hashes.pcm, ...job.hashes, settings: SETTINGS }));
      const cached = cfg.provider === 'latentsync' && cache.get(key);
      if (cached) {
        stage(job, 'validating');
        try {
          const check = await verify(job, cached.file);
          if (check.media !== cached.media) throw new Error('Cache hash mismatch');
          await copyFile(cached.file, path.join(job.dir, 'ready.mp4')); job.cacheHit = true;
        } catch (error) { assertLive(job); cache.delete(key); }
      }
      if (!job.cacheHit) await render(job, wav);
      assertLive(job); stage(job, 'validating');
      const check = await verify(job, path.join(job.dir, 'ready.mp4')); assertLive(job);
      job.hashes.media = check.media;
      // Cache only exact PCM/source/code/config identities verified above; copy
      // independent of job cleanup, bounded to four process-local entries.
      if (!job.cacheHit && cfg.provider === 'latentsync') {
        const cacheDir = path.join(root, 'cache'); await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        const file = path.join(cacheDir, key + '.mp4'); await copyFile(path.join(job.dir, 'ready.mp4'), file);
        cache.set(key, { file, media: check.media });
        if (cache.size > 4) {
          const [oldKey, old] = cache.entries().next().value; cache.delete(oldKey);
          if (/^[a-f0-9]{64}$/.test(oldKey) && path.resolve(old.file) === path.join(root, 'cache', oldKey + '.mp4')) await rm(old.file, { force: true });
        }
      }
      assertLive(job);
      job.state = 'ready'; job.stage = 'ready'; job.finishedAt = clock();
      job.timeline.push({ stage: 'ready', elapsedSeconds: (clock() - job.createdAt) / 1000 });
      await record(job);
    } catch (error) {
      if (job.abort.signal.aborted || job.state === 'cancelled') cancel(job, 'aborted');
      else { job.state = 'failed'; job.stage = 'failed'; job.error = String(error.message || error).slice(0, 300); job.finishedAt = clock(); await record(job); }
    } finally {
      if (lockOwned) {
        await lock?.close().catch(() => {});
        const target = path.resolve(root, 'render.lock');
        if (target === path.join(root, 'render.lock')) await rm(target, { force: true }).catch(() => {});
      }
      if (active === job) active = null;
      if (job.state === 'cancelled') await removeJob(job).catch(() => {});
    }
  }

  function owned(id, token) {
    if (!UUID.test(id || '')) throw httpError(400, 'Invalid visual id');
    const job = jobs.get(id);
    if (!job || job.owner !== token) throw httpError(404, 'Visual preparation not found');
    return job;
  }
  async function* streamMedia(job, signal) {
    const file = await open(path.join(job.dir, 'stream.mp4'), 'r');
    let offset = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        if (!['preparing', 'ready'].includes(job.state)) throw new Error('Visual stream ended before completion');
        const size = Math.min(64 * 1024, job.streamBytes - offset);
        if (size > 0) {
          const buffer = Buffer.allocUnsafe(size);
          const { bytesRead } = await file.read(buffer, 0, size, offset);
          if (!bytesRead) throw new Error('Visual stream ended before completion');
          offset += bytesRead;
          yield buffer.subarray(0, bytesRead);
        } else if (job.state === 'ready') return;
        else await delay(40, undefined, { signal });
      }
    } finally { await file.close(); }
  }
  return {
    create(value, token) {
      const request = validateVisualRequest(value);
      if (!cfg.enabled || disposed) throw httpError(503, 'Visual preparation is disabled');
      prune();
      const fingerprint = digest(JSON.stringify(request));
      for (const job of jobs.values()) if (job.owner === token && job.request.taskId === request.taskId && job.request.sessionId === request.sessionId) {
        if (job.fingerprint !== fingerprint) throw httpError(409, 'This task already has a different visual reply');
        return status(job); // Never restart failed/cancelled/costly duplicate work.
      }
      if (active) throw httpError(429, 'One visual preparation is already active');
      if (jobs.size >= MAX_JOBS) throw httpError(429, 'Visual job limit reached; delete completed preparations');
      const id = randomUUID();
      const job = { id, owner: token, fingerprint, request, state: 'preparing', stage: 'preflight', createdAt: clock(),
        ticket: randomUUID(), abort: new AbortController(), cacheHit: false, timeline: [{ stage: 'preflight', elapsedSeconds: 0 }], dir: path.join(root, 'jobs', id) };
      job.detach = instance.authorize(token, reason => cancel(job,
        OWNERSHIP_CANCEL_REASONS.has(reason) ? `ownership-${reason}` : 'ownership-unknown'));
      if (!job.detach) throw httpError(409, 'Aura ownership changed');
      jobs.set(id, job); active = job;
      // Allocation/202 must finish before any TTS/model work starts.
      job.done = Promise.resolve().then(() => execute(job));
      return status(job);
    },
    get(id, token) { return status(owned(id, token)); },
    delete(id, token) { return cancel(owned(id, token), 'api-delete'); },
    async media(request, peer) {
      if (!peer) {
        const admission = connection?.();
        const rejection = admission ? admission.requestRejection(request) : 401;
        if (rejection) return new Response(null, { status: rejection });
      }
      const url = new URL(request.url), id = url.searchParams.get('id'), ticket = url.searchParams.get('ticket');
      const job = UUID.test(id || '') && jobs.get(id);
      const progressive = url.searchParams.get('stream') === '1';
      if (!job || !UUID.test(ticket || '') || ticket !== job.ticket
        || (progressive ? !job.streamBytes || !['preparing', 'ready'].includes(job.state) : job.state !== 'ready')) {
        return new Response(null, { status: 404 });
      }
      // Capability + current seat are required even for an admitted in-process
      // Peer. Never put the instance token in a video URL or a diagnostic.
      const live = new AbortController();
      const detach = instance.authorize(job.owner, () => live.abort());
      if (!detach) return new Response(null, { status: 409 });
      const signal = AbortSignal.any([request.signal, live.signal, job.abort.signal]);
      let transferred = false;
      try {
        if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
        if (progressive) {
          const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'none', 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
          if (signal.aborted) return new Response(null, { status: 409 });
          if (request.method === 'HEAD') return new Response(null, { headers });
          if (request.headers.has('range')) return new Response(null, { status: 416, headers });
          const stream = Readable.from(streamMedia(job, signal), { signal });
          stream.once('close', detach); transferred = true;
          return new Response(Readable.toWeb(stream), { headers });
        }
        const file = path.join(job.dir, 'ready.mp4'), { size } = await stat(file);
        if (signal.aborted || job.state !== 'ready') return new Response(null, { status: 409 });
        const headers = { 'content-type': 'video/mp4', 'content-length': String(size), 'accept-ranges': 'bytes',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
        const value = request.method === 'GET' && !request.headers.has('if-range') ? request.headers.get('range') : null;
        let range;
        if (value !== null) {
          range = byteRange(value, size);
          if (!range) return new Response(null, { status: 416, headers: { ...headers, 'content-length': '0', 'content-range': `bytes */${size}` } });
          headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`; headers['content-length'] = String(range.end - range.start + 1);
        }
        let body = null;
        if (request.method !== 'HEAD') {
          const stream = createReadStream(file, { ...range, signal });
          stream.once('close', detach); transferred = true; body = Readable.toWeb(stream);
        }
        return new Response(body, { status: range ? 206 : 200, headers });
      } catch { return new Response(null, { status: 404 }); }
      finally { if (!transferred) detach(); }
    },
    async dispose() {
      disposed = true; clearInterval(timer);
      for (const job of jobs.values()) cancel(job, 'plugin-dispose');
      await Promise.all([...jobs.values()].map(job => job.done));
    },
  };
}
