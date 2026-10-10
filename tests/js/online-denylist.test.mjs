// Shared online-revoke denylist: decide (pure) + checkDenylist (map/array) + the guard transitions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideOnline, checkDenylist, createDenylistGuard, STATE } = require('../../desktop/licensing/online-denylist.cjs');

test('decideOnline: revoked→LOCKED, not-listed→LIVE, offline within grace→GRACE, past grace→LOCKED', () => {
  const g = 24 * 3600 * 1000;
  assert.equal(decideOnline({ remote: { ok: true, active: true }, anchorAt: 0, now: 0, graceMs: g }).state, STATE.LIVE);
  assert.equal(decideOnline({ remote: { ok: true, revoked: true, reason: 'x' }, anchorAt: 0, now: 0, graceMs: g }).state, STATE.LOCKED);
  assert.equal(decideOnline({ remote: { ok: false }, anchorAt: 0, now: g - 1, graceMs: g }).state, STATE.GRACE);
  assert.equal(decideOnline({ remote: { ok: false }, anchorAt: 0, now: g + 1, graceMs: g }).state, STATE.LOCKED);
});

test('checkDenylist: listed (map/array) → revoked; not listed → active; failure → ok:false', async () => {
  const map = async () => ({ ok: true, status: 200, json: async () => ({ revoked: { L: 'hết thuê' } }) });
  assert.deepEqual(await checkDenylist('https://raw/revoked.json', 'L', { fetchImpl: map }), { ok: true, revoked: true, active: false, reason: 'hết thuê' });
  assert.deepEqual(await checkDenylist('https://raw/revoked.json', 'OTHER', { fetchImpl: map }), { ok: true, revoked: false, active: true });
  const arr = async () => ({ ok: true, status: 200, json: async () => ({ revoked: ['L'] }) });
  assert.equal((await checkDenylist('https://raw/revoked.json', 'L', { fetchImpl: arr })).revoked, true);
  const boom = async () => { throw new Error('offline'); };
  assert.equal((await checkDenylist('https://raw/revoked.json', 'L', { fetchImpl: boom })).ok, false);
  assert.equal((await checkDenylist('', 'L', { fetchImpl: map })).ok, false);
});

test('guard: fires onChange once when it locks, once when it unlocks', async () => {
  let listed = false;
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ revoked: listed ? { L: 'x' } : {} }) });
  const changes = [];
  const g = createDenylistGuard({ url: 'https://raw/revoked.json', licenseId: 'L', fetchImpl, onChange: (d) => changes.push(d.state) });
  assert.equal((await g.poll()).state, STATE.LIVE);
  listed = true;
  assert.equal((await g.poll()).state, STATE.LOCKED);
  await g.poll(); // still locked → no duplicate change
  listed = false;
  assert.equal((await g.poll()).state, STATE.LIVE);
  assert.deepEqual(changes, [STATE.LOCKED, STATE.LIVE]);
  assert.equal(g.isLocked(), false);
});

test('guard: url empty → OFF, never locks', async () => {
  const g = createDenylistGuard({ url: '', licenseId: 'L', fetchImpl: async () => ({ ok: true, json: async () => ({ revoked: { L: 'x' } }) }) });
  assert.equal((await g.poll()).state, STATE.LIVE);
  assert.equal(g.isLocked(), false);
});

test('a denylist that is not published yet (404) means nobody is revoked — it never runs the grace clock down', async () => {
  const { checkDenylist } = require('../../desktop/licensing/online-denylist.cjs');
  const r = await checkDenylist('https://example.invalid/x.json', 'L-1', { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  assert.deepEqual({ ok: r.ok, revoked: r.revoked }, { ok: true, revoked: false });
  const e = await checkDenylist('https://example.invalid/x.json', 'L-1', { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(e.ok, false);
});

test('Phỏm QA + Aviator Control read the shared meta-game-status repo (own file, not Meta Game Key\'s status.json)', () => {
  const cfg = JSON.parse(require('node:fs').readFileSync(new URL('../../desktop/licensing/online-denylist.config.json', import.meta.url), 'utf8'));
  assert.equal(cfg.url, 'https://raw.githubusercontent.com/thienhaicmu/meta-game-status/main/tool-game-multi-status.json');
  const { TARGET, rawUrl } = require('../../tools/license-generator/online-publish.cjs');
  assert.equal(rawUrl(TARGET), cfg.url); // the generator writes exactly what the apps read
});
