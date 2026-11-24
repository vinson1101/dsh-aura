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
import { withInstanceSocket } from './instance-socket.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const continuous = process.env.AURA_TEST_CONTINUOUS === '1';

/* ---- DOM + audio seams -------------------------------------------------- */

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  pretendToBeVisual: true, url: 'http://127.0.0.1:52147',
});
const { window } = dom;
if (!continuous) window.localStorage.setItem('dsh-aura.prefs', JSON.stringify({ character: true, voice: 'longyan_v3', model: 'cosyvoice-v3-flash' }));
const windowErrors = [];
window.addEventListener('error', event => windowErrors.push(String(event.error || event.message)));

const context2d = {
  fillStyle: '',
  clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, arc() {}, fill() {},
  createRadialGradient: () => ({ addColorStop() {} }),
};
window.HTMLCanvasElement.prototype.getContext = () => context2d;
// jsdom intentionally has no decoder; keep media cleanup silent if mounted.
window.HTMLMediaElement.prototype.pause = function () {};
window.HTMLMediaElement.prototype.load = function () {};
window.HTMLMediaElement.prototype.play = async function () {};
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
let graphCount = 0, mediaCount = 0;
const playbackSources = [];
class AudioContextStub {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 48000;
    this.destination = {};
    this.state = 'running';
    this.currentTime = 0;
    this.audioWorklet = { addModule: async () => {} };
  }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createBuffer(_channels, length, rate) {
    const data = new Float32Array(length);
    return { length, sampleRate: rate, copyToChannel: samples => data.set(samples) };
  }
  createBufferSource() {
    const source = { context: this, onended: null, connect() {},
      start() { this.started = true; }, stop() { this.stopped = true; } };
    playbackSources.push(source);
    return source;
  }
  createAnalyser() {
    return { fftSize: 512, connect() {}, getByteTimeDomainData: data => data.fill(128) };
  }
  close() { this.closed = true; this.state = 'closed'; return Promise.resolve(); }
}
class AudioWorkletNodeStub {
  constructor(ctx, name) {
    this.context = ctx;
    this.name = name;
    this.port = { onmessage: null };
    liveNode = this; graphCount += 1;
  }
  connect() {}
  disconnect() {}
}
window.AudioContext = AudioContextStub;
window.AudioWorkletNode = AudioWorkletNodeStub;
window.URL.createObjectURL = () => 'blob:aura-capture';
window.URL.revokeObjectURL = () => {};

