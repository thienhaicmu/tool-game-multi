// PHASE 6.3.1 — flexible N-profile store: create / get / list / update / delete / persist / reload,
// with a STABLE id (unaffected by other profiles' add/remove). OS window ⟂ viewport preserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { PhomDeviceProfilesStore } = require('../../desktop/browser-run/phom-device-profiles-store.cjs');

function tmpFile() { const d = mkdtempSync(join(tmpdir(), 'phq-prof-')); return join(d, 'profiles.json'); }
// A valid explicit device (desktop OS window 960×540, mobile-landscape viewport 851×393).
const DEV = { profileType: 'CUSTOM', osWindowWidth: 960, osWindowHeight: 540, viewportWidth: 851, viewportHeight: 393, screenWidth: 851, screenHeight: 393, deviceScaleFactor: 2, touch: true, orientationType: 'landscapePrimary' };

test('create / get / list — assigns a stable id and exposes the public snapshot', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const r = s.create({ name: 'Laptop Small', device: { ...DEV }, proxyRef: 'px1' });
  assert.equal(r.ok, true);
  const id = r.profile.id;
  assert.ok(id && typeof id === 'string');
  assert.equal(r.profile.name, 'Laptop Small');
  assert.equal(r.profile.proxyRef, 'px1');
  // OS window and viewport are independent + both present
  assert.equal(r.profile.device.osWindowWidth, 960);
  assert.equal(r.profile.device.viewportWidth, 851);
  assert.deepEqual(s.list().map((p) => p.id), [id]);
  assert.equal(s.getPublic(id).name, 'Laptop Small');
  assert.ok(s.deviceFor(id).viewportWidth === 851, 'full device available in main');
});

test('create from a preset id normalizes the device', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const r = s.create({ name: 'Pixel', device: { presetId: 'android-pixel5-landscape' } });
  assert.equal(r.ok, true);
  assert.equal(r.profile.device.profileType, 'MOBILE_LANDSCAPE');
  assert.equal(r.profile.device.viewportWidth, 851);
});

test('update patches name/proxy/device but PRESERVES the id', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const id = s.create({ name: 'A', device: { ...DEV } }).profile.id;
  const u = s.update(id, { name: 'A2', proxyRef: 'px2', device: { ...DEV, osWindowWidth: 1280, osWindowHeight: 720 } });
  assert.equal(u.ok, true);
  assert.equal(u.profile.id, id, 'id stable across edits');
  assert.equal(u.profile.name, 'A2');
  assert.equal(u.profile.proxyRef, 'px2');
  assert.equal(u.profile.device.osWindowWidth, 1280);
  assert.equal(u.profile.device.viewportWidth, 851, 'viewport unchanged by an OS-window edit');
});

test('delete removes only that profile; other ids are unchanged', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const a = s.create({ name: 'A', device: { ...DEV } }).profile.id;
  const b = s.create({ name: 'B', device: { ...DEV } }).profile.id;
  const c = s.create({ name: 'C', device: { ...DEV } }).profile.id;
  assert.equal(s.remove(b).ok, true);
  assert.deepEqual(s.list().map((p) => p.id), [a, c], 'a and c keep their ids');
  assert.equal(s.get(b), null);
  assert.equal(s.remove('nope').ok, false);
});

test('persist + reload — profiles survive a restart', () => {
  const f = tmpFile();
  const s1 = new PhomDeviceProfilesStore({ filePath: f });
  const id = s1.create({ name: 'Keep', device: { ...DEV }, proxyRef: 'pxK' }).profile.id;
  const s2 = new PhomDeviceProfilesStore({ filePath: f }); // fresh instance loads from disk
  const p = s2.getPublic(id);
  assert.ok(p, 'profile reloaded');
  assert.equal(p.name, 'Keep');
  assert.equal(p.proxyRef, 'pxK');
  assert.equal(p.device.osWindowWidth, 960);
  rmSync(join(f, '..'), { recursive: true, force: true });
});

test('setProxyRef binds/clears a proxy on a profile; profilesUsingProxy reports it', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const id = s.create({ name: 'A', device: { ...DEV } }).profile.id;
  assert.equal(s.setProxyRef(id, 'pxZ').ok, true);
  assert.deepEqual(s.profilesUsingProxy('pxZ'), [id]);
  s.setProxyRef(id, null);
  assert.deepEqual(s.profilesUsingProxy('pxZ'), []);
});

test('invalid device is refused typed (no partial write)', () => {
  const s = new PhomDeviceProfilesStore({ filePath: tmpFile() });
  const r = s.create({ name: 'Bad', device: { viewportWidth: 0, viewportHeight: 100, deviceScaleFactor: 2 } });
  assert.equal(r.ok, false);
  assert.match(r.error.code, /PHOM_DEVICE/);
  assert.equal(s.count(), 0);
});

// PHASE 6.3.2-fix — the game URL is remembered per profile (never re-typed each launch) and survives reload.
test('gameUrl is persisted per profile (create + update) and reloads from disk', () => {
  const f = tmpFile();
  let s = new PhomDeviceProfilesStore({ filePath: f });
  const id = s.create({ name: 'HitClub', device: { ...DEV }, gameUrl: 'https://v.hitclub.maison/?a=hitclub' }).profile.id;
  assert.equal(s.getPublic(id).gameUrl, 'https://v.hitclub.maison/?a=hitclub');
  // blank gameUrl on create => null (not stored as empty string)
  const id2 = s.create({ name: 'Blank', device: { ...DEV } }).profile.id;
  assert.equal(s.getPublic(id2).gameUrl, null);
  // update saves a new URL; clearing with '' sets null; unspecified preserves it
  assert.equal(s.update(id2, { gameUrl: '  https://x.example/room  ' }).profile.gameUrl, 'https://x.example/room');
  assert.equal(s.update(id2, { name: 'Renamed' }).profile.gameUrl, 'https://x.example/room', 'gameUrl preserved when not in patch');
  assert.equal(s.update(id2, { gameUrl: '' }).profile.gameUrl, null, 'empty clears the URL');
  // reload from disk keeps the saved URL
  s = new PhomDeviceProfilesStore({ filePath: f });
  assert.equal(s.getPublic(id).gameUrl, 'https://v.hitclub.maison/?a=hitclub');
});
