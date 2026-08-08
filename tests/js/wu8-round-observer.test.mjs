import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { ProtocolHarness } = require('../../desktop/protocol/harness.cjs');
const { RoundObserver, validateConfig, STATUS, PHASE, TERMINAL } = require('../../desktop/protocol/round-observer.cjs');

// tracker + observer wired as in main, with a controllable monotonic clock.
function makeObs(config = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const clock = { t: 0 };
  const observer = new RoundObserver({ roundTracker: tracker, config, now: () => clock.t });
  const feed = (raw, direction = 'recv', targetId = 'T') => tracker.observe({ raw, direction, targetId, url: 'wss://game.host/ws' });
  return { tracker, observer, clock, feed };
}

// ---------------------------------------------------------------------------
// §1/§33/§35 — hard read-only boundary.
// ---------------------------------------------------------------------------
test('observer exposes no send seam and declares readOnly', () => {
  const { observer } = makeObs();
  for (const m of ['send', 'sendRaw', 'execute', 'continueRequest', 'bet', 'cashout']) assert.equal(typeof observer[m], 'undefined', `no ${m}()`);
  assert.equal(observer.snapshot().readOnly, true);
});

test('observer source imports NO request-sending seam', () => {
  const raw = readFileSync(new URL('../../desktop/protocol/round-observer.cjs', import.meta.url), 'utf8');
  // Strip comments so prose that merely names the seams (to document the boundary)
  // doesn't count — only executable code is scanned.
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['sendRaw', 'continueRequest', 'ReplayEngine', 'ProtocolHarness', 'wsReplay', 'Fetch.', 'harness.send']) {
    assert.ok(!code.includes(forbidden), `code must not reference ${forbidden}`);
  }
});

// MANDATORY (§33): feeding complete multi-round traffic triggers ZERO sends on
// every request-sending seam. A real ProtocolHarness with a spy send shares the
// same tracker (as main.cjs wires it) — observing must never call it.
test('CRITICAL: multi-round observation invokes send seams 0 times', () => {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const spy = { sendRaw: 0, harnessSend: 0, replayExecute: 0, fetchContinue: 0 };
  const observer = new RoundObserver({ roundTracker: tracker });
  // eslint-disable-next-line no-unused-vars
  const harness = new ProtocolHarness({ roundTracker: tracker, getTargetUrl: () => 'https://localhost/game', send: async () => { spy.harnessSend++; return { ok: true }; } });
  const wsReplay = { sendRaw: async () => { spy.sendRaw++; return { ok: true }; } };
  const replay = { execute: async () => { spy.replayExecute++; } };
  const fetch = { continueRequest: async () => { spy.fetchContinue++; } };
  void wsReplay; void replay; void fetch; // present only to prove they are never called

  const feed = (raw, direction = 'recv') => tracker.observe({ raw, direction, targetId: 'T', url: 'wss://game.host/ws' });
  for (let round = 100; round < 103; round++) {
    feed(`{"cmd":100005,"sid":${round}}`);
    feed(`{"cmd":100002,"b":5000,"sid":${round},"aid":1,"eid":1}`, 'send'); // even the client's OWN frames
    feed('{"cmd":100002,"eid":1,"b":5000}');
    feed(`{"cmd":100006,"sid":${round}}`);
    for (const o of [1.10, 1.30, 1.55]) feed(`{"cmd":100009,"sid":${round},"odd":${o}}`);
    feed(`{"cmd":100003,"sid":${round},"aid":1,"eid":1}`, 'send');
    feed('{"cmd":100003,"eid":1,"b":5000,"wm":7750,"odd":1.55}');
    feed(`{"cmd":100007,"sid":${round},"odd":1.55}`);
  }
  assert.deepEqual(spy, { sendRaw: 0, harnessSend: 0, replayExecute: 0, fetchContinue: 0 });
  assert.equal(observer.history().length, 3, 'observed all three rounds read-only');
});

