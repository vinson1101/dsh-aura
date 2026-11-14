/**
 * The microphone path in jsdom, end to end: click the mic, stream frames over
 * the bridge protocol, get a transcript back, and confirm it was sent and the
 * microphone closed.
 *
 * Only the audio seams are stubbed (getUserMedia, AudioContext, WebSocket). The
 * endpointing, the control frames and the submit are the real code.
 * Run with `node test/mic.test.mjs`.
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

/* ---- DOM + audio seams -------------------------------------------------- */

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

let liveNode = null;
class AudioContextStub {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.destination = {};
    this.state = 'running';
    this.audioWorklet = { addModule: async () => {} };
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  close() { this.closed = true; return Promise.resolve(); }
}
class AudioWorkletNodeStub {
  constructor(ctx, name) {
    this.context = ctx;
    this.name = name;
    this.port = { onmessage: null };
    liveNode = this;
  }
  connect() {}
  disconnect() {}
}
window.AudioContext = AudioContextStub;
window.AudioWorkletNode = AudioWorkletNodeStub;
window.URL.createObjectURL = () => 'blob:aura-capture';
window.URL.revokeObjectURL = () => {};

let stoppedTracks = 0;
const stream = { getTracks: () => [{ stop: () => { stoppedTracks += 1; } }] };
const mediaDevices = { getUserMedia: async () => stream };
Object.defineProperty(window.navigator, 'mediaDevices', { value: mediaDevices, configurable: true });

/* ---- the bridge protocol on a fake socket -------------------------------- */

const sockets = [];
class WebSocketStub {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    sockets.push(this);
    /* Open on the next turn, as a real socket would. */
    window.setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }, 1);
  }
  send(value) {
    this.sent.push(value);
    if (typeof value !== 'string') {
      this.audio = (this.audio || 0) + value.byteLength;
      return;
    }
    const message = JSON.parse(value);
    const reply = (payload) => {
      if (this.onmessage) this.onmessage({ data: JSON.stringify(payload) });
    };
    if (message.type === 'hello') {
      reply({ type: 'hello', audio_params: { format: 'pcm16', sample_rate: 16000 } });
      return;
    }
    if (message.type === 'listen' && message.state === 'start') {
      reply({ type: 'listen', state: 'start', mode: 'manual' });
      /* One partial so the caption path is exercised too. */
      /* A sentence-final partial is what allows the short pause to end the turn. */
      reply({ type: 'stt', text: '打开插件市场。', partial: true });
      return;
    }
    if (message.type === 'listen' && message.state === 'stop') {
      reply({ type: 'stt', text: '打开插件市场', partial: false });
    }
  }
  close() {
    this.readyState = 3;
  }
}
window.WebSocket = WebSocketStub;

const requests = [];
window.fetch = async (url, init = {}) => {
  requests.push({ url, init });
  /* The pane asks the host for its origin before opening the socket, because a
   * dsh-app:// page has no usable location.host. */
  if (url === '/aura/version') {
    return {
      ok: true,
      status: 200,
      async json() { return { version: 'test', origin: 'http://127.0.0.1:63215' }; },
      async text() { return ''; },
    };
  }
  return { ok: true, status: 204, async json() { return {}; }, async text() { return ''; } };
};

const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  ResizeObserver: ResizeObserverStub,
  AudioWorkletNode: AudioWorkletNodeStub,
  URL: window.URL,
  Blob: window.Blob,
  WebSocket: WebSocketStub,
  location: { protocol: 'http:', host: '127.0.0.1:63215' },
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
globalThis.fetch = window.fetch;
globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64');

/* ---- load the plugin ---------------------------------------------------- */

let captured = null;
window.__ModuleLoader__ = { load: (definition) => { captured = definition; } };
new Function('window', source)(window);

const React = require('react');
const { createRoot } = require('react-dom/client');
const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected module request: ' + name);
});

const prompts = [];
const session = {
  async prompt(content, mode) { prompts.push({ content, mode }); return { ok: true, value: { accepted: true } }; },
  async cancel() { return { ok: true, value: { accepted: true } }; },
};
const services = { get: (name) => (name === 'sessions' ? { binding: () => ({ session }) } : { openTab: () => {} }) };

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
root.render(
  React.createElement(pane.component, {
    sessionId: 'session-test',
    useSessionStatus: (selector) => selector(new Map()),
  }),
);
await new Promise((resolve) => setTimeout(resolve, 40));

/* ---- speak, then stop speaking ----------------------------------------- */

const mic = container.querySelector('button[aria-label="Start listening"]');
assert.ok(mic, 'the pane must offer a microphone control');
mic.click();
await new Promise((resolve) => setTimeout(resolve, 20));

assert.ok(sockets.length === 1, 'one live socket per turn');
const socket = sockets[0];
assert.equal(socket.url, 'ws://127.0.0.1:63215/aura/asr/live');
assert.ok(socket.sent.some((value) => typeof value === 'string' && JSON.parse(value).type === 'hello'));

const frame = new Float32Array(320);
const loud = new Float32Array(320);
for (let i = 0; i < loud.length; i += 1) loud[i] = 0.2 * Math.sin((i / 16000) * 2 * Math.PI * 220);

/* 400 ms of speech, then 1000 ms of silence: the endpoint is 900 ms. */
for (let i = 0; i < 20; i += 1) liveNode.port.onmessage({ data: loud });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(prompts.length, 0, 'speech alone must not finish a turn');
const audioBefore = socket.audio || 0;
assert.ok(audioBefore > 0, 'audio must stream while the user talks');

for (let i = 0; i < 50; i += 1) liveNode.port.onmessage({ data: frame });
await new Promise((resolve) => setTimeout(resolve, 60));

const stop = socket.sent.map((value) => (typeof value === 'string' ? JSON.parse(value) : null)).find(
  (message) => message && message.type === 'listen' && message.state === 'stop',
);
assert.ok(stop, 'the turn must end with a listen stop frame');
assert.equal(prompts.length, 1, 'the final transcript must be sent into the session');
assert.deepEqual(prompts[0].content, [{ type: 'text', text: '打开插件市场' }]);
assert.equal(prompts[0].mode, 'queue');
assert.equal(stoppedTracks, 1, 'the turn must release the microphone');
assert.ok(
  container.querySelector('button[aria-label="Start listening"]'),
  'the control must return to its idle state',
);

root.unmount();
console.log('mic.test.mjs: ok');
console.log('  audio streamed:', audioBefore, 'bytes');
