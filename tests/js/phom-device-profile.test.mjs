import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dp = require('../../desktop/browser-run/device-profile.cjs');
const { PhomProfileStore } = require('../../desktop/browser-run/phom-profile-store.cjs');
const { parseFlexibleProxy, normalizeProxyConfig, publicSnapshot } = require('../../desktop/browser-run/proxy-config.cjs');

// ---- device profile: presets + landscape invariant ----
test('mobile presets are landscape (width > height) and mobile/touch', () => {
  const presets = dp.listPresets();
  assert.ok(presets.length >= 3);
  for (const p of presets) {
    assert.ok(p.viewportWidth > p.viewportHeight, `${p.id} must be landscape`);
    assert.equal(p.mobile, true);
    assert.equal(p.touch, true);
    assert.match(p.userAgent, /Mobile/);
  }
});

test('normalizeDeviceProfile from a preset produces a stable landscape device', () => {
  const r = dp.normalizeDeviceProfile({ presetId: 'android-pixel5-landscape', name: 'Device A' });
  assert.equal(r.ok, true);
  assert.equal(r.device.name, 'Device A');
  assert.ok(r.device.viewportWidth > r.device.viewportHeight);
  assert.equal(r.device.orientationType, 'landscapePrimary');
  assert.equal(r.device.orientationAngle, 90);
  assert.equal(r.device.mobile, true);
  assert.equal(r.device.touch, true);
});

test('portrait / bad geometry is rejected typed (landscape invariant)', () => {
  assert.equal(dp.normalizeDeviceProfile({ viewportWidth: 390, viewportHeight: 844, deviceScaleFactor: 3 }).error.code, 'PHOM_DEVICE_NOT_LANDSCAPE');
  assert.equal(dp.normalizeDeviceProfile({ viewportWidth: 0, viewportHeight: 10, deviceScaleFactor: 2 }).error.code, 'PHOM_DEVICE_INVALID');
  assert.equal(dp.normalizeDeviceProfile({ presetId: 'nope' }).error.code, 'PHOM_DEVICE_PRESET_NOT_FOUND');
});

test('toCdpEmulation maps to Emulation.* params incl. screen orientation + touch + UA', () => {
  const { device } = dp.normalizeDeviceProfile({ presetId: 'android-galaxy-s20-landscape' });
  const cdp = dp.toCdpEmulation(device);
  assert.equal(cdp.deviceMetrics.mobile, true);
  assert.equal(cdp.deviceMetrics.width, device.viewportWidth);
  assert.equal(cdp.deviceMetrics.screenOrientation.type, 'landscapePrimary');
  assert.equal(cdp.deviceMetrics.screenOrientation.angle, 90);
  assert.equal(cdp.touch.enabled, true);
  assert.ok(cdp.touch.maxTouchPoints >= 1);
  assert.equal(cdp.emitTouchForMouse.enabled, true);
  assert.match(cdp.userAgent.userAgent, /Mobile/);
});

test('emulationCommands is an ordered CDP sequence (metrics->touch->mouse->UA)', () => {
  const { device } = dp.normalizeDeviceProfile({ presetId: 'android-pixel5-landscape' });
  const cmds = dp.emulationCommands(device);
  assert.deepEqual(cmds.map((c) => c.method), [
    'Emulation.setDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled',
    'Emulation.setEmitTouchEventsForMouse', 'Emulation.setUserAgentOverride',
  ]);
  // applying against a mock CDP client proves it drives Emulation.* (device metrics),
  // NOT a native window resize.
  const calls = [];
  const client = { Emulation: {} };
  for (const c of cmds) client.Emulation[c.method.split('.')[1]] = async (p) => { calls.push([c.method, p]); };
  return Promise.all(cmds.map((c) => client.Emulation[c.method.split('.')[1]](c.params))).then(() => {
    const metrics = calls.find((x) => x[0] === 'Emulation.setDeviceMetricsOverride')[1];
    assert.equal(metrics.mobile, true);
    assert.ok(metrics.width > metrics.height);
    assert.equal(metrics.screenOrientation.type, 'landscapePrimary');
    assert.equal(calls.find((x) => x[0] === 'Emulation.setTouchEmulationEnabled')[1].enabled, true);
  });
});

