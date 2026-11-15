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
  source.includes('const echoLike = follows > 0.55'),
  'the barge decision consults the correlation',
);
assert.ok(
  source.includes('const needed = echoLike ? threshold * 2 : threshold'),
  'and asks for more evidence when it looks like echo',
);

console.log('barge.test.mjs: ok');
