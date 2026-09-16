'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.3.2 — PHỎM CARD OBSERVATION ENGINE (pure, stateful, protocol-side).
//
// A SINGLE table-level observer that watches ONE current round and records only
// what the real protocol proves. It consumes the SAME classified frames the
// coordinator already produces (classifyPhomFrame → cls) — no second WS listener,
// no second CDP connection, no duplicate parsing. It NEVER sends and NEVER plays.
//
// Evidence surface (audited from card-codec / hand-reducer / phom-frame-classify):
//   DEAL  850  cs:[9]                 → the SOCKET OWNER's opening hand (own)
//   DRAW  852  uid, cs, sAC[], sMs[]  → own session gets sAC (full hand); a public
//                                        draw by another uid does NOT expose the card
//   PLAY  851  fP:{uid,dCs}, tP:{uid} → PUBLIC discard for ANY player (dCs single|multi)
//   MELD  854  uid, mes:[{meid,cs[]}] → PUBLIC meld laid down
//   END   853  sAC[], sMs[], fP.lm    → round end (own final hand)
//   TABLE_STATE ps[] {sit,uid,dn,r}   → seat / name / membership for ALL seats
//
// What is NOT in the protocol (kept UNSUPPORTED — never fabricated):
//   - another player's HIDDEN hand / their drawn CARD (only the fact of a draw)
//   - a server round id (we keep an INTERNAL roundSeq; roundId stays null)
//
// The 3 controlled browsers sit at the SAME table, so PUBLIC events (PLAY/MELD/
// TABLE_STATE) are ECHOED on all three sockets. The card LEDGER + per-event
// evidenceKey dedup collapses those echoes into ONE observation (§6).
// ---------------------------------------------------------------------------

const { isValidCardCode, decodeCard, MIN_CODE, MAX_CODE } = require('./card-codec.cjs');

// Ledger card statuses (§13). Terminal (public, one-way) statuses win over CURRENT.
const STATUS = Object.freeze({ CURRENT: 'CURRENT', DRAWN: 'DRAWN', DISCARDED: 'DISCARDED', MELDED: 'MELDED', UNKNOWN: 'UNKNOWN' });
const TERMINAL = Object.freeze(new Set([STATUS.DISCARDED, STATUS.MELDED]));

// What THIS protocol proves (audited). Consumers must not assume more than this.
const CAPABILITIES = Object.freeze({
  currentCards: true,        // own hand only (DEAL cs / DRAW sAC / END sAC) — controlled browsers
  draw: true,                // own draw authoritative; a public draw's card is NOT exposed
  discard: true,             // PUBLIC (PLAY fP.dCs) for every player at the table
  multiCardDiscard: true,    // engine handles dCs as number|array (live evidence: single)
  meld: true,                // PUBLIC (MELD 854 mes[])
  otherPlayers: true,        // discards + melds + seat/name for non-controlled players
  otherPlayerHand: false,    // hidden — UNSUPPORTED_BY_CURRENT_PROTOCOL
  serverRoundId: false,      // no server round id — UNSUPPORTED_BY_CURRENT_PROTOCOL (internal roundSeq only)
  remainingCards: true,      // derived: canonical 52 − proven-out (ledger)
});

// Normalize one raw card into a valid integer code, or null (never coerce garbage).
function normalizeCard(raw) { return isValidCardCode(raw) ? raw : null; }
// Normalize a discard/meld payload (number OR array) into an ordered list of valid codes (§5/§11).
function normalizeCards(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const v of arr) if (isValidCardCode(v)) out.push(v);
  return out;
}
// UI-ready decoded view for a code (reuses the single card-codec source of truth).
function decodeView(code) { const d = decodeCard(code); return { code, label: d.label, rank: d.rank, suit: d.suit, color: d.color }; }

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o; }
  return v;
}

class CardObserver {
  constructor(deps = {}) {
    this._runId = deps.runId != null ? String(deps.runId) : null;
    this._now = typeof deps.now === 'function' ? deps.now : (() => Date.now());
    // Debug is OFF by default; when off NO card data is ever logged (§22).
    this._logEnabled = deps.logEnabled != null ? !!deps.logEnabled : (process.env.PHOM_CARD_OBSERVER_LOG === '1');
    this._logFn = typeof deps.log === 'function' ? deps.log : ((event, data) => { try { console.error(`[phom-card-observer] ${event}`, data == null ? '' : data); } catch { /* ignore */ } });

    this._roundSeq = 0;         // INTERNAL observation counter (not a server round id)
    this._roundActive = false;
    this._startedAt = null;
    this._currentTurnUid = null;

    this._players = new Map();  // uid -> player state
    this._slotBinding = { B1: null, B2: null, B3: null };
    this._pendingOwnHand = {};  // slot -> { cards, source } captured before its uid was known
    this._discardPile = [];     // ordered codes (all players, this round)
    this._observedDiscardEvents = []; // [{ uid, cards, source, observedAt, evidenceKey }]
    this._ledger = new Map();   // code -> { code, status, ownerUid, source, observedAt, evidenceKey }
    this._seenEvents = new Set(); // evidenceKey dedup (draws/discards/melds)
    this._analysisPlayer = null;  // §19 — selected analysis angle (never merges hands)
  }

