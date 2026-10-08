'use strict';

const EventEmitter = require('node:events');
const { PhomContext } = require('./phom-context.cjs');
const { reduceHand, emptyHand } = require('./hand-reducer.cjs');
const { ZONE, GID } = require('./phom-frame-classify.cjs');
const { buildAutoReadyPrefFrame, buildChannelListFrame } = require('./phom-wire.cjs');
const { remainingCardsView } = require('./remaining-cards.cjs');
const { createCardObserver } = require('./phom-card-observer.cjs');
const { redactDiagnostic } = require('./diagnostic-redaction.cjs');
const { errMsg, accountIdOf, frameText, shortUid } = require('./coordinator-util.cjs');
const { mixin } = require('./mixin.cjs');
// the coordinator's other two parts (same class, split by concern — 3.2)
const { CoordinatorTableActions, LEAVE_CONFIRM_MS, JOIN_REJECT_GRACE_MS } = require('./coordinator-table-actions.cjs');
const { CoordinatorSearch, REROLL_COOLDOWN_MS, PROBE_ACK_MS, SEARCH_BUDGET_MS, LOTTERY_PER_MIN } = require('./coordinator-search.cjs');

// ---------------------------------------------------------------------------
// Table coordinator — the per-browser Phỏm PRIMITIVES for the three controlled browsers, nothing more:
//
//   observe   every game frame of each browser (PhomContext + hand reducer + card observer)
//   DÒ KEY    findKeyTable    — sit ALONE at an empty public table of the stake (the group's KEY)
//   TẠO       scanForKeyTable — find the KEY's table among the tables 313 names, and sit there
//   VÀO       joinTable       — sit at one exact số bàn (op 8)
//   RỜI       leaveTable · SẴN SÀNG sendTableReady · TỰ SẴN SÀNG setAutoReadyPref
//
// The protocol is the reference tool's, read from its live traffic (docs/phom-kich-ban.md). WHICH browser does what,
// and when, is decided by table-group.cjs; this module never sequences more than one browser.
//
// ONE class in three files (3.2): this one = the browsers, observation and the facts table-group reads;
// coordinator-table-actions.cjs = VÀO / RỜI / SẴN SÀNG; coordinator-search.cjs = DÒ KEY / TẠO.
//
// Pure of Electron/CDP: `send(frame, ctx)` is the per-browser seam (main → wsReplay.sendProtocol on that run's own
// socket), so everything here is unit-testable.
// ---------------------------------------------------------------------------

// The game socket is shared with the site's other games, and they broadcast constantly (capture 2026-10-02, one
// browser, 183s: 2009× cmd 10004 + 519× 10003 for mini-games gid 10112/10110/10888, 149× 1015, 61× 10000 jackpots,
// 7× 10 "nổ hũ" ticker — about 15 frames/s). A push that names another game's gid, or is one of those broadcast
// commands, is dropped right after the context has seen it: no update, no log, no IPC.
// What a RESERVE browser's own frames still decide: its own host, join and kick (its bar works like the others).
const RESERVE_TYPES = new Set(['HOST_CHANGED', 'TABLE_STATE', 'JOIN_ACCEPTED', 'LEAVE_ACK']);
const FOREIGN_PUSH_CMDS = new Set([10, 1015, 10000, 10003, 10004]);
function isForeignPush(cls, meta) {
  if (!cls || cls.known || cls.op !== 5 || meta.direction === 'send') return false;
  if (cls.gid != null && Number(cls.gid) !== GID) return true;
  return cls.cmd != null && FOREIGN_PUSH_CMDS.has(Number(cls.cmd));
}

