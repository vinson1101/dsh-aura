/**
 * The spoken reply: after a run we started ends, the pane asks for speech and
 * plays it. Run with `node test/reply.test.mjs`.
 *
 * The session is real enough to matter — the reply is read from the session
 * event window, not from a value the test hands over directly.
 */
import assert from 'node:assert/strict';
import { withInstanceSocket, controls } from './instance-socket.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

/* ---- environment -------------------------------------------------------- */

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://127.0.0.1:52147' });
const { window } = dom;

const context2d = {
  fillStyle: '',
  clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, arc() {}, fill() {},
  createRadialGradient: () => ({ addColorStop() {} }),
};
window.HTMLCanvasElement.prototype.getContext = () => context2d;
window.Element.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 300, width: 300, height: 300,
});
window.matchMedia = (query) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub;
let frames = 0;
window.requestAnimationFrame = (callback) => {
  frames += 1;
  if (frames > 2) return 0;
  return window.setTimeout(() => callback(window.performance.now()), 4);
};
window.cancelAnimationFrame = (id) => window.clearTimeout(id);

/* Audio playback seam: record the buffer that was started. */
const played = [];
let contextCount = 0;
class AudioContextStub {
  constructor(options = {}) {
    contextCount += 1;
    this.sampleRate = options.sampleRate || 48000;
    this.destination = {};
    this.state = "running";
    this.audioWorklet = { addModule: async () => {} };
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return {
      length,
      sampleRate: rate,
      getChannelData: () => data,
      copyToChannel: (source) => data.set(source.subarray(0, length)),
    };
  }
  createBufferSource() {
    const source = {
      buffer: null,
      onended: null,
      connect() {},
      start() { played.push({ rate: this.buffer.sampleRate, length: this.buffer.length }); },
      stop() { this.stopped = true; },
    };
    createdSources.push(source);
    return source;
  }
  createAnalyser() {
    return {
      fftSize: 512,
      getByteTimeDomainData(target) { target.fill(128); },
      connect() {},
    };
  }
  close() { return Promise.resolve(); }
}
window.AudioContext = AudioContextStub;
let captureNode;
class AudioWorkletNodeStub {
  constructor() { this.port = {}; captureNode = this; }
  connect() {}
  disconnect() {}
}
window.URL.createObjectURL = () => 'blob:aura';
window.URL.revokeObjectURL = () => {};
Object.defineProperty(window.navigator, 'mediaDevices', { value: {
  getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
} });
let speechSocket;
class WebSocketStub {
  constructor() {
    speechSocket = this;
    this.readyState = 1;
    this.bytes = 0;
    window.setTimeout(() => this.onopen?.({}), 1);
  }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
  send(value) {
    if (typeof value !== 'string') { this.bytes += value.byteLength; return; }
    const message = JSON.parse(value);
    if (message.type === 'hello') this.receive({ type: 'hello' });
    if (message.state === 'start') this.receive({ type: 'listen', state: 'start' });
  }
  close() { this.readyState = 3; }
}


/* ---- session, providers, services -------------------------------------- */

const ttsBodies = [];
const beacons = [];
const createdSources = [];
window.fetch = async (url, init = {}) => {
  if (url === '/aura/diag') {
    beacons.push(JSON.parse(init.body));
    return { ok: true, status: 200, async json() { return {}; }, async text() { return ''; } };
  }
  if (url === '/aura/tts') {
    ttsBodies.push(JSON.parse(init.body));
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(1200, 0);
    pcm.writeInt16LE(-1200, 2);
    const bytes = new Uint8Array(pcm);
    let sent = false;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name === 'x-aura-sample-rate' ? '16000' : null) },
      body: {
        getReader: () => ({
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
        }),
      },
      async json() { return {}; },
      async text() { return ''; },
    };
  }
  return { ok: true, status: 204, async json() { return {}; }, async text() { return ''; } };
};

let cancelCount = 0;
const prompts = [];
const session = {
  async prompt(content, mode) { prompts.push({ content, mode }); return { ok: true, value: { accepted: true } }; },
  async cancel() { cancelCount += 1; return { ok: true, value: { accepted: true } }; },
};
/* The window holds the previous reply during a run; the new one appears when it
 * ends. The pane must speak the difference, not whatever is newest. */
