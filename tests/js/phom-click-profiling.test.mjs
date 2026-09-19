// PHASE 6.3.2.10 — CLICK LATENCY PROFILING instrumentation (gated, minimal, no behaviour change). Asserts
// the profiling hooks exist so the click→visual round-trip and main-side handler duration can be captured
// live. This phase adds NO fix — only measurement. All hooks are gated behind env flags (no prod spam).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const gh = require('../../desktop/protocol/phom/game-header.cjs');
const main = read('desktop/phom-main.cjs');

test('page-side click→render round-trip is instrumented in ONE clock (gated by clickLog)', () => {
  const on = gh.bootScript({ clickLog: true });
  const off = gh.bootScript({ clickLog: false });
  assert.match(on, /const CLICKLOG = true/);
  assert.match(off, /const CLICKLOG = false/);
  // stamp at click (CLICK_START) …
  assert.match(on, /if\(CLICKLOG\)\{ window\.__phClickT=CLK\(\); window\.__phClickA=action; try\{ console\.log\('\[PHOM-CLK\] CLICK_START'/);
  // … and report the round-trip at the next header render (CLICK_TO_RENDER), single page clock.
  assert.match(on, /if\(CLICKLOG && window\.__phClickT!=null\)\{ try\{ console\.log\('\[PHOM-CLK\] CLICK_TO_RENDER'/);
  // uses a monotonic hi-res timer when available (not Date.now as primary)
  assert.match(on, /performance && performance\.now\) \? function\(\)\{ return performance\.now\(\)/);
});

test('main passes the click-profiling gate and it is OFF unless the env flag is set', () => {
  assert.match(main, /clickLog: process\.env\.PHOM_CLICK_LOG === '1' \|\| process\.env\.PHOM_HEADER_LOG === '1'/);
});

test('main-side handler duration (M1→M4) is measured with a monotonic clock for EVERY action', () => {
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('function liveRunCount('));
  assert.match(r, /const _t0 = nowMs\(\);/);
  assert.match(r, /headerLog\('action-done',[\s\S]*?elapsedMs: Math\.round\(nowMs\(\) - _t0\)/);
  // ENTER_GAME already reports click→ENTERED evidence latency (from 6.3.2.6)
  assert.match(main, /ENTER_GAME_EVIDENCE'[\s\S]*?elapsedMs: Math\.round\(nowMs\(\) - headerEnterStartedAt\[rid\]\)/);
});

test('profiling did NOT reintroduce a per-frame CDP verify or a fix (dedupe + narrow observer intact)', () => {
  // dedupe still gates the only per-push evaluate
  assert.match(main, /if \(headerLastPushed\[rid\] === json\) continue;/);
  // observer stays narrow (no subtree:true) — profiling didn't touch it
  const src = gh.bootScript();
  assert.equal(/subtree: true/.test(src), false);
});
