import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { ProtocolHarness, hostAllowed, verdictFor } = require('../../desktop/protocol/harness.cjs');

// Build a harness whose target resolves to `host`, with an observed live socket.
function setup({ host = 'localhost', allowlist, ackTimeoutMs = 200, sends = [] } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 5000 });
  const harness = new ProtocolHarness({
    roundTracker: tracker,
    allowlist,
    ackTimeoutMs,
    getTargetUrl: () => `https://${host}/game`,
    send: async (ctx, payload) => { sends.push({ ctx, payload }); return { ok: true }; },
  });
  return { tracker, harness, sends };
}
// Open a round and register the game socket for target T.
function openRound(tracker, sid, targetId = 'T') {
  tracker.observe({ targetId, cdpSessionId: 'S', url: 'wss://game.host/ws', direction: 'recv', raw: `{"cmd":100005,"sid":${sid}}` });
}

// ---------------------------------------------------------------------------
// §3 — environment allowlist gate.
// ---------------------------------------------------------------------------
test('hostAllowed: exact, *.suffix and keyword patterns', () => {
  assert.equal(hostAllowed('localhost', ['localhost']), true);
  assert.equal(hostAllowed('app.staging.acme.io', ['*.staging.acme.io']), true);
  assert.equal(hostAllowed('qa-3.internal', ['qa']), true);       // keyword substring
  assert.equal(hostAllowed('prod.acme.io', ['*.staging.acme.io']), false);
  assert.equal(hostAllowed('production.acme.io', ['localhost', '127.0.0.1']), false);
});

test('environmentFor gates on host; non-allowlisted -> CONTROL_DISABLED', () => {
  const { harness } = setup({ host: 'production.game.com', allowlist: ['localhost', 'staging'] });
  const env = harness.environmentFor('T');
  assert.equal(env.allowed, false);
  assert.equal(env.label, 'CONTROL_DISABLED_FOR_TARGET');
});

test('execute on a non-allowlisted target refuses to send', async () => {
  const { harness, sends } = setup({ host: 'production.game.com', allowlist: ['localhost'] });
  const ex = await harness.execute({ targetId: 'T', command: 'bet' });
  assert.equal(ex.result, 'ERROR');
  assert.equal(ex.error.code, 'CONTROL_DISABLED_FOR_TARGET');
  assert.equal(sends.length, 0, 'nothing sent to a disallowed target');
});

// ---------------------------------------------------------------------------
// §6 / §26 — templates seeded with the CURRENT server sid; cashout has no odd.
// ---------------------------------------------------------------------------
test('bet template uses current server sid', () => {
  const { tracker, harness } = setup();
  openRound(tracker, 2986908);
  assert.deepEqual(harness.buildTemplate('bet'), { cmd: 100002, b: 5000, sid: 2986908, aid: 1, eid: 1 });
});

test('cashout template uses current sid and adds NO odd field', () => {
  const { tracker, harness } = setup();
  openRound(tracker, 2986908);
  const t = harness.buildTemplate('cashout');
  assert.deepEqual(t, { cmd: 100003, sid: 2986908, aid: 1, eid: 1 });
  assert.ok(!('odd' in t), 'cashout request must not contain odd');
});

// ---------------------------------------------------------------------------
// §7 — never send from a guessed sid without an explicit negative flag.
// ---------------------------------------------------------------------------
test('checkSid flags a stale draft against the current round', () => {
  const { tracker, harness } = setup();
  openRound(tracker, 2986908);
  assert.equal(harness.checkSid(2986908).match, true);
  const stale = harness.checkSid(2986907);
  assert.equal(stale.match, false);
  assert.equal(stale.warning, 'STALE_OR_MANUAL_SID');
});

test('positive send with stale sid is refused (STALE_OR_MANUAL_SID)', async () => {
  const { tracker, harness, sends } = setup();
  openRound(tracker, 2986908);
  const ex = await harness.execute({ targetId: 'T', payload: { cmd: 100002, b: 5000, sid: 2986907, aid: 1, eid: 1 } });
  assert.equal(ex.error.code, 'STALE_OR_MANUAL_SID');
  assert.equal(sends.length, 0);
});

// ---------------------------------------------------------------------------
// §10 / §11 — safe send seam; no observed socket -> TEST_SESSION_UNAVAILABLE.
// ---------------------------------------------------------------------------
test('valid current-round bet is sent and ACK-correlated', async () => {
  const { tracker, harness, sends } = setup();
  openRound(tracker, 2986908);
  const p = harness.execute({ targetId: 'T', command: 'bet' });
  // Server acks the bet (same cmd + eid) shortly after.
  setTimeout(() => tracker.observe({ direction: 'recv', raw: '{"eid":1,"b":5000,"cmd":100002}' }), 20);
  const ex = await p;
  assert.equal(sends.length, 1);
  const wire = JSON.parse(sends[0].payload);
  assert.deepEqual(wire.slice(0, 3), ['6', 'MiniGame', 'aviatorPlugin']);
  assert.equal(wire[3].sid, 2986908);
  assert.equal(ex.result, 'ACK');
  assert.equal(ex.responsePayload.b, 5000);
});

