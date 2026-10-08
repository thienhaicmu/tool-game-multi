'use strict';

// ---------------------------------------------------------------------------
// Table group — what the buttons do: DÒ KEY, TẠO, VÀO, ReJoin, RỜI, BÀN KHÁC (scenarios T1–T5).
// Part of TableGroup (table-group.cjs) — its methods are mixed into that class: `this` is the group (this._group,
// this._coord, this._enqueue, this.pace, … live there).
// ---------------------------------------------------------------------------

const { ROLE, ACT_WORD, CANCELLED } = require('./table-group-constants.cjs');

class GroupManual {
  // ---- T1 / A1 building blocks ------------------------------------------------
  // T1 — DÒ KEY: this browser sits ALONE at an empty public table of the stake and becomes KEY. The table's số bàn
  // is not known yet (the server never says it to the KEY); T2a finds it.
  findTable(profileId, { stake, force = false } = {}) {
    const s = Number(stake) > 0 ? Number(stake) : this._stake; // the bar sends none: it uses the tool's Tiền
    return this._own(profileId, 'FIND', () => this._run('FIND', (gen) => this._find(profileId, s, gen, { force })));
  }
  // Run a request for ONE account unless that account is already busy (GĐ3 — no overlapping operations per account).
  _own(profileId, label, run) {
    const id = String(profileId);
    const cur = this._acting.get(id);
    if (cur) return Promise.resolve({ ok: false, busy: true, error: { code: 'PHOM_ACC_BUSY', message: `Acc này đang ${ACT_WORD[cur] || cur} — đợi xong hoặc bấm Dừng` } });
    this._acting.set(id, label); this._emit();
    return Promise.resolve().then(run).finally(() => { if (this._acting.get(id) === label) this._acting.delete(id); this._emit(); });
  }
  actingOf(id) { return this._acting.get(String(id)) || null; }
  async _find(profileId, stake, gen, { force = false } = {}) {
    const id = String(profileId);
    if (!this._coord.browserReady(id)) return { ok: false, error: { code: 'PHOM_NOT_IN_GAME', message: 'Acc chưa vào game' } };
    if (!(Number(stake) > 0)) return { ok: false, error: { code: 'PHOM_INVALID_STAKE', message: 'Chưa chọn Tiền — chọn mức cược ở tool Phỏm' } };
    // ONE KEY per group: a second Dò Key would split the accounts over two tables (live run 2026-10-03: B1 and B2 both
    // pressed it and never met). The others join the KEY with Tạo / Vào.
    const cur = this._group;
    if (cur && cur.creatorId !== id && this._atGroupTable(cur.creatorId)) {
      return { ok: false, error: { code: 'PHOM_KEY_EXISTS', message: `Đã có acc KEY (P${this._orderedIds().indexOf(cur.creatorId) + 1}) đang ngồi — ở acc này bấm Tạo${cur.rid != null ? ' hoặc Vào' : ''}, không bấm Dò Key` } };
    }
    // Rule D2 — a group whose members still SIT at its table is never replaced silently: the user confirms (Dò Key
    // again within 5s). A group nobody sits at any more (played, everyone out — live 2026-10-05: P1 Dò Key → round →
    // out → P2 Dò Key asked to confirm) is simply replaced.
    const stillSeated = cur ? [...cur.roles.keys()].filter((m) => m !== id && this._atGroupTable(m)) : [];
    if (cur && !force && stillSeated.length) {
      return { ok: false, needsConfirm: true, error: { code: 'PHOM_GROUP_EXISTS', message: `Nhóm cũ${cur.rid != null ? ' (SS ' + cur.rid + ')' : ''} còn ${stillSeated.length} acc đang ngồi — bấm Dò Key lần nữa trong 5 giây để huỷ nhóm cũ và lập nhóm mới` } };
    }
    const left = await this._leaveIfSeated(id, gen);
    if (!left.ok) return left;
    if (this._cancelled(gen)) return CANCELLED;
    if (!await this.pace(gen)) return CANCELLED;
    await this._coord.setAutoReadyPref(id, false); // KEY never auto-readies
    const res = await this._coord.findKeyTable(id, { stake: Number(stake), pace: () => this.pace(gen) });
    if (!res.ok) { this._event('FIND_FAILED', { id, error: res.error }); return res; }
    this._group = { rid: null, stake: Number(stake), creatorId: id, keyUid: this._coord.uidOf(id), keySeatedAt: this._now(), roles: new Map([[id, ROLE.KEY]]), kicks: new Map(), rejoinOn: new Set(), autoRejoin: new Set(), rejoinPending: new Set(), bellRung: new Set(), recreating: false };
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
    return this._own(id, 'SCAN', () => {
      this._scanning.add(id); this._emit();
      return this._scan(id, this._gen).finally(() => { this._scanning.delete(id); this._emit(); });
    });
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
    // keySeatedAt is read LIVE: the KEY may be kicked and Dò Key again while this search runs (a new group, same KEY)
    const res = await this._coord.scanForKeyTable(id, { stake: g.stake, keyUid: g.keyUid, keySeatedAt: () => (this._group && this._group.keyUid === g.keyUid ? this._group.keySeatedAt : g.keySeatedAt), pace: () => this.pace(gen) });
    if (!res.ok) {
      if (!res.cancelled) this._event('SCAN_FAILED', { id, error: res.error });
      return res;
    }
    // the group the KEY formed again meanwhile (same KEY) is the one this browser joins; another KEY → nothing to claim
    const cur = this._group;
    if (cur !== g && !(cur && cur.keyUid === g.keyUid && cur.rid == null)) return res;
    return this._scanFoundIn(cur, id, res, gen);
  }
  async _scanFoundIn(g, id, res, gen) {
    const claim = this._claimRole(id);
    if (g.rid == null) {
      g.rid = Number(res.rid);
      this._coord.adoptTableRid(g.creatorId, g.rid);
      this._event('TABLE_FOUND', { id: g.creatorId, rid: g.rid, by: id });
      // the other browsers still scanning stop and join the số bàn that was just found
      for (const other of [...this._scanning]) {
        if (other === id) continue;
        this._coord.cancelSearch(other);
        this._enqueue('JOIN', (gen2) => this._join(other, g.rid, gen2)); // its own TẠO turns into VÀO (not a 2nd request)
      }
    }
    this._seated(id, claim.role);
    this._event('JOINED', { id, rid: g.rid, role: claim.role });
    this._emit();
    // the seat frames arrived BEFORE this join was confirmed (they could not count it as seated): look at the full table again
    this._onSeats();
    await this._readyCheck(gen);
    return { ...res, role: claim.role };
  }
  // DỪNG — stop the DÒ KEY / TẠO this browser is running. Not queued: it must reach the search that holds the queue.
  cancelSearch(profileId) { return this._coord.cancelSearch(String(profileId)); }

  // T2 / T3 — join the group's table (role by join order), or any other số bàn with an empty code.
  joinTable(profileId, rid) {
    return this._own(profileId, 'JOIN', () => this._run('JOIN', (gen) => this._join(profileId, rid, gen)));
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
    if (claim) this._onSeats();
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
    return this._own(id, 'REJOIN', () => this._run('JOIN', (gen) => this._join(id, rid, gen))).then((res) => {
      if (res && res.busy) return res;
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
    // THOÁT is never refused for a busy account: it is also the way out of a long Dò Key / Tạo
    return this._run('LEAVE', async (gen) => {
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
    return this._auto ? this._enqueue('REGROUP', (gen) => this._form(creatorId, stake, gen)) : this.findTable(creatorId, { stake, force: true }); // BÀN KHÁC = the user's own choice to move the group
  }
}

module.exports = { GroupManual };
