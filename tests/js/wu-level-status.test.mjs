import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Level / round status (Goals 2 & 3). The Auto status area shows, from BACKEND authority only:
//     Vòng: <round>/<roundCount> - Level <N>
//   Level N    = current AutoSequence row index + 1
//   roundCount = the CURRENT Level's configured Số vòng (must not show a stale previous-Level total)
//   round      = AutoRunner's 1-based current round within the Level
// These tests drive the REAL AutoSequenceController and REAL AutoRunner (never a disconnected
// formatter): the renderer's exact string is reproduced here and asserted against real snapshots.

const require = createRequire(import.meta.url);
const { AutoSequenceController, CONTINUABLE_STOP_REASON } = require('../../desktop/browser-run/auto-sequence-controller.cjs');
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 6; i++) await tick(); };

// EXACT mirror of the renderer's status derivation (ui/product.js render()). Fed with real snapshots.
function levelStatus(seq, auto) {
  const level = (seq && Number.isFinite(seq.index)) ? seq.index + 1 : 1;
  const roundCount = (seq && seq.roundCount != null) ? seq.roundCount
    : (auto && auto.config && auto.config.roundCount != null ? auto.config.roundCount
      : (auto && auto.progress && auto.progress.target != null ? auto.progress.target : null));
  const p = (auto && auto.progress) || {};
  let round = (auto && auto.active && Number.isFinite(auto.active.index)) ? auto.active.index + 1 : (p.attempted || 0);
  round = Math.max(1, roundCount != null ? Math.min(round, roundCount) : round);
  return `Vòng: ${round}/${roundCount != null ? roundCount : '—'} - Level ${level}`;
}

function fakeScheduler() {
  let seq = 0; const timers = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fireAll() { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) fn(); },
  };
}
function mockCtrl({ ownerRunId = 'BR-0001' } = {}) {
  const sch = fakeScheduler();
  const starts = [];
  let seq = 0, curId = null;
  const startExecution = async (cfg, o) => { seq += 1; const execId = `AX-${seq}`; starts.push({ cfg, first: !!(o && o.first), execId }); curId = execId; return { ok: true, autoExecutionId: execId }; };
  const stopExecution = (reason) => ctrl.onExecutionFinalized({ autoExecutionId: curId, stopReason: reason });
  const ctrl = new AutoSequenceController({ startExecution, stopExecution, scheduler: sch, ownerRunId });
  const lastId = () => (starts.length ? starts[starts.length - 1].execId : null);
  const finalize = (reason = CONTINUABLE_STOP_REASON) => ctrl.onExecutionFinalized({ autoExecutionId: lastId(), stopReason: reason });
  const win = () => ctrl.onRoundWin({ autoExecutionId: curId });
  const advance = async () => { sch.fireAll(); await flush(); };
  return { ctrl, starts, finalize, win, advance };
}
const ROW = (roundCount) => ({ roundCount, amount: 5000, stopOdd: 2.0 });

test('current Level denominator tracks the active row across transitions (no stale total)', async () => {
  const { ctrl, finalize, advance } = mockCtrl();
  await ctrl.start([ROW(500), ROW(300), ROW(100)]);
  // Level 1
  let s = ctrl.snapshot();
  assert.equal(s.index, 0); assert.equal(s.roundCount, 500); assert.equal(s.total, 3);
  assert.equal(levelStatus(s, { progress: { attempted: 1, target: 500 } }), 'Vòng: 1/500 - Level 1');
  // Level 1 -> Level 2
  finalize(); await advance();
  s = ctrl.snapshot();
  assert.equal(s.index, 1); assert.equal(s.roundCount, 300, 'denominator is Level 2 (300), never the stale 500');
  assert.equal(levelStatus(s, { progress: { attempted: 1, target: 300 } }), 'Vòng: 1/300 - Level 2');
  // Level 2 -> Level 3
  finalize(); await advance();
  s = ctrl.snapshot();
  assert.equal(s.index, 2); assert.equal(s.roundCount, 100);
  assert.equal(levelStatus(s, { progress: { attempted: 1, target: 100 } }), 'Vòng: 1/100 - Level 3');
});

test('WIN reset returns status to Level 1 with the Level 1 denominator', async () => {
  const { ctrl, finalize, win, advance } = mockCtrl();
  await ctrl.start([ROW(500), ROW(300), ROW(100)]);
  finalize(); await advance();               // now on Level 2
  assert.equal(ctrl.snapshot().index, 1);
  win(); await advance();                     // authoritative WIN -> reset to Level 1
  const s = ctrl.snapshot();
  assert.equal(s.index, 0, 'WIN resets the sequence to Level 1');
  assert.equal(s.roundCount, 500, 'Level 1 denominator restored');
  assert.equal(levelStatus(s, { progress: { attempted: 1, target: 500 } }), 'Vòng: 1/500 - Level 1');
});

test('single row is Level 1', async () => {
  const { ctrl } = mockCtrl();
  await ctrl.start([ROW(500)]);
  const s = ctrl.snapshot();
  assert.equal(s.index, 0); assert.equal(s.total, 1); assert.equal(s.roundCount, 500);
  assert.equal(levelStatus(s, { progress: { attempted: 1, target: 500 } }), 'Vòng: 1/500 - Level 1');
});

// The round NUMERATOR is the AutoRunner's real 1-based round within the Level. Prove the mapping
// against real AutoRunner transitions (task §13 — do not assume attempted+1).
test('round numerator comes from real AutoRunner state (attempted / active.index+1)', async () => {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const harness = { execute: async (o) => (o.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05 } } : { result: 'ACK' }) };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'https://casino.example.com/game' });
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });

  runner.start('T', { roundCount: 500, amount: 5000, stopOdd: 999999 });
  assert.equal(runner.snapshot().progress.attempted, 0, 'no round attempted yet');

  feed('{"cmd":100005,"sid":1001}'); await flush();     // ROUND_OPEN -> place round 1
  let snap = runner.snapshot();
  assert.equal(snap.progress.attempted, 1, 'first active round -> attempted 1');
  assert.equal(snap.active.index, 0, 'round 1 has 0-based index 0');
  assert.equal(levelStatus({ index: 0, roundCount: 500, total: 1 }, snap), 'Vòng: 1/500 - Level 1');

  feed('{"cmd":100007,"sid":1001}'); await flush();      // ROUND_END (loss) -> round 1 finished
  feed('{"cmd":100005,"sid":1002}'); await flush();      // ROUND_OPEN -> place round 2
  snap = runner.snapshot();
  assert.equal(snap.progress.attempted, 2, 'second active round -> attempted 2');
  assert.equal(snap.active.index, 1);
  assert.equal(levelStatus({ index: 0, roundCount: 500, total: 1 }, snap), 'Vòng: 2/500 - Level 1',
    'the exact headline example is produced from real backend state');
});
