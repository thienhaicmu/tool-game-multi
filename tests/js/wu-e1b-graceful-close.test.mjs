// WU-E.1B — ChromeLauncher.closeGraceful: graceful path asks Chrome to close (so the
// profile flushes cookies/login), and the FORCED path kills on a bounded timeout so a
// hung graceful close can never leave a phantom Chrome (preserves D2-001).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChromeLauncher } = require('../../desktop/browser/chrome-launcher.cjs');

function fakeProc() {
  const p = new EventEmitter();
  p.killed = false;
  p.kill = () => { p.killed = true; p.emit('exit'); };
  return p;
}

test('closeGraceful requests Browser.close and resolves gracefully (no force kill)', async () => {
  let browserClosed = false, clientClosed = false;
  const cdp = async () => ({ Browser: { close: async () => { browserClosed = true; } }, close: async () => { clientClosed = true; } });
  const l = new ChromeLauncher({ profilePath: 'x', env: {}, cdp });
  const p = fakeProc(); l.process = p; l.port = 1234;
  // Chrome exits promptly in response to Browser.close.
  setTimeout(() => { p.killed = true; p.emit('exit'); }, 50);
  const res = await l.closeGraceful(3000);
  assert.equal(browserClosed, true, 'asked Chrome to close (flush profile)');
  assert.equal(clientClosed, true, 'closed the CDP client');
  assert.equal(res.graceful, true);
  assert.equal(res.forced, false);
  assert.equal(l.process, null);
});

test('closeGraceful FORCE-KILLS on timeout when Chrome will not exit (no phantom)', async () => {
  const cdp = async () => ({ Browser: { close: async () => {} }, close: async () => {} });
  const l = new ChromeLauncher({ profilePath: 'x', env: {}, cdp });
  const p = fakeProc(); l.process = p; l.port = 1234;
  // Chrome ignores Browser.close (never emits exit) -> must be force-killed after timeout.
  const res = await l.closeGraceful(600);
  assert.equal(p.killed, true, 'process force-killed on timeout');
  assert.equal(res.forced, true);
  assert.equal(l.process, null);
});

test('closeGraceful still force-kills when CDP is unreachable', async () => {
  const cdp = async () => { throw new Error('ECONNREFUSED'); };
  const l = new ChromeLauncher({ profilePath: 'x', env: {}, cdp });
  const p = fakeProc(); l.process = p; l.port = 1234;
  const res = await l.closeGraceful(600);
  assert.equal(p.killed, true, 'force-killed when CDP unreachable');
  assert.equal(res.forced, true);
});

test('closeGraceful is a no-op when nothing is running', async () => {
  const l = new ChromeLauncher({ profilePath: 'x', env: {}, cdp: async () => ({}) });
  const res = await l.closeGraceful(600);
  assert.equal(res.ok, true);
  assert.equal(res.graceful, false);
});
