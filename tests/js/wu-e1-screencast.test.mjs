// WU-E.1 — embedded web mirror (CDP screencast + input forwarding) ownership tests.
// The mirror is display+input only; it must be strictly per-run: frames carry the owning
// runId, input reaches ONLY the mirrored run's client, switching stops the previous
// mirror, and a closed run's mirror is torn down. No global "latest" anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PageScreencast } = require('../../desktop/cdp/screencast.cjs');

function fakeClient() {
  const calls = { start: 0, stop: 0, input: [], acks: 0, lastParams: null };
  let frameCb = null;
  return {
    calls,
    Page: {
      enable: async () => {},
      startScreencast: async (p) => { calls.start++; calls.lastParams = p; },
      stopScreencast: async () => { calls.stop++; },
      screencastFrame: (cb) => { frameCb = cb; },
      screencastFrameAck: async () => { calls.acks++; },
    },
    Input: {
      dispatchMouseEvent: async (e) => { calls.input.push(['mouse', e]); },
      dispatchKeyEvent: async (e) => { calls.input.push(['key', e]); },
    },
    _emit: (f) => { if (frameCb) frameCb(f); },
  };
}

test('start mirrors a run and routes frames tagged with its runId (+acks)', async () => {
  const c = fakeClient(); const frames = [];
  const sc = new PageScreencast({ resolvePageClient: (id) => id === 'BR-1' ? { client: c, targetId: 'T1' } : null, onFrame: (f) => frames.push(f) });
  const r = await sc.start('BR-1', { maxWidth: 800, maxHeight: 600 });
  assert.equal(r.ok, true);
  assert.equal(c.calls.start, 1);
  assert.equal(c.calls.lastParams.maxWidth, 800);
  c._emit({ data: 'AAAA', sessionId: 1, metadata: { deviceWidth: 800, deviceHeight: 600 } });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].runId, 'BR-1');
  assert.equal(c.calls.acks, 1, 'frame acked so Chrome keeps streaming');
});

test('input reaches ONLY the active mirrored run (per-run ownership)', async () => {
  const c = fakeClient();
  const sc = new PageScreencast({ resolvePageClient: () => ({ client: c, targetId: 'T1' }) });
  await sc.start('BR-1');
  const ok = await sc.input('BR-1', { kind: 'mouse', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 });
  assert.equal(ok.ok, true);
  const bad = await sc.input('BR-2', { kind: 'mouse', type: 'mousePressed', x: 1, y: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'SCREENCAST_NOT_ACTIVE');
  assert.equal(c.calls.input.length, 1, 'exactly one input dispatched, none for the other run');
});

test('switching mirror stops the previous run; stop() stops screencast', async () => {
  const c1 = fakeClient(), c2 = fakeClient();
  const map = { 'BR-1': { client: c1, targetId: 'T1' }, 'BR-2': { client: c2, targetId: 'T2' } };
  const sc = new PageScreencast({ resolvePageClient: (id) => map[id] });
  await sc.start('BR-1');
  await sc.start('BR-2');
  assert.equal(c1.calls.stop, 1, 'previous mirror stopped on switch');
  assert.equal(sc.activeRunId(), 'BR-2');
  await sc.stop();
  assert.equal(c2.calls.stop, 1);
  assert.equal(sc.activeRunId(), null);
});

test('stale run frames are dropped after a switch (no cross-run paint)', async () => {
  const c1 = fakeClient(), c2 = fakeClient(); const frames = [];
  const map = { 'BR-1': { client: c1, targetId: 'T1' }, 'BR-2': { client: c2, targetId: 'T2' } };
  const sc = new PageScreencast({ resolvePageClient: (id) => map[id], onFrame: (f) => frames.push(f) });
  await sc.start('BR-1');
  await sc.start('BR-2');
  c1._emit({ data: 'X', sessionId: 1, metadata: {} }); // stale (BR-1 no longer active)
  assert.equal(frames.length, 0, 'stale run frame dropped');
  c2._emit({ data: 'Y', sessionId: 1, metadata: {} });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].runId, 'BR-2');
});

test('onRunGone tears down the mirror when the active run closes', async () => {
  const c = fakeClient();
  const sc = new PageScreencast({ resolvePageClient: () => ({ client: c, targetId: 'T' }) });
  await sc.start('BR-1');
  sc.onRunGone('BR-1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sc.activeRunId(), null);
  assert.equal(c.calls.stop, 1);
});

test('start fails cleanly when the run has no page target yet', async () => {
  const sc = new PageScreencast({ resolvePageClient: () => null });
  const r = await sc.start('BR-9');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SCREENCAST_TARGET_UNAVAILABLE');
});

test('main.cjs wires screencast per-run (execRun) and preserves runtime/entitlement gates', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  // display/input IPC bind to an EXPLICIT run (execRun), never a global pointer.
  assert.ok(/handle\('screencast-start'.*execRun\(runId\)/s.test(main), 'screencast-start binds to explicit run');
  assert.ok(/handle\('screencast-input'.*execRun\(runId\)/s.test(main), 'screencast-input binds to explicit run');
  // the mirror never sends protocol; entitlement + worker-send path remain intact.
  assert.ok(/featureDenied\('autoRun'/.test(main), 'autoRun still enforced in main');
  assert.ok(/featureDenied\('jackpotGate'/.test(main), 'jackpotGate still enforced in main');
  assert.ok(/screencast\.onRunGone/.test(main), 'mirror torn down when a run closes');
});
