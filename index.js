/**
 * Host half of dsh-aura.
 *
 * Two routes, both loopback-only like the rest of the DSH web server:
 *
 * - `POST /aura/diag` — stage beacons from the browser half, appended to
 *   `$DSH_HOME/aura-diag.jsonl`. A slot entry that never mounts looks exactly
 *   like a plugin that is not installed, and the renderer console cannot be read
 *   from outside the app, so this file is the only way to tell them apart.
 * - `POST /aura/asr` — PCM16 in, transcript out. The microphone stays in the
 *   browser and the API key stays here; the page never sees either.
 *
 * The authenticated /aura command owns foreground mode and interruption;
 * native managed subagents independently own dispatched work.
 */
import { appendFile, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import path from 'node:path';
import { createAsr, openParaformerSession, withAllocationRetry } from './asr.js';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { createKeyReader, parseEnvFile } from './secrets.js';
import { createTts, speakablePrefix, textSegments } from './tts.js';
import { installTaskLayer } from './tasks.js';
import { installInstance } from './instance.js';
import { installTaskSpeech } from './task-speech.js';
import { createVisualResponse, visualConfig } from './visual-response.js';
import { installVisualSettings } from './visual-settings.js';

export const inject = ['webServer', 'commands', 'subagents', 'tools', 'systemPrompt', 'agents'];

/** One line per report; trimmed so a runaway loop cannot fill the disk. */
const MAX_LINES = 2000;
/** Cap one recording: a minute of 16 kHz mono PCM16 is under 2 MiB. */
const MAX_PCM_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** Credential record this plugin owns, as `<scope>/<id>`. */
const CREDENTIAL_KEY = 'dsh-aura/asr';

// Exact, local-only allowlist: no URL, pathname or query value selects a file.
// Keep the old portrait URL compatible with the existing static character mode.
const CHARACTER_ASSETS = [
  ['heart.mp4', './assets/previews/短发直播测试/H3-比心/短发半身-双手比心.mp4', 'video/mp4'],
  ['smile.mp4', './assets/previews/短发直播测试/H3-逗笑对照/H3-被逗开心.mp4', 'video/mp4'],
  ['wave.mp4', './assets/previews/短发直播测试/首尾衔接预演/挥手统一棚景.mp4', 'video/mp4'],

  ['short-hair.png', './assets/previews/短发直播测试/无声倾听/短发正面直视-参考帧.png', 'image/png'],
  ['front.mp4', './assets/runtime/short-hair/front-loop-background-matched.mp4', 'video/mp4'],
  ['catalog.json', './assets/runtime/short-hair/catalog.json', 'application/json'],
  ['idle-side.mp4', './assets/runtime/short-hair/idle-side-h3-matched.mp4', 'video/mp4'],
  ['idle-lean.mp4', './assets/runtime/short-hair/idle-lean.mp4', 'video/mp4'],
  ['side.png', './assets/runtime/short-hair/side.png', 'image/png'],
  ['turn.mp4', './assets/runtime/short-hair/turn.mp4', 'video/mp4'],
  ['listen.mp4', './assets/runtime/short-hair/listen.mp4', 'video/mp4'],
  ['respond.mp4', './assets/runtime/short-hair/respond.mp4', 'video/mp4'],
  ['return.mp4', './assets/runtime/short-hair/return.mp4', 'video/mp4'],
];

/** One byte range only; reject malformed/multipart/unsafe integers without IO. */
function characterRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ([first, last].some(n => n !== undefined && !Number.isSafeInteger(n))) return null;
  if (first === undefined) {
    if (!last || !size) return null;
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && first > last)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh');
}

function logFile() {
  return path.join(dshHome(), 'aura-diag.jsonl');
}

async function append(line) {
  const file = logFile();
  try {
    await appendFile(file, line + '\n', 'utf8');
  } catch {
    /* A diagnostic must never break the thing it observes. */
    return;
  }
  try {
    const { readFile, writeFile } = await import('node:fs/promises');
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    if (lines.length > MAX_LINES) {
      await writeFile(file, lines.slice(lines.length - MAX_LINES).join('\n'), 'utf8');
    }
  } catch {
    /* trimming is best effort */
  }
}

