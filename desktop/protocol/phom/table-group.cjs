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
    // { rid, key, stake, creatorId, keyUid, roles: Map, kicks: Map, rejoinOn: Set, recreating } — rid stays null from
    // DÒ KEY until a TẠO finds the KEY's table.
    this._group = null;
    this._stake = null;   // THE mức cược, picked once in the Phỏm tool (the in-page bars reuse it, never their own)
    this._auto = false;
    this._gen = 0;        // cancellation token: bumped by setAuto(false), leaveAll, reset
    this._queue = Promise.resolve();
    this._busy = null;    // the label of the running operation (for the UI)
    if (this._coord) {
      this._coord.on('kicked', ({ id, message } = {}) => this._onKicked(id, message));
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
    const left = await this._leaveIfSeated(id, gen);
    if (!left.ok) return left;
    if (this._cancelled(gen)) return CANCELLED;
    if (!await this.pace(gen)) return CANCELLED;
    await this._coord.setAutoReadyPref(id, false); // KEY never auto-readies
    const res = await this._coord.findKeyTable(id, { stake: Number(stake), pace: () => this.pace(gen) });
    if (!res.ok) { this._event('FIND_FAILED', { id, error: res.error }); return res; }
    this._group = { rid: null, stake: Number(stake), creatorId: id, keyUid: this._coord.uidOf(id), roles: new Map([[id, ROLE.KEY]]), kicks: new Map(), rejoinOn: new Set(), autoRejoin: new Set(), rejoinPending: new Set(), recreating: false };
    this._event('KEY_SEATED', { id, channel: res.channel });
    this._emit();
    return { ...res, role: ROLE.KEY, roles: { [id]: ROLE.KEY } };
  }

  // T2a — TẠO: a non-KEY browser looks for the KEY's table (313 + the U+200B probe) and sits down there. The rid it
  // lands on becomes the group's số bàn. Once the số bàn is known, TẠO is simply VÀO.
  scanTable(profileId) {
    return this._enqueue('SCAN', (gen) => this._scan(profileId, gen));
  }
  async _scan(profileId, gen) {
    const id = String(profileId);
    const g = this._group;
    if (!g || !g.keyUid) return { ok: false, error: { code: 'PHOM_NO_KEY', message: 'Chưa có acc KEY — bấm Dò Key ở một trình duyệt trước' } };
    if (g.rid != null) return this._join(id, g.rid, gen);
    if (id === g.creatorId) return { ok: false, error: { code: 'PHOM_KEY_CANNOT_SCAN', message: 'Đây là acc KEY — bấm Tạo ở trình duyệt khác' } };
    if (!this._coord.browserReady(id)) return { ok: false, error: { code: 'PHOM_NOT_IN_GAME', message: 'Acc chưa vào game' } };
    const claim = this._claimRole(id);
    const left = await this._leaveIfSeated(id, gen);
    if (!left.ok) return this._release(claim, left);
    if (!await this.pace(gen)) return this._release(claim, CANCELLED);
    await this._coord.setAutoReadyPref(id, claim.role === ROLE.READY);
    const res = await this._coord.scanForKeyTable(id, { stake: g.stake, keyUid: g.keyUid, pace: () => this.pace(gen) });
    if (!res.ok) {
      if (!res.cancelled) this._event('SCAN_FAILED', { id, error: res.error });
      return this._release(claim, res);
    }
    if (this._group !== g) return { ...res, role: claim.role }; // the group was dissolved meanwhile
    g.rid = Number(res.rid);
    this._coord.adoptTableRid(g.creatorId, g.rid);
    this._event('TABLE_FOUND', { id: g.creatorId, rid: g.rid, by: id });
    if (claim.role === ROLE.READY) {
      if (await this.pace(gen)) await this._coord.sendTableReady(id, g.rid);
    }
    this._event('JOINED', { id, rid: g.rid, role: claim.role });
    this._emit();
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
    const claim = ours ? this._claimRole(id) : null;
    if (ours) {
      if (!await this.pace(gen)) return this._release(claim, CANCELLED);
      await this._coord.setAutoReadyPref(id, claim.role === ROLE.READY);
    }
    if (!await this.pace(gen)) return this._release(claim, CANCELLED);
    // op 8; at the group's own table the KEY must be there, else it is not our table any more
    const res = await this._coord.joinTable(id, r, ours ? { expectUid: g.keyUid } : {});
    if (!res.ok) {
      this._event('JOIN_FAILED', { id, rid: r, error: res.error });
      if (ours && this._isMissingRoom(res)) await this._onTableLost(gen);
      return this._release(claim, res);
    }
    if (ours && claim.role === ROLE.READY) {
      if (!await this.pace(gen)) return { ...res, role: claim.role };
      await this._coord.sendTableReady(id, r);
    }
    this._event('JOINED', { id, rid: r, role: claim ? claim.role : null });
    this._emit();
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
    this._enqueue('REJOIN', async (gen) => {
      g.rejoinPending.delete(id);
      if (this._group !== g || this._atGroupTable(id)) return CANCELLED;
      if (!this._auto && !g.rejoinOn.has(id)) return CANCELLED;  // switched off while it waited
      return this._join(id, g.rid, gen);
    });
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
    this._auto = false; this._gen++;
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
  // Drop the group without touching the browsers (session end / cluster closed).
  reset() { this._auto = false; this._gen++; this._group = null; this._busy = null; this._emit(); }

  // ---- helpers ----------------------------------------------------------------
  _orderedIds() { return this._coord ? this._coord.profileIds() : []; }
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
  _claimRole(id) {
    const g = this._group;
    if (g.roles.has(id)) return { id, role: g.roles.get(id), claimed: false };
    const role = [...g.roles.values()].includes(ROLE.READY) ? ROLE.NOT_READY : ROLE.READY;
    g.roles.set(id, role);
    return { id, role, claimed: true };
  }
  _release(claim, res) {
    if (claim && claim.claimed && this._group) this._group.roles.delete(claim.id);
    return res;
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
