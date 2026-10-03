'use strict';

// ---------------------------------------------------------------------------
// ONE STATE PER BROWSER (GĐ2, docs/phom-kich-ban.md §B1) — the single place that turns a browser's facts into what
// it IS right now: a code, the words shown for it, a tone, and which table buttons make sense. The in-page bar
// (game-header deriveHeaderState) and the tool window's P1/P2/P3 cards both render THIS, so they can never disagree.
// Pure, no Electron/CDP.
//
//   CLOSED ─ NOT_IN_GAME ─ ENTERING ─ LOBBY            (a reserve P4/P5 goes through the same states, marked DỰ BỊ)
//   LOBBY ─► SEARCHING (Dò Key / Tạo) | JOINING ─► IN_TABLE (role)
//   IN_TABLE ─► KICKED ─► (ReJoin / Tự động) REJOINING | waiting for ReJoin
//   DATA_STALE, LEAVE_UNCONFIRMED, ERROR — each with its way out
// ---------------------------------------------------------------------------

const CODES = Object.freeze(['CLOSED', 'DATA_STALE', 'ENTERING', 'NOT_IN_GAME', 'KICKED', 'SEARCHING', 'LEAVE_UNCONFIRMED', 'JOINING', 'IN_TABLE', 'ERROR', 'LOBBY']);
const ROLE_WORD = Object.freeze({ KEY: 'KEY', READY: 'SẴN SÀNG', NOT_READY: 'CHƯA SS' });

//   view = { opened, closed, reserve, reserveLabel, inGame, entering, dataStale, staleSec, manualState, searchKind,
//            searchElapsedSec, searchAttempt, rid, joinedViaChannel, sharedRid, groupRole, keySeated, rejoinOn,
//            auto, autoBusy, lastError }
function deriveBrowserState(view = {}) {
  const s = view.manualState;
  const joined = !!view.inGame && s === 'JOINED' && view.rid != null;
  let code, label, tone;
  if (!view.opened) { code = 'CLOSED'; tone = 'off'; label = view.closed ? 'ĐÃ TẮT' : 'CHƯA MỞ'; }
  // Frames stopped arriving: the tool cannot know the real state, so it says so and offers the only fix.
  else if (view.dataStale) { code = 'DATA_STALE'; tone = 'bad'; label = 'MẤT DỮ LIỆU' + (view.staleSec ? ' ' + view.staleSec + 's' : '') + ' · TẢI LẠI'; }
  else if (view.entering) { code = 'ENTERING'; tone = 'warn'; label = 'ĐANG VÀO GAME'; }
  else if (!view.inGame) { code = 'NOT_IN_GAME'; tone = 'off'; label = 'CHƯA VÀO GAME'; }
  else if (s === 'KICKED') { code = 'KICKED'; tone = view.rejoinOn || view.auto ? 'warn' : 'bad'; label = 'BỊ ĐÁ' + (view.rejoinOn || view.auto ? ' · đang vào lại' : ' · bấm ReJoin'); }
  else if (s === 'SEARCHING') { code = 'SEARCHING'; tone = 'warn'; label = (view.searchKind === 'SCAN' ? 'ĐANG DÒ BÀN KEY' : 'ĐANG DÒ KEY') + (view.searchElapsedSec ? ' ' + view.searchElapsedSec + 's' : '') + (view.searchAttempt ? ' · lần ' + view.searchAttempt : ''); }
  else if (s === 'LEAVE_UNCONFIRMED') { code = 'LEAVE_UNCONFIRMED'; tone = 'bad'; label = 'CHƯA XÁC NHẬN RỜI BÀN — bấm Thoát lại'; }
  else if (s === 'JOINING' || s === 'RECONNECTING') { code = 'JOINING'; tone = 'warn'; label = 'ĐANG VÀO BÀN'; }
  else if (joined) { code = 'IN_TABLE'; tone = 'good'; label = (view.joinedViaChannel ? 'KÊNH ' : 'SS ') + view.rid; }
  else {
    // in the Phỏm lobby — the label says what to press next
    code = s === 'ERROR' ? 'ERROR' : 'LOBBY'; tone = s === 'ERROR' ? 'bad' : 'info';
    if (view.groupRole && view.sharedRid != null) label = 'NGOÀI BÀN · SS ' + view.sharedRid + ' · bấm ReJoin';
    else if (view.sharedRid != null) label = 'Ở SẢNH · SS ' + view.sharedRid + ' · bấm Vào';
    else if (view.keySeated) label = 'Ở SẢNH · KEY đã ngồi · bấm Tạo';
    else label = 'Ở SẢNH · bấm Dò Key (một acc)';
  }
  // A RESERVE browser (P4/P5) is a full browser like the playing ones — same state, same bar buttons (user rule
  // 2026-10-03); it is only marked as not holding a playing slot.
  if (view.reserve) label = 'DỰ BỊ' + (view.reserveLabel ? ' ' + view.reserveLabel : '') + ' · ' + label;
  const tableActions = !!view.opened && !!view.inGame && !view.dataStale;
  return {
    code, label, tone, reserve: !!view.reserve,
    role: view.groupRole || null, roleWord: view.groupRole ? ROLE_WORD[view.groupRole] || view.groupRole : null,
    inTable: joined,
    // the table buttons exist once the browser is in the game
    tableActions,
    error: view.lastError || null,
  };
}

module.exports = { deriveBrowserState, CODES, ROLE_WORD };