/** Read a request body as text, refusing anything oversized. */
async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * One live turn, speaking the same control frames the XiaoZhi bridge speaks
 * (`server.py: device_websocket_hello / device_websocket_control`):
 *
 *   client  {"type":"hello","transport":"websocket","audio_params":{…}}
 *   server  {"type":"hello","transport":"websocket","session_id":…,"audio_params":{…}}
 *   client  {"type":"listen","state":"start","mode":"manual"|"auto"}
 *   client  <binary PCM16 frames>
 *   server  {"type":"stt","text":…,"partial":true}
 *   client  {"type":"listen","state":"stop"}
 *   server  {"type":"stt","text":…,"partial":false}
 *
 * `generation` is bumped on every listen start so a late transcript from a
 * previous turn cannot be mistaken for this one — the bridge does the same with
 * its `session_id + generation` filter.
 */
export async function liveTurn(peer, asrConfig, readKey, fallback) {
  const sessionId = `aura-${randomUUID().slice(0, 8)}`;
  const send = (value) => {
    try {
      if (peer.readyState === peer.OPEN) peer.send(JSON.stringify({ session_id: sessionId, ...value }));
    } catch {
      /* the peer is gone */
    }
  };

  let greeted = false;
  let generation = 0;
  let mode = 'manual';
  let session = null;
  let finishing = null;
  /* Keep the audio: a stream that dies on a provider limit can still be
   * transcribed by the other provider instead of losing the turn. */
  let audio = [];

  peer.on('message', async (data, isBinary) => {
    if (isBinary) {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (audio.length < 400) audio.push(chunk);
      if (session && !finishing) {
        try {
          session.send(chunk);
        } catch {
          /* a dead socket ends the turn through close */
        }
      }
      return;
    }

    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      send({ type: 'error', message: 'invalid JSON' });
      return;
    }

    if (message.type === 'hello') {
      greeted = true;
      send({
        type: 'hello',
        transport: 'websocket',
        audio_params: { format: 'pcm16', sample_rate: 16000, channels: 1, frame_duration: 100 },
      });
      return;
    }

    if (!greeted) {
      send({ type: 'error', message: 'expected hello' });
      return;
    }

    if (message.type === 'listen' && message.state === 'start') {
      mode = message.mode === 'auto' ? 'auto' : 'manual';
      const mine = ++generation;
      finishing = null;
      if (session) session.close();
      session = null;
      audio = [];
      try {
        const apiKey = await readKey(asrConfig.apiKey);
        const opened = await withAllocationRetry(() =>
          openParaformerSession({
          apiKey,
          baseUrl: asrConfig.baseUrl,
          model: asrConfig.model,
          maxSentenceSilenceMs: asrConfig.maxSentenceSilenceMs,
          /* Injectable so the protocol can be exercised without a socket. */
          connect: asrConfig.connect,
          onUpdate: (update) => {
            if (mine === generation) send({ type: 'stt', text: update.latest, partial: true, end: update.end });
          },
          }),
        );
        if (mine !== generation || finishing) {
          opened.close();
          return;
        }
        session = opened;
        // Frames arriving during credential/provider startup must reach the
        // live recognizer once, while the full copy remains for fallback.
        for (const chunk of audio) opened.send(chunk);
        send({ type: 'listen', state: 'start', mode });
      } catch (failure) {
        if (mine !== generation) return;
        /* The stream could not open; the turn continues and the buffered audio
         * is handed to the fallback provider when it stops. */
        send({ type: 'listen', state: 'start', mode, degraded: true });
        return;
      }
      return;
    }

    if (message.type === 'listen' && message.state === 'stop') {
      if (finishing) return;
      const mine = generation;

      const runFallback = async (reason) => {
        const pcm = Buffer.concat(audio);
        audio = [];
        if (!fallback || pcm.length < 3200) {
          send({ type: 'error', message: reason });
          return;
        }
        try {
          const result = await withAllocationRetry(() =>
            fallback.transcribe({ pcm, sampleRate: 16000, channels: 1 }),
          );
          if (mine !== generation) return;
          send({ type: 'stt', text: result.text || '', partial: false, fallback: fallback.name });
        } catch (failure) {
          if (mine !== generation) return;
          send({ type: 'error', message: String((failure && failure.message) || failure).slice(0, 300) });
        }
      };

      if (!session) {
        finishing = runFallback('the realtime recognizer is unavailable').finally(() => {
          if (mine !== generation) return;
          generation += 1;
          try {
            peer.close();
          } catch {
            /* already closed */
          }
        });
        return;
      }

      const current = session;
      finishing = current
        .finish()
        .then((result) => {
          if (mine !== generation) return;
          send({ type: 'stt', text: result.text || '', partial: false, duration: result.duration });
        })
        .catch(async (failure) => {
          if (mine !== generation) return;
          /* A provider limit must not eat the utterance. */
          await runFallback(String((failure && failure.message) || failure));
        })
        .finally(() => {
          current.close();
          if (mine !== generation) return;
          generation += 1;
          try {
            peer.close();
          } catch {
            /* already closed */
          }
        });
    }
  });

  peer.on('close', () => {
    generation += 1; // invalidate callbacks still queued by the recognizer
    if (session) session.close();
  });
}

