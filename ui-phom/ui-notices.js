'use strict';

// Phỏm QA tool window — the group notices as one plain-Vietnamese line (never a raw code). Pure. Needs ui-kit.js.
(function () {
  const UI = window.PhomUI = window.PhomUI || {};
  const { errText } = UI;
  const SLOTS = ['A', 'B', 'C'];
  // ---------- group notices (docs/phom-kich-ban.md) — one plain-Vietnamese line, never a raw code ----------
  const ROLE_VIEW = { KEY: ['KEY', 'role-key', 'Acc Dò Key — chủ bàn, KHÔNG tự bấm Bắt đầu'], READY: ['SẴN SÀNG', 'role-ready', 'Vào bàn trước → luôn sẵn sàng'], NOT_READY: ['CHƯA SS', 'role-wait', 'Vào bàn sau → không sẵn sàng, tự ReJoin'] };
  function roleLabel(role) { const v = ROLE_VIEW[role]; return v ? v[0] : role; }
  // labelOf(runId) → "P1"…: who the line is about (the screen knows the slots)
  function noticeText(n, labelOf) {
    if (!n || !n.event) return '';
    const who = labelOf(n.id);
    switch (n.event) {
      case 'KEY_SEATED': return who + ' là KEY (chủ bàn) — các acc khác bấm Tạo / Vào.';
      case 'TABLE_FOUND': return 'Số bàn ' + n.rid + ' — đã điền vào ô SS của mọi trình duyệt.';
      case 'READY_SENT': return who + ' đã sẵn sàng.';
      case 'FOURTH_READY': return '🔔 Người thứ 4' + (n.name ? ' (' + n.name + ')' : '') + ' đã sẵn sàng — tool tự cho ' + (n.notReadyId ? labelOf(n.notReadyId) + ' sẵn sàng và ' : '') + labelOf(n.keyId) + ' (KEY) bắt đầu ván.';
      case 'FULL_READY': return 'Bàn đủ 4 người — ' + who + ' đã tự sẵn sàng.';
      case 'ROUND_START_SENT': return who + ' (KEY) đã bắt đầu ván.';
      case 'SCAN_FAILED': return who + ' chưa dò ra bàn KEY: ' + errText({ error: n.error }) + '.';
      case 'GROUP_FORMED': return 'Cả nhóm đã vào bàn ' + n.rid + '.';
      case 'JOINED': return who + (n.rejoin ? ' đã vào lại bàn' : ' đã vào bàn') +(n.role ? ' · ' + roleLabel(n.role) : '') + '.';
      case 'JOIN_FAILED': return who + ' vào bàn không được: ' + errText({ error: n.error }) + '.';
      case 'FIND_FAILED': return 'Tìm bàn không được: ' + errText({ error: n.error }) + '.';
      case 'LEAVE_FAILED': return who + ' chưa rời được bàn: ' + errText({ error: n.error }) + '.';
      case 'KICKED': return who + ' bị đá khỏi bàn' + (n.message ? ' (' + n.message + ')' : '') + (n.auto ? ' — đang tự vào lại…' : ' — bấm ReJoin để vào lại.');
      case 'TABLE_LOST': return 'Bàn ' + n.rid + ' không còn' + (n.auto ? ' — đang dò bàn khác…' : ' — bấm Dò Key để vào bàn khác.');
      case 'REGROUP': return 'Chủ bàn ' + n.rid + ' không còn là acc của mình — cả nhóm rời bàn, đang dò bàn khác…';
      case 'RULE_BROKEN_OUT': return 'Chủ bàn ' + n.rid + ' không còn là acc của mình — cả nhóm đã rời bàn. Bấm Dò Key để tìm bàn mới.';
      case 'KEY_CHANGED': return 'KEY mất bàn — ' + who + ' thành chủ bàn, là KEY mới (giữ bàn ' + n.rid + ').';
      case 'NOT_READY_RESET': return (n.reason === 'SS_LEFT' ? 'Acc SẴN SÀNG rời bàn' : 'Người lạ rời bàn') + ' — acc CHƯA SS vào lại để về chưa sẵn sàng.';
      case 'LOOP_GUARD': return n.what === 'REGROUP'
        ? 'Đã lập lại nhóm ' + n.max + ' lần trong ' + Math.round(n.windowSec / 60) + ' phút (chủ bàn toàn người lạ) — TỰ ĐỘNG đã tắt để không lặp mãi.'
        : (n.id ? labelOf(n.id) + ': ' : '') + (n.what === 'SEAT_FREE' ? 'đã thử vào lại bàn ' : 'đã rời rồi vào lại bàn ') + n.max + ' lần trong ' + n.windowSec + ' giây — tool tạm dừng việc này để không lặp mãi.';
      case 'BROWSER_MEMORY_RUNAWAY': return 'Trình duyệt ' + (n.slot ? ({ A: 'P1', B: 'P2', C: 'P3', D: 'P4', E: 'P5' }[n.slot] || n.slot) + ' ' : '') + 'dùng ' + Math.round((n.mb || 0) / 1024 * 10) / 10 + ' GB RAM — tool đã đóng nó để máy không bị đơ. Mở lại trình duyệt đó.';
      case 'GROUP_DISSOLVED': return n.reason === 'KEY_REPLACED' ? 'Acc KEY đã được thay — nhóm bị hủy, bấm Dò Key để lập bàn mới.' : (n.reason === 'KEY_KICKED' || n.reason === 'HOST_CHANGED') ? 'Nhóm đã rời bàn ' + n.rid + ' (chủ bàn không còn là acc của mình) — bấm Dò Key để tìm bàn mới.' : 'Đã thoát bàn tất cả.';
      case 'MEMBER_REPLACED': return who + ' thay acc cũ, nhận vai ' + roleLabel(n.role) + ' — vào game xong sẽ tự vào bàn' + (n.rid != null ? ' ' + n.rid : '') + '.';
      case 'REPLACE_TIMEOUT': return who + ' chưa vào game sau 2 phút — đăng nhập rồi bấm Tạo / Vào.';
      case 'SLOT_AUTO_REPLACED': return 'Trình duyệt P' + (SLOTS.indexOf(n.slot) + 1) + ' bị tắt — đã tự thay bằng ' + (n.label || 'trình duyệt dự bị') + '.';
      case 'SLOT_AUTO_REPLACE_FAILED': return 'Trình duyệt P' + (SLOTS.indexOf(n.slot) + 1) + ' bị tắt — chưa thay được bằng dự bị: ' + errText({ error: n.error }) + '.';
      case 'AUTO_OFF': return 'Đã tắt tự động.';
      default: return '';
    }
  }
  Object.assign(UI, { ROLE_VIEW, roleLabel, noticeText });
})();