let stoppedTracks = 0;
let track;
const mediaDevices = { getUserMedia: async () => {
  mediaCount += 1;
  const ownedTrack = { readyState: 'live', stop() { stoppedTracks += 1; this.readyState = 'ended'; } };
  track = ownedTrack;
  return { getTracks: () => [ownedTrack] };
} };
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
      const ready = () => reply({ type: 'listen', state: 'start', mode: 'manual' });
      if (continuous) this.makeReady = ready; else ready();
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
  if (url === '/aura/visual/config') return { ok: true, status: 200, async json() {
    return { version: 'test', enabled: true, editable: true };
  } };
  if (url === '/aura/visual' && init.method === 'POST') {
    return { ok: true, status: 202, async json() { return {
      id: 'visual-mic-fixture', state: 'ready', stage: 'ready',
      mediaUrl: '/aura/visual/media?id=visual-mic-fixture&ticket=test-only',
    }; } };
  }
  if (url === '/aura/tts') {
    let delivered = false;
    return {
      ok: true, status: 200, headers: { get: () => '16000' },
      body: { getReader: () => ({ read: async () => {
        if (delivered) return { done: true };
        delivered = true;
        return { done: false, value: new Uint8Array([176, 4, 80, 251]) };
      } }) },
    };
  }
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
  WebSocket: withInstanceSocket(WebSocketStub),
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
const microphoneAtRpc = () => ({
  stoppedTracks, trackState: track.readyState, audioClosed: liveNode?.context.closed === true,
  handler: liveNode?.port.onmessage, capture: window.__auraCapture,
  socketState: sockets.at(-1)?.readyState,
});
const session = {
  async prompt(content, mode) {
    // Snapshot AT publication, not after its promise settles. A late teardown
    // used to pass the final stoppedTracks assertion while still recording
    // during the command/prompt network round trip.
    prompts.push({ content, mode, microphone: microphoneAtRpc() });
    return { ok: true, value: { accepted: true } };
  },
  async cancel() { return { ok: true, value: { accepted: true } }; },
};
const entries = [];
const eventSource = {
  getSnapshot: () => ({ entries }),
  subscribe: () => () => {},
};
const services = { get: (name) => (name === 'sessions'
  ? { binding: () => ({ session, eventSource }) } : { openTab: () => {} }) };

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
const commands = [];
plugin.apply({
  remote: { commands: { async execute(_id, line) {
    commands.push({ line, microphone: microphoneAtRpc() });
    assert.equal(line, '/aura on');
    return { ok: true, value: { result: { kind: 'success' } } };
  } } },
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
let running = false;
const render = () => root.render(
  React.createElement(pane.component, {
    sessionId: 'session-test',
    useSessionStatus: (selector) => selector(new Map([['session-test', { running }]])),
  }),
);
render();
await new Promise((resolve) => setTimeout(resolve, 40));

/* Read-only status may be inspected alongside microphone/call activity, but
 * restarting configuration must remain locked throughout their lifetimes. */
container.querySelector('[aria-label="Aura profile"]').click();
await new Promise(resolve => setTimeout(resolve, 10));
const configToggle = () => container.querySelector('[aria-label="切换本地回复生成"]');
assert.equal(configToggle().disabled, false, 'idle owner may edit config');
assert.equal(requests.filter(r => r.url === '/aura/visual/config' && r.init.method === 'GET').length, 1);
assert.equal(requests.filter(r => r.url === '/aura/visual/config' && r.init.method === 'POST').length, 0);

/* ---- speak, then stop speaking ----------------------------------------- */

const mic = container.querySelector(continuous ? 'button[aria-label="Start call"]' : 'button[aria-label="Start listening"]');
assert.ok(mic, 'the pane must offer a microphone control');
mic.click();
await new Promise((resolve) => setTimeout(resolve, 20));

assert.equal(configToggle().disabled, true, 'live listening/call prevents restart/config save');
configToggle().click();
assert.equal(requests.filter(r => r.url === '/aura/visual/config' && r.init.method === 'POST').length, 0);
assert.ok(sockets.length === 1, 'one live socket per turn');
const socket = sockets[0];
assert.equal(socket.url, 'ws://127.0.0.1:63215/aura/asr/live?instance=test-instance-1');
assert.ok(socket.sent.some((value) => typeof value === 'string' && JSON.parse(value).type === 'hello'));

const frame = new Float32Array(320);
const loud = new Float32Array(320);
for (let i = 0; i < loud.length; i += 1) loud[i] = 0.2 * Math.sin((i / 16000) * 2 * Math.PI * 220);

if (continuous) {
  const originalNode = liveNode;
  for (let round = 0; round < 10; round++) {
    const currentSocket = sockets[round];
    assert.ok(currentSocket?.makeReady, 'new ASR session, same microphone');
    const before = currentSocket.audio || 0;
    // 38 RAW samples blocks before actual readiness, not 38 network packets.
    for (let i = 0; i < 38; i++) liveNode.port.onmessage({ data: loud });
    assert.equal(currentSocket.audio || 0, before, 'no wire audio before ready');
    const held = window.__auraCapture.queue.stats().held;
    currentSocket.makeReady();
    assert.equal(currentSocket.audio, Math.floor(held / 1600) * 3200, 'all full 100ms blocks (including boundary remainder) flushed exactly once');
    for (let i = 0; i < 50; i++) liveNode.port.onmessage({ data: frame });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(prompts.length, round + 1, 'one final per synthetic turn');
    assert.equal(prompts[round].microphone.stoppedTracks, 0, 'continuous prompt keeps its live track');
    assert.equal(prompts[round].microphone.trackState, 'live');
    assert.equal(prompts[round].microphone.audioClosed, false);
    assert.equal(liveNode, originalNode, 'same worklet across all turns');
    assert.equal(mediaCount, 1); assert.equal(graphCount, 1); assert.equal(stoppedTracks, 0);
  }
  container.querySelector('button[aria-label="End call"]').click();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stoppedTracks, 1, 'hangup releases the single microphone');
  assert.equal(configToggle().disabled, false, 'hangup unlocks config save');
  root.unmount();
  console.log('mic.test.mjs: synthetic ten-turn call ok (NOT Mac microphone acceptance)');
} else {
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
assert.equal(commands.length, 1);
for (const [name, snapshot] of [['/aura on', commands[0].microphone], ['prompt', prompts[0].microphone]]) {
  assert.equal(snapshot.stoppedTracks, 1, `single mode stops tracks BEFORE ${name}`);
  assert.equal(snapshot.trackState, 'ended', `the real track is ended at ${name}`);
  assert.equal(snapshot.audioClosed, true, `capture AudioContext is closed at ${name}`);
  assert.equal(snapshot.handler, null, `worklet can no longer deliver frames at ${name}`);
  assert.equal(snapshot.capture, null, `capture ownership is released at ${name}`);
  assert.equal(snapshot.socketState, 3, `ASR socket is closed at ${name}`);
}
assert.equal(stoppedTracks, 1, 'the turn must release the microphone exactly once');
assert.ok(
  container.querySelector('button[aria-label="Start listening"]'),
  'the control must return to its idle state',
);

// Full Pane integration: a code-only assistant reply is intentionally silent.
// It drains the real speech queue without constructing a playback/PCM source,
// so only the settle interval (not a PCM onended/stopSpeaking callback) can
// return SingleCharacter from waiting to idle. This is still not GUI acceptance.
const character = container.querySelector('[data-aura-visual="single-character"]');
assert.ok(character, 'single mode integration mounts the character');
assert.equal(character.dataset.auraState, 'waiting');
running = true;
render();
await new Promise(resolve => setTimeout(resolve, 20));
entries.push({ type: 'event', event: { type: 'assistant/message', data: {
  message: { role: 'assistant', content: [{ type: 'text', text: '```js\nconst silent = true;\n```' }] },
} } });
running = false;
render();
await new Promise(resolve => setTimeout(resolve, 250));
const diagStages = () => requests.filter(request => request.url === '/aura/diag')
  .map(request => JSON.parse(request.init.body).stage);
assert.ok(diagStages().includes('speak_skipped'), 'the real silent reply path drained its queue');
assert.equal(character.dataset.auraState, 'waiting', 'no PCM callback prematurely settled the character');
assert.equal(requests.filter(request => request.url === '/aura/tts').length, 0, 'silent reply creates no TTS or PCM');
await new Promise(resolve => setTimeout(resolve, 1800));
assert.equal(character.dataset.auraState, 'idle', 'silent reply settles through the actual Pane interval');
assert.deepEqual(windowErrors, [], 'settle interval must not throw a window ReferenceError');
assert.equal(stoppedTracks, 1, 'silent settlement never reopens or closes the microphone again');

// A later muxed reply is interrupted immediately when a new single microphone
// is opened (not delayed until ASR). A later partial must preserve listening.
const textarea = container.querySelector('textarea');
Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, '请继续回答');
textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise(resolve => setTimeout(resolve, 20));
container.querySelector('button[aria-label="Send"]').click();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(prompts.length, 2);
running = true; render();
await new Promise(resolve => setTimeout(resolve, 20));
entries.push({ type: 'event', event: { type: 'assistant/message', data: {
  message: { role: 'assistant', content: [{ type: 'text', text: '这是仍在播放的上一段回答。' }] },
} } });
running = false; render();
await new Promise(resolve => setTimeout(resolve, 200));
assert.equal(playbackSources.length, 0, 'single-character reply never schedules a separate PCM clock');
assert.equal(requests.filter(request => request.url === '/aura/tts').length, 0);
const answerVideo = character.querySelector('video');
assert.match(answerVideo.getAttribute('src'), /^\/aura\/visual\/media\?/);
assert.equal(answerVideo.muted, false, 'current answer video is the only sound owner');
assert.equal(character.dataset.auraState, 'prepare', 'ready/queued media is not yet audible');
answerVideo.oncanplaythrough();
answerVideo.onplaying();
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(character.dataset.auraState, 'speaking', 'only actual playing changes the UI to speaking');
container.querySelector('button[aria-label="Start listening"]').click();
await new Promise(resolve => setTimeout(resolve, 30));
assert.equal(sockets.at(-1).sent.map(value => typeof value === 'string' ? JSON.parse(value) : null)
  .some(message => message?.type === 'listen' && message.state === 'start'), true,
  'new capture starts immediately and exercises a later partial after single-mode AV cancellation');
assert.equal(answerVideo.muted, true, 'new listening cancels the AV answer and returns the decoder to quiet front');
assert.equal(answerVideo.getAttribute('src'), '/aura/character/front.mp4');
assert.ok(requests.some(request => request.init.method === 'DELETE' && request.url === '/aura/visual?id=visual-mic-fixture'),
  'barge-in cancels the backend job as well as media playback');
assert.equal(character.dataset.auraState, 'listening', 'barge-in preserves the new single listening stage');
assert.equal(track.readyState, 'live');
assert.equal(mediaCount, 2, 'one initial and one explicitly reopened microphone');
assert.equal(stoppedTracks, 1, 'barge-in stops old audio, not the new microphone');

// Transition directly from single listening to call and back. React has not
// updated modeRef inside toggleCall yet; hangup must still reset singleStage.
const reopenedNode = liveNode;
container.querySelector('button[aria-label="Start call"]').click();
await new Promise(resolve => setTimeout(resolve, 20));
assert.ok(container.querySelector('[data-aura-visual="portrait"]'));
assert.ok(!container.querySelector('[data-aura-visual="single-character"]'));
assert.equal(liveNode, reopenedNode, 'entering call reuses the open microphone');
container.querySelector('button[aria-label="End call"]').click();
await new Promise(resolve => setTimeout(resolve, 20));
const afterHangup = container.querySelector('[data-aura-visual="single-character"]');
assert.ok(afterHangup);
assert.equal(afterHangup.dataset.auraState, 'idle', 'hangup must not restore stale single listening');
assert.equal(afterHangup.dataset.auraClip, 'front');
assert.equal(afterHangup.querySelector('img').getAttribute('src'), '/aura/character/short-hair.png');
assert.equal(afterHangup.querySelector('video').getAttribute('src'), '/aura/character/front.mp4',
  'returning from call restores quiet front, not side or a new turn.mp4');
assert.equal(stoppedTracks, 2);
assert.equal(mediaCount, 2, 'hangup does not restart capture');
assert.equal(configToggle().disabled, false, 'ended capture/call/playback unlocks config save');
assert.deepEqual(windowErrors, []);

root.unmount();
console.log('mic.test.mjs: silent no-PCM waiting -> idle ok');
console.log('mic.test.mjs: one AV clock, barge-in listening and call hangup -> front ok');
console.log('mic.test.mjs: ok');
console.log('  audio streamed:', audioBefore, 'bytes');
}

