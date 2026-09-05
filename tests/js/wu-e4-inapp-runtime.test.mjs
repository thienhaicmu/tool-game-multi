// WU-E.4 — in-app runtime: the webContents.debugger-backed CRI-compatible client shim
// (commands + event subscriptions), deterministic per-B partition mapping, and main wiring
// (in-app default, view IPC, quit teardown). Electron-free via a fake debugger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeDebuggerClient, InAppRuntime } = require('../../desktop/browser/inapp-runtime.cjs');

function fakeWc() {
  const dbg = new EventEmitter();
  dbg._attached = false; dbg._cmds = [];
  dbg.isAttached = () => dbg._attached;
  dbg.attach = () => { dbg._attached = true; };
  dbg.detach = () => { dbg._attached = false; dbg.emit('detach'); };
  dbg.sendCommand = (method, params, sessionId) => { dbg._cmds.push({ method, params, sessionId }); return Promise.resolve({ ok: true, method }); };
  const wc = new EventEmitter(); wc.debugger = dbg; wc.isDestroyed = () => false; wc.getURL = () => 'http://x/';
  return wc;
}

test('debugger client: command methods route to sendCommand with sessionId', async () => {
  const wc = fakeWc(); const c = makeDebuggerClient(wc);
  assert.equal(wc.debugger.isAttached(), true, 'attached on create');
  await c.Network.enable();
  await c.Runtime.evaluate({ expression: 'x' }, 'sess-9');
  assert.deepEqual(wc.debugger._cmds[0], { method: 'Network.enable', params: {}, sessionId: undefined });
  assert.deepEqual(wc.debugger._cmds[1], { method: 'Runtime.evaluate', params: { expression: 'x' }, sessionId: 'sess-9' });
});

test('debugger client: event subscription delivers (params, sessionId) and can unsubscribe', () => {
  const wc = fakeWc(); const c = makeDebuggerClient(wc);
  const got = [];
  const off = c.Network.webSocketFrameSent((p, sid) => got.push([p, sid]));
  wc.debugger.emit('message', {}, 'Network.webSocketFrameSent', { requestId: 'r1' }, 'worker-1');
  wc.debugger.emit('message', {}, 'Network.webSocketFrameReceived', { requestId: 'r2' }, 'worker-1'); // not subscribed
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], [{ requestId: 'r1' }, 'worker-1']);
  off();
  wc.debugger.emit('message', {}, 'Network.webSocketFrameSent', { requestId: 'r3' }, 'worker-1');
  assert.equal(got.length, 1, 'no delivery after unsubscribe');
});

test('debugger client: close detaches; disconnect fires', async () => {
  const wc = fakeWc(); const c = makeDebuggerClient(wc);
  let disc = 0; c.on('disconnect', () => disc++);
  await c.close();
  assert.equal(wc.debugger.isAttached(), false);
  wc.debugger.emit('detach'); // client already off message, but emitter still wired for disconnect
  assert.ok(disc >= 1);
});

test('InAppRuntime: deterministic per-B partition mapping', () => {
  const rt = new InAppRuntime({ getHostWindow: () => null });
  assert.equal(rt.partitionFor('B-0001'), 'persist:aviator-B-0001');
  assert.equal(rt.partitionFor('B-0002'), 'persist:aviator-B-0002');
  assert.notEqual(rt.partitionFor('B-0001'), rt.partitionFor('B-0002'));
  // same B-id -> same partition (restart mapping is deterministic)
  assert.equal(rt.partitionFor('B-0001'), new InAppRuntime({ getHostWindow: () => null }).partitionFor('B-0001'));
});

test('main.cjs uses the in-app runtime as the ONLY browser runtime and tears it down on quit', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(/createLauncher: \(run\) => inappRuntime\.launcher\(run\)/.test(main), 'launcher is the in-app runtime (unconditional)');
  assert.ok(/createTargetManager: \(_endpoint, run\) => inappRuntime\.targetManager\(run\)/.test(main), 'targetManager is the in-app runtime (unconditional)');
  assert.ok(/handle\('inapp-view'/.test(main), 'in-app view bounds/visibility IPC exists');
  assert.ok(/inappRuntime\.destroyAll\(\)/.test(main), 'in-app views destroyed on quit');
  // No legacy external-Chrome runtime, flag, or screencast remains.
  assert.ok(!/USE_INAPP_RUNTIME|OBSERVATORY_LEGACY_CHROME|ChromeLauncher|PageScreencast/.test(main), 'no legacy runtime/flag/screencast');
});
