'use strict';

// ---------------------------------------------------------------------------
// Table coordinator — DÒ KEY (findKeyTable) and TẠO (scanForKeyTable): the group's table search.
// Part of HostTableCoordinator (host-table-coordinator.cjs) — its methods are mixed into that class: `this` is the
// coordinator (this._rec, this._log, this._changed, … live there).
// ---------------------------------------------------------------------------

const { ZONE, GID } = require('./phom-frame-classify.cjs');
const { buildQuickPlayFrame, buildChannelQuickJoinFrame, buildProbeJoinFrame } = require('./phom-wire.cjs');

// The pause between two asks of a search when no group pacing is supplied.
const REROLL_COOLDOWN_MS = 1500;
// How long TẠO waits for the refusal of its U+200B probe (live: ~50ms).
const PROBE_ACK_MS = 1500;
// The whole DÒ KEY / TẠO budget before the user is told.
const SEARCH_BUDGET_MS = 180000;
// TẠO fast path: at most this many one-player tables taken from the table list are sat at per search (the KEY's is
// normally the newest; the cap keeps the account from sitting at a row of strangers' tables).
const LIST_CANDIDATE_MAX = 6;
// TẠO lottery: at most this many 313 asks a minute, all accounts together (each ask = one wrong-password join).
const LOTTERY_PER_MIN = 15;

class CoordinatorSearch {
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
}

module.exports = { CoordinatorSearch, REROLL_COOLDOWN_MS, PROBE_ACK_MS, SEARCH_BUDGET_MS, LIST_CANDIDATE_MAX, LOTTERY_PER_MIN };
