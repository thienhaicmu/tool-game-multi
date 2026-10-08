// 3.2 step 1b — the header and enter-game features, driven through their own API (no Electron, no CDP): the
// behaviour the old phom-main source-pinned tests asserted, now as behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createHeaderFeature, FIND_CONFIRM_MS } = require('../../desktop/phom/features/header.cjs');
const { createEnterGameFeature, AUTO_MAX_TRIES } = require('../../desktop/phom/features/enter-game.cjs');
const { createSessionRegistry } = require('../../desktop/phom/core/session-registry.cjs');
const { evaluateHeaderAction, isBusyExempt } = require('../../desktop/protocol/phom/header-action-guard.cjs');

const tick = () => new Promise((r) => setImmediate(r));

function mkHeader({ routes = {}, auto = false, live = true } = {}) {
  const sessions = createSessionRegistry();
  const logs = []; const evals = []; let refreshes = 0; let t = 1000; let n = 0;
  const client = { Runtime: { evaluate: async (x) => { evals.push(x.expression); return {}; } } };
  const state = { auto, live };
  const f = createHeaderFeature({
    sessions,
    bootScript: (o) => 'BOOT:' + o.nonce,
    installHeader: async (_c, o) => { f._onAction = o.onAction; return { ok: true }; },
    clientFor: () => (state.live ? client : null),
    runOf: (rid) => ({ id: rid, profileId: rid }),
    evaluateHeaderAction,
    isBusyExempt,
    tableActions: new Set(['FIND_TABLE', 'SCAN_TABLE', 'JOIN_CODE', 'REJOIN', 'LEAVE']),
    autoActive: () => state.auto,
    routes,
    deriveHeaderState: (v) => ({ label: v.label, error: v.error || null }),
    stateCode: (v) => v.code || 'IN_GAME',
    log: (e, d) => logs.push([e, d]),
    refresh: () => { refreshes += 1; },
    now: () => t,
    newKey: () => 'key' + (++n),
  });
  return { f, sessions, logs, evals, state, refreshes: () => refreshes, advance: (ms) => { t += ms; } };
}
const run = { id: 'B1', slot: 'A', profileId: 'B1' };
let seq = 0;
const click = (h, action, extra = {}) => h.f.action('B1', { key: 'key1', action, runId: 'B1', profileId: 'B1', actionId: 'a' + (++seq), ...extra });

test('header N3: a click without a key this run was given is refused FIRST — even the DOM-status signal', async () => {
  const h = mkHeader({ routes: { LEAVE: async () => ({ ok: true }) } });
  await h.f.attach({ run, client: {} });
  const forged = await h.f.action('B1', { key: 'nope', action: '__HEADER_STATUS', present: true });
  assert.equal(forged.error.code, 'PHOM_HEADER_FORGED');
  assert.equal(h.f.status('B1').domPresent, false);
  // every key issued to the run stays valid (a page booted by an earlier attach keeps working)
  await h.f.attach({ run, client: {} });
  assert.equal((await h.f.action('B1', { key: 'key1', action: '__HEADER_STATUS', present: true })).ok, true);
  assert.equal((await h.f.action('B1', { key: 'key2', action: '__HEADER_STATUS', present: true })).ok, true);
});

