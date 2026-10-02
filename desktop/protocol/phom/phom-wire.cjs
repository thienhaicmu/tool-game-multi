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
// CMD 313 QUICK_PLAY_WITH_BET — "name me a table at this stake that still has room". Shape taken from the LIVE
// client (capture 2026-10-02, v.hitclub.guitars): `[6,"Simms","channelPlugin",{cmd:313,gid:8,aid:1,b:20000}]`,
// repeated every ~1.7s while the player looks for a table. The older build in the code cache sent the same thing
// as cmd 307 (QUICK_PLAY) with an extra `inc:false`; the live server answers 313, so that is what the tool sends.
//
// The answer is [5,{ri:{rid,b,sid,Mu,uC,hpwd,rn,…}, cmd:313}] — or {mgs:"Không tìm thấy phòng thích hợp!"}. It
// NAMES a table (số bàn + how many are seated) but does NOT seat anyone: the client JOINs it afterwards. Two
// things the answer must be checked for: `rn` ends with '#n' for a stake CHANNEL (e.g. rid 145 "Phom#6"), which is
// not a shareable số bàn, and `Mu - uC` is the room actually left at that table.
//
// This is what the tool uses instead of CREATE_TABLE (308): a created Phỏm table always needs a password (the
// server silently drops a 308 without one), and a password-locked table is one NO other player can enter from the
// lobby list — the opposite of what the group needs.
function buildQuickPlayFrame({ stake = null } = {}) {
  const p = { cmd: 313, gid: GID, aid: 1 };
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
