'use strict';

// ---------------------------------------------------------------------------
// PURE Phỏm hand reducer. previousState + classifiedEvent -> nextState.
//
// One HandState belongs to ONE profile and is fed ONLY by frames captured on
// THAT profile's own game socket (the caller routes by browserRunId/targetId).
// The reducer never invents cards and never infers a hidden hand: it only
// applies AUTHORITATIVE server evidence addressed to this profile's own uid.
//
// Ordering / dedup: every event carries the capture correlator's monotonic
// `seq`. An event whose seq is <= the last applied seq is a duplicate or a
// late/out-of-order frame and is ignored (no double add/remove, no dirtying a
// fresh round). This is a stronger guarantee than timestamps.
// ---------------------------------------------------------------------------

const { isValidCardCode, decodeCards, sortCardCodes } = require('./card-codec.cjs');

const SYNC = Object.freeze({
  EMPTY: 'EMPTY',       // no cards observed yet this session
  LIVE: 'LIVE',         // authoritative, in-round, consistent
  STALE: 'STALE',       // connection lost / snapshot may be outdated
  DESYNCED: 'DESYNCED', // an event disagreed with local hand — do NOT fabricate
  ENDED: 'ENDED',       // round finished; snapshot frozen
});

function emptyHand(profileId, uid) {
  return Object.freeze({
    profileId: profileId != null ? String(profileId) : null,
    uid: uid != null ? String(uid) : null,
    physicalTableIdentity: null,
    seat: null,
    roundSeq: 0,
    roundIdentity: null,
    cardsRaw: [],
    decodedCards: [],
    sortedCards: [],
    serverMelds: [],          // sMs codes (server-computed melds for OWN hand)
    publicMelds: [],          // [{ meid, cards }] laid down publicly by this uid (854)
    discardedCards: [],       // cards THIS profile has discarded this round (public)
    cardCount: 0,
    authoritative: false,
    revision: 0,
    syncState: SYNC.EMPTY,
    sourceCommand: null,
    lastAppliedSeq: -1,
    lastDrawn: null,
    lastDiscarded: null,
    currentTurnUid: null,
    resultDelta: null,        // fP.lm for this profile at round end (numeric money delta)
    updatedAt: null,
    lastError: null,
  });
}

// Build the derived views (decoded/sorted/count) from a raw code list, validating
// every code. Invalid codes never silently coerce — they flip DESYNCED.
function withCards(state, cardsRaw, patch) {
  const clean = Array.isArray(cardsRaw) ? cardsRaw : [];
  const allValid = clean.every(isValidCardCode);
  if (!allValid) {
    return freeze({ ...state, ...patch, syncState: SYNC.DESYNCED, lastError: 'PHOM_INVALID_CARD_CODE' });
  }
  let decoded;
  try { decoded = decodeCards(clean); } catch { return freeze({ ...state, ...patch, syncState: SYNC.DESYNCED, lastError: 'PHOM_INVALID_CARD_CODE' }); }
  return freeze({
    ...state,
    ...patch,
    cardsRaw: [...clean],
    decodedCards: decoded,
    sortedCards: sortCardCodes(clean),
    cardCount: clean.length,
  });
}

function freeze(s) { return Object.freeze(s); }
function sameUid(a, b) { return a != null && b != null && String(a) === String(b); }

/**
 * reduceHand(prevState, event, ctx) -> nextState (pure, always returns a frozen state).
 *   event: a descriptor from classifyPhomFrame (or a synthetic control event).
 *   ctx:   { profileUid, seq, now }
 */
