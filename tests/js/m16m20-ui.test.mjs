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
