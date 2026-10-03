'use strict';

// Which captured WebSocket frames the Phỏm tool keeps — decided at the capture, before any object is built, any JSON
// parsed, any buffer or log written. Three browsers each receive ~15 foreign frames a second (other games' jackpot /
// lobby broadcasts, the socket.io notification channel, heartbeats); handling all of them made the tool stall and
// the games lag. Cheap string tests only.
//
// Kept: every Phỏm protocol frame (a JSON array), in both directions, including the heartbeat ACK [6,1,n] the
// liveness check uses. Dropped:
//   - anything that is not a JSON array: socket.io ("451-…", "2"/"3"), the encrypted blobs, binary frames
//   - the outgoing heartbeat ["7","Simms","1",n] / ["7","MiniGame",…]
//   - the foreign pushes the coordinator always ignored: cmd 10 / 1015 / 10000 / 10003 / 10004, and any push of
//     another game (gid ≠ 8) that does not mention the Phỏm zone

const FOREIGN_CMD = /"cmd":(?:10|1015|10000|10003|10004)[,}]/;
const GID = /"gid":(\d+)/;

function isPhomRelevant(raw, dir) {
  if (typeof raw !== 'string' || raw.charCodeAt(0) !== 91 /* [ */) return false;
  if (dir === 'send') return !raw.startsWith('["7"');
  if (FOREIGN_CMD.test(raw)) return false;
  const g = GID.exec(raw);
  if (g && g[1] !== '8' && raw.indexOf('Simms') < 0) return false;
  return true;
}

module.exports = { isPhomRelevant };