/* ---- the interruption detector reads the samples it is given ----------- */

{
  /* The bug this guards: the worklet posts Float32 samples and the detector
   * parsed them as 16-bit integers, so every frame measured zero and nobody
   * could ever interrupt. The function is pulled out of the bundle because it
   * is a plain function, and evaluated on samples of each shape. */
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function levelOfFrame');
  const end = source.indexOf('function mountOrb', start);
  assert.ok(start > 0 && end > start, 'levelOfFrame is present');
  const factory = new Function(`${source.slice(start, end)}; return levelOfFrame;`);
  const levelOfFrame = factory();

  const loud = new Float32Array(1600).fill(0.3);
  const quiet = new Float32Array(1600).fill(0.001);
  assert.ok(levelOfFrame(loud) > 0.2, 'a loud float frame measures loud: ' + levelOfFrame(loud));
  assert.ok(levelOfFrame(quiet) < 0.01, 'a quiet float frame measures quiet');
  assert.ok(levelOfFrame(loud) > levelOfFrame(quiet) * 50, 'voice clearly beats room tone');

  /* PCM16 is accepted too, in case the capture path changes shape. */
  const pcm = new Int16Array(1600).fill(10000);
  assert.ok(levelOfFrame(pcm) > 0.2, 'a loud 16-bit frame measures loud: ' + levelOfFrame(pcm));
}
