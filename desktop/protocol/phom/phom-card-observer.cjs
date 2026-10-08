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
//   EAT   853  cs, fP:{uid,puid}      → PUBLIC: fP.uid ATE the discard cs of fP.puid (own eater: + sAC/sMs)
//   MELD  854  uid, mes:[{meid,cs[]}] → PUBLIC meld laid down
//   END   855  ps[]                   → round end (the next DEAL opens a new round)
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
// EATEN: a discard the next player took (853) — public, and committed to the eater's phỏm.
const STATUS = Object.freeze({ CURRENT: 'CURRENT', DRAWN: 'DRAWN', DISCARDED: 'DISCARDED', MELDED: 'MELDED', EATEN: 'EATEN', UNKNOWN: 'UNKNOWN' });
const TERMINAL = Object.freeze(new Set([STATUS.DISCARDED, STATUS.MELDED, STATUS.EATEN]));

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
    this._eats = [];            // [{ card, eaterUid, fromUid, observedAt }] — discards taken this round (853)
    this._dealtUids = new Map(); // own hand → the cards dealt to it in THIS round (another set = a new round)
    // §40 — seat ORDER learned from PUBLIC play: every PLAY names who discarded (fP.uid) and whose turn it is
    // next (tP.uid). Only that next player may eat the discard, so this is what a player at the table knows
    // anyway. Seeded at every DEAL from lpi[] (the turn order), then confirmed/overridden by each PLAY; never assumed
    // from `sit`. Without an lpi it is kept across rounds while the seated set is unchanged.
    this._nextOf = new Map();     // uid -> uid of the player who plays right after them
    this._seatedKey = null;       // fingerprint of the seated uid set the order was learned for
  }

  // ---- identity / players ----
  _player(uid) {
    const id = String(uid);
    let p = this._players.get(id);
    if (!p) {
      p = { uid: id, seat: null, name: null, controlled: false, slot: null,
        currentCards: [], currentCardsSource: null, currentCardsAt: null,
        drawnHistory: [], discardedHistory: [], melds: [], serverMeldCards: [] };
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

  // ĐỔI NGƯỜI CHƠI — the slot's browser was replaced: the old account is no longer one of ours (its cards are not
  // known any more), and LỌC BÀI of the slot waits for the new account's own uid (bindSlot).
  unbindSlot(slot) {
    const s = String(slot);
    if (!(s in this._slotBinding)) return;
    const u = this._slotBinding[s];
    if (u != null) { const p = this._players.get(u); if (p && p.slot === s) { p.controlled = false; p.slot = null; } }
    this._slotBinding[s] = null;
    delete this._pendingOwnHand[s];
    this._log('PLAYER_UNBIND', { slot: s });
  }
  bindSlot(slot, uid, now) { this._bindSlot(slot, uid, now != null ? now : this._now()); }

  // ---- round lifecycle (§10) ----
  // A new round is delimited by the protocol's ROUND_END → DEAL cycle (never a timeout).
  resetRound(meta = {}) {
    this._roundSeq += 1;
    this._roundActive = true;
    this._startedAt = meta.now != null ? meta.now : this._now();
    this._currentTurnUid = null;
    this._roundPlayers = [];
    // Clear per-round CARD data; KEEP identity (uid/seat/name/controlled/slot) and slot binding.
    for (const p of this._players.values()) {
      p.currentCards = []; p.currentCardsSource = null; p.currentCardsAt = null;
      p.drawnHistory = []; p.discardedHistory = []; p.melds = []; p.serverMeldCards = [];
    }
    this._discardPile = [];
    this._observedDiscardEvents = [];
    this._ledger.clear();
    this._seenEvents.clear();
    this._eats = [];
    this._dealtUids = new Map();
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
      case 'EAT': this._onEat(cls, input.slot, input.ownUid, now); break;
      case 'MELD': this._onMeld(cls, now); break;
      case 'ROUND_END': this._onRoundEnd(cls, input.slot, input.ownUid, now); break;
      default: break; // non-card frames never mutate observation
    }
  }

  // TABLE_STATE ps[] binds seat + name + membership for EVERY seat (own + others). No card data here.
  // ONE table per round (code review 2026-10-06, "lọc bài thi thoảng lỗi"): every card frame of P1–P3 reaches here, also
  // from a browser sitting at ANOTHER table (live: coseat (3) 19:31:51 the game seated B1 at a stranger's running table;
  // Dò Key / Tạo pass through running tables). While a round runs, an actor who is not one of its players (DEAL lpi[])
  // is another table's — never counted (its discards would make our cards look "Nên đánh", its DEAL would replace the
  // turn order, its 855 would end our round).
  _foreign(uid) {
    return !!(this._roundActive && this._roundPlayers && this._roundPlayers.length && uid != null && !this._roundPlayers.includes(String(uid)));
  }
  _skipForeign(kind, uid) {
    if (!this._foreign(uid)) return false;
    this._foreignSkipped = (this._foreignSkipped || 0) + 1;
    this._log('FOREIGN_TABLE_SKIPPED', { kind });
    return true;
  }

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
    // another table's seats (none of this round's players): names only, never our turn order
    if (this._roundActive && this._roundPlayers && this._roundPlayers.length && !ps.some((x) => x && x.uid != null && this._roundPlayers.includes(String(x.uid)))) return;
    const key = ps.map((x) => (x && x.uid != null ? String(x.uid) : '')).filter(Boolean).sort().join('|');
    // someone joined/left: re-learn — but a round being played keeps the order its DEAL gave (a spectator coming in
    // does not change who plays after whom)
    if (key && key !== this._seatedKey) { this._seatedKey = key; this._nextOf.clear(); if (this._roundActive) this._seedOrderFromDeal(); }
  }

  _seedOrderFromDeal() {
    const a = this._roundPlayers || [];
    if (a.length < 2) return;
    this._nextOf.clear();
    a.forEach((u, i) => this._nextOf.set(u, a[(i + 1) % a.length]));
  }

  _onDeal(cls, slot, ownUid, now) {
    // ROUND_END → DEAL delimiter: the first DEAL after a round closed opens a new round. Extra DEALs
    // WITHIN an active round (the other two controlled browsers' own deals) must NOT reset it (§10/§6).
    // Belt and braces when the round end was missed (a reload, a dropped frame): a second DEAL to the SAME own hand,
    // or a dealt card the ledger already has as played, can only be a new round — never merge it into the old one
    // (live 2026-10-05: old discards made new-round cards look "Nên đánh" and a stranger ate one).
    const cards = normalizeCards(cls.cs);
    const uid = ownUid != null ? String(ownUid) : (slot && this._slotBinding[slot]) || null;
    const handKey = uid != null ? uid : (slot ? 'slot:' + slot : null);
    // a browser that is not in our running round dealt at another table: none of that deal's players are ours
    const lpiNow = cls.json && Array.isArray(cls.json) && cls.json[1] && Array.isArray(cls.json[1].lpi) ? cls.json[1].lpi.map(String) : [];
    if (this._foreign(uid) && !lpiNow.some((u) => this._roundPlayers.includes(u))) { this._skipForeign('DEAL', uid); return; }
    // the SAME deal delivered again (a capture attached twice: the cluster re-connects every browser when a reserve is
    // reopened, a stale hook is re-installed) is that deal, not a new round — it used to wipe the round (2026-10-06)
    const dealSig = cards.slice().sort((a, b) => a - b).join(',');
    if (this._roundActive && handKey != null && cards.length && this._dealtUids.get(handKey) === dealSig) { this._log('DEDUP', { kind: 'deal' }); return; }
    const stale = this._roundActive && ((handKey != null && cards.length && this._dealtUids.has(handKey))
      || cards.some((c) => { const e = this._ledger.get(c); return !!(e && TERMINAL.has(e.status)); }));
    if (!this._roundActive || stale) this.resetRound({ now, reason: stale ? 'DEAL_AGAIN_NEW_ROUND' : 'DEAL_NEW_ROUND' });
    else this._ensureRound(now);
    if (cls.tP && cls.tP.uid != null) this._currentTurnUid = String(cls.tP.uid);
    // DEAL lpi[] = the players dealt into THIS round, IN TURN ORDER (live capture 2026-09-21: a kicked/spectating seat
    // is absent; play.log/play2.log: every one of 28 plays went to the next uid of lpi). So the next player of everyone
    // is known from the deal — the order learned in an earlier round (other seats) is never reused.
    const lpi = cls.json && Array.isArray(cls.json) && cls.json[1] && Array.isArray(cls.json[1].lpi) ? cls.json[1].lpi : null;
    if (lpi && lpi.length) { this._roundPlayers = lpi.map(String); this._seedOrderFromDeal(); }
    if (!cards.length) return;
    if (handKey != null) this._dealtUids.set(handKey, dealSig);
    if (uid != null) { this._setCurrentCards(uid, cards, 'DEAL', now); }
    else if (slot) { this._pendingOwnHand[slot] = { cards, source: 'DEAL' }; } // flush on bind
  }

  _onDraw(cls, slot, ownUid, now) {
    this._ensureRound(now);
    if (Array.isArray(cls.sAC)) {
      // OWN authoritative full hand.
      const uid = ownUid != null ? String(ownUid) : (slot && this._slotBinding[slot]) || (cls.uid != null ? String(cls.uid) : null);
      if (this._skipForeign('DRAW', uid)) return;
      if (uid != null) {
        this._setCurrentCards(uid, normalizeCards(cls.sAC), 'DRAW', now);
        if (Array.isArray(cls.sMs)) this._player(uid).serverMeldCards = normalizeCards(cls.sMs); // own phỏm (§41)
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
    if (this._skipForeign('PLAY', uid)) return;
    const cards = normalizeCards(fp.dCs);
    if (cls.tP && cls.tP.uid != null) {
      this._currentTurnUid = String(cls.tP.uid);
      if (String(cls.tP.uid) !== uid) this._nextOf.set(uid, String(cls.tP.uid)); // §40 — public turn order
    }
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

  // 853 — the next player ATE the discard: it leaves the pile and is committed to the eater's phỏm; the eater plays
  // next. The eater's own session also carries its new full hand (sAC) and the server's phỏm (sMs).
  _onEat(cls, slot, ownUid, now) {
    this._ensureRound(now);
    const fp = cls.fP || {};
    const code = normalizeCard(cls.cs);
    const eater = fp.uid != null ? String(fp.uid) : null;
    const from = fp.puid != null ? String(fp.puid) : null;
    if (this._skipForeign('EAT', eater)) return;
    if (eater != null) this._currentTurnUid = eater;
    if (eater != null && Array.isArray(cls.sAC) && ownUid != null && String(ownUid) === eater) {
      this._setCurrentCards(eater, normalizeCards(cls.sAC), 'EAT', now);
      if (Array.isArray(cls.sMs)) this._player(eater).serverMeldCards = normalizeCards(cls.sMs);
    }
    if (code == null) return;
    const key = `EA:${this._roundSeq}:${code}`;
    if (this._seenEvents.has(key)) { this._log('DEDUP', { kind: 'eat' }); return; }
    this._seenEvents.add(key);
    const i = this._discardPile.lastIndexOf(code);
    if (i >= 0) this._discardPile.splice(i, 1);
    this._setLedger(code, STATUS.EATEN, eater, 'EAT', now, key);
    this._eats.push({ card: code, eaterUid: eater, fromUid: from, observedAt: now });
    this._log('EAT_OBSERVED', {});
  }

  _onMeld(cls, now) {
    this._ensureRound(now);
    const uid = cls.uid != null ? String(cls.uid) : null;
    if (this._skipForeign('MELD', uid)) return;
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
    // 855 — the round closes; KEEP the observation (snapshot still shows the ended round). The next DEAL resets.
    // Another table's round end (none of its players are in ours) does not end ours.
    const endUids = Array.isArray(cls.ps) ? cls.ps.filter((x) => x && x.uid != null).map((x) => String(x.uid)) : [];
    if (endUids.length && endUids.every((u) => this._foreign(u))) { this._skipForeign('ROUND_END', endUids[0]); return; }
    this._roundActive = false;
    if (Array.isArray(cls.sAC)) {
      const uid = ownUid != null ? String(ownUid) : (slot && this._slotBinding[slot]) || (cls.uid != null ? String(cls.uid) : null);
      if (uid != null) { this._setCurrentCards(uid, normalizeCards(cls.sAC), 'ROUND_END', now); if (Array.isArray(cls.sMs)) this._player(uid).serverMeldCards = normalizeCards(cls.sMs); }
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

  // ---- queries (§15) — everything a reader needs is in getSnapshot() ----
  getLedger() { return [...this._ledger.values()].map(clone); }

  // §12 — remaining = canonical 52 − every card PROVEN out (any ledger entry). A card in an unknown
  // player's hand is NOT proven out, so it stays in "remaining" (indistinguishable from an in-deck card);
  // it is never force-counted as used. No double count (ledger is keyed by code).
  getRemainingCards() {
    const codes = [];
    for (let c = MIN_CODE; c <= MAX_CODE; c++) if (!this._ledger.has(c)) codes.push(c);
    return { count: codes.length, codes, cards: codes.map(decodeView), knownOutCount: this._ledger.size };
  }

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
        serverMeldCards: p.serverMeldCards.slice(), // §41 — this player's OWN phỏm as the server arranged it (own session only)
      };
    }
    const snap = {
      runId: this._runId,
      roundId: null,               // UNSUPPORTED_BY_CURRENT_PROTOCOL (no server round id)
      roundSeq: this._roundSeq,    // internal observation counter
      roundActive: this._roundActive,
      startedAt: this._startedAt,
      currentTurnUid: this._currentTurnUid,
      nextOf: Object.fromEntries(this._nextOf), // §40 — learned public turn order (uid -> next uid)
      roundPlayers: (this._roundPlayers || []).slice(), // DEAL lpi[] — who is actually playing this round
      slotBinding: { ...this._slotBinding },
      players,
      discardPile: this._discardPile.slice(),
      discardPileView: this._discardPile.map(decodeView),
      observedDiscardEvents: clone(this._observedDiscardEvents),
      eats: this._eats.map((e) => ({ ...e, view: decodeView(e.card) })), // 853 — who ate which discard of whom
      ledger: this.getLedger(),
      remaining: this.getRemainingCards(),
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
