// Offline seam test: no model, network, profile or external effects.
import assert from 'node:assert/strict';
import { mountForeground } from '../tasks.js';
for (const boundary of ['before-acceptance', 'accepted-before-receipt', 'after-receipt']) {
  const tools = new Map();
  const accepted = Promise.withResolvers(), receipt = Promise.withResolvers(), done = Promise.withResolvers();
  let dispatches = 0, completions = 0, interrupts = 0, disposals = 0;
  const childId = 'fixed-child-' + boundary;
  const signal = new AbortController();
  const agent = { session: { header: { cwd: '/offline' } }, ctx: { get(name) {
    return name === 'tools' ? { register(d) { tools.set(d.name, d); return () => tools.delete(d.name); }, guard() { return () => {}; } } : { section() { return () => {}; } };
  } } };
  const off = mountForeground(agent, {
    resolveMaxDepth() { return 1; },
    async startActivation(spec) {
      dispatches++;
      await accepted.promise;
      spec.signal.throwIfAborted(); // Simulated acceptance fence (not a live native worker).
      done.promise.then(() => completions++);
      await receipt.promise; // Manager already owns child; parent receipt can be late.
      return { childId, name: 'worker', result: done.promise, dispose() { disposals++; } };
    },
    interrupt() { interrupts++; },
  }, { reserve() { return childId; }, forget(id) { assert.equal(id, childId); } });
  const pending = tools.get('aura_task').execute({ description: 'no side effects', prompt: 'return one constant' }, { signal: signal.signal });
  if (boundary === 'before-acceptance') {
    signal.abort(); accepted.resolve();
    await assert.rejects(pending, /abort/i);
    assert.equal(completions, 0);
  } else {
    accepted.resolve(); await Promise.resolve();
    if (boundary === 'accepted-before-receipt') signal.abort();
    receipt.resolve();
    const result = await pending;
    assert.equal(result.sessionId, childId);
    assert.equal(result.status, 'dispatched');
    signal.abort(); off();
    done.resolve(); await Promise.resolve();
    assert.equal(completions, 1, 'same child completes once despite foreground interruption');
  }
  assert.equal(dispatches, 1); assert.equal(interrupts, 0); assert.equal(disposals, 0);
}
console.log('dispatch-race.test.mjs: offline before/after acceptance and before receipt ok');
