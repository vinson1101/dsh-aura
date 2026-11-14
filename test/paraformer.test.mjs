/**
 * The Paraformer realtime protocol, driven through the `connect` seam: no
 * socket, no key, no network. Asserts the exact frames the bridge sends.
 * Run with `node test/paraformer.test.mjs`.
 */
import assert from 'node:assert/strict';
import { createAsr } from '../asr.js';

const PCM = Buffer.alloc(7000, 9);

/** A scripted channel: records every send and replies by protocol step. */
function scriptedChannel({ fail } = {}) {
  const sent = [];
  const inbox = [];
  let notify = null;
  const wake = () => {
    if (notify) {
      const resume = notify;
      notify = null;
      resume();
    }
  };
  const push = (value) => {
    inbox.push(value);
    wake();
  };

  const channel = {
    sent,
    send(value) {
      sent.push(value);
      if (typeof value === 'string') {
        const message = JSON.parse(value);
        const action = message.header && message.header.action;
        if (action === 'run-task') {
          if (fail) {
            push({ isBinary: false, data: JSON.stringify({ header: { event: 'task-failed', error_message: fail } }) });
          } else {
            push({ isBinary: false, data: JSON.stringify({ header: { event: 'task-started' } }) });
          }
        }
        if (action === 'finish-task') {
          push({ isBinary: false, data: JSON.stringify({
            header: { event: 'result-generated' },
            payload: { output: { sentence: { text: '你好，', sentence_end: true } } },
          }) });
          push({ isBinary: false, data: JSON.stringify({
            header: { event: 'result-generated' },
            payload: { output: { sentence: { text: '我是斑马', sentence_end: false } } },
          }) });
          push({ isBinary: false, data: JSON.stringify({
            header: { event: 'result-generated' },
            payload: {
              output: { sentence: { text: '世界', sentence_end: true } },
              usage: { duration: 3 },
            },
          }) });
          push({ isBinary: false, data: JSON.stringify({ header: { event: 'task-finished' } }) });
        }
      }
    },
    async next() {
      while (inbox.length === 0) await new Promise((resume) => { notify = resume; });
      return inbox.shift();
    },
    close() {},
  };
  return channel;
}

/* ---- the happy path ----------------------------------------------------- */

{
  const channel = scriptedChannel();
  const asr = createAsr(
    {
      provider: 'bailian_paraformer_realtime',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      connect: async () => channel,
    },
    () => 'test-key',
  );
  assert.equal(asr.name, 'bailian_paraformer_realtime');

  const result = await asr.transcribe({ pcm: PCM, sampleRate: 16000 });
  assert.equal(result.text, '你好，世界', 'only sentence_end sentences are concatenated');
  assert.match(result.detail, /duration=3s/);

  const text = channel.sent.filter((value) => typeof value === 'string').map((value) => JSON.parse(value));
  assert.equal(text.length, 2, 'one run-task and one finish-task');

  const run = text[0];
  assert.equal(run.header.action, 'run-task');
  assert.equal(run.header.streaming, 'duplex');
  assert.ok(run.header.task_id, 'a task id is required');
  assert.equal(run.payload.task_group, 'audio');
  assert.equal(run.payload.task, 'asr');
  assert.equal(run.payload.function, 'recognition');
  assert.equal(run.payload.model, 'paraformer-realtime-v2', 'the model the bridge runs in production');
  assert.equal(run.payload.parameters.format, 'pcm', 'PCM goes straight in, no WAV or Ogg wrapper');
  assert.equal(run.payload.parameters.sample_rate, 16000);
  assert.equal(run.payload.parameters.max_sentence_silence, 800, 'same endpointing the bridge uses');
  assert.deepEqual(run.payload.parameters.language_hints, ['zh', 'en']);
  assert.equal(run.payload.parameters.punctuation_prediction_enabled, true);

  assert.equal(text[1].header.action, 'finish-task');

  const audio = channel.sent.filter((value) => Buffer.isBuffer(value));
  assert.equal(audio.length, 3, '7000 bytes split into 3200 byte frames');
  assert.deepEqual(Buffer.concat(audio), PCM, 'the audio must arrive intact and in order');
  assert.ok(audio.every((chunk) => chunk.length <= 3200));
}

/* ---- hints replace the default ------------------------------------------ */

{
  const channel = scriptedChannel();
  const asr = createAsr({ provider: 'bailian_paraformer_realtime', connect: async () => channel }, () => 'k');
  await asr.transcribe({ pcm: PCM, hints: ['zh'] });
  const run = JSON.parse(channel.sent[0]);
  assert.deepEqual(run.payload.parameters.language_hints, ['zh']);
}

/* ---- a failed task must reject, not return empty text -------------------- */

{
  const channel = scriptedChannel({ fail: 'invalid audio format' });
  const asr = createAsr({ provider: 'bailian_paraformer_realtime', connect: async () => channel }, () => 'k');
  await assert.rejects(() => asr.transcribe({ pcm: PCM }), /invalid audio format/);
}

/* ---- no key, no connection ---------------------------------------------- */

{
  let connected = false;
  const asr = createAsr(
    {
      provider: 'bailian_paraformer_realtime',
      connect: async () => {
        connected = true;
        return scriptedChannel();
      },
    },
    () => undefined,
  );
  await assert.rejects(() => asr.transcribe({ pcm: PCM }), /API key/);
  assert.equal(connected, false);
}

console.log('paraformer.test.mjs: ok');