test('cashout is sent through the MiniGame aviatorPlugin envelope', async () => {
  const { tracker, harness, sends } = setup();
  openRound(tracker, 2986908);
  const p = harness.execute({ targetId: 'T', command: 'cashout' });
  setTimeout(() => tracker.observe({ direction: 'recv', raw: '[5,{"eid":1,"wm":7750,"cmd":100003,"aid":1,"odd":1.55}]' }), 20);
  const ex = await p;
  assert.equal(ex.result, 'ACK');
  const wire = JSON.parse(sends[0].payload);
  assert.deepEqual(wire.slice(0, 3), ['6', 'MiniGame', 'aviatorPlugin']);
  assert.deepEqual(wire[3], { cmd: 100003, sid: 2986908, aid: 1, eid: 1 });
});

test('no observed game socket -> TEST_SESSION_UNAVAILABLE', async () => {
  const { harness } = setup();
  // Round known but no socket context for this target (no frames observed on it).
  harness._round.observe({ direction: 'recv', raw: '{"cmd":100005,"sid":10}' }); // no targetId
  const ex = await harness.execute({ targetId: 'T', payload: { cmd: 100002, b: 1, sid: 10, aid: 1, eid: 1 } });
  assert.equal(ex.result, 'ERROR');
  assert.equal(ex.error.code, 'TEST_SESSION_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// §20 — verdicts from evidence.
// ---------------------------------------------------------------------------
test('verdictFor: reject expectation', () => {
  assert.equal(verdictFor('reject', 'REJECTED'), 'PASS');
  assert.equal(verdictFor('reject', 'ACK'), 'FAIL');
  assert.equal(verdictFor('reject', 'TIMEOUT'), 'INCONCLUSIVE');
});

test('negative stale-sid test: server ACK -> FAIL, timeout -> INCONCLUSIVE', async () => {
  // ACK case: server wrongly accepts the stale round -> FAIL.
  {
    const { tracker, harness } = setup();
    openRound(tracker, 2986908);
    const p = harness.execute({ targetId: 'T', negative: true, expect: 'reject', payload: { cmd: 100002, b: 5000, sid: 2986907, aid: 1, eid: 1 } });
    setTimeout(() => tracker.observe({ direction: 'recv', raw: '{"eid":1,"b":5000,"cmd":100002}' }), 20);
    const ex = await p;
    assert.equal(ex.result, 'ACK');
    assert.equal(ex.verdict, 'FAIL');
    assert.ok(ex.warnings.some((w) => w.code === 'STALE_OR_MANUAL_SID'));
  }
  // Timeout case: no correlated response -> INCONCLUSIVE.
  {
    const { tracker, harness } = setup({ ackTimeoutMs: 60 });
    openRound(tracker, 2986908);
    const ex = await harness.execute({ targetId: 'T', negative: true, expect: 'reject', payload: { cmd: 100002, b: 5000, sid: 2986907, aid: 1, eid: 1 } });
    assert.equal(ex.result, 'TIMEOUT');
    assert.equal(ex.verdict, 'INCONCLUSIVE');
  }
});

test('rejection frame -> REJECTED -> PASS for a negative test', async () => {
  const { tracker, harness } = setup();
  openRound(tracker, 2986908);
  const p = harness.execute({ targetId: 'T', negative: true, expect: 'reject', payload: { cmd: 100002, b: -1, sid: 2986908, aid: 1, eid: 1 } });
  setTimeout(() => tracker.observe({ direction: 'recv', raw: '{"cmd":100002,"eid":1,"err":"invalid_amount"}' }), 20);
  const ex = await p;
  assert.equal(ex.result, 'REJECTED');
  assert.equal(ex.verdict, 'PASS');
});

// ---------------------------------------------------------------------------
// §13 — executions are append-only evidence.
// ---------------------------------------------------------------------------
test('executions are appended and never rewritten', async () => {
  const { tracker, harness, sends } = setup({ ackTimeoutMs: 40 });
  openRound(tracker, 2986908);
  await harness.execute({ targetId: 'T', command: 'bet' });
  await harness.execute({ targetId: 'T', command: 'cashout' });
  const all = harness.executions();
  assert.equal(all.length, 2);
  assert.equal(all[0].command, 100002);
  assert.equal(all[1].command, 100003);
  assert.ok(sends.length >= 2);
});

test('invalid payload -> INVALID_TEST_REQUEST', async () => {
  const { tracker, harness } = setup();
  openRound(tracker, 10);
  const ex = await harness.execute({ targetId: 'T', payload: 'not json' });
  assert.equal(ex.error.code, 'INVALID_TEST_REQUEST');
});
