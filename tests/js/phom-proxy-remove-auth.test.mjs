import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ProxyConfigStore } = require('../../desktop/browser-run/proxy-config-store.cjs');

// A minimal in-memory secret store (same shape ProxyConfigStore expects). No disk,
// no safeStorage, no network — keeps the test pure.
function fakeSecretStore() {
  const map = new Map();
  return {
    calls: { set: 0, del: 0 },
    setPassword(ref, secret) { this.calls.set++; map.set(ref, secret); return { ok: true }; },
    getPassword(ref) { return map.has(ref) ? map.get(ref) : null; },
    deletePassword(ref) { this.calls.del++; return map.delete(ref); },
    _map: map,
  };
}

function newStore() {
  const secret = fakeSecretStore();
  const store = new ProxyConfigStore({ filePath: null, secretStore: secret });
  return { store, secret };
}

// §5 — the empty password field must NEVER be overloaded as "remove auth".
test('edit with blank password KEEPS the existing password (ref + secret preserved)', () => {
  const { store, secret } = newStore();
  const created = store.upsert({ id: 'PX1', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'alice', password: 's3cr3t' });
  assert.equal(created.ok, true);
  const ref = store.get('PX1').passwordSecretRef;
  assert.ok(ref, 'password ref set on create');
  assert.equal(secret.getPassword(ref), 's3cr3t');

  // Edit host only; password field left blank (undefined) and NO passwordSecretRef sent.
  const edited = store.upsert({ id: 'PX1', protocol: 'http', host: '9.9.9.9', port: 8080, username: 'alice', password: undefined });
  assert.equal(edited.ok, true);
  const after = store.get('PX1');
  assert.equal(after.host, '9.9.9.9', 'host updated');
  assert.equal(after.passwordSecretRef, ref, 'password ref PRESERVED on blank-password edit');
  assert.equal(secret.getPassword(ref), 's3cr3t', 'stored secret PRESERVED');
  assert.equal(store.resolvePassword('PX1'), 's3cr3t');
});

test('explicit removeAuth clears username + password ref and DELETES the secret', () => {
  const { store, secret } = newStore();
  store.upsert({ id: 'PX2', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'pw' });
  const ref = store.get('PX2').passwordSecretRef;
  assert.equal(secret.getPassword(ref), 'pw');

  const removed = store.upsert({ id: 'PX2', protocol: 'http', host: '1.2.3.4', port: 8080, removeAuth: true });
  assert.equal(removed.ok, true);
  const after = store.get('PX2');
  assert.equal(after.passwordSecretRef, null, 'ref dropped');
  assert.equal(after.username, null, 'username cleared');
  assert.equal(secret.getPassword(ref), null, 'stored secret DELETED (not orphaned)');
  assert.ok(secret.calls.del >= 1, 'deletePassword was called');
  assert.equal(store.resolvePassword('PX2'), null);
});

test('a newly typed password REPLACES the old one', () => {
  const { store, secret } = newStore();
  store.upsert({ id: 'PX3', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'u', password: 'old' });
  const ref = store.get('PX3').passwordSecretRef;
  store.upsert({ id: 'PX3', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'u', password: 'new' });
  assert.equal(secret.getPassword(ref), 'new');
  assert.equal(store.resolvePassword('PX3'), 'new');
});

test('removeAuth wins even if a password is also (accidentally) supplied', () => {
  const { store, secret } = newStore();
  store.upsert({ id: 'PX4', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'u', password: 'x' });
  const ref = store.get('PX4').passwordSecretRef;
  store.upsert({ id: 'PX4', protocol: 'http', host: '1.2.3.4', port: 8080, password: 'ignored', removeAuth: true });
  const after = store.get('PX4');
  assert.equal(after.passwordSecretRef, null);
  assert.equal(after.username, null);
  assert.equal(secret.getPassword(ref), null);
});

test('public snapshot after removeAuth reports no auth and leaks no secret', () => {
  const { store } = newStore();
  store.upsert({ id: 'PX5', protocol: 'http', host: '1.2.3.4', port: 8080, username: 'u', password: 'p' });
  store.upsert({ id: 'PX5', protocol: 'http', host: '1.2.3.4', port: 8080, removeAuth: true });
  const snap = JSON.stringify(store.getPublic('PX5'));
  assert.equal(/p(assword)?/i.test(JSON.stringify(store.get('PX5').passwordSecretRef || '')), false);
  assert.equal(store.getPublic('PX5').hasAuth, false);
  assert.equal(/"password"/i.test(snap), false);
});
