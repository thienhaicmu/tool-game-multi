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
// The tool asks it from the NON-KEY accounts only ("Tạo"): repeated until the server names a table with exactly one
// player, which may be the KEY sitting alone (see buildProbeJoinFrame / buildJoinTableFrame).
function buildQuickPlayFrame({ stake = null } = {}) {
  const p = { cmd: 313, gid: GID, aid: 1 };
  if (Number(stake) > 0) p.b = Number(stake);
  return JSON.stringify([6, ZONE, 'channelPlugin', p]);
}
// op 3 — join a room, exactly as the game client's requestJoinRoom(rid, sid, pwd) builds it: [3,"Simms",rid,pwd].
// Element [3] is the room's PASSWORD. Sent to a 7-digit TABLE this is NOT "sit at this table" (09-21: two browsers
// sent it to the same số bàn and each became host of a fresh table) — that is op 8 below. The tool uses op 3 only for
// the two shapes the reference tool uses: the stake-channel quick-play and the password probe.
function buildJoinFrame(channel, code = '') { return JSON.stringify([3, ZONE, channel, code != null ? String(code) : '']); }
// op 8 — sit at THIS EXACT table: [8,"Simms",<số bàn>,"",8] (last element = gid). Taken from the reference tool's
// live traffic (capture 2026-10-02 22:24/22:27/22:28, three accounts merged): every "Vào" / "ReJoin" it sends is
// this frame, the server answers [3,true,0,-1,null] + the TABLE_STATE of that very table (the KEY's ps[] row), and a
// kicked member sent it 9 times in a row and landed back at the same table every time.
function buildJoinTableFrame(rid, pwd = '') { return JSON.stringify([8, ZONE, Number(rid), pwd != null ? String(pwd) : '', GID]); }
// op 3 with the quick-play flag — "seat me at some table of this stake CHANNEL": [3,"Simms",<channel rid>,"",true].
// The reference tool's "Dò Key" repeats it (leaving again whenever strangers are already seated) until the account
// lands ALONE at a table, i.e. it is the host of an empty public table — the group's KEY.
function buildChannelQuickJoinFrame(channelRid) { return JSON.stringify([3, ZONE, Number(channelRid), '', true]); }
// The password the reference tool's "Tạo" sends after every 313 answer: one invisible U+200B. No table has it, so the
// join is always refused (103 "Sai mật khẩu phòng") and the account never sits down at a stranger's table; only a
// table with one player (uC 1 — maybe the KEY, alone) is then really joined, with op 8.
const PROBE_PASSWORD = '​';
function buildProbeJoinFrame(rid) { return buildJoinFrame(Number(rid), PROBE_PASSWORD); }
// Room-plugin cmd 5 at the current table = the game's SẴN SÀNG (INGAME_USER_READY; client shape [5,"Simms",roomID,
// {cmd:5}] from its sendReady). For the table HOST the same cmd is BẮT ĐẦU — the tool never sends it for a host.
function buildTableReadyFrame(rid) { return JSON.stringify([5, ZONE, Number(rid), { cmd: 5 }]); }
// CMD 363 SET_AUTO_READY — the account's server-side "tự sẵn sàng" preference (game's sendAutoReadyPref, aRd = "true"/
// "false"). While on, the game client readies by itself whenever it sits down or a round ends.
function buildAutoReadyPrefFrame(on) { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 363, aRd: on ? 'true' : 'false' }]); }
// op 4 — leave the CURRENT room (-1 = the room this socket is in).
function buildLeaveFrame() { return JSON.stringify([4, ZONE, -1]); }

module.exports = { buildTableReadyFrame, buildAutoReadyPrefFrame, buildQuickPlayFrame, buildChannelListFrame, buildJoinFrame, buildJoinTableFrame, buildChannelQuickJoinFrame, buildProbeJoinFrame, PROBE_PASSWORD, buildLeaveFrame };
