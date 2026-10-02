// The browser AGENT — the only rendering choice a Phỏm profile has left (web / mobile), and the ONE
// window size every browser opens at. The device-profile model (viewport/screen/scale/touch/OS-window
// presets) is gone: it was what made the game lag, because every browser rendered the Cocos canvas at
// 2–3× the pixels through Emulation.setDeviceMetricsOverride and synthesised a touch event per mouse
// move. These tests pin that down so it cannot come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ba = require('../../desktop/browser-run/browser-agent.cjs');
const { PhomProfileStore } = require('../../desktop/browser-run/phom-profile-store.cjs');
const { PhomDeviceProfilesStore } = require('../../desktop/browser-run/phom-device-profiles-store.cjs');
const { parseFlexibleProxy, normalizeProxyConfig, publicSnapshot } = require('../../desktop/browser-run/proxy-config.cjs');

// ---- the agent model ----
test('there are exactly two agents, and the default is the mobile one the tool always used', () => {
  assert.deepEqual(ba.AGENTS, ['WEB', 'MOBILE']);
  assert.equal(ba.DEFAULT_AGENT, 'MOBILE');
  assert.equal(ba.normalizeAgent().agent, 'MOBILE');
  assert.equal(ba.normalizeAgent('web').agent, 'WEB');
  assert.equal(ba.normalizeAgent({ agent: 'MOBILE' }).agent, 'MOBILE');
  assert.equal(ba.normalizeAgent('tablet').error.code, 'PHOM_AGENT_INVALID');
});

test('MOBILE applies ONE CDP command (the user agent); WEB applies none', () => {
  const cmds = ba.emulationCommands('MOBILE');
  assert.deepEqual(cmds.map((c) => c.method), ['Emulation.setUserAgentOverride']);
  assert.match(cmds[0].params.userAgent, /Mobile/);
  assert.equal(cmds[0].params.platform, 'Android');
  assert.deepEqual(ba.emulationCommands('WEB'), []);
});

test('NO metrics / touch / scale emulation exists any more (the lag source is gone for good)', () => {
  // Nothing but the user agent is ever applied, by either agent…
  for (const agent of ['WEB', 'MOBILE', null, 'nonsense']) {
    for (const c of ba.emulationCommands(agent)) assert.equal(c.method, 'Emulation.setUserAgentOverride');
  }
  // …and the main process never calls the expensive overrides any more (the game lagged on these).
  const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  for (const forbidden of ['setDeviceMetricsOverride', 'setTouchEmulationEnabled', 'setEmitTouchEventsForMouse']) {
    assert.equal(main.includes(forbidden), false, forbidden + ' must not be applied any more');
  }
  // …and the launcher no longer asks Chromium for touch events either.
  const launcher = readFileSync(new URL('../../desktop/browser/chrome-launcher.cjs', import.meta.url), 'utf8');
  assert.equal(launcher.includes('--touch-events=enabled'), false);
  assert.equal(launcher.includes('mobileTouch'), false);
});

test('the web size IS the window size: one default viewport + the chrome allowance', () => {
  assert.deepEqual({ ...ba.DEFAULT_VIEWPORT }, { width: 600, height: 338 });     // 16:9, what the old default preset used
  const win = ba.defaultWindowSize();
  assert.equal(win.width, ba.DEFAULT_VIEWPORT.width + ba.WINDOW_CHROME.frameWidth);
  assert.equal(win.height, ba.DEFAULT_VIEWPORT.height + ba.WINDOW_CHROME.chromeHeight);
  // three of them fit side by side on one 1920×1080 monitor
  assert.ok(win.width * 3 <= 1920, `3 × ${win.width} must fit in 1920`);
  const snap = ba.publicSnapshot('WEB');
  assert.equal(snap.resolution, '600 × 338');
  assert.equal(snap.userAgent, null);
  assert.equal(ba.publicSnapshot('MOBILE').userAgent, ba.MOBILE_USER_AGENT);
});

