/**
 * The live recognition protocol, driven through the `connect` seam: the
 * handshake, the listen frames, partial then final, and the generation filter.
 * Run with `node test/live.test.mjs`.
 *
 * The frames are the ones the XiaoZhi bridge speaks
 * (`server.py: device_websocket_hello / device_websocket_control`).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { liveTurn } from '../index.js';

/** A fake WebSocket peer: records sends, accepts injected frames. */
function peer() {
  const emitter = new EventEmitter();
  emitter.readyState = 1;
  emitter.OPEN = 1;
  emitter.sent = [];
  emitter.texts = [];
  emitter.send = (value) => {
    emitter.sent.push(value);
    try {
      emitter.texts.push(JSON.parse(String(value)));
    } catch {
      /* binary */
    }
  };
  emitter.close = () => {
    emitter.readyState = 3;
    emitter.emit('close');
  };
  emitter.receive = (value) => {
    const binary = Buffer.isBuffer(value);
    emitter.emit('message', value, binary);
  };
  return emitter;
}

/** A scripted recognizer channel. */
function channel() {
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
  const received = [];
  const handle = {
    received,
    push,
    sent: [],
    send(value) {
      handle.sent.push(value);
      if (typeof value === 'string') {
        const message = JSON.parse(value);
        const action = message.header && message.header.action;
        if (action === 'run-task') {
          push({ isBinary: false, data: JSON.stringify({ header: { event: 'task-started' } }) });
        }
        if (action === 'finish-task') {
          push({ isBinary: false, data: JSON.stringify({
            header: { event: 'result-generated' },
            payload: { output: { sentence: { text: '帮我看看插件市场', sentence_end: true } }, usage: { duration: 2 } },
          }) });
          push({ isBinary: false, data: JSON.stringify({ header: { event: 'task-finished' } }) });
        }
      } else {
        received.push(Buffer.from(value));
      }
    },
    async next() {
      while (inbox.length === 0) await new Promise((resume) => { notify = resume; });
      return inbox.shift();
    },
    close() {},
  };
  return handle;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/* ---- the handshake, a turn, and the transcript --------------------------- */

{
  const connection = peer();
  const recognizer = channel();
  const config = { provider: 'bailian_paraformer_realtime', connect: async () => recognizer };
  await liveTurn(connection, config, async () => 'test-key');

  /* Nothing but hello may be spoken first. */
  connection.receive(JSON.stringify({ type: 'listen', state: 'start' }));
  await tick();
  assert.equal(connection.texts.at(-1).type, 'error', 'a turn before hello is refused');

  connection.receive(JSON.stringify({ type: 'hello', transport: 'websocket' }));
  await tick();
  const hello = connection.texts.at(-1);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.transport, 'websocket');
  assert.equal(hello.audio_params.format, 'pcm16');
  assert.equal(hello.audio_params.sample_rate, 16000);
  assert.equal(hello.audio_params.frame_duration, 100);
  assert.ok(hello.session_id, 'the session is named');

  connection.receive(JSON.stringify({ type: 'listen', state: 'start', mode: 'manual' }));
  await tick();
  await tick();
  const started = connection.texts.at(-1);
  assert.equal(started.type, 'listen');
  assert.equal(started.state, 'start');
  assert.equal(started.mode, 'manual');

  /* A run-task reached the recognizer. */
  const runTask = JSON.parse(recognizer.sent[0]);
  assert.equal(runTask.header.action, 'run-task');
  assert.equal(runTask.payload.parameters.format, 'pcm');

  /* Binary audio is forwarded untouched. */
  const pcm = Buffer.alloc(3200, 7);
  connection.receive(pcm);
  await tick();
  assert.equal(recognizer.received.length, 1);
  assert.deepEqual(recognizer.received[0], pcm);

  /* A partial MUST arrive while capture is still open, before finish-task. */
  recognizer.push({ isBinary: false, data: JSON.stringify({
    header: { event: 'result-generated' },
    payload: { output: { sentence: { text: '帮我看看', sentence_end: false } } },
  }) });
  await tick();
  const partial = connection.texts.filter((message) => message.type === 'stt').at(-1);
  assert.equal(partial?.text, '帮我看看');
  assert.equal(partial.partial, true);
  assert.equal(recognizer.sent.filter((value) => typeof value === 'string').length, 1,
    'recognition must not wait for finish-task');

  /* Stopping ends the turn with a final transcript. */
  connection.receive(JSON.stringify({ type: 'listen', state: 'stop' }));
  await tick();
  await tick();
  await tick();
  const final = connection.texts.filter((message) => message.type === 'stt').at(-1);
  assert.ok(final, 'a final transcript must be sent');
  assert.equal(final.partial, false);
  assert.equal(final.text, '帮我看看插件市场');
  assert.equal(final.session_id, hello.session_id);
}