let replyText = '这是上一轮的回复。';
const entries = [
  { type: 'event', event: { type: 'user/message', data: {} } },
  {
    type: 'event',
    event: {
      type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: replyText }] } },
    },
  },
];
const listeners = new Set();
let liveSeq = 0;
const eventSource = {
  getSnapshot() {
    return { entries };
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /* One live text delta, as the real window publishes while a run streams. */
  pushLive(text) {
    liveSeq += 1;
    entries.push({
      type: 'transient',
      event: { type: 'assistant/live-chunk', seq: liveSeq, data: { chunk: { type: 'text-delta', index: 0, text } } },
    });
    for (const listener of listeners) listener();
  },
  /* The finished message landing in the durable log. */
  finish(text) {
    entries.push({
      type: 'event',
      event: { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } },
    });
  },
};
const commands = [];
let commandFailure = null;
const remote = { commands: { async execute(id, line) {
  commands.push({ id, line });
  if (commandFailure) return { ok: true, value: { result: { kind: 'error', text: commandFailure } } };
  return { ok: true, value: { result: { kind: 'success' } } };
} } };
const services = {
  get(name) {
    if (name === 'sessions') {
      return { binding: () => ({ sessionId: 'session-test', session, eventSource }) };
    }
    return { openTab: () => {} };
  },
};

const globals = {
  window,
  AudioWorkletNode: AudioWorkletNodeStub,
  WebSocket: withInstanceSocket(WebSocketStub),
  location: { origin: "http://127.0.0.1:52147", protocol: "http:", host: "127.0.0.1:52147" },
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  ResizeObserver: ResizeObserverStub,
  URL: window.URL,
  Blob: window.Blob,
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.fetch = window.fetch;
globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');
globalThis.atob = (text) => Buffer.from(text, 'base64').toString('binary');

/* ---- load and apply ----------------------------------------------------- */

let captured = null;
window.__ModuleLoader__ = { load: (definition) => { captured = definition; } };
new Function('window', source)(window);

const React = require('react');
const { createRoot } = require('react-dom/client');
const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected module request: ' + name);
});

const registrations = [];
const slots = {
  inject: (_key, callback) => {
    const disposer = callback();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  register: (registration, component) => {
    registrations.push({ registration, component });
    return () => {};
  },
};
plugin.apply({
  remote,
  inject: (_services, callback) =>
    callback({
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: { openTab: () => {} },
      slots,
      get: services.get,
    }),
  slots,
  get: services.get,
});

const pane = registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab');
const container = window.document.getElementById('root');
const root = createRoot(container);

/* The hook exposes ALL sessions. A different window (or managed worker) stays
 * busy throughout: it must never suppress this session's completion or voice. */
let running = false;
const render = () => {
  const statusMap = new Map([
    ['session-other', { running: true, pendingInteraction: { kind: 'approval' } }],
    ['session-test', { running, pendingInteraction: undefined }],
  ]);
  root.render(
    React.createElement(pane.component, {
      sessionId: 'session-test',
      useSessionStatus: (selector) => selector(statusMap),
    }),
  );
};
window.sessionStorage.setItem('dsh-aura.speak-next', '1');
render();
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(container.querySelector('[data-aura-phase]').dataset.auraPhase, 'idle', 'other running/waiting sessions do not drive this pane');
// Old persisted playback intent cannot arm a newly mounted instance.
running = true; render();
await new Promise(resolve => setTimeout(resolve, 20));
replyText = '不是 Aura 请求的历史回答。';
eventSource.finish(replyText);
running = false; render();
await new Promise(resolve => setTimeout(resolve, 160));
assert.equal(ttsBodies.length, 0, 'restart never restores legacy pending playback');

/* ---- send a message, run, then settle ---------------------------------- */

const textarea = container.querySelector('textarea');
const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
setValue.call(textarea, '帮我看看插件市场');
textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 10));

