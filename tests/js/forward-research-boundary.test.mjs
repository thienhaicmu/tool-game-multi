import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Coexistence guard (integration WU): the Analytics product now independently owns an
// entry-only re-entry capability (analytics-aviator-entry / entry-only-transport /
// analytics-context-recovery). The Forward Research SUBSYSTEM must remain PURE / READ-ONLY:
// it may consume historical rounds via its injected store, but must NEVER import or reach
// any action / recovery / protocol-send path. This test enforces that boundary at the
// source level so a future edit cannot silently grant it action capability.
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FR_DIR = path.join(ROOT, 'desktop', 'analytics', 'forward-research');

const FORBIDDEN = [
  'analytics-aviator-entry', 'analytics-context-recovery', 'entry-only-transport',
  'wsReplay', 'ws-replay', 'auto-runner', 'harness', 'amount-validator',
  'jackpot-gate', 'stop1000', 'protocol-context', 'sendRaw', 'sendProtocol',
  'aviator.cjs', 'session-recovery',
];

function frFiles() { return readdirSync(FR_DIR).filter((f) => f.endsWith('.cjs')).map((f) => path.join(FR_DIR, f)); }

test('forward-research subsystem imports ONLY its own sibling modules', () => {
  const files = frFiles();
  assert.ok(files.length >= 6, 'forward-research modules present');
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const requires = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    for (const r of requires) {
      assert.ok(r.startsWith('./'), `${path.basename(file)} may only require siblings, found: ${r}`);
    }
  }
});

test('forward-research subsystem contains NO action / recovery / protocol-send references', () => {
  for (const file of frFiles()) {
    const src = readFileSync(file, 'utf8').toLowerCase();
    for (const bad of FORBIDDEN) {
      assert.ok(!src.includes(bad.toLowerCase()), `${path.basename(file)} must not reference "${bad}" (read-only research boundary)`);
    }
  }
});

test('forward-research runner is READ-ONLY over the store (SELECT-only, no writes)', () => {
  const src = readFileSync(path.join(FR_DIR, 'forward-research.cjs'), 'utf8');
  assert.ok(/completeness='COMPLETE'/.test(src) && /SELECT/.test(src), 'reads completed rounds');
  for (const write of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', '.run(', 'store.rounds', 'persistence']) {
    assert.ok(!src.includes(write), `runner must not write / mutate (found "${write}")`);
  }
});
