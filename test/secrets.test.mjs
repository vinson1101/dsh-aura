/**
 * Key resolution order, and the dotenv subset it reads.
 * Run with `node test/secrets.test.mjs`.
 */
import assert from 'node:assert/strict';
import { createKeyReader, parseEnvFile } from '../secrets.js';

/* ---- dotenv subset ------------------------------------------------------ */

assert.deepEqual(parseEnvFile('A=1\nB=two\n'), { A: '1', B: 'two' });
assert.deepEqual(parseEnvFile('# comment\n\nA=1\n'), { A: '1' }, 'comments and blanks are skipped');
assert.deepEqual(parseEnvFile('A="quoted"\nB=\'single\'\n'), { A: 'quoted', B: 'single' });
assert.deepEqual(parseEnvFile('A=has=equals\n'), { A: 'has=equals' }, 'only the first = splits');
assert.deepEqual(parseEnvFile('A=1\r\nB=2\r\n'), { A: '1', B: '2' }, 'CRLF survives');
assert.deepEqual(parseEnvFile('=novalue\nNOEQUALS\n'), {}, 'malformed lines are dropped');

/* ---- resolution order --------------------------------------------------- */

const ask = (options, configKey) => createKeyReader(options)(configKey);

/* 1. the configured literal wins */
assert.equal(
  await ask({ env: { DASHSCOPE_API_KEY: 'from-env' } }, '  from-config  '),
  'from-config',
);

/* 2. then the credential record */
assert.equal(
  await ask(
    {
      env: { DASHSCOPE_API_KEY: 'from-env' },
      readRecord: async () => ({ kind: 'grant', payload: { token: 'from-record' } }),
    },
    undefined,
  ),
  'from-record',
);

/* 3. then the environment */
assert.equal(
  await ask({ env: { DASHSCOPE_API_KEY: 'from-env' }, readRecord: async () => undefined }),
  'from-env',
);
assert.equal(
  await ask({ env: { XOB_BAILIAN_API_KEY: 'legacy-name' } }),
  'legacy-name',
  'the bridge name still works',
);

/* 4. then the secret file */
assert.equal(
  await ask({
    env: {},
    readSecretsFile: async () => 'DASHSCOPE_API_KEY="from-file"\n',
  }),
  'from-file',
);

/* nothing anywhere is undefined, not an empty string */
assert.equal(await ask({ env: {} }), undefined);

/* a throwing record or a missing file must not break resolution */
assert.equal(
  await ask(
    {
      env: {},
      readRecord: async () => {
        throw new Error('no credentials service');
      },
      readSecretsFile: async () => {
        throw new Error('ENOENT');
      },
    },
  ),
  undefined,
);

/* an empty record payload falls through to the next source */
assert.equal(
  await ask({
    env: { DASHSCOPE_API_KEY: 'from-env' },
    readRecord: async () => ({ kind: 'grant', payload: {} }),
  }),
  'from-env',
);

/* ---- the repository itself must stay free of key material --------------- */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Like node_modules, the gitignored real-app preview is local runtime state,
// not plugin source; Chromium owns transient/broken OS symlinks inside it.
const SKIP = new Set(['node_modules', '.git', 'test', '.aura-local-preview']);
// A task UUID contains "sk-..." inside "task-..."; it is not an API key.
// Keep scanning every source/doc and require a token boundary, not a file exemption.
const KEY_SHAPES = [/\bsk-[A-Za-z0-9._-]{20,}/, /MEUCIQ[A-Za-z0-9+/=]{10,}/];
const fakeKey = 'sk-' + 'x'.repeat(32);
for (const text of [fakeKey, `Bearer ${fakeKey}`, `API_KEY="${fakeKey}"`]) {
  assert.ok(KEY_SHAPES[0].test(text), 'real-shaped standalone keys must still be rejected');
}
assert.equal(KEY_SHAPES[0].test('task-635a3309-3dfd-42db-9f80-8f31cb0f7d2a'), false);
const offenders = [];

function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (SKIP.has(name)) continue;
    const full = path.join(directory, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
      continue;
    }
    if (stat.size > 512 * 1024) continue;
    if (!/\.(js|mjs|json|yml|yaml|md|txt|env)$/.test(name)) continue;
    const text = readFileSync(full, 'utf8');
    for (const shape of KEY_SHAPES) {
      if (shape.test(text)) offenders.push(path.relative(root, full));
    }
  }
}
walk(root);
assert.deepEqual(offenders, [], 'no key material may reach the repository');

console.log('secrets.test.mjs: ok');
