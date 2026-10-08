'use strict';

// ---------------------------------------------------------------------------
// Table coordinator — VÀO / RỜI / SẴN SÀNG / BẮT ĐẦU: one browser, one exact table; every wait proven by the server.
// Part of HostTableCoordinator (host-table-coordinator.cjs) — its methods are mixed into that class: `this` is the
// coordinator (this._rec, this._log, this._changed, … live there).
// ---------------------------------------------------------------------------

const { buildTableReadyFrame, buildAutoReadyPrefFrame, buildJoinTableFrame, buildLeaveFrame } = require('./phom-wire.cjs');
const { errMsg } = require('./coordinator-util.cjs');

// How long RỜI BÀN waits for the server to prove the browser is out of the table.
const LEAVE_CONFIRM_MS = 5000;
// After the server REFUSES a JOIN, how long to still wait for a seat (a second JOIN in flight can still seat us).
const JOIN_REJECT_GRACE_MS = 600;

class CoordinatorTableActions {
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
  // Is anyone who is NOT one of ours sitting at this browser's table? (a stranger leaving → CHƯA SS goes back to waiting)
  strangerSeated(profileId) {
    const r = this._rec(profileId); const ts = r && this._ownSeated(r) ? r.ctx.tableState() : null;
    if (!ts) return false;
    const ours = new Set([...this._profiles.values()].map((x) => x.ctx.uid()).filter(Boolean).map(String));
    return ts.seats.some((s) => s.uid && !ours.has(String(s.uid)));
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
}

module.exports = { CoordinatorTableActions, LEAVE_CONFIRM_MS, JOIN_REJECT_GRACE_MS };
