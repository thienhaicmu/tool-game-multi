import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Entry points that define the Analytics runtime dependency graph.
const ENTRIES = [
  path.join(ROOT, 'desktop/analytics-main.cjs'),
  path.join(ROOT, 'desktop/analytics-preload.cjs'),
];

// Modules Analytics must NEVER transitively import (action/send-bearing or sealed
// action graph). Matched by absolute path basename tail.
const FORBIDDEN = [
  'desktop/cdp/ws-replay.cjs',
  'desktop/cdp/intercept.cjs',
  'desktop/protocol/auto-runner.cjs',
  'desktop/protocol/harness.cjs',
  'desktop/protocol/amount-validator.cjs',
  'desktop/protocol/aviator-entry.cjs',
  'desktop/protocol/jackpot-gate.cjs',
  'desktop/protocol/stop1000-guard.cjs',
  'desktop/protocol/aviator.cjs',       // sealed RoundTracker + send/ack behaviour
  'desktop/protocol/round-observer.cjs',// sealed
  'desktop/replay/replay-engine.cjs',
  'desktop/replay/diff.cjs',
];

// Resolve a relative/absolute require specifier to an on-disk .cjs path (best effort).
function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.') && !path.isAbsolute(spec)) return null; // node builtin / node_modules
  let abs = path.resolve(path.dirname(fromFile), spec);
  const candidates = [abs, abs + '.cjs', abs + '.js', path.join(abs, 'index.cjs'), path.join(abs, 'index.js')];
  for (const c of candidates) if (existsSync(c) && c.endsWith('.cjs')) return c;
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// Build the transitive require graph by STATIC source scan (catches lazy requires too).
function buildGraph(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const spec of specs) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved && !seen.has(resolved)) stack.push(resolved);
    }
  }
  return seen;
}

const graph = buildGraph(ENTRIES);
const graphRel = [...graph].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

function reachable(rel) { return graphRel.includes(rel); }

// §11 / §19.7-14 — the hard no-action dependency gate.
test('Analytics entry points exist', () => {
  for (const e of ENTRIES) assert.ok(existsSync(e), `${e} must exist`);
});

for (const mod of FORBIDDEN) {
  test(`Analytics graph does NOT reach ${mod}`, () => {
    assert.ok(!reachable(mod), `FORBIDDEN module reachable from Analytics: ${mod}\nGraph: ${graphRel.join(', ')}`);
  });
}

test('Analytics graph contains the expected passive modules only', () => {
  // sanity: the allowed passive modules ARE reachable
  assert.ok(reachable('desktop/analytics/analytics-runtime.cjs'));
  assert.ok(reachable('desktop/analytics/live-state.cjs'));
  assert.ok(reachable('desktop/protocol/frame-classify.cjs'));
  assert.ok(reachable('desktop/protocol/jackpot-observer.cjs'));
  assert.ok(reachable('desktop/cdp/capture.cjs'));
  assert.ok(reachable('desktop/browser/inapp-runtime.cjs'));
});

// §12 / §19.5-6 — preload exposes PASSIVE names only; no action verb anywhere.
test('analytics-preload exposes no action channel or verb', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-preload.cjs'), 'utf8');
  const invokeChannels = [...src.matchAll(/invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const onChannels = [...src.matchAll(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const channels = [...invokeChannels, ...onChannels];
  assert.ok(channels.length > 0, 'expected some IPC channels');
  // every wired channel must be analytics-namespaced and passive
  for (const ch of channels) assert.ok(ch.startsWith('analytics-'), `unexpected channel ${ch}`);
  // Scan CODE only (strip // comments) so our own "no send/replay" docs are not false positives.
  const code = src.replace(/\/\/[^\n]*/g, '').toLowerCase();
  const forbiddenVerbs = ['sendraw', 'sendprotocol', 'ws-send', 'replay', 'bet', 'cashout', 'enter', 'autotest', 'btest', 'bvalidate', 'jackpot-gate', 'protocol-execute'];
  for (const v of forbiddenVerbs) assert.ok(!code.includes(v), `preload code must not expose "${v}"`);
});

// §12 — Analytics main registers no action IPC handler.
test('analytics-main registers only analytics-* passive IPC handlers', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/analytics-main.cjs'), 'utf8');
  const handlers = [...src.matchAll(/ipcMain\.(?:handle|on)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(handlers.length > 0, 'expected some IPC handlers');
  for (const h of handlers) assert.ok(h.startsWith('analytics-'), `non-analytics IPC channel: ${h}`);
  const forbidden = ['ws-send', 'protocol-execute', 'autotest-start', 'bvalidate-start', 'replay-execute'];
  for (const f of forbidden) assert.ok(!handlers.includes(f), `forbidden handler present: ${f}`);
});
