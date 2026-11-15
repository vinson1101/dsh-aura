import assert from 'node:assert/strict';
import fs from 'node:fs';

/**
 * The guidance the pane relies on.
 *
 * Interrupting stops the voice; whether the work survives is a habit of the
 * model, encoded as a prompt section. This checks the section is registered
 * once, in the prompt registry, and that it still says the things the
 * interruption model depends on.
 */
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');

assert.ok(source.includes(`name: 'aura-background-tasks'`), 'the section is registered by name');
assert.ok(
  source.includes(`prompts.section({`),
  'and it is registered through the prompt registry, not a preset',
);

const start = source.indexOf('const BACKGROUND_TASK_PROMPT = [');
assert.ok(start > 0, 'the text is a named constant');
const end = source.indexOf(`].join('\\n');`, start);
assert.ok(end > start, 'the constant is closed');

for (const rule of [
  'run_in_background',
  'job_output',
  'job_kill',
  '插话',
]) {
  assert.ok(source.slice(start, end).includes(rule), `the rules mention ${rule}`);
}

assert.ok(
  /不要\s*job_kill|不调用 job_kill/.test(source.slice(start, end)),
  'an interruption does not kill the background job',
);

console.log('prompt.test.mjs: ok');