  // ---- identity / players ----
  _player(uid) {
    const id = String(uid);
    let p = this._players.get(id);
    if (!p) {
      p = { uid: id, seat: null, name: null, controlled: false, slot: null,
        currentCards: [], currentCardsSource: null, currentCardsAt: null,
        drawnHistory: [], discardedHistory: [], melds: [] };
      this._players.set(id, p);
    }
    return p;
  }

  // Bind a browser SLOT (B1/B2/B3) to its AUTHORITATIVE own uid (from ctx.uid()), never the
  // browser index (§7). Flushes any own hand captured before the uid was known.
  _bindSlot(slot, uid, now) {
    if (!slot || uid == null) return;
    const s = String(slot); const u = String(uid);
    if (!(s in this._slotBinding)) return; // only B1/B2/B3
    const p = this._player(u); p.controlled = true; p.slot = s;
    if (this._slotBinding[s] === u) return;
    this._slotBinding[s] = u;
    this._log('PLAYER_BIND', { slot: s });
    const pend = this._pendingOwnHand[s];
    if (pend) { this._setCurrentCards(u, pend.cards, pend.source, now); delete this._pendingOwnHand[s]; }
  }

  // ---- round lifecycle (§10) ----
  // A new round is delimited by the protocol's ROUND_END → DEAL cycle (never a timeout).
  resetRound(meta = {}) {
    this._roundSeq += 1;
    this._roundActive = true;
    this._startedAt = meta.now != null ? meta.now : this._now();
    this._currentTurnUid = null;
    // Clear per-round CARD data; KEEP identity (uid/seat/name/controlled/slot) and slot binding.
    for (const p of this._players.values()) {
      p.currentCards = []; p.currentCardsSource = null; p.currentCardsAt = null;
      p.drawnHistory = []; p.discardedHistory = []; p.melds = [];
    }
    this._discardPile = [];
    this._observedDiscardEvents = [];
    this._ledger.clear();
    this._seenEvents.clear();
    this._pendingOwnHand = {};
    this._log('ROUND_RESET', { roundSeq: this._roundSeq, reason: meta.reason || null });
  }
  // Lazily open round 1 when card evidence arrives before any DEAL was observed (mid-round attach).
  _ensureRound(now) { if (this._roundSeq === 0) this.resetRound({ now, reason: 'FIRST_EVIDENCE' }); }

  // ---- ingestion ----
  // input: { slot, ownUid, cls, seq, now }. cls is the classifyPhomFrame descriptor.
  ingestFrame(input = {}) {
    const cls = input && input.cls;
    if (!cls || typeof cls !== 'object') return;
    const now = input.now != null ? input.now : this._now();
    if (input.slot && input.ownUid != null) this._bindSlot(input.slot, input.ownUid, now);
    switch (cls.type) {
      case 'TABLE_STATE': this.ingestTableState(cls, { now }); break;
      case 'DEAL': this._onDeal(cls, input.slot, input.ownUid, now); break;
      case 'DRAW': this._onDraw(cls, input.slot, input.ownUid, now); break;
      case 'PLAY': this._onPlay(cls, now); break;
      case 'MELD': this._onMeld(cls, now); break;
      case 'ROUND_END': this._onRoundEnd(cls, input.slot, input.ownUid, now); break;
      default: break; // non-card frames never mutate observation
    }
  }

  // TABLE_STATE ps[] binds seat + name + membership for EVERY seat (own + others). No card data here.
  ingestTableState(cls, meta = {}) {
    const ps = cls && Array.isArray(cls.ps) ? cls.ps : null;
    if (!ps) return;
    for (const seat of ps) {
      if (!seat || typeof seat !== 'object') continue;
      const uid = seat.uid != null ? String(seat.uid) : null;
      if (uid == null) continue;
      const p = this._player(uid);
      if (seat.sit != null) p.seat = seat.sit;
      if (seat.dn != null) p.name = String(seat.dn);
    }
  }

  _onDeal(cls, slot, ownUid, now) {
    // ROUND_END → DEAL delimiter: the first DEAL after a round closed opens a new round. Extra DEALs
    // WITHIN an active round (the other two controlled browsers' own deals) must NOT reset it (§10/§6).
    if (!this._roundActive) this.resetRound({ now, reason: 'DEAL_NEW_ROUND' });
    else this._ensureRound(now);
    if (cls.tP && cls.tP.uid != null) this._currentTurnUid = String(cls.tP.uid);
    const cards = normalizeCards(cls.cs);
    if (!cards.length) return;
    const uid = ownUid != null ? String(ownUid) : (slot && this._slotBinding[slot]) || null;
    if (uid != null) { this._setCurrentCards(uid, cards, 'DEAL', now); }
    else if (slot) { this._pendingOwnHand[slot] = { cards, source: 'DEAL' }; } // flush on bind
  }

