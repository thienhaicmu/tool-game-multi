// WU-AUTH... Input-Validation product audit — strict numeric parsing across the layers.
//
// The audit found the JS Number() coercion footguns reaching config: ''/whitespace → 0
// (jackpot threshold), scientific/hex strings accepted (1e3 / 0x10), and huge integers
// silently losing precision (round count). These tests lock the strict rules at every
// layer (canonical numeric.cjs, main validateConfig, config store, UI mirror) AND assert
// b-Test keeps its intentional wide acceptance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const { parseStrict } = require('../../desktop/protocol/numeric.cjs');
const { validateConfig } = require('../../desktop/protocol/auto-runner.cjs');
const { BrowserConfigStore } = require('../../desktop/browser-run/browser-config-store.cjs');
// UI helpers are classic scripts (project is type:module) — load into a fake window, matching
// the pattern used by wu10-1 / wu10-2.
const win = {};
new Function('window', rd('ui/amount-validation.js'))(win);
new Function('window', rd('ui/autotest-config.js'))(win);
const AV = win.AmountValidation;
const ATC = win.AutoTestConfig;

// ---- canonical parser (desktop/protocol/numeric.cjs) ----
test('numeric.parseStrict: rejects the Number() footguns', () => {
  const bad = ['', '   ', '1e3', '5e4', '0x10', '0o17', '0b101', '12abc', 'abc', '1,5', '1.', '.', 'NaN', 'Infinity', '-Infinity', '+Infinity'];
  for (const b of bad) assert.ok(parseStrict(b).error, `should reject: ${JSON.stringify(b)}`);
  // typed non-finite too
  assert.ok(parseStrict(NaN).error);
  assert.ok(parseStrict(Infinity).error);
  assert.ok(parseStrict(-Infinity).error);
});

test('numeric.parseStrict: accepts plain decimals and preserves the exact value', () => {
  assert.equal(parseStrict('0').value, 0);
  assert.equal(parseStrict('2.50').value, 2.5);
  assert.equal(parseStrict('-1.25').value, -1.25);
  assert.equal(parseStrict('.5').value, 0.5);
  assert.equal(parseStrict('5000').value, 5000);
});

test('numeric.parseStrict: integer + safe-integer enforcement (no silent rounding)', () => {
  assert.equal(parseStrict('42', { integer: true }).value, 42);
  assert.ok(parseStrict('2.5', { integer: true }).error, 'decimal rejected for integer field');
  assert.equal(parseStrict('9007199254740991', { integer: true }).value, 9007199254740991);
  assert.equal(parseStrict('9007199254740993', { integer: true }).error, 'unsafe-integer', 'beyond safe-int rejected, never rounded');
});

test('numeric.parseStrict: bounds and allowNull', () => {
  assert.ok(parseStrict('0', { gt: 0 }).error, '0 fails gt:0');
  assert.equal(parseStrict('1', { gt: 0 }).value, 1);
  assert.ok(parseStrict('-1', { min: 0 }).error);
  assert.equal(parseStrict(null, { allowNull: true }).value, null);
  assert.equal(parseStrict('', { allowNull: true }).value, null);
  assert.ok(parseStrict('', {}).error, 'empty is NOT null unless allowNull');
});

// ---- main authority: auto-runner.validateConfig ----
test('validateConfig: strict round/amount/stopOdd, rejects scientific/empty/unsafe', () => {
  const ok = validateConfig({ roundCount: 10, amount: 5000, stopOdd: 2.0 });
  assert.equal(ok.error, undefined);
  assert.deepEqual([ok.config.roundCount, ok.config.amount, ok.config.stopOdd], [10, 5000, 2]);
  for (const rounds of ['1.5', '0', '-1', '', '  ', '1e3', '0x10', 'abc', '9007199254740993']) {
    assert.ok(validateConfig({ roundCount: rounds, amount: 5000, stopOdd: 2 }).error, `rounds ${JSON.stringify(rounds)} rejected`);
  }
  for (const amount of ['0', '-5', '', 'abc', '1e3']) {
    assert.ok(validateConfig({ roundCount: 1, amount, stopOdd: 2 }).error, `amount ${JSON.stringify(amount)} rejected`);
  }
  assert.ok(validateConfig({ roundCount: 1, amount: 5000, stopOdd: '0' }).error, 'stopOdd 0 rejected');
  // decimals preserved exactly for stopOdd
  assert.equal(validateConfig({ roundCount: 1, amount: 5000, stopOdd: '1.01' }).config.stopOdd, 1.01);
});

