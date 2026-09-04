import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveBounds, DEFAULTS } = require('../../desktop/window-state.cjs');
const { ProtocolContext } = require('../../desktop/protocol/protocol-context.cjs');
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');

// app-shell.js + autotest-config.js are browser scripts -> load into a fake window.
function loadUI(rel) { const w = {}; new Function('window', readFileSync(new URL(rel, import.meta.url), 'utf8'))(w); return w; }
const Shell = loadUI('../../ui/app-shell.js').AppShell;
const ATC = loadUI('../../ui/autotest-config.js').AutoTestConfig;

// ---------------------------------------------------------------------------
// §1/§2/§16 — compact window defaults + bounds restore/validation.
// ---------------------------------------------------------------------------
test('fresh launch defaults to 960x680 (no maximize)', () => {
  // WU-E.1 — Overview now hosts the embedded browser workspace, so the default opens at a
  // workspace size; min stays small enough for the 1100x700 acceptance viewport.
  assert.deepEqual(resolveBounds(null), { width: 1300, height: 860 });
  assert.deepEqual(resolveBounds(undefined), { width: 1300, height: 860 });
  assert.equal(DEFAULTS.minWidth, 1000);
  assert.equal(DEFAULTS.minHeight, 680);
});

test('valid saved bounds are restored (incl. position)', () => {
  assert.deepEqual(resolveBounds({ width: 1200, height: 800, x: 40, y: 60 }), { width: 1200, height: 800, x: 40, y: 60 });
  assert.deepEqual(resolveBounds({ width: 1100, height: 700 }), { width: 1100, height: 700 });
});

test('invalid / too-small / malformed bounds fall back to default', () => {
  assert.deepEqual(resolveBounds({ width: 100, height: 100 }), { width: 1300, height: 860 }, 'below min');
  assert.deepEqual(resolveBounds({ width: 'x', height: 720 }), { width: 1300, height: 860 }, 'NaN width');
  assert.deepEqual(resolveBounds({ width: 99999, height: 720 }), { width: 1300, height: 860 }, 'absurd width');
  assert.deepEqual(resolveBounds({}), { width: 1300, height: 860 });
});

