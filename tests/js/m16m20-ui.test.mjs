import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(path.join(ROOT, 'ui-analytics/index.html'), 'utf8');
const js = readFileSync(path.join(ROOT, 'ui-analytics/analytics.js'), 'utf8');
const main = readFileSync(path.join(ROOT, 'desktop/analytics-main.cjs'), 'utf8');

test('renderer scheme is registered privileged BEFORE ready (root-cause fix for CSS/JS block)', () => {
  assert.match(main, /registerSchemesAsPrivileged\(/);
  assert.match(main, /scheme:\s*'analytics-app'/);
  assert.match(main, /secure:\s*true/);
  // registration must be at top-level (before app.whenReady)
  const idxReg = main.indexOf('registerSchemesAsPrivileged');
  const idxReady = main.indexOf('app.whenReady');
  assert.ok(idxReg > -1 && idxReg < idxReady, 'privileged scheme must be registered before app.whenReady');
});

test('stylesheet + CSP present in renderer', () => {
  assert.match(html, /<link rel="stylesheet" href="analytics\.css"/);
  assert.match(html, /Content-Security-Policy/);
});

test('main navigation is LIVE | WEB LOG | ROUNDS | REPORT | DATA', () => {
  for (const t of ['live', 'weblog', 'rounds', 'report', 'data']) {
    assert.ok(new RegExp(`data-tab="${t}"`).test(html), `missing main tab ${t}`);
  }
  assert.ok(!/data-tab="analytics"/.test(html), 'old ANALYTICS top-level tab must be gone');
});

test('one main view is toggled per tab (exactly five views)', () => {
  for (const v of ['view-live', 'view-weblog', 'view-rounds', 'view-report', 'view-data']) {
    assert.ok(html.includes(`id="${v}"`), `missing ${v}`);
    assert.ok(js.includes(`'${v}'`) || js.includes(v), `switchTab must toggle ${v}`);
  }
});

test('REPORT has subtabs incl Network/API; exactly one report panel', () => {
  for (const s of ['overview', 'distribution', 'timing', 'jackpot', 'time', 'rolling', 'streakgap', 'network']) {
    assert.ok(new RegExp(`data-sub="${s}"`).test(html), `missing report subtab ${s}`);
  }
  assert.ok(html.includes('id="analytics-panel"'));
});

test('WEB LOG has table + detail drawer; request detail hidden until selection', () => {
  assert.ok(html.includes('id="wl-body"'));
  assert.ok(html.includes('id="weblog-drawer"'));
  assert.match(html, /id="weblog-drawer" class="detail-drawer hidden"/); // hidden by default
});

test('no action controls or action terminology in the UI', () => {
  const lower = html.toLowerCase();
  for (const bad of ['replay', 'resend', 'intercept', 'edit request', 'continue request', 'place bet', 'cashout', 'send frame']) {
    assert.ok(!lower.includes(bad), `UI must not contain "${bad}"`);
  }
  // no prediction language
  for (const bad of ['bet now', 'due', 'hot streak', 'next likely', 'prediction']) assert.ok(!lower.includes(bad), `UI must not contain "${bad}"`);
});

test('DATA tab shows network counts + web log export', () => {
  assert.ok(js.includes('Network requests') && js.includes('WS connections') && js.includes('WS events'));
  assert.ok(html.includes('id="d-export-weblog"'));
});
