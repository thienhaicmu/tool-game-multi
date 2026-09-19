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

// §34 — actions that must stay clickable WHILE a long operation is running. A persistent TÌM BÀN can hold the
// browser for a minute, and single-flight is about not stacking two table operations — it was never meant to
// trap the user: HỦY is the way out of the very operation that is busy, and ⟳ / ⏻ / ↑ are lifecycle escapes
// that own their own teardown. Identity + duplicate-click checks still apply to them.
const BUSY_EXEMPT_ACTIONS = Object.freeze(new Set(['CANCEL_FIND', 'RELOAD', 'STOP', 'FOCUS']));
function isBusyExempt(action) { return BUSY_EXEMPT_ACTIONS.has(String(action || '')); }

function evaluateHeaderAction({ payload = {}, boundRunId, runProfileId = null, busy = false, lastActionId = null } = {}) {
  const p = payload || {};
  const bad = (reason) => ({ ok: false, reason, code: REASONS[reason].code, message: REASONS[reason].message });
  if (p.runId != null && String(p.runId) !== String(boundRunId)) return bad('STALE_RUN');
  if (p.profileId != null && runProfileId != null && String(p.profileId) !== String(runProfileId)) return bad('STALE_PROFILE');
  if (p.actionId != null && lastActionId != null && String(p.actionId) === String(lastActionId)) return bad('DUPLICATE_ACTION_ID');
  if (busy && !isBusyExempt(p.action)) return bad('DUPLICATE_ACTION');
  return { ok: true };
}

module.exports = { evaluateHeaderAction, isBusyExempt, BUSY_EXEMPT_ACTIONS, REASONS };
