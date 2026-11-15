import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * Telling the person from the speaker.
 *
 * Level alone cannot do it: automatic gain control moves it by 10x between a
 * quiet room and a loud answer, and the echo of the assistant's own voice is
 * speech-shaped. The envelopes are what differ — echo moves with the playback,
 * a person does not.
 */
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('    function correlation(');
const end = source.indexOf('    function mountOrb', start);
assert.ok(start > 0 && end > start, 'correlation is present');

const code = source
  .slice(start, end)
  .split('\n')
  .map((line) => line.replace(/^    /, ''))
  .join('\n');
const correlation = new Function(`${code}; return correlation;`)();

/* Echo: the microphone follows the speaker exactly. */
const playback = [0.1, 0.3, 0.2, 0.5, 0.4, 0.2, 0.1];
const echo = playback.map((value) => value * 0.6 + 0.01);
assert.ok(correlation(playback, echo) > 0.9, 'echo correlates with the playback');

/* Voice: loud exactly where the playback is quiet. */
const voice = [0.02, 0.02, 0.4, 0.35, 0.05, 0.5, 0.45];
assert.ok(correlation(playback, voice) < 0.4, 'a voice does not');

/* Degenerate inputs must not throw or divide by zero. */
assert.equal(correlation([0.1, 0.1, 0.1, 0.1], [0.2, 0.3, 0.1, 0.4]), 0, 'a flat series is 0');
assert.equal(correlation([0.1], [0.2]), 0, 'too few samples is 0');

/* And the decision has to use it. */
assert.ok(
  source.includes('const echoLike = follows > 0.8'),
  'the barge decision consults the correlation',
);
assert.ok(
  source.includes('const needed = echoLike ? threshold * 2 : threshold'),
  'and asks for more evidence when it looks like echo',
);

console.log('barge.test.mjs: ok');

/* ---- durations are milliseconds, not frames --------------------------- */

{
  /* The capture worklet posts 128 samples per call: 8 ms at 16 kHz. Reading a
   * "frame" as 100 ms is what made an onset 16 ms long and the head cache 80
   * ms deep — both far smaller than their comments claimed. */
  assert.ok(source.includes('const FRAME_MS = 8'), 'the frame length is stated once');
  assert.ok(source.includes('const framesFor = (ms)'), 'and converted in one place');
  assert.ok(source.includes('const BARGE_FRAMES = framesFor(200)'), 'an onset is 200 ms');
  assert.ok(source.includes('const HEAD_FRAMES = framesFor(HEAD_MS)'), 'the head is measured in ms');
  assert.ok(
    source.includes("options.echoTail === false ? 0 : Date.now() + 150"),
    'an interruption can keep the microphone open',
  );
  assert.ok(
    source.includes('stopSpeaking({ echoTail: false })'),
    'and the barge path does exactly that',
  );
}
