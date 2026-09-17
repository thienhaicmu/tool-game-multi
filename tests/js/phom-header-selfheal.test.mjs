// PHASE 6.3.2.7 — the in-Chromium header must never silently vanish: a real in-PAGE MutationObserver
// re-mounts #__phom_header when a Cocos/SPA bootstrap removes it, and the page reports its REAL DOM presence
// so the Tool shows HEADER=Sẵn sàng only when the bar actually exists. No per-WS-frame CDP verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const gh = require('../../desktop/protocol/phom/game-header.cjs');
const main = read('desktop/phom-main.cjs');

// ---- page-side self-heal (bootScript) — NARROW observers, never the whole game DOM (§2/§3) ----
test('bootScript uses NARROW childList observers (html + body, subtree:false) — not the whole game DOM', () => {
  const src = gh.bootScript({ slotId: 'B1', profileId: 'p', runId: 'r' });
  assert.match(src, /new MutationObserver/);
  // L1 — <html> childList only (body replace/create); L2 — <body> childList only (header removed).
  assert.match(src, /observe\(document\.documentElement, \{ childList: true, subtree: false \}\)/);
  assert.match(src, /observe\(document\.body, \{ childList: true, subtree: false \}\)/);
  // NEVER a whole-DOM observer, and NEVER attributes/characterData.
  assert.equal(/subtree: true/.test(src), false, 'no subtree:true whole-DOM observation');
  assert.equal(/attributes: true|characterData: true/.test(src), false, 'no attributes/characterData observation');
  assert.match(src, /addEventListener\('pagehide'[\s\S]*?disconnect\(\)/); // cleanup on unload (no leak)
});

test('remount is loop-safe + rAF-coalesced (present → no-op; burst → one remount)', () => {
  const src = gh.bootScript();
  assert.match(src, /function scheduleRemount\(\)\{/);
  assert.match(src, /if \(document\.getElementById\('__phom_header'\)\) return;/); // present → no-op (§5)
  assert.match(src, /if \(__remountScheduled\) return; __remountScheduled = true;/); // coalesce burst
  assert.match(src, /requestAnimationFrame\(function\(\)\{ __remountScheduled = false;/);
});

test('bootScript exposes DEBUG-only observer counters (no per-mutation production logging)', () => {
  const src = gh.bootScript();
  assert.match(src, /observerCallbacks:0, mutationRecords:0, remountRequests:0, actualRemounts:0/);
  assert.match(src, /window\.__phomHeaderCounters = __c/);
  assert.match(src, /if\(OBSLOG\)\{ try\{ console\.log\('\[PHOM-HDR\] remount'/); // logs only on real remount, gated
  // main passes the gate from PHOM_HEADER_OBSERVER_LOG
  assert.match(main, /observerLog: process\.env\.PHOM_HEADER_OBSERVER_LOG === '1'/);
});

// PHASE 6.3.8 — the header is a COMPACT, FLOATING, single-row control (not a full-width 3-column bar): a
// draggable identity handle (badge+name+status), the state-dependent action row, then the ⋮/─ controls.
test('§13 header layout is a compact floating single row (badge/handle · actions · menu)', () => {
  const src = gh.bootScript();
  assert.match(src, /position:fixed;top:8px;right:8px/);          // floating top-right (not full-width)
  assert.match(src, /display:flex;align-items:center/);           // single flex row
  assert.match(src, /const handle = mk\('div','display:flex;align-items:center;gap:7px;cursor:move/); // draggable identity area
  assert.match(src, /const act = mk\('div',/);                    // state-dependent action row
  assert.match(src, /bar\.appendChild\(handle\); bar\.appendChild\(act\); bar\.appendChild\(menuWrap\)/);
});

test('bootScript reports REAL DOM presence to main on mount/remount (__HEADER_STATUS), not per frame', () => {
  const src = gh.bootScript();
  assert.match(src, /function emitStatus\(\)\{[\s\S]*?action:'__HEADER_STATUS', present:true/);
  // emitStatus is called from ready() only when the bar is actually (re)appended
  assert.match(src, /document\.body\.appendChild\(bar\); emitStatus\(\);/);
});

test('mount is idempotent (guarded) — repeated boot keeps exactly one header', () => {
  const src = gh.bootScript();
  assert.match(src, /if \(window\.__phomHeaderInstalled\) \{ if \(!document\.getElementById\('__phom_header'\) && window\.__phomHeaderMount\) window\.__phomHeaderMount\(\); return; \}/);
  // ready() only appends when the bar is not already present (no duplicates)
  assert.match(src, /if\(!document\.getElementById\('__phom_header'\)\)\{ document\.body\.appendChild\(bar\)/);
});

// ---- main-side truth + resync (no storm) ----
test('main records header DOM presence from the page signal and force-repushes state on (re)mount', () => {
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('async function phomHeaderAction(') + 1200);
  assert.match(r, /if \(action === '__HEADER_STATUS'\)/);
  assert.match(r, /headerDomPresent\[rid\] = !!\(payload && payload\.present\)/);
  assert.match(r, /delete headerLastPushed\[rid\];/); // force re-push so the fresh bar is re-filled
  assert.match(r, /return \{ ok: true, internal: true \}/);
});

test('Tool HEADER indicator is DOM-truthful: READY needs cdp+binding+DOM; RECOVERING when DOM missing', () => {
  assert.match(main, /if \(cdp && headerReady\[rid\]\) header = headerDomPresent\[rid\] \? 'READY' : 'RECOVERING'/);
  // presence is cleared on detach AND reload so the indicator can never stay a stale Sẵn sàng
  assert.match(main, /headerDomPresent\[String\(run\.id\)\] = false/);        // detach
  assert.match(main, /headerDomPresent\[rid\] = false/);                      // reload reset (reloadWebRun)
});

test('NO CDP-storm regression: header DOM is NOT verified per WS frame (event-driven signal only)', () => {
  // pushHeaderStates still dedupes; the DOM-presence check lives in the page (__HEADER_STATUS), not a
  // per-frame Runtime.evaluate. The only evaluate on push is the (deduped) render.
  const fn = main.slice(main.indexOf('function pushHeaderStates('), main.indexOf('function pushHeaderStates(') + 1900);
  assert.match(fn, /if \(headerLastPushed\[rid\] === json\) continue;/);
  assert.equal(/verifyPresent|getElementById/.test(fn), false, 'no per-push DOM verify round-trip');
});

test('renderer shows the 3-state header (Sẵn sàng / Đang khôi phục / Chưa sẵn sàng)', () => {
  const js = read('ui-phom/phom-qa.js');
  assert.match(js, /hdr === 'READY' \? 'Sẵn sàng' : hdr === 'RECOVERING' \? 'Đang khôi phục' : 'Chưa sẵn sàng'/);
});
