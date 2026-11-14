/**
 * Microphone path, end to end inside jsdom: click the mic, feed frames, and
 * assert an utterance is cut, encoded and posted to /aura/asr, then lands in the
 * composer as text.
 *
 * The audio stack is stubbed at its seams (getUserMedia, AudioContext,
 * AudioWorkletNode) but the endpointing, the PCM conversion and the request are
 * the real code. Run with `node test/mic.test.mjs`.
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
  clearRect() {},
  fillRect() {},
  beginPath() {},
  moveTo() {},
  arc() {},
  fill() {},
  createRadialGradient: () => ({ addColorStop() {} }),
};
window.HTMLCanvasElement.prototype.getContext = () => context2d;

const BOX = 320;
window.Element.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: BOX, bottom: BOX, width: BOX, height: BOX,
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

/* AudioContext keeps the sample rate the pane asks for and hands back inert
 * nodes; AudioWorkletNode exposes the port the pane subscribes to. */
let liveNode = null;
class AudioContextStub {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
    this.closed = false;
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

const posts = [];
const requests = [];
window.fetch = async (url, init = {}) => {
  requests.push({ url, init });
  if (url === '/aura/asr') {
    posts.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      async json() { return { text: '打开插件市场', provider: 'fake' }; },
      async text() { return ''; },
    };
  }
  return { ok: true, status: 204, async json() { return {}; }, async text() { return ''; } };
};

/* Keep jsdom's navigator (react-dom reads its userAgent) and add the media
 * device seam to it. */
Object.defineProperty(window.navigator, 'mediaDevices', { value: mediaDevices, configurable: true });

const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  ResizeObserver: ResizeObserverStub,
  /* The bundle reaches for these as bare page globals, exactly as a browser
   * provides them. */
  AudioWorkletNode: AudioWorkletNodeStub,
  URL: window.URL,
  Blob: window.Blob,
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
const prompts = [];
const session = {
  async prompt(content, mode) {
    prompts.push({ content, mode });
    return { ok: true, value: { accepted: true } };
  },
  async cancel() {
    return { ok: true, value: { accepted: true } };
  },
};
const services = {
  get(name) {
    if (name === 'sessions') return { binding: () => ({ session }) };
    return { openTab: () => {} };
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
  /* The pane resolves the session through the root context, not the injected
   * scope, so the root needs the service too. */
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
await new Promise((resolve) => setTimeout(resolve, 60));

/* ---- speak, then stop speaking ----------------------------------------- */

const mic = container.querySelector('button[aria-label="Start listening"]');
assert.ok(mic, 'the pane must offer a microphone control');
mic.click();
await new Promise((resolve) => setTimeout(resolve, 20));

assert.ok(liveNode, 'capture must create an AudioWorkletNode');
assert.equal(liveNode.context.sampleRate, 16000, 'capture must ask for 16 kHz');
assert.ok(typeof liveNode.port.onmessage === 'function', 'the pane must subscribe to audio frames');

const frame = new Float32Array(320);
const loud = new Float32Array(320);
for (let i = 0; i < loud.length; i += 1) loud[i] = 0.2 * Math.sin((i / 16000) * 2 * Math.PI * 220);

/* 400 ms of speech, then 900 ms of silence: the endpointing threshold is 800. */
for (let i = 0; i < 20; i += 1) liveNode.port.onmessage({ data: loud });
assert.equal(posts.length, 0, 'speech alone must not finish an utterance');
for (let i = 0; i < 45; i += 1) liveNode.port.onmessage({ data: frame });

assert.equal(posts.length, 1, 'silence past the threshold must post exactly one utterance');
const body = posts[0];
assert.equal(body.sampleRate, 16000);
assert.equal(body.channels, 1);
const pcm = Buffer.from(body.pcm, 'base64');
assert.ok(pcm.length > 0, 'the utterance must carry audio');
assert.equal(pcm.length % 2, 0, 'PCM16 is two bytes per sample');

await new Promise((resolve) => setTimeout(resolve, 40));

/* Turn-taking: one utterance is recognised and sent, with no extra keystroke. */
assert.equal(prompts.length, 1, 'the transcript must be sent into the session');
assert.deepEqual(prompts[0].content, [{ type: 'text', text: '打开插件市场' }]);
assert.equal(prompts[0].mode, 'queue');

/* And the microphone closes by itself, which is the bug this guards. */
assert.equal(stoppedTracks, 1, 'the turn must release the microphone after sending');
assert.equal(liveNode.port.onmessage, null, 'the frame handler must be detached');
assert.ok(
  container.querySelector('button[aria-label="Start listening"]'),
  'the control must return to its idle state',
);
assert.equal(
  container.querySelector('textarea').value,
  '',
  'the composer must stay empty when the message was already sent',
);

/* ---- silence is not sent ------------------------------------------------ */

posts.length = 0;
prompts.length = 0;
const micAgain = container.querySelector('button[aria-label="Start listening"]');
micAgain.click();
await new Promise((resolve) => setTimeout(resolve, 20));
for (let i = 0; i < 30; i += 1) liveNode.port.onmessage({ data: frame });
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(prompts.length, 0, 'pure silence must submit nothing');

root.unmount();
console.log('mic.test.mjs: ok');
console.log('  utterance bytes:', pcm.length);
