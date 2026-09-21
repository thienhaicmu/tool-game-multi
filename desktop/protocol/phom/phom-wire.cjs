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
// CMD 311 — the game client names it CREATE_TABLE_RESPONSE: "which stakes may this account create a table at";
// the server replies { b:[…], mB }. Not used by the tool's discovery.
function buildFindTableFrame() { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 311, gid: GID }]); }
// The same CMD 311 exactly as the game's TẠO BÀN button sends it (requestcreateRoomResponse: {cmd:311,gid,aid:1}) —
// the first half of the create flow; the reply's b[] is the stake list the popup offers.
function buildCreateOptionsFrame() { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 311, gid: GID, aid: 1 }]); }
// CMD 308 CREATE_TABLE — the game's own "TẠO BÀN". Shape copied from the game client's requestcreateRoom(gid, b,
// Mu, pwd): {cmd:308, aid:1, gid, b, Mu, iJ:true, inc:false, pwd}. The server answers [5,{ri:{rid,b,sid,Mu,gid,pwd},
// cmd:308}] (or {mgs:"…"} when refused) and the game client then JOINs ri.rid by itself. For PHỎM the game's popup
// refuses an empty password ("Chưa nhập mật khẩu bàn!") and the server silently drops a 308 without one (live
// capture 2026-09-21: three creates, no reply) — so a Phỏm table is always created with a room key.
function buildCreateTableFrame({ stake, maxPlayers = 4, password = '' } = {}) {
  return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 308, aid: 1, gid: GID, b: Number(stake), Mu: Number(maxPlayers), iJ: true, inc: false, pwd: password != null ? String(password) : '' }]);
}
// op 3 — join a room. Element [3] is the positional ROOM CODE: '' = public matchmaking (server picks a table);
// a non-empty code (the anchor's hpwd) targets that specific table so followers co-seat. Membership is proven by
// the ensuing TABLE_STATE ps[], never by this send.
function buildJoinFrame(channel, code = '') { return JSON.stringify([3, ZONE, channel, code != null ? String(code) : '']); }
// Room-plugin cmd 5 at the current table = the game's SẴN SÀNG (INGAME_USER_READY; client shape [5,"Simms",roomID,
// {cmd:5}] from its sendReady). For the table HOST the same cmd is BẮT ĐẦU — the tool never sends it for a host.
function buildTableReadyFrame(rid) { return JSON.stringify([5, ZONE, Number(rid), { cmd: 5 }]); }
// CMD 363 SET_AUTO_READY — the account's server-side "tự sẵn sàng" preference (game's sendAutoReadyPref, aRd = "true"/
// "false"). While on, the game client readies by itself whenever it sits down or a round ends.
function buildAutoReadyPrefFrame(on) { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 363, aRd: on ? 'true' : 'false' }]); }
// CMD 363 — mark ready at the current table.
function buildReadyFrame() { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 363, aRd: 'true' }]); }
// op 4 — leave the CURRENT room (-1 = the room this socket is in).
function buildLeaveFrame() { return JSON.stringify([4, ZONE, -1]); }

// A fresh room key for a table the tool creates: 6 random digits. Only the tool's own browsers are told it.
function newRoomKey(rand = Math.random) { return String(Math.floor(rand() * 900000) + 100000); }

module.exports = { buildTableReadyFrame, buildAutoReadyPrefFrame, buildCreateTableFrame, buildCreateOptionsFrame, newRoomKey, buildChannelListFrame, buildFindTableFrame, buildJoinFrame, buildReadyFrame, buildLeaveFrame };
