// TỰ ĐÁNH (user 2026-10-09: "từng player khi user chọn bật … chỉ làm cho 3 player không làm cho người lạ") — per account,
// switched on by the user, following docs/phom-danh-bai.md turn by turn; since 2026-10-09 also with strangers in the
// round (the stranger guard was dropped). Every press is the game's own button through the play-actions feature.
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

test('the table guard: only waits for the deal — a stranger in the round does not stop it (user 2026-10-09)', () => {
  assert.equal(auto.tableGuard(snap({ mine: [cc(0, 0)] })).ok, true);
  assert.equal(auto.tableGuard(snap({ mine: [cc(0, 0)], players: ['A', 'B', 'S', 'C'] })).ok, true);
  const none = auto.tableGuard({ slotBinding: { B1: 'A' }, roundPlayers: [] });
  assert.deepEqual([none.ok, !!none.stop], [false, false], 'no deal yet → wait, not stop');
  assert.equal(auto.nextStep({ slotBinding: { B1: 'A' }, roundPlayers: [] }, 'B', ['DANH']).wait, true);
  const st = auto.nextStep(snap({ mine: [cc(0, 0), cc(5, 1)], players: ['A', 'B', 'S', 'C'] }), 'B', ['DANH']);
  assert.equal(st.action, 'DANH', 'a stranger in the round → it still plays');
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
  r.f.cardsChanged(); r.page.offered = ['DANH'];
  await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.equal(r.presses[1][1], 'DANH');
  assert.equal(r.f.status()['R-B'].on, true);
});

test('feature: only the account switched on plays; a stranger in the round does not switch it off (nor refuse to switch on)', async () => {
  const r = rig({ snapshot: snap({ mine: mine0 }) });
  r.f.start('R-B');
  await r.f.tick(); r.advance(1000); await r.f.tick();
  assert.deepEqual(r.presses.map((p) => p[0]), ['R-B'], 'R-A was never switched on');
  r.page.snap = snap({ mine: mine0, players: ['A', 'B', 'S', 'C'] });
  r.f.cardsChanged();
  await r.f.tick();
  assert.equal(r.f.status()['R-B'].on, true);
  r.f.stop('R-B');
  const again = r.f.start('R-B');
  assert.equal(again.ok, true);
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
  assert.match(main, /if \(_autoPlayFeature\) _autoPlayFeature\.cardsChanged\(\);/);
  assert.match(main, /autoPlay: _autoPlayFeature \? _autoPlayFeature\.status\(\) : \{\}/);
  assert.match(read('desktop/phom-preload.cjs'), /setAutoPlay: \(runId, on\) => ipcRenderer\.invoke\('phom:auto-play', \{ runId, on: !!on \}\)/);
  const ui = read('ui-phom/phom-qa.js');
  const bar = ui.slice(ui.indexOf('function playBar('), ui.indexOf('async function onPlayAction('));
  assert.match(bar, /autoPlaySwitch\(runId\)\);/);
  assert.match(ui, /autoPlayByRun = snap\.autoPlay \|\| \{\};/);
});
