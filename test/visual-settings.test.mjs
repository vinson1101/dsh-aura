import assert from 'node:assert/strict';
import { installVisualSettings } from '../visual-settings.js';
let route, denied, available = true, owner = true, writes = 0, active = 0, failure, revoke, revokeBeforeEdit;
let current = { asr: { provider: 'existing' }, tts: { model: 'cosyvoice-v3-flash' }, visualResponse: { workDir: '/private/preserved' } };
const entry = {};
const ctx = { fiber: { entry }, effect: fn => fn(), webServer: { register: value => { route = value; return () => {}; } },
  get(name) {
    if (name === 'connection') return { requestRejection: () => denied };
    if (name === 'configEditor') return available ? { async edit(actual, change) {
      assert.equal(actual, entry); if (failure) throw new Error(failure);
      if (revokeBeforeEdit) revoke();
      current = change(current); writes++;
    } } : undefined;
    assert.fail('status/config must never access providers');
  },
};
installVisualSettings(ctx, { enabled: false, version: 'test', instance: { authorize(token, onRevoke) {
  revoke = onRevoke;
  if (!owner || token !== 'owner') return null;
  active++; let released = false; return () => { if (!released) active--; released = true; };
} } });
const call = (method = 'GET', body, headers = {}) => route.resource(new Request('http://localhost/aura/visual/config', {
  method, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  headers: { 'content-type': 'application/json', 'x-aura-instance': 'owner', ...headers },
}));
for (const status of [401, 403]) {
  denied = status;
  assert.equal((await call()).status, status);
  assert.equal((await call('POST', { enabled: true })).status, status);
}
denied = undefined;
assert.deepEqual(await (await call()).json(), { enabled: false, provider: 'latentsync', editable: true, version: 'test' });
assert.equal(writes, 0, 'read-only status never persists or generates');
for (const value of [{}, [], null, { enabled: 1 }, { enabled: true, path: '/tmp' }, 'bad', 'x'.repeat(257)]) {
  assert.equal((await call('POST', value === null ? 'null' : value)).status, 400);
  assert.equal(active, 0);
}
assert.equal((await call('POST', { enabled: true }, { 'content-type': 'text/plain' })).status, 400);
assert.equal((await call('POST', { enabled: true }, { 'x-aura-instance': 'wrong' })).status, 409);
owner = false; assert.equal((await call('POST', { enabled: true })).status, 409); owner = true;
available = false;
assert.equal((await (await call()).json()).editable, false);
assert.equal((await call('POST', { enabled: true })).status, 503);
available = true; failure = 'overridden by a higher layer';
const rejected = await call('POST', { enabled: true });
assert.equal(rejected.status, 500); assert.match((await rejected.json()).error, /higher layer/);
assert.equal(writes, 0); failure = undefined;
revokeBeforeEdit = true;
assert.equal((await call('POST', { enabled: true })).status, 409, 'ownership rechecked inside serialized config transaction');
assert.equal(writes, 0); revokeBeforeEdit = false;
const aborted = new AbortController(); aborted.abort();
assert.equal((await route.resource(new Request('http://localhost/aura/visual/config', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-aura-instance': 'owner' },
  body: '{"enabled":true}', signal: aborted.signal,
}))).status, 409, 'aborted requests cannot persist');
assert.equal(writes, 0);
assert.deepEqual(await (await call('POST', { enabled: true })).json(), { saved: true, enabled: true, reopen: true });
assert.deepEqual(current, { asr: { provider: 'existing' }, tts: { model: 'cosyvoice-v3-flash' }, visualResponse: { workDir: '/private/preserved', enabled: true } });
await call('POST', { enabled: false }); assert.equal(current.visualResponse.enabled, false);
assert.equal(writes, 2); assert.equal(active, 0);
assert.equal((await call('DELETE')).status, 405);
console.log('ok visual settings: authenticated bounded read/save, explicit ownership, preserved raw config, honest failure, no provider access');
