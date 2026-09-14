import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ChromeLauncher, classifyGoneExit, EXIT_REASONS } = require('../../desktop/browser/chrome-launcher.cjs');

// A minimal fake chrome.exe child: pid + stderr stream + exit/kill, no real process.
function fakeChild(pid = 4242) {
  const stderr = new EventEmitter(); stderr.unref = () => {};
  const c = new EventEmitter();
  c.pid = pid; c.stderr = stderr; c.killed = false;
  c.unref = () => {}; c.kill = () => { c.killed = true; };
  return c;
}

// Open a launcher over the fake child + injected probe. Records every fired onExit.
async function openLauncher({ probe, child, instanceId, livenessWatchMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-lnch-'));
  const ch = child || fakeChild();
  const fired = [];
  const l = new ChromeLauncher({
    profilePath: dir,
    chromeExecutable: process.execPath,   // any readable file so open() proceeds
    spawn: () => ch,
    probeCdp: probe || (async () => ({ alive: false })),
    onExit: (rec) => fired.push(rec),
    now: (() => { let t = 1000; return () => (t += 50); })(),
    instanceId: instanceId || 'LNCH-test',
    livenessWatchMs,                       // 0 ⇒ no background poll (tests drive exits directly)
  });
  l.port = 55555;                          // skip real free-port allocation
  const r = await l.open('about:blank');
  return { l, ch, fired, r, dir };
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

// The bug: the spawned process is a BOOTSTRAP that hands off to a replacement main and
// exits ~immediately. If CDP still answers, the browser is ALIVE — keep the run open.
test('TRACKED_PID_REPLACED: bootstrap exits but CDP still answers ⇒ run stays alive, no onExit', async () => {
  const { l, fired, dir } = await openLauncher({ probe: async () => ({ alive: true, pid: 9001 }) });
  assert.equal(l.alive(), true);
  const rec = await l._onChildExit(0, null);   // bootstrap pid exits cleanly
  assert.equal(rec.reason, EXIT_REASONS.TRACKED_PID_REPLACED);
  assert.equal(rec.fired, false);
  assert.equal(fired.length, 0, 'a live browser must NEVER fire onExit (no spurious close)');
  assert.equal(l.alive(), true, 'run stays OPEN across the bootstrap PID swap');
  // PID replacement is tracked: snapshot now reports the replacement main pid, not null.
  const snap = l.snapshot();
  assert.equal(snap.alive, true);
  assert.equal(snap.chromePid, 9001);
  assert.equal(snap.bootstrapPid, 4242, 'the original bootstrap pid is preserved for evidence');
  cleanup(dir);
});

// After a swap, the browser lives on a process we no longer own — a later real close is
// caught by the CDP liveness poll (flips alive→false and fires onExit exactly once).
test('TRACKED_PID_REPLACED then a later real close is detected by the liveness watcher', async () => {
  let alive = true;
  const { l, fired, dir } = await openLauncher({ probe: async () => ({ alive, pid: 9001 }), livenessWatchMs: 15 });
  l.markCdpUp();
  await l._onChildExit(0, null);                 // bootstrap swap — stays open, watcher armed
  assert.equal(l.alive(), true);
  assert.equal(fired.length, 0);
  await delay(30);                               // let one poll run (still alive)
  assert.equal(l.alive(), true, 'still alive while CDP answers');
  alive = false;                                 // the replacement browser is now closed
  await delay(40);                               // next poll observes it gone
  assert.equal(l.alive(), false);
  assert.equal(fired.length, 1, 'the real close fires onExit exactly once');
  assert.equal(fired[0].reason, EXIT_REASONS.USER_CLOSED_WINDOW);
  assert.equal(fired[0].viaWatcher, true);
  cleanup(dir);
});

test('USER_CLOSED_WINDOW: browser was fully up, then a clean exit with CDP gone', async () => {
  const { l, fired, dir } = await openLauncher({ probe: async () => ({ alive: false }) });
  l.markCdpUp();                                // browser fully came up (target attached)
  const rec = await l._onChildExit(0, null);    // clean exit, CDP no longer answers
  assert.equal(rec.reason, EXIT_REASONS.USER_CLOSED_WINDOW);
  assert.equal(fired.length, 1);
  assert.equal(l.alive(), false);
  assert.equal(l.snapshot().chromePid, null);
  cleanup(dir);
});

test('CHROMIUM_CRASH: a non-zero exit code or a signal is a crash, never CLOSED_BY_USER', async () => {
  for (const [code, signal] of [[1, null], [null, 'SIGSEGV'], [139, null]]) {
    const { l, fired, dir } = await openLauncher({ probe: async () => ({ alive: false }) });
    l.markCdpUp();
    const rec = await l._onChildExit(code, signal);
    assert.equal(rec.reason, EXIT_REASONS.CHROMIUM_CRASH, `code=${code} signal=${signal}`);
    assert.notEqual(rec.reason, EXIT_REASONS.USER_CLOSED_WINDOW);
    assert.equal(fired.length, 1);
    cleanup(dir);
  }
});

test('PROFILE_LOCK: a user-data-dir SingletonLock hand-off is its own reason', async () => {
  const { l, ch, fired, dir } = await openLauncher({ probe: async () => ({ alive: false }) });
  ch.stderr.emit('data', Buffer.from('[ERROR] ProcessSingleton: The profile appears to be in use by SingletonLock'));
  const rec = await l._onChildExit(0, null);
  assert.equal(rec.reason, EXIT_REASONS.PROFILE_LOCK);
  assert.equal(fired.length, 1);
  cleanup(dir);
});

test('UNKNOWN_EXIT: exited 0 having NEVER become a browser is ambiguous — NOT a user close', async () => {
  const { l, fired, dir } = await openLauncher({ probe: async () => ({ alive: false }) });
  // never markCdpUp — the browser never came up
  const rec = await l._onChildExit(0, null);
  assert.equal(rec.reason, EXIT_REASONS.UNKNOWN_EXIT);
  assert.notEqual(rec.reason, EXIT_REASONS.USER_CLOSED_WINDOW);
  assert.equal(fired.length, 1);
  cleanup(dir);
});

test('APP_REQUESTED_CLOSE: our own close() is authoritative — no probe, no onExit cascade', async () => {
  let probed = 0;
  const { l, fired, dir } = await openLauncher({ probe: async () => { probed++; return { alive: false }; } });
  l.close();                                    // app-initiated
  const rec = await l._onChildExit(null, 'SIGTERM');
  assert.equal(rec.reason, EXIT_REASONS.APP_REQUESTED_CLOSE);
  assert.equal(rec.fired, false);
  assert.equal(fired.length, 0, 'app-initiated close must not cascade onExit');
  assert.equal(probed, 0, 'no CDP probe needed when we asked for the close');
  cleanup(dir);
});

// §B — a single A about:blank survives the integration sequence (spawn + CDP connect +
// device + listeners + navigation). At the launcher layer, "survive" = alive stays true
// with no onExit, because NONE of those integrations touch the process.
test('single A survives the spawn→CDP→device→listeners→navigation sequence (no close)', async () => {
  const { l, fired, dir } = await openLauncher({ probe: async () => ({ alive: true }) });
  assert.equal(l.alive(), true);              // 1. spawn
  l.markCdpUp();                              // 2. CDP connect
  assert.equal(l.alive(), true);              // 3-5. device/listeners/navigation never close the process
  assert.equal(fired.length, 0);
  assert.equal(l.snapshot().alive, true);
  cleanup(dir);
});

// §B/§G — A's exit does not close B/C. Two INDEPENDENT launchers: a genuine gone-exit on
// A fires onExit for A only; B is never touched.
test('A exit does not affect B (independent launchers)', async () => {
  const A = await openLauncher({ probe: async () => ({ alive: false }), instanceId: 'A' });
  const B = await openLauncher({ probe: async () => ({ alive: true }), instanceId: 'B' });
  A.l.markCdpUp();
  await A.l._onChildExit(0, null);            // A genuinely gone
  assert.equal(A.fired.length, 1);
  assert.equal(A.l.alive(), false);
  assert.equal(B.fired.length, 0, 'B receives no exit');
  assert.equal(B.l.alive(), true, 'B stays open');
  cleanup(A.dir); cleanup(B.dir);
});

test('stderr tail is redacted before it is stored on the exit record', async () => {
  const { l, ch, dir } = await openLauncher({ probe: async () => ({ alive: false }) });
  ch.stderr.emit('data', Buffer.from('connecting to socks5://user:s3cr3t@host:1080 password=hunter2'));
  const rec = await l._onChildExit(1, null);
  assert.equal(/s3cr3t|hunter2/.test(rec.stderrTail), false, 'no secrets survive in the tail');
  assert.match(rec.stderrTail, /<redacted>/);
  cleanup(dir);
});

// Pure classifier unit coverage (no process).
test('classifyGoneExit is honest about each signal', () => {
  assert.equal(classifyGoneExit({ code: 0, signal: null, cdpEverUp: true }), EXIT_REASONS.USER_CLOSED_WINDOW);
  assert.equal(classifyGoneExit({ code: 0, signal: null, cdpEverUp: false }), EXIT_REASONS.UNKNOWN_EXIT);
  assert.equal(classifyGoneExit({ code: 1, signal: null, cdpEverUp: true }), EXIT_REASONS.CHROMIUM_CRASH);
  assert.equal(classifyGoneExit({ code: null, signal: 'SIGKILL', cdpEverUp: true }), EXIT_REASONS.CHROMIUM_CRASH);
  assert.equal(classifyGoneExit({ code: 0, signal: null, cdpEverUp: false, stderr: 'SingletonLock' }), EXIT_REASONS.PROFILE_LOCK);
});
