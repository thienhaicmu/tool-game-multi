'use strict';

// ---------------------------------------------------------------------------
// TABLE GROUP — the ONE place that decides what the three browsers do at a table.
// It implements docs/phom-kich-ban.md literally; the test names carry the scenario ids (T1, T2, A1 … A6).
//
//   MANUAL (TỰ ĐỘNG off): the tool does exactly what the user pressed and NOTHING else. A kicked member is
//                         reported, never rejoined — unless the user switched its ReJoin on (the reference tool's
//                         toggle); a lost table is reported, never replaced.
//   AUTO   (TỰ ĐỘNG on):  form the group, rejoin a kicked member, take another table when one is lost.
//
// How the group finds its table is the reference tool's (capture 2026-10-02, see host-table-coordinator §dò-key):
//   DÒ KEY  — the KEY account quick-plays into the stake channel until it sits ALONE (host of an empty table).
//   TẠO     — a second account asks 313 until the server names a table with one player whose ps[] holds the KEY:
//             that rid is the group's số bàn (SS), shown in every bar.
//   VÀO     — the third account joins that số bàn directly (op 8).
//
// Two rules hold everywhere:
//   · PACING — every command sent to the server waits a random 0.8–2.5s first (deps.pace).
//   · ONE AT A TIME — every operation runs through a serial queue, so two browsers never send together and a
//     new operation never interleaves with a running one. Turning TỰ ĐỘNG off (or leaving) cancels what is queued
//     via a generation token, exactly like the coordinator's own cancellation.
//
// It owns NO protocol: every server interaction is a coordinator primitive (findKeyTable / scanForKeyTable /
// joinTable / leaveTable / setAutoReadyPref / sendTableReady).
// ---------------------------------------------------------------------------

const EventEmitter = require('node:events');

const ROLE = Object.freeze({ KEY: 'KEY', READY: 'READY', NOT_READY: 'NOT_READY' });
const PACE_MIN_MS = 800;
const PACE_MAX_MS = 2500;
// A kicked member comes back this long after the kick (the reference tool: ~0.5s). It does NOT wait in the queue:
// the NOT_READY account is kicked every ~10s, and an 8s queued rejoin (live log 2026-10-03 14:19) left it out of the
// table most of the time.
const REJOIN_DELAY_MS = 500;
// THAY ACC — how often (and how long) the group checks whether the replacement browser is in the game yet.
const REPLACE_POLL_MS = 1000;
const REPLACE_WAIT_MS = 120000;

