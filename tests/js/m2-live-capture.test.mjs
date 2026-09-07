import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import EventEmitter from 'node:events';

const require = createRequire(import.meta.url);
const { AnalyticsLiveState } = require('../../desktop/analytics/live-state.cjs');
const { AnalyticsRuntime } = require('../../desktop/analytics/analytics-runtime.cjs');
const { CaptureCorrelator } = require('../../desktop/cdp/capture.cjs');
const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');

// ---- fakes (Electron / CDP free) ----
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
      const { client, calls } = makeFakeClient();
      clients.set(run.browserId, { client, calls, tid });
      return {
        on: (...a) => em.on(...a), once: (...a) => em.once(...a),
        async start() { em.emit('target-added', { cdpTargetId: tid }); em.emit('attached', { target: { cdpTargetId: tid }, client }); },
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
  const b2 = registry.create({ name: 'B2', launchUrl: 'https://example.com/b' }).browser;
  const clients = new Map();
  const inapp = makeFakeInapp(clients);
  const capture = new CaptureCorrelator({ resolveClient: () => null });
  const runtime = new AnalyticsRuntime({ registry, inappRuntime: inapp, capture });
  await runtime.open(b1.id);
  await runtime.open(b2.id);
  return { runtime, capture, clients, b1, b2 };
}

function wsFrame(targetId, direction, raw) { return { isWebSocket: true, wsDirection: direction, targetId, body: { raw } }; }

// ---------------- LiveState unit (passive classification) ----------------
test('LiveState: RECV ROUND_OPEN sets SID; ODD sets odd; jackpot verbatim', () => {
  const ls = new AnalyticsLiveState({ browserId: 'B-0001' });
  assert.equal(ls.currentSid(), null); assert.equal(ls.currentOdd(), null); assert.equal(ls.currentJackpot(), null);
  ls.observeFrame({ direction: 'recv', raw: '{"cmd":100005,"sid":777}' });
  assert.equal(ls.currentSid(), 777);
  ls.observeFrame({ direction: 'recv', raw: '{"cmd":100009,"odd":2.5,"eI":{"jp":5000}}' });
  assert.equal(ls.currentOdd(), 2.5);
  assert.equal(ls.currentJackpot(), 5000);
});

test('LiveState: website SEND frame is recorded as direction=SEND/origin=WEBSITE and never mutates round truth', () => {
  const ls = new AnalyticsLiveState({ browserId: 'B-0001' });
  ls.observeFrame({ direction: 'recv', raw: '{"cmd":100005,"sid":42}' });
  const ev = ls.observeFrame({ direction: 'send', raw: '{"cmd":100005,"sid":99999}' }); // website-sent, bogus sid
  assert.equal(ev.direction, 'SEND');
  assert.equal(ev.origin, 'WEBSITE');
  assert.equal(ls.currentSid(), 42, 'SEND must not overwrite recv-authoritative sid');
});

test('LiveState: send-frame jackpot is ignored (recv-only authority)', () => {
  const ls = new AnalyticsLiveState({ browserId: 'B-0001' });
  ls.observeFrame({ direction: 'send', raw: '{"cmd":100009,"eI":{"jp":123}}' });
  assert.equal(ls.currentJackpot(), null);
});

test('LiveState: missing SID/ODD/jackpot stay null (never synthesised); unknown retained', () => {
  const ls = new AnalyticsLiveState({ browserId: 'B-0001' });
  const ev = ls.observeFrame({ direction: 'recv', raw: '{"cmd":424242}' });
  assert.equal(ev.sid, null); assert.equal(ev.odd, null); assert.equal(ev.jackpot, null);
  assert.equal(ev.cmd, 424242); assert.equal(ev.type, 'UNKNOWN'); assert.equal(ev.known, false);
});

test('LiveState: event buffer is bounded', () => {
  const ls = new AnalyticsLiveState({ browserId: 'B-0001', maxEvents: 10 });
  for (let i = 0; i < 50; i++) ls.observeFrame({ direction: 'recv', raw: '{"cmd":100009,"odd":1}' });
  assert.equal(ls.recentEvents().length, 10);
});

