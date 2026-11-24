// Read-only isolated artifact verification. No Host/profile writes or inference.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const release = path.resolve(process.argv[2]);
const artifact = path.join(release, 'package');
const record = JSON.parse(await fs.readFile(path.join(release, 'artifact.json'), 'utf8'));
const source = JSON.parse(await fs.readFile(path.join(release, 'source.json'), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {};
async function scan(dir, prefix = '') {
  for (const name of (await fs.readdir(dir)).sort()) {
    const file = path.join(dir, name), relative = path.posix.join(prefix, name), stat = await fs.lstat(file);
    if (stat.isDirectory()) await scan(file, relative);
    else { assert.ok(stat.isFile()); hashes[relative] = sha(await fs.readFile(file)); }
  }
}
await scan(artifact);
assert.deepEqual(hashes, record.files);
assert.equal(sha(Buffer.from(JSON.stringify(hashes))), record.artifactDigest);
assert.equal(sha(Buffer.from(JSON.stringify(source.files))), record.sourceDigest);
for (const [file, digest] of Object.entries(source.files)) assert.equal(sha(await fs.readFile(path.join(release, 'frozen-input', file))), digest);
const manifest = JSON.parse(await fs.readFile(path.join(artifact, 'package.json'), 'utf8'));
assert.equal(manifest.version, process.argv[3] || record.version);
assert.equal(manifest.version, record.version);
assert.equal(manifest.version, JSON.parse(await fs.readFile(path.join(release, 'frozen-input/package.json'), 'utf8')).version);
assert.equal(manifest.exports['.'], './index.js');
assert.equal(hashes['host-runtime.js'], source.files['index.js'], 'original Host bytes retained exactly under the local wrapper');
assert.equal(manifest.dependencies.ws, '8.23.0');
const require = createRequire(path.join(artifact, 'package.json'));
assert.ok(require.resolve('ws').startsWith(path.join(artifact, 'node_modules/ws/')));
assert.equal(require('ws/package.json').version, '8.23.0');
assert.equal(typeof (await import(pathToFileURL(path.join(artifact, 'index.js')).href)).apply, 'function', 'complete production import graph resolves');
const defaults = JSON.parse(await fs.readFile(path.join(artifact, 'local-visual-config.json'), 'utf8'));
let received;
const context = vm.createContext({ URL, TypeError });
const index = new vm.SyntheticModule(['apply', 'inject'], function () { this.setExport('apply', (_ctx, config) => { received = config; }); this.setExport('inject', {}); }, { context });
const fsModule = new vm.SyntheticModule(['readFileSync'], function () { this.setExport('readFileSync', (url, encoding) => { assert.equal(url.href, pathToFileURL(path.join(artifact, 'local-visual-config.json')).href); assert.equal(encoding, 'utf8'); return JSON.stringify(defaults); }); }, { context });
const wrapper = new vm.SourceTextModule(await fs.readFile(path.join(artifact, 'index.js'), 'utf8'), { context, initializeImportMeta: meta => { meta.url = pathToFileURL(path.join(artifact, 'index.js')).href; } });
await wrapper.link(specifier => specifier === './host-runtime.js' ? index : specifier === 'node:fs' ? fsModule : assert.fail(specifier));
await wrapper.evaluate();
wrapper.namespace.apply({}); assert.equal(received.visualResponse.enabled, true);
for (const enabled of [false, true, undefined]) {
  const asr = { provider: 'preserved' }, tts = { model: 'preserved' };
  wrapper.namespace.apply({}, { asr, tts, visualResponse: { enabled, workDir: '/explicit' } });
  assert.equal(received.asr, asr); assert.equal(received.tts, tts);
  assert.equal(received.visualResponse.enabled, enabled ?? true); assert.equal(received.visualResponse.workDir, '/explicit');
}
for (const value of [null, false, 'bad', []]) assert.throws(() => wrapper.namespace.apply({}, { visualResponse: value }), /must be an object/);
console.log(JSON.stringify({ ok: true, version: manifest.version, sourceDigest: record.sourceDigest, artifactDigest: record.artifactDigest, files: Object.keys(hashes).length, checks: ['full frozen and runtime tree hashes', 'exact isolated ws resolution', 'complete production import graph', 'local wrapper defaults/persisted false/invalid shape/preserved ASR and TTS'], inference: false }, null, 2));