// ---- profiles keep only the agent, and a profile saved under the old model still opens ----
test('a profile stores its agent; three slots stay independent', () => {
  const store = new PhomProfileStore({ filePath: null });
  store.upsert('A', { name: 'A', proxyRef: 'px-A', agent: 'MOBILE' });
  store.upsert('B', { name: 'B', proxyRef: 'px-B', agent: 'WEB' });
  assert.equal(store.agentFor('A'), 'MOBILE');
  assert.equal(store.agentFor('B'), 'WEB');
  store.upsert('A', { agent: 'WEB' });
  assert.equal(store.agentFor('A'), 'WEB');
  assert.equal(store.agentFor('B'), 'WEB', 'B was set to WEB itself — not by A');
  assert.equal(store.getPublic('A').name, 'A', 'an agent edit never touches the name');
  assert.equal(store.upsert('A', { agent: 'phone' }).error.code, 'PHOM_AGENT_INVALID');
});

test('a profile saved with the OLD device object is migrated: its UA decides the agent, the rest is dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phom-agent-'));
  const fp = join(dir, 'phom-device-profiles.json');
  // write a legacy file by hand (what the app has on disk from before this change)
  const legacy = {
    version: 1,
    profiles: [
      { id: 'prof-1', name: 'Laptop Small 960×540', gameUrl: 'https://game.example/', proxyRef: null,
        device: { id: 'prof-1', mobile: true, touch: true, deviceScaleFactor: 2.75, viewportWidth: 851, viewportHeight: 393, osWindowWidth: 960, osWindowHeight: 540, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 5) Mobile Safari/537.36' } },
      { id: 'prof-2', name: 'Desktop', gameUrl: null, proxyRef: null,
        device: { id: 'prof-2', mobile: false, touch: false, deviceScaleFactor: 1, viewportWidth: 1920, viewportHeight: 1080, userAgent: '' } },
    ],
  };
  const { writeFileSync } = require('node:fs');
  writeFileSync(fp, JSON.stringify(legacy), 'utf8');
  const store = new PhomDeviceProfilesStore({ filePath: fp });
  assert.equal(store.agentFor('prof-1'), 'MOBILE');
  assert.equal(store.agentFor('prof-2'), 'WEB');
  const pub = store.getPublic('prof-1');
  assert.equal(pub.agent, 'MOBILE');
  assert.equal(pub.gameUrl, 'https://game.example/', 'the saved game URL survives the migration');
  assert.equal(pub.device.resolution, '600 × 338', 'every profile now reports the one default size');
  // an edit rewrites the record with the agent only — no viewport/scale/touch left behind
  store.update('prof-1', { agent: 'WEB' });
  const raw = readFileSync(fp, 'utf8');
  assert.equal(/deviceScaleFactor|viewportWidth|osWindowWidth|"touch"/.test(raw), false, 'the device fields are gone from disk');
  assert.equal(store.agentFor('prof-1'), 'WEB');
});

test('create / update / reload — the profile id (and its Chromium user-data-dir) never changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phom-agent2-'));
  const fp = join(dir, 'profiles.json');
  const s1 = new PhomDeviceProfilesStore({ filePath: fp });
  const made = s1.create({ name: 'P1', agent: 'MOBILE', gameUrl: 'https://g/' });
  assert.equal(made.ok, true);
  const id = made.profile.id;
  assert.equal(made.profile.agent, 'MOBILE');
  s1.update(id, { name: 'P1 renamed' });
  assert.equal(s1.getPublic(id).id, id);
  assert.equal(s1.getPublic(id).agent, 'MOBILE', 'a name edit keeps the agent');
  const s2 = new PhomDeviceProfilesStore({ filePath: fp });
  assert.equal(s2.getPublic(id).name, 'P1 renamed');
  assert.equal(s2.agentFor(id), 'MOBILE');
  assert.equal(/password|token|cookie|secret/i.test(readFileSync(fp, 'utf8')), false);
});

test('slotsUsingProxy guards proxy deletion', () => {
  const store = new PhomProfileStore({ filePath: null });
  store.upsert('A', { proxyRef: 'PX1' });
  store.upsert('B', { proxyRef: 'PX2' });
  assert.deepEqual(store.slotsUsingProxy('PX1'), ['A']);
  assert.deepEqual(store.slotsUsingProxy('PX9'), []);
});

// ---- flexible proxy input parsing (unchanged; kept here with the profile model) ----
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
