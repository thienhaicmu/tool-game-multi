'use strict';

// Connection-aware Aviator socket ownership (§12). A BrowserRun's page holds many
// WebSockets — the Aviator game gateway PLUS unrelated ones (portal/card lobby,
// gemsdatapi, millicast video, other side channels) that open & close constantly.
// Recovery must treat ONLY the socket actually delivering classified Aviator SERVER
// evidence as the owning game socket; only its close means the game context is lost.
// Treating any close as Aviator loss caused false recoveries that reloaded a HEALTHY
// live round.
//
// Pure + Electron-free so the decision is deterministically unit-testable; the main
// process binds run._aviatorWsKey from observeRecv and gates recovery on isOwningClose.

const { AVIATOR_EVIDENCE_CMDS } = require('../protocol/aviator-context.cjs');

// Exact WebSocket identity: target:session:request. CDP reuses requestId per target,
// so target+session are part of the key (distinguishes sockets across reloads too).
function wsKeyOf(x) {
  return `${x && x.targetId != null ? x.targetId : ''}:${x && x.cdpSessionId != null ? x.cdpSessionId : ''}:${x && x.cdpRequestId != null ? x.cdpRequestId : ''}`;
}

// Authoritative Aviator server evidence = a classified round-lifecycle/ODD cmd or a
// Jackpot (eI.jp) value. Lobby/side-channel chatter classifies to neither.
function isAviatorEvidence(cls) {
  return !!(cls && (AVIATOR_EVIDENCE_CMDS.has(cls.cmd) || cls.jp != null));
}

// A WS close is Aviator context loss ONLY when it is the currently-bound owning socket.
// A null ownerKey (no Aviator socket identified yet) never matches — unrelated closes
// are ignored (whole-page/target loss is handled separately by target-removed).
function isOwningClose(ownerKey, closedReq) {
  return ownerKey != null && wsKeyOf(closedReq) === ownerKey;
}

module.exports = { wsKeyOf, isAviatorEvidence, isOwningClose };
