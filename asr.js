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
  model: 'fun-asr-flash-2026-06-15',
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
      const apiKey = readKey();
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
            model: options.model ?? DEFAULTS.model,
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
        if (!text) throw new Error('Bailian ASR returned no transcript');
        return { text, detail: `wav ${wav.length} bytes` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * @param {object} config resolved plugin config (`asr` section of the row).
 * @param {() => string | undefined} readKey returns the API key from config or env.
 */
export function createAsr(config = {}, readKey = () => process.env.DASHSCOPE_API_KEY) {
  const merged = { ...DEFAULTS, ...config };
  if (merged.provider === 'bailian') return bailianProvider(merged, readKey);
  return fakeProvider(merged);
}
