import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * What the voice is allowed to say.
 *
 * The reply is written for the eye. Read aloud, a fenced block becomes the word
 * "backtick", an identifier becomes English inside a Chinese sentence, and a
 * table row becomes punctuation soup. This pulls the normaliser out of the
 * bundle and checks it against the shapes that actually appear in replies.
 */
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('    function speechText(text) {');
const end = source.indexOf('    /**', start);
assert.ok(start > 0 && end > start, 'speechText is present in the bundle');
const code = source
  .slice(start, end)
  .split('\n')
  .map((line) => line.replace(/^    /, ''))
  .join('\n');
const speechText = new Function(`${code}; return speechText;`)();

/* ---- markup is dropped ------------------------------------------------- */

assert.equal(speechText('```js\nlet a = 1\n```'), '', 'a code block is not spoken');
assert.equal(speechText('运行 `npm test` 看一下。'), '运行 看一下。', 'inline code is removed');
assert.equal(speechText('**重要**：这次修好了。'), '重要：这次修好了。', 'emphasis marks are removed');
assert.equal(speechText('看这里 https://example.com/x 就懂'), '看这里 就懂', 'a URL is removed');

/* ---- noise is not spoken ---------------------------------------------- */

assert.equal(speechText('tts_cancelled'), '', 'an identifier alone is silent');
assert.equal(speechText('0.26.2'), '', 'a version alone is silent');
assert.equal(speechText('| 版本 | 现象 |'), '', 'a table row is silent');
assert.equal(speechText('   '), '', 'whitespace is silent');

/* ---- prose survives ---------------------------------------------------- */

assert.equal(speechText('先说结论：改好了。'), '先说结论：改好了。', 'a sentence is untouched');
assert.equal(
  speechText('第一行\n第二行'),
  '第一行，第二行',
  'a soft line break becomes a pause, not a stop',
);
assert.equal(
  speechText('第一段\n\n第二段'),
  '第一段。第二段',
  'a paragraph break becomes a full stop',
);
assert.ok(
  speechText('我现在用的是 cosyvoice 这个模型，稳定。').includes('cosyvoice'),
  'an English word inside Chinese prose is kept',
);

console.log('speech.test.mjs: ok');
