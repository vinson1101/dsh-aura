/**
 * Speech synthesis for dsh-aura, host side.
 *
 * The provider is the one the Zebra voice path runs: Bailian CosyVoice over the
 * HTTP SSE endpoint. The response is a stream of `data:` events, each carrying
 * one base64 slice of audio; the slices are consecutive pieces of **one**
 * stream, not independent files.
 *
 * Two rules from that path, both easy to get wrong:
 *
 * - skip events that carry no audio (the stream also reports progress),
 * - if the payload starts with a RIFF/WAVE header, strip it **once** for the
 *   whole stream rather than per slice.
 */

const DEFAULTS = {
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  model: 'cosyvoice-v3-flash',
  voice: 'longanyang',
  sampleRate: 16000,
  timeoutMs: 30000,
};

function endpointOf(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return base.endsWith('/services/audio/tts/SpeechSynthesizer')
    ? base
    : base + '/services/audio/tts/SpeechSynthesizer';
}

/**
 * Remove one RIFF/WAVE header from the front of a PCM stream.
 *
 * The `data` chunk is located by signature rather than assumed at byte 44,
 * because a provider is free to put other chunks first.
 */
export function stripWaveHeader(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 12) return buffer;
  if (buffer.subarray(0, 4).toString('latin1') !== 'RIFF') return buffer;
  const at = buffer.indexOf('data', 12, 'latin1');
  if (at < 0 || at + 8 > buffer.length) return buffer;
  /* Drop everything up to and including the `data` chunk header. The chunk's
   * declared size describes the first slice only, while the stream continues
   * past it — truncating to that size would cut the rest of the audio off. */
  return buffer.subarray(at + 8);
}

/** Pull `data: {...}` payloads out of an SSE text stream. */
export async function* sseData(chunks) {
  let carry = '';
  for await (const chunk of chunks) {
    carry += chunk;
    let newline = carry.indexOf('\n');
    while (newline !== -1) {
      const line = carry.slice(0, newline).trim();
      carry = carry.slice(newline + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
      newline = carry.indexOf('\n');
    }
  }
  const tail = carry.trim();
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim();
    if (payload) yield payload;
  }
}

/** Collect the audio slices from a parsed event; empty means "no audio here". */
export function audioOfEvent(event) {
  const output = event && typeof event.output === 'object' ? event.output : {};
  const audio = output && typeof output.audio === 'object' ? output.audio : {};
  const data = audio && audio.data;
  if (typeof data !== 'string' || !data.trim()) return Buffer.alloc(0);
  try {
    return Buffer.from(data, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Drop the dead air a synthesiser pads around its output.
 *
 * Measured on a real reply: 0.38 s before the first syllable and 0.40 s after
 * the last, which the listener experiences as a sluggish assistant. Keep a
 * short margin so the first phoneme and the final decay survive.
 */
export function trimSilence(pcm, { sampleRate = 16000, threshold = 200, marginMs = 60 } = {}) {
  const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const samples = Math.floor(buffer.length / 2);
  if (samples === 0) return buffer;
  let first = -1;
  let last = -1;
  for (let index = 0; index < samples; index += 1) {
    if (Math.abs(buffer.readInt16LE(index * 2)) > threshold) {
      if (first < 0) first = index;
      last = index;
    }
  }
  if (first < 0) return buffer;
  const margin = Math.round((marginMs / 1000) * sampleRate);
  const start = Math.max(0, first - margin);
  const end = Math.min(samples, last + 1 + margin);
  return buffer.subarray(start * 2, end * 2);
}

/** Turn a stream of SSE lines into one continuous PCM buffer. */
export async function assemblePcm(textChunks) {
  const pieces = [];
  for await (const payload of sseData(textChunks)) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    const audio = audioOfEvent(event);
    if (audio.length > 0) pieces.push(audio);
  }
  if (pieces.length === 0) return Buffer.alloc(0);
  /* Header first, then once: a later slice never carries the header again. */
  return stripWaveHeader(Buffer.concat(pieces));
}

export function createTts(config = {}, readKey = async (configKey) => configKey) {
  const merged = { ...DEFAULTS, ...config };

  return {
    name: 'bailian_cosyvoice',
    voice: merged.voice,
    async synthesize({ text, signal }) {
      const spoken = String(text || '').trim();
      if (!spoken) throw new Error('no text');
      const apiKey = await readKey(merged.apiKey);
      if (!apiKey) throw new Error('Bailian TTS needs an API key');

      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), merged.timeoutMs ?? DEFAULTS.timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      try {
        const response = await fetch(endpointOf(merged.baseUrl), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'X-DashScope-SSE': 'enable',
          },
          body: JSON.stringify({
            model: merged.model,
            input: {
              text: spoken,
              voice: merged.voice,
              format: 'wav',
              sample_rate: merged.sampleRate,
            },
          }),
          signal: composed,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`Bailian TTS HTTP ${response.status}: ${body.slice(0, 300)}`);
        }

        const decoder = new TextDecoder();
        const lines = (async function* read() {
          for await (const chunk of response.body) yield decoder.decode(chunk, { stream: true });
        })();

        const raw = await assemblePcm(lines);
        if (raw.length === 0) throw new Error('Bailian TTS returned no audio');
        const pcm = merged.trimSilence === false
          ? raw
          : trimSilence(raw, { sampleRate: merged.sampleRate });
        return { pcm, sampleRate: merged.sampleRate, model: merged.model, voice: merged.voice };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
