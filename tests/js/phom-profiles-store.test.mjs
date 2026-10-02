// The N-profile store: create / get / list / update / delete / persist / reload, with a STABLE id
// (unaffected by other profiles' add/remove). A profile holds a name, a browser AGENT, a game URL and
// an optional proxy ref — no device geometry (see phom-browser-agent.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { PhomDeviceProfilesStore } = require('../../desktop/browser-run/phom-device-profiles-store.cjs');

function tmpFile() { const d = mkdtempSync(join(tmpdir(), 'phq-prof-')); return join(d, 'profiles.json'); }

test('create / get / list — assigns a stable id and exposes the public snapshot', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const r = s.create({ name: 'Player 1', agent: 'MOBILE', proxyRef: 'px1' });
  assert.equal(r.ok, true);
  const id = r.profile.id;
  assert.ok(id && typeof id === 'string');
  assert.equal(r.profile.name, 'Player 1');
  assert.equal(r.profile.proxyRef, 'px1');
  assert.equal(r.profile.agent, 'MOBILE');
  assert.deepEqual(s.list().map((p) => p.id), [id]);
  assert.equal(s.getPublic(id).name, 'Player 1');
  assert.equal(s.agentFor(id), 'MOBILE', 'the agent to apply is available in main');
});

test('a profile created without an agent gets the default one', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const r = s.create({ name: 'Default' });
  assert.equal(r.ok, true);
  assert.equal(r.profile.agent, 'WEB');
  assert.equal(r.profile.device.resolution, '600 × 338', 'every profile reports the one default size');
});

test('update patches name/proxy/agent but PRESERVES the id', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const id = s.create({ name: 'A', agent: 'MOBILE' }).profile.id;
  const u = s.update(id, { name: 'A2', proxyRef: 'px2', agent: 'WEB' });
  assert.equal(u.ok, true);
  assert.equal(u.profile.id, id, 'id stable across edits');
  assert.equal(u.profile.name, 'A2');
  assert.equal(u.profile.proxyRef, 'px2');
  assert.equal(u.profile.agent, 'WEB');
  assert.equal(s.update(id, { name: 'A3' }).profile.agent, 'WEB', 'a name edit keeps the agent');
});

test('delete removes only that profile; other ids are unchanged', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const a = s.create({ name: 'A' }).profile.id;
  const b = s.create({ name: 'B' }).profile.id;
  const c = s.create({ name: 'C' }).profile.id;
  assert.equal(s.remove(b).ok, true);
  assert.deepEqual(s.list().map((p) => p.id), [a, c], 'a and c keep their ids');
  assert.equal(s.get(b), null);
  assert.equal(s.remove('nope').ok, false);
});

test('persist + reload — profiles survive a restart', () => {
  const f = tmpFile();
  const s1 = new PhomDeviceProfilesStore({ filePath: f });
  const id = s1.create({ name: 'Keep', agent: 'WEB', proxyRef: 'pxK' }).profile.id;
  const s2 = new PhomDeviceProfilesStore({ filePath: f }); // fresh instance loads from disk
  const p = s2.getPublic(id);
  assert.ok(p, 'profile reloaded');
  assert.equal(p.name, 'Keep');
  assert.equal(p.proxyRef, 'pxK');
  assert.equal(p.agent, 'WEB');
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('setProxyRef binds/clears a proxy on a profile; profilesUsingProxy reports it', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const id = s.create({ name: 'A' }).profile.id;
  assert.equal(s.setProxyRef(id, 'pxZ').ok, true);
  assert.deepEqual(s.profilesUsingProxy('pxZ'), [id]);
  s.setProxyRef(id, null);
  assert.deepEqual(s.profilesUsingProxy('pxZ'), []);
});

test('an unknown agent is refused typed (no partial write)', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const r = s.create({ name: 'Bad', agent: 'tablet' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'PHOM_AGENT_INVALID');
  assert.equal(s.count(), 0);
});

// PHASE 6.3.2-fix — the game URL is remembered per profile (never re-typed each launch) and survives reload.
test('gameUrl is persisted per profile (create + update) and reloads from disk', () => {
  const f = tmpFile();
  let s = new PhomDeviceProfilesStore({ filePath: f });
  const id = s.create({ name: 'HitClub', gameUrl: 'https://v.hitclub.tienda/' }).profile.id;
  assert.equal(s.getPublic(id).gameUrl, 'https://v.hitclub.tienda/');
  // blank gameUrl on create => null (not stored as empty string)
  const id2 = s.create({ name: 'Blank' }).profile.id;
  assert.equal(s.getPublic(id2).gameUrl, null);
  // update saves a new URL; clearing with '' sets null; unspecified preserves it
  assert.equal(s.update(id2, { gameUrl: '  https://x.example/room  ' }).profile.gameUrl, 'https://x.example/room');
  assert.equal(s.update(id2, { name: 'Renamed' }).profile.gameUrl, 'https://x.example/room', 'gameUrl preserved when not in patch');
  assert.equal(s.update(id2, { gameUrl: '' }).profile.gameUrl, null, 'empty clears the URL');
  // reload from disk keeps the saved URL
  s = new PhomDeviceProfilesStore({ filePath: f });
  assert.equal(s.getPublic(id).gameUrl, 'https://v.hitclub.tienda/');
});
