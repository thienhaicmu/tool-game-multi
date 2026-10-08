// MEMORY WATCH (2026-10-08): a logged-in browser's main process grew ~200 MB/s to 15 GB and froze the machine. The tool
// samples the browsers it launched and closes one that runs away. The decisions are pure; the wiring is source-checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const W = require('../../desktop/browser/browser-memory-watch.cjs');
const MB = 1048576;
const DIR = 'C:\\Users\\u\\AppData\\Roaming\\Phom QA\\phom\\browser-profiles-chrome\\P1';

test('summarize: groups a browser by its user-data-dir — main + its renderers (children carry no user-data-dir)', () => {
  const rows = [
    { p: 10, q: 1, t: 'main', u: DIR, m: 15527 * MB },
    { p: 11, q: 10, t: 'renderer', u: '', m: 800 * MB },
    { p: 12, q: 10, t: 'gpu-process', u: '', m: 300 * MB },
    { p: 20, q: 1, t: 'main', u: DIR.replace('P1', 'P2'), m: 58 * MB },
  ];
  const s = W.summarize(rows);
  const p1 = s.get(W.normDir(DIR));
  assert.deepEqual(p1, { mainPid: 10, mainMb: 15527, rendererMb: 800, totalMb: 16627 });
  assert.equal(s.get(W.normDir(DIR.replace('P1', 'P2'))).mainMb, 58);
  assert.equal(W.summarize(null).size, 0);
  assert.equal(W.summarize({ p: 1, q: 0, t: 'main', u: DIR, m: MB }).size, 1, 'PowerShell prints a lone object without []');
});

test('normDir: one browser found whatever the slashes / case / trailing separator', () => {
  assert.equal(W.normDir('C:/Users/U/Phom QA/phom/browser-profiles/P1/'), W.normDir('c:\\users\\u\\phom qa\\phom\\browser-profiles\\p1'));
});

test('judge: on the MAIN process — 1.5 GB HIGH (logged), 3 GB RUNAWAY (closed); a heavy game tab alone is not judged', () => {
  assert.equal(W.judge({ mainMb: 60, rendererMb: 2500 }), null);
  assert.equal(W.judge({ mainMb: 1600 }), 'HIGH');
  assert.equal(W.judge({ mainMb: 3000 }), 'RUNAWAY');
  assert.equal(W.judge(undefined), null);
  assert.deepEqual(W.DEFAULTS, { intervalMs: 5000, warnMb: 1500, killMb: 3000 });
});

test('sampler: ONE long-lived PowerShell loop (not a process per sample), only chrome.exe of the tool\'s profiles', () => {
  const s = W.samplerScript('C:\\x\\Phom QA\\phom\\browser-profiles', 5000);
  assert.match(s, /while \(\$true\)/);
  assert.match(s, /name='chrome\.exe'/);
  assert.match(s, /-like '\*C:\\x\\Phom QA\\phom\\browser-profiles\*'/);
  assert.match(s, /Start-Sleep -Seconds 5/);
  let spawned = 0;
  const fake = () => { spawned++; return { stdout: { setEncoding() {}, on() {} }, on() {}, unref() {}, kill() {} }; };
  const w = W.createMemoryWatch({ marker: 'X', spawn: fake, platform: 'win32' });
  assert.equal(w.start(), true); assert.equal(w.start(), false, 'started once');
  assert.equal(spawned, 1);
  assert.equal(W.createMemoryWatch({ marker: 'X', spawn: fake, platform: 'linux' }).start(), false, 'Windows only');
});

// 3.2: the memory-watch FEATURE (started by the first attach; off with PHOM_FEATURES_OFF=memory-watch). Its decisions
// (HIGH once, RUNAWAY close + kill, closed runs skipped) are tested in phom-features.test.mjs; this checks the wiring.
test('wiring: the memory-watch feature samples every run by its profile dir, closes through the tool, stops on quit', () => {
  const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /_memoryFeature = createMemoryWatchFeature\(\{/);
  assert.match(main, /marker: \(\) => profilesRootFor\('chromium'\)/, 'a prefix of both profile roots (Chromium and Chrome)');
  assert.match(main, /closeRun: \(rid\) => closeBrowserRun\(rid\)/);
  const { ALWAYS_RUN_EVENTS } = require('../../desktop/phom/core/logger.cjs');
  for (const e of ['BROWSER_MEMORY_HIGH', 'BROWSER_MEMORY_RUNAWAY']) assert.ok(ALWAYS_RUN_EVENTS.includes(e), e + ' always reaches coseat.jsonl');
  assert.match(main, /if \(_memoryFeature\) _memoryFeature\.stop\(\);/);
  const feature = readFileSync(new URL('../../desktop/phom/features/memory-watch.cjs', import.meta.url), 'utf8');
  assert.match(feature, /attach\(\) \{ start\(\); \}/, 'sampling starts with the first browser');
  assert.match(feature, /killWaitMs = 4000/);
  const ui = readFileSync(new URL('../../ui-phom/phom-qa.js', import.meta.url), 'utf8');
  assert.match(ui, /case 'BROWSER_MEMORY_RUNAWAY':/);
  assert.match(ui, /case 'LOOP_GUARD':/);
});