// ---- config store: no ''→0 for jackpot threshold, safe-int for rounds ----
test('config store: empty/whitespace jackpotThreshold becomes null (unset), NEVER 0; scientific rejected', () => {
  const store = new BrowserConfigStore({ filePath: null });
  // The critical guarantee (§empty handling): a cleared field is "unset" (null), never a silent 0.
  assert.equal(store.set('B-1', { jackpotThreshold: '' }).config.jackpotThreshold, null, "'' → null, not 0");
  assert.equal(store.set('B-1', { jackpotThreshold: '   ' }).config.jackpotThreshold, null, 'whitespace → null, not 0');
  assert.ok(store.set('B-1', { jackpotThreshold: '1e9' }).error, 'scientific rejected');
  assert.ok(store.set('B-1', { jackpotThreshold: -5 }).error, 'negative rejected');
  assert.equal(store.set('B-1', { jackpotThreshold: null }).config.jackpotThreshold, null, 'explicit null allowed');
  assert.equal(store.set('B-1', { jackpotThreshold: 50000000 }).config.jackpotThreshold, 50000000);
  assert.ok(store.set('B-1', { roundCount: 9007199254740993 }).error, 'unsafe integer rounds rejected');
});

// A null/empty threshold must NOT satisfy the execution-layer jackpot gate as 0 (the old
// Number('')===0 pitfall) — the main authority requires a real number when waiting.
test('execution layer: a null/empty jackpot threshold is NOT accepted as 0', () => {
  assert.ok(parseStrict(null, { min: 0 }).error, 'null rejected at execution (no allowNull)');
  assert.ok(parseStrict('', { min: 0 }).error, "'' rejected at execution");
  assert.equal(parseStrict('0', { min: 0 }).value, 0, 'an explicit 0 is still a valid threshold');
});

// ---- UI mirror (autotest-config.js) agrees with the main authority ----
test('UI ATC.validate mirrors strict rules (scientific/hex/empty/unsafe rejected)', () => {
  assert.ok(ATC.validate({ rounds: '1e3', amount: '5000', stopOdd: '2' }).errors.rounds, 'scientific rounds');
  assert.ok(ATC.validate({ rounds: '0x10', amount: '5000', stopOdd: '2' }).errors.rounds, 'hex rounds');
  assert.ok(ATC.validate({ rounds: '9007199254740993', amount: '5000', stopOdd: '2' }).errors.rounds, 'unsafe-int rounds');
  assert.ok(ATC.validate({ rounds: '  ', amount: '5000', stopOdd: '2' }).errors.rounds, 'whitespace rounds');
  assert.ok(ATC.validate({ rounds: '10', amount: '1e3', stopOdd: '2' }).errors.amount, 'scientific amount');
  // valid still passes and preserves decimals
  const ok = ATC.validate({ rounds: '10', amount: '5000', stopOdd: '2.50' });
  assert.equal(ok.ok, true);
  assert.equal(ok.config.stopOdd, 2.5);
});

// ---- UI/main cross-check: identical accept/reject on a shared battery (no drift) ----
test('UI and main agree on the same numeric battery (no validator drift)', () => {
  const battery = ['1', '10', '2.5', '0', '-1', '', '  ', '1e3', '0x10', '12abc', '9007199254740993'];
  for (const v of battery) {
    const uiRounds = !ATC.validate({ rounds: v, amount: '5000', stopOdd: '2' }).errors.rounds;
    const mainRounds = !validateConfig({ roundCount: v, amount: 5000, stopOdd: 2 }).error;
    assert.equal(uiRounds, mainRounds, `rounds "${v}" must agree UI(${uiRounds}) vs main(${mainRounds})`);
  }
});

// ---- b-Test intentionally keeps wide acceptance (server-boundary testing) ----
test('b-Test parseAmount preserves intentional invalid values (0, negative, out-of-range)', () => {
  assert.equal(AV.parseAmount('0').value, 0, 'zero allowed for server-boundary testing');
  assert.equal(AV.parseAmount('-1').value, -1, 'negative allowed');
  assert.equal(AV.parseAmount('999999999').value, 999999999, 'huge allowed');
  // but still type-rejects nonsense
  assert.ok(AV.parseAmount('NaN').error);
  assert.ok(AV.parseAmount('Infinity').error);
  assert.ok(AV.parseAmount('').error);
});

// ---- source guard: invalid config must be rejected BEFORE entry/jackpot side-effects ----
test('wiring: autotest-start validates config BEFORE the entry gate (no entry on bad config)', () => {
  const main = rd('desktop/main.cjs');
  // WU-AUTO-SEQUENCE — validation-before-entry lives in the shared startAutoExecution().
  const i = main.indexOf('async function startAutoExecution');
  const body = main.slice(i, i + 3200);
  const validateIdx = body.indexOf('C.validateConfig(config');
  const jpParseIdx = body.indexOf("parseStrict(config.jackpotThreshold");
  const entryIdx = body.indexOf('entryGate.ensureEntered()');
  assert.ok(validateIdx > 0 && validateIdx < entryIdx, 'config validated before entry');
  assert.ok(jpParseIdx > 0 && jpParseIdx < entryIdx, 'jackpot threshold validated (strict) before entry');
});
