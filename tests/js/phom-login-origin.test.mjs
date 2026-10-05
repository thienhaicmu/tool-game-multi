// The game keeps its login in localStorage of ONE origin, and the site moves between mirror domains. Found 2026-10-05:
// tokens stored under v.hitclub.guitars while every profile was saved as v.hitclub.tienda → each reopen asked for a
// login. Once an account is logged in, the origin it is on becomes the profile's Game URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
const src = main.slice(main.indexOf('function rememberLoginOrigin('), main.indexOf('function onRunDocumentReplaced('));

function load({ saved = 'https://v.hitclub.tienda/', href = null } = {}) {
  const store = { p: { id: 'prof-1', gameUrl: saved }, updates: [], get(id) { return id === 'prof-1' ? this.p : null; }, update(id, patch) { this.updates.push(patch); Object.assign(this.p, patch); return { ok: true }; } };
  const logs = [];
  const client = { Runtime: { evaluate: async () => ({ result: { value: href } }) } };
  const fn = new Function('deviceProfilesStore', 'headerLog', 'runClientFor', src + '\nreturn rememberLoginOrigin;')(store, (e, d) => logs.push([e, d]), () => client);
  return { fn, store, logs };
}

test('logged in on another mirror → the profile Game URL follows the origin of the login (origin only)', () => {
  const { fn, store, logs } = load();
  const run = { id: 'BR-1', profileId: 'prof-1', lastTopUrl: 'https://v.hitclub.guitars/lobby?x=1#y' };
  fn(run, { loggedIn: true });
  assert.deepEqual(store.updates, [{ gameUrl: 'https://v.hitclub.guitars/' }]);
  assert.equal(logs[0][0], 'GAME_URL_FOLLOWS_LOGIN');
  fn(run, { loggedIn: true });
  assert.equal(store.updates.length, 1, 'once per change, not on every repaint');
});

test('nothing changes before the login, or when the origin is already the saved one', () => {
  const a = load();
  a.fn({ id: 'BR-1', profileId: 'prof-1', lastTopUrl: 'https://v.hitclub.guitars/' }, { loggedIn: false });
  assert.equal(a.store.updates.length, 0, 'not logged in yet');
  const b = load({ saved: 'https://v.hitclub.guitars/' });
  b.fn({ id: 'BR-1', profileId: 'prof-1', lastTopUrl: 'https://v.hitclub.guitars/game' }, { loggedIn: true });
  assert.equal(b.store.updates.length, 0, 'same origin');
});

test('page loaded before the tool attached: it asks the page once, then follows', async () => {
  const { fn, store } = load({ href: 'https://v.hitclub.guitars/' });
  const run = { id: 'BR-1', profileId: 'prof-1' };
  fn(run, { loggedIn: true });
  await new Promise((r) => setImmediate(r));
  assert.equal(run.lastTopUrl, 'https://v.hitclub.guitars/');
  fn(run, { loggedIn: true });
  assert.deepEqual(store.updates, [{ gameUrl: 'https://v.hitclub.guitars/' }]);
});

test('wiring: every header push checks it; a navigation records where the page is', () => {
  assert.match(main, /rememberLoginOrigin\(run, browsers\.find\(/);
  assert.match(main, /if \(run\) run\.lastTopUrl = String\(url\);/);
});
