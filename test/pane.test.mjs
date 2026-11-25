/**
 * Mounts the Aura pane in jsdom and exercises its lifecycle effects.
 * Native Client dependency activation and real audio require live verification.
 *
 * This exists because a static render is not enough: `renderToStaticMarkup`
 * never runs effects, and the one bug this file was written for — a form
 * registry holding a function where the pane called `.mount` — threw inside
 * `useEffect`, so a static render passed while the real pane rendered nothing.
 *
 * Run: node test/pane.test.mjs
 */
import assert from 'node:assert/strict';
import { withInstanceSocket } from './instance-socket.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
for (const dependency of ['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-renderer']) {
  assert.ok(manifest.dsh.client.inject.includes(dependency), `Client graph must include ${dependency}`);
}
assert.ok(source.includes(`const AURA_VERSION = '${manifest.version}';`), 'Client and bundle versions must agree');

/* HMR reinjects classic scripts into the SAME page, not a fresh Function scope.
 * Once the old module is invalidated, registration must work again without a
 * global lexical redeclaration error that leaves its shortcuts unregistered. */
const replacements = [];
const page = vm.createContext({ window: { __ModuleLoader__: { load: value => replacements.push(value) } } });
vm.runInContext('const AURA_VERSION = "legacy-page";', page);
vm.runInContext(source, page, { filename: 'aura-initial.js' });
assert.doesNotThrow(() => vm.runInContext(source, page, { filename: 'aura-replacement.js' }), 'same-page Client replacement must be repeatable');
assert.equal(replacements.length, 2);
assert.equal(/watchForNewVersion|reload_for_version/.test(source), false, 'updates must not schedule automatic whole-app version reloads; explicit recovery buttons remain available');

/* ---- environment -------------------------------------------------------- */

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://127.0.0.1:52147' });
const { window } = dom;
// Legacy versions persisted a live call. Reopening must preserve preferences,
// not pretend that a microphone/recognizer connection survived the restart.
window.localStorage.setItem('dsh-aura.prefs', JSON.stringify({ mode: 'chat', avatar: '' }));

/* A 2D context stub: the pane only needs these calls to exist. */
const painted = { clear: 0, fill: 0 };
const context = {
  fillStyle: '',
  clearRect: () => { painted.clear += 1; },
  fillRect: () => {},
  beginPath: () => {},
  moveTo: () => {},
  arc: () => {},
  fill: () => { painted.fill += 1; },
  createRadialGradient: () => ({ addColorStop: () => {} }),
};
window.HTMLCanvasElement.prototype.getContext = () => context;
// jsdom has no media decoder. These lifecycle seams are exercised separately
// in character.test.mjs; do not emit jsdom's "Not implemented" diagnostics.
const mediaLifecycle = { pause: 0, load: 0 };
window.HTMLMediaElement.prototype.pause = function () { mediaLifecycle.pause++; };
window.HTMLMediaElement.prototype.load = function () { mediaLifecycle.load++; };
window.HTMLMediaElement.prototype.play = async function () {};
/* jsdom has no layout engine, so every box is 0 and the form would correctly
 * skip painting. Report a deliberately tall, narrow frame: that is the shape
 * that used to stretch a square bitmap into an oval with pointed ends. */
const BOX = { width: 220, height: 720 };
window.Element.prototype.getBoundingClientRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: BOX.width, bottom: BOX.height,
  width: BOX.width, height: BOX.height,
});
/* jsdom lays nothing out, so scrollHeight is 0 and the composer could never
 * look taller than one row. Report a height that grows with the text. */
Object.defineProperty(window.HTMLTextAreaElement.prototype, 'scrollHeight', {
  get() {
    return Math.max(34, 20 + String(this.value || '').length);
  },
  configurable: true,
});
window.matchMedia = (query) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub;

/* Stop the animation loop after a few frames so the test can settle. */
let frames = 0;
window.requestAnimationFrame = (callback) => {
  frames += 1;
  if (frames > 4) return 0;
  return window.setTimeout(() => callback(window.performance.now()), 4);
};
window.cancelAnimationFrame = (id) => window.clearTimeout(id);

/* The bundle only reaches for bare `document`; `window` arrives as the
 * wrapper argument below, so the Node-only globals stay untouched. */
/* The bundle reaches for these as bare globals, exactly as a page provides
 * them: `ResizeObserver` and `document` are not read through `window`. */
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  ResizeObserver: ResizeObserverStub,
  WebSocket: withInstanceSocket(),
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/* ---- load the plugin ---------------------------------------------------- */

let captured = null;
window.__ModuleLoader__ = { load: (definition) => { captured = definition; } };
// The bundle posts stage beacons to the host; keep the test offline.
window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ origin: 'http://127.0.0.1:52147' }) });
globalThis.fetch = window.fetch;

new Function('window', source)(window);
assert.ok(captured, 'the bundle must call __ModuleLoader__.load');
assert.equal(captured.id, 'dsh-aura');

