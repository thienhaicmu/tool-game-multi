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
  'desktop/protocol/aviator.cjs', 'desktop/protocol/round-observer.cjs',
  'desktop/replay/replay-engine.cjs', 'desktop/replay/diff.cjs',
];

function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.') && !path.isAbsolute(spec)) return null; // builtin / node_modules (e.g. better-sqlite3)
  const abs = path.resolve(path.dirname(fromFile), spec);
  for (const c of [abs, abs + '.cjs', abs + '.js', path.join(abs, 'index.cjs')]) if (existsSync(c)) return c;
  return null;
}
function graphFrom(entries) {
  const seen = new Set(); const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const r = resolveSpecifier(m[1], f); if (r && !seen.has(r)) stack.push(r);
    }
  }
  return [...seen].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
}

// The persistence graph (store + write path + assembler) must not reach any action module.
test('analytics persistence graph reaches no forbidden/action module', () => {
  const graph = graphFrom([
    path.join(ROOT, 'desktop/analytics/db/analytics-store.cjs'),
    path.join(ROOT, 'desktop/analytics/persistence.cjs'),
    path.join(ROOT, 'desktop/analytics/round-assembler.cjs'),
  ]);
  for (const mod of FORBIDDEN) assert.ok(!graph.includes(mod), `forbidden module reachable: ${mod}`);
  // the pure classifier IS shared (allowed)
  assert.ok(graph.includes('desktop/protocol/frame-classify.cjs'));
});

// The full Analytics app graph (now incl. DB) still has no action module.
test('analytics-main graph still closed after DB integration', () => {
  const graph = graphFrom([path.join(ROOT, 'desktop/analytics-main.cjs'), path.join(ROOT, 'desktop/analytics-preload.cjs')]);
  for (const mod of FORBIDDEN) assert.ok(!graph.includes(mod), `forbidden module reachable: ${mod}`);
  assert.ok(graph.includes('desktop/analytics/db/analytics-store.cjs'));
  assert.ok(graph.includes('desktop/analytics/persistence.cjs'));
});

// §28 — no generic/dangerous IPC (executeSQL / arbitrary file read / protocol send).
test('analytics-main exposes no executeSQL / raw-SQL / file / send IPC', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-main.cjs'), 'utf8');
  const handlers = [...src.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const h of handlers) assert.ok(h.startsWith('analytics-'), `non-analytics channel: ${h}`);
  const code = src.replace(/\/\/[^\n]*/g, '').toLowerCase();
  for (const bad of ['executesql', 'exec-sql', 'read-file', 'readfile(', 'sendprotocol', 'sendraw', 'ws-send']) {
    assert.ok(!code.includes(bad), `analytics-main must not expose ${bad}`);
  }
});

test('analytics preload still passive: query + lifecycle only, no exec/send', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-preload.cjs'), 'utf8');
  const channels = [...src.matchAll(/invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const ch of channels) assert.ok(ch.startsWith('analytics-'), `unexpected channel ${ch}`);
  const code = src.replace(/\/\/[^\n]*/g, '').toLowerCase();
  for (const bad of ['executesql', 'sendraw', 'sendprotocol', 'replay', 'bet', 'cashout']) {
    assert.ok(!code.includes(bad), `preload must not expose ${bad}`);
  }
});

// §52/§53 — store & write path expose no send/exec surface.
test('AnalyticsStore and AnalyticsPersistence expose no send/executeSQL surface', () => {
  const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
  const { AnalyticsPersistence } = require('../../desktop/analytics/persistence.cjs');
  const store = new AnalyticsStore({ file: ':memory:' });
  const p = new AnalyticsPersistence({ store });
  for (const m of ['executeSQL', 'exec', 'send', 'sendRaw', 'sendProtocol', 'bet', 'cashout', 'replay']) {
    assert.equal(typeof store[m], 'undefined', `store must not expose ${m}`);
    assert.equal(typeof p[m], 'undefined', `persistence must not expose ${m}`);
  }
  store.close();
});
