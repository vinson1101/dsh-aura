/**
 * Mounts the Aura pane in jsdom and fails on anything the browser would hit.
 *
 * This exists because a static render is not enough: `renderToStaticMarkup`
 * never runs effects, and the one bug this file was written for — a form
 * registry holding a function where the pane called `.mount` — threw inside
 * `useEffect`, so a static render passed while the real pane rendered nothing.
 *
 * Run: node test/pane.test.mjs
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
/* jsdom has no layout engine, so clientWidth/clientHeight are 0 and the form
 * would correctly skip painting. Give the canvas a box to fill. */
for (const side of ['clientWidth', 'clientHeight']) {
  Object.defineProperty(window.HTMLCanvasElement.prototype, side, {
    get: () => 320,
    configurable: true,
  });
}
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
};
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

/* ---- load the plugin ---------------------------------------------------- */

let captured = null;
window.__ModuleLoader__ = { load: (definition) => { captured = definition; } };
// The bundle posts stage beacons to the host; keep the test offline.
window.fetch = () => Promise.resolve({ ok: true });
globalThis.fetch = window.fetch;

new Function('window', source)(window);
assert.ok(captured, 'the bundle must call __ModuleLoader__.load');
assert.equal(captured.id, 'dsh-aura');

const plugin = captured.factory((name) => {
  if (name === 'react') return require('react');
  throw new Error('unexpected module request: ' + name);
});

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

const canvas = container.querySelector('canvas');
assert.ok(canvas, 'the pane must contain a canvas; rendered instead: ' + text.slice(0, 400));
assert.ok(canvas.width > 0, 'the form must size the canvas backing store');
assert.ok(painted.clear > 0, 'the form must paint at least one frame');
assert.ok(painted.fill > 0, 'the form must fill its depth groups');
assert.ok(container.querySelector('textarea'), 'the pane must carry its composer');

root.unmount();
console.log('pane.test.mjs: ok');
console.log('  canvas backing store:', canvas.width + 'x' + canvas.height);
console.log('  frames painted:', painted.clear);
