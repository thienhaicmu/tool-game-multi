import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { ProtocolHarness } = require('../../desktop/protocol/harness.cjs');
const { AmountValidator, validateAmountConfig, classifyCategory, classifyOutcome, verdictFor } = require('../../desktop/protocol/amount-validator.cjs');

// Pure UI helper loaded into a fake window (type:module can't require a .js as CJS).
const src = readFileSync(new URL('../../ui/amount-validation.js', import.meta.url), 'utf8');
const win = {}; new Function('window', src)(win);
const AV = win.AmountValidation;

const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };

// Fake harness: builds the bet payload with b verbatim (like the real one) and
// returns a scripted ack. Records exactly what would go on the wire.
function fakeHarness(scripted) {
  const sends = [];
  return {
    sends,
    execute: async (opts) => {
      const b = opts.overrides.b;
      sends.push({ command: opts.command, b });
      const r = scripted ? scripted(b, sends.length) : { result: 'ACK', responsePayload: { b } };
      return { requestPayload: { cmd: 100002, b, sid: 999, aid: opts.overrides.aid, eid: opts.overrides.eid }, ...r };
    },
  };
}
function make(scripted, host = 'http://localhost:8080/game') {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const harness = fakeHarness(scripted);
  const v = new AmountValidator({ roundTracker: tracker, harness, getTargetUrl: () => host, now: () => 0 });
  const feed = (raw) => tracker.observe({ raw, direction: 'recv', targetId: 'T', url: 'wss://g.local/ws' });
  return { tracker, harness, v, feed };
}

const REQUIRED = [-1, 0, 1, 4999, 5000, 5001, 7777, 12345, 49999, 50000, 50001, 100000, 2147483647];

// ---------------------------------------------------------------------------
// §2/§24/§25/§26/§28 — EXACT value preservation at the send template (no clamp).
// ---------------------------------------------------------------------------
test('buildTemplate carries the exact b for the whole required set (no clamp/snap/round)', () => {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  tracker.observe({ direction: 'recv', raw: '{"cmd":100005,"sid":2988001}' });
  const harness = new ProtocolHarness({ roundTracker: tracker, getTargetUrl: () => 'https://localhost/game' });
  for (const b of REQUIRED) {
    const p = harness.buildTemplate('bet', { b });
    assert.equal(p.b, b, `b=${b} preserved`);
    assert.equal(p.sid, 2988001, 'sid from server');
  }
});

// ---------------------------------------------------------------------------
// §28 — validator puts the exact input on the wire for every required value.
// ---------------------------------------------------------------------------
test('validator sends exactly the input b for every required value (list mode)', async () => {
  const { v, harness, feed } = make();
  v.start('T', { mode: 'list', values: REQUIRED });
  for (let i = 0; i < REQUIRED.length; i++) { feed(`{"cmd":100005,"sid":${1000 + i}}`); await flush(); }
  assert.deepEqual(harness.sends.map((s) => s.b), REQUIRED, 'wire b == input, in order');
  assert.deepEqual(v.history().map((c) => c.sentB), REQUIRED);
  assert.equal(v.state(), 'COMPLETED');
});

// ---------------------------------------------------------------------------
// §30/§31 — never clamp above-max / below-min.
// ---------------------------------------------------------------------------
test('above-UI-max (50001) and below-UI-min (4999) are sent unchanged', async () => {
  const { v, harness, feed } = make();
  v.start('T', { mode: 'list', values: [50001, 4999] });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100005,"sid":107}'); await flush();
  assert.deepEqual(harness.sends.map((s) => s.b), [50001, 4999]);
});

// ---------------------------------------------------------------------------
// §5/§32 — single value across N rounds, exact SIDs.
// ---------------------------------------------------------------------------
test('single value 7777 across 5 rounds uses the exact server SIDs', async () => {
  const { v, harness, feed } = make();
  v.start('T', { mode: 'single', amount: 7777, roundCount: 5 });
  for (const sid of [100, 107, 130, 145, 180]) { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); }
  assert.deepEqual(harness.sends.map((s) => s.b), [7777, 7777, 7777, 7777, 7777]);
  assert.deepEqual(v.history().map((c) => c.sid), [100, 107, 130, 145, 180]);
  assert.equal(v.state(), 'COMPLETED');
});

