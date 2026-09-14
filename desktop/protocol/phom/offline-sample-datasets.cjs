'use strict';

// ---------------------------------------------------------------------------
// Built-in, REDACTED/SYNTHETIC Phỏm datasets for the Offline Realtime Simulator
// (§7 allowed sources). These are hand-authored wire traces — NO real account,
// NO token/cookie, NO live capture. They ship with the app so the QA simulator
// has deterministic data to replay without ever touching the network.
//
// Card codes follow the codec (§13): code = rankIndex*4 + suitIndex.
//   0=A♠ 1=A♣ 2=A♦ 3=A♥ ... 12=4♠ 16=5♠ 20=6♠ 24=7♠ ... 40=J♠ 44=Q♠ 48=K♠
//
// Each entry is { seq, frame } where frame is a SmartFoxServer-style wire array
// the shared classifier understands: [5, { cmd, ... }].
// ---------------------------------------------------------------------------

const OWNER = '1001';
const OPP = '1002';

// A full, coherent round for the simulated owner (uid 1001). Exercises every
// command 850..854, an eatable public discard, a self-discard, a public meld and
// a round end — so counters visibly change after each event.
const BASIC_ROUND = Object.freeze([
  // 850 DEAL — opening 9 cards. Contains two ready runs (4-5-6♠, J-Q-K♠) + a pair.
  { seq: 1, frame: [5, { cmd: 850, cs: [0, 1, 12, 16, 20, 40, 44, 48, 5], tP: { uid: OWNER } }] },
  // 852 DRAW — owner draws A♦ (2). Server sends authoritative full hand + melds.
  { seq: 2, frame: [5, { cmd: 852, uid: OWNER, cs: 2, sAC: [0, 1, 2, 12, 16, 20, 40, 44, 48, 5], sMs: [0, 1, 2, 12, 16, 20, 40, 44, 48] }] },
  // 851 PLAY — opponent discards 7♠ (24); owner could EAT it (extends 4-5-6♠).
  { seq: 3, frame: [5, { cmd: 851, fP: { uid: OPP, dCs: 24 }, tP: { uid: OWNER } }] },
  // 851 PLAY — owner discards the loose 2♣ (5); turn passes to opponent.
  { seq: 4, frame: [5, { cmd: 851, fP: { uid: OWNER, dCs: 5 }, tP: { uid: OPP } }] },
  // 854 MELD — owner lays down the 4-5-6♠ run publicly.
  { seq: 5, frame: [5, { cmd: 854, uid: OWNER, mes: [{ meid: 1, cs: [12, 16, 20] }] }] },
  // 853 ROUND_END — authoritative final snapshot + money delta for owner.
  { seq: 6, frame: [5, { cmd: 853, uid: OWNER, sAC: [0, 1, 2, 40, 44, 48], sMs: [0, 1, 2, 40, 44, 48], fP: { uid: OWNER, lm: 120 } }] },
]);

const DATASETS = Object.freeze([
  Object.freeze({ id: 'basic-round', name: 'Ván mẫu 850→853 (redacted)', sourceKind: 'REDACTED_REPLAY', simulatedOwnerUid: OWNER, events: BASIC_ROUND }),
]);

function listDatasets() {
  return DATASETS.map((d) => ({ id: d.id, name: d.name, sourceKind: d.sourceKind, simulatedOwnerUid: d.simulatedOwnerUid, eventCount: d.events.length }));
}

function getDataset(id) {
  return DATASETS.find((d) => d.id === String(id)) || null;
}

module.exports = { OWNER, OPP, BASIC_ROUND, DATASETS, listDatasets, getDataset };