test('LiveState exposes no send/action API', () => {
  const ls = new AnalyticsLiveState({ browserId: 'B-0001' });
  for (const m of ['send', 'sendRaw', 'sendProtocol', 'bet', 'cashout', 'enter', 'replay']) {
    assert.equal(typeof ls[m], 'undefined', `LiveState must not expose ${m}`);
  }
});

// ---------------- Runtime routing (multi-browser) ----------------
test('Runtime: RECV frame routes to the OWNING browser only', async () => {
  const { runtime, capture, clients, b1, b2 } = await makeRuntime();
  capture.emit('request', wsFrame(clients.get(b1.id).tid, 'recv', '{"cmd":100005,"sid":111}'));
  assert.equal(runtime.liveSummary(b1.id).currentSid, 111);
  assert.equal(runtime.liveSummary(b2.id).currentSid, null, 'B2 must be unaffected by B1 traffic');
});

test('Runtime: B2 SEND does not update B1; B1 RECV does not update B2', async () => {
  const { runtime, capture, clients, b1, b2 } = await makeRuntime();
  capture.emit('request', wsFrame(clients.get(b2.id).tid, 'send', '{"cmd":100000}'));
  capture.emit('request', wsFrame(clients.get(b1.id).tid, 'recv', '{"cmd":100005,"sid":5}'));
  assert.equal(runtime.liveSummary(b1.id).currentSid, 5);
  assert.equal(runtime.liveSummary(b2.id).currentSid, null);
  // B2 recorded exactly one SEND evidence event; B1 recorded one RECV
  const b2ev = runtime.liveSummary(b2.id).events;
  assert.equal(b2ev.length, 1); assert.equal(b2ev[0].direction, 'SEND'); assert.equal(b2ev[0].origin, 'WEBSITE');
});

test('Runtime: observed website SEND triggers ZERO outgoing CDP action', async () => {
  const { capture, clients, b1 } = await makeRuntime();
  const c = clients.get(b1.id);
  capture.emit('request', wsFrame(c.tid, 'send', '{"cmd":100000}'));
  capture.emit('request', wsFrame(c.tid, 'send', '{"cmd":100002,"b":500}'));
  // Runtime.evaluate is the only way a frame could be injected/replayed; it must never be called.
  assert.ok(!c.calls.includes('Runtime.evaluate'), 'no Runtime.evaluate (no send/replay) allowed');
  assert.ok(!c.calls.some((x) => /Page\.addScriptToEvaluateOnNewDocument/.test(x)), 'no WS send-hook injection');
});

test('Runtime: UI selection does not retarget capture ownership', async () => {
  const { runtime, capture, clients, b1, b2 } = await makeRuntime();
  runtime.select(b2.id); // select B2 in the UI
  capture.emit('request', wsFrame(clients.get(b1.id).tid, 'recv', '{"cmd":100005,"sid":888}'));
  assert.equal(runtime.liveSummary(b1.id).currentSid, 888, 'frame still routes to its OWNER, not the selected browser');
  assert.equal(runtime.liveSummary(b2.id).currentSid, null);
});

test('Runtime exposes no protocol-send API (passive boundary)', async () => {
  const { runtime } = await makeRuntime();
  for (const m of ['send', 'sendRaw', 'sendProtocol', 'bet', 'cashout', 'enterGame', 'replay', 'autotestStart']) {
    assert.equal(typeof runtime[m], 'undefined', `Runtime must not expose ${m}`);
  }
});

test('Runtime: closing B1 invalidates only its own live truth', async () => {
  const { runtime, capture, clients, b1, b2 } = await makeRuntime();
  capture.emit('request', wsFrame(clients.get(b1.id).tid, 'recv', '{"cmd":100005,"sid":1}'));
  capture.emit('request', wsFrame(clients.get(b2.id).tid, 'recv', '{"cmd":100005,"sid":2}'));
  await runtime.close(b1.id); // tears down B1 target
  assert.equal(runtime.liveSummary(b1.id).open, false);
  assert.equal(runtime.liveSummary(b2.id).currentSid, 2, 'closing B1 must not touch B2');
});