function reduceHand(prev, event, ctx = {}) {
  const state = prev || emptyHand(ctx.profileId, ctx.profileUid);
  if (!event || typeof event !== 'object') return state;
  const now = ctx.now != null ? ctx.now : Date.now();
  const seq = Number.isFinite(ctx.seq) ? ctx.seq : null;

  // Ordering / dedup guard: ignore duplicates and out-of-order/late frames.
  if (seq != null && seq <= state.lastAppliedSeq && event.type !== 'CONTROL') {
    return state;
  }

  const profileUid = ctx.profileUid != null ? ctx.profileUid : state.uid;
  const bump = (patch) => freeze({ ...state, ...patch, revision: state.revision + 1, lastAppliedSeq: seq != null ? seq : state.lastAppliedSeq, updatedAt: now });

  switch (event.type) {
    case 'DEAL': {
      // Opening deal for the receiving session: authoritative 9 cards, new round.
      if (!Array.isArray(event.cs)) return state; // DEAL always carries cs[]
      const roundSeq = state.roundSeq + 1;
      const nextBase = {
        ...emptyHand(state.profileId, profileUid),
        physicalTableIdentity: state.physicalTableIdentity,
        seat: state.seat,
        roundSeq,
        roundIdentity: `R${roundSeq}`,
        authoritative: true,
        syncState: SYNC.LIVE,
        sourceCommand: 850,
        revision: state.revision + 1,
        lastAppliedSeq: seq != null ? seq : state.lastAppliedSeq,
        currentTurnUid: event.tP && event.tP.uid != null ? String(event.tP.uid) : null,
        updatedAt: now,
      };
      return withCards(nextBase, event.cs, {});
    }

    case 'DRAW': {
      // A player drew. Only OWN session gets an authoritative full hand (sAC/sMs).
      if (!sameUid(event.uid, profileUid)) {
        // Public: another player drew. Do not touch this profile's hidden hand.
        return bump({ sourceCommand: 852 });
      }
      if (Array.isArray(event.sAC)) {
        return withCards(
          { ...state, revision: state.revision + 1, lastAppliedSeq: seq != null ? seq : state.lastAppliedSeq, updatedAt: now },
          event.sAC,
          {
            authoritative: true,
            syncState: SYNC.LIVE,
            sourceCommand: 852,
            serverMelds: Array.isArray(event.sMs) ? [...event.sMs] : state.serverMelds,
            lastDrawn: isValidCardCode(event.cs) ? event.cs : (typeof event.cs === 'number' ? event.cs : null),
          }
        );
      }
      // Own draw but no authoritative full hand: append the single drawn card if valid.
      if (isValidCardCode(event.cs)) {
        return withCards(
          { ...state, revision: state.revision + 1, lastAppliedSeq: seq != null ? seq : state.lastAppliedSeq, updatedAt: now },
          [...state.cardsRaw, event.cs],
          { sourceCommand: 852, lastDrawn: event.cs, syncState: SYNC.LIVE }
        );
      }
      return bump({ sourceCommand: 852 });
    }

    case 'PLAY': {
      // Public discard + turn change. fP.uid discarded fP.dCs; turn -> tP.uid.
      const fpUid = event.fP && event.fP.uid != null ? String(event.fP.uid) : null;
      const dCs = event.fP && event.fP.dCs != null ? event.fP.dCs : null;
      const turnUid = event.tP && event.tP.uid != null ? String(event.tP.uid) : state.currentTurnUid;
      if (sameUid(fpUid, profileUid) && dCs != null) {
        const idx = state.cardsRaw.indexOf(dCs);
        if (idx === -1) {
          // We are the discarder but the card is not in our hand -> desync, never fabricate.
          return bump({ sourceCommand: 851, currentTurnUid: turnUid, syncState: SYNC.DESYNCED, lastError: 'PHOM_HAND_DESYNCED' });
        }
        const nextCards = state.cardsRaw.slice(0, idx).concat(state.cardsRaw.slice(idx + 1));
        return withCards(
          { ...state, revision: state.revision + 1, lastAppliedSeq: seq != null ? seq : state.lastAppliedSeq, updatedAt: now },
          nextCards,
          {
            sourceCommand: 851,
            currentTurnUid: turnUid,
            lastDiscarded: dCs,
            discardedCards: [...state.discardedCards, dCs],
          }
        );
      }
      // Someone else discarded: only turn + public discard evidence changes.
      return bump({ sourceCommand: 851, currentTurnUid: turnUid, lastDiscarded: dCs });
    }

    case 'MELD': {
      // Public meld laid down. Attach ONLY when it belongs to this profile's uid.
      if (!sameUid(event.uid, profileUid)) return bump({ sourceCommand: 854 });
      const melds = Array.isArray(event.mes) ? event.mes.map((m) => ({
        meid: m && m.meid != null ? m.meid : null,
        cards: Array.isArray(m && m.cs) ? m.cs.filter(isValidCardCode) : [],
      })) : [];
      // Do NOT remove hidden cards: meld visibility is public state, not proof the
      // server dropped them from sAC.
      return bump({ sourceCommand: 854, publicMelds: melds });
    }

    case 'ROUND_END': {
      // Round end. Prefer an authoritative final snapshot for this profile.
      const patch = {
        sourceCommand: 853,
        syncState: SYNC.ENDED,
        serverMelds: Array.isArray(event.sMs) ? [...event.sMs] : state.serverMelds,
        resultDelta: readMoneyDelta(event, profileUid),
      };
      if (Array.isArray(event.sAC) && (event.uid == null || sameUid(event.uid, profileUid))) {
        return withCards(
          { ...state, revision: state.revision + 1, lastAppliedSeq: seq != null ? seq : state.lastAppliedSeq, updatedAt: now },
          event.sAC,
          patch
        );
      }
      return bump(patch);
    }

    // ---- synthetic control events (connection lifecycle) ----
    case 'CONTROL': {
      if (event.control === 'DISCONNECT') {
        // A live hand becomes STALE on disconnect; never keeps showing LIVE.
        if (state.syncState === SYNC.LIVE) return freeze({ ...state, syncState: SYNC.STALE, updatedAt: now });
        return freeze({ ...state, updatedAt: now });
      }
      if (event.control === 'SEAT') {
        return freeze({ ...state, seat: event.seat != null ? event.seat : state.seat, physicalTableIdentity: event.physicalTableIdentity != null ? event.physicalTableIdentity : state.physicalTableIdentity, uid: profileUid != null ? String(profileUid) : state.uid, updatedAt: now });
      }
      return state;
    }

    default:
      // UNKNOWN / non-hand events never mutate the hand.
      return state;
  }
}

// fP.lm = money delta for the acting player at round end. Keep numeric only.
function readMoneyDelta(event, profileUid) {
  if (event.fP && sameUid(event.fP.uid, profileUid) && typeof event.fP.lm === 'number') return event.fP.lm;
  return null;
}

module.exports = { SYNC, emptyHand, reduceHand };
