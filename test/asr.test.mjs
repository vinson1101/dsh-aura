/**
 * Host-side speech-to-text: the WAV wrapper, the response shapes, and the two
 * providers. Run with `node test/asr.test.mjs`.
 *
 * The Bailian provider is exercised against a stubbed fetch, so the request
 * shape is checked without a key and without leaving the machine.
 */
import assert from 'node:assert/strict';
import { createAsr, pcm16ToWav, textOfResponse } from '../asr.js';

/* ---- WAV container ------------------------------------------------------ */

const pcm = Buffer.alloc(3200, 7);
const wav = pcm16ToWav(pcm, 16000, 1);
assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
assert.equal(wav.readUInt16LE(20), 1, 'format must be PCM');
assert.equal(wav.readUInt16LE(22), 1, 'channels');
assert.equal(wav.readUInt32LE(24), 16000, 'sample rate');
assert.equal(wav.readUInt16LE(34), 16, 'bits per sample');
assert.equal(wav.readUInt32LE(40), pcm.length, 'data chunk length');
assert.equal(wav.length, 44 + pcm.length);

/* ---- response shapes the provider has to tolerate ----------------------- */

assert.equal(textOfResponse({ output: { text: ' hello ' } }), 'hello');
assert.equal(textOfResponse({ output: { sentence: { text: ' a ' } } }), 'a');
assert.equal(textOfResponse({ text: 'top' }), 'top');
assert.equal(textOfResponse({ sentence: { text: 'sent' } }), 'sent');
assert.equal(textOfResponse({}), '');
assert.equal(textOfResponse(null), '');

/* ---- fake provider ------------------------------------------------------ */

{
  const asr = createAsr({ provider: 'fake', fakeText: '测试通过' });
  assert.equal(asr.name, 'fake');
  const result = await asr.transcribe({ pcm });
  assert.equal(result.text, '测试通过');
  await assert.rejects(() => asr.transcribe({ pcm: Buffer.alloc(0) }), /no audio/);
}

/* ---- bailian provider, stubbed fetch ------------------------------------ */

{
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { output: { text: '你好，我是斑马' } };
      },
      async text() {
        return '';
      },
    };
  };

  const asr = createAsr({ provider: 'bailian', baseUrl: 'https://example.test/api/v1/', model: 'm' }, () => 'k');
  assert.equal(asr.name, 'bailian');
  const result = await asr.transcribe({ pcm, sampleRate: 16000, hints: ['斑马', 'Aura'] });
  assert.equal(result.text, '你好，我是斑马');

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://example.test/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer k');
  assert.equal(init.headers['X-DashScope-SSE'], 'disable');

  const body = JSON.parse(init.body);
  assert.equal(body.model, 'm');
  assert.equal(body.parameters.format, 'wav');
  assert.equal(body.parameters.sample_rate, '16000');
  assert.equal(body.input.messages.length, 2, 'hints then audio');
  assert.equal(body.input.messages[0].content[0].text, '斑马 Aura');
  const audio = body.input.messages[1].content[0].input_audio.data;
  assert.ok(audio.startsWith('data:audio/wav;base64,'), 'audio travels as a WAV data URI');
  const decoded = Buffer.from(audio.split(',')[1], 'base64');
  assert.equal(decoded.subarray(0, 4).toString(), 'RIFF');
}

/* ---- a refused request must surface, not return empty text -------------- */

{
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    async text() {
      return 'rate limited';
    },
    async json() {
      return {};
    },
  });
  const asr = createAsr({ provider: 'bailian' }, () => 'k');
  await assert.rejects(() => asr.transcribe({ pcm }), /HTTP 429/);
}

/* ---- a missing key must fail before any network call ------------------- */

{
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return {};
  };
  const asr = createAsr({ provider: 'bailian' }, () => undefined);
  await assert.rejects(() => asr.transcribe({ pcm }), /API key/);
  assert.equal(called, false, 'no request without a key');
}

console.log('asr.test.mjs: ok');