const plugin = captured.factory((name) => {
  if (name === 'react') return require('react');
  throw new Error('unexpected module request: ' + name);
});

for (const service of ['slots', 'remote', 'remote.commands']) {
  assert.ok(plugin.inject.includes(service), `client must declare its ${service} dependency`);
}

/* ---- apply into a fake context ------------------------------------------ */

const registrations = [];
const record = (registration, component) => {
  registrations.push({ registration, component });
  return () => {};
};
const slots = {
  inject: (_key, callback) => {
    const disposer = callback();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  register: record,
};
const ctx = {
  inject: (_services, callback) =>
    callback({
      sidebarRightTabs: { register: () => () => {} },
      sidebarRight: { openTab: () => {} },
      slots,
      get: () => ({ openTab: () => {} }),
    }),
  slots,
};

plugin.apply(ctx);

const pane = registrations.find((entry) => entry.registration.name === 'sidebar.right.pane.tab');
assert.ok(pane, 'the pane body must register in sidebar.right.pane.tab');
assert.equal(pane.registration.key, 'dsh-aura');

/* ---- mount for real, so effects run ------------------------------------- */

const React = require('react');
const { createRoot } = require('react-dom/client');
const container = window.document.getElementById('root');
const root = createRoot(container);

const statusMap = new Map();
root.render(
  React.createElement(pane.component, {
    sessionId: 'session-test',
    useSessionStatus: (selector) => selector(statusMap),
  }),
);

await new Promise((resolve) => setTimeout(resolve, 120));

const html = container.innerHTML;
const text = container.textContent || '';

assert.ok(html.length > 0, 'the pane must render something');
assert.ok(
  !/form\.mount|is not a function/i.test(text),
  `the pane must not show a crash: ${text.slice(0, 200)}`,
);
assert.equal(pane.component.name, 'AuraPane');
assert.match(text, /任务独立执行/);
assert.match(text, /\/aura off/);
const call = container.querySelector('button[aria-label="Start call"]');
assert.ok(call, 'a previously saved call must reopen as Start call, not Hang up');
assert.equal(container.querySelector('button[aria-label="End call"]'), null);
assert.equal(container.querySelector('[data-aura-phase]').dataset.auraPhase, 'idle', 'restart does not restore an unconnected call');
assert.ok(call.closest('[role="group"]'), 'interactive call button belongs to the stage group');
assert.equal(call.closest('[role="img"]'), null, 'interactive controls are not hidden inside role=img');

/* The version and the reload control live inside the profile card; a stale
 * page and a broken feature look identical without them. */
const profile = container.querySelector('button[aria-label="Aura profile"]');
assert.ok(profile, 'the profile control must be in the header');

/* The card is closed by default, so the version cannot be read from a bare
 * render — open it the way a user would. */
profile.click();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.match(container.textContent, /v\d+\.\d+\.\d+/, 'the card must name the running version');
assert.ok(
  container.querySelector('button[aria-label="Force reload"]'),
  'the reload control must be inside the card',
);

/* The open card owns the pane and says so with its own close control. */
assert.ok(
  container.querySelector('button[aria-label="Close Aura profile"]'),
  'the open card must carry a close control',
);
/* The card sits in the flow: the sphere is still rendered underneath it, so
 * nothing is covered and no interaction is replaced. */
assert.ok(
  container.querySelector('canvas'),
  'opening the card must not replace the pane content',
);

/* A popover you can only close by finding an uncovered spot is a trap. */
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(container.querySelector('.aura-card'), null, 'Escape must close the card');

container.querySelector('button[aria-label="Aura profile"]').click();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.ok(container.querySelector('.aura-card'), 'the card reopens');

window.document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(container.querySelector('.aura-card'), null, 'a press outside must close the card');

const canvas = container.querySelector('canvas');
assert.ok(canvas, 'the pane must contain a canvas; rendered instead: ' + text.slice(0, 400));
/* The bug this guards: a non-square element let the browser stretch a square
 * bitmap into an oval. The element and the buffer must both be square, and the
 * side must follow the frame's shorter edge. */
assert.equal(
  canvas.width,
  canvas.height,
  'the backing store must be square',
);
assert.equal(
  canvas.width,
  Math.min(BOX.width, BOX.height),
  'the side must follow the shorter frame edge',
);
assert.equal(
  canvas.style.width,
  Math.min(BOX.width, BOX.height) + 'px',
  'the element must be squared through CSS as well',
);
assert.equal(canvas.style.height, canvas.style.width, 'both CSS sides must match');
assert.ok(painted.clear > 0, 'the form must paint at least one frame');
assert.ok(painted.fill > 0, 'the form must fill its depth groups');
assert.ok(container.querySelector('textarea'), 'the pane must carry its composer');

// Single-task v3: default frontal still + one shared video/media clock.
// This is DOM/lifecycle coverage, not browser decoding or visual acceptance.
profile.click();
await new Promise(resolve => setTimeout(resolve, 20));
const formSwitch = container.querySelector('.aura-card input[type=checkbox]');
formSwitch.click();
await new Promise(resolve => setTimeout(resolve, 30));
const character = container.querySelector('[data-aura-visual="single-character"]');
assert.ok(character, 'single mode mounts the single-utterance player, not the call portrait');
const picture = character.querySelector('img');
assert.equal(picture.getAttribute('src'), '/aura/character/side.png');
assert.equal(picture.style.objectFit, 'cover');
assert.equal(character.dataset.auraState, 'initial');
assert.equal(character.dataset.auraClip, 'side');
assert.equal(character.style.inset, '0px', 'background spans the entire controlled pane');
assert.match(character.style.background, /linear-gradient/);
assert.equal(container.querySelectorAll('canvas, audio').length, 0, 'no old face canvas or duplicate sound owner');
const standby = character.querySelector('video:not([data-aura-reply-player])');
const replyLayer = character.querySelector('[data-aura-reply-player]');
const idleLayer = character.querySelector('[data-aura-idle-player]');
const decoderLayers = [standby, replyLayer, idleLayer];
assert.equal(character.querySelectorAll('video').length, 3, 'front and idle media stay separate from the answer audio owner');
assert.equal(character.querySelector('[data-aura-idle-player]').hasAttribute('src'), false);
for (const video of decoderLayers) {
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.preload, video === idleLayer ? 'none' : 'auto');
  assert.equal(video.getAttribute('aria-hidden'), 'true');
  assert.equal(video.style.opacity, '0', 'idle does not expose an undecoded frame');
}
assert.equal(standby.getAttribute('src'), null, 'opening Aura does not start a video');
assert.equal(character.querySelector('img').getAttribute('src'), '/aura/character/side.png');
assert.match(container.querySelector('[data-aura-status-bar]').textContent, /未开始.*麦克风关闭/);
assert.equal(replyLayer.getAttribute('src'), null, 'answer player is unloaded during idle');
assert.equal(container.querySelectorAll('[data-aura-visual]').length, 1);
assert.ok(container.querySelector('.aura-character textarea'));
assert.ok(container.querySelector('button[aria-label="Start call"]'));
assert.match(container.querySelector('[data-aura-phase]').style.gridTemplateRows, /minmax\(0(?:px)?, 1fr\)/);
container.querySelector('button[aria-label="Close Aura profile"]').click();
await new Promise(resolve => setTimeout(resolve, 20));
profile.click();
await new Promise(resolve => setTimeout(resolve, 20));
const lifecycleBeforeSwitch = { ...mediaLifecycle };
container.querySelector('.aura-card input[type=checkbox]').click();
await new Promise(resolve => setTimeout(resolve, 20));
assert.ok(!container.querySelector('.aura-character'), 'particle mode restores original pane palette');
assert.ok(!container.querySelector('[data-aura-visual="single-character"]'),
  'switching to particles unmounts the player');
