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
// ONE class in four files (3.2): this one = state, pacing, the serial queue and the helpers; table-group-manual.cjs =
// what the buttons do (T1–T5); table-group-auto.cjs = TỰ ĐỘNG (A, B4 regroup, THAY ACC); table-group-full-table.cjs =
// the full-table rules (SẴN SÀNG, the 4th player, BẮT ĐẦU — T8/B).
//
// It owns NO protocol: every server interaction is a coordinator primitive (findKeyTable / scanForKeyTable /
// joinTable / leaveTable / setAutoReadyPref / sendTableReady).
// ---------------------------------------------------------------------------

const EventEmitter = require('node:events');

const { ROLE, PACE_MIN_MS, PACE_MAX_MS, REJOIN_DELAY_MS, REPLACE_POLL_MS, REPLACE_WAIT_MS, CANCELLED } = require('./table-group-constants.cjs');
const { mixin } = require('./mixin.cjs');
// the group's other parts (same class, split by concern — 3.2)
const { GroupManual } = require('./table-group-manual.cjs');
const { GroupAuto } = require('./table-group-auto.cjs');
const { GroupFullTable } = require('./table-group-full-table.cjs');

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
    // after the KEY is kicked: how long to wait for the server's cmd 203 (the new host) before deciding (B4)
    this._hostCheckMs = deps.hostCheckMs != null ? Number(deps.hostCheckMs) : 1000;
    this._replacePollMs = deps.replacePollMs != null ? Number(deps.replacePollMs) : REPLACE_POLL_MS;
    // the CHƯA SẴN SÀNG account readies 1–2 s (random) after a stranger readied, then the KEY starts at once
    // (user rule 2026-10-05/06: 2–3 s → 1–3 s → 2–4 s → 1–2 s)
    this._fullReadyMin = deps.fullReadyMinMs != null ? Number(deps.fullReadyMinMs) : 1000;
    this._fullReadyMax = deps.fullReadyMaxMs != null ? Number(deps.fullReadyMaxMs) : 2000;
    this._replaceWaitMs = deps.replaceWaitMs != null ? Number(deps.replaceWaitMs) : REPLACE_WAIT_MS;
    this._timers = new Set(); // rejoin + replacement timers — all cleared by reset / leaveAll / auto off
    // ONE operation per account at a time (GĐ3): whatever asks — the bar, the tool window, a timer — a second request
    // for an account that is already doing something is refused with what it is doing.
    this._acting = new Map(); // id -> label
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
        this._coord.on('seats', () => this._onSeats());
        this._coord.on('hostChanged', (e = {}) => this._onHostChanged(e.id, e.uid));
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
  // A request from the USER (bar / tool button) — rule GĐ3: MANUAL clicks are independent per account (one account's
  // Dò Key never makes another account's Vào wait; each still waits its own pace and runs one thing at a time, see
  // _own). With TỰ ĐỘNG on everything is synchronised through the one serial queue.
  _run(label, op) {
    if (this._auto) return this._enqueue(label, op);
    const gen = this._gen;
    return Promise.resolve().then(() => op(gen)).catch((e) => ({ ok: false, error: { code: 'PHOM_GROUP_FAILED', message: String(e && e.message || e) } }));
  }
  _emit() { this.emit('update', this.snapshot()); }
  _event(name, data = {}) { this._log(name, data); this.emit('notice', { event: name, ...data }); }
  // LOOP GUARD (2026-10-08): every automatic leave / join the group makes on its own has a hard ceiling per window. The
  // full-table rules (3.1.23 NOT_READY_RESET, 3.1.24 SS_LEFT / SEAT_FREE / REGROUP) ran again on EVERY seat frame and
  // could leave + sit down without end — each table join reloads the game's table scene in that browser. Over the
  // ceiling the action is skipped and announced once (LOOP_GUARD) instead of repeated.
  _budget(key, max, windowMs) {
    const now = this._now();
    if (!this._budgets) this._budgets = new Map();
    const b = this._budgets.get(key) || { at: [], warned: false };
    b.at = b.at.filter((t) => now - t < windowMs);
    if (b.at.length >= max) {
      if (!b.warned) { b.warned = true; this._event('LOOP_GUARD', { what: key.split(':')[0], id: key.split(':')[1] || null, max, windowSec: Math.round(windowMs / 1000) }); }
      this._budgets.set(key, b);
      return false;
    }
    b.at.push(now); b.warned = false; this._budgets.set(key, b);
    return true;
  }

  // Drop the group without touching the browsers (session end / cluster closed).
  reset() { this._clearTimers(); this._auto = false; this._gen++; this._group = null; this._busy = null; this._emit(); }

  // ---- helpers ----------------------------------------------------------------
  // The PLAYING accounts (P1/P2/P3) — TỰ ĐỘNG only ever seats these; a reserve (P4/P5) acts only when the user asks.
  _orderedIds() { return this._coord ? (typeof this._coord.playingIds === 'function' ? this._coord.playingIds() : this._coord.profileIds()) : []; }
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
  async _leaveIfSeated(id, gen) {
    if (!this._coord.isSeated(id)) return { ok: true };
    if (!await this.pace(gen)) return CANCELLED;
    const res = await this._coord.leaveTable(id);
    if (!res.ok) this._event('LEAVE_FAILED', { id, error: res.error });
    return res;
  }
  _isMissingRoom(res) { return Number(res?.error?.serverCode) === 102 || /phòng không tồn tại/i.test(res?.error?.message || ''); }
}

mixin(TableGroup, GroupManual, GroupAuto, GroupFullTable);

function createTableGroup(deps) { return new TableGroup(deps); }

module.exports = { TableGroup, createTableGroup, ROLE, PACE_MIN_MS, PACE_MAX_MS };
