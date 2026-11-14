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
 * Session control lives in the browser half through `sessions.binding()`; there
 * is nothing for the host to do there.
 */
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createAsr, openParaformerSession } from './asr.js';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { createKeyReader } from './secrets.js';
import { createTts } from './tts.js';

export const inject = ['webServer'];

/** One line per report; trimmed so a runaway loop cannot fill the disk. */
const MAX_LINES = 2000;
/** Cap one recording: a minute of 16 kHz mono PCM16 is under 2 MiB. */
const MAX_PCM_BYTES = 8 * 1024 * 1024;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
/** Credential record this plugin owns, as `<scope>/<id>`. */
const CREDENTIAL_KEY = 'dsh-aura/asr';

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
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
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
export async function liveTurn(peer, asrConfig, readKey) {
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

  peer.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (session && !finishing) {
        try {
          session.send(Buffer.isBuffer(data) ? data : Buffer.from(data));
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
      try {
        const apiKey = await readKey(asrConfig.apiKey);
        const opened = await openParaformerSession({
          apiKey,
          baseUrl: asrConfig.baseUrl,
          model: asrConfig.model,
          maxSentenceSilenceMs: asrConfig.maxSentenceSilenceMs,
          /* Injectable so the protocol can be exercised without a socket. */
          connect: asrConfig.connect,
        });
        if (mine !== generation) {
          opened.close();
          return;
        }
        session = opened;
        send({ type: 'listen', state: 'start', mode });
      } catch (failure) {
        send({ type: 'error', message: String((failure && failure.message) || failure).slice(0, 300) });
      }
      return;
    }

    if (message.type === 'listen' && message.state === 'stop') {
      if (!session || finishing) return;
      const mine = generation;
      const current = session;
      finishing = current
        .finish((update) => {
          if (mine === generation) send({ type: 'stt', text: update.latest, partial: true });
        })
        .then((result) => {
          if (mine !== generation) return;
          send({ type: 'stt', text: result.text || '', partial: false, duration: result.duration });
        })
        .catch((failure) => {
          send({ type: 'error', message: String((failure && failure.message) || failure).slice(0, 300) });
        })
        .finally(() => {
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
            void liveTurn(peer, asrConfig, readKey);
          });
        },
      }),
    'dsh-aura: live recognition route',
  );
  const tts = createTts(config.tts || {}, readKey);

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
        handler: async (req, res) => {
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
            const result = await asr.transcribe({
              pcm,
              sampleRate: Number(request.sampleRate) || 16000,
              channels: Number(request.channels) || 1,
              hints: Array.isArray(request.hints) ? request.hints.map(String).slice(0, 8) : [],
            });
            sendJson(res, 200, { text: result.text, provider: asr.name, detail: result.detail });
          } catch (failure) {
            sendJson(res, 502, {
              error: String((failure && failure.message) || failure).slice(0, 400),
              provider: asr.name,
            });
          }
        },
      }),
    'dsh-aura: speech to text route',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/aura/tts',
        handler: async (req, res) => {
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
          if (!text) {
            sendJson(res, 400, { error: 'no text' });
            return;
          }
          try {
            const result = await tts.synthesize({ text });
            sendJson(res, 200, {
              pcm: result.pcm.toString('base64'),
              sampleRate: result.sampleRate,
              provider: tts.name,
              voice: result.voice,
              chars: text.length,
            });
          } catch (failure) {
            sendJson(res, 502, {
              error: String((failure && failure.message) || failure).slice(0, 400),
              provider: tts.name,
            });
          }
        },
      }),
    'dsh-aura: speech synthesis route',
  );
}