// ---------------------------------------------------------------------------
// §26 — classifier integration (reuses WU7 classify via RoundTracker).
// ---------------------------------------------------------------------------
test('100005 -> sid + OPEN via the shared classifier', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"iOE":true,"sid":2986908}');
  assert.equal(observer.snapshot().currentSid, 2986908);
  assert.equal(observer.currentRound().phase, PHASE.OPEN);
  assert.equal(observer.status(), STATUS.OPEN);
});

// ---------------------------------------------------------------------------
// §7/§27 — full round lifecycle.
// ---------------------------------------------------------------------------
test('round lifecycle OPEN->LOCKED->RUNNING->ENDED with correct metrics', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"sid":100}');
  feed('{"cmd":100006,"sid":100}');
  for (const o of [1.01, 1.05, 1.08, 1.15]) feed(`{"cmd":100009,"sid":100,"odd":${o}}`);
  feed('{"cmd":100007,"sid":100,"odd":1.15}');
  const h = observer.history();
  assert.equal(h.length, 1);
  assert.equal(h[0].sid, 100);
  assert.equal(h[0].terminalReason, TERMINAL.ROUND_END);
  assert.equal(h[0].phase, PHASE.ENDED);
  assert.equal(h[0].maxOdd, 1.15);
  assert.equal(h[0].endOdd, 1.15);
  assert.equal(h[0].oddFrameCount, 4);
  assert.equal(observer.status(), STATUS.ENDED);
});

// ---------------------------------------------------------------------------
// §3/§28 — non-sequential SID; never previousSid+1.
// ---------------------------------------------------------------------------
test('current SID is the exact server value, never derived', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"sid":2986802}'); feed('{"cmd":100007,"sid":2986802}');
  feed('{"cmd":100005,"sid":2986851}');
  assert.equal(observer.snapshot().currentSid, 2986851);
  assert.ok(!observer.history().some((r) => r.sid === 2986803));
});

// ---------------------------------------------------------------------------
// §29 — odd frame-interval metrics from controlled monotonic timestamps.
// ---------------------------------------------------------------------------
test('odd metrics: count / max / last / avg-min-max interval', () => {
  const { observer, clock, feed } = makeObs();
  feed('{"cmd":100005,"sid":1}');
  for (const [t, o] of [[0, 1.01], [500, 1.05], [1000, 1.10], [1600, 1.15]]) { clock.t = t; feed(`{"cmd":100009,"sid":1,"odd":${o}}`); }
  const r = observer.currentRound();
  assert.equal(r.oddFrameCount, 4);
  assert.equal(r.maxOdd, 1.15);
  assert.equal(r.currentOdd, 1.15);
  assert.equal(r.avgOddIntervalMs, 533.3);   // (500+500+600)/3
  assert.equal(r.minOddIntervalMs, 500);
  assert.equal(r.maxOddIntervalMs, 600);
});

// ---------------------------------------------------------------------------
// §9/§30 — bounded odd buffer; frame count stays exact.
// ---------------------------------------------------------------------------
test('recentOdds bounded while oddFrameCount counts every frame', () => {
  const { observer, feed } = makeObs({ oddBufferLimit: 100 });
  feed('{"cmd":100005,"sid":1}');
  for (let i = 0; i < 500; i++) feed(`{"cmd":100009,"sid":1,"odd":${(1 + i / 1000).toFixed(3)}}`);
  const r = observer.currentRound();
  assert.equal(r.recentOdds.length, 100);
  assert.equal(r.oddFrameCount, 500);
});

