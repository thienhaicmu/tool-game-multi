'use strict';

// ---------------------------------------------------------------------------
// The ONLY place Phỏm client frames are shaped. Pure string builders — no socket,
// no state, no orchestration; the caller sends them on the browser's own game socket.
//
// These used to live inside phom-coordinator.cjs, an entire second orchestration stack
// that nothing in the app used any more: the live coordinator required that whole module
// just for these four builders. They now stand on their own so the dead stack could go.
//
// Wire format (SmartFoxServer-style array with a numeric opcode head) — see
// phom-frame-classify.cjs for the matching parser and the captured evidence.
// ---------------------------------------------------------------------------

const { ZONE, GID } = require('./phom-frame-classify.cjs');

// CMD 300 — ask for the stake channel list; the server replies with rs[].
function buildChannelListFrame(aid) { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 300, aid, gid: GID }]); }
// CMD 307 QUICK_PLAY — "seat me at a PUBLIC table in the lobby that still has room", optionally at one stake.
// Shape copied from the game client's own requestquickPlay(gid) / requestquickPlayBet(gid, b):
//   { cmd:307, aid:1, gid, b?, inc:false }
// The server answers like a create does — [5,{ri:{rid,b,sid,Mu,gid,pwd}, cmd:307|313}] — or {mgs:"Không tìm thấy
// phòng thích hợp!"} when no table qualifies, and the game client then JOINs ri.rid with ri.pwd by itself.
// This is what the tool uses instead of CREATE_TABLE (308): a created Phỏm table always needs a password (the
// server silently drops a 308 without one), and a password-locked table is one NO other player can enter from the
// lobby list — the opposite of what the group needs.
function buildQuickPlayFrame({ stake = null } = {}) {
  const p = { cmd: 307, aid: 1, gid: GID, inc: false };
  if (Number(stake) > 0) p.b = Number(stake);
  return JSON.stringify([6, ZONE, 'channelPlugin', p]);
}
// op 3 — join a room, exactly as the game client's requestJoinRoom(rid, sid, pwd) builds it: [3,"Simms",rid,pwd].
// Element [3] is the room's PASSWORD: for a public lobby table it is '' (what the server itself hands back in
// ri.pwd), for a locked table it is that table's password. Membership is proven by the ensuing TABLE_STATE ps[],
// never by this send.
function buildJoinFrame(channel, code = '') { return JSON.stringify([3, ZONE, channel, code != null ? String(code) : '']); }
// Room-plugin cmd 5 at the current table = the game's SẴN SÀNG (INGAME_USER_READY; client shape [5,"Simms",roomID,
// {cmd:5}] from its sendReady). For the table HOST the same cmd is BẮT ĐẦU — the tool never sends it for a host.
function buildTableReadyFrame(rid) { return JSON.stringify([5, ZONE, Number(rid), { cmd: 5 }]); }
// CMD 363 SET_AUTO_READY — the account's server-side "tự sẵn sàng" preference (game's sendAutoReadyPref, aRd = "true"/
// "false"). While on, the game client readies by itself whenever it sits down or a round ends.
function buildAutoReadyPrefFrame(on) { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 363, aRd: on ? 'true' : 'false' }]); }
// op 4 — leave the CURRENT room (-1 = the room this socket is in).
function buildLeaveFrame() { return JSON.stringify([4, ZONE, -1]); }

module.exports = { buildTableReadyFrame, buildAutoReadyPrefFrame, buildQuickPlayFrame, buildChannelListFrame, buildJoinFrame, buildLeaveFrame };
