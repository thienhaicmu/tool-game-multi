'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.2.3 — pure single-flight + identity guard for in-Chromium header actions (VÀO GAME / TÌM BÀN /
// …). A click MUST NOT:
//   - be attributed to a browser other than the one it came from  → STALE_RUN / STALE_PROFILE
//     (e.g. an action fired by an OLD header after the browser was reopened with a fresh run identity),
//   - be processed twice from a re-delivered binding call          → DUPLICATE_ACTION_ID,
//   - stack a second operation on a browser already running one    → DUPLICATE_ACTION (single-flight).
// Returns { ok:true } or { ok:false, reason, code, message }. Pure (no I/O) so it is fully unit-testable.
// Identity is checked BEFORE busy so a stale/duplicate click is labelled precisely even mid-operation.
// ---------------------------------------------------------------------------

const REASONS = Object.freeze({
  STALE_RUN:           { code: 'PHOM_HEADER_STALE_RUN',     message: 'Thao tác từ phiên trình duyệt cũ.' },
  STALE_PROFILE:       { code: 'PHOM_HEADER_STALE_PROFILE', message: 'Thao tác từ hồ sơ khác.' },
  DUPLICATE_ACTION_ID: { code: 'PHOM_HEADER_DUPLICATE',     message: 'Bỏ qua click trùng.' },
  DUPLICATE_ACTION:    { code: 'PHOM_HEADER_BUSY',          message: 'Đang xử lý thao tác trước…' },
});

function evaluateHeaderAction({ payload = {}, boundRunId, runProfileId = null, busy = false, lastActionId = null } = {}) {
  const p = payload || {};
  const bad = (reason) => ({ ok: false, reason, code: REASONS[reason].code, message: REASONS[reason].message });
  if (p.runId != null && String(p.runId) !== String(boundRunId)) return bad('STALE_RUN');
  if (p.profileId != null && runProfileId != null && String(p.profileId) !== String(runProfileId)) return bad('STALE_PROFILE');
  if (p.actionId != null && lastActionId != null && String(p.actionId) === String(lastActionId)) return bad('DUPLICATE_ACTION_ID');
  if (busy) return bad('DUPLICATE_ACTION');
  return { ok: true };
}

module.exports = { evaluateHeaderAction, REASONS };
