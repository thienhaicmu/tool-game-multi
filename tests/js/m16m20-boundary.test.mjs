import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORBIDDEN = [
  'desktop/cdp/ws-replay.cjs', 'desktop/cdp/intercept.cjs',
  'desktop/protocol/auto-runner.cjs', 'desktop/protocol/harness.cjs', 'desktop/protocol/amount-validator.cjs',
  'desktop/protocol/aviator-entry.cjs', 'desktop/protocol/jackpot-gate.cjs', 'desktop/protocol/stop1000-guard.cjs',
  'desktop/protocol/aviator.cjs', 'desktop/protocol/round-observer.cjs', 'desktop/replay/replay-engine.cjs', 'desktop/replay/diff.cjs',
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

test('full Analytics graph (with web log + network collection) reaches no action module', () => {
  const graph = graphFrom([path.join(ROOT, 'desktop/analytics-main.cjs'), path.join(ROOT, 'desktop/analytics-preload.cjs')]);
  for (const mod of FORBIDDEN) assert.ok(!graph.includes(mod), `forbidden reachable: ${mod}`);
  // new passive modules ARE reachable
  assert.ok(graph.includes('desktop/analytics/query/web-log-query.cjs'));
  assert.ok(graph.includes('desktop/analytics/db/repositories/network-repo.cjs'));
  assert.ok(graph.includes('desktop/analytics/db/repositories/ws-repo.cjs'));
});

test('runtime passive capture uses NO WS send/injection primitives', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics/analytics-runtime.cjs'), 'utf8').replace(/\/\/[^\n]*/g, '');
  // getResponseBody (passive body retrieval) IS allowed:
  assert.ok(src.includes('getResponseBody'), 'expected passive getResponseBody');
  // sending / injection primitives are NOT:
  for (const bad of ['Runtime.evaluate', 'addScriptToEvaluateOnNewDocument', 'wsReplay', 'sendProtocol', 'sendRaw', 'Fetch.enable']) {
    assert.ok(!src.includes(bad), `runtime must not use ${bad}`);
  }
});

test('preload exposes web log + network read APIs but no replay/resend/edit/intercept', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-preload.cjs'), 'utf8');
  const channels = [...src.matchAll(/invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const ch of channels) assert.ok(ch.startsWith('analytics-'), `unexpected channel ${ch}`);
  assert.ok(channels.includes('analytics-weblog-query'));
  assert.ok(channels.includes('analytics-net-overview'));
  const code = src.replace(/\/\/[^\n]*/g, '').toLowerCase();
  for (const bad of ['replay', 'resend', 'editrequest', 'continuerequest', 'abortrequest', 'sendrequest', 'sendraw', 'sendprotocol', 'executesql']) {
    assert.ok(!code.includes(bad), `preload must not expose ${bad}`);
  }
});

test('analytics-main network IPC handlers are all analytics-* and read-only', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-main.cjs'), 'utf8');
  const handlers = [...src.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const h of handlers) assert.ok(h.startsWith('analytics-'), `non-analytics channel ${h}`);
  assert.ok(handlers.includes('analytics-weblog-query') && handlers.includes('analytics-net-overview'));
  const code = src.replace(/\/\/[^\n]*/g, '').toLowerCase();
  for (const bad of ['executesql', 'sendrequest', 'replay', 'resend', 'fetch.continue', 'intercept']) assert.ok(!code.includes(bad), `main must not expose ${bad}`);
});
