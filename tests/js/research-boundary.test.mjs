import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Prediction/Research subsystem boundary (§78/§79). The Algorithm Research &
// Evaluation platform must stay ACTION-INDEPENDENT: it may read captured rounds
// and write ONLY its own research_* tables, but must NEVER reach a bet / cashout /
// protocol-send / entry / recovery / replay path. This static guard fails the build
// if a future edit silently grants the research platform action capability.
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESEARCH_DIR = path.join(ROOT, 'desktop', 'analytics', 'research');

const ENTRIES = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith('.cjs')).map((f) => path.join(RESEARCH_DIR, f));

// Action / send-bearing / recovery modules the research platform must never reach.
const FORBIDDEN_MODULES = [
  'desktop/cdp/ws-replay.cjs', 'desktop/cdp/intercept.cjs',
  'desktop/protocol/auto-runner.cjs', 'desktop/protocol/harness.cjs', 'desktop/protocol/amount-validator.cjs',
  'desktop/protocol/aviator-entry.cjs', 'desktop/protocol/jackpot-gate.cjs', 'desktop/protocol/stop1000-guard.cjs',
  'desktop/protocol/aviator.cjs', 'desktop/replay/replay-engine.cjs',
  'desktop/analytics/analytics-aviator-entry.cjs', 'desktop/analytics/entry-only-transport.cjs', 'desktop/analytics/analytics-context-recovery.cjs',
];
const FORBIDDEN_TOKENS = ['sendraw', 'sendprotocol', 'ws-send', 'place bet', 'cashout', 'bet(', 'auto-runner', 'jackpot-gate', 'stop1000', 'entry-only', 'aviator-entry', 'context-recovery', 'session-recovery'];

function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.') && !path.isAbsolute(spec)) return null; // builtin / node_modules (e.g. crypto)
  const abs = path.resolve(path.dirname(fromFile), spec);
  for (const c of [abs, abs + '.cjs', abs + '.js', path.join(abs, 'index.cjs')]) if (existsSync(c)) return c;
  return null;
}
function buildGraph(entries) {
  const seen = new Set(); const stack = [...entries];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) { const r = resolveSpecifier(m[1], file); if (r) stack.push(r); }
  }
  return seen;
}
const graphRel = [...buildGraph(ENTRIES)].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

test('research subsystem has ≥6 modules incl. registry/fingerprint/service', () => {
  assert.ok(ENTRIES.length >= 6, 'research modules present');
  for (const f of ['algorithm-registry.cjs', 'fingerprint.cjs', 'research-engine.cjs', 'research-service.cjs', 'comparison.cjs', 'drift.cjs', 'quality.cjs']) {
    assert.ok(existsSync(path.join(RESEARCH_DIR, f)), 'missing ' + f);
  }
});

for (const mod of FORBIDDEN_MODULES) {
  test(`research graph does NOT reach ${mod}`, () => {
    assert.ok(!graphRel.includes(mod), `FORBIDDEN module reachable from research subsystem: ${mod}`);
  });
}

test('research source contains no action / send / entry / recovery tokens', () => {
  for (const f of ENTRIES) {
    const src = readFileSync(f, 'utf8').toLowerCase().replace(/\/\/[^\n]*/g, '');
    for (const tok of FORBIDDEN_TOKENS) assert.ok(!src.includes(tok), `${path.basename(f)} must not reference "${tok}"`);
  }
});

test('research-service reads captured rounds READ-ONLY (SELECT COMPLETE only; no round/capture writes)', () => {
  const src = readFileSync(path.join(RESEARCH_DIR, 'research-service.cjs'), 'utf8');
  assert.ok(/completeness='COMPLETE'/.test(src) && /SELECT/.test(src), 'reads completed rounds');
  // The service itself must not issue DML; all persistence is delegated to ResearchRepo (research_* tables).
  for (const dml of ['INSERT', 'UPDATE ', 'DELETE', 'DROP', 'ALTER']) assert.ok(!src.includes(dml), `service must not issue ${dml}`);
});

test('research persistence writes ONLY research_* tables (never capture/round history)', () => {
  const raw = readFileSync(path.join(ROOT, 'desktop', 'analytics', 'db', 'repositories', 'research-repo.cjs'), 'utf8');
  const src = raw.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments (prose like "never UPDATE a run")
  // Real table-targeted DML only: INSERT INTO <t>, DELETE FROM <t>, UPDATE <t> SET (the
  // upsert's "DO UPDATE SET" has no table token between UPDATE and SET, so it is excluded).
  const writes = [
    ...[...src.matchAll(/INSERT INTO\s+([a-z_]+)/gi)].map((m) => m[1]),
    ...[...src.matchAll(/DELETE FROM\s+([a-z_]+)/gi)].map((m) => m[1]),
    ...[...src.matchAll(/UPDATE\s+([a-z_]+)\s+SET/gi)].map((m) => m[1]),
  ].map((t) => t.toLowerCase());
  assert.ok(writes.length > 0, 'repo performs writes');
  for (const t of writes) assert.ok(t.startsWith('research_'), `write target must be research_*, found: ${t}`);
  // Must never write protected capture/round tables.
  for (const protectedT of ['rounds', 'capture_sessions', 'raw_protocol_events', 'round_metrics', 'raw_ws_events']) {
    assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${protectedT}\\b`, 'i').test(src), `must not write ${protectedT}`);
  }
});
