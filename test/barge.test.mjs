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

// The capture handler has one unconditional feed, no volume decision, no replay.
const handler = source.slice(source.indexOf('          node.port.onmessage = (event) => {'),
  source.indexOf('          liveCapture.seq += 1;'));
assert.equal((handler.match(/vad\.push\(event\.data\)/g) || []).length, 1);
assert.ok(!handler.includes('stopSpeaking'), 'microphone level alone cannot interrupt');
assert.ok(!handler.includes('headFrames'), 'already-streamed audio is not replayed');
assert.ok(!source.includes('BARGE_LEVEL'), 'the conflicting level-based path is removed');
assert.ok(source.includes('stopSpeaking({ echoTail: false })'));
console.log('barge.test.mjs: ok');
