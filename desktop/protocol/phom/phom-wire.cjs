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
// CMD 311 — the game's own quick-find (observed, not used by the tool's discovery).
function buildFindTableFrame() { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 311, gid: GID }]); }
// op 3 — join a room by its id. Membership is proven by the ensuing TABLE_STATE ps[], never by this send.
function buildJoinFrame(channel) { return JSON.stringify([3, ZONE, channel, '']); }
// CMD 363 — mark ready at the current table.
function buildReadyFrame() { return JSON.stringify([6, ZONE, 'channelPlugin', { cmd: 363, aRd: 'true' }]); }
// op 4 — leave the CURRENT room (-1 = the room this socket is in).
function buildLeaveFrame() { return JSON.stringify([4, ZONE, -1]); }

module.exports = { buildChannelListFrame, buildFindTableFrame, buildJoinFrame, buildReadyFrame, buildLeaveFrame };