/* ---- audio before a turn is dropped, not queued ------------------------- */

{
  const connection = peer();
  const recognizer = channel();
  await liveTurn(connection, { connect: async () => recognizer }, async () => 'k');
  connection.receive(JSON.stringify({ type: 'hello', transport: 'websocket' }));
  await tick();
  connection.receive(Buffer.alloc(1600, 1));
  await tick();
  assert.equal(recognizer.received.length, 0, 'no audio outside a turn');
}

/* ---- a dead stream hands the turn to the other provider ----------------- */

{
  const connection = peer();
  const dead = {
    send() {},
    async next() {
      throw new Error('The free quota has been exhausted');
    },
    close() {},
  };
  const fallback = {
    name: 'bailian',
    async transcribe({ pcm }) {
      assert.ok(pcm.length > 0, 'the fallback must receive the buffered audio');
      return { text: '降级成功', detail: `wav ${pcm.length}` };
    },
  };
  await liveTurn(connection, { connect: async () => dead }, async () => 'k', fallback);
  connection.receive(JSON.stringify({ type: 'hello', transport: 'websocket' }));
  await tick();
  connection.receive(JSON.stringify({ type: 'listen', state: 'start' }));
  await tick();
  await tick();
  connection.receive(Buffer.alloc(6400, 3));
  await tick();
  connection.receive(JSON.stringify({ type: 'listen', state: 'stop' }));
  await tick();
  await tick();
  await tick();
  const stt = connection.texts.filter((message) => message.type === 'stt').at(-1);
  assert.ok(stt, 'the fallback answer must be sent as a transcript');
  assert.equal(stt.text, '降级成功');
  assert.equal(stt.partial, false);
  assert.equal(stt.fallback, 'bailian');
}

/* ---- replacement capture rejects stale partials ----------------------- */
{
  const connection = peer();
  const old = channel();
  const fresh = channel();
  const channels = [old, fresh];
  await liveTurn(connection, { connect: async () => channels.shift() }, async () => 'k');
  connection.receive(JSON.stringify({ type: 'hello' }));
  connection.receive(JSON.stringify({ type: 'listen', state: 'start' }));
  await tick();
  connection.receive(JSON.stringify({ type: 'listen', state: 'start' }));
  await tick();
  const partial = (text) => ({ isBinary: false, data: JSON.stringify({
    header: { event: 'result-generated' },
    payload: { output: { sentence: { text, sentence_end: false } } },
  }) });
  old.push(partial('旧轮次结果'));
  fresh.push(partial('新轮次结果'));
  await tick();
  assert.deepEqual(connection.texts.filter((m) => m.type === 'stt').map((m) => m.text), ['新轮次结果']);
  connection.close();
  fresh.push(partial('关闭后的结果'));
  await tick();
  assert.equal(connection.texts.filter((m) => m.type === 'stt').length, 1);
}

/* ---- provider failure during capture is held for fallback, not unhandled */
{
  const connection = peer();
  const recognizer = channel();
  const fallback = { name: 'test', async transcribe() { return { text: '保留了这一轮' }; } };
  await liveTurn(connection, { connect: async () => recognizer }, async () => 'k', fallback);
  connection.receive(JSON.stringify({ type: 'hello' }));
  connection.receive(JSON.stringify({ type: 'listen', state: 'start' }));
  await tick();
  connection.receive(Buffer.alloc(6400, 1));
  recognizer.push({ isBinary: false, data: JSON.stringify({
    header: { event: 'task-failed', error_message: 'provider disconnected' },
  }) });
  await tick();
  connection.receive(JSON.stringify({ type: 'listen', state: 'stop' }));
  await tick();
  assert.equal(connection.texts.filter((m) => m.type === 'stt').at(-1)?.text, '保留了这一轮');
}

/* ---- startup audio is flushed once, before subsequent live frames -------- */
{
  const connection = peer();
  const recognizer = channel();
  const key = Promise.withResolvers();
  await liveTurn(connection, { connect: async () => recognizer }, () => key.promise);
  connection.receive(JSON.stringify({ type: 'hello' }));
  connection.receive(JSON.stringify({ type: 'listen', state: 'start' }));
  const early = Buffer.alloc(3200, 1);
  const later = Buffer.alloc(3200, 2);
  connection.receive(early);
  assert.equal(recognizer.received.length, 0);
  key.resolve('k');
  await tick();
  connection.receive(later);
  assert.deepEqual(recognizer.received, [early, later]);
  connection.receive(JSON.stringify({ type: 'listen', state: 'stop' }));
  await tick();
}

console.log('live.test.mjs: ok');
