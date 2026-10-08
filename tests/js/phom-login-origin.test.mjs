// The game keeps its login in localStorage of ONE origin, and the site moves between mirror domains. Found 2026-10-05:
// tokens stored under v.hitclub.guitars while every profile was saved as v.hitclub.tienda → each reopen asked for a
// login. Once an account is logged in, the origin it is on becomes the profile's Game URL (feature login-origin).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLoginOriginFeature, originOf } = require('../../desktop/phom/features/login-origin.cjs');
const { createSessionRegistry } = require('../../desktop/phom/core/session-registry.cjs');
const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');

function load({ saved = 'https://v.hitclub.tienda/', href = null } = {}) {
  const names = { set: [] };
  const store = { p: { id: 'prof-1', gameUrl: saved }, updates: [], get(id) { return id === 'prof-1' ? this.p : null; }, update(id, patch) { this.updates.push(patch); Object.assign(this.p, patch); return { ok: true }; }, setAccount(id, name) { names.set.push([id, name]); return true; } };
  const logs = [];
  const client = { Runtime: { evaluate: async () => ({ result: { value: href } }) } };
  const sessions = createSessionRegistry();
  const f = createLoginOriginFeature({ profiles: () => store, clientFor: () => client, log: (e, d) => logs.push([e, d]) });
  const run = { id: 'BR-1', profileId: 'prof-1' };
  const push = (b) => f.push({ run, session: sessions.get('BR-1'), browser: b });
  const nav = (url) => f.documentReplaced({ run, session: sessions.get('BR-1'), url });
  return { f, store, logs, names, push, nav, session: () => sessions.get('BR-1') };
}

test('logged in on another mirror → the profile Game URL follows the origin of the login (origin only)', () => {
  const { store, logs, push, nav } = load();
  nav('https://v.hitclub.guitars/lobby?x=1#y');
  push({ loggedIn: true });
  assert.deepEqual(store.updates, [{ gameUrl: 'https://v.hitclub.guitars/' }]);
  assert.equal(logs[0][0], 'GAME_URL_FOLLOWS_LOGIN');
  push({ loggedIn: true });
  assert.equal(store.updates.length, 1, 'once per change, not on every repaint');
});

test('nothing changes before the login, or when the origin is already the saved one', () => {
  const a = load();
  a.nav('https://v.hitclub.guitars/');
  a.push({ loggedIn: false });
  assert.equal(a.store.updates.length, 0, 'not logged in yet');
  const b = load({ saved: 'https://v.hitclub.guitars/' });
  b.nav('https://v.hitclub.guitars/game');
  b.push({ loggedIn: true });
  assert.equal(b.store.updates.length, 0, 'same origin');
});

test('page loaded before the tool attached: it asks the page once, then follows', async () => {
  const { store, push, session } = load({ href: 'https://v.hitclub.guitars/' });
  push({ loggedIn: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(session().origin.lastTopUrl, 'https://v.hitclub.guitars/');
  push({ loggedIn: true });
  assert.deepEqual(store.updates, [{ gameUrl: 'https://v.hitclub.guitars/' }]);
});

test('about: (the proxy-auth launch page) is not where the game is; originOf keeps http(s) only', () => {
  const { nav, session } = load();
  nav('about:blank');
  assert.equal(session().origin.lastTopUrl, null);
  assert.equal(originOf('https://a.b/x?y'), 'https://a.b/');
  assert.equal(originOf('chrome://newtab'), null);
});

test('the account name playing in a profile is remembered (never USER_UNKNOWN)', () => {
  const { push, names } = load();
  push({ loggedIn: true, username: 'USER_UNKNOWN' });
  push({ loggedIn: true, username: 'acc01' });
  assert.deepEqual(names.set, [['prof-1', 'acc01']]);
});

test('wiring: login-origin is one of main\'s features, writing to the ONE profile store', () => {
  assert.match(main, /createLoginOriginFeature\(\{ profiles: \(\) => deviceProfilesStore, clientFor: runClientFor/);
  assert.match(main, /features\(\)\.documentReplaced\(\{ run: [^}]*session: sessions\.get\(rid\), url: String\(url\) \}\)/);
});
