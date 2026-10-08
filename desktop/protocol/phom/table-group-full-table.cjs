'use strict';

// ---------------------------------------------------------------------------
// Table group — the full-table rules: SẴN SÀNG after CHƯA SS sits, a stranger readies / leaves, the 4th player, BẮT ĐẦU.
// Part of TableGroup (table-group.cjs) — its methods are mixed into that class: `this` is the group (this._group,
// this._coord, this._enqueue, this.pace, … live there).
// ---------------------------------------------------------------------------

const { ROLE, RESET_MAX_PER_MIN, SEAT_FREE_MAX_PER_MIN, SEAT_FREE_BACKOFF_MS, CANCELLED } = require('./table-group-constants.cjs');

class GroupFullTable {
  // SẴN SÀNG presses ready — [5,"Simms",-1,{cmd:5}] — only once the CHƯA SẴN SÀNG member sits at the table too, and
  // again after every round. Why the wait (live run 2026-10-03 07:13): once every non-host player is ready, the server
  // kicks the host for not starting ~16s later; with the not-ready member seated the KEY never owes a start.
  async _readyCheck(gen) {
    const g = this._group;
    if (!g || this._coord.roundRunning(this._group ? this._group.creatorId : undefined)) return;
    const ids = [...g.roles.entries()];
    const ready = ids.find(([, role]) => role === ROLE.READY);
    const notReady = ids.find(([, role]) => role === ROLE.NOT_READY);
    if (!ready || !notReady) return;
    const [rid] = ready;
    if (!this._atGroupTable(rid) || !this._atGroupTable(notReady[0]) || this._coord.isReady(rid)) return;
    if (!await this.pace(gen) || this._group !== g || this._coord.isReady(rid) || this._coord.roundRunning(this._group ? this._group.creatorId : undefined)) return;
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
  // FULL TABLE (user rule 2026-10-05): once the group's table has 4 players and no round runs, the CHƯA SẴN SÀNG
  // member readies; once everyone but the host is ready, the KEY (host) starts the round. Each step once per round
  // (reset at round end, or when the table is no longer full), paced like every other command.
  // Each decision not to act is written to the log once (FULL_WAIT + reason), so a coseat.jsonl shows why acc 3 did
  // not ready (live coseat (3) 2026-10-05 could not tell).
  _onSeats() {
    const g = this._group;
    if (!g || g.rid == null || !this._coord || g.recreating) return;
    const key = g.creatorId;
    if (this._coord.roundRunning(key)) return this._fullWait(g, 'ROUND_RUNNING');
    const nr = [...g.roles.entries()].find(([, role]) => role === ROLE.NOT_READY);
    const ss = [...g.roles.entries()].find(([, role]) => role === ROLE.READY);
    if (!this._atGroupTable(key) || typeof this._coord.tablePlayerCount !== 'function') return this._fullWait(g, 'KEY_NOT_SEATED');
    const players = this._coord.tablePlayerCount(key);
    // EDGES, not levels (2026-10-08): "the stranger LEFT" / "SẴN SÀNG LEFT" are things that HAPPEN — seen once, when a
    // stranger was there before and is gone now (SẴN SÀNG was seated and is not). Read as a state on every seat frame
    // they re-fired after each re-sit (the game's own auto-ready, a stale r:true) and CHƯA SS left + sat down without end.
    const strangerHere = typeof this._coord.strangerSeated === 'function' ? this._coord.strangerSeated(key) : true;
    const ssIn = !!(ss && this._atGroupTable(ss[0]));
    if (g.prevStrangerHere === true && !strangerHere) g.resetWanted = 'STRANGER_LEFT';
    if (g.prevSsIn === true && !ssIn) g.resetWanted = 'SS_LEFT';
    if ((g.resetWanted === 'STRANGER_LEFT' && strangerHere) || (g.resetWanted === 'SS_LEFT' && ssIn)) g.resetWanted = null; // undone meanwhile
    g.prevStrangerHere = strangerHere; g.prevSsIn = ssIn;
    if (players < 4) {
      g.fullReadySent = false; g.fullStartSent = false; g.startRetried = false;
      // user rule 2026-10-05: the stranger LEFT before the round → CHƯA SS goes back to "not ready" and waits for the
      // next one. The game has no un-ready command (its own JS, 2026-09-21) and a fresh seat is never ready, so it
      // leaves and sits down again at once. Also the server kicks the HOST ~15 s after everyone else is ready
      // ("Bạn thoát vì không bắt đầu", captures test-D 2026-09-21): a ready CHƯA SS left alone with the group would
      // cost the KEY its table. B1 (user 2026-10-06, choice b): the same when SẴN SÀNG is the one who left — CHƯA SS
      // goes back to not ready and the group waits for SẴN SÀNG to come back.
      // Once per departure (resetWanted is consumed here), and never more than RESET_MAX times a minute.
      if (g.resetWanted && nr && this._atGroupTable(nr[0]) && this._coord.isReady(nr[0])) {
        const why = g.resetWanted; g.resetWanted = null;
        if (this._budget('NOT_READY_RESET:' + nr[0], RESET_MAX_PER_MIN, 60000)) this._resetNotReady(g, nr[0], why);
      }
      // B2 (2026-10-06): a member who is not at the table while a seat is free (lost its seat to a stranger, or left)
      // comes back — when TỰ ĐỘNG or its ReJoin is on, like after a kick. A refused join waits SEAT_FREE_BACKOFF_MS
      // before the next try, and the tries are capped — a full / refusing table was asked again on every seat frame.
      const now = this._now();
      for (const [id, role] of g.roles) {
        if (role === ROLE.KEY || this._atGroupTable(id) || (g.resetPending && id === (nr && nr[0]))) continue;
        if (!(this._auto || g.rejoinOn.has(id)) || g.rejoinPending.has(id)) continue;
        if (g.seatFreeBlockUntil && (g.seatFreeBlockUntil.get(id) || 0) > now) continue;
        if (this._budget('SEAT_FREE:' + id, SEAT_FREE_MAX_PER_MIN, 60000)) this._rejoinSoon(g, id, 'SEAT_FREE');
      }
      return this._fullWait(g, 'PLAYERS_' + players);
    }
    // user rule 2026-10-05: KEY · SẴN SÀNG · CHƯA SẴN SÀNG waits — only once a STRANGER at the table is ready does the
    // CHƯA SẴN SÀNG account ready, after a random 1–2 s
    const strangerReady = typeof this._coord.strangerReady === 'function' ? this._coord.strangerReady(key) : true;
    // CHƯA SS NOT at the table while it is full (4 here, so without it): it lost its seat to a stranger (user 2026-10-06)
    // → the round goes on with our two accounts; the KEY starts once everyone seated is ready
    const nrOut = !!(nr && !this._atGroupTable(nr[0]));
    if (nrOut) this._fullWait(g, 'NOT_READY_ACC_LOST_SEAT');
    if (nr && !nrOut && !this._coord.isReady(nr[0])) {
      if (!strangerReady) return this._fullWait(g, 'STRANGER_NOT_READY');
      if (g.fullReadySent) return;
      g.fullReadySent = true;
      const delay = Math.round(this._fullReadyMin + this._random() * (this._fullReadyMax - this._fullReadyMin));
      this._log('FULL_READY_SCHEDULED', { id: nr[0], rid: g.rid, delayMs: delay });
      this._enqueue('READY', async (gen) => {
        await this._sleep(delay);
        if (this._cancelled(gen) || this._group !== g || this._coord.roundRunning(key) || this._coord.isReady(nr[0])) { g.fullReadySent = false; return CANCELLED; }
        // the stranger left during the 2–4 s: stay not ready
        if (this._coord.tablePlayerCount(key) < 4 || !this._coord.strangerReady(key)) { g.fullReadySent = false; this._log('FULL_READY_SKIPPED', { id: nr[0], reason: 'STRANGER_GONE' }); return CANCELLED; }
        if (!this._atGroupTable(nr[0])) { g.fullReadySent = false; this._log('FULL_READY_SKIPPED', { id: nr[0], reason: 'NOT_SEATED' }); return CANCELLED; } // kicked meanwhile: asks again when it sits
        const res = await this._coord.sendTableReady(nr[0]);
        if (res && res.ok !== false) this._event('FULL_READY', { id: nr[0], rid: g.rid, delayMs: delay });
        else { g.fullReadySent = false; this._log('FULL_READY_FAILED', { id: nr[0], error: res && res.error ? res.error.code : null }); }
        return res;
      });
      return; // the start waits for this ready to come back from the server
    }
    if (g.fullStartSent) return;
    if (!this._coord.isTableHost(key)) return this._fullWait(g, 'KEY_NOT_HOST');
    if (!this._coord.othersReady(key)) return this._fullWait(g, 'OTHERS_NOT_READY');
    g.fullStartSent = true;
    this._enqueue('START', async (gen) => {
      // never a round of our three alone: the stranger must still be there when the start goes out
      // the KEY starts AT ONCE once everyone else is ready (user 2026-10-06 "acc key bắt đầu luôn") — no pause before it
      if (this._cancelled(gen) || this._group !== g || this._coord.roundRunning(key) || !this._coord.othersReady(key) || this._coord.tablePlayerCount(key) < 4) { g.fullStartSent = false; return CANCELLED; }
      const res = await this._coord.sendTableStart(key);
      if (res && res.ok !== false) this._event('ROUND_START_SENT', { id: key, rid: g.rid });
      else {
        g.fullStartSent = false;
        this._log('ROUND_START_FAILED', { id: key, error: res && res.error ? res.error.code : null, retry: !g.startRetried });
        // B5 — one more try (the server kicks the host ~15 s after everyone else is ready); the conditions are checked again
        if (!g.startRetried) { g.startRetried = true; this._after(this._rejoinDelayMs, () => this._onSeats()); }
      }
      return res;
    });
  }
  // CHƯA SS back to "not ready": leave + sit down again at the group's table (queued and paced like every command).
  // reason STRANGER_LEFT: undone if a new stranger sat down meanwhile; SS_LEFT: undone if SẴN SÀNG is back.
  _resetNotReady(g, id, reason = 'STRANGER_LEFT') {
    if (g.resetPending) return;
    g.resetPending = true;
    this._event('NOT_READY_RESET', { id, rid: g.rid, reason });
    this._enqueue('UNREADY', async (gen) => {
      try {
        if (!await this.pace(gen) || this._group !== g || g.recreating || this._coord.roundRunning(g.creatorId)) return CANCELLED;
        if (!this._atGroupTable(id) || !this._coord.isReady(id)) return CANCELLED; // not seated / not ready any more: nothing to undo
        const ss = [...g.roles.entries()].find(([, role]) => role === ROLE.READY);
        const ssBack = !ss || this._atGroupTable(ss[0]);
        if (reason === 'STRANGER_LEFT' && this._coord.strangerSeated(g.creatorId) && ssBack) return CANCELLED; // a new stranger sat down meanwhile
        if (reason === 'SS_LEFT' && ssBack && this._coord.tablePlayerCount(g.creatorId) >= 4) return CANCELLED; // SẴN SÀNG is back, the table is full
        const lv = await this._coord.leaveTable(id);
        if (!lv || lv.ok === false) { this._log('NOT_READY_RESET_FAILED', { id, step: 'LEAVE', error: lv && lv.error ? lv.error.code : null }); return lv; }
        if (this._group !== g || this._cancelled(gen)) return CANCELLED;
        const res = await this._coord.joinTable(id, g.rid, { expectUid: g.keyUid });
        if (!res.ok) {
          this._event('JOIN_FAILED', { id, rid: g.rid, error: res.error });
          if (this._isMissingRoom(res)) this._enqueue('TABLE_LOST', (gen2) => this._onTableLost(gen2));
          return res;
        }
        this._seated(id, g.roles.get(id));
        this._event('JOINED', { id, rid: g.rid, role: g.roles.get(id) || null, reset: true });
        this._emit();
        this._onSeats();
        return res;
      } finally { g.resetPending = false; }
    });
  }
  // why the full-table step is waiting — logged once per change, never once per frame
  _fullWait(g, reason) {
    if (g.fullWaitReason === reason) return;
    g.fullWaitReason = reason;
    this._log('FULL_WAIT', { rid: g.rid, reason });
  }
  _onRoundEnd() {
    const g = this._group;
    if (!g) return;
    g.fullReadySent = false; g.fullStartSent = false; g.startRetried = false; // the next round asks again
    g.bellRung.clear(); // a new round: the 4th player readies again
    if (g.hostCheckAfterRound) { const why = g.hostCheckAfterRound; g.hostCheckAfterRound = null; this._checkHost(g, why); if (this._group !== g || g.recreating) return; } // B4 — the host changed during the round
    this._enqueue('READY', (gen) => this._readyCheck(gen));
  }
}

module.exports = { GroupFullTable };
