import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Screen-2 monitor source truthfulness (LIVE_INTERNAL default vs explicit FIXTURE_REPLAY).
// Source-level assertions, sliced to the specific function bodies so they are meaningful:
// the LIVE view must never auto-load / display the bundled D fixture as if it were live.
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');

const between = (from, to) => { const a = js.indexOf(from); const b = to ? js.indexOf(to, a + 1) : js.length; return js.slice(a, b > a ? b : js.length); };
const liveBody = () => between('function renderLiveMonitorInto(', 'function liveUpdatedLabel(');
const replayBody = () => between('function renderReplayMonitorInto(', 'function cardRow(');
const chooserBody = () => between('function liveMonitor(', 'function liveConnState(');

test('default monitor source is LIVE_INTERNAL', () => {
  assert.match(js, /const MON = \{ LIVE: 'LIVE_INTERNAL', REPLAY: 'FIXTURE_REPLAY' \}/);
  assert.match(js, /let monitorMode = MON\.LIVE/);
});

test('liveMonitor auto-loads the fixture ONLY in explicit REPLAY mode (never in LIVE)', () => {
  const chooser = chooserBody();
  // fixture load is gated behind the REPLAY branch; the LIVE branch renders the live view.
  assert.match(chooser, /monitorMode === MON\.REPLAY[^]*qaMonitorEnsure\(\)[^]*renderReplayMonitorInto/);
  assert.match(chooser, /else renderLiveMonitorInto/);
  // the LIVE renderer must not touch the fixture engine at all (no auto-load, no fallback).
  const live = liveBody();
  assert.equal(/qaMonitorEnsure|qaMonitorLoad|qaSnap|qaMonitorControl/.test(live), false,
    'LIVE view must never reference the D fixture engine');
});

test('LIVE idle state: waiting text, no cards, no x/y counter, no playback controls', () => {
  const live = liveBody();
  assert.match(live, /ĐANG CHỜ DỮ LIỆU LIVE/);
  assert.match(live, /Chưa nhận được ván/);
  // the "not connected" badge is a real string and is what the idle (CONNECTING) state shows.
  assert.match(js, /CONNECTING: 'LIVE INTERNAL · CHƯA KẾT NỐI'/);
  assert.match(live, /LIVE_BADGE\[conn\]/);
  // no fixture-style event counter anywhere in the LIVE view
  assert.equal(/Sự kiện /.test(live), false, 'no "Sự kiện x/y" in LIVE mode');
  // no playback transport controls in the LIVE view
  assert.equal(/qaMonitorPlay|qaMonitorStep|'▶'|'⏸'|'⏮'|'⏭'|'⟲'/.test(live), false,
    'no Play/Pause/Prev/Next/Reset in LIVE mode');
});

test('LIVE badge is LIVE INTERNAL; header is LIVE QA MONITOR', () => {
  const live = liveBody();
  assert.match(live, /LIVE QA MONITOR/);
  assert.match(live, /mon-srcbadge live/);
  assert.equal(/D — MÔ PHỎNG/.test(live), false, 'the LIVE view never wears the replay badge');
});

test('REPLAY mode is explicit-only, carries playback + Sự kiện x/y, and the D badge (never LIVE)', () => {
  const replay = replayBody();
  assert.match(replay, /MÔ PHỎNG \/ REPLAY/);
  assert.match(replay, /D — MÔ PHỎNG/);
  assert.match(replay, /Sự kiện \$\{snap\.counters\.currentEvent\}\/\$\{snap\.counters\.totalEvents\}/);
  assert.match(replay, /qaMonitorPlay|qaMonitorStep/);
  assert.equal(/mon-srcbadge live|LIVE INTERNAL/.test(replay), false, 'REPLAY must never show a LIVE badge');
  // entering REPLAY is a user action (explicit selector button), not an automatic fallback.
  assert.match(js, /onclick: \(\) => setMonitorMode\(MON\.REPLAY\)/);
});

test('switching REPLAY → LIVE clears the simulated snapshot and stops playback', () => {
  const set = between('function setMonitorMode(', 'function renderReplayMonitorInto(');
  assert.match(set, /if \(monitorMode === MON\.LIVE\) \{ qaMonitorPlay\(false\); qaSnap = null; \}/);
});

test('a live frame updates ONLY its owning profile (no cross-profile copy); missing hand ⇒ UNKNOWN', () => {
  const owner = between('function liveHandForSlot(', 'function renderLiveMonitorInto(');
  // resolves the slot's OWN profileId, then finds the hand whose profileId matches it.
  assert.match(owner, /clusterSnap\.profiles && clusterSnap\.profiles\[slot\]/);
  assert.match(owner, /hands \|\| \[\]\)\.find\(\(x\) => x\.profileId === cp\.profileId\)/);
  // only an AUTHORITATIVE hand counts; otherwise null ⇒ UNKNOWN (no D fallback, no fabrication).
  assert.match(owner, /h\.authoritative \? h : null/);
  const live = liveBody();
  assert.match(live, /UNKNOWN/);
  assert.equal(/basic-round|simulatedOwner|D sample|qaSnap/.test(live), false, 'no fixture/D fallback in LIVE');
});

test('LIVE view re-derives from the live session each render (round change clears prior rows)', () => {
  const live = liveBody();
  assert.match(live, /mon\.replaceChildren\(\)/);           // full rebuild each render
  assert.match(live, /hostTableIdentity && s\.hostTableIdentity\.channelRid/); // keyed on the live round
});

test('DỪNG stop path does not close browsers and does not force a fixture load', () => {
  const stop = between('async function stopOrchestration()', 'async function closeBrowsers()');
  assert.equal(/api\.closeBrowsers|api\.clusterStop|closeRun/.test(stop), false, 'DỪNG never closes browsers');
  assert.match(stop, /qaMonitorPlay\(false\)/);              // unsubscribe playback only
});
