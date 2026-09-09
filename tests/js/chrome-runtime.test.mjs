// Real-Chrome transport — ChromeRuntime mirrors the InAppRuntime facade the manager/main use
// (launcher, targetManager, webContents, focus, destroy) but backed by an independent chrome.exe
// + CDP per run. Proves: per-run process/profile/CDP isolation, the CDP-backed WebContents
// adapter (Page.* -> did-navigate/did-finish-load, getURL/reload/loadURL/isDestroyed/focus),
// cross-run event isolation, and the user-close (onRunExit) vs app-close distinction.
// Electron-free / no real Chrome: child_process.spawn and chrome-remote-interface are injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ChromeRuntime } = require('../../desktop/browser/chrome-runtime.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const tmpProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-rt-'));

function makeFakeClient(ws) {
  const c = new EventEmitter();
  c.setMaxListeners(0);
  c.sessionId = ws;
  const rec = { reloads: [], navs: [], brings: 0, enabled: false };
  c.Page = {
    enable: async () => { rec.enabled = true; },
    reload: async (a) => { rec.reloads.push(a || {}); },
    navigate: async (a) => { rec.navs.push(a); },
    bringToFront: async () => { rec.brings++; },
  };
  c.Inspector = { enable: async () => {} };
  c.close = async () => { c.emit('disconnect'); };
  c._rec = rec;
  return c;
}

function makeFakeCdp() {
  const clientsByWs = new Map();
  const targetsByPort = new Map();
  const fn = async (opts) => {
    if (opts && opts.target) {
      let c = clientsByWs.get(opts.target);
      if (!c) { c = makeFakeClient(opts.target); clientsByWs.set(opts.target, c); }
      return c;
    }
    return makeFakeClient('browser'); // Browser.close path
  };
  fn.Version = async () => ({ Browser: 'FakeChrome/1' });
  fn.List = async ({ port }) => (targetsByPort.get(port) || []).map((t) => ({ ...t }));
  fn.setTargets = (port, arr) => targetsByPort.set(port, arr);
  fn.client = (ws) => clientsByWs.get(ws);
  return fn;
}

function makeFakeSpawn() {
  const calls = [];
  const spawn = (exe, args) => {
    const p = new EventEmitter();
    p.pid = 7000 + calls.length;
    p.killed = false;
    p.unref = () => {};
    p.kill = () => { if (p.killed) return; p.killed = true; setImmediate(() => p.emit('exit', 0)); };
    calls.push({ exe, args, proc: p });
    return p;
  };
  spawn.calls = calls;
  return spawn;
}

function makeRuntime(extra = {}) {
  const cdp = makeFakeCdp();
  const spawn = makeFakeSpawn();
  const exits = [];
  const fallback = tmpProfile();
  const rt = new ChromeRuntime({ env: { CHROME_PATH: process.execPath }, chromeProfileFallback: fallback, cdp, spawn, onRunExit: (id) => exits.push(id), ...extra });
  return { rt, cdp, spawn, exits, fallback };
}

// Launch a run through the runtime and attach one page target; returns { wc, client, endpoint }.
async function launchWithPage(rt, cdp, run, url, wsUrl) {
  const launcher = rt.launcher(run);
  const opened = await launcher.open(url);
  assert.equal(opened.ok, true);
  cdp.setTargets(opened.endpoint.port, [{ id: wsUrl, type: 'page', url, title: '', webSocketDebuggerUrl: wsUrl }]);
  const tm = rt.targetManager(run, opened.endpoint);
  await tm.start();
  await tick(); await tick();
  return { launcher, tm, wc: rt.webContents(run.id), client: cdp.client(wsUrl), endpoint: opened.endpoint };
}