test('header: the page signal records DOM presence and forces a re-push; status = binding + DOM', async () => {
  const h = mkHeader();
  assert.deepEqual(h.f.status('B1'), { ready: false, domPresent: false });
  await h.f.attach({ run, client: {} });
  assert.deepEqual(h.f.status('B1'), { ready: true, domPresent: false }, 'binding up, DOM not confirmed → RECOVERING');
  const view = { label: 'X' };
  h.f.push({ run, session: h.sessions.get('B1'), view: { ...view } });
  h.f.push({ run, session: h.sessions.get('B1'), view: { ...view } });
  assert.equal(h.evals.length, 1, 'an unchanged state skips the CDP evaluate (the storm fix)');
  const r = await h.f.action('B1', { key: 'key1', action: '__HEADER_STATUS', present: true });
  assert.deepEqual(r, { ok: true, internal: true });
  assert.deepEqual(h.f.status('B1'), { ready: true, domPresent: true });
  h.f.push({ run, session: h.sessions.get('B1'), view: { ...view } });
  assert.equal(h.evals.length, 2, 'a (re)mounted bar is filled again');
  assert.match(h.evals[1], /^window\.__phomHeaderRender && window\.__phomHeaderRender\(/);
});

test('header: one table op per browser; escape actions run alongside and never release the flag', async () => {
  let release;
  const h = mkHeader({ routes: { FIND_TABLE: () => new Promise((r) => { release = r; }), CANCEL_FIND: async () => ({ ok: true }), LEAVE: async () => ({ ok: true }) } });
  await h.f.attach({ run, client: {} });
  const find = click(h, 'FIND_TABLE');
  await tick();
  const second = await click(h, 'LEAVE');
  assert.equal(second.ok, false, 'busy');
  assert.equal((await click(h, 'CANCEL_FIND')).ok, true, 'HỦY runs alongside');
  assert.equal(h.sessions.get('B1').header.busy, true, 'and did not release the flag Dò Key owns');
  release({ ok: true });
  await find;
  assert.equal(h.sessions.get('B1').header.busy, false);
  assert.equal((await click(h, 'LEAVE')).ok, true);
});

test('header: a duplicate actionId is refused; a dead CDP session is never routed into', async () => {
  let calls = 0;
  const h = mkHeader({ routes: { LEAVE: async () => { calls += 1; return { ok: true }; } } });
  await h.f.attach({ run, client: {} });
  await click(h, 'LEAVE', { actionId: 'same' });
  const dup = await click(h, 'LEAVE', { actionId: 'same' });
  assert.equal(dup.ok, false); assert.equal(calls, 1);
  h.state.live = false;
  const dead = await click(h, 'LEAVE');
  assert.equal(dead.error.code, 'PHOM_HEADER_NO_CLIENT');
  assert.match(h.f.errorOf('B1'), /mất kết nối/);
  assert.equal(calls, 1);
});

test('header rule D1: with TỰ ĐỘNG on a table click is refused; VÀO GAME / TẢI LẠI still route', async () => {
  const done = [];
  const h = mkHeader({ auto: true, routes: { FIND_TABLE: async () => { done.push('find'); return { ok: true }; }, RELOAD: async () => { done.push('reload'); return { ok: true }; } } });
  await h.f.attach({ run, client: {} });
  assert.equal((await click(h, 'FIND_TABLE')).error.code, 'PHOM_AUTO_ACTIVE');
  assert.equal((await click(h, 'RELOAD')).ok, true);
  assert.deepEqual(done, ['reload']);
});

test('header rule D2: a second Dò Key within the confirm window forces replacing the group', async () => {
  const forces = [];
  const h = mkHeader({ routes: { FIND_TABLE: async (_rid, _p, ctx) => { forces.push(ctx.force); return forces.length === 1 ? { ok: false, needsConfirm: true, error: { code: 'X' } } : { ok: true }; } } });
  await h.f.attach({ run, client: {} });
  await click(h, 'FIND_TABLE');
  h.advance(FIND_CONFIRM_MS - 1);
  await click(h, 'FIND_TABLE');
  assert.deepEqual(forces, [false, true]);
  // too late → not confirmed
  const h2 = mkHeader({ routes: { FIND_TABLE: async (_rid, _p, ctx) => { forces.push(ctx.force); return { ok: false, needsConfirm: true, error: { code: 'X' } }; } } });
  forces.length = 0;
  await h2.f.attach({ run, client: {} });
  await click(h2, 'FIND_TABLE'); h2.advance(FIND_CONFIRM_MS + 1); await click(h2, 'FIND_TABLE');
  assert.deepEqual(forces, [false, false]);
});

test('header: a failed action shows its error until the browser state moves on; an unknown action is an error', async () => {
  const h = mkHeader({ routes: { LEAVE: async () => ({ ok: false, error: { code: 'E', message: 'không rời được' } }) } });
  await h.f.attach({ run, client: {} });
  await click(h, 'LEAVE');
  const s = h.sessions.get('B1');
  h.f.push({ run, session: s, view: { label: 'a', code: 'AT_TABLE' } });
  assert.equal(h.f.errorOf('B1'), 'không rời được', 'kept in the state it happened in');
  h.f.push({ run, session: s, view: { label: 'a', code: 'AT_TABLE' } });
  assert.equal(h.f.errorOf('B1'), 'không rời được');
  h.f.push({ run, session: s, view: { label: 'a', code: 'IN_LOBBY' } });
  assert.equal(h.f.errorOf('B1'), null, 'the state changed → the old error goes');
  assert.equal((await click(h, 'NOPE')).error.code, 'PHOM_HEADER_UNKNOWN_ACTION');
});

test('header: a new document / the tool reload / a CDP detach make the bar be confirmed and filled again', async () => {
  const h = mkHeader();
  await h.f.attach({ run, client: {} });
  await h.f.action('B1', { key: 'key1', action: '__HEADER_STATUS', present: true });
  const s = h.sessions.get('B1');
  h.f.push({ run, session: s, view: { label: 'a' } });
  h.f.documentReplaced({ session: s });
  assert.equal(s.header.domPresent, false); assert.equal(s.header.lastPushed, null);
  s.header.domPresent = true; s.header.error = 'x';
  h.f.detached('B1');
  assert.deepEqual(h.f.status('B1'), { ready: false, domPresent: false });
  assert.equal(h.f.errorOf('B1'), 'x', 'a detach keeps the error the user has to see');
  h.f.reset('B1');
  assert.equal(h.f.errorOf('B1'), null);
});

// ---- enter-game ----
function mkEnter({ enterRes = { ok: true }, timeoutMs = 50, autoOn = true } = {}) {
  const sessions = createSessionRegistry();
  const logs = []; const calls = []; let t = 0;
  const f = createEnterGameFeature({
    sessions, timeoutMs,
    enter: async (rid) => { calls.push(rid); return typeof enterRes === 'function' ? enterRes() : enterRes; },
    autoEnabled: () => autoOn,
    log: (e, d) => logs.push([e, d]),
    now: () => t,
  });
  return { f, sessions, logs, calls, advance: (ms) => { t += ms; }, s: () => sessions.get('B1') };
}

test('enter-game: VÀO GAME shows ĐANG VÀO GAME until evidence; the latency is logged once', async () => {
  const e = mkEnter({ timeoutMs: 10000 });
  await e.f.start('B1', { source: 'header' });
  assert.deepEqual(e.f.pending('B1'), { pending: true, startedAt: 0 });
  e.advance(1234);
  e.f.push({ run, session: e.s(), view: { opened: true, inGame: true }, browser: null });
  assert.deepEqual(e.f.pending('B1'), { pending: false, startedAt: null });
  e.f.push({ run, session: e.s(), view: { opened: true, inGame: true }, browser: null });
  assert.deepEqual(e.logs.filter(([k]) => k === 'ENTER_GAME_EVIDENCE').map(([, d]) => d.elapsedMs), [1234]);
  assert.equal(e.s().enter.timer, null, 'the bounded timeout was cancelled');
});

test('enter-game: no evidence within the window → back to VÀO GAME (never stuck); a failed click stops at once', async () => {
  const e = mkEnter({ timeoutMs: 20 });
  await e.f.start('B1');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(e.f.pending('B1').pending, false);
  assert.ok(e.logs.some(([k]) => k === 'ENTER_GAME_TIMEOUT'));
  const bad = mkEnter({ enterRes: { ok: false, error: { code: 'X' } } });
  await bad.f.start('B1');
  assert.equal(bad.f.pending('B1').pending, false);
  assert.equal(bad.s().enter.timer, null);
  assert.ok(bad.logs.some(([k]) => k === 'ENTER_GAME_FAIL'));
});

test('enter-game: a fresh VÀO GAME re-arms ONE timer; the tool reload clears ENTERING', async () => {
  const e = mkEnter({ timeoutMs: 10000 });
  await e.f.start('B1');
  const first = e.s().enter.timer;
  await e.f.start('B1');
  assert.notEqual(e.s().enter.timer, first);
  e.f.reset('B1');
  assert.equal(e.f.pending('B1').pending, false); assert.equal(e.s().enter.timer, null);
});

test('AUTO-ENTER: once logged in and not in Phỏm it presses VÀO GAME after the settle, once per page, bounded', async () => {
  const e = mkEnter({ enterRes: { ok: false, error: { code: 'NOT_READY' } }, timeoutMs: 10000 });
  const push = (view, b = { loggedIn: true }) => e.f.push({ run, session: e.s(), view: { opened: true, ...view }, browser: b });
  push({ inGame: false }, { loggedIn: false });
  assert.equal(e.calls.length, 0, 'not before the login');
  push({ inGame: false });
  assert.equal(e.calls.length, 0, 'the lobby is given time to build');
  for (let i = 0; i < AUTO_MAX_TRIES + 3; i++) { e.advance(10000); push({ inGame: false }); await tick(); await tick(); }
  clearTimeout(e.s().enter.auto && e.s().enter.auto.timer);
  assert.equal(e.calls.length, AUTO_MAX_TRIES, 'bounded');
  assert.ok(e.logs.some(([k]) => k === 'AUTO_ENTER_GAVE_UP'));
  // a new page = a new login → it runs again
  e.f.documentReplaced({ session: e.s() });
  assert.equal(e.s().enter.auto, null);
});

test('AUTO-ENTER: reaching Phỏm ends it; it waits for a click in flight and for stale data; it can be switched off', async () => {
  const e = mkEnter();
  e.f.push({ run, session: e.s(), view: { opened: true, inGame: true }, browser: { loggedIn: true } });
  e.advance(5000);
  e.f.push({ run, session: e.s(), view: { opened: true, inGame: false }, browser: { loggedIn: true } });
  assert.equal(e.calls.length, 0, 'done once it was in Phỏm');
  const busy = mkEnter();
  busy.s().header.busy = true;
  busy.f.push({ run, session: busy.s(), view: { opened: true }, browser: { loggedIn: true } }); busy.advance(5000);
  busy.f.push({ run, session: busy.s(), view: { opened: true }, browser: { loggedIn: true } });
  busy.f.push({ run, session: busy.s(), view: { opened: true, dataStale: true }, browser: { loggedIn: true } });
  assert.equal(busy.calls.length, 0, 'a bar click in flight / stale data → no auto press');
  clearTimeout(busy.s().enter.auto && busy.s().enter.auto.timer);
  const off = mkEnter({ autoOn: false });
  off.f.push({ run, session: off.s(), view: { opened: true }, browser: { loggedIn: true } }); off.advance(5000);
  off.f.push({ run, session: off.s(), view: { opened: true }, browser: { loggedIn: true } });
  assert.equal(off.calls.length, 0);
});

test('enter-game: the auto press takes the bar\'s single-flight flag while it runs', async () => {
  let release;
  const e = mkEnter({ enterRes: () => new Promise((r) => { release = r; }) });
  const push = () => e.f.push({ run, session: e.s(), view: { opened: true, inGame: false }, browser: { loggedIn: true } });
  push(); e.advance(5000); push();
  assert.equal(e.s().header.busy, true);
  release({ ok: true }); await tick(); await tick();
  assert.equal(e.s().header.busy, false);
  e.f.closed({ session: e.s() });
  assert.equal(e.s().enter.timer, null); assert.equal(e.s().enter.auto, null);
});
