'use strict';

// ---------------------------------------------------------------------------
// Table group — TỰ ĐỘNG: form the group, a kicked member, the host changed (B4 regroup), THAY ACC, a lost table.
// Part of TableGroup (table-group.cjs) — its methods are mixed into that class: `this` is the group (this._group,
// this._coord, this._enqueue, this.pace, … live there).
// ---------------------------------------------------------------------------

const { ROLE, REPLACE_WAIT_MS, SEAT_FREE_BACKOFF_MS, REGROUP_MAX, REGROUP_WINDOW_MS, CANCELLED } = require('./table-group-constants.cjs');

class GroupAuto {
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
    const found = await this._find(creator, stake, gen, { force: true }); // TỰ ĐỘNG re-forms its own group
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
    // B4 (user 2026-10-06): the KEY lost the table ("Bạn thoát vì không bắt đầu" …). Who owns it now decides: the
    // server names the new host with a cmd 203 to the others — look a moment later (_checkHost)
    if (g.roles.get(id) === ROLE.KEY) { this._after(this._hostCheckMs, () => this._checkHost(g, 'KEY_KICKED')); return; }
    if (!comeBack || g.rid == null) return; // T6 — the user presses ReJoin
    // FAST path: op 8 straight to the group's table ~0.5s after the kick, outside the queue and without pacing; the
    // auto-ready-off (363) follows every accepted join in the coordinator, so it is not sent twice.
    this._rejoinSoon(g, id, 'KICK');
  }
  // Back to the group's table ~0.5 s from now (after a kick, or a member out while a seat is free — B2). One at a time
  // per account; never while the user is doing something with it.
  _rejoinSoon(g, id, why) {
    if (g.rejoinPending.has(id)) return;
    g.rejoinPending.add(id);
    this._after(this._rejoinDelayMs, async () => {
      g.rejoinPending.delete(id);
      if (this._group !== g || g.recreating || this._atGroupTable(id)) return;
      if (!this._auto && !g.rejoinOn.has(id)) return; // switched off while it waited
      if (!this._coord.browserReady(id)) return;
      if (this._acting.has(id)) return; // the user is doing something with this account right now — never overlap
      const res = await this._coord.joinTable(id, g.rid, { expectUid: g.keyUid });
      if (this._group !== g) return;
      if (!res.ok) {
        if (res.superseded || res.cancelled) return;
        if (why === 'SEAT_FREE') (g.seatFreeBlockUntil || (g.seatFreeBlockUntil = new Map())).set(id, this._now() + SEAT_FREE_BACKOFF_MS);
        this._event('JOIN_FAILED', { id, rid: g.rid, error: res.error, why });
        if (this._isMissingRoom(res)) this._enqueue('TABLE_LOST', (gen) => this._onTableLost(gen));
        return;
      }
      this._seated(id, g.roles.get(id));
      this._event('JOINED', { id, rid: g.rid, role: g.roles.get(id) || null, rejoin: true, why });
      this._emit();
      this._onSeats();
      this._enqueue('READY', (gen) => this._readyCheck(gen));
    });
  }
  // B4 — another player became the host of the group's table (the KEY left / was kicked). Between rounds: decide now;
  // during a round (the KEY dropped mid-game): once the round is over.
  _onHostChanged(profileId, uid) {
    const g = this._group;
    if (!g || g.rid == null || uid == null || !this._atGroupTable(String(profileId))) return;
    if (g.keyUid != null && String(uid) === String(g.keyUid)) return;
    if (this._coord.roundRunning(String(profileId))) { g.hostCheckAfterRound = 'HOST_CHANGED'; this._log('HOST_CHECK_AFTER_ROUND', { rid: g.rid }); return; }
    this._checkHost(g, 'HOST_CHANGED');
  }
  // B4 (user 2026-10-06, refined): the rule is "the table's host is ONE OF OUR accounts that are there".
  //  - the host is one of ours (the server handed it to SẴN SÀNG / CHƯA SS) → that account is the KEY now; the table
  //    is kept (nothing leaves);
  //  - the host is a stranger → the rule is broken: everyone of ours leaves the table. MANUAL stops there (the user
  //    presses Dò Key / Tạo / Vào); TỰ ĐỘNG searches again (Dò Key with the same KEY, Tạo, Vào);
  //  - none of ours is at the table any more → the table is gone for the group: MANUAL dissolves it, TỰ ĐỘNG searches again.
  _checkHost(g, reason) {
    if (this._group !== g || g.recreating || g.rid == null) return;
    if (this._coord.roundRunning(g.creatorId)) { g.hostCheckAfterRound = reason; return; }
    const here = this._orderedIds().filter((id) => this._atGroupTable(id));
    const host = here.find((id) => this._coord.isTableHost(id));
    if (host) { if (host !== g.creatorId) this._adoptKey(g, host, reason); return; }
    // TỰ ĐỘNG re-forms the group — a few times; a table whose host keeps being a stranger would otherwise make the
    // whole group leave and search forever. Over the ceiling TỰ ĐỘNG switches off and the MANUAL rule applies.
    if (this._auto) {
      if (this._budget('REGROUP', REGROUP_MAX, REGROUP_WINDOW_MS)) return this._regroup(reason);
      this.setAuto(false);
    }
    if (!here.length) { this._group = null; this._event('GROUP_DISSOLVED', { reason, rid: g.rid }); this._emit(); return; }
    return this._outAll(g, reason);
  }
  // The server made one of ours the host: it is the KEY now (the old KEY, out of the table, loses its role — pressing
  // ReJoin / Vào for it later takes the free SẴN SÀNG / CHƯA SS place).
  _adoptKey(g, id, reason) {
    const old = g.creatorId;
    if (!this._atGroupTable(old)) { g.roles.delete(old); g.rejoinOn.delete(old); }
    g.roles.set(id, ROLE.KEY);
    g.rejoinOn.delete(id);
    g.creatorId = id;
    const uid = typeof this._coord.uidOf === 'function' ? this._coord.uidOf(id) : null;
    if (uid != null) g.keyUid = String(uid);
    this._event('KEY_CHANGED', { id, from: old, rid: g.rid, reason });
    this._emit();
    this._onSeats();
  }
  // The host is not one of ours (MANUAL): everyone of ours at the group's table leaves; the group is dissolved.
  _outAll(g, reason) {
    g.recreating = true;
    this._clearTimers();
    this._event('RULE_BROKEN_OUT', { rid: g.rid, reason });
    this._emit();
    return this._enqueue('LEAVE_ALL', async (gen) => {
      for (const id of this._orderedIds()) {
        if (this._cancelled(gen)) break;
        if (!(g.rid != null && Number(this._coord.seatedRid(id)) === Number(g.rid))) continue;
        if (!await this.pace(gen)) break;
        await this._coord.leaveTable(id);
      }
      if (this._group === g) { this._group = null; this._event('GROUP_DISSOLVED', { reason, rid: g.rid }); this._emit(); }
      return { ok: true };
    });
  }
  // TỰ ĐỘNG: everyone leaves and the search starts again — Dò Key (same KEY), Tạo, Vào.
  _regroup(reason) {
    const g = this._group;
    if (!g || g.recreating) return;
    g.recreating = true;
    this._clearTimers();
    this._event('REGROUP', { rid: g.rid, reason, auto: this._auto });
    this._emit();
    return this._enqueue('REGROUP', async (gen) => {
      if (this._group !== g) return CANCELLED;
      const { creatorId, stake } = g;
      this._group = null; this._emit();
      return this._form(creatorId, stake, gen);
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
  // reports it (user 2026-10-06: manual stays manual — only what the user presses).
  async _onTableLost(gen) {
    const g = this._group;
    if (!g || g.recreating) return;
    this._event('TABLE_LOST', { rid: g.rid, auto: this._auto });
    if (!this._auto) { this._group = null; this._emit(); return; }
    g.recreating = true; this._clearTimers(); this._emit();
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
}

module.exports = { GroupAuto };
