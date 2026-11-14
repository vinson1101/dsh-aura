/**
 * The spoken reply: after a run we started ends, the pane asks for speech and
 * plays it. Run with `node test/reply.test.mjs`.
 *
 * The session is real enough to matter — the reply is read from the session
 * event window, not from a value the test hands over directly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

/* ---- environment -------------------------------------------------------- */

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
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
  }
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
      stop() {},
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

const prompts = [];
const session = {
  async prompt(content, mode) { prompts.push({ content, mode }); return { ok: true, value: { accepted: true } }; },
  async cancel() { return { ok: true, value: { accepted: true } }; },
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

/* The session's running flag is what the pane watches for the end of a run. */
let running = false;
const render = () => {
  const statusMap = new Map([['session-test', { running, pendingInteraction: undefined }]]);
  root.render(
    React.createElement(pane.component, {
      sessionId: 'session-test',
      useSessionStatus: (selector) => selector(statusMap),
    }),
  );
};
render();
await new Promise((resolve) => setTimeout(resolve, 40));

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

/* ---- a voice input during a run steers it instead of queueing ---------- */

{
  const textarea4 = container.querySelector('textarea');
  const setValue4 = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  running = true;
  render();
  await new Promise((resolve) => setTimeout(resolve, 20));

  setValue4.call(textarea4, '打断一下');
  textarea4.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  container.querySelector('button[aria-label="Send"]').click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(prompts.at(-1).mode, 'steer', 'a message sent during a run interrupts it');

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
}

root.unmount();
console.log('reply.test.mjs: ok');
