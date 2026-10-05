'use strict';

const EventEmitter = require('node:events');
const { PhomContext } = require('./phom-context.cjs');
const { reduceHand, emptyHand } = require('./hand-reducer.cjs');
const { ZONE, GID } = require('./phom-frame-classify.cjs');
const { buildTableReadyFrame, buildAutoReadyPrefFrame, buildQuickPlayFrame, buildChannelListFrame, buildJoinTableFrame, buildChannelQuickJoinFrame, buildProbeJoinFrame, buildLeaveFrame } = require('./phom-wire.cjs');
const { remainingCardsView } = require('./remaining-cards.cjs');
const { createCardObserver } = require('./phom-card-observer.cjs');
const { redactDiagnostic } = require('./diagnostic-redaction.cjs');

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
// Pure of Electron/CDP: `send(frame, ctx)` is the per-browser seam (main → wsReplay.sendProtocol on that run's own
// socket), so everything here is unit-testable.
// ---------------------------------------------------------------------------

// How long RỜI BÀN waits for the server to prove the browser is out of the table.
const LEAVE_CONFIRM_MS = 5000;
// The pause between two asks of a search when no group pacing is supplied.
const REROLL_COOLDOWN_MS = 1500;
// After the server REFUSES a JOIN, how long to still wait for a seat (a second JOIN in flight can still seat us).
const JOIN_REJECT_GRACE_MS = 600;
// How long TẠO waits for the refusal of its U+200B probe (live: ~50ms).
const PROBE_ACK_MS = 1500;
// The whole DÒ KEY / TẠO budget before the user is told.
const SEARCH_BUDGET_MS = 180000;
// TẠO fast path: at most this many one-player tables taken from the table list are sat at per search (the KEY's is
// normally the newest; the cap keeps the account from sitting at a row of strangers' tables).
const LIST_CANDIDATE_MAX = 6;
// TẠO lottery: at most this many 313 asks a minute, all accounts together (each ask = one wrong-password join).
const LOTTERY_PER_MIN = 15;

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
      case 'HOST_CHANGED': rec._hostUid = cls.uid; break;
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
    if (playing && meta.direction !== 'send' && !meta.replay && (cls.type === 'TABLE_STATE' || cls.type === 'SEAT_UPDATE' || cls.type === 'USER_READY')) this.emit('seats', { id: rec.id });
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

  // ---- VÀO / RỜI ---------------------------------------------------------------------------------------------
  // VÀO — sit at this exact số bàn (op 8). A browser seated elsewhere leaves first (a JOIN sent while seated makes the
  // server move the player). `expectUid`: the table must hold that player (the KEY) or the browser leaves again.
  async joinTable(profileId, rid, opts = {}) {
    if (!this._guard()) return this._unauthorized();
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    const r = Number(rid);
    if (!Number.isFinite(r) || r <= 0) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_INVALID_RID', message: 'Số bàn trống hoặc không hợp lệ' } }; }
    if (this._ownSeated(rec)) {
      const lv = await this._leaveConfirmed(rec, ++rec._manualGen);
      if (!lv.confirmed) return { ok: false, id: rec.id, cancelled: lv.cancelled, error: rec.lastError || { code: 'PHOM_OPERATION_CANCELLED', message: 'Đã hủy' } };
    }
    const j = await this._joinTable(rec, r, opts);
    if (!j.ok || opts.expectUid == null || this._seatedWith(rec, opts.expectUid)) return j;
    // Seated, but not with the KEY: this is not the group's table.
    await this._leaveConfirmed(rec, ++rec._manualGen);
    rec.lastError = { code: 'PHOM_NOT_KEY_TABLE', message: `Bàn ${r} không có acc KEY — đã rời bàn đó` };
    this._changed();
    return { ok: false, id: rec.id, rid: r, error: rec.lastError };
  }

  // RỜI BÀN — leave and WAIT for the server's confirmation.
  async leaveTable(profileId) {
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY' } };
    if (!this._ownSeated(rec)) return { ok: true, already: true };
    const left = await this._leaveConfirmed(rec, ++rec._manualGen);
    return left.confirmed ? { ok: true } : { ok: false, error: rec.lastError || { code: 'PHOM_LEAVE_NOT_CONFIRMED' } };
  }

  // The account's server-side "tự sẵn sàng" preference (CMD 363). Set BEFORE a browser sits down: with it on the game
  // client readies by itself on join / after a round, and there is no un-ready command.
  async setAutoReadyPref(profileId, on) {
    const rec = this._rec(profileId);
    if (!rec || !rec.ctx.sendContext()) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND' } };
    try { const r = await rec.send(buildAutoReadyPrefFrame(on), rec.ctx.sendContext()); return { ok: r?.ok !== false }; }
    catch (e) { return { ok: false, error: { code: 'PHOM_PREF_FAILED', message: errMsg(e) } }; }
  }
  // BẮT ĐẦU — the table HOST starts the round: the same cmd 5 frame that is SẴN SÀNG for anyone else (Phỏm
  // TableCommand START = READY = 5). Only for the host; table-group decides WHEN (full table, everyone else ready).
  async sendTableStart(profileId) {
    const rec = this._rec(profileId);
    if (!rec || !rec.ctx.sendContext()) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND' } };
    if (!this.isTableHost(profileId)) return { ok: false, error: { code: 'PHOM_NOT_HOST', message: 'Chỉ chủ bàn bắt đầu được ván' } };
    try { const r = await rec.send(buildTableReadyFrame(), rec.ctx.sendContext()); return { ok: r?.ok !== false }; }
    catch (e) { return { ok: false, error: { code: 'PHOM_START_FAILED', message: errMsg(e) } }; }
  }
  // How many sit at this browser's table, and are all of them except the host ready? (the full-table auto start)
  tablePlayerCount(profileId) { const r = this._rec(profileId); const ts = r && this._ownSeated(r) ? r.ctx.tableState() : null; return ts ? ts.seats.length : 0; }
  // Is a player who is NOT one of ours ready at this browser's table? (the trigger for the CHƯA SẴN SÀNG account)
  strangerReady(profileId) {
    const r = this._rec(profileId); const ts = r && this._ownSeated(r) ? r.ctx.tableState() : null;
    if (!ts) return false;
    const ours = new Set([...this._profiles.values()].map((x) => x.ctx.uid()).filter(Boolean).map(String));
    return ts.seats.some((s) => s.uid && !ours.has(String(s.uid)) && (s.ready || this._readyUids.has(s.uid)));
  }
  othersReady(profileId) {
    const r = this._rec(profileId); const ts = r && this._ownSeated(r) ? r.ctx.tableState() : null;
    if (!ts) return false;
    const hostUid = r._hostUid || (ts.seats.find((s) => s.host) || {}).uid;
    return ts.seats.filter((s) => s.uid && s.uid !== hostUid).every((s) => s.ready || this._readyUids.has(s.uid));
  }
  // SẴN SÀNG at the current table — never for the table HOST (for a host the same cmd 5 means BẮT ĐẦU).
  async sendTableReady(profileId, rid) {
    const rec = this._rec(profileId);
    if (!rec || !rec.ctx.sendContext()) return { ok: false, error: { code: 'PHOM_SOCKET_NOT_FOUND' } };
    if (this.isTableHost(profileId)) return { ok: false, error: { code: 'PHOM_HOST_NEVER_STARTS', message: 'Chủ bàn không tự bấm Bắt đầu' } };
    try { const r = await rec.send(buildTableReadyFrame(), rec.ctx.sendContext()); return { ok: r?.ok !== false }; }
    catch (e) { return { ok: false, error: { code: 'PHOM_READY_FAILED', message: errMsg(e) } }; }
  }

  // op 8 and the wait for its proof: own uid in a TABLE_STATE that arrived after the send, or the server's refusal.
  async _joinTable(rec, r, opts = {}) {
    const ctx = rec.ctx.sendContext();
    if (!ctx) { rec.manualState = 'ERROR'; return { ok: false, id: rec.id, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'browser has no game socket yet' } }; }
    const myGen = ++rec._manualGen;
    const ackBefore = rec.ctx.ackSeq();
    const tableBefore = rec.ctx.tableSeq();
    rec.manualState = 'JOINING'; rec.lastError = null;
    this._log('JOIN_SENT', rec, { rid: r });
    this._changed();
    try { const sent = await rec.send(buildJoinTableFrame(r, ''), ctx); if (sent?.ok === false) throw new Error('JOIN_SEND_FAILED'); }
    catch (e) { return this._joinFailed(rec, r, { code: 'PHOM_JOIN_FAILED', message: errMsg(e) }); }
    const seatedFresh = () => this._ownSeated(rec) && rec.ctx.tableSeq() > tableBefore;
    const refusal = () => { const a = rec.ctx.lastJoinAck(); return a && a.seq > ackBefore && a.accepted === false ? a : null; };
    let seated = await this._waitManual(() => seatedFresh() || !!refusal(), rec, myGen, opts.timeoutMs != null ? opts.timeoutMs : 8000);
    if (seated && !seatedFresh()) seated = await this._waitManual(seatedFresh, rec, myGen, this._joinRejectGraceMs);
    if (rec._manualGen !== myGen) return { ok: false, id: rec.id, rid: r, superseded: true };
    if (this._stopped) return this._joinFailed(rec, r, { code: 'PHOM_OPERATION_CANCELLED', message: 'stopped' });
    if (!seated) {
      const refused = refusal();
      if (refused) return this._joinFailed(rec, r, { code: 'PHOM_JOIN_REJECTED', message: `Máy chủ từ chối vào bàn: ${refused.message || `mã ${refused.code}`}`, serverCode: refused.code });
      return this._joinFailed(rec, r, { code: 'PHOM_JOIN_NOT_CONFIRMED', message: 'Không thấy vào bàn sau 8 giây' });
    }
    rec._joinedRid = r; rec._lastRid = r; rec._joinedViaChannel = false;
    rec.manualState = 'JOINED'; rec.lastError = null;
    this._changed();
    const ts = rec.ctx.tableState();
    return { ok: true, id: rec.id, rid: r, state: 'JOINED', seat: rec.ctx.seat(), membership: ts ? ts.uids.slice() : [] };
  }
  _joinFailed(rec, rid, error) {
    rec._joinedRid = null; rec.manualState = 'ERROR'; rec.lastError = error;
    this._log('JOIN_FAILED', rec, { rid, code: error.code, serverCode: error.serverCode, reason: error.message });
    this._changed();
    return { ok: false, id: rec.id, rid, error };
  }
  async _leaveConfirmed(rec, myGen) {
    const ackBefore = rec.ctx.ackSeq();
    this._log('LEAVE_SENT', rec, { by: 'tool', state: rec.manualState || null, search: rec._searchKind || null });
    let sent = true; try { const r = await rec.send(buildLeaveFrame(), rec.ctx.sendContext()); sent = r?.ok !== false; } catch { sent = false; }
    const acked = () => { const a = rec.ctx.lastLeaveAck(); return !!(a && a.seq > ackBefore && a.accepted); };
    const confirmed = sent && await this._waitManual(() => acked() || !this._ownSeated(rec), rec, myGen, this._leaveConfirmMs);
    if (rec._manualGen !== myGen || this._stopped) return { confirmed: false, cancelled: true };
    if (!confirmed) {
      rec.manualState = 'LEAVE_UNCONFIRMED';
      rec.lastError = { code: 'PHOM_LEAVE_NOT_CONFIRMED', message: 'Chưa xác nhận đã rời bàn — không gửi lệnh vào bàn mới' };
      this._changed();
      return { confirmed: false, cancelled: false };
    }
    rec.ctx.leaveTable(); rec._joinedRid = null; rec._hostUid = null; rec._inRound = false;
    if (rec.manualState !== 'SEARCHING') rec.manualState = 'READY';
    return { confirmed: true, cancelled: false };
  }

  // ---- DÒ KEY / TẠO --------------------------------------------------------------------------------------------
  //  DÒ KEY (the KEY account) — quick-play into the stake CHANNEL, [3,"Simms",<channel rid>,"",true]: the server seats
  //  the account at some table of that stake. Strangers already there → leave and ask again (every ~1–2s) until the
  //  account sits ALONE, i.e. it is the host of a fresh public table. TABLE_STATE carries no rid, so nobody knows that
  //  table's số bàn yet — not even the KEY.
  //
  //  TẠO (the other accounts) — ask 313 for a table of the stake, over and over. The answer NAMES a table (rid + uC)
  //  and seats nobody. Every named table gets a JOIN with the invisible password U+200B, which is always refused (103)
  //  — so the account never ends up at a stranger's table, whatever the game client does with the answer. A table with
  //  exactly ONE player may be the KEY sitting alone: that one is really joined (op 8) and kept only when the KEY's uid
  //  is in its ps[] (the reference tool skips that check and twice sat down at a stranger's table). The rid of that
  //  join IS the group's số bàn.
  //
  // Both give up after the search budget (3 minutes) with a typed error; cancelSearch() stops either at its next step.
  async findKeyTable(profileId, opts = {}) {
    const pre = await this._searchPrepare(profileId, opts);
    if (pre.result) return pre.result;
    const { rec, stake, sg, deadline, timeoutMs } = pre;
    const channel = this._stakeChannel(rec, stake);
    if (channel == null) return this._searchFail(rec, 'PHOM_NO_STAKE_CHANNEL', `Chưa thấy kênh cược ${stake} trong sảnh — tải lại danh sách cược rồi thử lại`, { stake });
    this._searchBegin(rec, 'KEY');
    for (let attempt = 0; ; attempt++) {
      if (!await this._searchBreathe(rec, sg, opts)) return this._searchCancelled(rec);
      const myGen = this._searchStep(rec, attempt);
      const tableBefore = rec.ctx.tableSeq();
      const ackBefore = rec.ctx.ackSeq();
      this._log('KEY_SCAN_SENT', rec, { stake, channel, attempt });
      if (!await this._searchSend(rec, buildChannelQuickJoinFrame(channel))) return this._searchFail(rec, 'PHOM_FIND_FAILED', 'Không gửi được lệnh vào kênh cược');
      const seatedFresh = () => this._ownSeated(rec) && rec.ctx.tableSeq() > tableBefore;
      const refusal = () => { const a = rec.ctx.lastJoinAck(); return a && a.seq > ackBefore && a.accepted === false ? a : null; };
      await this._waitManual(() => seatedFresh() || !!refusal(), rec, myGen, timeoutMs);
      if (this._searchStopped(rec, sg)) return this._searchCancelled(rec);
      if (!seatedFresh()) {
        const r = refusal();
        this._log('KEY_SCAN_NOT_SEATED', rec, { attempt, code: r ? r.code : null, reason: r ? r.message : null });
        if (this._now() >= deadline) return this._searchFail(rec, 'PHOM_NO_KEY_TABLE', `Không ngồi được một mình ở bàn nào cược ${stake} sau 3 phút${r && r.message ? ` — máy chủ: ${r.message}` : ''}`, { stake, attempts: attempt + 1 });
        continue;
      }
      const others = rec.ctx.tableState().seats.filter((s) => s.uid !== rec.ctx.uid()).length;
      if (others === 0) {
        // Alone = host of a fresh public table. Until TẠO learns its số bàn the seat is shown as the channel (KÊNH).
        rec._joinedRid = channel; rec._joinedViaChannel = true; rec.manualState = 'JOINED'; rec.lastError = null;
        this._searchEnd(rec);
        this._log('KEY_TABLE_OK', rec, { stake, channel, attempt });
        this._changed();
        return { ok: true, id: rec.id, channel, state: 'JOINED', seat: rec.ctx.seat(), attempts: attempt + 1 };
      }
      this._log('KEY_SCAN_STRANGERS', rec, { attempt, others });
      const lv = await this._leaveConfirmed(rec, myGen);
      if (lv.cancelled || this._searchStopped(rec, sg)) return this._searchCancelled(rec);
      if (!lv.confirmed) { this._searchEnd(rec); return { ok: false, id: rec.id, state: rec.manualState, error: rec.lastError }; }
      if (this._now() >= deadline) return this._searchFail(rec, 'PHOM_NO_KEY_TABLE', `Bàn nào cược ${stake} cũng đã có người — chưa ngồi được một mình sau 3 phút`, { stake, attempts: attempt + 1 });
    }
  }

  async scanForKeyTable(profileId, opts = {}) {
    const pre = await this._searchPrepare(profileId, opts);
    if (pre.result) return pre.result;
    const { rec, stake, sg, deadline, timeoutMs } = pre;
    const keyUid = opts.keyUid != null ? String(opts.keyUid) : null;
    if (!keyUid) return this._searchFail(rec, 'PHOM_NO_KEY', 'Chưa có acc KEY ngồi bàn — bấm Dò Key ở một trình duyệt trước');
    this._searchBegin(rec, 'SCAN');
    let lastMessage = null;
    // FAST PATH (2026-10-05 "Tạo is slow, it seems to browse"): the server broadcasts the whole table list to every
    // browser (~every 60s). The KEY sits ALONE at a FRESH public table of the stake, and table numbers only grow — so
    // in a list received after the KEY sat down, its table is a one-player row of the stake, near the top when sorted
    // by number (newest first). Those rows are tried first, straight with op 8; the 313 lottery only runs while no
    // such list has arrived yet. Rows already tried (either way) are never tried again; strangers' tables tried from
    // the list are capped.
    const tried = new Set();
    let listTries = 0;
    let lotteryAsks = 0;
    let lastGate = null;
    // when the KEY last sat down — a function (the group's current value: the KEY may be kicked and sit again) or a number
    const keySince = () => { const v = typeof opts.keySeatedAt === 'function' ? opts.keySeatedAt() : opts.keySeatedAt; return v != null ? Number(v) : null; };
    const keyRec = [...this._profiles.values()].find((r) => r.ctx.uid() != null && String(r.ctx.uid()) === keyUid) || null;
    let waitingKey = false;
    const giveUp = (attempt) => this._searchFail(rec, 'PHOM_NO_KEY_TABLE', `Chưa dò ra bàn của acc KEY (cược ${stake}) sau 3 phút${lastMessage ? ` — máy chủ: ${lastMessage}` : ''}`, { stake, attempts: attempt + 1 });
    for (let attempt = 0; ; attempt++) {
      if (!await this._searchBreathe(rec, sg, opts)) return this._searchCancelled(rec);
      const myGen = this._searchStep(rec, attempt);
      // (1) The KEY is not at a table (kicked — its table is gone — or re-running Dò Key): nothing to look for. Wait
      // for it to sit again WITHOUT asking (live 2026-10-05: the KEY's table lived ~20s, the lottery chased dead tables
      // for minutes and the account was logged out).
      if (keyRec && keyRec !== rec && !this._ownSeated(keyRec)) {
        if (!waitingKey) { waitingKey = true; this._log('SCAN_WAIT_KEY', rec, { attempt }); }
        await this._waitManual(() => this._ownSeated(keyRec), rec, myGen, 1000);
        if (this._searchStopped(rec, sg)) return this._searchCancelled(rec);
        if (this._now() >= deadline) return giveUp(attempt);
        continue;
      }
      waitingKey = false;
      const listRid = listTries < LIST_CANDIDATE_MAX ? this._listCandidates(stake, keySince(), tried)[0] : undefined;
      if (listRid != null) {
        tried.add(listRid); listTries += 1;
        this._log('SCAN_LIST_CANDIDATE', rec, { rid: listRid, attempt, listTries });
        const j = await this._joinTable(rec, listRid, { timeoutMs });
        if (j.superseded || this._searchStopped(rec, sg)) return this._searchCancelled(rec);
        if (j.ok && this._seatedWith(rec, keyUid)) return this._scanFound(rec, listRid, attempt);
        rec.manualState = 'SEARCHING';
        if (j.ok) {
          this._log('SCAN_NOT_KEY', rec, { rid: listRid, host: rec._hostUid, attempt, from: 'list' });
          const lv = await this._leaveConfirmed(rec, rec._manualGen);
          if (lv.cancelled || this._searchStopped(rec, sg)) return this._searchCancelled(rec);
          if (!lv.confirmed) { this._searchEnd(rec); return { ok: false, id: rec.id, state: rec.manualState, error: rec.lastError }; }
        }
        if (this._now() >= deadline) return giveUp(attempt);
        continue;
      }
      // (2) Each 313 is one wrong-password join (the game's own, armed). An account was logged out after ~60 of them a
      // minute for 10 minutes (live 2026-10-05). So: ONE account runs the lottery at a time (the accounts share an IP),
      // and all of them together ask at most LOTTERY_PER_MIN times a minute. A waiting account still uses the list.
      const gate = this._lotteryGate(rec);
      if (gate.wait) {
        if (gate.reason !== lastGate) { lastGate = gate.reason; this._log('SCAN_THROTTLED', rec, { attempt, reason: gate.reason }); }
        await this._waitManual(() => false, rec, myGen, Math.min(1000, gate.wait));
        if (this._searchStopped(rec, sg)) return this._searchCancelled(rec);
        if (this._now() >= deadline) return giveUp(attempt);
        continue;
      }
      lastGate = null;
      lotteryAsks += 1;
      const assignBefore = rec.ctx.roomAssignSeq();
      const ackBeforeAsk = rec.ctx.ackSeq(); // the game's own (armed) join answering the 313 acks after this
      const tableBefore = rec.ctx.tableSeq(); // before the ask: the game client may sit down the instant the answer lands
      this._log('SCAN_SENT', rec, { stake, attempt });
      // The game client answers a 313 by joining the named table ITSELF ([3,"Simms",rid,""]) — at a stranger's table,
      // where it auto-readies and the round starts. Armed, that join leaves the page with the U+200B password and is
      // refused, exactly like the reference tool's.
      if (rec.armProbe) { try { await rec.armProbe(rec.ctx.sendContext()); } catch { /* the probe + leave below still guard */ } }
      if (!await this._searchSend(rec, buildQuickPlayFrame({ stake }))) return this._searchFail(rec, 'PHOM_FIND_FAILED', 'Không gửi được lệnh tìm bàn');
      const reply = () => { const r = rec.ctx.lastRoomAssign(); return r && r.seq > assignBefore ? r : null; };
      await this._waitManual(() => !!reply(), rec, myGen, timeoutMs);
      if (this._searchStopped(rec, sg)) return this._searchCancelled(rec);
      const res = reply();
      if (!res || !res.ok) {
        lastMessage = res && res.message ? res.message : lastMessage;
        this._log('SCAN_NO_TABLE', rec, { attempt, reason: lastMessage });
        if (this._now() >= deadline) return giveUp(attempt);
        continue;
      }
      const rid = Number(res.rid);
      const seatedFresh = () => this._ownSeated(rec) && rec.ctx.tableSeq() > tableBefore;
      if (res.isTable && tried.has(rid) && !seatedFresh()) { // already looked at this one (from the list or before)
        if (this._now() >= deadline) return giveUp(attempt);
        continue;
      }
      if (res.isTable) tried.add(rid);
      if (res.isTable) {
        // The game client answers the 313 with its own JOIN, armed to the invisible password → refused (103). That
        // refusal is the proof the account did not sit down: wait for it first, and send the tool's own probe (a
        // second wrong-password join) ONLY when the game's join did not come back.
        const gameAck = () => { const a = rec.ctx.lastJoinAck(); return !!(a && a.seq > ackBeforeAsk) || seatedFresh(); };
        await this._waitManual(gameAck, rec, myGen, this._probeAckMs);
        if (this._searchStopped(rec, sg)) return this._searchCancelled(rec);
        if (!gameAck()) {
          const ackBefore = rec.ctx.ackSeq();
          await this._searchSend(rec, buildProbeJoinFrame(rid));
          await this._waitManual(() => { const a = rec.ctx.lastJoinAck(); return !!(a && a.seq > ackBefore) || seatedFresh(); }, rec, myGen, this._probeAckMs);
          if (this._searchStopped(rec, sg)) return this._searchCancelled(rec);
        }
      }
      if (seatedFresh()) {
        // Seated anyway (the game client answering the 313 by itself): fine only at the KEY's table.
        if (this._seatedWith(rec, keyUid)) return this._scanFound(rec, rid, attempt);
        this._log('SCAN_UNEXPECTED_SEAT', rec, { rid, attempt });
        const lv = await this._leaveConfirmed(rec, myGen);
        if (lv.cancelled || this._searchStopped(rec, sg)) return this._searchCancelled(rec);
        if (!lv.confirmed) { this._searchEnd(rec); return { ok: false, id: rec.id, state: rec.manualState, error: rec.lastError }; }
        if (this._now() >= deadline) return giveUp(attempt);
        continue;
      }
      if (!(res.isTable && !res.locked && Number(res.seated) === 1)) {
        this._log('SCAN_SKIP', rec, { rid, seated: res.seated, isTable: res.isTable, locked: res.locked, attempt });
        if (this._now() >= deadline) return giveUp(attempt);
        continue;
      }
      // One player at this table — maybe the KEY. Sit down for real and look.
      this._log('SCAN_CANDIDATE', rec, { rid, attempt });
      const j = await this._joinTable(rec, rid, { timeoutMs });
      if (j.superseded || this._searchStopped(rec, sg)) return this._searchCancelled(rec);
      if (j.ok && this._seatedWith(rec, keyUid)) return this._scanFound(rec, rid, attempt);
      rec.manualState = 'SEARCHING';
      if (j.ok) {
        this._log('SCAN_NOT_KEY', rec, { rid, host: rec._hostUid, attempt });
        const lv = await this._leaveConfirmed(rec, rec._manualGen);
        if (lv.cancelled || this._searchStopped(rec, sg)) return this._searchCancelled(rec);
        if (!lv.confirmed) { this._searchEnd(rec); return { ok: false, id: rec.id, state: rec.manualState, error: rec.lastError }; }
      }
      if (this._now() >= deadline) return giveUp(attempt);
    }
  }

  // The 313 lottery gate: one account at a time (the owner keeps it until its search ends), and at most
  // _lotteryPerMin asks a minute across all accounts. Returns { wait: ms } when this account must not ask now.
  _lotteryGate(rec) {
    const L = this._lottery; const now = this._now();
    const owner = L.owner != null ? this._rec(L.owner) : null;
    if (owner && owner !== rec && owner._searchKind === 'SCAN') return { wait: 800, reason: 'OTHER_ACCOUNT' };
    L.owner = rec.id;
    L.asks = L.asks.filter((t) => now - t < 60000);
    if (L.asks.length >= this._lotteryPerMin) return { wait: Math.max(50, 60000 - (now - L.asks[0])), reason: 'RATE' };
    L.asks.push(now);
    return { wait: 0 };
  }
  // TẠO fast path — one-player public tables of the stake from the FRESHEST table list any of our browsers received,
  // only if that list arrived AFTER the KEY sat down (an older list cannot contain its table), newest number first.
  _listCandidates(stake, sinceMs, tried) {
    let best = null;
    for (const r of this._profiles.values()) {
      const at = r.ctx.roomListAt();
      if (at != null && (!best || at > best.at)) best = { at, rows: r.ctx.roomList() };
    }
    if (!best || (sinceMs != null && best.at < sinceMs)) return [];
    return best.rows
      .filter((c) => Number(c.b) === Number(stake) && Number(c.uC) === 1 && !c.hpwd && !tried.has(Number(c.rid)))
      .map((c) => Number(c.rid))
      .sort((a, b) => b - a);
  }

  // DỪNG on the header: stop the DÒ KEY / TẠO running on this browser. A seat it already holds is kept.
  cancelSearch(profileId) {
    const rec = this._rec(profileId);
    if (!rec) return { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } };
    rec._searchGen += 1;
    rec._manualGen += 1; // wakes the step that is waiting right now
    this._searchEnd(rec);
    this._changed();
    return { ok: true, id: rec.id };
  }

  // The KEY learns its own số bàn from the account that found it: from now on it shows SS <rid>, not the channel.
  adoptTableRid(profileId, rid) {
    const rec = this._rec(profileId);
    if (!rec || !this._ownSeated(rec) || !Number.isFinite(Number(rid))) return false;
    rec._joinedRid = Number(rid); rec._lastRid = Number(rid); rec._joinedViaChannel = false;
    this._changed();
    return true;
  }

  // The stake CHANNEL of this stake (rs[] row "Phom#n", small rid) — what DÒ KEY quick-plays into.
  _stakeChannel(rec, stake) {
    const c = rec.ctx.channels().find((x) => Number(x.b) === Number(stake) && Number(x.rid) < 100000
      && (x.zn == null || x.zn === ZONE) && (x.gid == null || Number(x.gid) === GID));
    return c ? Number(c.rid) : null;
  }
  async _searchPrepare(profileId, opts) {
    if (!this._guard()) return { result: this._unauthorized() };
    const rec = this._rec(profileId);
    if (!rec) return { result: { ok: false, error: { code: 'PHOM_PROFILE_NOT_READY', message: `unknown browser ${profileId}` } } };
    const stake = Number(opts.stake);
    if (!Number.isFinite(stake) || stake <= 0) return { result: { ok: false, id: rec.id, error: { code: 'PHOM_INVALID_STAKE', message: 'Chọn mức cược để tìm bàn' } } };
    if (!rec.ctx.sendContext()) { rec.manualState = 'ERROR'; return { result: { ok: false, id: rec.id, error: { code: 'PHOM_SOCKET_NOT_FOUND', message: 'browser has no game socket yet' } } }; }
    const sg = ++rec._searchGen;
    if (this._ownSeated(rec)) {
      const lv = await this._leaveConfirmed(rec, ++rec._manualGen);
      if (!lv.confirmed) return { result: { ok: false, id: rec.id, state: rec.manualState, error: rec.lastError || { code: 'PHOM_OPERATION_CANCELLED' } } };
    }
    const deadline = this._now() + (opts.budgetMs != null ? Number(opts.budgetMs) : this._findBudgetMs);
    return { rec, stake, sg, deadline, timeoutMs: opts.timeoutMs != null ? opts.timeoutMs : 8000 };
  }
  _searchBegin(rec, kind) {
    rec.manualState = 'SEARCHING'; rec._searchKind = kind; rec._searchStartedAt = this._now(); rec._searchAttempt = 0; rec.lastError = null;
    this._changed();
  }
  _searchStep(rec, attempt) {
    rec.manualState = 'SEARCHING'; rec._searchAttempt = attempt + 1;
    this._changed();
    return ++rec._manualGen;
  }
  async _searchSend(rec, frame) {
    try { const r = await rec.send(frame, rec.ctx.sendContext()); return r?.ok !== false; } catch { return false; }
  }
  _searchEnd(rec) {
    if (this._lottery.owner === rec.id) this._lottery.owner = null; // the lottery is free for another account
    if (rec.manualState === 'SEARCHING') rec.manualState = this._ownSeated(rec) ? 'JOINED' : 'READY';
    rec._searchKind = null; rec._searchStartedAt = null;
  }
  _searchStopped(rec, sg) { return this._stopped || rec._searchGen !== sg; }
  // The pause before every ask: the group's pacing when it drives the search, else the reroll cooldown.
  async _searchBreathe(rec, sg, opts) {
    if (this._searchStopped(rec, sg)) return false;
    if (typeof opts.pace === 'function') { if (await opts.pace() === false) return false; }
    else await this._waitManual(() => false, rec, rec._manualGen, this._rerollCooldownMs);
    return !this._searchStopped(rec, sg);
  }
  _searchCancelled(rec) {
    this._searchEnd(rec);
    this._changed();
    return { ok: false, id: rec.id, cancelled: true, superseded: true, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'Đã dừng dò bàn' } };
  }
  _searchFail(rec, code, message, extra = {}) {
    this._searchEnd(rec);
    rec.manualState = 'ERROR'; rec.lastError = { code, message };
    this._log('SEARCH_FAIL', rec, { code, ...extra });
    this._changed();
    return { ok: false, id: rec.id, error: rec.lastError, ...extra };
  }
  _scanFound(rec, rid, attempt) {
    rec._joinedRid = rid; rec._lastRid = rid; rec._joinedViaChannel = false; rec.manualState = 'JOINED'; rec.lastError = null;
    this._searchEnd(rec);
    this._log('SCAN_KEY_FOUND', rec, { rid, attempt });
    this._changed();
    return { ok: true, id: rec.id, rid, found: true, state: 'JOINED', seat: rec.ctx.seat(), attempts: attempt + 1 };
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
function errMsg(e) { return String(e && e.message || e); }
function accountIdOf(uid) { if (uid == null) return null; const m = /^\d+_(\d+)$/.exec(String(uid)); return m ? m[1] : null; }
// A short server reply kept verbatim in the diagnostic log (only refusals / kicks — never a login frame, which holds the
// session token). Bounded so a log line never grows with the frame.
function frameText(raw) { return typeof raw === 'string' && !/token|"pwd"|password/i.test(raw) ? raw.slice(0, 300) : null; }
function shortUid(uid) { if (uid == null) return null; const s = String(uid); return s.length <= 6 ? s : `${s.slice(0, 4)}…${s.slice(-3)}`; }

module.exports = { HostTableCoordinator };
