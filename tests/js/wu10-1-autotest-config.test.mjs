import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');

// autotest-config.js is a browser classic script (project is type:module); load it
// into a fake window to exercise the pure config reader/validator.
const src = readFileSync(new URL('../../ui/autotest-config.js', import.meta.url), 'utf8');
const win = {};
new Function('window', src)(win);
const ATC = win.AutoTestConfig;

// ---------------------------------------------------------------------------
// §2/§15 — UI config maps EXACTLY to the AutoRunner contract.
// ---------------------------------------------------------------------------
test('config pass-through: fields -> {roundCount, amount, stopOdd}', () => {
  const v = ATC.validate({ rounds: '7', amount: '12345', stopOdd: '1.75' });
  assert.equal(v.ok, true);
  assert.deepEqual(v.config, { roundCount: 7, amount: 12345, stopOdd: 1.75, aid: 1, eid: 1 });
});

test('aid/eid default to 1 and are overridable', () => {
  assert.deepEqual(ATC.validate({ rounds: '3', amount: '5000', stopOdd: '2' }).config, { roundCount: 3, amount: 5000, stopOdd: 2, aid: 1, eid: 1 });
  assert.deepEqual(ATC.validate({ rounds: '3', amount: '5000', stopOdd: '2', aid: '4', eid: '9' }).config.aid, 4);
});

// ---------------------------------------------------------------------------
// §6 — client-side validation gates Start with per-field errors.
// ---------------------------------------------------------------------------
test('validation: per-field errors and no config when invalid', () => {
  const r0 = ATC.validate({ rounds: '0', amount: '5000', stopOdd: '2' });
  assert.equal(r0.ok, false); assert.ok(r0.errors.rounds); assert.equal(r0.config, null);
  assert.ok(ATC.validate({ rounds: '2.5', amount: '5000', stopOdd: '2' }).errors.rounds, 'non-integer rounds');
  assert.ok(ATC.validate({ rounds: '3', amount: '0', stopOdd: '2' }).errors.amount, 'amount > 0');
  assert.ok(ATC.validate({ rounds: '3', amount: '-1', stopOdd: '2' }).errors.amount, 'amount > 0');
  assert.ok(ATC.validate({ rounds: '3', amount: '5000', stopOdd: '0' }).errors.stopOdd, 'stopOdd > 0');
  assert.ok(ATC.validate({ rounds: '', amount: '', stopOdd: '' }).errors.rounds, 'empty required');
  assert.ok(ATC.validate({ rounds: '3', amount: '5000', stopOdd: '2', aid: '-1' }).errors.aid, 'aid non-negative');
});

test('client validation matches the backend contract for a valid config', () => {
  const { AutoRunner: _AR } = require('../../desktop/protocol/auto-runner.cjs');
  const { validateConfig } = require('../../desktop/protocol/auto-runner.cjs');
  const raw = { rounds: '10', amount: '5000', stopOdd: '2.00' };
  const ui = ATC.validate(raw);
  const be = validateConfig(ui.config);
  assert.ok(ui.ok && be.config, 'both accept it');
  assert.equal(be.config.roundCount, ui.config.roundCount);
  assert.equal(be.config.amount, ui.config.amount);
  assert.equal(be.config.stopOdd, ui.config.stopOdd);
});

// ---------------------------------------------------------------------------
// Runner-level: config actually propagates into the sent bets.
// ---------------------------------------------------------------------------
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };
function make() {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const sends = [];
  const harness = { execute: async (opts) => { sends.push({ command: opts.command, overrides: opts.overrides }); return opts.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2.05, wm: 7750 } } : { result: 'ACK' }; } };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'http://localhost:8080/game', now: () => 0 });
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://game.local/ws' });
  const bets = () => sends.filter((s) => s.command === 'bet');
  return { runner, feed, sends, bets };
}
async function qualify(feed, sid) { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); feed(`{"cmd":100009,"sid":${sid},"odd":2.5}`); await flush(); feed(`{"cmd":100007,"sid":${sid}}`); await flush(); }

// §17 — mandatory regression: the configured amount reaches every bet.
test('amount propagation: every bet carries the configured amount (7777)', async () => {
  const { runner, feed, bets } = make();
  runner.start('T', { roundCount: 2, amount: 7777, stopOdd: 2 });
  await qualify(feed, 100); await qualify(feed, 107);
  assert.equal(bets().length, 2);
  assert.ok(bets().every((b) => b.overrides.b === 7777), 'no default 5000 leaks through');
});

// §16 — N-round execution with the configured amount + exact sids.
test('N-round: 3 bets b=5000 on sids 100/107/130 then COMPLETED', async () => {
  const { runner, feed, bets } = make();
  runner.start('T', { roundCount: 3, amount: 5000, stopOdd: 2 });
  for (const sid of [100, 107, 130]) await qualify(feed, sid);
  assert.deepEqual(bets().map((b) => b.overrides.b), [5000, 5000, 5000]);
  assert.equal(runner.state(), 'COMPLETED');
});

// §18 — a new run uses ONLY the new configuration (no stale amount/threshold).
test('new run uses only the new config', async () => {
  const { runner, feed, bets } = make();
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 2 });
  await qualify(feed, 100);
  assert.equal(runner.state(), 'COMPLETED');
  runner.start('T', { roundCount: 1, amount: 10000, stopOdd: 1.5 });
  await qualify(feed, 200);
  const last = bets().at(-1);
  assert.equal(last.overrides.b, 10000, 'second run uses 10000, not 5000');
  assert.equal(runner.snapshot().config.stopOdd, 1.5);
});
