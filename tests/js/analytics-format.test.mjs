import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

// Load ui-analytics/format.js the same way the browser does (classic script), but in a
// sandbox so we can exercise the pure AFmt formatter without a DOM. Mirrors the string-read
// convention used by m16m20-ui.test.mjs.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(path.join(ROOT, 'ui-analytics/format.js'), 'utf8');
const sandbox = { window: {}, module: { exports: {} } };
vm.runInNewContext(src, sandbox);
const AFmt = sandbox.window.AFmt;

test('AFmt attaches to window and exports the same object', () => {
  assert.ok(AFmt, 'window.AFmt present');
  assert.equal(sandbox.module.exports, AFmt, 'CommonJS export matches window global');
});

test('jackpot: grouped, ≤2 decimals, trailing zeros trimmed', () => {
  assert.equal(AFmt.jackpot(0), '0');
  assert.equal(AFmt.jackpot(12.3), '12.3');
  assert.equal(AFmt.jackpot(123.4567), '123.46');
  assert.equal(AFmt.jackpot(1234.5), '1,234.5');
  assert.equal(AFmt.jackpot(1234567.89), '1,234,567.89');
});

test('odd: 2 decimals + × sign, grouped for large multipliers', () => {
  assert.equal(AFmt.odd(1.2), '1.20×');
  assert.equal(AFmt.odd(2), '2.00×');
  assert.equal(AFmt.odd(10.456), '10.46×');
  assert.equal(AFmt.odd(1000), '1,000.00×');
});

test('percent: 2 decimals; tiny non-zero shows <0.01%; exact 0 shows 0%', () => {
  assert.equal(AFmt.percent(0.123456), '12.35%');
  assert.equal(AFmt.percent(0), '0%');
  assert.equal(AFmt.percent(0.00001), '<0.01%');   // 0.001% → guarded
  assert.equal(AFmt.percent(1), '100.00%');
});

test('ci: two fractions → 95% CI band; null bounds → empty', () => {
  assert.equal(AFmt.ci(0.1842, 0.2217), '95% CI: 18.42–22.17%');
  assert.equal(AFmt.ci(null, 0.2), '');
  assert.equal(AFmt.ci(0.2, null), '');
});

test('count: grouped integer', () => {
  assert.equal(AFmt.count(1250), '1,250');
  assert.equal(AFmt.count(5), '5');
  assert.equal(AFmt.sampleN(1250), 'n = 1,250');
});

test('duration: readable unit ladder', () => {
  assert.equal(AFmt.duration(842), '842ms');
  assert.equal(AFmt.duration(1240), '1.24s');
  assert.equal(AFmt.duration(12800), '12.8s');
  assert.equal(AFmt.duration(84000), '1m 24s');
});

test('NULL vs 0: nullish/NaN → em dash, never 0', () => {
  for (const f of ['jackpot', 'odd', 'count', 'duration', 'fixed', 'bytes']) {
    assert.equal(AFmt[f](null), '—', `${f}(null)`);
    assert.equal(AFmt[f](undefined), '—', `${f}(undefined)`);
    assert.equal(AFmt[f](NaN), '—', `${f}(NaN)`);
  }
  assert.equal(AFmt.percent(null), '—');
  // 0 is a real value, not "no data".
  assert.equal(AFmt.jackpot(0), '0');
  assert.equal(AFmt.count(0), '0');
});

test('id: identifier passthrough (no grouping), null-safe', () => {
  assert.equal(AFmt.id(100005), '100005');   // SID/CMD never grouped
  assert.equal(AFmt.id(null), '—');
});

test('fixed: grouped fixed decimals, null-safe', () => {
  assert.equal(AFmt.fixed(2.3456, 1), '2.3');
  assert.equal(AFmt.fixed(1234.5, 0), '1,235');
  assert.equal(AFmt.fixed(null, 1), '—');
});

test('pvalue: never "p = 0.000"; small → "p < 0.001"; null → —', () => {
  assert.equal(AFmt.pvalue(0.032), 'p = 0.032');
  assert.equal(AFmt.pvalue(0.0004), 'p < 0.001');
  assert.equal(AFmt.pvalue(0), 'p < 0.001');
  assert.equal(AFmt.pvalue(1), 'p = 1.000');
  assert.equal(AFmt.pvalue(null), '—');
});
