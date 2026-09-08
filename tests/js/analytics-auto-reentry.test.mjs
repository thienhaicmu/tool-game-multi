import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsAviatorEntryGate } = require('../../desktop/analytics/analytics-aviator-entry.cjs');
const { AnalyticsContextRecovery, STATE } = require('../../desktop/analytics/analytics-context-recovery.cjs');

const CFG = { freshMs: 1000, verifyWindowMs: 500, maxReentryAttempts: 3 };
const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ cfg = CFG, timeoutMs = 10, ctx = { targetId: 'T1', cdpSessionId: 'S1', host: 'h' } } = {}) {
  const clock = { t: 10000 };
  const now = () => clock.t;
  const S = { lastAviatorMono: null, lastWsRecvMono: null };
  const ref = { ctx };
  const sent = [];
  const gate = new AnalyticsAviatorEntryGate({
    sendEntry: (c) => { sent.push({ ctx: c, at: clock.t }); return Promise.resolve({ ok: true }); },
    getContext: () => ref.ctx,
    now, timeoutMs,
  });
  const rec = new AnalyticsContextRecovery({ entryGate: gate, config: cfg, now });
  const tickNow = (over = {}) => rec.tick({
    now: clock.t,
    lastAviatorMono: S.lastAviatorMono,
    lastWsRecvMono: S.lastWsRecvMono,
    wcAlive: true, wsConnected: true,
    lastWsRecvFresh: S.lastWsRecvMono != null && (clock.t - S.lastWsRecvMono) <= cfg.freshMs,
    loginRequired: false,
    hasSocket: !!ref.ctx,
    ...over,
  });
  const aviator = (t) => { clock.t = t; S.lastAviatorMono = t; S.lastWsRecvMono = t; gate.onAviatorEvidence(t); };
  const lobby = (t) => { clock.t = t; S.lastWsRecvMono = t; };
  return { clock, now, S, ref, gate, rec, sent, tickNow, aviator, lobby };
}

test('§24 basic: ACTIVE → aviator-silent + lobby chatter → VERIFYING → CONTEXT_LOST → REENTERING (exactly 1 send)', async () => {
  const h = harness();
  h.aviator(10000); assert.equal(h.tickNow().state, STATE.ACTIVE);
  h.lobby(11200); assert.equal(h.tickNow().state, STATE.VERIFYING);
  h.lobby(11600); assert.equal(h.tickNow().state, STATE.REENTERING);
  await flush();
  assert.equal(h.gate.sentCount(), 1, 'exactly one entry request');
  assert.equal(h.sent[0].ctx.targetId, 'T1', 'sent through THIS browser socket ctx');
});

test('§25/§30 SEND != ENTERED: send alone (and a stale frame) never confirms; only fresh server evidence does', async () => {
  const h = harness();
  h.aviator(10000); h.tickNow();
  h.lobby(11600); assert.equal(h.tickNow().state, STATE.REENTERING); // sends at attemptStart=11600
  await flush();
  // Send alone → NOT active.
  assert.notEqual(h.tickNow().state, STATE.ACTIVE);
  // A STALE frame (<= attemptStart) must NOT confirm.
  h.gate.onAviatorEvidence(11590); await flush();
  assert.notEqual(h.tickNow().state, STATE.ACTIVE);
  // FRESH authoritative evidence after the attempt boundary confirms.
  h.aviator(11650); await flush();
  assert.equal(h.tickNow().state, STATE.ACTIVE);
});

test('§26 bounded retry: no confirmation → attempts up to max → RECOVERY_FAILED (send count == max)', async () => {
  const h = harness({ timeoutMs: 8 });
  h.aviator(10000); h.tickNow();
  h.lobby(11600);
  h.tickNow(); await sleep(20);            // attempt 1 → timeout
  h.tickNow(); await sleep(20);            // attempt 2 → timeout
  h.tickNow(); await sleep(20);            // attempt 3 → timeout
  const final = h.tickNow();               // budget exhausted → escalate
  assert.equal(h.gate.sentCount(), 3, 'exactly maxReentryAttempts sends');
  assert.equal(final.state, STATE.RECOVERY_FAILED);
  // No further sends after failure.
  h.tickNow(); await sleep(20); h.tickNow();
  assert.equal(h.gate.sentCount(), 3);
});