  _onDraw(cls, slot, ownUid, now) {
    this._ensureRound(now);
    if (Array.isArray(cls.sAC)) {
      // OWN authoritative full hand.
      const uid = ownUid != null ? String(ownUid) : (slot && this._slotBinding[slot]) || (cls.uid != null ? String(cls.uid) : null);
      if (uid != null) {
        this._setCurrentCards(uid, normalizeCards(cls.sAC), 'DRAW', now);
        const drawn = normalizeCard(cls.cs);
        if (drawn != null) this._recordDraw(uid, drawn, 'DRAW_OWN', now);
      }
      return;
    }
    // PUBLIC draw by another player: the DRAWN CARD is NOT exposed (§5B) — record nothing we cannot see.
    // (We deliberately do not fabricate a card just because a draw happened.)
  }

  _recordDraw(uid, card, source, now) {
    const key = `DR:${this._roundSeq}:${uid}:${card}`;
    if (this._seenEvents.has(key)) { this._log('DEDUP', { kind: 'draw' }); return; }
    this._seenEvents.add(key);
    const p = this._player(uid);
    p.drawnHistory.push({ card, source, observedAt: now, evidenceKey: key });
    this._setLedger(card, STATUS.CURRENT, uid, source, now, key); // a drawn card is now in hand
    this._log('DRAW_OBSERVED', { source });
  }

  _onPlay(cls, now) {
    this._ensureRound(now);
    const fp = cls.fP;
    if (!fp || fp.uid == null) return;
    const uid = String(fp.uid);
    const cards = normalizeCards(fp.dCs);
    if (cls.tP && cls.tP.uid != null) this._currentTurnUid = String(cls.tP.uid);
    if (!cards.length) return;
    const newCards = [];
    for (const code of cards) {
      const key = `DC:${this._roundSeq}:${code}`; // a card is discarded at most once per round
      if (this._seenEvents.has(key)) { this._log('DEDUP', { kind: 'discard' }); continue; }
      this._seenEvents.add(key);
      newCards.push(code);
      const p = this._player(uid);
      p.discardedHistory.push({ card: code, source: 'PLAY', observedAt: now, evidenceKey: key });
      this._discardPile.push(code);
      this._setLedger(code, STATUS.DISCARDED, uid, 'PLAY', now, key);
      this._removeFromHands(code); // a discarded card leaves every hand
      this._log('DISCARD_OBSERVED', {});
    }
    if (newCards.length) {
      this._observedDiscardEvents.push({ uid, cards: newCards.slice(), source: 'PLAY', observedAt: now, evidenceKey: `DE:${this._roundSeq}:${uid}:${newCards.join(',')}` });
    }
  }

  _onMeld(cls, now) {
    this._ensureRound(now);
    const uid = cls.uid != null ? String(cls.uid) : null;
    const mes = Array.isArray(cls.mes) ? cls.mes : [];
    for (const m of mes) {
      const meid = m && m.meid != null ? m.meid : null;
      const cards = normalizeCards(m && m.cs);
      if (!cards.length) continue;
      const key = `ML:${this._roundSeq}:${uid}:${meid}:${cards.join(',')}`;
      if (this._seenEvents.has(key)) { this._log('DEDUP', { kind: 'meld' }); continue; }
      this._seenEvents.add(key);
      if (uid != null) { const p = this._player(uid); p.melds.push({ meid, cards: cards.slice(), source: 'MELD', observedAt: now, evidenceKey: key }); }
      // Melded cards are PUBLIC + out of the unknown pool; they stay in the owner's own hand (server keeps
      // them in sAC — §9), so we mark the ledger but never strip them from currentCards.
      for (const code of cards) this._setLedger(code, STATUS.MELDED, uid, 'MELD', now, key);
      this._log('MELD_OBSERVED', {});
    }
  }

  _onRoundEnd(cls, slot, ownUid, now) {
    // Round closes; KEEP the observation (snapshot still shows the ended round). The next DEAL resets.
    this._roundActive = false;
    if (Array.isArray(cls.sAC)) {
      const uid = ownUid != null ? String(ownUid) : (slot && this._slotBinding[slot]) || (cls.uid != null ? String(cls.uid) : null);
      if (uid != null) this._setCurrentCards(uid, normalizeCards(cls.sAC), 'ROUND_END', now);
    }
  }

