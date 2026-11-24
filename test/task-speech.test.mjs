import assert from 'node:assert/strict';
import { installTaskSpeech } from '../task-speech.js';
import { mountForeground } from '../tasks.js';
const listeners = new Map(), effects = [], delivered = [];
const ctx = { on(name, fn) { listeners.set(name, fn); }, effect(fn) { effects.push(fn()); } };
const emit = (name, ...args) => listeners.get(name)?.(...args);
const speech = installTaskSpeech(ctx, (id, message) => delivered.push({ id, ...message }));
const parent = { id: 'parent', session: { header: { cwd: '/same-workspace' } } };
const claim = (child, turn, kind = 'subagent-settled', agent = parent, stopReason = 'completed') => emit('agent/inbox/claimed', { agent, turn, message: { source: { kind, senderSessionId: child, stopReason } } });
const answer = (turn, text, reason = 'completed', content) => {
  emit('session/event', { id: parent.id }, { type: 'assistant/message', data: { turn, step: 0, message: { content: content || [{ type: 'text', text }] } } });
  emit('session/event', { id: parent.id }, { type: 'turn/end', data: { turn, reason: { kind: reason } } });
};
// Delayed completion after the initial foreground turn already ended.
const child = speech.reserve(parent);
answer(1, '已派发。'); assert.equal(delivered.length, 0);
claim(child, 2); answer(2, '已完成测试。'); answer(2, '已完成测试。');
assert.equal(delivered.length, 1); assert.equal(delivered[0].text, '已完成测试。');
assert.equal(delivered[0].taskId, child, 'single task summary includes the actual reserved native child');
// Unrelated children, sessions, and unknown results cannot claim this channel.
claim('ordinary-child', 3); answer(3, '不应读');
claim(child, 4, 'subagent-settled', { id: 'other-session' }); answer(4, '不应读');
assert.equal(delivered.length, 1);
// Same turn merges tasks, not summaries; replay does not duplicate.
const second = speech.reserve(parent);
claim(child, 5); claim(second, 5); answer(5, '两个任务都完成。');
assert.equal(delivered.length, 2);
assert.equal(delivered.at(-1).taskId, undefined, 'merged summary must not invent a single native task identity');
assert.deepEqual(delivered.at(-1).taskIds, [child, second].sort(), 'merged summary names every actual completed child');
claim(second, 5); answer(5, '重复 end'); assert.equal(delivered.length, 2);
// send_message followed by settled: identical parent summary once.
claim(second, 6, 'agent-message'); answer(6, '测试通过。');
claim(second, 7); answer(7, '测试通过。'); assert.equal(delivered.length, 3);
emit('agent/inbox/claimed', { agent: parent, turn: 70, message: { source: { kind: 'subagent-settled', senderSessionId: second, stopReason: 'completed' }, content: [{ type: 'text', text: 'It sent you a message just before finishing, so its closing message is omitted.' }] } });
answer(70, '同一个结果的另一种复述。'); assert.equal(delivered.length, 3, 'native omitted closing text must not repeat a delivered relay');
// No fabricated success for failed parent turns or tool/reasoning output.
claim(child, 8); answer(8, '残缺回答', 'aborted');
claim(child, 9); answer(9, '', 'completed', [{ type: 'reasoning', text: 'secret' }, { type: 'tool-call', name: 'x' }]);
assert.equal(delivered.length, 3);
for (const [i, status] of ['error', 'aborted', 'refusal', 'max-tokens'].entries()) {
  claim(child, 10 + i, 'subagent-settled', parent, status); answer(10 + i, `任务终态：${status}`);
  assert.equal(delivered.at(-1).text, `任务终态：${status}`);
}
// Real aura_task execution reserves before native startActivation is called:
// claimed and complete may run BEFORE the receipt resolves.
let task, spec;
parent.ctx = { get(name) { return name === 'tools' ? { register(def) { if (def.name === 'aura_task') task = def; return () => {}; }, guard() { return () => {}; } } : { section() { return () => {}; } }; } };
const off = mountForeground(parent, { resolveMaxDepth: () => 1, async startActivation(input) {
  spec = input; claim(input.childId, 20); answer(20, '极速完成。');
  return { childId: input.childId, name: 'fast' };
} }, speech);
const result = await task.execute({ description: 'fast', prompt: 'context' }, { signal: new AbortController().signal });
assert.equal(result.sessionId, spec.childId); assert.match(spec.childId, /^session-/);
assert.equal(delivered.at(-1).text, '极速完成。'); assert.equal(spec.cwd, '/same-workspace');
assert.equal(delivered.at(-1).taskId, spec.childId, 'fast summary carries child ID before activation receipt');
off(); effects.reverse().forEach(fn => fn());
console.log('task-speech.test.mjs: ok (native claimed/message/end contracts, attribution, fast receipt, dedup, failures)');
