'use strict';

// ---------------------------------------------------------------------------
// AutoExecutionCollector — WU-AUTO-RUNTIME-HARDENING, Part A.
//
// Turns an AutoRunner's authoritative `executionFinalized` event into a persistent
// per-BrowserRun Auto EXECUTION record, attributed to the OWNING run's persistent
// browser (browserId + runId — structural ownership, never UI selection).
//
// The record carries the machine-readable stopReason + the authoritative stopOdd
// (or null; never fabricated). A Vietnamese label is derived for the History UI, but
// the raw stopReason is always retained so nothing is lost in translation (§14).
// ---------------------------------------------------------------------------

// stopReason -> understandable Vietnamese (§14). Unknown reasons fall back to a
// generic label but keep the raw code available in the record.
const STOP_REASON_LABEL_VI = Object.freeze({
  USER_STOP: 'Người dùng dừng',
  ROUND_TARGET_COMPLETED: 'Hoàn thành số vòng',
  STOP_ODD_REACHED: 'Đạt ODD dừng',
  STOP_1000X_REACHED: 'Đạt 1000x',
  LOGIN_REQUIRED: 'Cần đăng nhập',
  SESSION_RECOVERY: 'Đang khôi phục phiên',
  RECOVERY_FAILED: 'Khôi phục thất bại',
  AUTO_ERROR: 'Lỗi Auto Run',
  RUN_CLOSED: 'Đã đóng trình duyệt',
  APP_CLOSED: 'Đã đóng ứng dụng',
  LICENSE_BLOCKED: 'Giấy phép bị khóa',
  // A round WIN ended this LƯỢT so the sequence restarts at LƯỢT 1 — a legitimate win outcome,
  // never a failure/unknown (the winning round itself stays COMPLETED in round history).
  SEQUENCE_WIN_RESET: 'Thắng — quay lại Level 1',
  UNKNOWN: 'Không xác định',
});

function stopReasonLabelVi(reason) {
  return STOP_REASON_LABEL_VI[String(reason || '')] || STOP_REASON_LABEL_VI.UNKNOWN;
}

// Evidence-safe result status (§22): only a proven server-completed round set yields a
// definitive status; everything else stays UNKNOWN. We never infer LOSS/win/net from a
// stop/disconnect/login/recovery/entry error.
function resultStatus(rec) {
  if (rec && rec.stopReason === 'ROUND_TARGET_COMPLETED') return 'COMPLETED';
  if (rec && rec.stopReason === 'USER_STOP') return 'STOPPED';
  return 'UNKNOWN';
}

function deriveExecutionRecord({ browserId, runId, rec } = {}) {
  return {
    browserId: String(browserId), runId: String(runId),
    autoExecutionId: rec ? rec.autoExecutionId : null,
    startedAt: rec ? rec.startedAt : null,
    endedAt: rec ? rec.endedAt : null,
    stopReason: rec ? rec.stopReason : null,
    stopReasonLabel: stopReasonLabelVi(rec ? rec.stopReason : null),
    roundsRequested: rec ? rec.roundsRequested : null,
    roundsCompleted: rec ? rec.roundsCompleted : null,
    betAmount: rec ? rec.betAmount : null,
    configuredStopOdd: rec ? rec.configuredStopOdd : null,
    lastSid: rec ? rec.lastSid : null,
    stopOdd: rec ? rec.stopOdd : null,
    stopOddObservedAt: rec ? rec.stopOddObservedAt : null,
    stopOddSource: rec ? rec.stopOddSource : null,
    recoveryCount: rec ? rec.recoveryCount : 0,
    lastRecoveryReason: rec ? rec.lastRecoveryReason : null,
    errorCode: rec ? rec.errorCode : null,
    resultStatus: resultStatus(rec),
  };
}

class AutoExecutionCollector {
  constructor(deps = {}) {
    this._store = deps.store;
    this._browserId = deps.browserId;
    this._runId = deps.runId;
    this._onPersisted = deps.onPersisted || (() => {});
    if (deps.autoRunner && deps.autoRunner.on) deps.autoRunner.on('executionFinalized', (rec) => this.record(rec));
  }

  record(rec) {
    try {
      const out = deriveExecutionRecord({ browserId: this._browserId, runId: this._runId, rec });
      const res = this._store.upsert(out);
      if (!res.error) this._onPersisted(this._browserId, res.record);
      return res;
    } catch (e) { return { error: { code: 'AUTO_EXECUTION_COLLECT_FAILED', message: String(e && e.message || e) } }; }
  }
}

module.exports = { AutoExecutionCollector, deriveExecutionRecord, stopReasonLabelVi, resultStatus, STOP_REASON_LABEL_VI };
