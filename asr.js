/**
 * Speech to text for dsh-aura, host side.
 *
 * Mirrors the provider split the Zebra bridge settled on
 * (`src/xiaozhi_openclaw_bridge/asr.py`): a `fake` provider that proves the
 * plumbing without credentials, and Bailian Fun-ASR Flash for real use. Both
 * accept PCM16 and return plain text, so the browser never learns which
 * provider answered.
 *
 * The streaming provider (Paraformer realtime over a WebSocket, Ogg-Opus
 * framed) is deliberately absent: that framing exists for the device link this
 * plugin does not have. The browser sends PCM, so one-shot is the baseline and
 * a PCM streaming provider can slot in behind the same `transcribe` contract
 * when the latency budget needs it.
 */

const DEFAULTS = {
  provider: 'fake',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  timeoutMs: 60000,
  fakeText: '这是一次测试识别',
};

/** Wrap PCM16LE in a RIFF/WAVE container so providers get a file they accept. */
export function pcm16ToWav(pcm, sampleRate = 16000, channels = 1) {
  const bytes = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const header = Buffer.alloc(44);
  const blockAlign = channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([header, bytes]);
}

/** The Bailian reply nests the transcript; every documented shape is covered. */
export function textOfResponse(response) {
  const pick = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
  const output = response && response.output;
  if (output && typeof output === 'object') {
    const direct = pick(output.text);
    if (direct) return direct;
    const sentence = output.sentence;
    if (sentence && typeof sentence === 'object' && pick(sentence.text)) return pick(sentence.text);
  }
  const direct = pick(response && response.text);
  if (direct) return direct;
  const sentence = response && response.sentence;
  if (sentence && typeof sentence === 'object') return pick(sentence.text);
  return '';
}

function endpointOf(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return base.endsWith('/services/aigc/multimodal-generation/generation')
    ? base
    : base + '/services/aigc/multimodal-generation/generation';
}

function fakeProvider(options) {
  return {
    name: 'fake',
    async transcribe({ pcm }) {
      if (!pcm || pcm.length === 0) throw new Error('no audio');
      return { text: options.fakeText ?? DEFAULTS.fakeText, detail: `${pcm.length} bytes` };
    },
  };
}

function bailianProvider(options, readKey) {
  return {
    name: 'bailian',
    async transcribe({ pcm, sampleRate = 16000, channels = 1, hints = [], signal }) {
      if (!pcm || pcm.length === 0) throw new Error('no audio');
      const apiKey = await readKey(options.apiKey);
      if (!apiKey) throw new Error('Bailian ASR needs an API key');

      const wav = pcm16ToWav(pcm, sampleRate, channels);
      const messages = [];
      if (hints.length > 0) {
        messages.push({
          role: 'user',
          content: [{ type: 'input_text', text: hints.join(' ').slice(0, 400) }],
        });
      }
      messages.push({
        role: 'user',
        content: [
          { type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + wav.toString('base64') } },
        ],
      });

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? DEFAULTS.timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      try {
        const response = await fetch(endpointOf(options.baseUrl ?? DEFAULTS.baseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-DashScope-SSE': 'disable',
          },
          body: JSON.stringify({
            /* The name `bailian_fun_flash` is historical: the bridge's logs say
             * fun-asr-flash while the model that actually ran came from
             * XOB_BAILIAN_ASR_MODEL. qwen-audio-3.1-asr-flash is the one with
             * recent log evidence. */
            model: options.model ?? 'qwen-audio-3.1-asr-flash',
            input: { messages },
            parameters: { format: 'wav', sample_rate: String(sampleRate) },
          }),
          signal: composed,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Bailian ASR HTTP ${response.status}: ${body.slice(0, 300)}`);
        }
        const payload = await response.json();
        const text = textOfResponse(payload);
        /* Silence is a normal outcome, not a failure: the caller drops an empty
         * transcript instead of submitting it to the agent. */
        return { text, detail: `wav ${wav.length} bytes` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/* ---- Paraformer realtime -------------------------------------------------
 *
 * The provider the Zebra bridge runs in production
 * (docs/PHASE7B_ASR_PROVIDER.md: `XOB_ASR_PROVIDER=bailian_paraformer_realtime`,
 * model `paraformer-realtime-v2`). It is a duplex WebSocket: `run-task`, then
 * PCM chunks as binary frames, then `finish-task`, reading
 * `result-generated` events until `task-finished`.
 *
 * `connect` is a seam so the protocol can be exercised without a socket.
 */
function paraformerUrl(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.host || parsed.pathname;
    return `wss://${host}/api-ws/v1/inference`;
  } catch {
    return 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
  }
}

/** Default transport: the `ws` package, imported lazily so other providers
 * work even when it is absent. */
async function defaultConnect(url, apiKey, timeoutMs) {
  const { WebSocket } = await import('ws');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      handshakeTimeout: timeoutMs,
    });
    const queue = [];
    let notify = null;
    let settled = false;
    const wake = () => {
      if (notify) {
        const resume = notify;
        notify = null;
        resume();
      }
    };
    socket.on('message', (data, isBinary) => {
      queue.push({ data, isBinary });
      wake();
    });
    socket.on('error', (error) => {
      settled = true;
      queue.push({ error });
      wake();
    });
    socket.on('close', () => {
      settled = true;
      wake();
    });
    socket.on('open', () => {
      resolve({
        send(value) {
          socket.send(value);
        },
        async next() {
          while (queue.length === 0 && !settled) await new Promise((resume) => { notify = resume; });
          return queue.shift();
        },
        close() {
          try {
            socket.close();
          } catch {
            /* already closed */
          }
        },
      });
    });
  });
}