// ---- three independent profiles, no cross-mutation ----
test('three slots hold independent devices; editing A never mutates B/C', () => {
  const store = new PhomProfileStore({ filePath: null });
  store.upsert('A', { name: 'A', proxyRef: 'px-A', device: { presetId: 'android-pixel5-landscape' } });
  store.upsert('B', { name: 'B', proxyRef: 'px-B', device: { presetId: 'android-galaxy-s20-landscape' } });
  store.upsert('C', { name: 'C', proxyRef: 'px-C', device: { presetId: 'android-generic-412-landscape' } });
  const a1 = store.getPublic('A'), b1 = store.getPublic('B');
  assert.notEqual(a1.device.id, b1.device.id);
  assert.notEqual(a1.proxyRef, b1.proxyRef);
  // edit A's device -> B unchanged
  store.upsert('A', { device: { presetId: 'android-generic-412-landscape', regenerate: true } });
  assert.equal(store.getPublic('B').device.id, b1.device.id);
  assert.notEqual(store.getPublic('A').device.id, a1.device.id); // regenerate => new id
});

// ---- stable identity + persistence across restart ----
test('device identity is stable across a reload (persisted, not re-randomized)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phom-prof-'));
  const fp = join(dir, 'phom-profiles.json');
  const s1 = new PhomProfileStore({ filePath: fp });
  s1.upsert('A', { name: 'A', proxyRef: 'px-A', device: { presetId: 'android-pixel5-landscape' } });
  const idA = s1.getPublic('A').device.id;
  // editing the name must NOT change the device id
  s1.upsert('A', { name: 'A renamed' });
  assert.equal(s1.getPublic('A').device.id, idA);
  // fresh instance (restart) restores the same device id
  const s2 = new PhomProfileStore({ filePath: fp });
  assert.equal(s2.getPublic('A').device.id, idA);
  assert.equal(s2.getPublic('A').name, 'A renamed');
  // no secrets persisted
  const raw = readFileSync(fp, 'utf8');
  assert.equal(/password|token|cookie|secret/i.test(raw), false);
});

test('slotsUsingProxy guards proxy deletion', () => {
  const store = new PhomProfileStore({ filePath: null });
  store.upsert('A', { proxyRef: 'PX1', device: { presetId: 'android-pixel5-landscape' } });
  store.upsert('B', { proxyRef: 'PX2', device: { presetId: 'android-pixel5-landscape' } });
  assert.deepEqual(store.slotsUsingProxy('PX1'), ['A']);
  assert.deepEqual(store.slotsUsingProxy('PX9'), []);
});

// ---- flexible proxy input parsing ----
test('parseFlexibleProxy handles the four convenience formats', () => {
  assert.deepEqual(parseFlexibleProxy('1.2.3.4:8080').parts, { protocol: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' });
  assert.deepEqual(parseFlexibleProxy('1.2.3.4:8080:user:pass').parts, { protocol: 'http', host: '1.2.3.4', port: 8080, username: 'user', password: 'pass' });
  assert.equal(parseFlexibleProxy('socks5://h:1080').parts.protocol, 'socks5');
  const withCreds = parseFlexibleProxy('http://user:pass@h:3128').parts;
  assert.equal(withCreds.username, 'user'); assert.equal(withCreds.password, 'pass');
});

test('normalizeProxyConfig(input:raw) separates password + never persists it raw', () => {
  const r = normalizeProxyConfig({ id: 'PXZ', input: '10.0.0.1:1080:bob:s3cr3t', protocol: 'socks5' });
  assert.equal(r.ok, true);
  assert.equal(r.secret, 's3cr3t');
  assert.equal(r.config.username, 'bob');
  const snap = JSON.stringify(publicSnapshot(r.config));
  assert.equal(/s3cr3t/.test(snap), false);
});
