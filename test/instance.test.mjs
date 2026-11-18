import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { installInstance } from '../instance.js';

const upgrades = new Map(), effects = [];
const ctx = {
  webServer: {
    registerUpgrade(route) {
      assert.equal(upgrades.has(route.path), false);
      upgrades.set(route.path, route.handler);
      return () => upgrades.delete(route.path);
    },
  },
  effect(effect) { effects.push(effect()); },
};
const server = createServer();
server.on('upgrade', (req, socket, head) => {
  const route = upgrades.get(new URL(req.url, 'http://localhost').pathname);
  if (route) route(req, socket, head); else socket.destroy();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `ws://127.0.0.1:${server.address().port}`;
const connect = async session => {
  const peer = new WebSocket(`${origin}/aura/instance?sessionId=${session}`);
  peer.on('error', () => {});
  const [data] = await once(peer, 'message');
  return { peer, message: JSON.parse(String(data)) };
};
const dispose = () => { while (effects.length) effects.pop()(); };
try {
  let instance = installInstance(ctx);
  const contenders = await Promise.all([connect('one'), connect('two')]);
  const owners = contenders.filter(c => c.message.type === 'owned');
  assert.equal(owners.length, 1, 'two windows racing for one runtime cannot both win');
  const owner = owners[0], busy = contenders.find(c => c.message.type === 'busy');
  assert.equal(busy.message.sessionId, owner.message.sessionId);
  assert.equal(instance.deliver('not-owner-session', { type: 'task-summary' }), false);
  const notice = once(owner.peer, 'message');
  assert.equal(instance.deliver(owner.message.sessionId, { type: 'task-summary', key: 'turn:1', text: '真实摘要' }), true);
  assert.equal(JSON.parse(String((await notice)[0])).text, '真实摘要');
  let stopped = 0, released;
  const releaseObserved = new Promise(resolve => { released = resolve; });
  assert.equal(instance.authorize('bogus-token', () => {}), null);
  assert.ok(instance.authorize(owner.message.token, () => { stopped++; released(); }));
  const detach = instance.authorize(owner.message.token, () => assert.fail('detached resource was revoked'));
  detach();
  const closed = once(owner.peer, 'close');
  owner.peer.close(); await closed; await releaseObserved;
  assert.equal(stopped, 1, 'closing Aura releases owned speech resources');
  assert.equal(instance.deliver(owner.message.sessionId, { type: 'task-summary', text: '迟到结果' }), false, 'closed owners have no replay backlog');
  assert.equal(instance.authorize(owner.message.token, () => {}), null, 'stale tokens cannot reopen audio');
  const next = await connect('three');
  assert.equal(next.message.type, 'owned');
  assert.notEqual(next.message.token, owner.message.token);
  let shutdown = 0;
  instance.authorize(next.message.token, () => { shutdown++; });
  const shutdownClosed = once(next.peer, 'close');
  dispose(); await shutdownClosed;
  assert.equal(shutdown, 1, 'plugin/runtime shutdown closes audio but has no Agent/worker dependency');
  instance = installInstance(ctx, { heartbeatMs: 10, timeoutMs: 80 });
  const afterRestart = await connect('four');
  assert.equal(afterRestart.message.type, 'owned');
  assert.equal(instance.authorize(next.message.token, () => {}), null, 'restart invalidates the previous runtime token');
  const lost = once(afterRestart.peer, 'close');
  await lost;
  assert.equal(instance.authorize(afterRestart.message.token, () => {}), null, 'half-open/frozen clients expire');
  const final = await connect('five');
  assert.equal(final.message.type, 'owned', 'an expired instance releases the runtime seat');
  const finalClosed = once(final.peer, 'close'); final.peer.close(); await finalClosed;
  console.log('instance.test.mjs: ok (real concurrent sockets, release, stale tokens, restart, timeout)');
} finally {
  dispose();
  server.close(); await once(server, 'close');
}
