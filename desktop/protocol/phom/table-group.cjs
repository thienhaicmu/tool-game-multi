'use strict';

// ---------------------------------------------------------------------------
// TABLE GROUP — the ONE place that decides what the three browsers do at a table.
// It implements docs/phom-kich-ban.md literally; the test names carry the scenario ids (T1, T2, A1 … A6).
//
//   MANUAL (TỰ ĐỘNG off): the tool does exactly what the user pressed and NOTHING else. A kicked member is
//                         reported, never rejoined; a lost table is reported, never re-created.
//   AUTO   (TỰ ĐỘNG on):  form the group, rejoin a kicked member, re-create a lost table.
//
// Two rules hold everywhere:
//   · PACING — every command sent to the server waits a random 0.8–2.5s first (deps.pace).
//   · ONE AT A TIME — every operation runs through a serial queue, so two browsers never send together and a
//     new operation never interleaves with a running one. Turning TỰ ĐỘNG off (or leaving) cancels what is queued
//     via a generation token, exactly like the coordinator's own cancellation.
//
// It owns NO protocol: every server interaction is a coordinator primitive (createTable / manualJoinByCode /
// manualJoinRoom / leaveTable / setAutoReadyPref / sendTableReady).
// ---------------------------------------------------------------------------

const EventEmitter = require('node:events');

