'use strict';

const DEFAULT_TOLERANCE_SECONDS = 300;

function checkClock(nowSeconds, lastTrustedSeenAt, toleranceSeconds = DEFAULT_TOLERANCE_SECONDS) {
  if (lastTrustedSeenAt && nowSeconds < lastTrustedSeenAt - toleranceSeconds) {
    return { ok: false, error: { code: 'LICENSE_CLOCK_ROLLBACK', message: 'System clock appears to have moved backwards', lastTrustedSeenAt, nowSeconds } };
  }
  return { ok: true };
}

function nextTrustedSeenAt(nowSeconds, lastTrustedSeenAt) {
  return Math.max(Number(lastTrustedSeenAt || 0), Number(nowSeconds || 0));
}

module.exports = { DEFAULT_TOLERANCE_SECONDS, checkClock, nextTrustedSeenAt };
