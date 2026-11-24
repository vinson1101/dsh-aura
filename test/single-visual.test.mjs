/** Offline tests of the real visual-job controller AND full Aura Pane wiring.
 * No TTS, Wan, LatentSync, network, real decoder, or live profile is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { withInstanceSocket, controls } from './instance-socket.mjs';
const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const a = source.indexOf('function createVisualPreparation('), b = source.indexOf('/** Single-task v3:', a);
assert.ok(a > 0 && b > a);
const createVisualPreparation = new Function(`${source.slice(a, b)}; return createVisualPreparation;`)();
const reply = (value, ok = true) => ({ ok, json: async () => value });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const body = { text: '当前完整回复。', voice: 'longyan_v3', model: 'cosyvoice-v3-flash', taskId: 'native-child', sessionId: 'parent' };
function controller(request) {
  const timers = new Map(); let next = 0, active = true;
  const statuses = [], diagnostics = [], access = { token: 'instance-secret', active: () => active };
  const clock = { setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const value = createVisualPreparation({ access, clock, request, onStatus: status => statuses.push(status), diagnostic: (stage, data) => diagnostics.push({ stage, ...data }) });
  return { value, timers, statuses, diagnostics, revoke() { active = false; value.cancel(); }, async poll() {
    const first = [...timers][0]; assert.ok(first, 'poll timer is pending'); timers.delete(first[0]); first[1](); await flush();
  } };
}

await test('visual preparation posts exact current female voice/task, polls authentic status, returns capability URL', async () => {
  const calls = [];
  const f = controller(async (url, init) => {
    calls.push({ url, init });
    return reply(init.method === 'POST' ? { id: 'job', state: 'preparing', stage: 'tts', elapsedSeconds: 2 }
      : { id: 'job', state: 'ready', stage: 'validating', elapsedSeconds: 25, mediaUrl: '/aura/visual/media?id=job&ticket=cap' });
  });
  const prepared = f.value.prepare(body); await flush();
  assert.deepEqual(JSON.parse(calls[0].init.body), body);
  assert.equal(calls[0].init.headers['x-aura-instance'], 'instance-secret');
  assert.equal(f.statuses.at(-1).stage, 'tts'); assert.equal(f.statuses.at(-1).progress, undefined, 'no invented progress');
  await f.poll(); const ready = await prepared;
  assert.equal(ready.mediaUrl, '/aura/visual/media?id=job&ticket=cap');
  assert.equal(calls[1].init.headers['x-aura-instance'], 'instance-secret');
  f.value.cancel(); assert.equal(calls.at(-1).init.method, 'DELETE');
});

await test('cancel clears polling timer and DELETEs once; a late POST receipt cannot orphan a job', async () => {
  const allocation = deferred(), calls = [];
  const f = controller((url, init) => { calls.push({ url, init }); return init.method === 'POST' ? allocation.promise : Promise.resolve(reply({})); });
  const pending = f.value.prepare(body); f.value.cancel(); f.value.cancel();
  allocation.resolve(reply({ id: 'late-id', state: 'preparing', stage: 'rendering' }));
  assert.equal(await pending, null);
  assert.equal(calls.filter(c => c.init.method === 'DELETE').length, 1);
  assert.equal(calls.at(-1).url, '/aura/visual?id=late-id'); assert.equal(f.timers.size, 0);
});

await test('cancel aborts active GET, revokes job, and ignores stale ready response/status', async () => {
  const reading = deferred(), calls = [];
  const f = controller((url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return Promise.resolve(reply({ id: 'polling', state: 'preparing', stage: 'loading-models' }));
    if (init.method === 'DELETE') return Promise.resolve(reply({}));
    return reading.promise;
  });
  const pending = f.value.prepare(body); await flush(); await f.poll();
  const signal = calls.find(c => !c.init.method).init.signal;
  const statuses = f.statuses.length; f.revoke(); assert.equal(signal.aborted, true);
  reading.resolve(reply({ id: 'polling', state: 'ready', mediaUrl: '/stale' }));
  assert.equal(await pending, null); assert.equal(f.statuses.length, statuses);
  assert.equal(calls.at(-1).init.method, 'DELETE'); assert.equal(f.timers.size, 0);
});

await test('new generation cannot be overwritten by old preparation; inactive access starts nothing', async () => {
  const old = deferred(), calls = [];
  const f = controller((url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST' && JSON.parse(init.body).text === body.text) return old.promise;
    return Promise.resolve(reply({ id: 'new', state: 'ready', mediaUrl: '/new' }));
  });
  const stale = f.value.prepare(body);
  const fresh = await f.value.prepare({ ...body, text: '新回复' });
  old.resolve(reply({ id: 'old', state: 'ready', mediaUrl: '/old' }));
  assert.equal(await stale, null); assert.equal(fresh.mediaUrl, '/new');
  assert.ok(calls.some(c => c.url.endsWith('id=old') && c.init.method === 'DELETE'));
  f.revoke(); const count = calls.length; assert.equal(await f.value.prepare(body), null); assert.equal(calls.length, count);
});

await test('failed/preflight denial is surfaced without fallback TTS and releases job', async () => {
  for (const state of ['failed', 'cancelled']) {
    const calls = [], f = controller(async (url, init) => {
      calls.push({ url, init }); return reply({ id: 'bad', state, stage: 'preflight', error: '当前路径不可用' }, false);
    });
    await assert.rejects(f.value.prepare(body), /当前路径不可用/);
    assert.equal(calls.at(-1).init.method, 'DELETE'); assert.equal(f.timers.size, 0);
  }
});

await test('transient GET network and 503 failures retry the same allocated job, never TTS/POST again', async () => {
  const calls = []; let polls = 0;
  const f = controller(async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return reply({ id: 'stable', state: 'preparing', stage: 'loading-models' });
    if (init.method === 'DELETE') return reply({});
    if (++polls === 1) throw new TypeError('Failed to fetch');
    if (polls === 2) return { status: 503, ok: false };
    return reply({ id: 'stable', state: 'ready', mediaUrl: '/current' });
  });
  const pending = f.value.prepare(body); await flush();
  await f.poll(); await f.poll();
  assert.equal(calls.filter(c => c.init.method === 'DELETE').length, 0);
  await f.poll(); assert.equal((await pending).mediaUrl, '/current');
  assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  assert.equal(f.diagnostics.filter(d => d.stage === 'visual_poll_retry').length, 2);
  f.value.cancel('playback-ended'); assert.equal(f.diagnostics.at(-1).reason, 'playback-ended');
});

await test('poll retry budget is finite and explicit cancellation during retries remains immediate', async () => {
  for (const cancel of [false, true]) {
    const calls = [], f = controller(async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') return reply({ id: 'bounded', state: 'preparing', stage: 'rendering' });
      if (init.method === 'DELETE') return reply({});
      throw new TypeError('offline');
    });
    const pending = f.value.prepare(body), checked = cancel ? pending : assert.rejects(pending, /offline/);
    await flush(); await f.poll();
    if (cancel) { f.value.cancel('mic-start'); assert.equal(await pending, null); }
    else { await f.poll(); await f.poll(); await f.poll(); }
    await checked;
    assert.equal(calls.filter(c => c.init.method === 'DELETE').length, 1);
    assert.equal(calls.filter(c => c.init.method === 'POST').length, 1); assert.equal(f.timers.size, 0);
    assert.equal(f.diagnostics.at(-1).reason, cancel ? 'mic-start' : 'poll-error');
  }
});

// Full production module (not a parallel test implementation of speech logic).
async function mountPane(options = {}) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://aura.test' });
  const { window } = dom, { document } = window;
  window.localStorage.setItem('dsh-aura.prefs', JSON.stringify({ character: true, mode: 'talk', voice: 'longwan_v3', model: 'cosyvoice-v3-flash', ...options.prefs }));
  const calls = [], prompts = [], mediaCalls = [], summaries = [], entries = [], listeners = new Set();
  const polls = new Map(); let pollId = 0;
  if (options.manualPoll) {
    const schedule = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => {
      if (ms !== 1000) return schedule(fn, ms, ...args);
      const id = --pollId; polls.set(id, () => fn(...args)); return id;
    };
    window.clearTimeout = id => { if (!polls.delete(id)) clear(id); };
  }
  let seq = 0, running = false, api, closed = false;
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === '/aura/version') return reply({ origin: 'http://aura.test' });
    if (String(url).startsWith('/aura/visual')) return options.request ? options.request(url, init) : reply({ id: 'current-job', state: 'ready', mediaUrl: '/aura/visual/media?id=current-job&ticket=cap' });
    if (url === '/aura/tts') throw new Error('single character must NEVER use separate PCM');
    return reply({});
  };
  window.fetch = fetch;
  window.HTMLMediaElement.prototype.load = function () { mediaCalls.push({ kind: 'load', src: this.getAttribute('src') }); };
  window.HTMLMediaElement.prototype.pause = function () { mediaCalls.push({ kind: 'pause' }); };
  window.HTMLMediaElement.prototype.play = async function () {
    mediaCalls.push({ kind: 'play' }); if (options.playError) throw options.playError;
  };
  window.AudioContext = class { constructor() { throw new Error('single character answer must not create independent audio graph'); } };
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
  const services = { get(name) { return name === 'sessions' ? { binding: () => ({ session, eventSource }) } : { openTab() {} }; } };
  window.__ModuleLoader__ = { load(value) { api = value.factory(name => name === 'react' ? React : {}); } };
  new Function('window', 'document', 'navigator', 'ResizeObserver', 'fetch', 'WebSocket', 'location', source)(window, document, window.navigator, ResizeObserver, fetch, globals.WebSocket, window.location);
  let Body;
  const slots = { inject(_key, fn) { const off = fn(); if (off) summaries.push(off); return () => {}; },
    register(registration, component) { if (registration.name === 'sidebar.right.pane.tab') Body = component; return () => {}; } };
  api.apply({ inject(_keys, fn) { const off = fn({ sidebarRightTabs: { register: () => () => {} }, slots, get: services.get }); if (off) summaries.push(off); },
    remote: { commands: { execute: async () => ({ ok: true, value: { result: { kind: 'success' } } }) } }, slots, get: services.get });
  assert.ok(Body, 'actual pane slot component captured');
  const root = createRoot(document.getElementById('root'));
  const props = () => ({ sessionId: 'parent', useSessionStatus: selector => selector(new Map([['parent', { running }]])) });
  const render = async () => { await act(async () => root.render(React.createElement(Body, props()))); };
  const wait = ms => act(async () => { await new Promise(r => setTimeout(r, ms)); });
  await render(); await wait(30);
  const container = document.getElementById('root');
  const emit = async (type, data) => act(async () => {
    entries.push({ type: 'event', event: { seq: ++seq, type, data } }); for (const fn of listeners) fn();
  });
  const run = fn => act(async () => { fn(); });
  const send = async () => {
    await run(() => {
      const input = container.querySelector('textarea');
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(input, '执行当前任务');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await run(() => container.querySelector('[aria-label="Send"]').click());
  };
  const unmount = async () => {
    if (closed) return; closed = true;
    await act(async () => root.unmount()); for (const off of summaries) off(); dom.window.close();
  };
  return { container, calls, prompts, mediaCalls, emit, run, wait, send, unmount, socket: controls.at(-1),
    diagnostics: () => calls.filter(c => c.url === '/aura/diag').map(c => JSON.parse(c.init.body)),
    poll: async () => { const next = [...polls][0]; assert.ok(next, 'real production poll is pending');
      polls.delete(next[0]); await run(next[1]); },
    setRunning: async value => { running = value; await render(); },
    preferences: () => JSON.parse(window.localStorage.getItem('dsh-aura.prefs')),
    post: () => calls.filter(c => c.url === '/aura/visual' && c.init.method === 'POST') };
}
const summary = (f, values = {}) => f.run(() => f.socket.onmessage({ data: JSON.stringify({
  type: 'task-summary', sessionId: 'parent', key: 'parent:2', turn: 2, text: '当前任务已经完成，这是实际结果。', ...values,
}) }));
const final = (f, text, turn = 1) => f.emit('assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
const prepareReply = async f => {
  await f.send(); await f.setRunning(true); await final(f, '本轮回复。');
  await f.setRunning(false); await f.wait(160);
};
const preparationCard = f => f.container.querySelector('[data-aura-preparation]');
const speakEnd = async f => {
  const video = f.container.querySelector('video');
  await f.run(() => video.oncanplaythrough()); await f.run(() => video.onplaying()); await f.run(() => video.onended());
};

await test('full pane single-task completion renders once, uses native task id/female preference, and speaks only on media playing', async t => {
  const f = await mountPane(); t.after(f.unmount);
  await f.send(); assert.equal(f.prompts.length, 1, 'actual task submission is not suppressed');
  await f.setRunning(true);
  await f.emit('turn/start', { turn: 1 });
  await f.emit('tool/call', { turn: 1, step: 0, callId: 'dispatch', name: 'aura_task', arguments: '{}' });
  await f.emit('tool/result', { turn: 1, message: { toolCallId: 'dispatch', content: [{ type: 'text', text: JSON.stringify({ status: 'dispatched', sessionId: 'native-child' }) }] } });
  await f.emit('assistant/live-chunk', { turn: 1, chunk: { type: 'text-delta', text: '已经派发任务。' } });
  await final(f, '已经派发任务。');
  await f.setRunning(false); await f.wait(300);
  assert.equal(f.post().length, 0, 'dispatch acknowledgement incurs no TTS or render');
  await summary(f, { taskId: 'native-child' }); await f.wait(200);
  assert.equal(f.post().length, 1);
  const payload = JSON.parse(f.post()[0].init.body);
  assert.equal(payload.taskId, 'native-child'); assert.equal(payload.voice, 'longwan_v3'); assert.equal(payload.model, 'cosyvoice-v3-flash');
  const video = f.container.querySelector('video');
  assert.equal(video.getAttribute('src'), '/aura/visual/media?id=current-job&ticket=cap');
  assert.notEqual(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  await f.run(() => video.oncanplaythrough());
  assert.notEqual(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  await f.run(() => video.onplaying()); assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  await f.run(() => video.onended());
  assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'idle');
  assert.ok(f.calls.some(c => c.init.method === 'DELETE'), 'finished answer capability revoked');
  await summary(f); await f.wait(200); assert.equal(f.post().length, 1, 'completion duplicate is not expensive inference twice');
  assert.ok(!f.calls.some(c => c.url === '/aura/tts'));
});

await test('ordinary single response buffers ALL streamed sentences until completion, sends final current text exactly once', async t => {
  const f = await mountPane(); t.after(f.unmount); await f.send(); await f.setRunning(true);
  const text = '这是当前第一句。\n这是当前第二句。';
  await f.emit('assistant/live-chunk', { turn: 1, chunk: { type: 'text-delta', index: 0, text: '这是尚未定稿的中间说明。\n' } });
  await f.wait(180); assert.equal(f.post().length, 0, 'no sentence-level TTS/render while task is running');
  await f.emit('assistant/live-chunk', { turn: 1, chunk: { type: 'text-delta', index: 0, text: '这是当前第二句。' } });
  await final(f, text); await f.setRunning(false); await f.wait(160);
  assert.equal(f.post().length, 1); assert.equal(JSON.parse(f.post()[0].init.body).text, '这是当前第一句。，这是当前第二句。');
  await speakEnd(f);
  await summary(f, { key: 'parent:1', turn: 1, text }); await f.wait(200);
  assert.equal(f.post().length, 1, 'late completion cannot duplicate normal answer');
});

await test('fast completion before foreground ends/receipt arrives owns reply once and never leaves phantom pending task', async t => {
  const f = await mountPane(); t.after(f.unmount); await f.send(); await f.setRunning(true);
  await f.emit('tool/call', { turn: 1, callId: 'fast', name: 'aura_task', arguments: '{}' });
  await summary(f, { taskId: 'fast-child', key: 'parent:1', turn: 1 });
  await f.emit('tool/result', { turn: 1, message: { toolCallId: 'fast', content: [{ type: 'text', text: '{"status":"dispatched","sessionId":"fast-child"}' }] } });
  await final(f, '已经派发，请稍等。');
  await f.wait(180); assert.equal(f.post().length, 0);
  await f.setRunning(false); await f.wait(200);
  assert.equal(f.post().length, 1); assert.equal(JSON.parse(f.post()[0].init.body).taskId, 'fast-child');
  assert.equal(JSON.parse(f.post()[0].init.body).text, '当前任务已经完成，这是实际结果。');
  await speakEnd(f); assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'idle');
  await summary(f, { taskId: 'fast-child', key: 'parent:1-duplicate', turn: 1 }); await f.wait(200);
  assert.equal(f.post().length, 1, 'same turn with another key is not rendered twice');
});

await test('no-stream final snapshot fallback reads actual current reply once, never historical previous response', async t => {
  const f = await mountPane(); t.after(f.unmount);
  await final(f, '上一轮旧回复。', 0); await f.send(); await f.setRunning(true);
  await final(f, '这次完整回答。', 1); await f.setRunning(false); await f.wait(200);
  assert.equal(f.post().length, 1); assert.equal(JSON.parse(f.post()[0].init.body).text, '这次完整回答。');
  await speakEnd(f);
});

await test('production Pane shows prominent preparation card across authentic Chinese stages, real elapsed and steps without live tick spam', async t => {
  const stages = [
    ['preflight', '检查本地环境'], ['tts', '生成当前女声'], ['loading-models', '加载口型模型'],
    ['rendering', '生成口型音画'], ['muxing', '合并本次音画'], ['validating', '校验完整音画'],
  ];
  let index = 0;
  const f = await mountPane({ manualPoll: true, request: async (_url, init) => {
    if (init.method === 'DELETE') return reply({});
    const stage = stages[index][0];
    return reply({ id: 'stages', state: 'preparing', stage, elapsedSeconds: index * 17,
      ...(stage === 'rendering' ? { progress: { step: 3, steps: 20 } } : {}) });
  } });
  t.after(f.unmount); await prepareReply(f);
  const card = preparationCard(f), view = card.ownerDocument.defaultView;
  assert.ok(card.closest('[role="group"][aria-label^="Aura "]'), 'card is in the main call/character stage, not the footer');
  assert.equal(view.getComputedStyle(card).display, 'grid');
  assert.notEqual(view.getComputedStyle(card).visibility, 'hidden');
  assert.equal(card.hidden, false);
  for (const message of ['文字已回复，音画仍在生成', '当前为待机画面，完成后自动播放本次回答',
    '请留在本会话；切换、关闭或刷新会取消本次生成', '可能耗时数分钟或更久']) assert.ok(card.textContent.includes(message));
  assert.match(card.textContent, /非实时/);
  const live = card.querySelector('[aria-live="polite"]'), elapsed = card.querySelector('[aria-live="off"]');
  assert.equal(card.hasAttribute('aria-live'), false);
  assert.equal(live.textContent, '检查本地环境'); assert.equal(elapsed.textContent, '已用 0 秒');
  await f.wait(1100);
  assert.match(elapsed.textContent, /已用 [1-9]\d* 秒/);
  assert.equal(live.textContent, '检查本地环境', 'elapsed ticks are outside the small live region');
  assert.equal(live.contains(elapsed), false);
  for (index = 1; index < stages.length; index++) {
    await f.poll();
    assert.equal(preparationCard(f), card, 'same visible card persists across stages');
    assert.equal(live.textContent, stages[index][1]);
    assert.equal(elapsed.textContent, `已用 ${index * 17} 秒${index === 3 ? ' · 3/20' : ''}`);
    assert.doesNotMatch(card.textContent, /%|ETA|预计/);
    assert.equal(f.container.querySelector('video').getAttribute('src'), '/aura/character/front.mp4');
    assert.notEqual(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  }
  assert.ok(f.container.querySelector('[aria-label="Silence"]'));
  assert.ok(f.container.querySelector('[aria-label="Aura profile"]'));
  await f.run(() => f.container.querySelector('[aria-label="Silence"]').click());
  assert.equal(preparationCard(f), null);
  assert.equal(f.calls.filter(c => c.init.method === 'DELETE').length, 1);
});

await test('ready AV keeps preparation card until actual playing, preserves play gesture/settings, and clears after playback or buffering resumes', async t => {
  const f = await mountPane({ playError: Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }) });
  t.after(f.unmount); await prepareReply(f);
  const card = preparationCard(f), video = f.container.querySelector('video');
  assert.ok(card); assert.match(card.textContent, /音画就绪等待播放/);
  assert.match(card.textContent, /等待播放器就绪/); assert.doesNotMatch(card.textContent, /已播放|正在播放/);
  assert.notEqual(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  await f.run(() => video.oncanplaythrough());
  const play = f.container.querySelector('[data-aura-play]'); assert.ok(play, 'real autoplay-denied handler exposes gesture');
  const view = card.ownerDocument.defaultView;
  assert.ok(Number(view.getComputedStyle(play).zIndex) > Number(view.getComputedStyle(card).zIndex));
  const plays = f.mediaCalls.filter(c => c.kind === 'play').length;
  await f.run(() => play.click());
  assert.equal(f.mediaCalls.filter(c => c.kind === 'play').length, plays + 1);
  assert.equal(preparationCard(f), card, 'play request is not evidence of playing');
  await f.run(() => f.container.querySelector('[aria-label="Aura profile"]').click());
  const settings = f.container.querySelector('[aria-label="Aura settings"]'); assert.ok(settings);
  assert.ok(Number(view.getComputedStyle(settings).zIndex) > Number(view.getComputedStyle(card).zIndex));
  await f.run(() => f.container.querySelector('[aria-label="Close Aura profile"]').click());
  await f.run(() => video.onplaying());
  assert.equal(preparationCard(f), null); assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  await f.run(() => video.onwaiting());
  assert.match(preparationCard(f).textContent, /本次回答音画正在缓冲/);
  assert.doesNotMatch(preparationCard(f).textContent, /当前为待机画面/);
  await f.run(() => video.onplaying()); assert.equal(preparationCard(f), null);
  await f.run(() => video.onended()); assert.equal(preparationCard(f), null);
});

await test('failed or server-cancelled generation removes the preparation card and surfaces failure without independent audio', async () => {
  for (const state of ['failed', 'cancelled']) {
    const f = await mountPane({ manualPoll: true, request: async (_url, init) => reply(init.method === 'POST'
      ? { id: 'failed-job', state: 'preparing', stage: 'rendering', elapsedSeconds: 21 }
      : { id: 'failed-job', state, error: '本次音画未完成' }) });
    try {
      await prepareReply(f); assert.ok(preparationCard(f)); await f.poll();
      assert.equal(preparationCard(f), null); assert.match(f.container.querySelector('[role="alert"]').textContent, /本次音画未完成/);
      assert.equal(f.calls.filter(c => c.init.method === 'DELETE').length, 1);
      assert.ok(!f.calls.some(c => c.url === '/aura/tts'));
    } finally { await f.unmount(); }
  }
});

await test('honest elapsed stage/progress during long render; Silence aborts poll, DELETEs job, ignores late ready and late summaries', async t => {
  const stale = deferred();
  const f = await mountPane({ request: async (_url, init) => {
    if (init.method === 'POST') return reply({ id: 'preparing-job', state: 'preparing', stage: 'rendering', elapsedSeconds: 17, progress: { step: 3, steps: 20 } });
    if (init.method === 'DELETE') return reply({});
    return stale.promise;
  } });
  t.after(f.unmount); await f.send(); await f.setRunning(true);
  await f.emit('assistant/live-chunk', { turn: 1, chunk: { type: 'text-delta', index: 0, text: '本轮回复。' } });
  await final(f, '本轮回复。'); await f.setRunning(false); await f.wait(160);
  assert.match(f.container.textContent, /已用 17 秒 · 生成口型音画 · 3\/20/);
  assert.ok(preparationCard(f));
  assert.equal(f.container.querySelector('video').getAttribute('src'), '/aura/character/front.mp4');
  assert.notEqual(f.container.querySelector('[data-aura-state]').dataset.auraState, 'speaking');
  await f.wait(1100);
  const reading = f.calls.find(c => c.url.includes('?id=preparing-job') && !c.init.method);
  assert.ok(reading, 'actual poll started');
  await f.run(() => f.container.querySelector('[aria-label="Silence"]').click());
  assert.equal(reading.init.signal.aborted, true);
  assert.equal(preparationCard(f), null);
  assert.equal(f.calls.filter(c => c.init.method === 'DELETE').length, 1);
  stale.resolve(reply({ id: 'preparing-job', state: 'ready', mediaUrl: '/stale-answer' })); await f.wait(50);
  await summary(f, { turn: 2 }); await f.wait(200);
  assert.equal(f.post().length, 1); assert.equal(f.container.querySelector('video').getAttribute('src'), '/aura/character/front.mp4');
  assert.ok(!f.calls.some(c => c.url === '/aura/tts'));
});

const assertSafeInstanceDiagnostic = (line, close = false) => {
  assert.deepEqual(Object.keys(line).sort(), ['stage', 'v', 'at', 'sessionId', 'readyState', 'hidden',
    ...(close ? ['code', 'wasClean'] : [])].sort());
  assert.ok(Object.values(line).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value)));
  assert.equal(line.sessionId, 'parent'); assert.equal(line.hidden, false);
  assert.doesNotMatch(JSON.stringify(line), /test-instance-|credential-secret|ticket=|https?:|wss?:|mediaUrl|reason|environment/i);
};

await test('instance cleanup beacon precedes revoke/visual DELETE and socket close, without fabricating a remote close', async () => {
  const f = await mountPane({ request: async (_url, init) => reply(init.method === 'POST'
    ? { id: 'cleanup-job', state: 'preparing', stage: 'rendering', elapsedSeconds: 6 } : {}) });
  try {
    await prepareReply(f); assert.ok(preparationCard(f));
    const originalClose = f.socket.close; let closeObserved = false;
    f.socket.close = function () {
      closeObserved = true;
      assert.equal(f.diagnostics().filter(d => d.stage === 'instance_cleanup').length, 1);
      assert.ok(f.calls.some(c => c.init.method === 'DELETE'), 'revoke still runs before socket.close');
      return originalClose.call(this);
    };
    await f.unmount(); assert.ok(closeObserved); assert.equal(f.socket.readyState, 3);
    const lines = f.diagnostics(), cleanup = lines.find(d => d.stage === 'instance_cleanup');
    assertSafeInstanceDiagnostic(cleanup); assert.equal(cleanup.readyState, 1, 'recorded before socket.close');
    const cleanupIndex = f.calls.findIndex(c => c.url === '/aura/diag' && JSON.parse(c.init.body).stage === 'instance_cleanup');
    assert.ok(cleanupIndex < f.calls.findIndex(c => c.init.method === 'DELETE'), 'cleanup recorded before access.revoke cancels preparation');
    assert.equal(lines.filter(d => d.stage === 'instance_close').length, 0, 'cleanup keeps original detached-close-handler behavior');
    assert.equal(preparationCard(f), null);
  } finally { await f.unmount(); }
});

await test('network error and remote close diagnostics preserve code/wasClean but never log raw events or sensitive close reasons', async t => {
  const f = await mountPane(); t.after(f.unmount);
  await f.run(() => f.socket.onerror({ message: 'credential-secret', url: 'https://private/?ticket=credential-secret' }));
  assert.match(f.container.textContent, /连接失败/);
  await f.run(() => {
    const onclose = f.socket.onclose; f.socket.onclose = null; f.socket.close(); f.socket.onclose = onclose;
    onclose({ code: 1006, wasClean: false, reason: 'credential-secret '.repeat(20), token: 'credential-secret',
      url: 'wss://private/?ticket=credential-secret' });
  });
  const error = f.diagnostics().find(d => d.stage === 'instance_error'); assertSafeInstanceDiagnostic(error);
  const close = f.diagnostics().find(d => d.stage === 'instance_close'); assertSafeInstanceDiagnostic(close, true);
  assert.equal(close.code, 1006); assert.equal(close.wasClean, false); assert.equal(close.readyState, 3);
  assert.equal(f.diagnostics().filter(d => d.stage === 'instance_cleanup').length, 0, 'network failure is not a component cleanup');
});

await test('heartbeat timeout has its own safe diagnostic and retains normal revoke/close behavior', async t => {
  const f = await mountPane(); t.after(f.unmount);
  await f.run(() => f.socket.onmessage({ data: JSON.stringify({ type: 'owned', token: 'credential-secret', timeoutMs: 1 }) }));
  await f.wait(1100);
  const timeout = f.diagnostics().find(d => d.stage === 'instance_timeout'); assertSafeInstanceDiagnostic(timeout);
  assert.equal(timeout.readyState, 1); assert.equal(f.socket.readyState, 3);
  assert.match(f.container.textContent, /连接超时/);
  assertSafeInstanceDiagnostic(f.diagnostics().find(d => d.stage === 'instance_close'), true);
});

await test('lease invalidation during AV unloads video, revokes capability and ignores old playback callbacks', async t => {
  const f = await mountPane(); t.after(f.unmount); await f.send(); await f.setRunning(true);
  await f.emit('assistant/live-chunk', { turn: 1, chunk: { type: 'text-delta', index: 0, text: '即将中断的回答。' } });
  await final(f, '即将中断的回答。'); await f.setRunning(false); await f.wait(160);
  const video = f.container.querySelector('video'); await f.run(() => video.onplaying());
  const stale = video.onplaying;
  await f.run(() => f.socket.onclose({}));
  assert.equal(video.getAttribute('src'), null); assert.equal(f.container.querySelector('video'), null);
  assert.ok(f.calls.some(c => c.init.method === 'DELETE'));
  await f.run(stale); assert.match(f.container.textContent, /连接已断开/);
});

await test('two distinct completed turns with identical text each prepare once, not mistaken for historical replay', async t => {
  const f = await mountPane(); t.after(f.unmount);
  for (const turn of [1, 2]) {
    await f.send(); await f.setRunning(true); await final(f, '好的，完成。', turn); await f.setRunning(false); await f.wait(180);
    assert.equal(f.post().length, turn); await speakEnd(f);
  }
  const first = JSON.parse(f.post()[0].init.body), second = JSON.parse(f.post()[1].init.body);
  assert.equal(first.text, second.text); assert.notEqual(first.taskId, second.taskId, 'job key is per run, not per text');
});

await test('multi-child summary settles all attributed children, ignores late receipts and preserves unrelated running work', async t => {
  const f = await mountPane(); t.after(f.unmount); await f.send(); await f.setRunning(true);
  const receipt = child => f.emit('tool/result', { turn: 1, message: { toolCallId: child,
    content: [{ type: 'text', text: JSON.stringify({ status: 'dispatched', sessionId: child }) }] } });
  const state = () => f.container.querySelector('[data-aura-state]').dataset.auraState;
  for (const child of ['child-A', 'child-B', 'child-C']) {
    await f.emit('tool/call', { turn: 1, callId: child, name: 'aura_task', arguments: '{}' });
  }
  await receipt('child-A'); await receipt('child-C');
  await final(f, '三个任务已派发。'); await f.setRunning(false); await f.wait(200);
  assert.equal(f.post().length, 0, 'multi dispatch acknowledgement never renders');
  await summary(f, { key: 'parent:2', turn: 2, taskIds: ['child-A', 'child-B', 'child-A'] }); await f.wait(200);
  assert.equal(f.post().length, 1);
  assert.equal(JSON.parse(f.post()[0].init.body).taskId, 'parent:2', 'merged answer uses stable summary key, not arbitrary pending child');
  await receipt('child-B'); // Receipt arrives AFTER a summary already settled B.
  await speakEnd(f);
  assert.equal(state(), 'waiting', 'unrelated child C still blocks idle');
  await summary(f, { key: 'parent:3', turn: 3 }); await f.wait(200);
  assert.equal(f.post().length, 2);
  assert.equal(JSON.parse(f.post()[1].init.body).taskId, 'parent:3');
  await speakEnd(f);
  assert.equal(state(), 'waiting', 'unattributed summary cannot guess or clear unrelated child C');
  await summary(f, { key: 'parent:4', turn: 4, taskIds: ['child-C'] }); await f.wait(200);
  assert.equal(f.post().length, 3);
  assert.equal(JSON.parse(f.post()[2].init.body).taskId, 'child-C', 'single child in taskIds retains native identity');
  await speakEnd(f);
  assert.equal(state(), 'idle', 'all matched children settled, with no phantom pending A/B from late receipt');
});

await test('single-character local preflight gives actionable Chinese settings hints without voice substitution, PCM, render or blocking tasks', async () => {
  for (const prefs of [
    { voice: 'longanyang', model: 'cosyvoice-v3-flash' },
    { voice: 'custom-unverified-voice', model: 'cosyvoice-v3-flash' },
    { voice: 'longwan_v3', model: 'cosyvoice-v3.5-flash' },
  ]) {
    const f = await mountPane({ prefs });
    try {
      await f.run(() => f.container.querySelector('[aria-label="Aura profile"]').click());
      const settings = f.container.querySelector('[aria-label="Aura settings"]');
      const checkbox = [...settings.querySelectorAll('label')].find(label => label.textContent === '显示数字人');
      assert.ok(checkbox);
      const note = checkbox.parentElement.textContent;
      assert.match(note, /单句数字人需选择女声 \+ CosyVoice 3\.0 Flash（非 3\.5）/);
      assert.match(note, /不自动换声/); assert.match(note, /54 分钟（非实时）/); assert.match(note, /10 秒正面循环有接缝/);
      await f.run(() => f.container.querySelector('[aria-label="Close Aura profile"]').click());
      await f.send(); assert.equal(f.prompts.length, 1, 'invalid visual preference never prevents task submission');
      await f.setRunning(true); await final(f, '任务已经完成。'); await f.setRunning(false); await f.wait(180);
      assert.equal(f.post().length, 0, 'invalid visual configuration never allocates expensive backend work');
      assert.ok(!f.calls.some(call => call.url === '/aura/tts'), 'no fallback PCM');
      const hint = f.container.querySelector('[role="alert"]').textContent;
      assert.match(hint, /单句数字人需要女声音色和 CosyVoice 3\.0 Flash/);
      assert.match(hint, /请打开 Aura 设置/); assert.match(hint, /不会自动换声/); assert.match(hint, /任务执行不受影响/);
      assert.equal(f.preferences().voice, prefs.voice); assert.equal(f.preferences().model, prefs.model);
      assert.equal(f.container.querySelector('video').getAttribute('src'), '/aura/character/front.mp4');
    } finally { await f.unmount(); }
  }
});

await test('accepted task keeps same-turn mixed-dispatch acknowledgement silent in either receipt order', async () => {
  for (const rejectedFirst of [false, true]) {
    const f = await mountPane();
    try {
      await f.send(); await f.setRunning(true);
      for (const callId of ['accepted', 'rejected']) await f.emit('tool/call', { turn: 1, callId, name: 'aura_task', arguments: '{}' });
      const accepted = () => f.emit('tool/result', { turn: 1, message: { toolCallId: 'accepted',
        content: [{ type: 'text', text: '{"status":"dispatched","sessionId":"mixed-child"}' }] } });
      const rejected = () => f.emit('tool/result', { turn: 1, message: { toolCallId: 'rejected',
        content: [{ type: 'text', text: '{"error":"另一个任务无法启动"}' }] } });
      if (rejectedFirst) { await rejected(); await accepted(); } else { await accepted(); await rejected(); }
      await final(f, '一个任务已派发，另一个启动失败。'); await f.setRunning(false); await f.wait(240);
      assert.equal(f.post().length, 0, 'acknowledgement is not rendered while an accepted task runs');
      assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'waiting');
      await summary(f, { taskIds: ['mixed-child'] }); await f.wait(200);
      assert.equal(f.post().length, 1); assert.equal(JSON.parse(f.post()[0].init.body).taskId, 'mixed-child');
      await speakEnd(f); assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'idle');
    } finally { await f.unmount(); }
  }
});

await test('rejected task dispatch speaks the actual final failure instead of suppressing a non-acknowledgement', async t => {
  const f = await mountPane(); t.after(f.unmount); await f.send(); await f.setRunning(true);
  await f.emit('tool/call', { turn: 1, callId: 'rejected', name: 'aura_task', arguments: '{}' });
  await f.emit('tool/result', { turn: 1, message: { toolCallId: 'rejected', content: [{ type: 'text', text: '{"error":"任务无法启动"}' }] } });
  await final(f, '任务未能启动。'); await f.setRunning(false); await f.wait(160);
  assert.equal(f.post().length, 1); assert.equal(JSON.parse(f.post()[0].init.body).text, '任务未能启动。');
  await speakEnd(f); assert.equal(f.container.querySelector('[data-aura-state]').dataset.auraState, 'idle');
});
