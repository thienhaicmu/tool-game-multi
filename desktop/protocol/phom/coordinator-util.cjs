'use strict';

// Small pure helpers shared by the table coordinator's parts.
function errMsg(e) { return String(e && e.message || e); }
function accountIdOf(uid) { if (uid == null) return null; const m = /^\d+_(\d+)$/.exec(String(uid)); return m ? m[1] : null; }
// A short server reply kept verbatim in the diagnostic log (only refusals / kicks — never a login frame, which holds the
// session token). Bounded so a log line never grows with the frame.
function frameText(raw) { return typeof raw === 'string' && !/token|"pwd"|password/i.test(raw) ? raw.slice(0, 300) : null; }
function shortUid(uid) { if (uid == null) return null; const s = String(uid); return s.length <= 6 ? s : `${s.slice(0, 4)}…${s.slice(-3)}`; }

module.exports = { errMsg, accountIdOf, frameText, shortUid };
