import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EventEmitter from 'node:events';

const require = createRequire(import.meta.url);
const { AnalyticsRuntime } = require('../../desktop/analytics/analytics-runtime.cjs');
const { CaptureCorrelator } = require('../../desktop/cdp/capture.cjs');
const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');
const { STATE } = require('../../desktop/protocol/aviator-context.cjs');

// ---------------------------------------------------------------------------
// §12 ANALYTICS DEFECT — connection-aware disconnect.
//
// The audited bug: AnalyticsLiveState.onDisconnect() (which nulls _lastAviatorFrameMono)
// was fired whenever ANY WebSocket FINISHED. A real Aviator page keeps several unrelated
// sockets (gemsdatapi / millicast / analytics side-channels) that open & close constantly.
// Any one of those closing wiped Aviator freshness, so a browser genuinely IN the game
// would flip to "context lost" — spurious re-entry and blanked live values.
//
// Fix: only the socket that actually carried Aviator SERVER evidence owns the live Aviator
// context. Its close (matched by exact identity) clears context; unrelated socket churn does not.
// Whole-page loss stays owned by tm.on('target-removed').
// ---------------------------------------------------------------------------

function makeFakeClient() {
  const calls = [];
  const domain = (name) => new Proxy({}, { get(_t, m) { return (arg) => { calls.push(name + '.' + String(m)); if (typeof arg === 'function') return () => {}; return Promise.resolve({}); }; } });
  const client = new Proxy({}, { get(_t, prop) { return domain(String(prop)); } });
  return { client, calls };
}

function makeFakeInapp(clients) {
  return {
    partitionFor: (id) => 'persist:analytics-' + id,
    launcher: (run) => ({ open: async () => ({ ok: true, endpoint: { inapp: true }, profile: 'persist:analytics-' + run.browserId }), close() {} }),
    targetManager: (run) => {
      const em = new EventEmitter();
      const tid = 'INAPP-' + run.id;
      const { client } = makeFakeClient();
      clients.set(run.browserId, { client, tid });
      return {
        on: (...a) => em.on(...a), once: (...a) => em.once(...a),
        async start() { em.emit('attached', { target: { cdpTargetId: tid }, client }); },
        async stop() { em.emit('target-removed', tid); },
        getSession(id) { return String(id) === tid ? { target: { cdpTargetId: tid }, client } : undefined; },
      };
    },
    showOnly() {}, setBounds() {}, webContents() { return null; },
  };
}

async function makeRuntime() {
  const registry = new BrowserRegistry({ entitlement: () => ({ maxBrowsers: null }) });
  registry.load();
  const b1 = registry.create({ name: 'B1', launchUrl: 'https://example.com/a' }).browser;
  const clients = new Map();
  const inapp = makeFakeInapp(clients);
  const capture = new CaptureCorrelator({ resolveClient: () => null });
  const runtime = new AnalyticsRuntime({ registry, inappRuntime: inapp, capture });
  await runtime.open(b1.id);
  const tid = clients.get(b1.id).tid;
  // Stop the time-driven recovery tick so freshness assertions are deterministic (we only exercise
  // the disconnect-routing path here; VERIFYING→LOST timing is covered by the context/reentry suites).
  const run = runtime._runs.get(String(b1.id));
  if (run && run.recoveryTick) { clearInterval(run.recoveryTick); run.recoveryTick = null; }
  return { runtime, capture, tid, b1 };
}

// A WS data frame on a specific socket (identified by cdpRequestId + cdpSessionId).
const wsRecv = (tid, raw, reqId, sessId = 'S1') => ({
  isWebSocket: true, wsDirection: 'recv', targetId: tid, cdpRequestId: reqId, cdpSessionId: sessId, body: { raw },
});
// A WS connection-closed event (no wsDirection, state FINISHED) for a specific socket.
const wsClosed = (tid, reqId, sessId = 'S1') => ({
  isWebSocket: true, targetId: tid, cdpRequestId: reqId, cdpSessionId: sessId, state: 'FINISHED',
});

const AVIATOR = (sid) => `{"cmd":100005,"sid":${sid}}`;

test('T5: an UNRELATED socket closing does NOT clear Aviator freshness (context stays ACTIVE)', async () => {
  const { runtime, capture, tid, b1 } = await makeRuntime();
  // Aviator evidence arrives on the OWNING game socket (reqAviator).
  capture.emit('request', wsRecv(tid, AVIATOR(101), 'reqAviator', 'S1'));
  let s = runtime.liveSummary(b1.id);
  assert.equal(s.aviatorContext, STATE.ACTIVE);
  assert.equal(s.currentSid, 101);

  // A DIFFERENT, unrelated socket (gemsdatapi-style, reqSide) finishes. Must NOT touch Aviator context.
  capture.emit('update', wsClosed(tid, 'reqSide', 'S1'));
  s = runtime.liveSummary(b1.id);
  assert.equal(s.aviatorContext, STATE.ACTIVE, 'unrelated socket churn must not wipe Aviator freshness');
  assert.equal(s.currentSid, 101, 'live SID preserved through unrelated socket close');
  assert.equal(s.wsStatus, 'CONNECTED');
});

test('T5b: MANY unrelated closes never destroy Aviator context detection', async () => {
  const { runtime, capture, tid, b1 } = await makeRuntime();
  capture.emit('request', wsRecv(tid, AVIATOR(7), 'reqAviator', 'S1'));
  for (const req of ['reqA', 'reqB', 'reqC', 'reqD']) capture.emit('update', wsClosed(tid, req, 'S1'));
  const s = runtime.liveSummary(b1.id);
  assert.equal(s.aviatorContext, STATE.ACTIVE);
  assert.equal(s.currentSid, 7);
});

test('disconnect fires ONLY when the OWNING Aviator socket closes (identity match)', async () => {
  const { runtime, capture, tid, b1 } = await makeRuntime();
  capture.emit('request', wsRecv(tid, AVIATOR(55), 'reqAviator', 'S1'));
  assert.equal(runtime.liveSummary(b1.id).currentSid, 55);

  // The actual game socket closes → Aviator context is genuinely gone.
  capture.emit('update', wsClosed(tid, 'reqAviator', 'S1'));
  const s = runtime.liveSummary(b1.id);
  assert.equal(s.wsStatus, 'DISCONNECTED', 'owning-socket close marks the live view disconnected');
  assert.equal(s.currentSid, null, 'owning-socket close clears frozen live values');
  assert.notEqual(s.aviatorContext, STATE.ACTIVE, 'owning-socket close ends Aviator ACTIVE');
});

test('after an unrelated close, fresh Aviator evidence still flows on the SAME owning socket', async () => {
  const { runtime, capture, tid, b1 } = await makeRuntime();
  capture.emit('request', wsRecv(tid, AVIATOR(1), 'reqAviator', 'S1'));
  capture.emit('update', wsClosed(tid, 'reqSide', 'S1'));           // unrelated churn
  capture.emit('request', wsRecv(tid, AVIATOR(2), 'reqAviator', 'S1')); // next round on the live game socket
  const s = runtime.liveSummary(b1.id);
  assert.equal(s.aviatorContext, STATE.ACTIVE);
  assert.equal(s.currentSid, 2, 'collection continues uninterrupted through unrelated socket churn');
});
