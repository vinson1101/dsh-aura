import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('    function bare(');
const end = source.indexOf('    function levelOfFrame', start);
assert.ok(start > 0 && end > start);
const fromOurVoice = new Function(`${source.slice(start, end)}; return fromOurVoice;`)();

const spoken = '收到，我会继续处理插件市场的问题。';
assert.equal(fromOurVoice('', spoken), true, 'an empty partial is not speech');
assert.equal(fromOurVoice('收', spoken), true, 'a short echo must not interrupt playback');
assert.equal(fromOurVoice('收到，我会继续处理', spoken), true, 'our own partial is ignored');
assert.equal(fromOurVoice('插件市场的问题。', spoken), true, 'punctuation differences do not matter');
assert.equal(fromOurVoice('今天天气怎么样', spoken), false, 'ordinary new speech interrupts, without keywords');
assert.equal(fromOurVoice('先回答另一个问题', spoken), false);
assert.equal(fromOurVoice('你好', ''), false, 'speech without playback is user speech');

// Decisions use the entire partial, not a coincidental six-character suffix.
assert.equal(fromOurVoice('不要继续处理插件市场的问题', spoken), false);
const helpers = new Function(`${source.slice(start, end)}; return {createPlaybackReference, createSampleQueue};`)();
const ref = helpers.createPlaybackReference();
const audio = { currentTime: 0, state: 'running' };
ref.add(audio, 1, 2, '从一数到二十', 1);
assert.equal(ref.read(), '', 'scheduled but unplayed audio is excluded');
audio.currentTime = 1.2;
assert.equal(fromOurVoice('从一数到二十', ref.read()), true);
ref.clear();
ref.add(audio, 1.2, 2, '我们现在检查麦克风和背景声', 2);
assert.equal(fromOurVoice('从一数到二十', ref.read()), false, 'old turn cannot poison this playback');
assert.equal(fromOurVoice('检查麦克风', ref.read()), true, 'playback-only echo still filtered');
audio.currentTime = 2.19;
assert.equal(ref.read(), '', 'natural tail expires');
ref.add(audio, 3, 4, spoken, 3);
ref.clear(); audio.currentTime = 3.2;
assert.equal(ref.read(), '', 'cancelled audio is excluded');
for (const rate of [16000, 48000]) {
  const queue = helpers.createSampleQueue(rate);
  const expected = [];
  for (let i = 0; i < 38; i++) { const frame = new Float32Array(128).fill(i); expected.push(...frame); assert.equal(queue.push(frame), true); }
  const got = [];
  queue.drain(frame => got.push(...frame)); queue.drain(() => assert.fail('duplicate flush'));
  assert.deepEqual(got, expected, '38 raw worklet frames survive handshake once, in order');
  assert.equal(queue.stats().dropped, 0);
  assert.equal(queue.stats().delivered, 38 * 128);
}
const bounded = helpers.createSampleQueue(16000, 100);
assert.equal(bounded.push(new Float32Array(1600)), true);
assert.equal(bounded.push(new Float32Array(128)), false, 'overflow must be detectable, not discard oldest');
assert.equal(bounded.stats().dropped, 128);
assert.ok(!source.includes('handshakeFrames.length > 12'));
assert.ok(!source.includes('const stoppedEpoch'), 'no close/reopen timer on normal call handoff');
assert.ok(!source.includes('BARGE_LEVEL'), 'the conflicting level-based path is removed');
assert.ok(source.includes("stopSpeaking({ echoTail: false, reason: 'barge-in' })"));
console.log('barge.test.mjs: ok');
