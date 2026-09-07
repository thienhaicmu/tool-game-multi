'use strict';

// ---------------------------------------------------------------------------
// login-signal — the ONE source-of-truth heuristic for "this page is a login/auth
// wall". Extracted so the SAME signal drives both the SessionRecoveryWatchdog
// evidence (loginDetected) and the Auto-start login gate (§14): a not-yet-entered
// run whose page is a login wall must never be driven into the game (no cmd 100000
// sent) and must surface a clear "Cần đăng nhập" instead of a generic entry timeout.
//
// This is a URL heuristic only — NOT proof of a valid session. HTTP 200 on the auth
// endpoint or a game page loading is NOT login-confirmed (§5). The authoritative
// evidence a run is actually IN the game remains a fresh SERVER round frame, owned by
// AviatorEntryGate; this signal only recognises the negative case (an auth screen).
// ---------------------------------------------------------------------------

// Matches login / auth screens as an anchored path/hash/query segment, so a game URL
// that merely embeds one of these words in an opaque token does not false-positive.
// Kept deliberately narrow; new tokens must be added with a matching test.
const LOGIN_URL_RE = /(?:^|[\/.?#])(login|signin|sign-in|log-in|auth|dangnhap|dang-nhap)(?:[\/.?#=]|$)/i;

function looksLikeLoginUrl(url) {
  const u = String(url == null ? '' : url);
  if (!u) return false;
  return LOGIN_URL_RE.test(u);
}

module.exports = { looksLikeLoginUrl, LOGIN_URL_RE };
