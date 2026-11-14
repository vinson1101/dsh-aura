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
class AudioContextStub {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.destination = {};
  }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return { length, sampleRate: rate, getChannelData: () => data };
  }
  createBufferSource() {
    const source = {
      buffer: null,
      onended: null,
      connect() {},
      start() { played.push({ rate: this.buffer.sampleRate, length: this.buffer.length }); },
      stop() {},
    };
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
window.fetch = async (url, init = {}) => {
  if (url === '/aura/tts') {
    ttsBodies.push(JSON.parse(init.body));
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(1200, 0);
    pcm.writeInt16LE(-1200, 2);
    return {
      ok: true,
      status: 200,
      async json() { return { pcm: pcm.toString('base64'), sampleRate: 16000, provider: 'bailian_cosyvoice' }; },
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
const eventSource = {
  getSnapshot() {
    return {
      entries: [
        { type: 'event', event: { type: 'user/message', data: {} } },
        {
          type: 'event',
          event: {
            type: 'assistant/message',
            data: { message: { role: 'assistant', content: [{ type: 'text', text: '收到，我来处理。' }] } },
          },
        },
      ],
    };
  },
  subscribe() { return () => {}; },
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

running = false;
render();
await new Promise((resolve) => setTimeout(resolve, 40));

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

root.unmount();
console.log('reply.test.mjs: ok');