function readJson(frame) {
  const text = frame.isBinary ? frame.data.toString('utf8') : String(frame.data ?? '');
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw new Error('Bailian returned invalid JSON over the socket');
  }
}

async function awaitEvent(channel, wanted) {
  for (;;) {
    const frame = await channel.next();
    if (!frame) throw new Error(`Bailian socket closed before ${wanted}`);
    if (frame.error) throw frame.error;
    if (frame.isBinary) continue;
    const message = readJson(frame);
    const header = (message && message.header) || {};
    if (header.event === 'task-failed') {
      throw new Error(String(header.error_message || header.error_code || 'Paraformer task failed'));
    }
    if (header.event === wanted) return message;
  }
}

async function readParaformerResult(channel, onUpdate) {
  const finished = [];
  let latest = '';
  let duration;
  for (;;) {
    const frame = await channel.next();
    if (!frame) break;
    if (frame.error) throw frame.error;
    if (frame.isBinary) continue;
    const message = readJson(frame);
    const header = message.header || {};
    const event = header.event;
    if (event === 'task-failed') {
      throw new Error(String(header.error_message || header.error_code || 'Paraformer task failed'));
    }
    const payload = message.payload || {};
    const output = payload.output || {};
    const sentence = output.sentence || {};
    if (typeof sentence.text === 'string' && sentence.text.trim()) {
      latest = sentence.text.trim();
      if (sentence.sentence_end === true) finished.push(latest);
      if (typeof onUpdate === 'function') onUpdate({ latest, end: sentence.sentence_end === true });
    }
    const usage = payload.usage || {};
    if (typeof usage.duration === 'number') duration = usage.duration;
    if (event === 'task-finished') break;
  }
  const text = finished.join('').trim() || latest;
  return { text, duration };
}

/**
 * Open a duplex Paraformer session and keep it open.
 *
 * This is what makes a live endpoint possible: partial results arrive while the
 * user is still talking, so the caller can decide that a sentence is complete
 * without waiting for a silence gap.
 */