// ---------------------------------------------------------------------------
// §6/§33 — value-list maps one value per distinct server round.
// ---------------------------------------------------------------------------
test('value list maps one value per round', async () => {
  const { v, feed } = make();
  v.start('T', { mode: 'list', values: [4999, 7777, 50001] });
  for (const sid of [100, 107, 130]) { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); }
  const h = v.history();
  assert.deepEqual(h.map((c) => [c.sid, c.sentB]), [[100, 4999], [107, 7777], [130, 50001]]);
});

// ---------------------------------------------------------------------------
// §11/§12/§13/§14/§15 — outcome classification.
// ---------------------------------------------------------------------------
test('classifyOutcome: EXACT / NORMALIZED / REJECTED / INCONCLUSIVE', () => {
  assert.equal(classifyOutcome({ result: 'ACK', responsePayload: { b: 7777 } }, 7777).observed, 'ACCEPTED_EXACT');
  const norm = classifyOutcome({ result: 'ACK', responsePayload: { b: 5000 } }, 7777);
  assert.equal(norm.observed, 'ACCEPTED_NORMALIZED'); assert.equal(norm.ackB, 5000);
  assert.equal(classifyOutcome({ result: 'REJECTED' }, 7777).observed, 'REJECTED');
  assert.equal(classifyOutcome({ result: 'TIMEOUT' }, 7777).observed, 'INCONCLUSIVE');
});