assert.equal(container.querySelectorAll('video').length, 0);
assert.equal(mediaLifecycle.pause - lifecycleBeforeSwitch.pause, 0, 'the unopened portrait has no active decoder');
assert.equal(mediaLifecycle.load - lifecycleBeforeSwitch.load, 0, 'switching rest does not allocate a decoder');
for (const video of decoderLayers) {
  assert.equal(video.getAttribute('src'), null);
  assert.equal(video.onloadeddata, null);
  assert.equal(video.onended, null);
  assert.equal(video.onerror, null);
}
assert.equal(container.querySelectorAll('canvas').length, 1);
const restored = container.querySelector('canvas');
assert.equal(restored.width, restored.height);
container.querySelector('button[aria-label="Close Aura profile"]').click();
await new Promise(resolve => setTimeout(resolve, 20));

/* ---- the composer grows instead of clipping the second line ------------- */

const textarea = container.querySelector('textarea');
assert.ok(textarea, 'the pane must carry its composer');
assert.equal(textarea.style.height, '34px', 'an empty composer sits at its floor');

const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
const type = (value) => {
  setValue.call(textarea, value);
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
};
type('a'.repeat(200));
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(textarea.style.height, '132px', 'a long draft grows to the cap');
assert.equal(textarea.style.overflowY, 'auto', 'past the cap it scrolls');

type('short');
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(textarea.style.height, '34px', 'a short draft shrinks back to the floor');
assert.equal(textarea.style.overflowY, 'hidden', 'no scrollbar when it fits');

/* ---- a call is an action beside the orb, not a setting ----------------- */

{
  const call = container.querySelector('button[aria-label="Start call"]');
  assert.ok(call, 'the stage carries a call control');
  assert.equal(call.getAttribute('data-active'), 'false', 'and it starts idle');
  assert.equal(call.closest('.aura-card'), null, 'call is a stage action, not a profile setting');
  assert.equal(call.title, '通话');
}

root.unmount();
console.log('pane.test.mjs: ok');
console.log('  canvas backing store:', canvas.width + 'x' + canvas.height);
console.log('  frames painted:', painted.clear);