test('§27 lobby chatter alone never keeps ACTIVE — it drives to CONTEXT_LOST/re-entry', async () => {
  const h = harness();
  h.aviator(10000); assert.equal(h.tickNow().state, STATE.ACTIVE);
  for (let t = 10400; t <= 12000; t += 400) { h.lobby(t); h.tickNow(); }
  await flush();
  assert.ok(h.gate.sentCount() >= 1, 'continuous lobby traffic must not mask context loss');
});

test('§28 normal between-round gap (< freshMs) → NO re-entry', async () => {
  const h = harness();
  h.aviator(10000); assert.equal(h.tickNow().state, STATE.ACTIVE);
  h.clock.t = 10800; assert.equal(h.tickNow().state, STATE.ACTIVE);   // quiet gap, still fresh
  h.aviator(10900); assert.equal(h.tickNow().state, STATE.ACTIVE);    // next round
  await flush();
  assert.equal(h.gate.sentCount(), 0, 'no false re-entry on a normal round gap');
});

test('§31 login: no send while login wall is up (LOGIN_REQUIRED); auto-retries after login clears', async () => {
  const h = harness();
  h.aviator(10000); h.tickNow();
  h.lobby(11600);
  assert.equal(h.tickNow({ loginRequired: true }).state, STATE.LOGIN_REQUIRED);
  await flush();
  assert.equal(h.gate.sentCount(), 0, 'never spam entry while logged out');
  // Login completes → next silent tick advances to re-entry with NO extra user action.
  h.lobby(11700);
  assert.equal(h.tickNow({ loginRequired: false }).state, STATE.REENTERING);
  await flush();
  assert.equal(h.gate.sentCount(), 1);
});

test('§18 closed browser: dispose during re-entry — a late server frame cannot resurrect recovery', async () => {
  const h = harness();
  h.aviator(10000); h.tickNow();
  h.lobby(11600); assert.equal(h.tickNow().state, STATE.REENTERING);
  await flush();
  h.rec.dispose();
  assert.equal(h.gate.isPending(), false, 'dispose cancels the in-flight attempt');
  const before = h.gate.sentCount();
  h.gate.onAviatorEvidence(99999);         // late frame after close
  await flush();
  assert.equal(h.gate.sentCount(), before, 'no resurrected send');
});

test('§32 multi-browser isolation: B1 loss sends via B1 only; B2 fresh evidence never confirms B1', async () => {
  const b1 = harness({ ctx: { targetId: 'B1', cdpSessionId: 'S1', host: 'h1' } });
  const b2 = harness({ ctx: { targetId: 'B2', cdpSessionId: 'S2', host: 'h2' } });
  b1.aviator(10000); b1.tickNow();
  b2.aviator(10000); b2.tickNow();
  // B1 loses context; B2 stays active.
  b1.lobby(11600); assert.equal(b1.tickNow().state, STATE.REENTERING);
  await flush();
  assert.equal(b1.sent.length, 1);
  assert.equal(b1.sent[0].ctx.targetId, 'B1', 'B1 entry rode B1 socket only');
  assert.equal(b2.gate.sentCount(), 0, 'B2 sent nothing');
  // A fresh B2 Aviator frame must NOT confirm B1's pending entry.
  b2.gate.onAviatorEvidence(11650);
  await flush();
  assert.notEqual(b1.tickNow().state, STATE.ACTIVE, 'B2 evidence cannot confirm B1');
  // B1's OWN fresh evidence confirms B1.
  b1.aviator(11700); await flush();
  assert.equal(b1.tickNow().state, STATE.ACTIVE);
});