test('normalized server ack is surfaced with a diff in history', async () => {
  const { v, feed } = make((b) => ({ result: 'ACK', responsePayload: { b: 5000 } })); // server clamps everything to 5000
  v.start('T', { mode: 'single', amount: 7777, roundCount: 1 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  const c = v.history()[0];
  assert.equal(c.observed, 'ACCEPTED_NORMALIZED');
  assert.equal(c.sentB, 7777); assert.equal(c.ackB, 5000); assert.equal(c.diff, -2777);
});

test('rejected + inconclusive are recorded honestly', async () => {
  const { v, feed } = make((b) => (b < 5000 ? { result: 'REJECTED', error: { code: 'X' } } : { result: 'TIMEOUT' }));
  v.start('T', { mode: 'list', values: [4999, 7777] });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100005,"sid":107}'); await flush();
  assert.equal(v.history()[0].observed, 'REJECTED');
  assert.equal(v.history()[1].observed, 'INCONCLUSIVE');
});

// ---------------------------------------------------------------------------
// §34 — bet-only: no cashout, no odd dependency.
// ---------------------------------------------------------------------------
test('bet-only: never sends cashout and does not wait for odd', async () => {
  const { v, harness, feed } = make();
  v.start('T', { mode: 'single', amount: 7777, roundCount: 1 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100009,"sid":100,"odd":2.5}'); feed('{"cmd":100007,"sid":100}'); await flush();
  assert.equal(v.history().length, 1, 'case completed on bet ack, not on odd/round-end');
  assert.ok(harness.sends.every((s) => s.command === 'bet'));
  assert.equal(harness.sends.filter((s) => s.command === 'cashout').length, 0);
});

// ---------------------------------------------------------------------------
// §10 — one case per SID.
// ---------------------------------------------------------------------------
test('duplicate 100005 for the same sid does not create a second case', async () => {
  const { v, harness, feed } = make();
  v.start('T', { mode: 'single', amount: 7777, roundCount: 3 });
  feed('{"cmd":100005,"sid":100}'); await flush();
  feed('{"cmd":100005,"sid":100}'); await flush();
  assert.equal(harness.sends.length, 1);
});

// ---------------------------------------------------------------------------
// §3/§4 — allow any numeric b; reject only type garbage.
// ---------------------------------------------------------------------------
test('config allows negative/zero/extreme; rejects non-numeric', () => {
  for (const amount of [-1, 0, 50001, 2147483647]) assert.ok(validateAmountConfig({ mode: 'single', amount, roundCount: 1 }).config, `allow ${amount}`);
  assert.equal(validateAmountConfig({ mode: 'single', amount: NaN, roundCount: 1 }).error.code, 'INVALID_AUTO_TEST_CONFIG');
  assert.equal(validateAmountConfig({ mode: 'single', amount: Infinity, roundCount: 1 }).error.code, 'INVALID_AUTO_TEST_CONFIG');
  assert.equal(validateAmountConfig({ mode: 'list', values: [] }).error.code, 'INVALID_AUTO_TEST_CONFIG');
});

test('UI parseAmount: finite numbers pass (incl -1/0); garbage rejected', () => {
  assert.equal(AV.parseAmount('7777').value, 7777);
  assert.equal(AV.parseAmount(' -1 ').value, -1);
  assert.equal(AV.parseAmount('0').value, 0);
  assert.equal(AV.parseAmount('50001').value, 50001);
  assert.ok(AV.parseAmount('').error);
  assert.ok(AV.parseAmount('abc').error);
  assert.ok(AV.parseAmount('Infinity').error);
  assert.ok(AV.parseAmount('NaN').error);
});

test('UI parseValues + preset generator', () => {
  const r = AV.parseValues('4999\n7777, 50001\nabc');
  assert.deepEqual(r.values, [4999, 7777, 50001]);
  assert.equal(r.errors.length, 1);
  assert.deepEqual(AV.generateAroundLimits(5000, 50000), [0, 1, 4999, 5000, 5001, 49999, 50000, 50001]);
});

// ---------------------------------------------------------------------------
// §8 — display-only category classification.
// ---------------------------------------------------------------------------
test('classifyCategory: intent labels (display only)', () => {
  const o = { uiMin: 5000, uiMax: 50000, presets: [10000] };
  assert.equal(classifyCategory(-1, o), 'NEGATIVE');
  assert.equal(classifyCategory(0, o), 'ZERO');
  assert.equal(classifyCategory(4999, o), 'BELOW_UI_MIN');
  assert.equal(classifyCategory(5000, o), 'UI_MIN');
  assert.equal(classifyCategory(7777, o), 'WITHIN_UI_RANGE_NON_PRESET');
  assert.equal(classifyCategory(10000, o), 'UI_PRESET');
  assert.equal(classifyCategory(50000, o), 'UI_MAX');
  assert.equal(classifyCategory(50001, o), 'ABOVE_UI_MAX');
  assert.equal(classifyCategory(100000, o), 'EXTREME');
});

// ---------------------------------------------------------------------------
// §16/§17 — verdict only when an expectation is set.
// ---------------------------------------------------------------------------
test('verdictFor: any=>null, accept/reject => PASS/FAIL', () => {
  assert.equal(verdictFor('any', 'ACCEPTED_EXACT'), null);
  assert.equal(verdictFor('accept', 'ACCEPTED_EXACT'), 'PASS');
  assert.equal(verdictFor('accept', 'REJECTED'), 'FAIL');
  assert.equal(verdictFor('reject', 'REJECTED'), 'PASS');
  assert.equal(verdictFor('reject', 'ACCEPTED_NORMALIZED'), 'FAIL');
  assert.equal(verdictFor('reject', 'INCONCLUSIVE'), 'INCONCLUSIVE');
});

// ---------------------------------------------------------------------------
// §9 (gate) — hard local/test endpoint binding.
// ---------------------------------------------------------------------------
test('start refuses a non-local endpoint', () => {
  const { v } = make(null, 'https://casino.example.com/game');
  assert.equal(v.start('T', { mode: 'single', amount: 7777, roundCount: 1 }).error.code, 'AUTO_TEST_TARGET_NOT_ALLOWED');
});

// ---------------------------------------------------------------------------
// summary observations (§22) — server-behavior, not auto-vulnerability.
// ---------------------------------------------------------------------------
test('summary lists accepted-below-min / above-max / non-preset', async () => {
  const { v, feed } = make(() => ({ result: 'ACK' })); // server accepts everything exactly
  v.start('T', { mode: 'list', values: [4999, 7777, 50001], uiMin: 5000, uiMax: 50000 });
  for (const sid of [100, 107, 130]) { feed(`{"cmd":100005,"sid":${sid}}`); await flush(); }
  const s = v.summary();
  assert.equal(s.tested, 3);
  assert.equal(s.acceptedExact, 3);
  assert.deepEqual(s.acceptedBelowMin, [4999]);
  assert.deepEqual(s.acceptedAboveMax, [50001]);
  assert.deepEqual(s.acceptedNonPreset, [7777]);
});
