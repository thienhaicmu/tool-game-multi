// GĐ2 — ONE state per browser (browser-state.cjs): the in-page bar and the tool window's P1/P2/P3 cards render the
// same derived state, so they can never disagree; an error on a bar clears itself once the state moves on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { deriveBrowserState } = require('../../desktop/protocol/phom/browser-state.cjs');
const gh = require('../../desktop/protocol/phom/game-header.cjs');
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const lobby = { opened: true, inGame: true, manualState: 'READY' };
const CASES = [
  [{ opened: false }, 'CLOSED', 'CHƯA MỞ'],
  [{ opened: false, closed: true }, 'CLOSED', 'ĐÃ TẮT'],
  [{ opened: true, dataStale: true, staleSec: 45 }, 'DATA_STALE', 'MẤT DỮ LIỆU 45s · TẢI LẠI'],
  [{ opened: true, entering: true }, 'ENTERING', 'ĐANG VÀO GAME'],
  [{ opened: true, inGame: false }, 'NOT_IN_GAME', 'CHƯA VÀO GAME'],
  [{ ...lobby }, 'LOBBY', 'Ở SẢNH · bấm Dò Key (một acc)'],
  [{ ...lobby, keySeated: true }, 'LOBBY', 'Ở SẢNH · KEY đã ngồi · bấm Tạo'],
  [{ ...lobby, sharedRid: 7 }, 'LOBBY', 'Ở SẢNH · SS 7 · bấm Vào'],
  [{ ...lobby, sharedRid: 7, groupRole: 'READY' }, 'LOBBY', 'NGOÀI BÀN · SS 7 · bấm ReJoin'],
  [{ ...lobby, manualState: 'SEARCHING', searchKind: 'SCAN', searchElapsedSec: 12, searchAttempt: 6 }, 'SEARCHING', 'ĐANG DÒ BÀN KEY 12s · lần 6'],
  [{ ...lobby, manualState: 'JOINING' }, 'JOINING', 'ĐANG VÀO BÀN'],
  [{ ...lobby, manualState: 'JOINED', rid: 700100 }, 'IN_TABLE', 'SS 700100'],
  [{ ...lobby, manualState: 'KICKED' }, 'KICKED', 'BỊ ĐÁ · bấm ReJoin'],
  [{ ...lobby, manualState: 'KICKED', rejoinOn: true }, 'KICKED', 'BỊ ĐÁ · đang vào lại'],
  [{ ...lobby, manualState: 'KICKED', auto: true }, 'KICKED', 'BỊ ĐÁ · đang vào lại'],
  [{ ...lobby, manualState: 'LEAVE_UNCONFIRMED' }, 'LEAVE_UNCONFIRMED', 'CHƯA XÁC NHẬN RỜI BÀN — bấm Thoát lại'],
  [{ ...lobby, manualState: 'ERROR' }, 'ERROR', 'Ở SẢNH · bấm Dò Key (một acc)'],
];

test('every state has one code + one label; the bar shows exactly that label', () => {
  for (const [view, code, label] of CASES) {
    const st = deriveBrowserState(view);
    assert.equal(st.code, code, JSON.stringify(view));
    assert.equal(st.label, label, JSON.stringify(view));
    assert.equal(gh.deriveHeaderState(view).statusLabel, st.label, 'bar = tool card');
    assert.equal(gh.deriveHeaderState(view).stateCode, st.code);
  }
});

test('tones: in table good, kicked without a way back bad, kicked with ReJoin/auto warn, lobby info', () => {
  assert.equal(deriveBrowserState({ ...lobby, manualState: 'JOINED', rid: 1 }).tone, 'good');
  assert.equal(deriveBrowserState({ ...lobby, manualState: 'KICKED' }).tone, 'bad');
  assert.equal(deriveBrowserState({ ...lobby, manualState: 'KICKED', rejoinOn: true }).tone, 'warn');
  assert.equal(deriveBrowserState({ ...lobby }).tone, 'info');
});

test('a RESERVE (P4/P5) has the same state and the same bar buttons, only marked DỰ BỊ', () => {
  const st = deriveBrowserState({ ...lobby, reserve: true, reserveLabel: 'P4' });
  assert.equal(st.code, 'LOBBY');
  assert.equal(st.label, 'DỰ BỊ P4 · Ở SẢNH · bấm Dò Key (một acc)');
  assert.equal(st.tableActions, true);
  assert.equal(gh.deriveHeaderState({ ...lobby, reserve: true }).canAct, true);
});

test('wiring: main derives the state once per browser for the bar AND the tool cards; a stale error clears on a state change', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /b\.state = browserStateFor\(b\.profileId, browsers, shared\)/);
  assert.match(main, /settleHeaderError\(rid, deriveBrowserState\(view\)\.code\)/);
  assert.match(main, /function settleHeaderError[\s\S]*?if \(headerErrorState\[rid\] !== code\) \{ delete headerError\[rid\]/);
  assert.match(read('ui-phom/phom-qa.js'), /b\.state && b\.state\.label \? \[b\.state\.label/);
});

test('rule D1: with TỰ ĐỘNG on the bar locks its table buttons, shows TỰ ĐỘNG + what it does; main refuses a late click', () => {
  const st = gh.deriveHeaderState({ ...lobby, auto: true, autoBusy: 'đang vào bàn' });
  assert.equal(st.auto, true); assert.equal(st.autoBusy, 'đang vào bàn');
  const boot = gh.bootScript({ slotId: 'B1', profileId: 'p', runId: 'r' });
  assert.match(boot, /var LOCK = !!state\.auto/);
  assert.match(boot, /chip\('TỰ ĐỘNG'/);
  for (const a of ['JOIN_CODE', 'REJOIN', 'SCAN_TABLE', 'FIND_TABLE', 'LEAVE']) assert.ok(boot.includes("emit('" + a + "'"), a);
  assert.equal((boot.match(/LOCK \|\|/g) || []).length >= 4, true, 'Vào, ReJoin, Tạo, Thoát disabled while locked');
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /HEADER_TABLE_ACTIONS\.has\(action\) && phomSessions && phomSessions\.active\(\) && phomSessions\.autoActive\(\)/);
  assert.match(main, /code: 'PHOM_AUTO_ACTIVE'/);
  assert.match(main, /const force = headerFindConfirm\[rid\] != null && nowMs\(\) <= headerFindConfirm\[rid\]/);
});
