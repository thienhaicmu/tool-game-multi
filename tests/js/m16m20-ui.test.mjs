import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(path.join(ROOT, 'ui-analytics/index.html'), 'utf8');
const js = readFileSync(path.join(ROOT, 'ui-analytics/analytics.js'), 'utf8');
const main = readFileSync(path.join(ROOT, 'desktop/analytics-main.cjs'), 'utf8');

test('renderer scheme is registered privileged BEFORE ready (CSS/JS load fix)', () => {
  assert.match(main, /registerSchemesAsPrivileged\(/);
  assert.match(main, /scheme:\s*'analytics-app'/);
  assert.ok(main.indexOf('registerSchemesAsPrivileged') < main.indexOf('app.whenReady'));
});

test('stylesheet + CSP present', () => {
  assert.match(html, /<link rel="stylesheet" href="analytics\.css"/);
  assert.match(html, /Content-Security-Policy/);
});

test('primary navigation is HOME | REPORT | HISTORY | ADVANCED (browser-first, no Web Log in primary)', () => {
  for (const t of ['home', 'report', 'history', 'advanced']) assert.ok(new RegExp(`data-tab="${t}"`).test(html), `missing tab ${t}`);
  assert.ok(!/data-tab="weblog"/.test(html), 'Web Log must NOT be a primary tab');
  assert.ok(!/data-tab="live"/.test(html) && !/data-tab="rounds"/.test(html), 'old tab names replaced');
});

test('exactly four main views toggled', () => {
  for (const v of ['view-home', 'view-report', 'view-history', 'view-advanced']) {
    assert.ok(html.includes(`id="${v}"`) && js.includes(v), `missing view ${v}`);
  }
});

test('Web Log + Data live under ADVANCED (not primary)', () => {
  assert.ok(/data-adv="weblog"/.test(html) && /data-adv="network"/.test(html) && /data-adv="data"/.test(html));
  assert.ok(html.includes('id="wl-body"'), 'web log table still present under Advanced');
  assert.ok(html.includes('id="data-cards"'), 'data panel present under Advanced');
});

test('HOME is browser-first: Open Browser action + current SID/ODD/JP, no manual capture button', () => {
  assert.ok(html.includes('id="home-open"'));
  assert.ok(html.includes('id="m-sid"') && html.includes('id="m-odd"') && html.includes('id="m-jp"'));
  const lower = html.toLowerCase();
  for (const bad of ['start capture', 'attach cdp', 'start logging', 'capture network', 'start websocket']) {
    assert.ok(!lower.includes(bad), `HOME must not require manual "${bad}"`);
  }
});

test('REPORT is jackpot-first: persistent JP basis config + 5 simplified perspectives', () => {
  assert.ok(html.includes('id="f-jpbasis"'), 'jackpot basis selector present');
  // Simplified normal-user structure (spec §3): Tổng quan → Jackpot → ODD → Thời gian → Chuỗi/Xu hướng.
  for (const s of ['overview', 'jackpot', 'odd', 'time', 'streakgap']) {
    assert.ok(new RegExp(`data-sub="${s}"`).test(html), `missing report perspective ${s}`);
  }
  // Jackpot is promoted ahead of ODD (jackpot-first ordering).
  assert.ok(html.indexOf('data-sub="jackpot"') < html.indexOf('data-sub="odd"'), 'Jackpot precedes ODD');
  // "Tốc độ ODD" (timing) is MERGED into "Thời gian" as a metric, not a separate perspective.
  assert.ok(!/data-sub="timing"/.test(html), 'timing is no longer a standalone perspective');
  assert.ok(js.includes('data-tm="timing"') && js.includes('api.report.timing'), 'timing reachable inside Thời gian');
  // every report perspective renderer consults the jackpot report API
  assert.ok(js.includes('api.report.overview') && js.includes('api.report.odd') && js.includes('api.report.gap'));
});

test('global Jackpot Range filter is present and propagated (half-open, basis-aligned)', () => {
  assert.ok(html.includes('id="f-jprange"'), 'Jackpot Range selector present in the global filter bar');
  assert.ok(js.includes('const JP_RANGES'), 'UI defines the authoritative JP ranges');
  // The filter must carry the selected basis + half-open range bounds so the predicate column matches the report bucketing.
  assert.ok(js.includes('f.jackpotBasis') && js.includes('jackpotRangeMin'), 'buildFilter sends basis + range');
  assert.ok(js.includes('if (rng.max != null) f.jackpotRangeMax'), 'open-ended bucket omits the upper bound');
});

test('S25/S26/S27 statistical analysis block: retrospective, effect-first, no prediction wording', () => {
  // Compact "Phân tích thống kê" lives inside the Jackpot section (not a new main tab).
  assert.ok(js.includes('renderStatsBlock') && js.includes('api.report.stats'), 'stats block wired into Jackpot');
  assert.ok(js.includes('Phân tích thống kê'));
  assert.ok(!/data-sub="stats"/.test(html), 'statistics is NOT a separate report perspective');
  // S26: p-values via the centralized formatter (never "p = 0.000").
  assert.ok(js.includes('AFmt.pvalue'), 'p-values formatted via AFmt.pvalue');
  // S27: effect-size interpretation present (cards + details), significance is not a success badge.
  assert.ok(js.includes('EFFECT_VI') && js.includes('Hiệu ứng'), 'effect-size interpretation surfaced');
  // S25: no Vietnamese prediction/recommendation wording anywhere in the renderer.
  const banned = ['dự đoán', 'vòng sau', 'vòng tiếp', 'nên cược', 'nên vào', 'tín hiệu', 'jackpot nóng', 'jackpot lạnh', 'dễ nổ', 'xác suất thắng', 'sắp ra', 'điểm vào'];
  const lower = js.toLowerCase();
  for (const b of banned) assert.ok(!lower.includes(b), `renderer must not contain "${b}"`);
});

test('Forward Research: subordinate research area, out-of-sample, no prediction/betting wording', () => {
  assert.ok(js.includes('renderForwardSection') && js.includes('api.forward.run'), 'forward research wired into Jackpot');
  assert.ok(js.includes('Nghiên cứu Forward'));
  assert.ok(!/data-sub="forward"/.test(html) && !/data-tab="forward"/.test(html), 'forward is NOT a primary tab/perspective');
  assert.ok(js.includes('walkForward') && js.includes('leakageAudit'), 'walk-forward + leakage audit surfaced');
  const banned = ['dự đoán', 'dự báo', 'vòng sau', 'nên cược', 'nên vào', 'tín hiệu', 'jackpot nóng', 'jackpot lạnh', 'dễ nổ', 'xác suất thắng', 'khuyến nghị', 'signal', 'edge', 'bet when', 'next round'];
  const lower = js.toLowerCase();
  // ASCII tokens are matched as WHOLE WORDS so the wagering term "edge" does not
  // false-positive on legitimate words like "ledger" (hyperparameter search ledger,
  // §31) — the guard's intent is wagering language, not the substring.
  for (const b of banned) {
    const hit = /^[a-z ]+$/.test(b) ? new RegExp(`\\b${b}\\b`).test(lower) : lower.includes(b);
    assert.ok(!hit, `renderer must not contain "${b}"`);
  }
});

test('centralized number formatter (format.js / AFmt) is loaded before the app', () => {
  assert.ok(/<script src="format\.js">/.test(html), 'format.js script tag present');
  assert.ok(html.indexOf('format.js') < html.indexOf('analytics.js'), 'format.js loads before analytics.js');
  assert.ok(js.includes('window.AFmt'), 'app uses the centralized AFmt formatter');
});

test('no action controls / no prediction language anywhere in the UI', () => {
  const jsCode = js.replace(/\/\/[^\n]*/g, ''); // ignore source comments
  const lower = (html + '\n' + jsCode).toLowerCase();
  for (const bad of ['replay', 'resend', 'intercept', 'edit request', 'place bet', 'cashout', 'send frame',
    'bet now', 'next likely', 'win probability', 'prediction', '>hot<', 'cold streak']) {
    assert.ok(!lower.includes(bad), `UI must not contain "${bad}"`);
  }
});
