// Freeze reviewed input bytes first; construct a reproducible, isolated LOCAL test artifact.
// No build/package manager runs against the dirty checkout. No profile writes here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { visualConfig } from '../visual-response.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !output.startsWith('/Users/vinson/Projects/local/aura-releases/')) throw new Error('Explicit owned local release path required');
const quickTalkDefaults = process.env.AURA_QUICKTALK_URL
  ? { provider: 'quicktalk', remoteUrl: visualConfig({ provider: 'quicktalk' }).remoteUrl } : {};
try { await fs.stat(output); throw new Error('Refusing to overwrite an existing artifact'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const files = ['assets/previews/短发直播测试/H3-比心/短发半身-双手比心.mp4',
'assets/previews/短发直播测试/H3-逗笑对照/H3-被逗开心.mp4',
'assets/previews/短发直播测试/首尾衔接预演/挥手统一棚景.mp4',
'package.json', 'README.md', 'LICENSE', 'index.js', 'client.js', 'asr.js', 'tts.js',
  'visual-response.js', 'visual-settings.js', 'tasks.js', 'task-speech.js', 'instance.js', 'secrets.js',
  'tools/latentsync-response.py', 'tools/stage-local-visual.mjs', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json',
  'docs/DETAIL.md', 'docs/PANEL.md', 'docs/PROVIDERS.md', 'docs/VOICES.md',
  'assets/runtime/peach/portrait.webp', 'assets/runtime/peach/motion.webp',
  ...['side.png', 'turn.mp4', 'listen.mp4', 'respond.mp4', 'return.mp4', 'front-loop-background-matched.mp4', 'idle-side-h3-matched.mp4', 'idle-lean.mp4', 'catalog.json'].map(x => 'assets/runtime/short-hair/' + x),
  'assets/previews/短发直播测试/无声倾听/短发正面直视-参考帧.png',
  'assets/previews/短发直播测试/无声倾听/短发正面直视-十秒无声倾听.mp4',
  'assets/previews/短发直播测试/Wan讲话-背景单独校正/Wan讲话底片-定妆棚景-10秒无声.mp4',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trimEnd();
const source = { repository: root, branch: git('branch', '--show-current'), base: git('rev-parse', 'HEAD'),
  status: git('status', '--short'), diff: git('diff', '--binary'), files: {} };
const frozen = new Map();
for (const file of files.sort()) { const bytes = await fs.readFile(path.join(root, file)); frozen.set(file, bytes); source.files[file] = sha(bytes); }
// Capture the sole production dependency as exact bytes, including its license.
const wsRoot = path.join(root, 'node_modules/ws');
async function dependency(dir, relative = '') {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('Dependency symlinks are not reproducible');
    const name = path.posix.join(relative, item.name), absolute = path.join(dir, item.name);
    if (item.isDirectory()) await dependency(absolute, name);
    else if (item.isFile()) { const bytes = await fs.readFile(absolute); const file = 'node_modules/ws/' + name; frozen.set(file, bytes); source.files[file] = sha(bytes); }
  }
}
await dependency(wsRoot);
const manifest = JSON.parse(frozen.get('package.json').toString('utf8'));
const ws = JSON.parse(frozen.get('node_modules/ws/package.json').toString('utf8'));
if (ws.version !== '8.23.0') throw new Error('Unexpected frozen ws version');
// Detect concurrent changes before the frozen snapshot is accepted.
for (const [file, digest] of Object.entries(source.files)) if (sha(await fs.readFile(path.join(root, file))) !== digest) throw new Error('Source changed while freezing: ' + file);
const sourceDigest = sha(Buffer.from(JSON.stringify(source.files)));
const frozenDir = path.join(output, 'frozen-input');
const artifact = path.join(output, 'package');
await fs.mkdir(output); // Atomically claim this new path; never share an output directory.
for (const [file, bytes] of frozen) {
  await fs.mkdir(path.dirname(path.join(frozenDir, file)), { recursive: true });
  await fs.writeFile(path.join(frozenDir, file), bytes, { flag: 'wx' });
}
await fs.writeFile(path.join(output, 'source.json'), JSON.stringify(source, null, 2) + '\n', { flag: 'wx' });
// The deployable artifact is built only from that frozen, hashed input, never the worktree.
await fs.cp(frozenDir, artifact, { recursive: true, errorOnExist: true, force: false });
const defaults = { enabled: true,
  envDir: '/Users/vinson/Projects/local/aura-latentsync-mac-20261123',
  repoDir: '/Users/vinson/Projects/github/bytedance/LatentSync',
  vaeDir: '/Users/vinson/Projects/local/aura-musetalk-1.5/models/sd-vae',
  python: '/Users/vinson/Projects/local/aura-musetalk-1.5/.venv/bin/python',
  ffmpeg: '/opt/homebrew/bin/ffmpeg', ffprobe: '/opt/homebrew/bin/ffprobe',
  workDir: quickTalkDefaults.provider ? '/Users/vinson/Projects/local/aura-visual-response-quicktalk' : '/Users/vinson/Projects/local/aura-visual-response',
  ...quickTalkDefaults,
};
const wrapper = `// Local test deployment authority. Explicit persisted values always win.\nimport { apply as applyAura } from './host-runtime.js';\nimport { readFileSync } from 'node:fs';\nexport { inject } from './host-runtime.js';\nconst defaults = JSON.parse(readFileSync(new URL('./local-visual-config.json', import.meta.url), 'utf8'));\nexport function apply(ctx, config = {}) {\n  const incoming = config.visualResponse;\n  if (incoming !== undefined && (!incoming || typeof incoming !== 'object' || Array.isArray(incoming))) throw new TypeError('visualResponse must be an object');\n  const visualResponse = { ...defaults, ...incoming };\n  if (incoming?.enabled === undefined) visualResponse.enabled = defaults.enabled;\n  return applyAura(ctx, { ...config, visualResponse });\n}\n`;
// Retain the original public entry filename: DSH relocates linked roots only after
// Node resolves that filename successfully in its cached, previous package root.
await fs.writeFile(path.join(artifact, 'host-runtime.js'), frozen.get('index.js'), { flag: 'wx' });
await fs.writeFile(path.join(artifact, 'index.js'), wrapper);
await fs.writeFile(path.join(artifact, 'local-visual-config.json'), JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx' });
manifest.exports['.'] = './index.js';
manifest.dependencies.ws = '8.23.0';
manifest.files.push('host-runtime.js', 'local-visual-config.json');
await fs.writeFile(path.join(artifact, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
const hashes = {};
async function hashTree(dir, prefix = '') {
  for (const name of (await fs.readdir(dir)).sort()) {
    const file = path.join(dir, name), relative = path.posix.join(prefix, name), stat = await fs.lstat(file);
    if (stat.isDirectory()) await hashTree(file, relative);
    else if (stat.isFile()) hashes[relative] = sha(await fs.readFile(file));
    else throw new Error('Non-file artifact entry');
  }
}
await hashTree(artifact);
const artifactDigest = sha(Buffer.from(JSON.stringify(hashes)));
const record = { version: manifest.version, sourceDigest, artifactDigest, sourceBase: source.base,
  authority: 'Explicit local test wrapper defaults, persisted raw config overrides; normal source default remains disabled',
  productionDependency: { ws: ws.version }, files: hashes };
await fs.writeFile(path.join(output, 'artifact.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, artifact, version: manifest.version, sourceDigest, artifactDigest,
  files: Object.keys(hashes).length, bytes: [...frozen.values()].reduce((n, b) => n + b.length, 0) }, null, 2));
