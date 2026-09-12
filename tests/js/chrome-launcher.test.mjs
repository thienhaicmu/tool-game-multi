// Real-Chrome transport — ChromeLauncher owns exactly one chrome.exe per run with its OWN
// persistent profile dir, its OWN unique CDP port and a 720x405 DEFAULT opening window.
// Electron-free / no real Chrome: child_process.spawn and chrome-remote-interface are injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ChromeLauncher, DEFAULT_WINDOW } = require('../../desktop/browser/chrome-launcher.cjs');

// A fake spawn that records launches and yields a controllable fake child process.
function makeFakeSpawn() {
  const calls = [];
  const spawn = (exe, args, opts) => {
    const p = new EventEmitter();
    p.pid = 4000 + calls.length;
    p.killed = false;
    p.unref = () => {};
    p.kill = () => { if (p.killed) return; p.killed = true; setImmediate(() => p.emit('exit', 0)); };
    calls.push({ exe, args, opts, proc: p });
    return p;
  };
  spawn.calls = calls;
  return spawn;
}

// A fake chrome-remote-interface used only by closeGraceful (Browser.close).
function makeFakeCdp() {
  const client = new EventEmitter();
  client.Browser = { close: async () => { client._closed = true; } };
  client.close = async () => {};
  const cdp = async () => client;
  cdp._client = client;
  return cdp;
}