const sendButton = container.querySelector('button[aria-label="Send"]');
assert.ok(sendButton, 'the pane must offer a send control');
sendButton.click();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(prompts.length, 1, 'the message must reach the session');

/* The run starts and then ends. */
running = true;
render();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(ttsBodies.length, 0, 'nothing is spoken while the run is in flight');

replyText = '收到，我来处理。';
eventSource.finish(replyText);
running = false;
render();
/* The pane waits ~120 ms then polls for a message that differs from the reply
 * it saw before this turn. */
await new Promise((resolve) => setTimeout(resolve, 300));

/* ---- the reply is spoken ------------------------------------------------ */

assert.equal(ttsBodies.length, 1, 'the settled run must be spoken');
assert.equal(ttsBodies[0].text, '收到，我来处理。', 'the reply comes from the session log');
assert.equal(played.length, 1, 'the audio must actually start');
assert.equal(played[0].rate, 16000, 'playback runs at the provider rate');
assert.equal(played[0].length, 4, 'four PCM16 samples');

/* A second settle with nothing new must not speak twice. */
running = false;
render();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(ttsBodies.length, 1, 'a settled run is spoken once');

/* ---- a streaming run is spoken while it is still going ------------------ */

{
  const before = ttsBodies.length;
  const textarea2 = container.querySelector('textarea');
  const setValue2 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setValue2.call(textarea2, '再问一次');
  textarea2.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ttsBodies.length, before, 'nothing is spoken before any text exists');

  /* A completed sentence, one token at a time. */
  eventSource.pushLive('第一句话。');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ttsBodies.length, before + 1, 'a completed sentence is spoken at once');
  assert.equal(ttsBodies.at(-1).text, '第一句话。');

  /* A fragment waits for its sentence to finish. */
  eventSource.pushLive('第二句还没');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ttsBodies.length, before + 1, 'an unfinished sentence is not spoken');

  eventSource.pushLive('说完。');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(ttsBodies.at(-1).text, '第二句还没说完。', 'the rest of the sentence joins it');

  replyText = '第一句话。第二句还没说完。';
  eventSource.finish(replyText);
  running = false;
  render();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(
    ttsBodies.every((body) => body.text !== replyText),
    'a streamed reply is not spoken again at the end',
  );
}

/* ---- several sentences never open several players ---------------------- */

{
  const textarea3 = container.querySelector('textarea');
  const setValue3 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setValue3.call(textarea3, '再来一次');
  textarea3.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const before = contextCount;
  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 20));
  /* Three completed sentences in one delta: they must share one player. */
  eventSource.pushLive('一。二。三。');
  await new Promise((resolve) => setTimeout(resolve, 200));
  /* A player may already exist from the previous utterance; what must not
   * happen is one player per sentence. */
  assert.ok(contextCount - before <= 1, "one player for the whole utterance, got " + (contextCount - before));

  replyText = '一。二。三。';
  eventSource.finish(replyText);
  running = false;
  render();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/* ---- ordinary new input cancels only foreground, then queues ---------- */

{
  const textarea4 = container.querySelector('textarea');
  const setValue4 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 20));

  setValue4.call(textarea4, '换个话题，今天晚饭吃什么？');
  textarea4.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(prompts.at(-1).mode, 'queue', 'replacement follows foreground cancellation');
  assert.deepEqual(commands.slice(-2).map(c => c.line), ['/aura on', '/aura interrupt']);

  running = false;
  render();
  await new Promise((resolve) => setTimeout(resolve, 20));
  setValue4.call(textarea4, '这一条是排队');
  textarea4.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(prompts.at(-1).mode, 'queue', 'a message sent while idle queues');
}

/* ---- a finished sentence does not silence the next one ----------------- */

{
  /* The stub's sources never end on their own, so ending them is done by hand
   * between sentences — which is exactly the moment that used to cancel the
   * sentence that followed. */
  /* The live subscription only exists while a run is in flight. */
  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 30));
  eventSource.pushLive('甲句。');
  await new Promise((resolve) => setTimeout(resolve, 120));
  const spoken = ttsBodies.length;
  for (const source of createdSources) if (typeof source.onended === 'function') source.onended();
  eventSource.pushLive('乙句。');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(ttsBodies.length > spoken, 'a sentence after a natural end is still spoken');
  assert.ok(
    !beacons.some((beacon) => beacon.stage === 'tts_cancelled'),
    'and it is not cancelled as stale',
  );
  running = false;
  render();
}

