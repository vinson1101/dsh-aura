import assert from 'node:assert/strict';
import { mountForeground, foregroundEnabled, installTaskLayer } from '../tasks.js';

const tools = new Map([['bash', {}], ['list_agents', {}], ['send_message', {}]]);
let guard, allowed, prompt, activation, interrupts = 0, disposed = 0, cancels = 0;
const workerDone = Promise.withResolvers();
const foregroundIdle = Promise.withResolvers();
const subagents = {
  resolveMaxDepth: () => 3,
  async startActivation(spec) {
    spec.signal.throwIfAborted();
    activation = spec;
    return { childId: 'child', name: 'worker', result: workerDone.promise, dispose: () => { disposed++; } };
  },
  async resolveName(_agent, name) { assert.equal(name, 'worker'); return 'child'; },
  interrupt(id, authority) { assert.equal(id, 'child'); assert.equal(authority.agent, agent); interrupts++; },
};
const scopedTools = {
  get: name => tools.get(name),
  register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name); },
  restrict(mask) { allowed = mask.allow; return () => { allowed = undefined; }; },
  guard(fn) { guard = fn; return () => { guard = undefined; }; },
};
const agent = {
  session: { header: { cwd: '/task/workspace' }, snapshotEvents: () => [] },
  ctx: { get(name) { return name === 'tools' ? scopedTools : { section(spec) { prompt = spec; return () => { prompt = undefined; }; } }; } },
  whenIdle: () => foregroundIdle.promise,
  cancel(cause, options) { assert.equal(cause.kind, 'user'); assert.equal(options.keepInbox, true); cancels++; },
};
const unmount = mountForeground(agent, subagents);
assert.equal(allowed, undefined, 'inherited tool schemas remain stable; guards enforce execution');
assert.match(guard({ name: 'bash' }), /aura_task/);
assert.equal(guard({ name: 'aura_task' }), undefined);
assert.equal(guard({ name: 'run_code' }), undefined, 'PTC transport retains guarded inner tools');
assert.match(prompt.text, /简单问题/);
assert.match(prompt.text, /不代表取消/);
const signal = new AbortController();
const dispatched = await tools.get('aura_task').execute({ description: 'work', prompt: 'Authorized task and full context' }, { agent, signal: signal.signal });
assert.equal(dispatched.status, 'dispatched');
assert.equal(activation.delivery, 'parent');
assert.equal(activation.parent, agent);
assert.equal(activation.cwd, '/task/workspace');
assert.match(activation.prompt[0].text, /Authorized task and full context/);
signal.abort();
assert.equal(disposed, 0, 'foreground abort never disposes published task');
assert.equal(interrupts, 0, 'foreground abort never interrupts worker');
await tools.get('aura_interrupt_task').execute({ name: 'worker' }, { signal: new AbortController().signal });
assert.equal(interrupts, 1, 'only explicit task operation interrupts worker');
unmount();
assert.equal(disposed, 0, 'leaving foreground does not dispose task');
assert.equal(tools.has('aura_task'), false);
assert.equal(prompt, undefined);

const events = [];
const run = (id, args, kind = 'success') => events.push(
  { type: 'command/run', data: { commandId: id, name: 'aura', args } },
  { type: 'command/done', data: { commandId: id, kind } },
);
run('a', ' on');
run('b', ' off', 'error');
assert.equal(foregroundEnabled(events), true);
run('c', ' interrupt');
assert.equal(foregroundEnabled(events), true);
run('d', 'off');
assert.equal(foregroundEnabled(events), false);

let command;
const handlers = {};
let cleanup;
installTaskLayer({ agents: { list: () => [] }, subagents, commands: { register(def) { command = def; } }, on(name, fn) { handlers[name] = fn; }, effect(fn) { cleanup = fn(); } });
const invoke = rawInput => command.handler({ agent, rawInput, signal: new AbortController().signal });
assert.equal(invoke('on').kind, 'success');
assert.equal(invoke('on').kind, 'success', 'activation is idempotent');
let interruptAcknowledged = false;
const interrupted = invoke('interrupt').then(value => { interruptAcknowledged = true; return value; });
await Promise.resolve();
assert.equal(interruptAcknowledged, false, 'voice remains gagged until obsolete foreground drains');
foregroundIdle.resolve();
assert.equal((await interrupted).kind, 'success');
assert.equal(cancels, 1);
assert.equal(interrupts, 1, 'foreground command does not interrupt task');
assert.equal(invoke('off').kind, 'success');
assert.equal(invoke('interrupt').kind, 'error');
agent.status = 'running';
assert.equal(invoke('on').kind, 'error', 'never convert and cancel existing ordinary work');
assert.equal(cancels, 1);
agent.status = 'idle';
cleanup();
assert.equal(guard, undefined);
// A plugin reload restores already-live foreground sessions, not only future
// agent/created events. Ordinary sessions remain untouched.
agent.session.snapshotEvents = () => events.slice(0, 2);
installTaskLayer({ agents: { list: () => [agent] }, subagents, commands: { register() {} }, on() {}, effect(fn) { cleanup = fn(); } });
assert.equal(tools.has('aura_task'), true);
assert.match(guard({ name: 'bash' }), /aura_task/);
cleanup();
workerDone.resolve({ output: 'done' });
console.log('prompt.test.mjs: scoped foreground, independent dispatch, explicit interruption and replay ok');
