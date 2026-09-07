import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FORBIDDEN = [
  'desktop/cdp/ws-replay.cjs', 'desktop/cdp/intercept.cjs',
  'desktop/protocol/auto-runner.cjs', 'desktop/protocol/harness.cjs', 'desktop/protocol/amount-validator.cjs',
  'desktop/protocol/aviator-entry.cjs', 'desktop/protocol/jackpot-gate.cjs', 'desktop/protocol/stop1000-guard.cjs',
  'desktop/protocol/aviator.cjs', 'desktop/protocol/round-observer.cjs', 'desktop/replay/replay-engine.cjs',
];
function resolveSpec(spec, from) {
  if (!spec.startsWith('.') && !path.isAbsolute(spec)) return null;
  const abs = path.resolve(path.dirname(from), spec);
  for (const c of [abs, abs + '.cjs', abs + '.js', path.join(abs, 'index.cjs')]) if (existsSync(c)) return c;
  return null;
}
function graphFrom(entries) {
  const seen = new Set(); const stack = [...entries];
  while (stack.length) { const f = stack.pop(); if (seen.has(f) || !existsSync(f)) continue; seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) { const r = resolveSpec(m[1], f); if (r && !seen.has(r)) stack.push(r); } }
  return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
}

test('analytics query engine graph reaches no action module', () => {
  const g = graphFrom([
    path.join(ROOT, 'desktop/analytics/query/analytics-query-engine.cjs'),
    path.join(ROOT, 'desktop/analytics/query/analytics-filter.cjs'),
    path.join(ROOT, 'desktop/analytics/query/statistics.cjs'),
    path.join(ROOT, 'desktop/analytics/query/confidence.cjs'),
  ]);
  for (const mod of FORBIDDEN) assert.ok(!g.includes(mod), `forbidden reachable: ${mod}`);
});

test('analytics-main exposes read-only stats channels, no executeSQL/action/send', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-main.cjs'), 'utf8');
  const handlers = [...src.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const h of handlers) assert.ok(h.startsWith('analytics-'), `non-analytics channel: ${h}`);
  assert.ok(handlers.includes('analytics-stats-overview'));
  assert.ok(handlers.includes('analytics-stats-streaks'));
  const code = src.replace(/\/\/[^\n]*/g, '').toLowerCase();
  for (const bad of ['executesql', 'exec-sql', 'read-file', 'sendraw', 'sendprotocol', 'ws-send', 'protocol-execute']) {
    assert.ok(!code.includes(bad), `analytics-main must not expose ${bad}`);
  }
});

test('preload stats API is read-only and namespaced', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-preload.cjs'), 'utf8');
  const channels = [...src.matchAll(/invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const ch of channels) assert.ok(ch.startsWith('analytics-'), `unexpected channel ${ch}`);
  assert.ok(channels.some((c) => c.startsWith('analytics-stats-')));
  const code = src.replace(/\/\/[^\n]*/g, '').toLowerCase();
  for (const bad of ['executesql', 'sendraw', 'sendprotocol', 'replay', 'cashout']) assert.ok(!code.includes(bad));
});

test('engine exposes no send/exec surface', () => {
  const { AnalyticsQueryEngine } = require('../../desktop/analytics/query/analytics-query-engine.cjs');
  const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
  const store = new AnalyticsStore({ file: ':memory:' });
  const e = new AnalyticsQueryEngine({ store });
  for (const m of ['executeSQL', 'exec', 'send', 'sendProtocol', 'bet', 'cashout', 'replay']) assert.equal(typeof e[m], 'undefined');
  store.close();
});