/* ---- a finished utterance reports its end ----------------------------- */

{
  /* The clock in the stub does not advance, which is exactly the situation
   * that used to leave the player permanently "speaking". */
  for (const source of createdSources) {
    if (typeof source.onended === 'function') source.onended();
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.ok(
    beacons.some((beacon) => beacon.stage === 'play_end'),
    'playback reports its end once the queue drains',
  );
  /* Reaching the end of a sentence is not a cancellation: it used to abort the
   * request for the next one, which surfaced to the user as an error. */
  assert.ok(
    !beacons.some((beacon) => beacon.stage === 'tts_error'),
    'a natural end does not report an error',
  );
}

/* ---- a stop lasts until the next turn, not until the next sentence ----- */

{
  const textarea5 = container.querySelector('textarea');
  const setValue5 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setValue5.call(textarea5, '再讲一段');
  textarea5.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 20));

  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 20));
  eventSource.pushLive('第一句。');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterFirst = ttsBodies.length;
  assert.ok(afterFirst > 0, 'the first sentence is spoken');

  /* The user interrupts: the stop control stands in for the barge-in path,
   * which needs a microphone. */
  const stopButton = container.querySelector('button[aria-label="Silence"]');
  assert.ok(stopButton, 'the stop control exists while speaking');
  stopButton.click();
  await new Promise((resolve) => setTimeout(resolve, 60));

  eventSource.pushLive('第二句。');
  eventSource.pushLive('第三句。');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(ttsBodies.length, afterFirst, 'nothing more is spoken after a stop');

  /* A new turn lifts the mute. */
  replyText = '第一句。第二句。第三句。';
  eventSource.finish(replyText);
  running = false;
  render();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const textarea6 = container.querySelector('textarea');
  setValue5.call(textarea6, '接着说');
  textarea6.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const beforeNew = ttsBodies.length;
  eventSource.pushLive('新的回答。');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(ttsBodies.length > beforeNew, 'a new turn speaks again');
  running = false;
  render();
}

