// TỰ ĐÁNH (user 2026-10-09: "từng player khi user chọn bật … chỉ làm cho 3 player không làm cho người lạ") — per account,
// switched on by the user, following docs/phom-danh-bai.md turn by turn, ONLY while every player of the round is one
// of the tool's accounts. Every press is the game's own button through the play-actions feature.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const auto = require('../../desktop/protocol/phom/phom-auto-play.cjs');
const help = require('../../desktop/protocol/phom/phom-play-help.cjs');
const { ACTIONS, buildOfferedScript } = require('../../desktop/protocol/phom/play-actions.cjs');
const { createAutoPlayFeature } = require('../../desktop/phom/features/auto-play.cjs');
const { encodeCard } = require('../../desktop/protocol/phom/card-codec.cjs');
const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
const cc = (r, s) => encodeCard(r, s); // rank 0..12 = A..K, suit 0..3 = ♠ ♣ ♦ ♥

// A, B, C = the tool's three accounts (P1–P3); B is the account under test. A plays before B.
function snap({ mine, discarded = 0, prevDiscard = null, laidA = [], laidB = [], players = ['A', 'B', 'C'], eats = [] } = {}) {
  const p = (uid, extra) => ({ uid, seat: null, currentCards: [], melds: [], serverMeldCards: [], discardedHistory: [], ...extra });
  const all = {
    A: p('A', { melds: laidA.length ? [{ meid: 3, cards: laidA }] : [] }),
    B: p('B', { currentCards: mine, currentCardsSource: 'DRAW', controlled: true, melds: laidB.length ? [{ meid: 9, cards: laidB }] : [], discardedHistory: Array.from({ length: discarded }, (_, i) => cc(12, i % 4)) }),
    C: p('C'),
  };
  for (const u of players) if (!all[u]) all[u] = p(u);
  const order = players.slice();
  const nextOf = Object.fromEntries(order.map((u, i) => [u, order[(i + 1) % order.length]]));
  return {
    roundPlayers: players, nextOf, slotBinding: { B1: 'A', B2: 'B', B3: 'C' }, players: all,
    ledger: mine.map((code) => ({ code, status: 'CURRENT', ownerUid: 'B' })), eats,
    observedDiscardEvents: prevDiscard != null ? [{ uid: 'A', cards: [prevDiscard] }] : [],
  };
}

test('the table guard: every player of the round must be one of the tool\'s accounts', () => {
  assert.equal(auto.tableGuard(snap({ mine: [cc(0, 0)] })).ok, true);
  const s = auto.tableGuard(snap({ mine: [cc(0, 0)], players: ['A', 'B', 'S', 'C'] }));
  const none = auto.tableGuard({ slotBinding: { B1: 'A' }, roundPlayers: [] });
  assert.deepEqual([none.ok, !!none.stop], [false, false], 'no deal yet → wait, not stop');
  const st = auto.nextStep(snap({ mine: [cc(0, 0)], players: ['A', 'B', 'S', 'C'] }), 'B', ['DANH']);
  assert.equal(st.stop, true, 'a stranger in the round stops it before any press');
});

test('a reserve of the session (P4/P5, not in a slot) is one of ours, not a stranger', () => {
  const s = snap({ mine: [cc(0, 0), cc(5, 1)], players: ['A', 'B', 'R4', 'C'] });
  assert.equal(auto.tableGuard(s).stop, true, 'unknown uid → stranger');
  assert.equal(auto.tableGuard(s, ['A', 'B', 'C', 'R4']).ok, true);
  assert.equal(auto.nextStep(s, 'B', ['DANH'], new Set(), ['R4']).action, 'DANH');
});

