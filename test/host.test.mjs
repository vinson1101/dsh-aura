import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { apply } from '../index.js';

const routes = new Map(), upgrades = new Map(), effects = [];
const register = map => route => { map.set(route.path, route.handler); return () => map.delete(route.path); };
const ctx = {
  webServer: { register: register(routes), registerUpgrade: register(upgrades), getOrigin: () => origin },
  commands: { register() {} }, agents: { list: () => [] }, on() {},
  get() { assert.fail('audio gate must reject before credentials/provider access'); },
  effect(effect) { effects.push(effect()); },
};
const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
  if (!handler) { res.writeHead(404).end(); return; }
  Promise.resolve(handler(req, res)).catch(error => { console.error(error); res.writeHead(500).end(); });
});
server.on('upgrade', (req, socket, head) => upgrades.get(new URL(req.url, 'http://localhost').pathname)?.(req, socket, head));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const connect = (path) => new WebSocket(origin.replace('http', 'ws') + path);
const request = async (path, token) => {
  const response = await fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-aura-instance': token } : {}) }, body: '{}',
  });
  await response.text(); return response.status;
};
try {
  apply(ctx);
  for (const path of ['/aura/tts', '/aura/asr']) assert.equal(await request(path), 409);
  const denied = connect('/aura/asr/live');
  const [code] = await once(denied, 'close');
  assert.equal(code, 1008, 'live ASR is also Host-gated, not merely hidden in the UI');
  const owner = connect('/aura/instance?sessionId=test-session');
  const [owned] = await once(owner, 'message');
  const { token } = JSON.parse(String(owned));
  for (const path of ['/aura/tts', '/aura/asr']) {
    assert.equal(await request(path, 'wrong-token'), 409);
    assert.equal(await request(path, token), 400, 'valid ownership reaches payload validation without accessing a provider');
  }
  const closed = once(owner, 'close'); owner.close(); await closed;
  for (const path of ['/aura/tts', '/aura/asr']) assert.equal(await request(path, token), 409, 'released tokens cannot consume provider resources');
  console.log('host.test.mjs: ok (actual routes gate ASR/TTS, reject stale ownership before credentials)');
} finally {
  while (effects.length) effects.pop()();
  server.close(); await once(server, 'close');
}