// Real microphone handler + real streaming reply: barge-in only silences audio.
{
  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 30));
  eventSource.pushLive('我继续说明实现方式。');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const latestSource = createdSources.at(-1);
  const cancelBefore = cancelCount;
  const spokenBefore = ttsBodies.length;
  const promptsBefore = prompts.length;
  container.querySelector('button[aria-label="Start listening"]').click();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(captureNode?.port.onmessage, 'capture opens during playback');
  assert.ok(!latestSource.stopped, 'opening capture is NOT itself an interruption');

  // 400 ms of audio is sent once: no level-only stop and no onset replay.
  for (let i = 0; i < 50; i += 1) captureNode.port.onmessage({ data: new Float32Array(128).fill(0.2) });
  assert.equal(speechSocket.bytes, 12800);
  assert.ok(!latestSource.stopped, 'loud audio alone does not interrupt');
  speechSocket.receive({ type: 'stt', partial: true, text: '我' });
  assert.ok(!latestSource.stopped, 'short own-voice echo is ignored');
  speechSocket.receive({ type: 'stt', partial: true, text: '今天天气怎么样' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(latestSource.stopped, 'natural new words stop the playing source');
  assert.equal(cancelCount, cancelBefore, 'partial speech does not cancel any agent');
  assert.equal(prompts.length, promptsBefore, 'a partial is not submitted as a user turn');
  eventSource.pushLive('这段旧播报不应该恢复。');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(ttsBodies.length, spokenBefore, 'late old deltas cannot restart speech');
}

// A second pane never mounts an audio/composer engine and never steals Aura.
{
  const other = window.document.createElement('div');
  container.after(other);
  const second = createRoot(other);
  second.render(React.createElement(pane.component, { sessionId: 'session-other', useSessionStatus: selector => selector(new Map()) }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(other.querySelector('[data-aura-instance]').dataset.auraInstance, 'busy');
  assert.equal(other.querySelector('textarea'), null);
  assert.equal(other.querySelector('button[aria-label="Start listening"]'), null);
  second.unmount();
}

// Late final transcripts after a manual mic stop must not submit anything.
{
  const before = prompts.length;
  container.querySelector('button[aria-label="Stop listening"]')?.click();
  speechSocket.receive({ type: 'stt', text: '这条已经取消的识别不应提交' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(prompts.length, before);
  running = false; render();
  await new Promise(resolve => setTimeout(resolve, 30));
  commandFailure = 'ordinary session busy';
  setValue.call(textarea, '验证提交错误');
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(prompts.length, before, 'failed enable must never fall through to prompt');
  assert.ok(beacons.some(e => e.stage === 'submit_error' && e.step === 'enable' && e.sessionId === 'session-test' && e.message === commandFailure));
  commandFailure = null;
}

// Hang up while OS permission is pending: stop the late track, do not publish
// an audio graph, do not re-arm the call or submit a stale final transcript.
{
  let release;
  window.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { release = resolve; });
  const before = prompts.length, contexts = contextCount;
  container.querySelector('button[aria-label="Start call"]').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(typeof release, 'function');
  assert.equal(JSON.parse(window.localStorage.getItem('dsh-aura.prefs')).mode, undefined, 'live calls are never persisted');
  const oldSocket = speechSocket;
  container.querySelector('button[aria-label="End call"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(oldSocket.readyState, 3, 'hangup closes pending speech socket before permission resolves');
  let stopped = 0;
  release({ getTracks: () => [{ stop() { stopped++; } }] });
  oldSocket.receive({ type: 'stt', text: '迟到的权限回调不能发送命令' });
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(stopped, 1);
  assert.equal(contextCount, contexts);
  assert.equal(prompts.length, before);
  assert.ok(container.querySelector('button[aria-label="Start call"]'));
}

// Runtime connection loss also fences permission and final-result callbacks.
{
  let release;
  window.navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { release = resolve; });
  const before = prompts.length, contexts = contextCount;
  container.querySelector('button[aria-label="Start listening"]').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  const oldSocket = speechSocket;
  controls.find(c => c.readyState === 1).close();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(container.querySelector('textarea'), null);
  assert.equal(container.querySelector('[data-aura-instance]').dataset.auraInstance, 'error');
  let stopped = 0;
  release({ getTracks: () => [{ stop() { stopped++; } }] });
  oldSocket.receive({ type: 'stt', text: '失联旧面板不应继续工作' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stopped, 1);
  assert.equal(contextCount, contexts);
  assert.equal(prompts.length, before);
  container.querySelector('button').click();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(container.querySelector('button[aria-label="Start call"]'), 'explicit reopening starts with no call');
  assert.equal(container.querySelector('button[aria-label="End call"]'), null);
}

// A fast first delta need not wait for running=true. Ownership loss must
// close an unpublished AudioContext even while resume() itself is pending.
{
  let resume, pendingAudio;
  window.AudioContext = class extends AudioContextStub {
    constructor(options) { super(options); this.state = 'suspended'; pendingAudio = this; }
    resume() { return new Promise(resolve => { resume = resolve; }); }
    close() { this.closed = true; return Promise.resolve(); }
  };
  const currentInput = container.querySelector('textarea');
  setValue.call(currentInput, '快速回答的播放权限测试');
  currentInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise(resolve => setTimeout(resolve, 20));
  const playedBefore = played.length;
  eventSource.pushLive('先于运行状态抵达的第一句。');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(typeof resume, 'function', 'the first new delta is not skipped waiting for running status');
  controls.find(c => c.readyState === 1).close();
  assert.ok(pendingAudio.closed, 'disconnect closes unpublished audio synchronously');
  resume();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(played.length, playedBefore, 'late audio resume cannot publish or play after revocation');
}

root.unmount();
console.log('reply.test.mjs: ok');