test('the session lists the uids of every browser — the playing slots and the reserves', () => {
  const { HostSessionManager } = require('../../desktop/protocol/phom/host-session-manager.cjs');
  const m = Object.create(HostSessionManager.prototype);
  m._c = () => ({ profileIds: () => ['R1', 'R2', 'R3', 'R4', 'R5'], uidOf: (id) => ({ R1: 11, R2: 12, R3: 13, R4: 14 })[id] ?? null });
  assert.deepEqual(m.toolUids(), ['11', '12', '13', '14'], 'a reserve before its login is simply not known yet');
  m._c = () => null;
  assert.deepEqual(m.toolUids(), []);
});

test('step 1 — Ăn when the card just discarded makes a phỏm, else Bốc; an Ăn the game refused falls back to Bốc', () => {
  const mine = [cc(1, 0), cc(1, 1), cc(8, 2), cc(12, 3)]; // 2♠ 2♣ 9♦ K♥
  const eat = auto.nextStep(snap({ mine, prevDiscard: cc(1, 2) }), 'B', ['BOC', 'AN']);
  assert.deepEqual([eat.action, eat.cards], ['AN', []]);
  assert.match(eat.why, /Ăn 2♦/);
  assert.equal(auto.nextStep(snap({ mine, prevDiscard: cc(6, 0) }), 'B', ['BOC', 'AN']).action, 'BOC', 'no phỏm with it');
  assert.equal(auto.nextStep(snap({ mine, prevDiscard: cc(1, 2) }), 'B', ['BOC', 'AN'], new Set(['AN'])).action, 'BOC');
  assert.equal(auto.nextStep(snap({ mine, prevDiscard: cc(1, 2) }), 'B', []).wait, true, 'no button → not its turn');
});

test('Đ1–Đ3 — Đánh the card "Nên đánh" of the ĐÁNH BÀI help', () => {
  const mine = [cc(1, 0), cc(1, 1), cc(1, 2), cc(5, 3), cc(12, 3), cc(8, 2)];
  for (const discarded of [0, 1, 2]) {
    const s = snap({ mine, discarded });
    const st = auto.nextStep(s, 'B', ['DANH']);
    assert.equal(st.action, 'DANH');
    assert.deepEqual(st.cards, [help.discardRanking(s, 'B').recommended.code], 'lượt ' + (discarded + 1));
    assert.equal([cc(1, 0), cc(1, 1), cc(1, 2)].includes(st.cards[0]), false, 'never breaks the phỏm');
  }
  const eaten = snap({ mine, eats: [{ card: cc(8, 2), eaterUid: 'B' }] });
  assert.notEqual(auto.nextStep(eaten, 'B', ['DANH']).cards[0], cc(8, 2), 'an eaten card is never discarded');
});

test('Đ4 — the last turn: ① Hạ the plan → ② Gửi what fits now (a chain on the next press) → ③ Đánh', () => {
  const run = [cc(2, 3), cc(3, 3), cc(4, 3)]; // A laid 3♥ 4♥ 5♥
  const set = [cc(1, 0), cc(1, 1), cc(1, 2)];  // 2♠ 2♣ 2♦
  const mine = [...set, cc(5, 3), cc(6, 3), cc(12, 0)]; // + 6♥ 7♥ K♠
  const s1 = snap({ mine, discarded: 3, laidA: run });
  const ha = auto.nextStep(s1, 'B', ['HA', 'DANH']);
  assert.equal(ha.action, 'HA');
  assert.deepEqual(ha.cards, help.haPlan(s1, 'B').cards);
  assert.deepEqual(ha.cards.slice().sort((a, b) => a - b), set.slice().sort((a, b) => a - b));
  assert.equal(auto.nextStep(s1, 'B', ['DANH']).wait, true, 'a phỏm to lay but no Hạ button → wait (no discard before hạ)');
  // laid → send: 6♥ fits 3♥4♥5♥ now; 7♥ only after it
  const s2 = snap({ mine, discarded: 3, laidA: run, laidB: set });
  const gui = auto.nextStep(s2, 'B', ['GUI', 'DANH']);
  assert.deepEqual([gui.action, gui.cards], ['GUI', [cc(5, 3)]]);
  const s3 = snap({ mine: mine.filter((c) => c !== cc(5, 3)), discarded: 3, laidA: run.concat(cc(5, 3)), laidB: set });
  const gui2 = auto.nextStep(s3, 'B', ['GUI', 'DANH']);
  assert.deepEqual([gui2.action, gui2.cards], ['GUI', [cc(6, 3)]]);
  const s4 = snap({ mine: [...set, cc(12, 0)], discarded: 3, laidA: run.concat(cc(5, 3), cc(6, 3)), laidB: set });
  const danh = auto.nextStep(s4, 'B', ['GUI', 'DANH']);
  assert.deepEqual([danh.action, danh.cards], ['DANH', [cc(12, 0)]]);
  // nothing to lay (móm) → no hạ, no gửi: the discard
  const mom = snap({ mine: [cc(0, 0), cc(4, 1), cc(8, 2), cc(12, 3)], discarded: 3, laidA: [cc(9, 0), cc(10, 0), cc(11, 0)] });
  assert.equal(auto.nextStep(mom, 'B', ['HA', 'GUI', 'DANH']).action, 'DANH');
});