  // Authoritative full-hand replace for one uid (own session). Idempotent (dedup-safe) — re-applying the
  // same hand does not duplicate anything (§6).
  _setCurrentCards(uid, cards, source, now) {
    const p = this._player(uid);
    p.currentCards = cards.slice();
    p.currentCardsSource = source;
    p.currentCardsAt = now;
    for (const code of cards) this._setLedger(code, STATUS.CURRENT, uid, source, now, `CC:${this._roundSeq}:${uid}:${code}`);
    this._log('CARD_OBSERVED', { source, count: cards.length });
  }

  // One status per card identity; TERMINAL (public discard/meld) never downgrades to CURRENT (§13).
  _setLedger(code, status, ownerUid, source, now, evidenceKey) {
    const prev = this._ledger.get(code);
    if (prev && TERMINAL.has(prev.status) && !TERMINAL.has(status)) return;
    this._ledger.set(code, { code, status, ownerUid: ownerUid != null ? String(ownerUid) : null, source, observedAt: now, evidenceKey });
  }

  _removeFromHands(code) {
    for (const p of this._players.values()) {
      const i = p.currentCards.indexOf(code);
      if (i >= 0) p.currentCards.splice(i, 1);
    }
  }

  // ---- queries (§15) ----
  getPlayer(uid) { const p = this._players.get(String(uid)); return p ? clone(p) : null; }
  getPlayers() { return [...this._players.values()].map(clone); }
  getDiscardHistory(uid) { const p = this._players.get(String(uid)); return p ? clone(p.discardedHistory) : []; }
  getAllObservedDiscards() { return clone(this._observedDiscardEvents); }
  getLedger() { return [...this._ledger.values()].map(clone); }

  // §12 — remaining = canonical 52 − every card PROVEN out (any ledger entry). A card in an unknown
  // player's hand is NOT proven out, so it stays in "remaining" (indistinguishable from an in-deck card);
  // it is never force-counted as used. No double count (ledger is keyed by code).
  getRemainingCards() {
    const codes = [];
    for (let c = MIN_CODE; c <= MAX_CODE; c++) if (!this._ledger.has(c)) codes.push(c);
    return { count: codes.length, codes, cards: codes.map(decodeView), knownOutCount: this._ledger.size };
  }

  // §19 — the analysis ANGLE (one player). Never merges P1+P2+P3 into one hand (§20).
  setAnalysisPlayer(uid) { this._analysisPlayer = uid != null ? String(uid) : null; return this._analysisPlayer; }
  getAnalysisPlayer() { return this._analysisPlayer; }

  // Deep-cloned, immutable snapshot (§15). Includes decoded views so the renderer needs no codec.
  getSnapshot() {
    const players = {};
    for (const p of this._players.values()) {
      players[p.uid] = {
        uid: p.uid, seat: p.seat, name: p.name, controlled: p.controlled, slot: p.slot,
        currentCards: p.currentCards.slice(), currentCardsView: p.currentCards.map(decodeView),
        currentCardsCount: p.currentCards.length, currentCardsSource: p.currentCardsSource,
        drawnHistory: clone(p.drawnHistory), drawnHistoryView: p.drawnHistory.map((e) => ({ ...e, view: decodeView(e.card) })),
        discardedHistory: clone(p.discardedHistory), discardedHistoryView: p.discardedHistory.map((e) => ({ ...e, view: decodeView(e.card) })),
        melds: p.melds.map((m) => ({ meid: m.meid, cards: m.cards.slice(), cardsView: m.cards.map(decodeView), source: m.source, observedAt: m.observedAt, evidenceKey: m.evidenceKey })),
      };
    }
    const snap = {
      runId: this._runId,
      roundId: null,               // UNSUPPORTED_BY_CURRENT_PROTOCOL (no server round id)
      roundSeq: this._roundSeq,    // internal observation counter
      roundActive: this._roundActive,
      startedAt: this._startedAt,
      currentTurnUid: this._currentTurnUid,
      slotBinding: { ...this._slotBinding },
      players,
      discardPile: this._discardPile.slice(),
      discardPileView: this._discardPile.map(decodeView),
      observedDiscardEvents: clone(this._observedDiscardEvents),
      ledger: this.getLedger(),
      remaining: this.getRemainingCards(),
      selectedAnalysisPlayer: this._analysisPlayer,
      capabilities: { ...CAPABILITIES },
    };
    this._log('SNAPSHOT', { players: this._players.size, remaining: snap.remaining.count });
    return deepFreeze(snap);
  }

  _log(event, data) { if (!this._logEnabled) return; this._logFn(event, data); }
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { for (const k of Object.keys(o)) deepFreeze(o[k]); Object.freeze(o); }
  return o;
}

function createCardObserver(deps = {}) { return new CardObserver(deps); }

module.exports = { createCardObserver, CardObserver, STATUS, CAPABILITIES, normalizeCard, normalizeCards };
