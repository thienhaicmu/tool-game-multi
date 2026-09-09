import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// V2 UI + IPC wiring and research/action boundary (§49/§50/§55/§61). Static
// source checks: the renderer discovers the new families, is simple-first
// (progressive disclosure via collapsed technical details), speaks plain
// Vietnamese, and NEVER emits wagering wording; the IPC surface exposes the new
// read-only research channels and nothing action-bearing.
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const ui = read('ui-analytics/analytics.js');
const html = read('ui-analytics/index.html');
const preload = read('desktop/analytics-preload.cjs');
const main = read('desktop/analytics-main.cjs');

test('UI-01 renderer discovers families + complexity + incremental-value (registry-driven, no hardcoded routing)', () => {
  assert.ok(ui.includes('RS_FAMILY_VI') && ui.includes('SPLINE') && ui.includes('DECISION_TREE'), 'family labels present');
  assert.ok(ui.includes('RS_INCR_VI') && ui.includes('STABLE_INCREMENTAL_VALUE'), 'incremental-value vocabulary present');
  assert.ok(ui.includes('RS_COMPLEXITY_VI'), 'complexity labels present');
  assert.ok(ui.includes('familyMonitoring'), 'renders family monitoring');
});

test('UI-02 simple-first: collapsed technical details + 4 primary tabs', () => {
  assert.ok(ui.includes('details class="rs-tech"') || ui.includes("details class=\"rs-tech\""), 'technical detail is collapsed');
  assert.ok(ui.includes('Chi tiết kỹ thuật'), 'progressive-disclosure section present');
  const tabs = (html.match(/data-rs="/g) || []).length;
  assert.equal(tabs, 4, 'exactly four research subtabs (Tổng quan / Thuật toán / So sánh / Lịch sử)');
});

test('UI-03 insufficient-data state is explained in plain language (no raw enum dump)', () => {
  assert.ok(ui.includes('Chưa đủ dữ liệu để đánh giá'), 'plain insufficient message');
  assert.ok(ui.includes('Cần thêm khoảng') || ui.includes('rsDataHint'), 'estimates how much more data');
});

test('UI-04 renderer contains NO wagering / action wording', () => {
  const forbidden = ['đặt cược', 'rút tiền', 'cashout', 'place bet', 'nên đặt', 'khuyến nghị đặt', 'auto-bet', 'tín hiệu cược'];
  const low = ui.toLowerCase();
  for (const w of forbidden) assert.ok(!low.includes(w), `renderer must not contain wagering wording: ${w}`);
});

test('UI-05 preload exposes ONLY read-only research channels incl. the new V2 ones', () => {
  for (const ch of ['familyMonitoring', 'batches', 'batchRuns', 'ledger', 'overview', 'evaluate', 'compare']) {
    assert.ok(preload.includes(ch), 'preload exposes research.' + ch);
  }
  // No action bridge on the analytics preload (strip comments — they document the
  // deliberate ABSENCE of such channels).
  const low = preload.replace(/\/\/[^\n]*/g, '').toLowerCase();
  for (const w of ['cashout', 'placebet', 'sendraw', 'auto-runner']) assert.ok(!low.includes(w), 'preload must not expose ' + w);
});

test('UI-06 main registers the new research IPC handlers', () => {
  for (const ch of ['analytics-research-family-monitoring', 'analytics-research-batches', 'analytics-research-batch-runs', 'analytics-research-ledger']) {
    assert.ok(main.includes(ch), 'main handles ' + ch);
  }
});
