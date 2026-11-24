/** Real mounted Aura settings. Offline: no profile edits, TTS, inference, or server. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { withInstanceSocket, controls } from './instance-socket.mjs';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const reply = (value, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => value });
const config = values => ({ version: '0.35.4-visual.1', enabled: false, editable: true, ...values });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function mountPane(options = {}) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://aura.test' });
  const { window } = dom, { document } = window;
  window.localStorage.setItem('dsh-aura.prefs', JSON.stringify({ character: true, mode: 'talk', voice: 'longwan_v3', model: 'cosyvoice-v3-flash' }));
  const calls = [], prompts = [], entries = [], listeners = new Set(), disposers = [];
  let seq = 0, status = {}, api, closed = false;
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/aura/version') return reply({ origin: 'http://aura.test' });
    if (url === '/aura/visual/config') return options.request ? options.request(url, init) : reply(config());
    if (url === '/aura/visual' && init.method === 'POST') return reply({ id: 'job', state: 'ready', mediaUrl: '/aura/visual/media?id=job&ticket=cap' });
    if (url === '/aura/tts') throw new Error('settings must not request TTS');
    return reply({});
  };
  window.fetch = fetch;
  window.HTMLMediaElement.prototype.load = function () {};
  window.HTMLMediaElement.prototype.pause = function () {};
  window.HTMLMediaElement.prototype.play = async function () {};
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.AudioContext = class { constructor() { throw new Error('no separate audio graph in this fixture'); } };
  window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {};
  const ResizeObserver = class { observe() {} disconnect() {} };
  window.ResizeObserver = ResizeObserver;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const globals = { window, document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    ResizeObserver, fetch, WebSocket: withInstanceSocket(), location: window.location, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const React = require('react'), { act } = React, { createRoot } = require('react-dom/client');
  const eventSource = { getSnapshot: () => ({ entries }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const session = { async prompt(content) { prompts.push(content); return { ok: true }; } };
  const get = name => name === 'sessions' ? { binding: () => ({ session, eventSource }) } : { openTab() {} };
  window.__ModuleLoader__ = { load(value) { api = value.factory(name => name === 'react' ? React : {}); } };
  new Function('window', 'document', 'navigator', 'ResizeObserver', 'fetch', 'WebSocket', 'location', source)(window, document, window.navigator, ResizeObserver, fetch, globals.WebSocket, window.location);
  let Body;
  const slots = { inject(_key, fn) { const off = fn(); if (off) disposers.push(off); return () => {}; },
    register(registration, component) { if (registration.name === 'sidebar.right.pane.tab') Body = component; return () => {}; } };
  api.apply({ inject(_keys, fn) { const off = fn({ sidebarRightTabs: { register: () => () => {} }, slots, get }); if (off) disposers.push(off); },
    remote: { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success' } } }) } }, slots, get });
  assert.ok(Body, 'mount the actual registered production Pane');
  const container = document.getElementById('root'), root = createRoot(container);
  const render = () => act(async () => root.render(React.createElement(Body, { sessionId: 'parent', useSessionStatus: selector => selector(new Map([['parent', status]])) })));
  const run = fn => act(async () => { fn(); });
  const wait = ms => act(async () => { await new Promise(r => setTimeout(r, ms)); });
  await render(); await wait(30);
  const socket = controls.at(-1);
  const open = () => run(() => container.querySelector('[aria-label="Aura profile"]').click());
  const button = label => container.querySelector(`[aria-label="${label}"]`);
  const toggle = () => button('切换本地回复生成');
  const refresh = () => button('刷新本地回复生成状态');
  const settings = () => container.querySelector('[data-aura-visual-config]');
  const emit = (type, data) => run(() => { entries.push({ type: 'event', event: { seq: ++seq, type, data } }); for (const fn of listeners) fn(); });
  const send = async () => {
    await run(() => {
      const input = container.querySelector('textarea');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, '执行当前任务');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await run(() => button('Send').click());
  };
  return { container, calls, prompts, socket, run, wait, open, button, toggle, refresh, settings, emit, send,
    setStatus: async value => { status = value; await render(); },
    summary: values => run(() => socket.onmessage({ data: JSON.stringify({ type: 'task-summary', sessionId: 'parent', key: 'parent:1', turn: 1, text: '当前实际回复。', ...values }) })),
    preferences: () => window.localStorage.getItem('dsh-aura.prefs'),
    configCalls: method => calls.filter(c => c.url === '/aura/visual/config' && c.init.method === method),
    async unmount() { if (closed) return; closed = true; await act(async () => root.unmount()); for (const off of disposers) off(); dom.window.close(); } };
}

await test('opening settings performs only authenticated read; status and environment never claim a passed preflight', async t => {
  const f = await mountPane({ request: () => reply(config({ enabled: true })) }); t.after(f.unmount);
  const before = f.preferences();
  assert.equal(f.configCalls('GET').length, 0, 'do not query before settings open');
  await f.open();
  assert.match(f.settings().textContent, /本地回复生成：已启用/);
  assert.match(f.settings().textContent, /环境：未检测/);
  assert.match(f.settings().textContent, /不执行 TTS 或模型预检/);
  assert.equal(f.toggle().textContent, '关闭本地回复生成'); assert.equal(f.toggle().disabled, false);
  const read = f.configCalls('GET')[0];
  assert.equal(read.init.headers['x-aura-instance'], f.socket ? `test-instance-${controls.length}` : 'missing');
  assert.equal(read.init.cache, 'no-store');
  await f.run(() => f.refresh().click()); assert.equal(f.configCalls('GET').length, 2);
  assert.equal(f.configCalls('POST').length, 0);
  assert.equal(f.calls.some(c => c.url === '/aura/tts' || (c.url === '/aura/visual' && c.init.method === 'POST')), false);
  assert.equal(f.preferences(), before, 'status reads preserve voice/model/character preferences');
});

await test('unknown/malformed status degrades to unavailable; retry is read-only and distinct from show-character', async t => {
  let count = 0;
  const f = await mountPane({ request: () => ++count === 1 ? reply({ error: 'route missing' }, false, 404)
    : count === 2 ? reply({ enabled: true }) : reply(config()) }); t.after(f.unmount);
  await f.open(); assert.match(f.settings().textContent, /状态不可用/); assert.equal(f.toggle().disabled, true);
  assert.match(f.settings().querySelector('[role="alert"]').textContent, /route missing/);
  await f.run(() => f.refresh().click()); assert.match(f.settings().textContent, /状态不可用/);
  assert.match(f.settings().textContent, /配置状态响应无效/); assert.equal(f.toggle().disabled, true);
  await f.run(() => f.refresh().click()); assert.match(f.settings().textContent, /本地回复生成：已关闭/);
  await f.run(() => f.container.querySelector('input[type="checkbox"]').click());
  assert.equal(f.configCalls('POST').length, 0, 'show-character is not backend enablement');
  assert.match(f.settings().textContent, /本地回复生成：已关闭/);
});

await test('read-only configuration exposes exact reason and cannot save', async t => {
  const f = await mountPane({ request: () => reply(config({ enabled: true, editable: false, reason: '当前配置没有可编辑的所属条目。' })) }); t.after(f.unmount);
  await f.open(); assert.match(f.settings().textContent, /本地回复生成：已启用/);
  assert.match(f.settings().textContent, /当前配置没有可编辑的所属条目/);
  assert.equal(f.toggle().disabled, true);
  await f.run(() => f.toggle().click()); assert.equal(f.configCalls('POST').length, 0);
});

await test('pending save gives feedback, never optimistically flips state; error preserves enabled state and preferences', async t => {
  const saving = deferred();
  const f = await mountPane({ request: (_url, init) => init.method === 'POST' ? saving.promise : reply(config()) }); t.after(f.unmount);
  await f.open(); const before = f.preferences();
  await f.run(() => f.toggle().click());
  assert.equal(f.toggle().disabled, true); assert.equal(f.refresh().disabled, true);
  assert.match(f.settings().textContent, /正在保存/); assert.match(f.settings().textContent, /本地回复生成：已关闭/);
  await f.run(() => f.toggle().click()); assert.equal(f.configCalls('POST').length, 1);
  const post = f.configCalls('POST')[0];
  assert.deepEqual(JSON.parse(post.init.body), { enabled: true });
  assert.equal(post.init.headers['x-aura-instance'], f.configCalls('GET')[0].init.headers['x-aura-instance']);
  await f.run(() => saving.resolve(reply({ error: 'disk denied' }, false)));
  assert.match(f.settings().textContent, /本地回复生成：已关闭/);
  assert.match(f.settings().querySelector('[role="alert"]').textContent, /disk denied/);
  assert.equal(f.toggle().disabled, false); assert.equal(f.preferences(), before);
});

for (const enabled of [false, true]) await test(`explicit ${enabled ? 'disable' : 'enable'} confirms persistence and requires manual reopen`, async t => {
  const f = await mountPane({ request: (_url, init) => reply(init.method === 'POST' ? { saved: true, enabled: !enabled, reopen: true } : config({ enabled })) }); t.after(f.unmount);
  await f.open(); const seats = controls.length, before = f.preferences();
  await f.run(() => f.toggle().click());
  assert.deepEqual(JSON.parse(f.configCalls('POST')[0].init.body), { enabled: !enabled });
  assert.match(f.container.textContent, /配置已保存/); assert.match(f.container.textContent, /请重新打开 Aura/);
  assert.equal(f.container.querySelector('[data-aura-instance]').dataset.auraInstance, 'restart');
  assert.equal(controls.length, seats, 'never automatically reacquire the seat');
  assert.equal(f.preferences(), before);
});

await test('restart before POST receipt retains unconfirmed guidance, then upgrades only on saved acknowledgement', async t => {
  const saving = deferred();
  const f = await mountPane({ request: (_url, init) => init.method === 'POST' ? saving.promise : reply(config()) }); t.after(f.unmount);
  await f.open(); await f.run(() => f.toggle().click());
  await f.run(() => f.socket.close());
  assert.match(f.container.textContent, /保存结果尚未确认/); assert.match(f.container.textContent, /重新打开 Aura/);
  assert.doesNotMatch(f.container.textContent, /配置已保存/);
  await f.run(() => saving.resolve(reply({ saved: true, enabled: true, reopen: true })));
  assert.match(f.container.textContent, /配置已保存/); assert.match(f.container.textContent, /请重新打开 Aura/);
});

await test('restart plus a failed POST never claims a successful save', async t => {
  const saving = deferred();
  const f = await mountPane({ request: (_url, init) => init.method === 'POST' ? saving.promise : reply(config()) }); t.after(f.unmount);
  await f.open(); await f.run(() => f.toggle().click()); await f.run(() => f.socket.close());
  await f.run(() => saving.resolve(reply({ error: 'persistence not confirmed' }, false)));
  assert.match(f.container.textContent, /配置保存未确认/); assert.match(f.container.textContent, /persistence not confirmed/);
  assert.doesNotMatch(f.container.textContent, /配置已保存/);
});

await test('late GET after settings close cannot override a newer read', async t => {
  const first = deferred(); let reads = 0;
  const f = await mountPane({ request: () => ++reads === 1 ? first.promise : reply(config()) }); t.after(f.unmount);
  await f.open(); assert.equal(f.toggle().disabled, true); assert.match(f.refresh().textContent, /读取状态/);
  await f.run(() => f.button('Close Aura profile').click());
  assert.equal(f.configCalls('GET')[0].init.signal.aborted, true);
  await f.open(); assert.match(f.settings().textContent, /本地回复生成：已关闭/);
  await f.run(() => first.resolve(reply(config({ enabled: true }))));
  assert.match(f.settings().textContent, /本地回复生成：已关闭/); assert.equal(f.toggle().disabled, false);
});

await test('running/waiting sessions lock saves but still allow read-only refresh', async t => {
  const f = await mountPane(); t.after(f.unmount); await f.open();
  for (const status of [{ running: true }, { pendingInteraction: { kind: 'confirmation' } }]) {
    await f.setStatus(status); assert.equal(f.toggle().disabled, true);
    await f.run(() => f.toggle().click()); assert.equal(f.configCalls('POST').length, 0);
    await f.run(() => f.refresh().click());
  }
  await f.setStatus({}); assert.equal(f.toggle().disabled, false);
});

await test('actual pending task, preparation, and AV playback lock config saves until completion', async t => {
  const f = await mountPane(); t.after(f.unmount); await f.open(); await f.send();
  await f.setStatus({ running: true }); await f.emit('turn/start', { turn: 1 });
  await f.emit('tool/call', { turn: 1, step: 0, callId: 'dispatch', name: 'aura_task', arguments: '{}' });
  await f.emit('tool/result', { turn: 1, message: { toolCallId: 'dispatch', content: [{ type: 'text', text: JSON.stringify({ status: 'dispatched', sessionId: 'native-child' }) }] } });
  await f.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '任务已派发。' }] } });
  await f.setStatus({}); await f.wait(200);
  assert.equal(f.toggle().disabled, true, 'native child remains pending after foreground run');
  await f.summary({ taskId: 'native-child' }); await f.wait(160);
  assert.equal(f.toggle().disabled, true, 'preparing and loading reply media');
  const video = f.container.querySelector('video');
  await f.run(() => video.oncanplaythrough()); await f.run(() => video.onplaying());
  assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  assert.equal(f.toggle().disabled, true, 'actual AV clock is playing');
  await f.run(() => video.onended()); assert.equal(f.toggle().disabled, false, 'ended task/media allows save');
  assert.equal(f.configCalls('POST').length, 0);
});