class HostTableCoordinator extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._now = deps.now || (() => Date.now());
    this._sessionId = deps.sessionId || `PHOMHOST-${this._now()}`;
    // Authorization may be a boolean or a live getter (a licensed app grants it the moment its license is active).
    this._authorizedFn = typeof deps.environmentAuthorized === 'function' ? deps.environmentAuthorized : () => deps.environmentAuthorized !== false;
    this._leaveConfirmMs = deps.leaveConfirmMs != null ? Number(deps.leaveConfirmMs) : LEAVE_CONFIRM_MS;
    this._rerollCooldownMs = deps.rerollCooldownMs != null ? Number(deps.rerollCooldownMs) : REROLL_COOLDOWN_MS;
    this._joinRejectGraceMs = deps.joinRejectGraceMs != null ? Number(deps.joinRejectGraceMs) : JOIN_REJECT_GRACE_MS;
    this._probeAckMs = deps.probeAckMs != null ? Number(deps.probeAckMs) : PROBE_ACK_MS;
    this._lotteryPerMin = deps.lotteryPerMin != null ? Number(deps.lotteryPerMin) : LOTTERY_PER_MIN;
    this._lottery = { owner: null, asks: [] };
    this._findBudgetMs = deps.findBudgetMs != null ? Number(deps.findBudgetMs) : SEARCH_BUDGET_MS;
    this._stopped = false;
    this._roundRunning = false;
    this._readyUids = new Set(); // who signalled READY since the last deal / round end
    // One table-level CARD OBSERVER, fed from the same classified frames (no second listener). It never sends.
    this._cardObserver = createCardObserver({ runId: this._sessionId, now: this._now });
    this._profiles = new Map();
    for (const p of (Array.isArray(deps.profiles) ? deps.profiles : [])) this._addProfile(p);
  }

  _addProfile(p) {
    if (!p || p.id == null) return;
    const id = String(p.id);
    this._profiles.set(id, {
      id, displayName: p.displayName != null ? String(p.displayName) : id,
      send: typeof p.send === 'function' ? p.send : async () => ({ ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no send seam' } }),
      armProbe: typeof p.armProbe === 'function' ? p.armProbe : null, // TẠO: the game's own join → refused probe (phom-probe-guard)
      ctx: new PhomContext({ profileId: id, uid: p.uid }), hand: emptyHand(id, p.uid),
      manualState: null, lastError: null,
      _joinedRid: null, _lastRid: null, _joinedViaChannel: false, _hostUid: null,
      _manualGen: 0, _searchGen: 0, _searchKind: null, _searchStartedAt: null, _searchAttempt: 0,
    });
  }

  // THAY PROFILE / mở lại — a NEW browser run takes the place of a closed one at the SAME position (P1/P2/P3 order),
  // starting from nothing. The other browsers' state is untouched.
  replaceProfile(oldId, p) {
    const old = String(oldId);
    if (!this._profiles.has(old) || !p || p.id == null || this._profiles.has(String(p.id))) return false;
    const entries = [...this._profiles.entries()];
    // LỌC BÀI follows the slot: the old account stops being "ours" at once; the new one binds by its own uid
    this._cardObserver.unbindSlot('B' + (entries.findIndex(([id]) => id === old) + 1));
    this._profiles = new Map();
    for (const [id, rec] of entries) {
      if (id !== old) { this._profiles.set(id, rec); continue; }
      rec._manualGen += 1; rec._searchGen += 1; // cancels any wait the closed browser still had in flight
      this._addProfile(p);
    }
    this._changed();
    this.emit('hands', this.handsSnapshot());
    return true;
  }

  // N4 — a RESERVE browser joins (reopened P4/P5) or leaves (closed) the session. A playing browser (P1–P3) is
  // never removed this way: its slot is replaced (replaceProfile / swapProfiles).
  addProfile(p) {
    if (!p || p.id == null || this._profiles.has(String(p.id))) return false;
    this._addProfile(p); this._changed();
    return true;
  }
  removeProfile(id) {
    const k = String(id);
    if (!this._profiles.has(k) || this.profileIds().indexOf(k) < 3) return false;
    const rec = this._profiles.get(k);
    rec._manualGen += 1; rec._searchGen += 1; // ends anything it still had in flight
    this._profiles.delete(k);
    this._changed();
    return true;
  }

  // The PLAYING browsers: the first three in order (P1/P2/P3). A 4th/5th one is a RESERVE (P4/P5): a full browser of the
  // session (its bar works like the others) that TỰ ĐỘNG never seats and LỌC BÀI does not cover.
  playingIds() { return this.profileIds().slice(0, 3); }
  // ĐỔI — two browsers of the session swap places (a reserve takes a playing slot, the playing one becomes the
  // reserve). Their own state is untouched; LỌC BÀI follows the slots at once.
  swapProfiles(aId, bId) {
    const a = String(aId), b = String(bId);
    if (a === b || !this._profiles.has(a) || !this._profiles.has(b)) return false;
    const entries = [...this._profiles.entries()];
    const ia = entries.findIndex(([id]) => id === a), ib = entries.findIndex(([id]) => id === b);
    for (const i of [ia, ib]) if (i < 3) this._cardObserver.unbindSlot('B' + (i + 1));
    [entries[ia], entries[ib]] = [entries[ib], entries[ia]];
    this._profiles = new Map(entries);
    this.rebindCardSlot(a); this.rebindCardSlot(b);
    this._changed();
    this.emit('hands', this.handsSnapshot());
    return true;
  }

  // Bind a browser's slot (B1/B2/B3) in the card observer to its account as soon as the uid is known (a swapped-in
  // browser is usually logged in already), so LỌC BÀI of that slot uses the new account without waiting for a deal.
  rebindCardSlot(profileId) {
    const rec = this._rec(profileId);
    const uid = rec && rec.ctx.uid();
    if (!uid) return false;
    const idx = this.profileIds().indexOf(rec.id);
    if (idx > 2) return false; // a reserve has no LỌC BÀI slot
    this._cardObserver.bindSlot('B' + (idx + 1), uid, this._now());
    this.emit('cards', this.cardObserverSnapshot());
    return true;
  }

  sessionId() { return this._sessionId; }

  // ---- observation -------------------------------------------------------------------------------------------
  ingest(profileId, meta = {}) {
    const rec = this._rec(profileId);
    if (!rec) return null;
    const now = meta.now != null ? meta.now : this._now();
    const wasHost = this.isTableHost(rec.id); // before a kick clears the table (KICKED diagnostics)
    const cls = rec.ctx.observe({ ...meta, now });
    if (isForeignPush(cls, meta)) return cls;
    const seq = Number.isFinite(meta.seq) ? meta.seq : null;
    if (cls.isHandEvent) rec.hand = reduceHand(rec.hand, cls, { profileId: rec.id, profileUid: rec.ctx.uid(), seq, now });
    // A RESERVE (P4/P5) may sit at another table: its frames never feed the group-table facts (cards, round, readiness)
    const idx = this.profileIds().indexOf(rec.id);
    const playing = idx < 3;
    if (playing && (cls.isHandEvent || cls.type === 'TABLE_STATE')) {
      this._cardObserver.ingestFrame({ slot: 'B' + (idx + 1), browserIndex: idx + 1, ownUid: rec.ctx.uid(), cls, seq, now });
    }
    switch (playing ? cls.type : RESERVE_TYPES.has(cls.type) ? cls.type : null) {
      case 'DEAL': rec._inRound = true; this._roundRunning = true; this._readyUids.clear(); break;
      case 'ROUND_END': {
        const wasRunning = this._roundRunning;
        rec._inRound = false; this._roundRunning = false; this._readyUids.clear();
        if (wasRunning) this.emit('roundEnd', {}); // once, though all three browsers receive it
        break;
      }
      case 'USER_READY': this._readyUids.add(cls.uid); this._logReady(rec, cls.uid); this._maybeStrangerReady(rec, cls.uid); break;
      case 'SEAT_UPDATE':
        // a player who LEFT the table (t:2 — kicked, moved, quit) is not ready any more: a stale "ready" kept the
        // account that sat down again from being readied, and the KEY waited for a start that never came (live
        // coseat (3) 2026-10-05: the stranger sat 62 s and left)
        if (cls.t === 2 && cls.seat && cls.seat.uid != null) this._unready(cls.seat.uid);
        if (cls.present && cls.seat && cls.seat.r === true) this._maybeStrangerReady(rec, String(cls.seat.uid));
        if (meta.direction !== 'send' && !meta.replay) this._logSeats('SEAT_DIAG', rec, cls, [cls.json && cls.json[1] && cls.json[1].p]);
        break;
      case 'HOST_CHANGED':
        rec._hostUid = cls.uid;
        // the table's owner changed (the KEY left / was kicked) — table-group decides (user rule B4: re-form the group)
        if (playing && meta.direction !== 'send' && !meta.replay) { this._log('HOST_CHANGED', rec, { uid: String(cls.uid) }); this.emit('hostChanged', { id: rec.id, uid: String(cls.uid) }); }
        break;
      case 'TABLE_STATE': {
        const ts = rec.ctx.tableState();
        const h = ts && ts.seats.find((s) => s.host);
        rec._hostUid = h ? h.uid : null;
        // the round state of THIS browser's table (gS 4 = a round is being played; 1 = waiting) — a TẠO that sat at
        // a stranger's running table must not leave the whole group "in a round" (live 2026-10-05: stale for minutes)
        { const gS = cls.json && cls.json[1] && cls.json[1].gS; if (gS != null) rec._inRound = Number(gS) === 4; }
        if (playing && ts) for (const s of ts.seats) if (s.ready && s.uid) this._readyUids.add(s.uid);
        if (meta.direction !== 'send' && !meta.replay) this._logSeats('TABLE_DIAG', rec, cls, cls.json && cls.json[1] && cls.json[1].ps);
        break;
      }
      case 'JOIN_ACCEPTED':
        // a refusal keeps the server's own frame (no secrets in it: [3,false,code,rid,text]) — 166 "Phòng đầy" at a
        // 2-player table (live 2026-10-03) cannot be explained from the code alone
        if (meta.direction !== 'send') this._log('JOIN_ACK', rec, { accepted: cls.accepted === true, code: cls.resultCode, reason: cls.resultMessage || null, ...(cls.accepted === true ? {} : { serverFrame: frameText(meta.raw), money: this._money(rec) }) });
        if (cls.accepted === true && meta.direction !== 'send' && rec.ctx.uid() != null) this._unready(rec.ctx.uid()); // a fresh seat is not ready
        // Auto-ready OFF right after EVERY accepted join, as the reference tool does (capture 2026-10-02: 363 aRd
        // "false" 4–7 ms after each [3,true,0,-1,null] — Dò Key, Vào, every ReJoin). Sent before the join it did not
        // hold: the game's own auto-ready readied the 2nd account and the server kicked the KEY 15 s later, "Bạn thoát
        // vì không bắt đầu" (live log 2026-10-03 11:14). Whoever made the join — the tool or the game itself.
        if (cls.accepted === true && meta.direction !== 'send' && !meta.replay && this._guard()) {
          Promise.resolve(rec.send(buildAutoReadyPrefFrame(false), rec.ctx.sendContext())).catch(() => {});
          this._log('AUTO_READY_OFF', rec, {});
        }
        break;
      case 'LEAVE_REQUEST':
        // every leave this page sends (the tool's own is also logged as LEAVE_SENT by:'tool' just before) — a leave seen
        // here without a LEAVE_SENT came from the game page itself (live coseat (3): members left the group's table
        // seconds after sitting, no kick, no tool leave logged — could not be explained)
        if (meta.direction === 'send' && !meta.replay) this._log('LEAVE_REQUEST_SEEN', rec, {});
        break;
      case 'LEAVE_ACK':
        // every removal is logged with the server's own code/message (only code 2 = kick was logged before)
        if (meta.direction !== 'send' && !meta.replay && !(cls.accepted === true && cls.resultCode === 2)) this._log('LEAVE_ACK', rec, { accepted: cls.accepted === true, code: cls.resultCode, reason: cls.resultMessage || null, serverFrame: frameText(meta.raw) });
        // The server removed this browser (code 2, e.g. "Bạn bị kick vì không sẵn sàng"). What to do about it is the
        // GROUP's decision (table-group.cjs) — here it is only recorded and announced.
        if (cls.accepted === true && cls.resultCode === 2 && meta.direction !== 'send') {
          rec._joinedRid = null; rec.manualState = 'KICKED';
          rec.lastError = { code: 'PHOM_KICKED', message: cls.resultMessage || 'Bị máy chủ đưa ra khỏi bàn' };
          this._log('KICKED', rec, { reason: cls.resultMessage || null, serverFrame: frameText(meta.raw), host: wasHost, roundRunning: !!rec._inRound });
          rec._inRound = false;
          if (rec.ctx.uid() != null) this._unready(rec.ctx.uid());
          this.emit('kicked', { id: rec.id, message: cls.resultMessage || null });
        }
        break;
      default: break;
    }
    // who sits / who is ready at the group's table changed → table-group checks the full-table auto start
    // Also on this browser's OWN leave / join answer: the others' t:2 / t:1 for it travel on other sockets and may be
    // read first, while this browser still counted as seated (or not yet) — the rule must look again (B1 e2e 2026-10-06)
    if (playing && meta.direction !== 'send' && !meta.replay && (cls.type === 'TABLE_STATE' || cls.type === 'SEAT_UPDATE' || cls.type === 'USER_READY' || cls.type === 'LEAVE_ACK' || cls.type === 'JOIN_ACCEPTED')) this.emit('seats', { id: rec.id });
    this._changed();
    this.emit('hands', this.handsSnapshot());
    if (cls.isHandEvent || cls.type === 'TABLE_STATE') this.emit('cards', this.cardObserverSnapshot());
    return cls;
  }

  markDisconnected(profileId) {
    const rec = this._rec(profileId);
    if (!rec) return;
    rec._manualGen += 1; // a dead socket cancels any wait in flight
    rec.ctx.onDisconnect();
    rec.hand = reduceHand(rec.hand, { type: 'CONTROL', control: 'DISCONNECT' }, { profileId: rec.id, profileUid: rec.ctx.uid(), now: this._now() });
    this._changed();
    this.emit('hands', this.handsSnapshot());
  }
  // A CDP websocket-closed for this run — a real disconnect only when it is this browser's bound game socket.
  markSocketClosed(profileId, meta = {}) {
    const rec = this._rec(profileId);
    if (!rec || !rec.ctx.socketMatches(meta)) return false;
    this.markDisconnected(profileId);
    return true;
  }
  setIdentity(profileId, identity) { const rec = this._rec(profileId); if (rec) rec.ctx.setIdentity(identity); this._changed(); }

  // The page reloaded: forget everything this browser's old document told us.
  resetBrowser(profileId) {
    const rec = this._rec(profileId);
    if (!rec) return false;
    rec._manualGen += 1; rec._searchGen += 1;
    try { rec.ctx.reset(); } catch { /* best effort */ }
    rec._joinedRid = null; rec._hostUid = null; rec._inRound = false; rec.lastError = null; rec.manualState = 'READY';
    rec._searchKind = null; rec._searchStartedAt = null;
    this._changed();
    this.emit('hands', this.handsSnapshot());
    return true;
  }

  // CMD 300 — ask for the stake channel list so the stake picker has the server's real stakes. Never sent for a
  // seated browser: the real client never lists channels while seated.
  async requestChannels({ profileId = null } = {}) {
    if (!this._guard()) return this._unauthorized();
    const out = [];
    for (const rec of this._profiles.values()) {
      if (profileId != null && rec.id !== String(profileId)) continue;
      if (this._ownSeated(rec) || rec.manualState === 'JOINED') { out.push({ id: rec.id, ok: false, skipped: true, reason: 'SEATED' }); continue; }
      const aid = rec.ctx.aid(); const ctx = rec.ctx.sendContext();
      if (aid == null) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_PROTOCOL_CONTEXT_MISSING', message: 'aid not learned yet' } }); continue; }
      if (!ctx) { out.push({ id: rec.id, ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'no game socket yet' } }); continue; }
      let res; try { res = await rec.send(buildChannelListFrame(aid), ctx); } catch (e) { res = { ok: false, error: { code: 'PHOM_CHANNEL_REQUEST_FAILED', message: errMsg(e) } }; }
      out.push({ id: rec.id, ...res });
    }
    return { ok: out.some((r) => r.ok), results: out };
  }
  // The distinct stakes in the server's channel lists (never a hard-coded list; empty until one arrived).
  availableStakes() {
    const seen = new Set();
    for (const rec of this._profiles.values()) for (const b of this._betOptionsFor(rec)) seen.add(b);
    return [...seen].sort((a, b) => a - b);
  }

  // DỪNG ở tool: every wait in flight becomes a no-op; browsers and seats are left as they are.
  stop() {
    this._stopped = true;
    for (const rec of this._profiles.values()) { rec._manualGen += 1; rec._searchGen += 1; }
    this._log('STOPPED', null);
    this.emit('update', this.snapshot());
  }

  // ---- facts for table-group.cjs ------------------------------------------------------------------------------
  // In the game = its own socket is bound and connected; only then can it be told to do anything.
  browserReady(profileId) { const r = this._rec(profileId); if (!r) return false; const c = r.ctx.get(); return !!(c.connected && c.socketReady); }
  profileIds() { return [...this._profiles.keys()]; }
  uidOf(profileId) { const r = this._rec(profileId); return r ? r.ctx.uid() : null; }
  isSeated(profileId) { const r = this._rec(profileId); return !!(r && this._ownSeated(r)); }
  seatedRid(profileId) { const r = this._rec(profileId); return r && this._ownSeated(r) && r._joinedRid != null ? Number(r._joinedRid) : null; }
  lastRidOf(profileId) { const r = this._rec(profileId); return r ? (r._joinedRid != null ? Number(r._joinedRid) : r._lastRid) : null; }
  isReady(profileId) { return this._isReady(this._rec(profileId)); }
  // The table host (chủ bàn) as seen from any seated browser.
  tableHostUid() { for (const r of this._profiles.values()) if (this._ownSeated(r) && r._hostUid) return r._hostUid; return null; }
  isTableHost(profileId) { const r = this._rec(profileId); return !!(r && this._ownSeated(r) && r._hostUid != null && r._hostUid === r.ctx.uid()); }
  // Is a round being played? With a browser: at THAT browser's table (the group asks for the KEY's). Without one: at
  // any playing browser's table. Per browser, so a stranger's table a TẠO passed through never sticks to the group.
  roundRunning(profileId) {
    if (profileId != null) { const r = this._rec(profileId); return !!(r && r._inRound && this._ownSeated(r)); }
    return [...this._profiles.values()].slice(0, 3).some((r) => r._inRound && this._ownSeated(r));
  }

  // ---- views ----------------------------------------------------------------------------------------------------
  // Are all browsers proven to sit at ONE table? Read from every browser's own ps[] — never from one browser's count.
  coSeatStatus() {
    const recs = [...this._profiles.values()].slice(0, 3); // the playing browsers only — a reserve is not expected there
    const seated = recs.filter((r) => this._ownSeated(r));
    const base = { rid: null, seatedCount: seated.length, browserCount: recs.length };
    if (!seated.length) return { ok: false, result: 'IDLE', reason: null, playerCount: null, ...base };
    const uids = seated.map((r) => r.ctx.uid());
    const apart = seated.find((r) => !uids.every((u) => r.ctx.tableState().uids.includes(u)));
    if (apart) return { ok: false, result: 'TABLE_MISMATCH', reason: `${apart.id} không thấy các acc kia trong bàn`, playerCount: null, ...base };
    const playerCount = seated[0].ctx.tableState().playerCount;
    if (seated.length < recs.length) return { ok: false, result: 'PARTIAL_JOIN', reason: `${seated.length}/${recs.length} acc trong bàn`, playerCount, ...base };
    return { ok: true, result: 'SAME_TABLE', reason: null, playerCount, ...base };
  }

  // The SỐ BÀN list one browser received (real tables only), for the header's ⋮ list.
  roomList(profileId) {
    const rec = this._rec(profileId) || [...this._profiles.values()].find((r) => r.ctx.roomListAt() != null);
    if (!rec) return { rooms: [], at: null, ageSec: null };
    const at = rec.ctx.roomListAt();
    const rooms = rec.ctx.roomList().map((c) => ({ rid: Number(c.rid), b: c.b, uC: c.uC, Mu: c.Mu, locked: !!c.hpwd }));
    return { rooms, at, ageSec: at != null ? Math.max(0, Math.round((this._now() - at) / 1000)) : null };
  }

  // Per-browser state for the in-page bar and the tool window (stable Player 1/2/3 order).
  manualBrowserSnapshot() {
    const controlled = new Set([...this._profiles.values()].map((r) => r.ctx.uid()).filter(Boolean));
    return [...this._profiles.values()].map((rec, i) => {
      const c = rec.ctx.get();
      const ts = rec.ctx.tableState();
      return {
        browserIndex: i + 1, profileId: rec.id, displayName: rec.displayName,
        username: this._username(rec) || 'USER_UNKNOWN',
        // The account's in-game ID: the number of its uid ("1_365473596" → "365473596"), shown beside its name.
        accountId: accountIdOf(c.uid), loggedIn: rec.ctx.loggedIn(),
        connected: c.connected, socketReady: c.socketReady, lastFrameAt: c.lastFrameAt,
        // > 0 = this browser received the Phỏm stake list, i.e. it is in the Phỏm lobby.
        channelCount: c.channels.length,
        rid: rec._joinedRid, lastRid: rec._lastRid,
        // the KEY's seat before its số bàn is known: the stake channel it came through (KÊNH, never SS)
        joinedViaChannel: !!rec._joinedViaChannel,
        ready: this._isReady(rec), isTableHost: this.isTableHost(rec.id),
        betOptions: this._betOptionsFor(rec),
        manualState: rec.manualState || (c.socketReady && c.connected ? 'READY' : 'CLOSED'),
        // DÒ KEY ('KEY') / TẠO ('SCAN') in progress: which one, how many asks so far, how long it has been running.
        searchKind: rec._searchKind,
        searchAttempt: rec._searchKind ? rec._searchAttempt : 0,
        searchElapsedSec: rec._searchKind && rec._searchStartedAt != null ? Math.max(0, Math.round((this._now() - rec._searchStartedAt) / 1000)) : 0,
        seat: c.seat, uid: shortUid(c.uid),
        // The account's money: its seat's `m` at a table, else the wallet the server pushed (cmd 100 / 317).
        money: this._money(rec),
        // Who sits at this browser's table, the reference tool's "name-money" list: host 👑, ready ✓, ours = one of the
        // three controlled accounts (so the user sees at once whether the accounts really sit together).
        players: ts ? ts.seats.slice().sort((a, b) => (a.sit ?? 9) - (b.sit ?? 9)).map((s) => ({
          name: s.dn || shortUid(s.uid), money: s.m != null ? Number(s.m) : null, host: s.host, ready: this._readyUids.has(s.uid) || s.ready,
          self: s.uid === c.uid, ours: controlled.has(s.uid),
        })) : [],
        membership: ts ? ts.uids.map(shortUid) : [], playerCount: ts ? ts.playerCount : 0,
        lastError: rec.lastError,
      };
    });
  }

  // Screen 2 — cards REMAINING after removing every card held by the three browsers (NOT player 4).
  remainingCards(opts = {}) {
    // the PLAYING browsers only — a reserve's hand belongs to another table
    const hands = [...this._profiles.values()].slice(0, 3).map((rec) => (rec.hand && Array.isArray(rec.hand.cardsRaw) ? rec.hand.cardsRaw : []));
    return remainingCardsView(hands, opts);
  }
  cardObserverSnapshot() { return this._cardObserver.getSnapshot(); }
  handsSnapshot() { return [...this._profiles.values()].map((rec) => publicHand(rec)); }
  snapshot() {
    const profiles = [...this._profiles.values()].map((rec) => {
      const c = rec.ctx.get();
      return {
        id: rec.id, displayName: rec.displayName, uid: shortUid(c.uid), aid: c.aid,
        socketReady: c.socketReady, connected: c.connected, seat: c.seat, ready: this._isReady(rec),
        playerCount: c.tableState ? c.tableState.playerCount : 0,
        // > 0 = in the Phỏm LOBBY, not merely logged in at the portal (where the socket may connect early)
        channelCount: c.channels.length,
        lastError: rec.lastError,
      };
    });
    return {
      sessionId: this._sessionId, state: this._stopped ? 'STOPPED' : (this._roundRunning ? 'ROUND_RUNNING' : 'IDLE'),
      authorized: this._authorizedFn(), stopped: this._stopped, roundRunning: this._roundRunning,
      readyCount: profiles.filter((p) => p.ready).length,
      onlineCount: profiles.filter((p) => p.socketReady && p.connected).length,
      profiles, hands: this.handsSnapshot(),
    };
  }

  // ---- internals ------------------------------------------------------------------------------------------------
  _rec(profileId) { return this._profiles.get(String(profileId)) || null; }
  _ownSeated(rec) { const ts = rec.ctx.tableState(); const uid = rec.ctx.uid(); return !!(ts && uid && ts.uids.includes(uid)); }
  _seatedWith(rec, uid) { const ts = rec.ctx.tableState(); return !!(ts && this._ownSeated(rec) && ts.uids.includes(String(uid))); }
  // The account name: its seat's dn at a table, else the name the server sent with the login identity (cmd 100).
  _username(rec) {
    const ts = rec.ctx.tableState(); const uid = rec.ctx.uid();
    const mine = ts && uid ? ts.seats.find((s) => s.uid === uid) : null;
    return mine && mine.dn ? mine.dn : rec.ctx.displayName();
  }
  _money(rec) {
    const ts = rec.ctx.tableState(); const uid = rec.ctx.uid();
    const mine = ts && uid ? ts.seats.find((s) => s.uid === uid) : null;
    return mine && mine.m != null ? Number(mine.m) : rec.ctx.money();
  }
  // A player who is NOT one of the three controlled accounts readied at a table this browser sits at (the 4th seat) —
  // table-group rings the tool's bell. Every browser at that table reports it; the group keeps it to once per round.
  _maybeStrangerReady(rec, uid) {
    if (uid == null || !this._ownSeated(rec)) return;
    for (const r of this._profiles.values()) if (r.ctx.uid() === uid) return;
    const seat = rec.ctx.tableState().seats.find((s) => s.uid === uid);
    this.emit('strangerReady', { id: rec.id, uid, name: seat && seat.dn ? seat.dn : null });
  }
  // Ready = this browser signalled READY since the last deal/end, or its own seat row says so.
  _isReady(rec) {
    if (!rec) return false;
    const uid = rec.ctx.uid();
    if (uid != null && this._readyUids.has(uid)) return true;
    const ts = rec.ctx.tableState();
    const s = ts && uid != null ? ts.seats.find((x) => x.uid === uid) : null;
    return !!(s && s.ready);
  }
  // The distinct stakes (rs[].b) in THIS browser's channel list — the server's real options, never a fallback list.
  _betOptionsFor(rec) {
    const seen = new Set();
    for (const c of rec.ctx.channels()) {
      if ((c.zn != null && c.zn !== ZONE) || (c.gid != null && c.gid !== GID)) continue;
      const b = Number(c.b); if (Number.isFinite(b) && b > 0) seen.add(b);
    }
    return [...seen].sort((a, b) => a - b);
  }
  // Event-driven wait: resolves true as soon as `pred()` holds (woken by every 'update'), false on timeout, on a newer
  // operation for this browser (generation), or on stop.
  _waitManual(pred, rec, myGen, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (done) return; done = true; this.off('update', check); clearTimeout(timer); resolve(v); };
      const holds = () => { try { return !!pred(); } catch { return false; } };
      const check = () => { if (this._stopped || rec._manualGen !== myGen) settle(false); else if (holds()) settle(true); };
      const timer = setTimeout(() => settle(holds() && !this._stopped && rec._manualGen === myGen), timeoutMs);
      check();
      if (!done) this.on('update', check);
    });
  }
  // A seat the game itself took away (the player left in the game UI, the round closed the table) — back to the lobby.
  _changed() {
    for (const rec of this._profiles.values()) {
      if (rec.manualState !== 'JOINED' || rec.ctx.tableState()) continue;
      rec.manualState = 'READY'; rec._joinedRid = null; rec._hostUid = null;
    }
    this.emit('update', this.snapshot());
  }
  _unready(uid) { this._readyUids.delete(uid); this._readyUids.delete(String(uid)); }
  // Every READY press seen at the table (ours or a stranger's) goes to coseat.jsonl once — the three browsers all
  // receive it, so a repeat within 3 s is the same press.
  _logReady(rec, uid) {
    if (uid == null) return;
    const u = String(uid); const now = this._now();
    this._readyLogAt = this._readyLogAt || new Map();
    if (now - (this._readyLogAt.get(u) || -Infinity) < 3000) return;
    this._readyLogAt.set(u, now);
    const ours = [...this._profiles.values()].find((r) => r.ctx.uid() != null && String(r.ctx.uid()) === u);
    const seat = rec.ctx.tableState() ? rec.ctx.tableState().seats.find((s) => String(s.uid) === u) : null;
    this._log('READY_SEEN', rec, { uid: u, name: seat && seat.dn ? seat.dn : null, ours: ours ? 'B' + (this.profileIds().indexOf(ours.id) + 1) : null, players: this.tablePlayerCount(rec.id) });
  }
  _log(event, rec, data = {}) {
    try {
      const slot = rec ? 'B' + (this.profileIds().indexOf(rec.id) + 1) : null;
      this.emit('log', redactDiagnostic({ tag: 'PHOM-COSEAT', event, at: this._now(), slot, runId: rec ? rec.id : null, ...data }));
    } catch { /* never throw from logging */ }
  }
  // What the server says about each seat, as THIS browser received it (diagnosis: the game drew our own accounts as
  // "Ẩn Danh Tính · $?????" to each other while the reference tool's accounts saw names + avatars — every field
  // name is kept so a flag the reference captures never show, e.g. mT, stands out).
  _logSeats(event, rec, cls, seats) {
    if (!Array.isArray(seats)) return;
    if (event === 'TABLE_DIAG') { // a table state repeats during play: log it only when who sits there changed
      const sig = seats.map((s) => s && s.uid + ':' + s.mT).join('|');
      if (rec._seatDiagSig === sig) return;
      rec._seatDiagSig = sig;
    }
    const body = cls.json && cls.json[1] && typeof cls.json[1] === 'object' ? cls.json[1] : null;
    const top = body ? Object.keys(body).filter((k) => k !== 'ps' && k !== 'p') : [];
    this._log(event, rec, {
      table: top.join(','), t: body ? body.t : undefined,
      // the values that decide who may sit: stake, max players (Mu), game state, lock — "Phòng đầy" diagnosis
      ...(event === 'TABLE_DIAG' && body ? { stake: body.b, maxPlayers: body.Mu, gameState: body.gS, locked: body.hpwd === true } : {}),
      seats: seats.filter((s) => s && typeof s === 'object').map((s) => ({
        uid: shortUid(s.uid), name: s.dn, avatar: s.a, mT: s.mT, pi: s.pi, host: s.C, ready: s.r, sit: s.sit, money: s.m,
        fields: Object.keys(s).sort().join(','),
      })),
    });
  }
  _guard() { return this._authorizedFn() && !this._stopped; }
  _unauthorized() {
    if (!this._authorizedFn()) return { ok: false, error: { code: 'PHOM_UNAUTHORIZED_ENVIRONMENT', message: 'AUTHORIZED_ENVIRONMENT_REQUIRED' } };
    return { ok: false, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' } };
  }
}

function publicHand(rec) {
  const h = rec.hand;
  return {
    profileId: rec.id, displayName: rec.displayName, uid: shortUid(h.uid), seat: h.seat,
    roundIdentity: h.roundIdentity, cards: h.cardsRaw.slice(),
    decoded: h.decodedCards.map((d) => ({ code: d.code, label: d.label, rank: d.rank, suit: d.suit, color: d.color })),
    sortedCards: h.sortedCards.slice(), serverMelds: h.serverMelds.slice(),
    publicMelds: h.publicMelds.map((m) => ({ meid: m.meid, cards: m.cards.slice() })),
    cardCount: h.cardCount, authoritative: h.authoritative, syncState: h.syncState, revision: h.revision,
    lastDrawn: h.lastDrawn, lastDiscarded: h.lastDiscarded, currentTurnUid: shortUid(h.currentTurnUid),
    resultDelta: h.resultDelta, updatedAt: h.updatedAt, lastError: h.lastError,
  };
}

mixin(HostTableCoordinator, CoordinatorTableActions, CoordinatorSearch);

module.exports = { HostTableCoordinator };