test('Ù — pressed whenever the game shows it', () => {
  assert.equal(auto.nextStep(snap({ mine: [cc(0, 0)] }), 'B', ['BAO_U', 'DANH']).action, 'BAO_U');
});

// a fake Cocos page for the read-only offered-buttons script
test('the offered-buttons script reads the game\'s buttons only (shown + interactable), never presses', () => {
  const calls = [];
  const Button = function Button() {};
  const ctrl = {};
  const shown = { btnRutBai: true, btnAnBai: true, btnDanhBai: false };
  for (const a of Object.values(ACTIONS)) { ctrl[a.btn] = { activeInHierarchy: !!shown[a.btn], getComponent: () => ({ interactable: a.btn !== 'btnAnBai' }) }; ctrl[a.handler] = () => calls.push(a.handler); }
  const cocos = { Button, director: { getScene: () => ({ getComponentInChildren: () => ctrl }) } };
  const r = vm.runInContext(buildOfferedScript(), vm.createContext({ window: { cc: cocos } }));
  assert.deepEqual([r.ok, r.atTable, [...r.offered]], [true, true, ['BOC']]);
  assert.equal(calls.length, 0);
  const lobby = vm.runInContext(buildOfferedScript(), vm.createContext({ window: {} }));
  assert.deepEqual([lobby.atTable, [...lobby.offered]], [false, []]);
  assert.equal(/onBtn|setListCardSelected|\.send\(/.test(buildOfferedScript()), false);
});

// ---- the feature: a fake clock, a fake page, a fake press ----
function rig({ offered = ['BOC'], snapshot, uid = 'B', act } = {}) {
  let t = 0;
  const page = { offered };
  const presses = [];
  const client = { Runtime: { evaluate: async () => ({ result: { value: { ok: true, atTable: true, offered: page.offered } } }) } };
  const f = createAutoPlayFeature({
    act: act || (async (rid, input) => { presses.push([rid, input.action, input.cards]); return { ok: true, action: input.action }; }),
    clientFor: (rid) => (rid === 'R-B' || rid === 'R-A' ? client : null), snapshot: () => page.snap, uidOf: (rid) => (rid === 'R-B' ? uid : rid === 'R-A' ? 'A' : null),
    now: () => t, setTimer: () => 1, clearTimer: () => {}, settleMs: 900, stallMs: 6000, waitStallMs: 12000,
  });
  page.snap = snapshot;
  return { f, page, presses, advance: (ms) => { t += ms; } };
}
const mine0 = [cc(1, 0), cc(1, 1), cc(8, 2), cc(12, 3)];

test('feature: off by default; a step is pressed once it stayed the same for settleMs; never twice for one table state', async () => {
  const r = rig({ snapshot: snap({ mine: mine0 }) });
  await r.f.tick();
  assert.equal(r.presses.length, 0, 'nothing runs before the user switches it on');
  assert.equal(r.f.start('R-B').ok, true);
  await r.f.tick();
  assert.equal(r.presses.length, 0, 'first sight of the step: wait for the snapshot to settle');
  r.advance(1000); await r.f.tick();
  assert.deepEqual(r.presses, [['R-B', 'BOC', []]]);
  r.advance(1000); await r.f.tick();
  assert.equal(r.presses.length, 1, 'the table has not changed → the same press does not go out again');
  r.page.offered = ['DANH'];
  await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.equal(r.presses[1][1], 'DANH');
  assert.equal(r.f.status()['R-B'].on, true);
});

test('feature: only the account switched on plays; a stranger in the round switches it off (and refuses to switch on)', async () => {
  const r = rig({ snapshot: snap({ mine: mine0 }) });
  r.f.start('R-B');
  await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.deepEqual(r.presses.map((p) => p[0]), ['R-B'], 'R-A was never switched on');
  r.page.snap = snap({ mine: mine0, players: ['A', 'B', 'S', 'C'] });
  await r.f.tick();
  assert.equal(r.f.status()['R-B'].on, false);
  assert.match(r.f.status()['R-B'].message, /người chơi ngoài tool/);
  const again = r.f.start('R-B');
  assert.deepEqual([again.ok, again.error.code], [false, 'AUTO_STRANGER']);
  r.advance(5000); await r.f.tick();
  assert.equal(r.presses.length, 1, 'nothing more was pressed');
});

test('feature: a press the game did not take — Ăn falls back to Bốc; anything else switches it off', async () => {
  const r = rig({ offered: ['BOC', 'AN'], snapshot: snap({ mine: mine0, prevDiscard: cc(1, 2) }) });
  r.f.start('R-B');
  await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.equal(r.presses[0][1], 'AN');
  r.advance(7000); await r.f.tick(); // no table change after the Ăn
  r.advance(100); await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.equal(r.presses[1][1], 'BOC', 'the game refused the Ăn → Bốc');
  r.advance(7000); await r.f.tick();
  assert.equal(r.f.status()['R-B'].on, false);
  assert.match(r.f.status()['R-B'].message, /Game không nhận Bốc/);
});

test('feature: a refused press (precheck / not at the table) stops it; busy only retries; page reload / close stop it', async () => {
  const r = rig({ snapshot: snap({ mine: mine0 }), act: async () => ({ ok: false, error: { code: 'PHOM_PLAY_BUSY', message: 'Đang thực hiện thao tác trước' } }) });
  r.f.start('R-B');
  await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.equal(r.f.status()['R-B'].on, true, 'busy → try again');
  const r2 = rig({ snapshot: snap({ mine: mine0 }), act: async () => ({ ok: false, error: { code: 'PHOM_PLAY_PRECHECK', message: 'Lá đã ăn phải nằm trong phỏm' } }) });
  r2.f.start('R-B');
  await r2.f.tick(); r2.advance(1000); await r2.f.tick();
  assert.equal(r2.f.status()['R-B'].on, false);
  assert.match(r2.f.status()['R-B'].message, /Lá đã ăn/);
  const r3 = rig({ snapshot: snap({ mine: mine0 }) });
  r3.f.start('R-B'); r3.f.documentReplaced({ run: { id: 'R-B' } });
  assert.equal(r3.f.status()['R-B'].on, false);
  r3.f.start('R-B'); r3.f.closed({ run: { id: 'R-B' } });
  assert.equal(r3.f.status()['R-B'], undefined);
});

test('feature: buttons shown but no step for a long time → it stops and says why (the user plays on by hand)', async () => {
  const set = [cc(1, 0), cc(1, 1), cc(1, 2)];
  const r = rig({ offered: ['DANH'], snapshot: snap({ mine: [...set, cc(12, 0)], discarded: 3 }) });
  r.f.start('R-B');
  await r.f.tick(); r.advance(13000); await r.f.tick();
  assert.equal(r.f.status()['R-B'].on, false);
  assert.match(r.f.status()['R-B'].message, /Chờ game hiện nút Hạ/);
  assert.equal(r.presses.length, 0);
});

test('feature: IPC phom:auto-play needs the license; off → refused; the switch off always works', async () => {
  const r = rig({ snapshot: snap({ mine: mine0 }) });
  const ipc = {};
  r.f.registerIpc((ch, fn, opts) => { ipc[ch] = { fn, guarded: !!(opts && opts.guarded) }; }, { enabled: false });
  assert.equal(ipc['phom:auto-play'].guarded, true);
  assert.equal((await ipc['phom:auto-play'].fn(null, { runId: 'R-B', on: true })).error.code, 'PHOM_FEATURE_OFF');
  assert.equal((await ipc['phom:auto-play'].fn(null, { runId: 'R-B', on: false })).ok, true);
});

test('wiring: main builds it on the play-actions feature, the preload bridges it, the ĐÁNH BÀI bar has the switch', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /_autoPlayFeature = createAutoPlayFeature\(\{/);
  assert.match(main, /_playFeature\.act\(rid, input\)/);
  assert.match(main, /licensed: autoPlayLicensed,/);
  assert.match(main, /return !!\(p && p\.v === 2 && p\.features && p\.features\.autoRun === true\);/);
  assert.match(main, /autoPlayLicensed: autoPlayLicensed\(\)/, 'the UI learns the right from capabilities');
  assert.match(main, /manualBlocked: \(rid\) => \(\(_autoPlayFeature && \(_autoPlayFeature\.status\(\)\[rid\] \|\| \{\}\)\.on\)/);
  assert.match(main, /toolUids: \(\) => \(phomSessions && phomSessions\.active\(\) \? phomSessions\.toolUids\(\) : \[\]\)/);
  assert.match(main, /autoPlay: _autoPlayFeature \? _autoPlayFeature\.status\(\) : \{\}/);
  assert.match(read('desktop/phom-preload.cjs'), /setAutoPlay: \(runId, on\) => ipcRenderer\.invoke\('phom:auto-play', \{ runId, on: !!on \}\)/);
  const ui = read('ui-phom/phom-qa.js');
  const bar = ui.slice(ui.indexOf('function playBar('), ui.indexOf('async function onPlayAction('));
  assert.match(bar, /autoPlaySwitch\(runId\)\);/);
  assert.match(ui, /const allowed = caps\.autoPlayLicensed === true;/);
  assert.match(ui, /Key chưa có quyền Tự đánh/);
  assert.match(ui, /autoPlayByRun = snap\.autoPlay \|\| \{\};/);
});

// ---- review 2026-10-09: three accounts switched on at once ----
test('an account whose buttons show at ANOTHER table (not a player of the round the tool follows) is switched off — even for Ù', () => {
  const s = snap({ mine: [cc(0, 0)], players: ['A', 'C'] }); // B left for a table the observer does not follow
  for (const offered of [['BAO_U'], ['BOC'], ['DANH']]) {
    const st = auto.nextStep(s, 'B', offered);
    assert.deepEqual([st.stop, st.code], [true, 'AUTO_OTHER_TABLE'], offered[0]);
  }
  assert.equal(auto.nextStep(s, 'B', []).wait, true, 'no button there → just waits');
});

test('stateKey: another account\'s own hand does not count; this account\'s hand, the pile and the eats do', () => {
  const base = snap({ mine: mine0 });
  const otherHand = { ...base, players: { ...base.players, A: { ...base.players.A, currentCards: [cc(3, 3)] } } };
  assert.equal(auto.stateKey(otherHand, 'B'), auto.stateKey(base, 'B'));
  assert.notEqual(auto.stateKey(snap({ mine: mine0.slice(1) }), 'B'), auto.stateKey(base, 'B'));
  assert.notEqual(auto.stateKey(snap({ mine: mine0, prevDiscard: cc(6, 0) }), 'B'), auto.stateKey(base, 'B'));
  assert.notEqual(auto.stateKey(snap({ mine: mine0, eats: [{ card: cc(6, 0), eaterUid: 'C' }] }), 'B'), auto.stateKey(base, 'B'));
});

test('feature: frames of the other two accounts neither re-press a step that went out nor forget an Ăn the game refused', async () => {
  const s0 = snap({ mine: mine0, prevDiscard: cc(1, 2) });
  const r = rig({ offered: ['BOC', 'AN'], snapshot: s0 });
  r.f.start('R-B');
  await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.equal(r.presses[0][1], 'AN');
  const busyTable = (n) => ({ ...s0, players: { ...s0.players, A: { ...s0.players.A, currentCards: [n] } } });
  r.page.snap = busyTable(cc(3, 3)); r.advance(1000); await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.equal(r.presses.length, 1, 'A\'s own frame is not "the table changed" for B');
  r.advance(5000); await r.f.tick(); // the Ăn stalled → Bốc
  r.page.snap = busyTable(cc(4, 3)); await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.deepEqual(r.presses.map((p) => p[1]), ['AN', 'BOC'], 'the refused Ăn is not tried again after another account\'s frame');
});

test('feature: one browser that never answers does not hold the others (ticked side by side, page calls bounded)', async () => {
  const presses = [];
  const ok = { Runtime: { evaluate: async () => ({ result: { value: { ok: true, atTable: true, offered: ['BOC'] } } }) } };
  const hung = { Runtime: { evaluate: () => new Promise(() => {}) } };
  let t = 0;
  const f = createAutoPlayFeature({
    act: async (rid, input) => { presses.push([rid, input.action]); return { ok: true }; },
    clientFor: (rid) => (rid === 'R-A' ? hung : ok), snapshot: () => snap({ mine: mine0 }), uidOf: (rid) => (rid === 'R-A' ? 'A' : 'B'),
    now: () => t, setTimer: (fn, ms) => (ms === 20 ? setTimeout(fn, 1) : 1), clearTimer: (h) => { if (h && h !== 1) clearTimeout(h); },
    settleMs: 900, evalTimeoutMs: 20,
  });
  f.start('R-A'); f.start('R-B');
  await f.tick(); t += 1000; await f.tick();
  assert.deepEqual(presses, [['R-B', 'BOC']], 'B played while A\'s page hung');
  assert.equal(f.status()['R-A'].on, true);
  assert.match(f.status()['R-A'].message, /Không đọc được nút/);
});

test('feature: TỰ ĐÁNH needs the key\'s "Cho dùng Tự đánh" — refused without it; a run that loses it stops', async () => {
  let right = false;
  const presses = [];
  const client = { Runtime: { evaluate: async () => ({ result: { value: { ok: true, atTable: true, offered: ['BOC'] } } }) } };
  let t = 0;
  const f = createAutoPlayFeature({ act: async (rid, i) => { presses.push(i.action); return { ok: true }; }, clientFor: () => client, snapshot: () => snap({ mine: mine0 }), uidOf: () => 'B',
    licensed: () => right, now: () => t, setTimer: () => 1, clearTimer: () => {} });
  const no = f.start('R-B');
  assert.deepEqual([no.ok, no.error.code], [false, 'PHOM_AUTO_PLAY_NOT_LICENSED']);
  assert.match(no.error.message, /Cho dùng Tự đánh/);
  const ipc = {};
  f.registerIpc((ch, fn) => { ipc[ch] = fn; });
  assert.equal((await ipc['phom:auto-play'](null, { runId: 'R-B', on: true })).error.code, 'PHOM_AUTO_PLAY_NOT_LICENSED');
  right = true;
  assert.equal(f.start('R-B').ok, true);
  right = false;
  await f.tick();
  assert.equal(f.status()['R-B'].on, false);
  assert.match(f.status()['R-B'].message, /chưa được cấp quyền Tự đánh/);
  assert.equal(presses.length, 0);
});