export async function openParaformerSession(options) {
  const {
    apiKey,
    baseUrl,
    model = 'paraformer-realtime-v2',
    sampleRate = 16000,
    maxSentenceSilenceMs = 800,
    hints = ['zh', 'en'],
    timeoutMs = 60000,
    connect = defaultConnect,
  } = options;
  if (!apiKey) throw new Error('Bailian ASR needs an API key');

  const channel = await connect(paraformerUrl(baseUrl), apiKey, timeoutMs);
  const taskId = globalThis.crypto?.randomUUID?.() ?? `aura-${Date.now()}`;

  const parameters = {
    format: 'pcm',
    sample_rate: sampleRate,
    disfluency_removal_enabled: false,
    punctuation_prediction_enabled: true,
    semantic_punctuation_enabled: false,
    max_sentence_silence: maxSentenceSilenceMs,
  };
  if (hints.length > 0) parameters.language_hints = hints;

  channel.send(
    JSON.stringify({
      header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
      payload: { task_group: 'audio', task: 'asr', function: 'recognition', model, parameters, input: {} },
    }),
  );
  await awaitEvent(channel, 'task-started');

  let reading = null;
  return {
    send(pcm) {
      channel.send(pcm);
    },
    /** Stop accepting audio, wait for the final transcript. */
    finish(onUpdate) {
      if (reading) return reading;
      channel.send(
        JSON.stringify({
          header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
          payload: { input: {} },
        }),
      );
      reading = readParaformerResult(channel, onUpdate);
      return reading;
    },
    close() {
      channel.close();
    },
  };
}

function paraformerProvider(options, readKey) {
  const chunkBytes = options.chunkBytes ?? 3200;
  const maxSilenceMs = options.maxSentenceSilenceMs ?? 800;
  return {
    name: 'bailian_paraformer_realtime',
    async transcribe({ pcm, sampleRate = 16000, hints = [] }) {
      if (!pcm || pcm.length === 0) throw new Error('no audio');
      const apiKey = await readKey(options.apiKey);
      if (!apiKey) throw new Error('Bailian ASR needs an API key');

      const model = options.model ?? 'paraformer-realtime-v2';
      const timeoutMs = options.timeoutMs ?? 60000;
      const connect = options.connect ?? defaultConnect;
      const taskId = globalThis.crypto?.randomUUID?.() ?? `aura-${Date.now()}`;

      const parameters = {
        format: 'pcm',
        sample_rate: sampleRate,
        disfluency_removal_enabled: false,
        punctuation_prediction_enabled: true,
        semantic_punctuation_enabled: false,
        max_sentence_silence: maxSilenceMs,
      };
      const languageHints = hints.length > 0 ? hints : ['zh', 'en'];
      if (languageHints.length > 0) parameters.language_hints = languageHints;

      const channel = await connect(paraformerUrl(options.baseUrl), apiKey, timeoutMs);
      const deadline = setTimeout(() => channel.close(), timeoutMs);
      try {
        channel.send(
          JSON.stringify({
            header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
            payload: {
              task_group: 'audio',
              task: 'asr',
              function: 'recognition',
              model,
              parameters,
              input: {},
            },
          }),
        );
        await awaitEvent(channel, 'task-started');

        for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
          channel.send(pcm.subarray(offset, offset + chunkBytes));
        }
        channel.send(
          JSON.stringify({
            header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
            payload: { input: {} },
          }),
        );

        const { text, duration } = await readParaformerResult(channel);
        return {
          text,
          detail: `paraformer pcm ${pcm.length} bytes${duration ? ` duration=${duration}s` : ''}`,
        };
      } finally {
        clearTimeout(deadline);
        channel.close();
      }
    },
  };
}

/**
 * @param {object} config resolved plugin config (`asr` section of the row).
 * @param {(configKey?: string) => string | Promise<string | undefined>} readKey
 *   resolves the provider key per request; see `secrets.js`.
 */
export function createAsr(config = {}, readKey = (configKey) => configKey || process.env.DASHSCOPE_API_KEY) {
  const merged = { ...DEFAULTS, ...config };
  const selected = String(merged.provider || 'fake').trim();
  if (selected === 'bailian_paraformer_realtime' || selected === 'paraformer_realtime') {
    return paraformerProvider(merged, readKey);
  }
  if (selected === 'bailian_fun_flash' || selected === 'bailian') {
    return bailianProvider(merged, readKey);
  }
  return fakeProvider(merged);
}
