/**
 * Speech synthesis assembly: the SSE stream, the one-time RIFF strip, and the
 * provider request. Run with `node test/tts.test.mjs`.
 */
import assert from 'node:assert/strict';
import { assemblePcm, audioOfEvent, createTts, sseData, stripWaveHeader, trimSilence } from '../tts.js';

/* ---- the SSE line splitter survives chunk boundaries -------------------- */

{
  const chunks = ['data: {"a":1}\n\ndata: {"b"', ':2}\n\n', 'data: {"c":3}'];
  const lines = [];
  for await (const line of sseData(chunks)) lines.push(line);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
}

/* ---- events without audio are skipped ----------------------------------- */

assert.equal(audioOfEvent({ output: { audio: { data: '' } } }).length, 0);
assert.equal(audioOfEvent({ output: {} }).length, 0);
assert.equal(audioOfEvent({}).length, 0);
assert.equal(audioOfEvent({ output: { audio: { data: 'AAEC' } } }).length, 3);

/* ---- the WAV header is stripped once, from the front -------------------- */

{
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  assert.deepEqual(stripWaveHeader(Buffer.concat([header, pcm])), pcm, 'header removed');
  assert.deepEqual(stripWaveHeader(pcm), pcm, 'bare PCM is untouched');
  assert.deepEqual(stripWaveHeader(Buffer.from('RIFF')), Buffer.from('RIFF'), 'short buffers are untouched');
}

/* ---- assembling a stream that carries the header in its first slice ----- */

{
  const wav = (payload) => {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.write('data', 36);
    header.writeUInt32LE(payload.length, 40);
    return Buffer.concat([header, payload]);
  };
  const first = wav(Buffer.from([9, 9]));
  const second = Buffer.from([8, 8]);

  const events = [
    `data: ${JSON.stringify({ output: { audio: { data: first.toString('base64') } } })}`,
    `data: ${JSON.stringify({ output: {} })}`,
    `data: ${JSON.stringify({ output: { audio: { data: second.toString('base64') } } })}`,
  ];
  const pcm = await assemblePcm([events.join('\n') + '\n']);
  assert.deepEqual([...pcm], [9, 9, 8, 8], 'header stripped once, slices concatenated in order');
}

/* ---- dead air is trimmed, the speech itself is kept -------------------- */

{
  const make = (parts) => {
    const buffer = Buffer.alloc(parts.length * 2);
    parts.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
    return buffer;
  };
  /* Enough quiet on both sides that the margin is not clamped by the edges. */
  const quiet = new Array(400).fill(0);
  const loud = new Array(50).fill(900);
  const one = make([...quiet, ...loud, ...quiet]);

  const trimmed = trimSilence(one, { sampleRate: 16000, marginMs: 0 });
  assert.equal(trimmed.length, loud.length * 2, 'silence on both sides goes, speech stays');
  assert.deepEqual([...trimmed], [...make(loud)]);

  const margin = trimSilence(one, { sampleRate: 16000, marginMs: 10 });
  assert.equal(margin.length, (loud.length + 320) * 2, 'the margin keeps a short tail on each side');

  assert.deepEqual(trimSilence(make(quiet)), make(quiet), 'all-silent audio is left alone');
  assert.deepEqual(trimSilence(Buffer.alloc(0)), Buffer.alloc(0));
}

/* ---- the provider request shape ---------------------------------------- */

{
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const lines = [
      `data: ${JSON.stringify({ output: { audio: { data: Buffer.from([1, 2]).toString('base64') } } })}`,
      `data: ${JSON.stringify({ output: { audio: { data: Buffer.from([3, 4]).toString('base64') } } })}`,
    ].join('\n');
    return {
      ok: true,
      status: 200,
      body: (async function* stream() {
        yield new TextEncoder().encode(lines);
      })(),
      async text() {
        return '';
      },
    };
  };

  const tts = createTts({ baseUrl: 'https://example.test/api/v1/', voice: 'longyan_v3' }, async () => 'k');
  const result = await tts.synthesize({ text: '  收到。  ' });
  assert.deepEqual([...result.pcm], [1, 2, 3, 4]);
  assert.equal(result.sampleRate, 16000);
  assert.equal(result.voice, 'longyan_v3');
  assert.equal(result.model, 'cosyvoice-v3-flash', 'the source default the Zebra path documents');

  const { url, init } = calls[0];
  assert.equal(url, 'https://example.test/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.equal(init.headers['X-DashScope-SSE'], 'enable');
  assert.equal(init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'cosyvoice-v3-flash');
  assert.deepEqual(body.input, {
    text: '收到。',
    voice: 'longyan_v3',
    format: 'wav',
    sample_rate: 16000,
  });
}

/* ---- failures surface instead of producing silence ---------------------- */

{
  globalThis.fetch = async () => ({ ok: false, status: 500, async text() { return 'boom'; } });
  const tts = createTts({}, async () => 'k');
  await assert.rejects(() => tts.synthesize({ text: '你好' }), /HTTP 500/);

  const empty = createTts({}, async () => 'k');
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: (async function* stream() {
      yield new TextEncoder().encode('data: {"output":{}}\n');
    })(),
    async text() {
      return '';
    },
  });
  await assert.rejects(() => empty.synthesize({ text: '你好' }), /no audio/);

  const noKey = createTts({}, async () => undefined);
  await assert.rejects(() => noKey.synthesize({ text: '你好' }), /API key/);

  await assert.rejects(() => empty.synthesize({ text: '   ' }), /no text/);
}

console.log('tts.test.mjs: ok');

/* ---- a long reply is cut at a sentence, not sent to the provider --------- */

{
  const { speakablePrefix } = await import('../tts.js');
  const short = speakablePrefix('收到。', 140);
  assert.equal(short.spoken, '收到。');
  assert.equal(short.truncated, false);

  const long = '第一句话在这里。'.repeat(40);
  const cut = speakablePrefix(long, 140);
  assert.ok(cut.truncated, 'a long reply is marked truncated');
  assert.ok(cut.spoken.length <= 140, 'and stays inside the budget');
  assert.ok(cut.spoken.endsWith('。'), 'cutting prefers a sentence boundary');
}

/* ---- segmentation follows the bridge's rules --------------------------- */

{
  const { textSegments } = await import('../tts.js');

  /* The bridge packs sentences up to 60 characters, then starts a new segment;
   * it does not emit one sentence per segment. */
  const text = '第一句。第二句！第三句？'
    + '后面还有很长的一段话没有任何标点符号需要硬切分才行真的超过六十个字符了所以会被切开成两段'
    + '而且还要再长一点才能确保超过六十个字符的上限并触发硬切分这里的字数已经足够多了吧';
  const segments = textSegments(text);
  assert.ok(segments.length >= 2, 'a long reply becomes several segments');
  assert.ok(segments.every((part) => part.length <= 60), 'no segment exceeds 60 characters');
  assert.equal(segments.join(''), text, 'nothing is lost or duplicated');

  /* A short sentence is packed with its neighbour rather than split off. */
  assert.deepEqual(textSegments('第一句。第二句。'), ['第一句。第二句。']);

  /* Empty input still yields something to say. */
  assert.deepEqual(textSegments('   '), ['我没听清。']);
}