class TableGroup extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._coord = deps.coord;
    this._now = deps.now || (() => Date.now());
    this._random = deps.random || Math.random;
    this._sleep = deps.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); }));
    this._paceMin = deps.paceMinMs != null ? Number(deps.paceMinMs) : PACE_MIN_MS;
    this._paceMax = deps.paceMaxMs != null ? Number(deps.paceMaxMs) : PACE_MAX_MS;
    this._log = typeof deps.log === 'function' ? deps.log : () => {};
    this._rejoinDelayMs = deps.rejoinDelayMs != null ? Number(deps.rejoinDelayMs) : REJOIN_DELAY_MS;
    this._replacePollMs = deps.replacePollMs != null ? Number(deps.replacePollMs) : REPLACE_POLL_MS;
    this._replaceWaitMs = deps.replaceWaitMs != null ? Number(deps.replaceWaitMs) : REPLACE_WAIT_MS;
    this._timers = new Set(); // rejoin + replacement timers — all cleared by reset / leaveAll / auto off
    // { rid, key, stake, creatorId, keyUid, roles: Map, kicks: Map, rejoinOn: Set, recreating } — rid stays null from
    // DÒ KEY until a TẠO finds the KEY's table.
    this._group = null;
    this._stake = null;   // THE mức cược, picked once in the Phỏm tool (the in-page bars reuse it, never their own)
    this._auto = false;
    this._gen = 0;        // cancellation token: bumped by setAuto(false), leaveAll, reset
    this._queue = Promise.resolve();
    this._busy = null;    // the label of the running operation (for the UI)
    this._scanning = new Set(); // browsers running a manual TẠO right now (they run side by side)
    if (this._coord) {
      this._coord.on('kicked', ({ id, message } = {}) => this._onKicked(id, message));
      if (typeof this._coord.on === 'function') {
        this._coord.on('strangerReady', (e = {}) => this._onStrangerReady(e.id, e));
        this._coord.on('roundEnd', () => this._onRoundEnd());
      }
    }
  }

  // ---- state for the surfaces -------------------------------------------------
  active() { return !!this._group; }
  // The session's stake: every TÌM BÀN (tool or in-page bar) searches at this stake.
  stake() { return this._stake; }
  setStake(stake) {
    const v = Number(stake);
    this._stake = Number.isFinite(v) && v > 0 ? v : null;
    this._emit();
    return { ok: true, stake: this._stake };
  }
  autoActive() { return this._auto; }
  busy() { return this._busy; }
  roleOf(id) { return this._group ? (this._group.roles.get(String(id)) || null) : null; }
  // The group's số bàn (SS) — null until TẠO found the KEY's table.
  rid() { return this._group && this._group.rid != null ? Number(this._group.rid) : null; }
  rejoinOn(id) { return !!(this._group && this._group.rejoinOn.has(String(id))); }
  snapshot() {
    const g = this._group;
    if (!g) return null;
    return {
      rid: g.rid, stake: g.stake, selectedStake: this._stake, auto: this._auto, busy: this._busy, recreating: g.recreating,
      hostUid: this._coord ? this._coord.tableHostUid() : null,
      members: [...g.roles.entries()].map(([id, role]) => ({
        id, role,
        seated: this._atGroupTable(id),
        ready: !!this._coord && this._coord.isReady(id),
        host: !!this._coord && this._coord.isTableHost(id),
        kicks: (g.kicks.get(id) || []).length,
        rejoinOn: g.rejoinOn.has(id),
      })),
    };
  }

  // ---- pacing + serial queue --------------------------------------------------
  // Every command waits a random 0.8–2.5s. `gen` makes a cancelled operation stop at its next step.
  async pace(gen) {
    const ms = Math.round(this._paceMin + this._random() * (this._paceMax - this._paceMin));
    await this._sleep(ms);
    return gen == null || gen === this._gen;
  }
  _cancelled(gen) { return gen !== this._gen; }
  // Run `op` after everything already queued. Its result is returned to the caller; a rejection never breaks the
  // queue for the next operation.
  _enqueue(label, op) {
    const run = this._queue.then(async () => {
      const gen = this._gen;
      this._busy = label; this._emit();
      try { return await op(gen); }
      catch (e) { return { ok: false, error: { code: 'PHOM_GROUP_FAILED', message: String(e && e.message || e) } }; }
      finally { this._busy = null; this._emit(); }
    });
    this._queue = run.then(() => {}, () => {});
    return run;
  }
  _emit() { this.emit('update', this.snapshot()); }
  _event(name, data = {}) { this._log(name, data); this.emit('notice', { event: name, ...data }); }

  // ---- T1 / A1 building blocks ------------------------------------------------
  // T1 — DÒ KEY: this browser sits ALONE at an empty public table of the stake and becomes KEY. The table's số bàn
  // is not known yet (the server never says it to the KEY); T2a finds it.
  findTable(profileId, { stake } = {}) {
    const s = Number(stake) > 0 ? Number(stake) : this._stake; // the bar sends none: it uses the tool's Tiền
    return this._enqueue('FIND', (gen) => this._find(profileId, s, gen));
  }
  async _find(profileId, stake, gen) {
    const id = String(profileId);
    if (!this._coord.browserReady(id)) return { ok: false, error: { code: 'PHOM_NOT_IN_GAME', message: 'Acc chưa vào game' } };
    if (!(Number(stake) > 0)) return { ok: false, error: { code: 'PHOM_INVALID_STAKE', message: 'Chưa chọn Tiền — chọn mức cược ở tool Phỏm' } };
    // ONE KEY per group: a second Dò Key would split the accounts over two tables (live run 2026-10-03: B1 and B2 both
    // pressed it and never met). The others join the KEY with Tạo / Vào.
    const cur = this._group;
    if (cur && cur.creatorId !== id && this._atGroupTable(cur.creatorId)) {
      return { ok: false, error: { code: 'PHOM_KEY_EXISTS', message: `Đã có acc KEY (P${this._orderedIds().indexOf(cur.creatorId) + 1}) đang ngồi — ở acc này bấm Tạo${cur.rid != null ? ' hoặc Vào' : ''}, không bấm Dò Key` } };
    }
    const left = await this._leaveIfSeated(id, gen);
    if (!left.ok) return left;
    if (this._cancelled(gen)) return CANCELLED;
    if (!await this.pace(gen)) return CANCELLED;
    await this._coord.setAutoReadyPref(id, false); // KEY never auto-readies
    const res = await this._coord.findKeyTable(id, { stake: Number(stake), pace: () => this.pace(gen) });
    if (!res.ok) { this._event('FIND_FAILED', { id, error: res.error }); return res; }
    this._group = { rid: null, stake: Number(stake), creatorId: id, keyUid: this._coord.uidOf(id), roles: new Map([[id, ROLE.KEY]]), kicks: new Map(), rejoinOn: new Set(), autoRejoin: new Set(), rejoinPending: new Set(), bellRung: new Set(), recreating: false };
    this._event('KEY_SEATED', { id, channel: res.channel });
    this._emit();
    return { ...res, role: ROLE.KEY, roles: { [id]: ROLE.KEY } };
  }

  // T2a — TẠO: a non-KEY browser looks for the KEY's table (313 + the U+200B probe) and sits down there. The rid it
  // lands on becomes the group's số bàn. Once the số bàn is known, TẠO is simply VÀO.
  // Like the reference tool, several browsers may run TẠO AT THE SAME TIME (capture 2026-10-02: B and C scanned side
  // by side): a manual TẠO does not wait in the group queue. The first one to find the KEY sits as CHƯA SẴN SÀNG; the
  // others stop scanning and join that số bàn (the second one = SẴN SÀNG).
  scanTable(profileId) {
    const id = String(profileId);
    const g = this._group;
    if (g && g.rid != null) return this.joinTable(id, g.rid);
    if (this._scanning.has(id)) return Promise.resolve({ ok: false, busy: true, error: { code: 'PHOM_SCAN_RUNNING', message: 'Acc này đang dò bàn KEY' } });
    this._scanning.add(id); this._emit();
    return this._scan(id, this._gen).finally(() => { this._scanning.delete(id); this._emit(); });
  }
  async _scan(profileId, gen) {
    const id = String(profileId);
    const g = this._group;
    if (!g || !g.keyUid) return { ok: false, error: { code: 'PHOM_NO_KEY', message: 'Chưa có acc KEY — bấm Dò Key ở MỘT acc trước' } };
    if (g.rid != null) return this._join(id, g.rid, gen);
    if (id === g.creatorId) return { ok: false, error: { code: 'PHOM_KEY_CANNOT_SCAN', message: 'Đây là acc KEY — bấm Tạo ở acc khác' } };
    if (!this._coord.browserReady(id)) return { ok: false, error: { code: 'PHOM_NOT_IN_GAME', message: 'Acc chưa vào game' } };
    const left = await this._leaveIfSeated(id, gen);
    if (!left.ok) return left;
    if (!await this.pace(gen)) return CANCELLED;
    // Searching sits down at strangers' one-player tables now and then: never ready there (the reference tool keeps
    // auto-ready off throughout). The role — and with it readiness — is decided once the KEY's table is found.
    await this._coord.setAutoReadyPref(id, false);
    const res = await this._coord.scanForKeyTable(id, { stake: g.stake, keyUid: g.keyUid, pace: () => this.pace(gen) });
    if (!res.ok) {
      if (!res.cancelled) this._event('SCAN_FAILED', { id, error: res.error });
      return res;
    }
    if (this._group !== g) return res; // the group was dissolved meanwhile
    const claim = this._claimRole(id);
    if (g.rid == null) {
      g.rid = Number(res.rid);
      this._coord.adoptTableRid(g.creatorId, g.rid);
      this._event('TABLE_FOUND', { id: g.creatorId, rid: g.rid, by: id });
      // the other browsers still scanning stop and join the số bàn that was just found
      for (const other of [...this._scanning]) {
        if (other === id) continue;
        this._coord.cancelSearch(other);
        this.joinTable(other, g.rid);
      }
    }
    this._seated(id, claim.role);
    this._event('JOINED', { id, rid: g.rid, role: claim.role });
    this._emit();
    await this._readyCheck(gen);
    return { ...res, role: claim.role };
  }
  // DỪNG — stop the DÒ KEY / TẠO this browser is running. Not queued: it must reach the search that holds the queue.
  cancelSearch(profileId) { return this._coord.cancelSearch(String(profileId)); }

  // T2 / T3 — join the group's table (role by join order), or any other số bàn with an empty code.
  joinTable(profileId, rid) {
    return this._enqueue('JOIN', (gen) => this._join(profileId, rid, gen));
  }
  async _join(profileId, rid, gen) {
    const id = String(profileId);
    const r = Number(rid);
    if (!Number.isFinite(r) || r <= 0) return { ok: false, error: { code: 'PHOM_INVALID_RID', message: 'Số bàn không hợp lệ' } };
    if (!this._coord.browserReady(id)) return { ok: false, error: { code: 'PHOM_NOT_IN_GAME', message: 'Acc chưa vào game' } };
    const g = this._group;
    const ours = !!g && Number(g.rid) === r;
    if (ours) {
      if (!await this.pace(gen)) return CANCELLED;
      await this._coord.setAutoReadyPref(id, false);
    }
    if (!await this.pace(gen)) return CANCELLED;
    // op 8; at the group's own table the KEY must be there, else it is not our table any more
    const res = await this._coord.joinTable(id, r, ours ? { expectUid: g.keyUid } : {});
    if (!res.ok) {
      this._event('JOIN_FAILED', { id, rid: r, error: res.error });
      if (ours && this._isMissingRoom(res)) await this._onTableLost(gen);
      return res;
    }
    const claim = ours && this._group === g ? this._claimRole(id) : null;
    if (claim) this._seated(id, claim.role);
    this._event('JOINED', { id, rid: r, role: claim ? claim.role : null });
    this._emit();
    if (claim) await this._readyCheck(gen);
    return { ...res, role: claim ? claim.role : null };
  }

  // T3 — ReJoin, the reference tool's toggle. ON: sit at the group's table now, and come back by itself every time the
  // server removes this browser (the NOT_READY account is kicked every ~10s for not being ready — capture 2026-10-02:
  // the reference tool rejoined it 9 times in a row). Pressed again while ON and seated → OFF; the seat is kept.
  rejoin(profileId) {
    const id = String(profileId);
    const g = this._group;
    if (g && g.rejoinOn.has(id) && this._atGroupTable(id)) {
      g.rejoinOn.delete(id);
      this._event('REJOIN_OFF', { id }); this._emit();
      return Promise.resolve({ ok: true, rejoinOn: false });
    }
    const rid = g ? g.rid : this._coord.lastRidOf(id);
    if (rid == null) return Promise.resolve({ ok: false, error: { code: 'PHOM_REJOIN_NO_RID', message: 'Chưa có số bàn để vào lại' } });
    return this.joinTable(id, rid).then((res) => {
      if (g && this._group === g) {
        if (res.ok) { g.rejoinOn.add(id); this._event('REJOIN_ON', { id, rid }); } else if (!res.cancelled) g.rejoinOn.delete(id);
        this._emit();
      }
      return { ...res, rejoinOn: !!(g && g.rejoinOn.has(id)) };
    });
  }

  // T5 — leave one browser's table. A READY / NOT_READY member frees its role; KEY keeps it. ReJoin goes off.
  leave(profileId) {
    const id = String(profileId);
    if (this._group) this._group.rejoinOn.delete(id);
    return this._enqueue('LEAVE', async (gen) => {
      if (!await this.pace(gen)) return CANCELLED;
      const res = await this._coord.leaveTable(id);
      const g = this._group;
      if (res.ok && g && g.roles.get(id) && g.roles.get(id) !== ROLE.KEY) { g.roles.delete(id); this._emit(); }
      return res;
    });
  }

  // T4 (manual) / A5 (auto) — BÀN KHÁC: the KEY browser runs DÒ KEY again for a new empty table. Manual: only the KEY
  // moves (the others press Tạo / Vào again). Auto: the whole group is re-formed at the new table.
  newTable() {
    const g = this._group;
    if (!g) return Promise.resolve({ ok: false, error: { code: 'PHOM_NO_GROUP', message: 'Chưa có bàn nào của nhóm' } });
    const { creatorId, stake } = g;
    return this._auto ? this._enqueue('REGROUP', (gen) => this._form(creatorId, stake, gen)) : this.findTable(creatorId, { stake });
  }

  // ---- A — the TỰ ĐỘNG checkbox ------------------------------------------------
  setAuto(on, { creatorId = null, stake = null } = {}) {
    if (!on) { // A6 — cancel what is queued; seats and group stay as they are; the ReJoins AUTO switched on go off
      this._auto = false; this._gen++; this._busy = null;
      const g = this._group;
      if (g) { for (const id of g.autoRejoin) g.rejoinOn.delete(id); g.autoRejoin.clear(); }
      this._event('AUTO_OFF', {});
      this._emit();
      return Promise.resolve({ ok: true, auto: false });
    }
    this._auto = true; this._emit();
    return this._enqueue('AUTO_ON', async (gen) => {
      const g = this._group;
      if (g) { // A2 — keep the group the user built: bring back whoever is not seated, add whoever has no role yet
        for (const id of this._orderedIds()) {
          if (this._cancelled(gen)) return CANCELLED;
          if (!this._coord.browserReady(id)) continue;
          if (this._atGroupTable(id)) continue;
          if (!g.roles.has(id) && g.roles.size >= 3) continue;
          // the KEY can only go back once the số bàn is known; anyone else looks for it (TẠO) or joins it (VÀO)
          const res = id === g.creatorId ? (g.rid != null ? await this._join(id, g.rid, gen) : null) : await this._scan(id, gen);
          if (res && res.cancelled) return CANCELLED;
        }
        this._autoRejoinMembers();
        return { ok: true, auto: true, rid: g.rid, roles: this._rolesObject() };
      }
      const st = Number(stake) > 0 ? Number(stake) : this._stake;
      if (!(Number(st) > 0)) { this._auto = false; this._emit(); return { ok: false, error: { code: 'PHOM_INVALID_STAKE', message: 'Chọn Tiền ở tool Phỏm trước khi bật Tự động' } }; }
      const creator = creatorId ? String(creatorId) : this._orderedIds().find((id) => this._coord.browserReady(id));
      if (!creator) { this._auto = false; this._emit(); return { ok: false, error: { code: 'PHOM_NOT_IN_GAME', message: 'Chưa có acc nào vào game' } }; }
      const res = await this._form(creator, Number(st), gen); // A1
      if (!res.ok && !res.cancelled) { this._auto = false; this._emit(); }
      return { ...res, auto: this._auto };
    });
  }

  // A1 — everyone leaves; the KEY browser runs DÒ KEY; the next one runs TẠO (finds the KEY's số bàn); the last one
  // joins that số bàn. One after another, never together.
  async _form(creatorId, stake, gen) {
    const ids = this._orderedIds().filter((id) => this._coord.browserReady(id));
    const creator = String(creatorId);
    const others = ids.filter((id) => id !== creator);
    for (const id of [creator, ...others]) {
      const left = await this._leaveIfSeated(id, gen);
      if (!left.ok) return left;
      if (this._cancelled(gen)) return CANCELLED;
    }
    const found = await this._find(creator, stake, gen);
    if (!found.ok) return found;
    for (const id of others) {
      if (this._cancelled(gen)) return CANCELLED;
      const res = await this._scan(id, gen);
      if (res && res.cancelled) return CANCELLED;
      if (!res.ok) return { ok: false, rid: this._group ? this._group.rid : null, found: true, error: res.error, roles: this._rolesObject() };
    }
    this._autoRejoinMembers();
    this._event('GROUP_FORMED', { rid: this._group.rid, roles: this._rolesObject() });
    this._emit();
    return { ok: true, rid: this._group.rid, found: true, roles: this._rolesObject() };
  }

  // A3 — a member the server removed. It comes back when TỰ ĐỘNG is on or its ReJoin is on — every time, like the
  // reference tool (the NOT_READY account is removed every ~10s by design, so a per-minute cap would strand it);
  // otherwise it is only reported (T6). The table being gone is what ends it (A4 / T7).
  _onKicked(profileId, message) {
    const g = this._group;
    const id = String(profileId);
    if (!g || !g.roles.has(id)) return;
    const now = this._now();
    const recent = (g.kicks.get(id) || []).filter((t) => now - t < 60000);
    recent.push(now); g.kicks.set(id, recent);
    const comeBack = this._auto || g.rejoinOn.has(id);
    this._event('KICKED', { id, rid: g.rid, message: message || null, auto: this._auto, rejoinOn: g.rejoinOn.has(id), kicksLastMinute: recent.length });
    this._emit();
    if (!comeBack || g.rid == null || g.rejoinPending.has(id)) return; // T6 — the user presses ReJoin
    g.rejoinPending.add(id);
    // FAST path: op 8 straight to the group's table ~0.5s after the kick, outside the queue and without pacing; the
    // auto-ready-off (363) follows every accepted join in the coordinator, so it is not sent twice.
    this._after(this._rejoinDelayMs, async () => {
      g.rejoinPending.delete(id);
      if (this._group !== g || this._atGroupTable(id)) return;
      if (!this._auto && !g.rejoinOn.has(id)) return; // switched off while it waited
      if (!this._coord.browserReady(id)) return;
      const res = await this._coord.joinTable(id, g.rid, { expectUid: g.keyUid });
      if (this._group !== g) return;
      if (!res.ok) {
        if (res.superseded || res.cancelled) return;
        this._event('JOIN_FAILED', { id, rid: g.rid, error: res.error });
        if (this._isMissingRoom(res)) this._enqueue('TABLE_LOST', (gen) => this._onTableLost(gen));
        return;
      }
      this._seated(id, g.roles.get(id));
      this._event('JOINED', { id, rid: g.rid, role: g.roles.get(id) || null, rejoin: true });
      this._emit();
      this._enqueue('READY', (gen) => this._readyCheck(gen));
    });
  }
  _after(ms, fn) {
    const t = setTimeout(() => { this._timers.delete(t); Promise.resolve().then(fn).catch(() => {}); }, ms);
    if (t && t.unref) t.unref();
    this._timers.add(t);
    return t;
  }
  _clearTimers() { for (const t of this._timers) clearTimeout(t); this._timers.clear(); }

  // THAY ACC — a browser of the group was replaced by another one (P4/P5 swapped in, or a new profile opened in that
  // slot). The procedure, one step at a time:
  //   1. the old browser is out: its role, ReJoin and pending rejoin go (main makes it LEAVE the table first when it
  //      is still open — a benched browser must not keep a seat at the group's table);
  //   2. the new browser takes the SAME role (SẴN SÀNG / CHƯA SẴN SÀNG, with its ReJoin);
  //   3. as soon as it is in the game (logged in, Phỏm socket up) it sits at the group's table — op 8 to the số bàn,
  //      or TẠO while the số bàn is not known yet; then the SẴN SÀNG check runs as after any join;
  //   4. the KEY replaced: its table has no owner any more — the group is dissolved; with TỰ ĐỘNG on the new browser
  //      forms a new group (Dò Key → Tạo → Vào) as soon as it is in the game.
  // It waits at most REPLACE_WAIT_MS for the new browser; the user can always press Tạo / Vào by hand.
  replaceMember(oldId, newId) {
    const g = this._group;
    const o = String(oldId), n = String(newId);
    if (!g || !g.roles.has(o)) return { ok: true, moved: false };
    const role = g.roles.get(o);
    if (role === ROLE.KEY) {
      const auto = this._auto, stake = g.stake;
      this.dropMember(o);
      if (auto) { this._auto = true; this._emit(); this._whenInGame(n, null, () => this._enqueue('REGROUP', (gen) => this._form(n, stake, gen))); }
      return { ok: true, moved: false, dissolved: true, reform: auto };
    }
    const hadRejoin = g.rejoinOn.has(o); // the user's ReJoin choice (or TỰ ĐỘNG's) moves with the seat
    g.roles.delete(o); g.rejoinOn.delete(o); g.kicks.delete(o);
    if (g.rejoinPending) g.rejoinPending.delete(o);
    if (g.autoRejoin && g.autoRejoin.delete(o)) g.autoRejoin.add(n);
    g.roles.set(n, role);
    if (hadRejoin) g.rejoinOn.add(n);
    this._event('MEMBER_REPLACED', { id: n, from: o, role, rid: g.rid });
    this._emit();
    this._whenInGame(n, g, () => this._enqueue('REPLACE_JOIN', async (gen) => {
      if (this._group !== g || !g.roles.has(n) || this._atGroupTable(n)) return CANCELLED;
      return g.rid != null ? this._join(n, g.rid, gen) : this._scan(n, gen);
    }));
    return { ok: true, moved: true, role };
  }
  // Run `fn` once browser `id` is in the game (polled, cheap: one boolean per tick); gives up after REPLACE_WAIT_MS or
  // when the group `g` is gone. g = null: no group needed (a re-form).
  _whenInGame(id, g, fn) {
    const deadline = this._now() + this._replaceWaitMs;
    const tick = () => {
      if (g && this._group !== g) return;
      if (this._coord.browserReady(id)) { fn(); return; }
      if (this._now() >= deadline) { this._event('REPLACE_TIMEOUT', { id }); return; }
      this._after(this._replacePollMs, tick);
    };
    tick();
  }

  // A4 / T7 — the table is gone. AUTO runs DÒ KEY again with the same KEY browser and re-forms the group; MANUAL
  // reports it.
  async _onTableLost(gen) {
    const g = this._group;
    if (!g || g.recreating) return;
    this._event('TABLE_LOST', { rid: g.rid, auto: this._auto });
    if (!this._auto) { this._group = null; this._emit(); return; }
    g.recreating = true; this._emit();
    const { creatorId, stake } = g;
    this._group = null;
    await this._form(creatorId, stake, gen);
  }

  // THOÁT BÀN TẤT CẢ — auto off, everyone leaves (paced), the group is dissolved.
  leaveAll() {
    this._clearTimers(); this._auto = false; this._gen++;
    return this._enqueue('LEAVE_ALL', async (gen) => {
      for (const id of this._orderedIds()) {
        if (this._cancelled(gen)) break;
        if (!this._coord.isSeated(id)) continue;
        if (!await this.pace(gen)) break;
        await this._coord.leaveTable(id);
      }
      this._group = null; this._event('GROUP_DISSOLVED', {});
      this._emit();
      return { ok: true };
    });
  }
  // THAY PROFILE — a browser left the session (its slot now runs another account). It loses its role; the KEY gone
  // means the group's table has no owner any more, so the group is dissolved (the others stay where they sit).
  dropMember(profileId) {
    const g = this._group;
    const id = String(profileId);
    if (!g || !g.roles.has(id)) return { ok: true, dropped: false };
    const wasKey = g.roles.get(id) === ROLE.KEY;
    if (wasKey) {
      this._auto = false; this._gen++; this._group = null;
      this._event('GROUP_DISSOLVED', { reason: 'KEY_REPLACED', id });
    } else {
      g.roles.delete(id); g.rejoinOn.delete(id); g.kicks.delete(id);
      if (g.rejoinPending) g.rejoinPending.delete(id);
      if (g.autoRejoin) g.autoRejoin.delete(id);
      this._event('MEMBER_REPLACED', { id, rid: g.rid });
    }
    this._emit();
    return { ok: true, dropped: true, wasKey };
  }
  // Drop the group without touching the browsers (session end / cluster closed).
  reset() { this._clearTimers(); this._auto = false; this._gen++; this._group = null; this._busy = null; this._emit(); }

  // ---- helpers ----------------------------------------------------------------
  _orderedIds() { return this._coord ? this._coord.profileIds() : []; }
  // The CHƯA SẴN SÀNG member is kicked every ~10s by design. It comes back by itself ONLY when the user asked for it:
  // its ReJoin button, or the TỰ ĐỘNG checkbox (user rule 2026-10-03) — with TỰ ĐỘNG on its ReJoin is switched on
  // here as it sits down, so the bar shows it; in manual mode a kick is only reported until ReJoin is pressed.
  _seated(id, role) {
    const g = this._group;
    if (g && this._auto && role === ROLE.NOT_READY && !g.rejoinOn.has(id)) { g.rejoinOn.add(id); g.autoRejoin.add(id); }
  }
  // AUTO does what the user would press by hand: after Dò Key → Tạo → Vào it switches ReJoin on for the members it
  // seated (READY / NOT_READY), so the bars show "ReJoin ●" exactly as a manual ReJoin would.
  _autoRejoinMembers() {
    const g = this._group;
    if (!g || !this._auto) return;
    for (const [id, role] of g.roles) {
      if (role === ROLE.KEY || !this._atGroupTable(id) || g.rejoinOn.has(id)) continue;
      g.rejoinOn.add(id); g.autoRejoin.add(id);
    }
    this._emit();
  }
  // Sitting at the group's table: at its số bàn, or — before the số bàn is known — the KEY at the table it found.
  _atGroupTable(id) {
    const g = this._group;
    if (!g || !this._coord || !this._coord.isSeated(String(id))) return false;
    if (g.rid == null) return String(id) === g.creatorId;
    return Number(this._coord.seatedRid(String(id))) === Number(g.rid);
  }
  _rolesObject() { return this._group ? Object.fromEntries(this._group.roles) : {}; }
  // Roles follow the ORDER OF OPERATION (the user's scenario): the account that sits down at the KEY's table first is
  // SẴN SÀNG, the next one CHƯA SẴN SÀNG (with ReJoin). Kept until the group is dissolved; a kicked member keeps its own.
  _claimRole(id) {
    const g = this._group;
    if (g.roles.has(id)) return { id, role: g.roles.get(id), claimed: false };
    const role = [...g.roles.values()].includes(ROLE.READY) ? ROLE.NOT_READY : ROLE.READY;
    g.roles.set(id, role);
    return { id, role, claimed: true };
  }
  // SẴN SÀNG presses ready — [5,"Simms",-1,{cmd:5}] — only once the CHƯA SẴN SÀNG member sits at the table too, and
  // again after every round. Why the wait (live run 2026-10-03 07:13): once every non-host player is ready, the server
  // kicks the host for not starting ~16s later; with the not-ready member seated the KEY never owes a start.
  async _readyCheck(gen) {
    const g = this._group;
    if (!g || this._coord.roundRunning()) return;
    const ids = [...g.roles.entries()];
    const ready = ids.find(([, role]) => role === ROLE.READY);
    const notReady = ids.find(([, role]) => role === ROLE.NOT_READY);
    if (!ready || !notReady) return;
    const [rid] = ready;
    if (!this._atGroupTable(rid) || !this._atGroupTable(notReady[0]) || this._coord.isReady(rid)) return;
    if (!await this.pace(gen) || this._group !== g || this._coord.isReady(rid) || this._coord.roundRunning()) return;
    const res = await this._coord.sendTableReady(rid);
    if (res && res.ok !== false) this._event('READY_SENT', { id: rid, rid: g.rid });
  }
  // The 4th player — not one of ours — pressed ready at the group's table: ring the tool window's bell (three times) so
  // the user readies the CHƯA SẴN SÀNG account by hand and the KEY starts the round. Once per player per round.
  _onStrangerReady(profileId, { uid, name } = {}) {
    const g = this._group;
    if (!g || !this._atGroupTable(String(profileId)) || uid == null || g.bellRung.has(uid)) return;
    g.bellRung.add(uid);
    const nr = [...g.roles.entries()].find(([, role]) => role === ROLE.NOT_READY);
    this._event('FOURTH_READY', { uid, name: name || null, rid: g.rid, notReadyId: nr ? nr[0] : null, keyId: g.creatorId });
  }
  _onRoundEnd() {
    const g = this._group;
    if (!g) return;
    g.bellRung.clear(); // a new round: the 4th player readies again
    this._enqueue('READY', (gen) => this._readyCheck(gen));
  }
  async _leaveIfSeated(id, gen) {
    if (!this._coord.isSeated(id)) return { ok: true };
    if (!await this.pace(gen)) return CANCELLED;
    const res = await this._coord.leaveTable(id);
    if (!res.ok) this._event('LEAVE_FAILED', { id, error: res.error });
    return res;
  }
  _isMissingRoom(res) { return Number(res?.error?.serverCode) === 102 || /phòng không tồn tại/i.test(res?.error?.message || ''); }
}

const CANCELLED = Object.freeze({ ok: false, cancelled: true, error: { code: 'PHOM_OPERATION_CANCELLED', message: 'Đã hủy' } });

function createTableGroup(deps) { return new TableGroup(deps); }

module.exports = { TableGroup, createTableGroup, ROLE, PACE_MIN_MS, PACE_MAX_MS };