function tmpProfile() { return fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-run-')); }
const envWithChrome = () => ({ CHROME_PATH: process.execPath }); // an existing exe, deterministic

function argValue(args, flag) {
  const a = args.find((x) => x.startsWith(flag + '='));
  return a ? a.slice(flag.length + 1) : null;
}

test('open() launches chrome with the run\'s OWN profile dir, a unique port and 720x405 default window', async () => {
  const profile = tmpProfile();
  try {
    const spawn = makeFakeSpawn();
    const l = new ChromeLauncher({ profilePath: profile, env: envWithChrome(), spawn, cdp: makeFakeCdp() });
    const res = await l.open('https://game.example/');
    assert.equal(res.ok, true);
    assert.equal(res.reused, false);
    assert.equal(res.profile, profile);
    assert.equal(res.endpoint.host, '127.0.0.1');
    assert.ok(Number.isInteger(res.endpoint.port) && res.endpoint.port > 0, 'a real free port was allocated');
    assert.equal(res.pid, spawn.calls[0].proc.pid);

    const { args } = spawn.calls[0];
    assert.equal(argValue(args, '--user-data-dir'), profile, 'launches with THIS run\'s profile dir');
    assert.equal(argValue(args, '--remote-debugging-port'), String(res.endpoint.port), 'uses the run\'s own CDP port');
    assert.equal(argValue(args, '--window-size'), `${DEFAULT_WINDOW.width},${DEFAULT_WINDOW.height}`, 'default opening size 720x405');
    assert.equal(argValue(args, '--window-size'), '720,405');
    assert.equal(args[args.length - 1], 'https://game.example/', 'opens the configured URL');
    // Never lock the window: no kiosk/app/fixed-size flags that would prevent resize.
    assert.ok(!args.some((a) => /--kiosk|--app=|--force-device-scale/.test(a)), 'no window-locking flags');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test('two runs get independent profiles and independent ports (no shared user-data-dir / port)', async () => {
  const pA = tmpProfile(), pB = tmpProfile();
  try {
    const spawn = makeFakeSpawn();
    const a = new ChromeLauncher({ profilePath: pA, env: envWithChrome(), spawn, cdp: makeFakeCdp() });
    const b = new ChromeLauncher({ profilePath: pB, env: envWithChrome(), spawn, cdp: makeFakeCdp() });
    const ra = await a.open('https://a/');
    const rb = await b.open('https://b/');
    assert.notEqual(ra.profile, rb.profile, 'separate profile dirs');
    assert.notEqual(argValue(spawn.calls[0].args, '--user-data-dir'), argValue(spawn.calls[1].args, '--user-data-dir'));
    assert.notEqual(ra.pid, rb.pid, 'separate processes');
    // Each launcher owns its own port field; a run never reuses another run's port object.
    assert.ok(ra.endpoint.port > 0 && rb.endpoint.port > 0);
    assert.equal(a.snapshot().chromeProfile, pA);
    assert.equal(b.snapshot().chromeProfile, pB);
    assert.equal(a.snapshot().chromePid, ra.pid);
  } finally { fs.rmSync(pA, { recursive: true, force: true }); fs.rmSync(pB, { recursive: true, force: true }); }
});

test('a second open() on a live process is a reuse (focus), never a duplicate launch', async () => {
  const profile = tmpProfile();
  try {
    const spawn = makeFakeSpawn();
    const l = new ChromeLauncher({ profilePath: profile, env: envWithChrome(), spawn, cdp: makeFakeCdp() });
    await l.open('https://game/');
    const again = await l.open('https://game/');
    assert.equal(again.reused, true, 'reused the live Chrome');
    assert.equal(spawn.calls.length, 1, 'no second chrome.exe spawned');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test('a run with no profile dir fails closed (CHROME_PROFILE_MISSING) and never spawns', async () => {
  const spawn = makeFakeSpawn();
  const noProfile = new ChromeLauncher({ profilePath: null, env: envWithChrome(), spawn });
  const r = await noProfile.open('https://x/');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CHROME_PROFILE_MISSING');
  assert.equal(spawn.calls.length, 0, 'no chrome.exe spawned without a profile');
});

test('close() kills the owned process; closeGraceful() asks Chrome to close then resolves', async () => {
  const profile = tmpProfile();
  try {
    const spawn = makeFakeSpawn();
    const cdp = makeFakeCdp();
    const l = new ChromeLauncher({ profilePath: profile, env: envWithChrome(), spawn, cdp });
    await l.open('https://game/');
    const proc = spawn.calls[0].proc;
    l.close();
    assert.equal(proc.killed, true, 'the owned Chrome process is terminated');

    // Fresh launch for graceful-close.
    const l2 = new ChromeLauncher({ profilePath: profile, env: envWithChrome(), spawn, cdp });
    await l2.open('https://game/');
    const proc2 = spawn.calls[1].proc;
    // Simulate Chrome exiting shortly after Browser.close.
    setImmediate(() => proc2.emit('exit', 0));
    const g = await l2.closeGraceful(1500);
    assert.equal(g.ok, true);
    assert.equal(g.graceful, true, 'exited before the force-kill timeout');
    assert.equal(cdp._client._closed, true, 'requested a graceful Browser.close over CDP');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

// --- Chromium sandbox policy (SECURITY) --------------------------------------
// The sandbox is ON by default for EVERYONE. The copied-runtime "Access denied 0x5"
// is fixed by an AppContainer ACL grant on the runtime (ensureSandboxAccess), NOT by
// --no-sandbox. --no-sandbox appears ONLY when the caller passes sandboxDisabled:true
// (the fully-gated dev diagnostic path). Nobody gets it by default.
test('sandbox is ON by default for custom Chromium AND system Chrome (no --no-sandbox)', async () => {
  const profile = tmpProfile();
  try {
    const spawnCustom = makeFakeSpawn();
    const custom = new ChromeLauncher({ profilePath: profile, env: {}, spawn: spawnCustom, cdp: makeFakeCdp(), chromeExecutable: process.execPath });
    await custom.open('about:blank');
    assert.equal(spawnCustom.calls[0].exe, process.execPath, 'used the pinned custom executable');
    assert.ok(!spawnCustom.calls[0].args.includes('--no-sandbox'), 'custom Chromium keeps its sandbox by default');

    const spawnSystem = makeFakeSpawn();
    const system = new ChromeLauncher({ profilePath: profile, env: envWithChrome(), spawn: spawnSystem, cdp: makeFakeCdp() });
    await system.open('about:blank');
    assert.ok(!spawnSystem.calls[0].args.includes('--no-sandbox'), 'system Chrome keeps its sandbox by default');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test('--no-sandbox appears ONLY when sandboxDisabled is explicitly set (dev diagnostic)', async () => {
  const profile = tmpProfile();
  try {
    const spawn = makeFakeSpawn();
    const l = new ChromeLauncher({ profilePath: profile, env: {}, spawn, cdp: makeFakeCdp(), chromeExecutable: process.execPath, sandboxDisabled: true });
    await l.open('about:blank');
    assert.ok(spawn.calls[0].args.includes('--no-sandbox'), 'the explicit dev diagnostic bypass adds --no-sandbox');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

// §11 loopback-only CDP + PHOM mobile/tiling opening args are opt-in and correct.
test('CDP debugging binds loopback only; mobile-touch and 2x2 window-position are opt-in', async () => {
  const profile = tmpProfile();
  try {
    const spawn = makeFakeSpawn();
    const l = new ChromeLauncher({ profilePath: profile, env: envWithChrome(), spawn, cdp: makeFakeCdp(), mobileTouch: true, windowPosition: { x: 964, y: 0 } });
    await l.open('about:blank');
    const { args } = spawn.calls[0];
    assert.ok(args.includes('--remote-debugging-address=127.0.0.1'), 'debugging port is bound to loopback, never 0.0.0.0');
    assert.ok(args.includes('--touch-events=enabled'), 'mobile-touch opt-in adds browser-level touch events');
    assert.equal(argValue(args, '--window-position'), '964,0', 'window-position tiles the opening window');

    // Off by default: a plain launcher adds none of these.
    const spawn2 = makeFakeSpawn();
    const plain = new ChromeLauncher({ profilePath: profile, env: envWithChrome(), spawn: spawn2, cdp: makeFakeCdp() });
    await plain.open('about:blank');
    assert.ok(!spawn2.calls[0].args.some((a) => /--touch-events|--window-position/.test(a)), 'no mobile/tiling flags unless requested');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});