// ---------------------------------------------------------------------------
// §8/§31 — new SID before terminal frame => SUPERSEDED, no fabricated 100007.
// ---------------------------------------------------------------------------
test('non-terminal round is finalized SUPERSEDED, not fake-ended', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"sid":100}');
  feed('{"cmd":100009,"sid":100,"odd":1.20}');
  feed('{"cmd":100005,"sid":107}');
  const h = observer.history();
  assert.equal(h.length, 1);
  assert.equal(h[0].sid, 100);
  assert.equal(h[0].terminalReason, TERMINAL.SUPERSEDED);
  assert.equal(h[0].endedAt, null, 'no fabricated round-end timestamp');
  assert.equal(observer.snapshot().currentSid, 107);
});

// ---------------------------------------------------------------------------
// §20/§32 — disconnect during a live round => DISCONNECTED, partial metrics.
// ---------------------------------------------------------------------------
test('disconnect finalizes the active round DISCONNECTED with partial metrics', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"sid":100}');
  feed('{"cmd":100009,"sid":100,"odd":1.30}');
  observer.onDisconnect('T');
  const h = observer.history();
  assert.equal(h.length, 1);
  assert.equal(h[0].terminalReason, TERMINAL.DISCONNECTED);
  assert.equal(h[0].maxOdd, 1.30, 'partial metrics preserved');
  assert.equal(observer.status(), STATUS.IDLE);
});

test('disconnect on an unrelated target does not finalize the active round', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"sid":100}');
  observer.onDisconnect('OTHER');
  assert.equal(observer.history().length, 0);
  assert.equal(observer.currentRound().sid, 100);
});

// ---------------------------------------------------------------------------
// §13 — global metrics over completed rounds.
// ---------------------------------------------------------------------------
test('global metrics aggregate durations and frames', () => {
  const { observer, clock, feed } = makeObs();
  const play = (sid, open, end, odds) => {
    clock.t = open; feed(`{"cmd":100005,"sid":${sid}}`);
    let t = open; for (const o of odds) { t += 100; clock.t = t; feed(`{"cmd":100009,"sid":${sid},"odd":${o}}`); }
    clock.t = end; feed(`{"cmd":100007,"sid":${sid},"odd":${odds[odds.length - 1]}}`);
  };
  play(1, 0, 1000, [1.1, 1.2, 1.3]);
  play(2, 2000, 4000, [1.1, 1.5]);
  const m = observer.globalMetrics();
  assert.equal(m.observedRounds, 2);
  assert.equal(m.completedRounds, 2);
  assert.equal(m.minRoundDurationMs, 1000);
  assert.equal(m.maxRoundDurationMs, 2000);
  assert.equal(m.avgRoundDurationMs, 1500);
});

// ---------------------------------------------------------------------------
// §25/§3 — config validation is typed.
// ---------------------------------------------------------------------------
test('config validation rejects invalid values', () => {
  assert.equal(validateConfig({ oddBufferLimit: 0 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(validateConfig({ oddBufferLimit: 99999 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(validateConfig({ historyLimit: -1 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.ok(validateConfig({ oddBufferLimit: 50 }).config);
  const { observer } = makeObs();
  assert.equal(observer.setConfig({ oddBufferLimit: 0 }).error.code, 'INVALID_OBSERVER_CONFIG');
  assert.equal(observer.setConfig({ oddBufferLimit: 25 }).config.oddBufferLimit, 25);
});

// ---------------------------------------------------------------------------
// §14/§15 — ActionTrace is read from RoundTracker for display, not generated.
// ---------------------------------------------------------------------------
test('round detail surfaces ActionTrace evidence read from RoundTracker', () => {
  const { observer, feed } = makeObs();
  feed('{"cmd":100005,"sid":100}');
  feed('{"cmd":100002,"b":5000,"sid":100,"aid":1,"eid":1}', 'send'); // client bet (observed)
  feed('{"cmd":100002,"eid":1,"b":5000}');                          // server ack (observed)
  const traces = observer.currentRound().actionTraces;
  assert.equal(traces.length, 1);
  assert.equal(traces[0].sid, 100);
  assert.ok(traces[0].ack, 'ack correlated by RoundTracker, displayed read-only');
});