test('launcher spawns a real Chrome per run with its own profile; webContents adapter tracks the page', async () => {
  const { rt, cdp } = makeRuntime();
  const profile = tmpProfile();
  try {
    const run = { id: 'BR-0001', browserId: 'B-0001', profileDir: profile };
    const { wc, client } = await launchWithPage(rt, cdp, run, 'https://game/', 'ws://x/TA');
    assert.ok(wc, 'webContents adapter exists');
    assert.equal(wc.isDestroyed(), false, 'page is live once attached');
    assert.equal(wc.getURL(), 'https://game/', 'adapter reflects the attached target URL');
    assert.ok(client, 'a per-target CDP client was created');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test('webContents adapter maps CDP Page.* to Electron-shaped events and drives CDP for reload/loadURL/focus', async () => {
  const { rt, cdp } = makeRuntime();
  const profile = tmpProfile();
  try {
    const run = { id: 'BR-0001', browserId: 'B-0001', profileDir: profile };
    const { wc, client } = await launchWithPage(rt, cdp, run, 'https://game/', 'ws://x/TA');

    let nav = 0, lastNav = null, inPage = 0, loaded = 0, gone = 0;
    wc.on('did-navigate', (_e, u) => { nav++; lastNav = u; });
    wc.on('did-navigate-in-page', () => { inPage++; });
    wc.on('did-finish-load', () => { loaded++; });
    wc.on('render-process-gone', () => { gone++; });

    client.emit('Page.frameNavigated', { frame: { url: 'https://game/lobby' } });
    assert.equal(nav, 1); assert.equal(lastNav, 'https://game/lobby');
    assert.equal(wc.getURL(), 'https://game/lobby', 'getURL follows main-frame navigation');
    // A subframe navigation must NOT be reported as a top-level navigate.
    client.emit('Page.frameNavigated', { frame: { url: 'https://ads/iframe', parentId: 'F2' } });
    assert.equal(nav, 1, 'subframe navigation is ignored');

    client.emit('Page.navigatedWithinDocument', { url: 'https://game/lobby#x' });
    assert.equal(inPage, 1);
    client.emit('Page.loadEventFired', {});
    assert.equal(loaded, 1);

    wc.reload();
    await tick();
    assert.equal(client._rec.reloads.length, 1, 'reload() calls CDP Page.reload on the run\'s page');
    wc.loadURL('https://game/reenter');
    await tick();
    assert.equal(client._rec.navs[0].url, 'https://game/reenter', 'loadURL() calls CDP Page.navigate');

    assert.equal(rt.focus('BR-0001'), true);
    await tick();
    assert.equal(client._rec.brings, 1, 'focus() calls CDP Page.bringToFront');

    // Page/tab closes -> adapter reports destroyed (recovery sees the renderer as down).
    client.emit('Page.loadEventFired'); // still alive
    client.emit('disconnect');
    await tick();
    assert.equal(wc.isDestroyed(), true, 'page gone -> isDestroyed()');
  } finally { fs.rmSync(profile, { recursive: true, force: true }); }
});

test('two runs are isolated: separate profiles, separate CDP clients, no cross-run events', async () => {
  const { rt, cdp, spawn } = makeRuntime();
  const pA = tmpProfile(), pB = tmpProfile();
  try {
    const runA = { id: 'BR-0001', browserId: 'B-0001', profileDir: pA };
    const runB = { id: 'BR-0002', browserId: 'B-0002', profileDir: pB };
    const A = await launchWithPage(rt, cdp, runA, 'https://a/', 'ws://a/TA');
    const B = await launchWithPage(rt, cdp, runB, 'https://b/', 'ws://b/TB');

    assert.notEqual(rt.webContents('BR-0001'), rt.webContents('BR-0002'), 'separate adapters');
    assert.notEqual(A.client, B.client, 'separate per-target CDP clients');
    assert.notEqual(A.endpoint.port, B.endpoint.port, 'separate CDP endpoints');
    assert.notEqual(spawn.calls[0].args.find((x) => x.startsWith('--user-data-dir')), spawn.calls[1].args.find((x) => x.startsWith('--user-data-dir')), 'separate profiles');

    let aNav = 0, bNav = 0;
    A.wc.on('did-navigate', () => aNav++);
    B.wc.on('did-navigate', () => bNav++);
    // An event on B's client must reach ONLY B.
    B.client.emit('Page.frameNavigated', { frame: { url: 'https://b/round' } });
    assert.equal(bNav, 1); assert.equal(aNav, 0, 'B\'s navigation never touches A');
    assert.equal(A.wc.getURL(), 'https://a/', 'A\'s URL is unchanged by B');
    // Destroying B leaves A live.
    B.client.emit('disconnect');
    await tick();
    assert.equal(B.wc.isDestroyed(), true);
    assert.equal(A.wc.isDestroyed(), false, 'closing B does not affect A');
  } finally { fs.rmSync(pA, { recursive: true, force: true }); fs.rmSync(pB, { recursive: true, force: true }); }
});

test('onRunExit fires only for a user-initiated Chrome close, not an app-initiated close', async () => {
  const { rt, cdp, spawn, exits } = makeRuntime();
  const pA = tmpProfile(), pB = tmpProfile();
  try {
    // User closes the Chrome window: the process exits without the app asking.
    const runA = { id: 'BR-0001', browserId: 'B-0001', profileDir: pA };
    const la = rt.launcher(runA);
    await la.open('https://a/');
    spawn.calls[0].proc.emit('exit', 0);
    await tick();
    assert.deepEqual(exits, ['BR-0001'], 'user close triggers the safe-stop teardown for that run');

    // App-initiated close (BrowserRunManager.closeRun -> launcher.close) must NOT re-enter teardown.
    const runB = { id: 'BR-0002', browserId: 'B-0002', profileDir: pB };
    const lb = rt.launcher(runB);
    await lb.open('https://b/');
    lb.close(); // sets _closing before the process exits
    await tick();
    assert.deepEqual(exits, ['BR-0001'], 'app-initiated close does not fire onRunExit');
  } finally { fs.rmSync(pA, { recursive: true, force: true }); fs.rmSync(pB, { recursive: true, force: true }); }
});

test('a run with no persistent browserId still gets an isolated per-run profile (fallback)', async () => {
  const { rt, spawn, fallback } = makeRuntime();
  try {
    const run = { id: 'BR-0009', browserId: null, profileDir: null };
    const l = rt.launcher(run);
    const r = await l.open('https://debug/');
    assert.equal(r.ok, true);
    const udd = spawn.calls[0].args.find((x) => x.startsWith('--user-data-dir=')).split('=')[1];
    assert.ok(udd.includes('BR-0009'), 'fallback profile is namespaced by runId (no shared user-data-dir)');
    assert.ok(udd.startsWith(fallback), 'fallback profile lives under the instance chrome-profile root');
  } finally { fs.rmSync(fallback, { recursive: true, force: true }); }
});
