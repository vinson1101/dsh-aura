import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { apply } from '../index.js';

const routes = new Map(), upgrades = new Map(), resourceRoutes = new Map(), effects = [];
let assetAdmission, connectionAvailable = true;
const admissionRequests = [];
const register = map => route => {
  if (route.resource) resourceRoutes.set(route.path, route);
  map.set(route.path, route.handler || (async (req, res) => {
    const response = await route.resource(new Request(origin + req.url, {
      method: req.method, headers: req.headers,
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  }));
  return () => { map.delete(route.path); resourceRoutes.delete(route.path); };
};
const ctx = {
  webServer: { register: register(routes), registerUpgrade: register(upgrades), getOrigin: () => origin },
  commands: { register() {} }, agents: { list: () => [] }, on() {},
  get(name) {
    if (name === 'connection') return connectionAvailable ? { requestRejection(request) {
      admissionRequests.push(request);
      return assetAdmission;
    } } : undefined;
    assert.fail('audio gate must reject before credentials/provider access');
  },
  effect(effect) { effects.push(effect()); },
};
const server = createServer((req, res) => {
  const handler = routes.get(new URL(req.url, 'http://localhost').pathname);
  if (!handler) { res.writeHead(404).end(); return; }
  Promise.resolve(handler(req, res)).catch(error => { console.error(error); res.writeHead(500).end(); });
});
server.on('upgrade', (req, socket, head) => upgrades.get(new URL(req.url, 'http://localhost').pathname)?.(req, socket, head));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const connect = (path) => new WebSocket(origin.replace('http', 'ws') + path);
const request = async (path, token) => {
  const response = await fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-aura-instance': token } : {}) }, body: '{}',
  });
  await response.text(); return response.status;
};
try {
  apply(ctx);
  for (const name of ['portrait', 'motion']) {
    const artwork = await fetch(origin + '/aura/peach/' + name + '.webp');
    assert.equal(artwork.status, 200);
    assert.equal(artwork.headers.get('content-type'), 'image/webp');
    assert.equal(Buffer.from(await artwork.arrayBuffer()).toString('ascii', 8, 12), 'WEBP');
  }
  const assets = [
    ['heart.mp4', 'assets/previews/短发直播测试/H3-比心/短发半身-双手比心.mp4', 'video/mp4'],
    ['smile.mp4', 'assets/previews/短发直播测试/H3-逗笑对照/H3-被逗开心.mp4', 'video/mp4'],
    ['wave.mp4', 'assets/previews/短发直播测试/首尾衔接预演/挥手统一棚景.mp4', 'video/mp4'],
    ['short-hair.png', 'assets/previews/短发直播测试/无声倾听/短发正面直视-参考帧.png', 'image/png'],
    ['front.mp4', 'assets/runtime/short-hair/front-loop-background-matched.mp4', 'video/mp4'],
    ['catalog.json', 'assets/runtime/short-hair/catalog.json', 'application/json'],
    ['idle-side.mp4', 'assets/runtime/short-hair/idle-side-h3-matched.mp4', 'video/mp4'],
    ['idle-lean.mp4', 'assets/runtime/short-hair/idle-lean.mp4', 'video/mp4'],
    ['side.png', 'assets/runtime/short-hair/side.png', 'image/png'],
    ['turn.mp4', 'assets/runtime/short-hair/turn.mp4', 'video/mp4'],
    ['listen.mp4', 'assets/runtime/short-hair/listen.mp4', 'video/mp4'],
    ['respond.mp4', 'assets/runtime/short-hair/respond.mp4', 'video/mp4'],
    ['return.mp4', 'assets/runtime/short-hair/return.mp4', 'video/mp4'],
  ];
  assert.deepEqual([...resourceRoutes.keys()].sort(), [...assets.map(([name]) => '/aura/character/' + name), '/aura/visual/media', '/aura/visual/config'].sort(),
    'only approved exact resources plus scoped visual media are registered');
  for (const rejection of [401, 403]) {
    assetAdmission = rejection;
    assert.equal((await fetch(origin + '/aura/visual/media?id=not-a-uuid&ticket=bad')).status, rejection,
      'visual media checks browser admission before id/file handling');
    assert.equal(await request('/aura/visual'), rejection, 'visual API checks browser admission before ownership/body');
  }
  assetAdmission = undefined;
  connectionAvailable = false;
  assert.equal((await fetch(origin + '/aura/visual/media')).status, 401);
  assert.equal(await request('/aura/visual'), 401);
  connectionAvailable = true;
  assert.equal((await fetch(origin + '/aura/visual/media?id=not-a-uuid&ticket=bad')).status, 404);
  assert.equal((await fetch(origin + '/aura/visual/media?id=../../etc/passwd')).status, 404);
  for (const [name, localPath, contentType] of assets) {
    const url = origin + '/aura/character/' + name;
    const route = resourceRoutes.get('/aura/character/' + name);
    assert.equal(route.kind, 'exact', 'never register a filesystem/prefix resource route');
    for (const rejection of [401, 403]) {
      assetAdmission = rejection;
      for (const options of [{}, { method: 'HEAD' }, { headers: { range: 'bytes=0-15' } }, { method: 'POST' }]) {
        const denied = await fetch(url, options);
        assert.equal(denied.status, rejection, name + ' reuses portrait admission before method/range handling');
        assert.equal(denied.headers.get('content-range'), null, 'denied requests reveal no size');
        assert.equal((await denied.arrayBuffer()).byteLength, 0);
      }
    }
    assetAdmission = undefined;
    connectionAvailable = false;
    assert.equal((await fetch(url)).status, 401, 'missing Connection fails closed');
    connectionAvailable = true;
    const expected = await readFile(new URL('../' + localPath, import.meta.url));
    const full = await fetch(url, { headers: { origin, cookie: 'admission-marker=present' } });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), contentType);
    assert.equal(full.headers.get('content-length'), String(expected.length));
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('cache-control'), 'no-cache');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(admissionRequests.at(-1).headers.get('origin'), origin);
    assert.equal(admissionRequests.at(-1).headers.get('cookie'), 'admission-marker=present');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), expected);
    if (contentType === 'image/png') {
      assert.equal(expected.readUInt32BE(16), 1113);
      assert.equal(expected.readUInt32BE(20), 1414);
    } else if (contentType === 'application/json') {
      const catalog = JSON.parse(expected);
      assert.equal(catalog.schemaVersion, 1);
      const tagged = JSON.parse(await readFile(new URL('../docs/参考资料/盛唐-微表情与肢体动作库/Aura素材标签.json', import.meta.url)));
      assert.deepEqual(catalog.assets, tagged.assets, 'runtime selection preserves the reviewed source tags');
      assert.ok(catalog.assets.some(asset => asset.id === 'h3-lean' && asset.runtime.roles.includes('idle-interaction')));
      assert.deepEqual(catalog.assets.find(asset => asset.id === 'h3-heart').runtime.roles, ['manual-interaction']);
    } else assert.equal(expected.toString('ascii', 4, 8), 'ftyp');
    for (const headers of [{}, { range: 'bytes=3-20' }, { range: 'bytes=not-valid' }]) {
      const head = await fetch(url, { method: 'HEAD', headers });
      assert.equal(head.status, 200, 'Range is GET-only, HEAD describes the full representation');
      assert.equal(head.headers.get('content-length'), String(expected.length));
      assert.equal(head.headers.get('content-range'), null);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
    }
    for (const [range, start, end] of [
      ['bytes=0-15', 0, 15], ['bytes=123-456', 123, 456],
      ['bytes=16-', 16, expected.length - 1], ['bytes=-17', expected.length - 17, expected.length - 1],
      [`bytes=${expected.length - 1}-${expected.length + 500}`, expected.length - 1, expected.length - 1],
      [`bytes=-${expected.length + 100}`, 0, expected.length - 1],
    ]) {
      const partial = await fetch(url, { headers: { range } });
      assert.equal(partial.status, 206, range);
      assert.equal(partial.headers.get('content-type'), contentType);
      assert.equal(partial.headers.get('content-range'), `bytes ${start}-${end}/${expected.length}`);
      assert.equal(partial.headers.get('content-length'), String(end - start + 1));
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected.subarray(start, end + 1), range);
    }
    for (const range of [
      `bytes=${expected.length}-`, 'bytes=20-10', 'bytes=-0', 'bytes=-',
      'bytes=1-2,4-5', 'bytes=nope', 'items=0-1', 'bytes=0-9007199254740992',
      'bytes=9007199254740992-', 'bytes=-9007199254740992',
    ]) {
      const invalid = await fetch(url, { headers: { range } });
      assert.equal(invalid.status, 416, range);
      assert.equal(invalid.headers.get('content-range'), `bytes */${expected.length}`);
      assert.equal(invalid.headers.get('content-length'), '0');
      assert.equal((await invalid.arrayBuffer()).byteLength, 0);
    }
    const ifRange = await fetch(url, { headers: { range: 'bytes=0-15', 'if-range': '"unknown-validator"' } });
    assert.equal(ifRange.status, 200, 'unvalidated If-Range must not get a slice');
    assert.deepEqual(Buffer.from(await ifRange.arrayBuffer()), expected);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const unsupported = await fetch(url, { method });
      assert.equal(unsupported.status, 405);
      assert.equal(unsupported.headers.get('allow'), 'GET, HEAD');
      await unsupported.arrayBuffer();
    }
    const query = await fetch(url + '?file=/etc/passwd&path=../../secrets.js&url=https://example.invalid/remote.mp4');
    assert.equal(query.status, 200, 'query cannot select a file or initiate a fetch');
    assert.deepEqual(Buffer.from(await query.arrayBuffer()), expected);
    const calls = admissionRequests.length;
    assetAdmission = 403;
    const admitted = await route.resource(new Request(url, { headers: { range: 'bytes=1-8' } }), { id: 'admitted-peer' });
    assert.equal(admitted.status, 206, 'an in-process Peer was already admitted by its caller');
    assert.equal(admissionRequests.length, calls);
    assert.deepEqual(Buffer.from(await admitted.arrayBuffer()), expected.subarray(1, 9));
    assetAdmission = undefined;
  }
  for (const suffix of [
    'other.png', 'source.mp4', 'runtime-metadata.json', '../secrets.js', '%2e%2e%2fsecrets.js',
    '%2Fetc%2Fpasswd', 'side.png/extra', 'side.png%00.mp4', 'turn.mp4.bak',
    'https%3A%2F%2Fexample.invalid%2Fvideo.mp4',
  ]) assert.equal((await fetch(origin + '/aura/character/' + suffix)).status, 404, suffix);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const [, localPath] of assets) assert.ok(manifest.files.includes(localPath), localPath + ' must ship');
  assert.ok(!manifest.files.some(file => file.includes('short-hair') && (file.endsWith('*') || file.includes('inspection'))),
    'runtime source/evidence files are not shipped by a broad glob');
  for (const path of ['/aura/tts', '/aura/asr', '/aura/visual']) assert.equal(await request(path), 409);
  const denied = connect('/aura/asr/live');
  const [code] = await once(denied, 'close');
  assert.equal(code, 1008, 'live ASR is also Host-gated, not merely hidden in the UI');
  const owner = connect('/aura/instance?sessionId=test-session');
  const [owned] = await once(owner, 'message');
  const { token } = JSON.parse(String(owned));
  for (const path of ['/aura/tts', '/aura/asr', '/aura/visual']) {
    assert.equal(await request(path, 'wrong-token'), 409);
    assert.equal(await request(path, token), 400, 'valid ownership reaches payload validation without accessing a provider');
  }
  const visualBody = { text: '本次任务回复。', voice: 'longyan_v3', model: 'cosyvoice-v3-flash', taskId: 'host-task', sessionId: 'test-session' };
  const visualCall = (method, suffix = '', body) => fetch(origin + '/aura/visual' + suffix, {
    method, headers: { 'x-aura-instance': token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await visualCall('POST', '', visualBody)).status, 503, 'opt-in disabled refuses a valid reply without TTS/inference');
  assert.equal((await visualCall('POST', '', { ...visualBody, text: '字'.repeat(3000) })).status, 503,
    'maximum-length visual text reaches the disabled service without accessing a provider');
  for (const body of [{ ...visualBody, voice: 'longanyang' }, { ...visualBody, voice: undefined },
    { ...visualBody, source: '/etc/passwd' }, { ...visualBody, text: '字'.repeat(3001) }]) {
    assert.equal((await visualCall('POST', '', body)).status, 400, 'strict voice/text/schema validation runs before any provider');
  }
  for (const [body, type] of [[' '.repeat(24 * 1024) + '{}', 'application/json'], ['{', 'application/json'], ['{}', 'text/plain']]) {
    const response = await fetch(origin + '/aura/visual', { method: 'POST',
      headers: { 'x-aura-instance': token, 'content-type': type }, body });
    assert.equal(response.status, 400, 'small JSON-only body boundary');
    await response.arrayBuffer();
  }
  assert.equal((await visualCall('GET', '?id=../secrets')).status, 400);
  assert.equal((await visualCall('DELETE', '?id=bad')).status, 400);
  assert.equal((await visualCall('PUT')).status, 405);
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.equal((await visualCall('GET', '?id=' + unknown)).status, 404);
  assert.equal((await visualCall('DELETE', '?id=' + unknown)).status, 404);
  const closed = once(owner, 'close'); owner.close(); await closed;
  for (const path of ['/aura/tts', '/aura/asr', '/aura/visual']) assert.equal(await request(path, token), 409, 'released tokens cannot consume provider resources');
  console.log('host.test.mjs: ok (13 allowlisted authenticated assets: HEAD/Range/416/path safety; ASR/TTS/visual ownership + browser admission, opt-in disabled, UUID/method gates)');
} finally {
  while (effects.length) effects.pop()();
  server.close(); await once(server, 'close');
}