const ROLE = Object.freeze({ KEY: 'KEY', READY: 'READY', NOT_READY: 'NOT_READY' });
const PACE_MIN_MS = 800;
const PACE_MAX_MS = 2500;
const MAX_KICKS_PER_MINUTE = 5;

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
    this._group = null;   // { rid, key, stake, creatorId, roles: Map, kicks: Map, recreating }
    this._stake = null;   // THE mức cược, picked once in the Phỏm tool (the in-page bars reuse it, never their own)
    this._auto = false;
    this._gen = 0;        // cancellation token: bumped by setAuto(false), leaveAll, reset
    this._queue = Promise.resolve();
    this._busy = null;    // the label of the running operation (for the UI)
    if (this._coord) {
      this._coord.setRoomKeyResolver((rid) => (this._group && Number(this._group.rid) === Number(rid) ? this._group.key : ''));
      this._coord.on('kicked', ({ id, message } = {}) => this._onKicked(id, message));
    }
  }

  // ---- state for the surfaces -------------------------------------------------
  active() { return !!this._group; }
  // The session's stake: every TẠO (tool or in-page bar) creates at this stake.
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
  keyFor(rid) { return this._group && Number(this._group.rid) === Number(rid) ? this._group.key : ''; }
  snapshot() {
    const g = this._group;
    if (!g) return null;
    return {
      rid: g.rid, key: g.key, stake: g.stake, selectedStake: this._stake, auto: this._auto, busy: this._busy, recreating: g.recreating,
      hostUid: this._coord ? this._coord.tableHostUid() : null,
      members: [...g.roles.entries()].map(([id, role]) => ({
        id, role,
        seated: !!this._coord && Number(this._coord.seatedRid(id)) === Number(g.rid),
        ready: !!this._coord && this._coord.isReady(id),
        host: !!this._coord && this._coord.isTableHost(id),
        kicks: (g.kicks.get(id) || []).length,
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
  // T1 — this browser creates a keyed table and becomes KEY. Everything else stays where it is.
  createTable(profileId, { stake } = {}) {
    const s = Number(stake) > 0 ? Number(stake) : this._stake; // the bar sends none: it uses the tool's Tiền
    return this._enqueue('CREATE', (gen) => this._create(profileId, s, gen));
  }
  async _create(profileId, stake, gen) {
    const id = String(profileId);
    if (!this._coord.browserReady(id)) return { ok: false, error: { code: 'PHOM_NOT_IN_GAME', message: 'Acc chưa vào game' } };
    if (!(Number(stake) > 0)) return { ok: false, error: { code: 'PHOM_INVALID_STAKE', message: 'Chưa chọn Tiền — chọn mức cược ở tool Phỏm' } };
    const left = await this._leaveIfSeated(id, gen);
    if (!left.ok) return left;
    if (this._cancelled(gen)) return CANCELLED;
    if (!await this.pace(gen)) return CANCELLED;
    await this._coord.setAutoReadyPref(id, false); // KEY never auto-readies
    if (!await this.pace(gen)) return CANCELLED;
    const res = await this._coord.createTable(id, { stake: Number(stake), pace: () => this.pace(gen) });
    if (!res.ok) { this._event('CREATE_FAILED', { id, error: res.error }); return res; }
    this._group = { rid: Number(res.rid), key: String(res.roomKey), stake: Number(stake), creatorId: id, roles: new Map([[id, ROLE.KEY]]), kicks: new Map(), recreating: false };
    this._coord.setHost(id); this._coord.setFinder(id);
    this._event('GROUP_CREATED', { id, rid: this._group.rid });
    this._emit();
    return { ...res, role: ROLE.KEY, roles: { [id]: ROLE.KEY } };
  }

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
    const res = await this._coord.manualJoinByCode(id, r, ours ? g.key : null, {});
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

  // T3 — ReJoin: the group's table, else this browser's own last table.
  rejoin(profileId) {
    const g = this._group;
    const rid = g ? g.rid : this._coord.lastRidOf(profileId);
    if (rid == null) return Promise.resolve({ ok: false, error: { code: 'PHOM_REJOIN_NO_RID', message: 'Chưa có số bàn để vào lại' } });
    return this.joinTable(profileId, rid);
  }

  // T5 — leave one browser's table. A READY / NOT_READY member frees its role; KEY keeps it.
  leave(profileId) {
    return this._enqueue('LEAVE', async (gen) => {
      const id = String(profileId);
      if (!await this.pace(gen)) return CANCELLED;
      const res = await this._coord.leaveTable(id);
      const g = this._group;
      if (res.ok && g && g.roles.get(id) && g.roles.get(id) !== ROLE.KEY) { g.roles.delete(id); this._emit(); }
      return res;
    });
  }

  // T4 (manual) / A5 (auto) — a new key means a NEW table (the game has no key-change command). Manual: only the
  // KEY browser moves. Auto: the whole group is re-formed there.
  changeKey() {
    const g = this._group;
    if (!g) return Promise.resolve({ ok: false, error: { code: 'PHOM_NO_GROUP', message: 'Chưa có bàn nào của nhóm' } });
    const { creatorId, stake } = g;
    return this._auto ? this._enqueue('REGROUP', (gen) => this._form(creatorId, stake, gen)) : this.createTable(creatorId, { stake });
  }

  // ---- A — the TỰ ĐỘNG checkbox ------------------------------------------------
  setAuto(on, { creatorId = null, stake = null } = {}) {
    if (!on) { // A6 — cancel what is queued; seats and group stay as they are
      this._auto = false; this._gen++; this._busy = null;
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
          if (Number(this._coord.seatedRid(id)) === Number(g.rid)) continue;
          if (!g.roles.has(id) && g.roles.size >= 3) continue;
          const res = await this._join(id, g.rid, gen);
          if (res && res.cancelled) return CANCELLED;
        }
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

  // A1 — everyone leaves, the creator makes the keyed table, the others join it one after another.
  async _form(creatorId, stake, gen) {
    const ids = this._orderedIds().filter((id) => this._coord.browserReady(id));
    const creator = String(creatorId);
    const others = ids.filter((id) => id !== creator);
    for (const id of [creator, ...others]) {
      const left = await this._leaveIfSeated(id, gen);
      if (!left.ok) return left;
      if (this._cancelled(gen)) return CANCELLED;
    }
    const created = await this._create(creator, stake, gen);
    if (!created.ok) return created;
    for (const id of others) {
      if (this._cancelled(gen)) return CANCELLED;
      const res = await this._join(id, this._group.rid, gen);
      if (res && res.cancelled) return CANCELLED;
      if (!res.ok) return { ok: false, rid: this._group.rid, created: true, error: res.error, roles: this._rolesObject() };
    }
    this._event('GROUP_FORMED', { rid: this._group.rid, roles: this._rolesObject() });
    this._emit();
    return { ok: true, rid: this._group.rid, key: this._group.key, roomKey: this._group.key, created: true, roles: this._rolesObject() };
  }

  // A3 — a member the server removed. AUTO rejoins it (bounded); MANUAL only reports it (T6).
  _onKicked(profileId, message) {
    const g = this._group;
    const id = String(profileId);
    if (!g || !g.roles.has(id)) return;
    const now = this._now();
    const recent = (g.kicks.get(id) || []).filter((t) => now - t < 60000);
    recent.push(now); g.kicks.set(id, recent);
    this._event('KICKED', { id, rid: g.rid, message: message || null, auto: this._auto, kicksLastMinute: recent.length });
    this._emit();
    if (!this._auto) return;                       // T6 — the user presses ReJoin
    if (recent.length > MAX_KICKS_PER_MINUTE) { this._event('REJOIN_EXHAUSTED', { id, rid: g.rid }); return; }
    this._enqueue('REJOIN', async (gen) => {
      if (this._cancelled(gen) || !this._group || Number(this._coord.seatedRid(id)) === Number(this._group.rid)) return CANCELLED;
      return this._join(id, this._group.rid, gen);
    });
  }

  // A4 / T7 — the table is gone. AUTO re-creates it with the same stake and the same KEY browser; MANUAL reports it.
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

module.exports = { TableGroup, createTableGroup, ROLE, PACE_MIN_MS, PACE_MAX_MS, MAX_KICKS_PER_MINUTE };