test('main.cjs opens the window with resolveBounds (no maximize/fullscreen)', () => {
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.ok(/new BrowserWindow\(\{ \.\.\.bounds/.test(main), 'uses resolved bounds');
  assert.ok(/resolveBounds\(loadWindowState\(\)\)/.test(main));
  assert.ok(!/\.maximize\(\)/.test(main) && !/fullscreen:\s*true/.test(main), 'no maximize/fullscreen');
});

// ---------------------------------------------------------------------------
// §3/§4 — the Auto-Run CTA changes by state.
// ---------------------------------------------------------------------------
test('autoCta: READY / RUNNING / COMPLETED / STOPPED labels + actions', () => {
  // WU-D.1 — the one Auto CTA is Vietnamese in the final product UI.
  assert.deepEqual(Shell.autoCta('IDLE', false), { action: 'start', label: '▶ BẮT ĐẦU TỰ ĐỘNG', note: '', cls: 'primary' });
  assert.equal(Shell.autoCta('WATCHING_ODD', true).action, 'stop');
  assert.equal(Shell.autoCta('WATCHING_ODD', true).label, '■ DỪNG TỰ ĐỘNG');
  assert.equal(Shell.autoCta('COMPLETED', false).label, '↻ CHẠY LẠI');
  assert.equal(Shell.autoCta('COMPLETED', false).note, 'Tự dừng — đã chạy hết lượt');
  assert.equal(Shell.autoCta('STOPPED', false).label, '▶ BẮT ĐẦU LẠI');
  assert.equal(Shell.autoCta('STOPPED', false).note, 'Bạn đã nhấn Dừng');
});

// ---------------------------------------------------------------------------
// §14/§15 — START AUTO RUN maps to autotestStart(config) with session aid/eid.
// ---------------------------------------------------------------------------
test('config pass-through maps Rounds/Amount/Odd + session aid/eid', () => {
  const v = ATC.validate({ rounds: '7', amount: '7777', stopOdd: '2.5', aid: 3, eid: 9 });
  assert.deepEqual(v.config, { roundCount: 7, amount: 7777, stopOdd: 2.5, aid: 3, eid: 9 });
});

// ---------------------------------------------------------------------------
// Protocol Context ownership — aid/eid learned from frames, not hardcoded.
// ---------------------------------------------------------------------------
test('ProtocolContext is NOT ready until a frame with aid+eid is seen', () => {
  const ctx = new ProtocolContext();
  assert.deepEqual(ctx.get(), { aid: null, eid: null, ready: false, at: null });
  ctx.observe({ cmd: 100005, sid: 100 });          // no aid/eid -> still not ready
  assert.equal(ctx.get().ready, false);
  ctx.observe({ cmd: 100002, aid: 4, eid: 8, sid: 100 });
  const g = ctx.get();
  assert.equal(g.ready, true); assert.equal(g.aid, 4); assert.equal(g.eid, 8);
});

test('ProtocolContext adopts the FIRST pair and keeps it stable', () => {
  const ctx = new ProtocolContext();
  ctx.observe({ aid: 1, eid: 1 });
  ctx.observe({ aid: 99, eid: 99 }); // must not change mid-session
  assert.equal(ctx.get().aid, 1); assert.equal(ctx.get().eid, 1);
  ctx.reset();
  assert.equal(ctx.get().ready, false);
});

test('ProtocolContext learns aid/eid from the observed frame stream (via RoundTracker)', () => {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const ctx = new ProtocolContext({ roundTracker: tracker });
  let changed = 0; ctx.on('change', () => changed++);
  tracker.observe({ direction: 'recv', raw: '{"cmd":100005,"sid":2986908}' });   // no aid/eid
  assert.equal(ctx.get().ready, false);
  tracker.observe({ direction: 'send', raw: '{"cmd":100002,"b":5000,"sid":2986908,"aid":1,"eid":1}' });
  assert.equal(ctx.get().ready, true);
  assert.equal(ctx.get().aid, 1); assert.equal(ctx.get().eid, 1);
  assert.ok(changed >= 1);
});

test('ProtocolContext can become ready from the MiniGame login frame', () => {
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const ctx = new ProtocolContext({ roundTracker: tracker });
  tracker.observe({ direction: 'send', raw: '[1,"MiniGame","","",{"agentId":"1","accessToken":"redacted","reconnect":false}]' });
  assert.equal(ctx.get().ready, true);
  assert.equal(ctx.get().aid, 1);
  assert.equal(ctx.get().eid, 1);
});

// ---------------------------------------------------------------------------
// UI wiring: aid/eid are no longer editable; Overview shows AID/EID + waiting.
// ---------------------------------------------------------------------------
test('aid/eid inputs removed from Auto Run/Amount Check; overview + waiting-for-login present', () => {
  const html = readFileSync(new URL('../../ui/product.html', import.meta.url), 'utf8');
  assert.ok(!/id="at-aid"/.test(html) && !/id="at-eid"/.test(html), 'Auto Run has no aid/eid inputs');
  assert.ok(!/id="bv-aid"/.test(html) && !/id="bv-eid"/.test(html), 'Amount Check has no aid/eid inputs');
  assert.ok(/id="at-cta"/.test(html), 'Auto Run CTA present');
  assert.ok(/id="ov-aid"/.test(html) && /id="ov-eid"/.test(html), 'Overview shows AID/EID');
  assert.ok(/id="shell-license"/.test(html), 'Appbar shows license remaining days');
  assert.ok(/Waiting for login context/.test(readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8')), 'waiting-for-login gate');
});

test('product.js sources aid/eid from protoCtx (never hardcoded field)', () => {
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  assert.ok(/aid: protoCtx\.aid/.test(js) && /eid: protoCtx\.eid/.test(js), 'Auto/Manual use session context');
  assert.ok(/aid: protoCtx\.aid, eid: protoCtx\.eid/.test(js), 'Amount Check uses session context');
});

test('auto run completion waits for the user instead of starting the next session', () => {
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  const completedBlock = js.match(/if \(sequenceRunning && s && s\.state === 'COMPLETED'\) \{([\s\S]*?)\n    \}/);
  assert.ok(completedBlock, 'completion handler exists');
  assert.ok(/sequenceRunning = false/.test(completedBlock[1]), 'completion stops the sequence');
  assert.ok(!/startCurrentRow/.test(completedBlock[1]), 'completion does not auto-start another session');
});
