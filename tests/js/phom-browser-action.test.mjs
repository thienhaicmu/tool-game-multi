// PHASE 6.2.2 — the per-browser business action (TÌM BÀN vs VÀO BÀN vs THOÁT GAME vs VÀO GAME vs MỞ
// CHROMIUM). Pure decision from authoritative state: once a shared RID exists, in-game browsers show
// VÀO BÀN (JOIN the shared RID) — never TÌM BÀN / a new discovery. Loaded as a browser classic script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const code = readFileSync(new URL('../../ui-phom/manual-cluster-state.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(code, ctx);
const S = ctx.ManualClusterState;

const B = (manualState, rid) => ({ profileId: '1', manualState, rid: rid != null ? rid : null });

test('chromium closed => MỞ CHROMIUM', () => {
  const a = S.browserAction(S.create(), B('CLOSED'), { opened: false });
  assert.equal(a.action, 'CLOSED');
  assert.equal(a.label, 'MỞ CHROMIUM');
});

test('opened but not in game => VÀO GAME (and ĐANG VÀO GAME while entering)', () => {
  assert.equal(S.browserAction(S.create(), B('READY'), { opened: true, inGame: false }).label, 'VÀO GAME');
  const e = S.browserAction(S.create(), B('READY'), { opened: true, inGame: false, entering: true });
  assert.equal(e.action, 'ENTERING');
  assert.ok(e.busy);
});

test('in game, NO shared RID => TÌM BÀN (discovery)', () => {
  const a = S.browserAction(S.create(), B('READY'), { opened: true, inGame: true });
  assert.equal(a.action, 'FIND');
  assert.equal(a.label, 'TÌM BÀN');
});

// §2/§3/§14.1-4 — once a shared RID exists, in-game browsers show VÀO BÀN (JOIN_SHARED), never TÌM BÀN
test('in game + shared RID exists => VÀO BÀN (JOIN_SHARED), never TÌM BÀN', () => {
  const st = { searchingBrowserId: null, sharedRid: 700100, sharedRidOwner: '2', sharedStake: 500 };
  const a = S.browserAction(st, B('READY'), { opened: true, inGame: true });
  assert.equal(a.action, 'JOIN_SHARED');
  assert.equal(a.label, 'VÀO BÀN');
  assert.equal(a.rid, 700100);
  assert.notEqual(a.action, 'FIND');
});

// §14.5/§3 — VÀO BÀN carries the exact shared RID (the join target)
test('VÀO BÀN targets the exact shared RID', () => {
  const st = { searchingBrowserId: null, sharedRid: 999, sharedRidOwner: '1', sharedStake: 100 };
  assert.equal(S.browserAction(st, B('READY'), { opened: true, inGame: true }).rid, 999);
});

test('joined the shared table => THOÁT GAME (leave)', () => {
  const st = { searchingBrowserId: null, sharedRid: 700100, sharedRidOwner: '1', sharedStake: 500 };
  const a = S.browserAction(st, B('JOINED', 700100), { opened: true, inGame: true });
  assert.equal(a.action, 'LEAVE');
  assert.equal(a.label, 'THOÁT GAME');
});

test('joining/searching are busy states (ĐANG VÀO BÀN… / ĐANG TÌM…)', () => {
  const st = { searchingBrowserId: null, sharedRid: 700100, sharedRidOwner: '2', sharedStake: 500 };
  const j = S.browserAction(st, B('JOINING'), { opened: true, inGame: true });
  assert.equal(j.action, 'JOINING'); assert.ok(j.busy); assert.match(j.label, /VÀO BÀN/);
  const s = S.browserAction(S.create(), B('SEARCHING'), { opened: true, inGame: true });
  assert.equal(s.action, 'SEARCHING'); assert.ok(s.busy);
});

// §14.6 — a browser joined to a DIFFERENT rid than the shared one is not "joined shared" (still VÀO BÀN)
test('joined a different rid than shared => still VÀO BÀN (not THOÁT GAME)', () => {
  const st = { searchingBrowserId: null, sharedRid: 700100, sharedRidOwner: '2', sharedStake: 500 };
  const a = S.browserAction(st, B('JOINED', 555), { opened: true, inGame: true });
  assert.equal(a.action, 'JOIN_SHARED');
});
