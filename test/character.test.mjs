/** Real SingleCharacter DOM/state tests. No video decoder or inference; media
 * events and the 300-second inactivity clock are controlled explicitly. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('function SingleCharacter(');
const end = source.indexOf('/** The tab body:', start);
assert.ok(start > 0 && end > start);

async function mount(stage = 'idle', options = {}) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: options.desktop ? 'dsh-app://app/' : 'http://aura.test' });
  const { window } = dom, { document } = window;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const calls = { load: [], play: [], pause: [], seek: [] }, media = new WeakMap();
  const state = v => { if (!media.has(v)) media.set(v, { paused: true, currentTime: 0, readyState: 0 }); return media.get(v); };
  Object.defineProperties(window.HTMLMediaElement.prototype, {
    paused: { configurable: true, get() { return state(this).paused; } },
    readyState: { configurable: true, get() { return state(this).readyState; } },
    currentTime: { configurable: true, get() { return state(this).currentTime; },
      set(value) { calls.seek.push(value); state(this).currentTime = value; } },
  });
  window.HTMLMediaElement.prototype.load = function () {
    calls.load.push(this.getAttribute('src')); Object.assign(state(this), { paused: true, currentTime: 0, readyState: 0 });
  };
  window.HTMLMediaElement.prototype.pause = function () { calls.pause.push(this); state(this).paused = true; };
  window.HTMLMediaElement.prototype.play = function () {
    calls.play.push(this);
    if (this.rejectPlay) return Promise.reject(new Error('decoder rejected play'));
    state(this).paused = false; return Promise.resolve();
  };
  let now = 0, next = 0, hidden = false;
  const timers = new Map(), visibilityListeners = new Set();
  Object.defineProperty(window.performance, 'now', {value: () => now});
  window.setTimeout = (callback, delay) => { const id = ++next; timers.set(id, { callback, at: now + delay }); return id; };
  window.clearTimeout = id => timers.delete(id);
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
  document.addEventListener = (type, fn, ...args) => { if (type === 'visibilitychange') visibilityListeners.add(fn); add(type, fn, ...args); };
  document.removeEventListener = (type, fn, ...args) => { if (type === 'visibilitychange') visibilityListeners.delete(fn); remove(type, fn, ...args); };
  const diagnostics = [];
  const SingleCharacter = new Function('React', 'h', 'window', 'document', 'CHARACTER_IMAGE', 'CHARACTER_SURROUND', 'diag', 'fetch', 'URL', 'Blob', 'Math',
    `${source.slice(start, end)}; return SingleCharacter;`)(React, React.createElement, window, document, {}, { pointerEvents: 'none', zIndex: -1 },
      (stage, value) => diagnostics.push({ stage, ...value }), (url, init) => url === '/aura/character/catalog.json'
        ? Promise.resolve(options.catalogFailure ? new Response(null, { status: 404 })
          : Response.json({ schemaVersion: 1, assets: options.catalog || [] }))
        : (options.fetch || globalThis.fetch)(url, init), options.URL || URL, Blob,
      Object.assign(Object.create(Math), { random: () => options.idleRandom ?? 0 }));
  const control = { current: null }, root = createRoot(document.getElementById('root'));
  let sessionId = 'session-one', currentStage = stage, closed = false;
  const run = fn => act(async () => { fn(); });
  const render = async (nextStage = currentStage, nextSession = sessionId) => {
    currentStage = nextStage; sessionId = nextSession;
    await act(async () => root.render(React.createElement(SingleCharacter, { stage: currentStage, sessionId, control })));
  };
  await render();
  const node = document.querySelector('[data-aura-visual="single-character"]'), video = node.querySelector('video');
  const reply = node.querySelector('[data-aura-reply-player]');
  const idleVideo = node.querySelector('[data-aura-idle-player]');
  const event = (name, target = video) => run(() => {
    if (name === 'loadeddata') state(target).readyState = 4;
    target[`on${name}`]?.();
  });
  const replyEvent = name => event(name, reply);
  const advance = async ms => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); await run(due[1].callback);
    }
    now = until;
  };
  const ready = async (target = video) => { await event('loadeddata', target); await event('playing', target); };
  const unmount = async () => {
    if (closed) return; closed = true;
    await act(async () => root.unmount()); dom.window.close();
  };
  return { node, video, idleVideo, reply, replyEvent, control, calls, diagnostics, timers, visibilityListeners, render, run, event, ready, advance, unmount,
    hide: value => run(() => { hidden = value; document.dispatchEvent(new window.Event('visibilitychange')); }) };
}

async function frontal(f, stage = 'listening') {
  await f.render('listening'); await f.ready();
  await f.render(stage);
}
await test('static approved portrait on entry and while opening the microphone, with no automatic playback', async t => {
  const f = await mount(); t.after(f.unmount);
  assert.equal(f.node.querySelector('img').getAttribute('src'), '/aura/character/side.png');
  assert.equal(f.node.dataset.auraClip, 'side');
  assert.equal(f.video.getAttribute('src'), null);
  assert.equal(f.reply.getAttribute('src'), null);
  assert.equal(f.calls.play.length, 0);
  assert.equal(f.control.current.schedule, undefined, 'there is no separate PCM timeline in single mode');
  await f.advance(900000);
  await f.render('opening'); await f.advance(35000);
  assert.equal(f.node.dataset.auraClip, 'side');
  assert.equal(f.video.getAttribute('src'), null);
  await f.render('listening');
  assert.equal(f.video.getAttribute('src'), '/aura/character/front.mp4');
  assert.equal(f.node.querySelector('img').style.visibility, 'visible');
});

await test('listening/waiting/preparing keep same frontal source and time with no reload, seek or restart', async t => {
  const f = await mount(); t.after(f.unmount); await frontal(f);
  f.video.currentTime = 8.72;
  const loads = f.calls.load.length, plays = f.calls.play.length, pauses = f.calls.pause.length, seeks = f.calls.seek.length;
  for (const stage of ['waiting', 'prepare', 'idle', 'opening', 'listening', 'idle']) await f.render(stage);
  assert.equal(f.video.getAttribute('src'), '/aura/character/front.mp4');
  assert.equal(f.video.currentTime, 8.72);
  assert.equal(f.calls.load.length, loads); assert.equal(f.calls.play.length, plays);
  assert.equal(f.calls.pause.length, pauses); assert.equal(f.calls.seek.length, seeks);
});

const idleTag = (id, wave = false, overrides = {}) => ({
  id, state: '互动', pose: '正面半身', background: '统一棚景', audio_policy: '静音播放', status: '已认可',
  intent: '长待机低频', runtime: { enabled: true, roles: ['idle-interaction'], poseFamily: 'frontal-half',
    backgroundFamily: 'aura-studio', audio: 'silent', src: '/aura/character/' + id + '.mp4', wave, ...overrides },
});
const idleCatalog = [idleTag('idle-wave', true), idleTag('h3-lean'), idleTag('h3-heart', false, { roles: ['manual-interaction'] })];

await test('manual player requests stay independent from idle selection and yield to capture, answer and hidden state', async t => {
  const catalog = [idleTag('h3-heart', false, { roles: ['manual-interaction'], manualAction: 'heart' }), idleTag('idle-side')];
  const f = await mount('initial', { catalog }); t.after(f.unmount);
  assert.deepEqual(await f.control.current.interactions(), [{ id: 'h3-heart', action: 'heart', available: true, reason: undefined }]);
  assert.equal(f.control.current.preview('idle-side'), false);
  assert.equal(f.control.current.preview('h3-heart'), true);
  await f.ready(f.idleVideo);
  assert.equal(f.node.dataset.auraClip, 'h3-heart');
  const stale = f.idleVideo.onended;
  await f.render('opening');
  assert.equal(f.idleVideo.paused, true);
  assert.equal(f.control.current.preview('h3-heart'), false);
  await f.run(stale);
  await f.ready();
  assert.equal(f.node.dataset.auraClip, 'front');
  await f.render('prepare');
  assert.equal(f.control.current.preview('h3-heart'), true);
  await f.ready(f.idleVideo);
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=priority' });
  const rejected = assert.rejects(answer, /取消/);
  assert.equal(f.idleVideo.paused, true);
  assert.equal(f.control.current.preview('h3-heart'), false);
  f.control.current.clear(); await rejected;
  await f.hide(true);
  assert.equal(f.control.current.preview('h3-heart'), false);
});

await test('idle draws from the approved catalog after the microphone closes, spaces actions, and rate-limits waving', async t => {
  const f = await mount('idle', { catalog: idleCatalog }); t.after(f.unmount); await frontal(f, 'listening');
  await f.advance(900000);
  assert.equal(f.idleVideo.getAttribute('src'), null, 'open microphone blocks idle motion');
  await f.render('waiting');
  await f.advance(20000);
  await f.render('prepare');
  await f.advance(14999);
  assert.equal(f.node.dataset.auraClip, 'front', 'thinking-to-preparing keeps the same idle timer');
  assert.equal(f.idleVideo.getAttribute('src'), null);
  await f.advance(1);
  assert.equal(f.idleVideo.getAttribute('src'), '/aura/character/idle-wave.mp4');
  assert.equal(f.video.style.opacity, '1', 'front remains until the idle clip decodes');
  assert.equal(f.idleVideo.style.opacity, '0');
  await f.ready(f.idleVideo);
  assert.equal(f.video.style.opacity, '0');
  assert.equal(f.idleVideo.muted, true); assert.equal(f.idleVideo.loop, false);
  assert.equal(f.node.dataset.auraClip, 'idle-wave');
  await f.event('ended', f.idleVideo);
  assert.equal(f.idleVideo.style.opacity, '1', 'last idle frame remains during front resume');
  await f.event('playing');
  assert.equal(f.node.dataset.auraClip, 'front');
  assert.equal(f.idleVideo.getAttribute('src'), null);
  await f.advance(34999);
  assert.equal(f.idleVideo.getAttribute('src'), null);
  for (let i = 0; i < 3; i++) {
    await f.advance(i === 0 ? 1 : 35000);
    assert.equal(f.idleVideo.getAttribute('src'), '/aura/character/h3-lean.mp4', 'wave cannot repeat inside 120 seconds');
    await f.ready(f.idleVideo); await f.event('ended', f.idleVideo); await f.event('playing');
  }
  await f.advance(35000);
  assert.equal(f.idleVideo.getAttribute('src'), '/aura/character/idle-wave.mp4');
});

await test('missing runtime labels do not invent an idle motion or unload an activated front', async t => {
  const f = await mount('idle', { catalogFailure: true }); t.after(f.unmount);
  await frontal(f, 'idle');
  assert.equal(f.node.dataset.auraClip, 'front');
  await f.advance(900000);
  assert.equal(f.node.dataset.auraClip, 'front');
  assert.equal(f.video.getAttribute('src'), '/aura/character/front.mp4');
  assert.equal(f.idleVideo.getAttribute('src'), null);
});

await test('opening, listening and hidden browser immediately interrupt idle motion and invalidate late decoder callbacks', async t => {
  const f = await mount('idle', { catalog: idleCatalog }); t.after(f.unmount); await frontal(f, 'idle');
  for (const next of ['opening', 'listening', 'hidden']) {
    await f.advance(35000);
    await f.ready(f.idleVideo);
    const stale = f.idleVideo.onended;
    assert.ok(['idle-wave', 'h3-lean'].includes(f.node.dataset.auraClip));
    if (next === 'hidden') await f.hide(true);
    else await f.render(next);
    assert.equal(f.idleVideo.paused, true);
    await f.run(stale);
    if (next === 'hidden') await f.hide(false);
    await f.event('playing');
    assert.equal(f.node.dataset.auraClip, 'front');
    assert.equal(f.idleVideo.getAttribute('src'), null);
    await f.render('idle');
  }
});

await test('current reply is one unmuted muxed AV clock; actual playing/ended govern completion, not load or play promise', async t => {
  const f = await mount(); t.after(f.unmount); await frontal(f, 'prepare');
  let playing = 0, waiting = 0, ended = 0;
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=current&ticket=secret',
    onPlaying() { playing++; }, onWaiting() { waiting++; } }).then(() => ended++);
  assert.equal(f.reply.muted, false); assert.equal(f.reply.loop, false);
  assert.equal(f.reply.getAttribute('src'), '/aura/visual/media?id=current&ticket=secret');
  assert.equal(f.video.style.opacity, '1');
  assert.equal(f.video.getAttribute('src'), '/aura/character/front.mp4');
  assert.equal(f.reply.style.opacity, '0');
  await f.replyEvent('playing');
  assert.equal(playing, 0, 'cannot switch before decoder readiness');
  const plays = f.calls.play.length;
  await f.replyEvent('loadeddata'); assert.equal(f.calls.play.length, plays, 'wait for canplaythrough of prepared complete AV');
  await f.replyEvent('canplaythrough'); assert.equal(playing, 0); assert.equal(ended, 0);
  assert.equal(f.video.style.opacity, '1'); assert.equal(f.reply.style.opacity, '0');
  await f.replyEvent('playing'); assert.equal(playing, 1);
  assert.equal(f.video.style.opacity, '0'); assert.equal(f.reply.style.opacity, '1'); assert.equal(f.node.dataset.auraAudio, 'playing');
  await f.advance(900000); assert.equal(f.node.dataset.auraClip, 'answer', 'no idle action during AV');
  await f.replyEvent('waiting'); assert.equal(waiting, 1); assert.equal(ended, 0);
  await f.replyEvent('playing'); await f.replyEvent('ended'); await answer;
  assert.equal(ended, 1); assert.equal(f.reply.style.opacity, '1'); assert.equal(f.reply.muted, true);
  assert.equal(f.video.getAttribute('src'), '/aura/character/front.mp4');
  await f.render('idle');
  await f.advance(499);
  assert.equal(f.node.dataset.auraClip, 'answer', 'retain answer tail briefly instead of cutting to portrait');
  assert.equal(f.node.querySelector('img').style.visibility, 'hidden');
  await f.advance(1); await f.ready();
  assert.equal(f.reply.style.transition, 'opacity 320ms ease-out');
  assert.ok(f.reply.getAttribute('src'), 'keep decoded frame during the fade');
  await f.advance(320);
  assert.equal(f.reply.getAttribute('src'), null);
  assert.equal(f.node.dataset.auraClip, 'front');
});

await test('a new answer interrupts the return delay and cannot be erased by an old fade timer', async t => {
  const f = await mount(); t.after(f.unmount); await frontal(f, 'prepare');
  const first = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=first' });
  await f.replyEvent('canplaythrough'); await f.replyEvent('playing'); await f.replyEvent('ended'); await first;
  const second = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=second' });
  const rejected = assert.rejects(second, /取消/);
  await f.replyEvent('canplaythrough'); await f.replyEvent('playing');
  await f.advance(1000);
  assert.equal(f.node.dataset.auraClip, 'answer');
  assert.equal(f.reply.getAttribute('src'), '/aura/visual/media?id=second');
  f.control.current.clear(); await rejected; await f.ready(); await f.advance(320);
  assert.equal(f.node.dataset.auraClip, 'front');
  assert.equal(f.reply.getAttribute('src'), null);
});

await test('an answer preempts silent interaction without reusing its decoder or losing the last frame', async t => {
  const f = await mount('idle', { catalog: idleCatalog }); t.after(f.unmount); await frontal(f, 'idle');
  await f.advance(35000); await f.ready(f.idleVideo);
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=queued' });
  const rejected = assert.rejects(answer, /取消/);
  assert.equal(f.idleVideo.paused, true);
  assert.equal(f.idleVideo.style.opacity, '1');
  assert.equal(f.reply.getAttribute('src'), '/aura/visual/media?id=queued');
  f.control.current.clear(); await rejected;
  await f.event('playing');
  assert.equal(f.node.dataset.auraClip, 'front');
  assert.equal(f.reply.getAttribute('src'), null);
});

await test('cancel unloads answer, rejects waiter, and invalidates all late decoder callbacks', async t => {
  const f = await mount(); t.after(f.unmount); await frontal(f, 'prepare');
  let playing = 0;
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=cancelled', onPlaying() { playing++; } });
  const rejected = assert.rejects(answer, /取消/);
  const stale = [f.reply.onplaying, f.reply.onended, f.reply.onerror, f.reply.oncanplaythrough];
  f.control.current.clear(); await rejected;
  const loads = f.calls.load.length;
  await f.run(() => stale.forEach(fn => fn?.()));
  assert.equal(playing, 0); assert.equal(f.calls.load.length, loads);
  assert.equal(f.reply.getAttribute('src'), null);
  assert.equal(f.video.getAttribute('src'), '/aura/character/front.mp4'); assert.equal(f.reply.muted, true);
});

await test('failed answer never falls back to respond.mp4 or independent speech', async t => {
  const f = await mount('prepare'); t.after(f.unmount);
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=bad' });
  const rejected = assert.rejects(answer, /无法播放/);
  f.reply.rejectPlay = true; await f.replyEvent('canplaythrough'); await rejected;
  assert.equal(f.node.dataset.auraClip, 'fallback');
  assert.equal(f.reply.getAttribute('src'), null);
  assert.ok(!f.calls.load.some(url => /respond|listen\.mp4/.test(url || '')));
});

await test('hidden playback pauses and resumes same media time, never reloads answer', async t => {
  const f = await mount('prepare'); t.after(f.unmount);
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=visible' });
  const rejected = assert.rejects(answer, /取消/);
  await f.replyEvent('canplaythrough'); await f.replyEvent('playing'); f.reply.currentTime = 3.2;
  const loads = f.calls.load.length, seeks = f.calls.seek.length;
  await f.hide(true); assert.equal(f.reply.paused, true);
  await f.hide(false); assert.equal(f.reply.paused, false); assert.equal(f.reply.currentTime, 3.2);
  assert.equal(f.calls.load.length, loads); assert.equal(f.calls.seek.length, seeks);
  f.control.current.clear(); await rejected;
});

await test('session replacement/unmount release decoder, listeners and timers; disposed API cannot restart', async t => {
  const f = await mount('prepare'); t.after(f.unmount);
  const old = f.control.current;
  const answer = old.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=obsolete' });
  const rejected = assert.rejects(answer, /关闭/);
  await f.render('idle', 'session-two'); await rejected;
  await assert.rejects(f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/old' }), /失效/);
  await f.unmount();
  assert.equal(f.control.current, null); assert.equal(f.visibilityListeners.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.video.getAttribute('src'), null); assert.equal(f.video.onplaying, null); assert.equal(f.video.onended, null);
  const loads = f.calls.load.length; old.sync(); old.clear(); old.activity();
  await assert.rejects(old.playReply({ sessionId: 'session-one', mediaUrl: '/stale' }), /失效/);
  assert.equal(f.calls.load.length, loads);
});

await test('autoplay denial retains the same completed AV and exposes a user-gesture retry, never fake speaking', async t => {
  const f = await mount('prepare'); t.after(f.unmount);
  const normalPlay = f.reply.play.bind(f.reply);
  f.reply.play = () => Promise.reject(new DOMException('User gesture required', 'NotAllowedError'));
  let playing = 0, ended = false;
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=retained', onPlaying() { playing++; } });
  void answer.catch(() => {});
  await f.replyEvent('canplaythrough');
  const button = f.node.parentElement.querySelector('[data-aura-play]'); assert.equal(button?.textContent, '点击播放音画');
  assert.equal(f.node.style.pointerEvents, 'none'); assert.equal(f.node.contains(button), false, 'gesture overlay escapes the negative background stack');
  assert.equal(button.style.pointerEvents, 'auto'); assert.equal(button.style.zIndex, '2');
  assert.equal(f.node.dataset.auraClip, 'side'); assert.equal(playing, 0);
  const loads = f.calls.load.length; f.reply.play = normalPlay;
  await f.run(() => button.click()); assert.equal(f.calls.load.length, loads);
  assert.equal(playing, 0); assert.equal(ended, false);
  await f.replyEvent('playing'); assert.equal(playing, 1); assert.equal(f.node.parentElement.querySelector('[data-aura-play]'), null);
  await f.replyEvent('ended'); await answer; ended = true; assert.equal(ended, true);
});

await test('visibility pause invalidates an outstanding play attempt, including a late AbortError after return', async t => {
  const f = await mount('prepare'); t.after(f.unmount);
  let rejectPlay; const normalPlay = f.reply.play.bind(f.reply);
  f.reply.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=paused' });
  const rejected = assert.rejects(answer, /取消/);
  await f.replyEvent('canplaythrough'); await f.hide(true);
  f.reply.play = normalPlay; await f.hide(false);
  await f.run(() => rejectPlay(new DOMException('Interrupted by pause', 'AbortError')));
  assert.equal(f.node.dataset.auraClip, 'side'); assert.equal(f.reply.getAttribute('src'), '/aura/visual/media?id=paused');
  assert.equal(f.node.parentElement.querySelector('[data-aura-play]'), null);
  f.control.current.clear(); await rejected;
});

function desktop(request) {
  const created = [], revoked = [];
  return { desktop: true, fetch: request, created, revoked, URL: {
    createObjectURL(blob) { const url = `blob:owned-${created.length}`; created.push({ url, blob }); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  } };
}
const mp4 = () => new Response(new Uint8Array([0, 0, 0, 32]), { headers: { 'content-type': 'video/mp4' } });

await test('Desktop authenticates and bounds a complete MP4 Blob; the SAME video decodes and unload revokes once', async t => {
  const requests = [], options = desktop(async (url, init) => { requests.push({ url, init }); return mp4(); });
  const f = await mount('listening', options); t.after(f.unmount);
  assert.equal(requests[0].url, '/aura/character/front.mp4');
  assert.equal(requests[0].init.credentials, 'same-origin'); assert.equal(options.created.length, 1);
  assert.equal(options.created[0].blob.type, 'video/mp4'); assert.equal(f.video.getAttribute('src'), 'blob:owned-0');
  assert.equal(f.calls.play.length, 0); await f.ready(); assert.equal(f.calls.play.length, 1);
  assert.ok(f.diagnostics.some(d => d.stage === 'character_asset_loaded' && d.bytes === 4));
  assert.ok(f.diagnostics.some(d => d.stage === 'character_decoded'));
  await f.unmount(); assert.deepEqual(options.revoked, ['blob:owned-0']);
  assert.equal(requests[0].init.signal.aborted, true);
});

await test('Desktop show during deferred answer download never plays an empty source or cancels the reply', async t => {
  let release;
  const options = desktop(url => url.includes('/visual/') ? new Promise(r => { release = r; }) : Promise.resolve(mp4()));
  const f = await mount('prepare', options); t.after(f.unmount); await f.ready();
  const answer = f.control.current.playReply({ sessionId: 'session-one', mediaUrl: '/aura/visual/media?id=current' });
  const rejected = assert.rejects(answer, /取消/);
  await f.hide(true); await f.hide(false); assert.equal(f.calls.play.filter(target => target === f.reply).length, 0);
  assert.equal(f.node.dataset.auraClip, 'side');
  await f.run(() => release(mp4())); await f.replyEvent('loadeddata');
  await f.hide(true); await f.hide(false); assert.equal(f.calls.play.filter(target => target === f.reply).length, 0, 'loadeddata alone is not answer admission');
  await f.replyEvent('canplaythrough'); assert.equal(f.calls.play.filter(target => target === f.reply).length, 1);
  f.control.current.clear(); await rejected;
});

await test('Desktop stale fetch receipt cannot allocate a Blob or revive the previous session', async t => {
  let release; const requests = [];
  const options = desktop((url, init) => { requests.push(init); return requests.length === 1 ? new Promise(r => { release = r; }) : Promise.resolve(mp4()); });
  const f = await mount('listening', options); t.after(f.unmount);
  await f.render('listening', 'next-session'); assert.equal(requests[0].signal.aborted, true);
  const count = options.created.length;
  await f.run(() => release(mp4())); assert.equal(options.created.length, count);
  assert.equal(f.video.getAttribute('src'), options.created.at(-1).url);
});

await test('Desktop chunked asset without content-length is size-bounded, aborts, cancels reader and reports failure', async t => {
  let cancelled = 0, signal;
  const options = desktop(async (_url, init) => {
    if (init.method === 'HEAD') return mp4();
    signal = init.signal;
    return { ok: true, headers: new Headers({ 'content-type': 'video/mp4' }), body: { getReader: () => ({
      read: async () => ({ done: false, value: { byteLength: 8 * 1024 * 1024 + 1 } }),
      cancel: async () => { cancelled++; }, releaseLock() {},
    }) } };
  });
  const f = await mount('listening', options); t.after(f.unmount);
  assert.equal(options.created.length, 0); assert.equal(signal.aborted, true); assert.equal(cancelled, 1);
  assert.equal(f.node.dataset.auraClip, 'fallback');
});

await test('Desktop hung download has a deadline even hidden; a decoded hidden front does not falsely time out', async t => {
  const options = desktop(() => new Promise(() => {}));
  const f = await mount('listening', options); t.after(f.unmount); await f.hide(true);
  await f.advance(15000); assert.equal(f.node.dataset.auraClip, 'fallback');
  await f.unmount();
  const good = await mount('listening'); t.after(good.unmount); await good.hide(true); await good.event('loadeddata');
  await good.advance(20000); assert.equal(good.node.dataset.auraClip, 'side');
  await good.hide(false); assert.equal(good.calls.play.length, 1);
});

await test('idle asset error preserves front and waits before trying another action', async t => {
  const f = await mount('idle', { catalog: idleCatalog }); t.after(f.unmount); await frontal(f, 'idle');
  await f.advance(35000); await f.event('error', f.idleVideo); await f.event('playing');
  assert.equal(f.node.dataset.auraClip, 'front');
  assert.equal(f.idleVideo.getAttribute('src'), null);
  await f.advance(34999);
  assert.equal(f.idleVideo.getAttribute('src'), null);
});
