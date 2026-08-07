import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { CookieVault, hostMatches } = require('../../desktop/cookie-vault.cjs');

test('hostMatches: exact + subdomain, not unrelated', () => {
  assert.equal(hostMatches('chamhinh.vinasoy.com', 'chamhinh.vinasoy.com'), true);
  assert.equal(hostMatches('chamhinh.vinasoy.com', '.vinasoy.com'), true);
  assert.equal(hostMatches('chamhinh.vinasoy.com', 'other.com'), false);
  assert.equal(hostMatches('evil-vinasoy.com', '.vinasoy.com'), false);
});

test('save + paramsForHost filters by domain; session cookie keeps no expiry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ckv-'));
  try {
    const v = new CookieVault(join(dir, 'v.json'));
    v.save([
      { name: 'sid', value: '9', domain: 'chamhinh.vinasoy.com', path: '/', secure: true, httpOnly: true, expires: -1 },
      { name: 'a', value: 'b', domain: '.vinasoy.com', path: '/', expires: 1893456000 },
      { name: 'x', value: '1', domain: 'other.com', path: '/' },
    ]);
    const params = v.paramsForHost('chamhinh.vinasoy.com');
    const names = params.map((p) => p.name).sort();
    assert.deepEqual(names, ['a', 'sid'], 'other.com excluded');
    const sid = params.find((p) => p.name === 'sid');
    assert.equal('expires' in sid, false, 'session cookie restored without expiry (stays a session cookie)');
    assert.equal(sid.secure, true);
    const a = params.find((p) => p.name === 'a');
    assert.equal(a.expires, 1893456000, 'persistent cookie keeps expiry');
    assert.equal(v.hasForHost('chamhinh.vinasoy.com'), true);
    assert.equal(v.hasForHost('nope.com'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('update replaces same name+path; persists across reload', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ckv-'));
  try {
    const file = join(dir, 'v.json');
    const v1 = new CookieVault(file);
    v1.save([{ name: 'sid', value: 'OLD', domain: 'app.test', path: '/' }]);
    v1.save([{ name: 'sid', value: 'NEW', domain: 'app.test', path: '/' }]);
    assert.equal(v1.paramsForHost('app.test').filter((p) => p.name === 'sid').length, 1, 'no duplicate');
    assert.equal(v1.paramsForHost('app.test').find((p) => p.name === 'sid').value, 'NEW');
    const v2 = new CookieVault(file); // reload from disk
    assert.equal(v2.paramsForHost('app.test').find((p) => p.name === 'sid').value, 'NEW', 'persisted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