export function apply(ctx, config = {}) {
  const asrConfig = config.asr || {};
  const readKey = createKeyReader({
    readRecord: async () => {
      const credentials = ctx.get('credentials');
      if (!credentials || typeof credentials.readRecord !== 'function') return undefined;
      return credentials.readRecord(CREDENTIAL_KEY);
    },
    readSecretsFile: () => readFile(path.join(dshHome(), 'aura-secrets.env'), 'utf8'),
  });
  const asr = createAsr(asrConfig, readKey);

  const instance = installInstance(ctx);
  const taskSpeech = installTaskSpeech(ctx, instance.deliver);
  installTaskLayer(ctx, taskSpeech);
  const audioRoute = handler => async (req, res) => {
    const cancelled = new AbortController();
    const detach = instance.authorize(req.headers['x-aura-instance'], () => {
      cancelled.abort();
      res.destroy();
    });
    if (!detach) { sendJson(res, 409, { error: 'Aura is not owned by this window. Reopen its panel.' }); return; }
    const closed = () => { cancelled.abort(); detach(); };
    res.once('close', closed);
    try { await handler(req, res, cancelled); }
    finally { detach(); res.off('close', closed); }
  };
  /* A different model on purpose: the realtime stream and the one-shot request
   * draw on separate quotas, so one dying does not take the turn with it. */
  const fallbackAsr = createAsr(
    { ...asrConfig, provider: 'bailian', model: asrConfig.fallbackModel || 'qwen-audio-3.1-asr-flash' },
    readKey,
  );

  /* Live recognition: the browser streams PCM while the user is still talking
   * and receives partials, which is what lets it end a turn on a completed
   * sentence instead of on a silence gap alone. */
  const sockets = new WebSocketServer({ noServer: true });
  ctx.effect(
    () => () => sockets.close(),
    'dsh-aura: live recognition server',
  );
  ctx.effect(
    () =>
      ctx.webServer.registerUpgrade({
        path: '/aura/asr/live',
        handler: (request, socket, head) => {
          sockets.handleUpgrade(request, socket, head, (peer) => {
            const token = new URL(request.url, 'http://localhost').searchParams.get('instance');
            const detach = instance.authorize(token, () => peer.terminate());
            if (!detach) { peer.close(1008, 'Open the runtime Aura instance first'); return; }
            peer.once('close', detach);
            void liveTurn(peer, asrConfig, readKey, fallbackAsr);
          });
        },
      }),
    'dsh-aura: live recognition route',
  );
  for (const [name, localPath, contentType] of CHARACTER_ASSETS) {
    const file = new URL(localPath, import.meta.url);
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: `/aura/character/${name}`,
      resource: async (request, peer) => {
        // Resources do not authenticate themselves. Reuse the old portrait's
        // Host/Origin + browser-cookie gate; in-process readers are admitted by
        // the caller before supplying a Peer. Always gate before file access.
        if (!peer) {
          const connection = ctx.get?.('connection');
          const rejection = connection ? connection.requestRejection(request) : 401;
          if (rejection) return new Response(null, { status: rejection });
        }
        if (!['GET', 'HEAD'].includes(request.method)) {
          return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
        }
        try {
          const { size } = await stat(file);
          const headers = {
            'content-type': contentType, 'content-length': String(size),
            'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
            'accept-ranges': 'bytes',
          };
          // RFC 9110: Range applies only to GET. Without validators an If-Range
          // request gets the full representation, never an unvalidated slice.
          const value = request.method === 'GET' && !request.headers.has('if-range')
            ? request.headers.get('range') : null;
          let range;
          if (value !== null) {
            range = characterRange(value, size);
            if (!range) return new Response(null, { status: 416, headers: {
              ...headers, 'content-length': '0', 'content-range': `bytes */${size}`,
            } });
            headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
            headers['content-length'] = String(range.end - range.start + 1);
          }
          // HEAD only stats the file; GET streams precisely the selected bytes.
          const body = request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file, {
            ...range, signal: request.signal,
          }));
          return new Response(body, { status: range ? 206 : 200, headers });
        } catch { return new Response(null, { status: 404 }); }
      },
    }), 'dsh-aura: approved character asset');
  }
  const tts = createTts(config.tts || {}, readKey);
  const visualOptions = visualConfig(config.visualResponse || {});
  const visual = createVisualResponse({
    config: visualOptions, instance,
    async readQuickTalkToken() {
      if (process.env.AURA_QUICKTALK_TOKEN) return process.env.AURA_QUICKTALK_TOKEN;
      try { return parseEnvFile(await readFile(path.join(dshHome(), 'aura-secrets.env'), 'utf8')).AURA_QUICKTALK_TOKEN; }
      catch { return undefined; }
    },
    // This independent buffered path fixes PCM's actual format, without changing
    // ordinary streaming TTS or any current browser voice/model preference.
    tts: createTts({ ...(config.tts || {}), sampleRate: 16000 }, readKey),
    connection: () => ctx.get?.('connection'),
    diagnostic: value => append(JSON.stringify({ at: new Date().toISOString(), ...value })),
  });
  ctx.effect(() => () => { void visual.dispose(); }, 'dsh-aura: local visual lifecycle');
  const { enabled: visualEnabled, provider } = visualOptions;
  installVisualSettings(ctx, { instance, enabled: visualEnabled, provider, version: '0.35.4-visual.6' });
  void append(JSON.stringify({ stage: 'visual_backend', v: '0.35.4-visual.6',
    at: Date.now(), enabled: visualEnabled, provider }));
  const visualApi = audioRoute(async (req, res, cancelled) => {
    res.setHeader('cache-control', 'no-store');
    try {
      const token = req.headers['x-aura-instance'];
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
          sendJson(res, 400, { error: 'application/json required' }); return;
        }
        let body;
        try { body = JSON.parse(await readBody(req, 24 * 1024)); }
        catch { sendJson(res, 400, { error: 'invalid or oversized JSON body' }); return; }
        if (!cancelled.signal.aborted) sendJson(res, 202, visual.create(body, token));
      } else if (req.method === 'GET') sendJson(res, 200, visual.get(url.searchParams.get('id'), token));
      else if (req.method === 'DELETE') sendJson(res, 200, visual.delete(url.searchParams.get('id'), token));
      else { res.writeHead(405, { allow: 'POST, GET, DELETE' }); res.end(); }
    } catch (error) { sendJson(res, error.status || 500, { error: String(error.message || error).slice(0, 300) }); }
  });
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/aura/visual',
    handler: async (req, res) => {
      // Check the actual request authority/Origin/cookie before ownership, body
      // parsing or IO. Request resources need the same explicit browser gate.
      const connection = ctx.get?.('connection');
      let rejection = 401;
      if (connection) {
        try {
          const protocol = new URL(ctx.webServer.getOrigin()).protocol;
          const url = new URL(req.url, `${protocol}//${req.headers.host}`);
          rejection = connection.requestRejection(new Request(url, { method: req.method, headers: req.headers }));
        } catch { rejection = 403; }
      }
      if (rejection) { sendJson(res, rejection, { error: 'Browser authentication required' }); return; }
      await visualApi(req, res);
    },
  }), 'dsh-aura: local visual API');
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/aura/visual/media', resource: (request, peer) => visual.media(request, peer),
  }), 'dsh-aura: scoped local visual media');
  for (const file of ['portrait.webp', 'motion.webp']) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: `/aura/peach/${file}`,
      handler: async (req, res) => {
        if (req.method !== 'GET') { res.writeHead(405).end(); return; }
        try {
          const image = await readFile(new URL(`./assets/runtime/peach/${file}`, import.meta.url));
          res.writeHead(200, { 'content-type': 'image/webp' }).end(image);
        } catch {
          res.writeHead(404).end();
        }
      },
    }), 'dsh-aura: character artwork');
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/aura/diag',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          let body = '';
          try {
            body = await readBody(req);
          } catch {
            res.writeHead(400);
            res.end();
            return;
          }
          const text = body.trim().slice(0, 4000);
          if (text) await append(text.startsWith('{') ? text : JSON.stringify({ raw: text }));
          res.writeHead(204);
          res.end();
        },
      }),
    'dsh-aura: diagnostic route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/aura/asr',
        handler: audioRoute(async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          let request;
          try {
            request = JSON.parse(await readBody(req));
          } catch (failure) {
            sendJson(res, 400, { error: 'invalid JSON body' });
            return;
          }
          let pcm;
          try {
            pcm = Buffer.from(String(request.pcm || ''), 'base64');
          } catch {
            sendJson(res, 400, { error: 'pcm must be base64' });
            return;
          }
          if (pcm.length === 0) {
            sendJson(res, 400, { error: 'no audio' });
            return;
          }
          if (pcm.length > MAX_PCM_BYTES) {
            sendJson(res, 413, { error: 'audio too long' });
            return;
          }
          try {
            const result = await withAllocationRetry(() =>
              asr.transcribe({
                pcm,
                sampleRate: Number(request.sampleRate) || 16000,
                channels: Number(request.channels) || 1,
                hints: Array.isArray(request.hints) ? request.hints.map(String).slice(0, 8) : [],
              }),
            );
            sendJson(res, 200, { text: result.text, provider: asr.name, detail: result.detail });
          } catch (failure) {
            sendJson(res, 502, {
              error: String((failure && failure.message) || failure).slice(0, 400),
              provider: asr.name,
            });
          }
        }),
      }),
    'dsh-aura: speech to text route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/aura/tts',
        handler: audioRoute(async (req, res, cancelled) => {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          let request;
          try {
            request = JSON.parse(await readBody(req));
          } catch {
            sendJson(res, 400, { error: 'invalid JSON body' });
            return;
          }
          const text = String(request.text || '').trim().slice(0, 2000);
          /* A voice id is a short token; anything else is refused rather than
           * forwarded to the provider. */
          const requestedVoice = String(request.voice || '').trim();
          const voice = /^[A-Za-z0-9_.-]{1,64}$/.test(requestedVoice) ? requestedVoice : undefined;
          /* Only the models this plugin knows about are forwarded. v3.5-flash is
           * cheaper per character but rejects system voice ids. */
          const requestedModel = String(request.model || '').trim();
          const model = /^cosyvoice-v3(\.5)?-flash$/.test(requestedModel) ? requestedModel : undefined;
          if (!text) {
            sendJson(res, 400, { error: 'no text' });
            return;
          }
          /* Raw PCM, chunked: the browser plays it as it arrives instead of
           * waiting for the whole sentence to be synthesised. */
          /* turns.py: the writer checks cancellation on every frame. Here the
           * cancellation is the client going away. */
          if (cancelled.signal.aborted) return;
          let closed = false;
          res.on('close', () => {
            closed = true;
            cancelled.abort();
          });
          try {
            res.writeHead(200, {
              'content-type': 'audio/L16',
              'cache-control': 'no-store',
              'x-aura-sample-rate': String(16000),
              'x-aura-provider': tts.name,
            });
            /* Segment first, synthesise each, write as it arrives: the bridge's
             * shape (server.py: _tts_messages + _write_tts_audio_stream). */
            const { spoken } = speakablePrefix(text, 240);
            const segments = textSegments(spoken, 60);
            for (const segment of segments) {
              if (closed) break;
              await tts.stream({
                model,
                signal: cancelled.signal,
                text: segment,
                voice,
                onChunk: (chunk) => {
                  if (closed) return;
                  try {
                    res.write(chunk);
                  } catch {
                    /* the client went away; the stream ends on its own */
                  }
                },
              });
            }
            res.end();
          } catch (failure) {
            if (!res.headersSent) {
              sendJson(res, 502, {
                error: String((failure && failure.message) || failure).slice(0, 400),
                provider: tts.name,
              });
              return;
            }
            try {
              res.end();
            } catch {
              /* already closed */
            }
          }
        }),
      }),
    'dsh-aura: speech synthesis route',
  );

  /* Diagnostics and the actual Host origin for desktop dsh-app:// pages.
   * Module replacement belongs to DSH; never auto-reload the whole GUI. */
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/aura/version',
        handler: async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            res.end();
            return;
          }
          let version = '0.0.0';
          try {
            const manifest = JSON.parse(
              await readFile(new URL('./package.json', import.meta.url), 'utf8'),
            );
            version = String(manifest.version || version);
          } catch {
            /* the version is a convenience; a missing manifest is not fatal */
          }
          /* The page may be served from dsh-app://, where location.host is not
           * the host. Name the real origin so the browser can build a socket
           * URL for the live recognizer. */
          let origin;
          try {
            origin = ctx.webServer.getOrigin();
          } catch {
            origin = undefined;
          }
          sendJson(res, 200, { version, origin });
        },
      }),
    'dsh-aura: version route',
  );
}
