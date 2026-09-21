'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.2.3 — pure TÌM BÀN qualification. A candidate (a server CMD-300 rs[] row) qualifies for the
// shared-room flow ONLY if it is the right zone/game, matches the SELECTED stake, is a REAL table (uC <= Mu
// — a stake BUCKET has uC >> Mu), and has at least `need` FREE seats. `need` defaults to 3 so B1 + B2 + B3
// can all JOIN the same room (the finder A must not pick a table that only fits 1–2 browsers).
//
//   freeSlots = Mu - uC ;  QUALIFY ⇔ freeSlots >= need   (generic, never hard-coded to uC <= 1)
//
// Pure + reason-typed so discovery can (a) unit-test every case and (b) LOG exactly why a table was
// rejected (reason=NOT_ENOUGH_FREE_SLOTS …) without leaking secrets. No I/O, no protocol.
// ---------------------------------------------------------------------------

const DEFAULT_NEED = 3; // B1 + B2 + B3 share one room

// Free seats for a candidate, or null when the counts are missing/non-numeric.
function freeSlotsOf(c) {
  const Mu = Number(c && c.Mu);
  const uC = Number(c && c.uC);
  if (!Number.isFinite(Mu) || !Number.isFinite(uC)) return null;
  return Mu - uC;
}

// Qualify ONE candidate. Returns { ok, reason, freeSlots }. reason is null on success, else a stable code.
function qualifyTable(c, opts = {}) {
  const need = opts.need != null && Number.isFinite(Number(opts.need)) ? Number(opts.need) : DEFAULT_NEED;
  const wantStake = opts.selectedStake != null && Number.isFinite(Number(opts.selectedStake)) ? Number(opts.selectedStake) : null;
  if (!c || c.rid == null) return { ok: false, reason: 'INVALID_RID', freeSlots: null };
  if (c.b == null || c.Mu == null) return { ok: false, reason: 'MISSING_FIELDS', freeSlots: null };
  if (opts.zone != null && c.zn != null && c.zn !== opts.zone) return { ok: false, reason: 'WRONG_ZONE', freeSlots: null };
  if (opts.gid != null && c.gid != null && c.gid !== opts.gid) return { ok: false, reason: 'WRONG_GAME', freeSlots: null };
  if (wantStake == null) return { ok: false, reason: 'NO_STAKE', freeSlots: null };
  if (Number(c.b) !== wantStake) return { ok: false, reason: 'STAKE_MISMATCH', freeSlots: null };
  // A PASSWORD-PROTECTED room. In the CHANNEL LIST (rs[]) `hpwd` is a BOOLEAN flag — "this table needs a key" —
  // not the key itself (the key only ever appears as a STRING in that table's own TABLE_STATE, which a browser
  // sees solely once it is already inside). So the finder cannot possibly hold the key for a room it found in
  // the lobby: JOINing it with the empty public code earns "Sai mật khẩu phòng", the rid gets blacklisted and
  // the search re-rolls — a whole wasted pass per locked table. Skipping them up front is the only correct
  // reading of the flag. Locked rooms are what the reference tool's own "Tạo / Đổi Key" flow produces.
  if (c.hpwd === true) return { ok: false, reason: 'ROOM_LOCKED', freeSlots: freeSlotsOf(c) };
  const free = freeSlotsOf(c);
  if (free == null) return { ok: false, reason: 'INVALID_COUNTS', freeSlots: null };
  // A stake BUCKET reports uC >> Mu; a real table has uC <= Mu.
  if (!(Number(c.uC) <= Number(c.Mu))) return { ok: false, reason: 'INVALID_STRUCTURE', freeSlots: free };
  if (typeof opts.isFailedRid === 'function' && opts.isFailedRid(c.rid)) return { ok: false, reason: 'FAILED_RID_SKIPPED', freeSlots: free };
  if (free < need) return { ok: false, reason: 'NOT_ENOUGH_FREE_SLOTS', freeSlots: free };
  return { ok: true, reason: null, freeSlots: free };
}

// Qualify a LIST and pick the EMPTIEST qualifying table (most free seats first → lowest uC).
// Returns { candidate, qualifiedCount, rejects:[{rid,stake,uC,Mu,freeSlots,reason}] } (rejects for logging).
function pickQualifiedCandidate(candidates, opts = {}) {
  const ok = [];
  const rejects = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    const q = qualifyTable(c, opts);
    if (q.ok) ok.push(c);
    else rejects.push({ rid: c && c.rid, stake: c && c.b, uC: c && c.uC, Mu: c && c.Mu, freeSlots: q.freeSlots, reason: q.reason });
  }
  // §47 — MOST FREE SEATS first (not simply the lowest occupancy): the searching browser only needs one seat,
  // but the table that leaves the most room is the one where the whole group can still end up together. Ties
  // break on rid so the choice is deterministic.
  ok.sort((a, b) => ((freeSlotsOf(b) || 0) - (freeSlotsOf(a) || 0)) || (Number(a.rid) - Number(b.rid)));
  return { candidate: ok[0] || null, qualifiedCount: ok.length, rejects };
}

// Human-readable (Vietnamese) explanation for a "no table qualified" diagnosis code, so the FIND failure
// the user sees names the ACTUAL cause instead of only "không tìm thấy bàn". Pure: a total map with a safe
// fallback for an unknown code — never throws, never leaks a rid or any other server detail.
function reasonTexts(need) {
  return Object.freeze({
    NO_TABLE_RECORDS: 'máy chủ chưa trả về bàn nào (thử ⟳ tải lại web rồi vào lại game)',
    NO_MATCHING_STAKE: 'không có bàn nào ở mức cược này',
    ONLY_STAKE_BUCKETS: 'mức cược này mới chỉ có nhóm cược, chưa có bàn thật nào',
    NOT_ENOUGH_FREE_SLOTS: `có bàn ở mức cược này nhưng không bàn nào còn đủ ${need} ghế trống`,
    ALL_CANDIDATES_FAILED: 'mọi bàn tìm được đều vừa vào không thành công',
    ONLY_LOCKED_ROOMS: 'mức cược này chỉ còn bàn ĐẶT MẬT KHẨU — tool không có key nên không vào được',
  });
}
const NO_TABLE_REASON_TEXT = reasonTexts(DEFAULT_NEED);
// `need` = the seats this FIND actually required (fewer than 3 when fewer browsers are playing), so the message
// never claims "3 ghế" when the search only needed 2.
function describeNoTableReason(reason, { need } = {}) {
  const key = reason == null ? '' : String(reason);
  const n = need != null && Number.isFinite(Number(need)) ? Number(need) : DEFAULT_NEED;
  return reasonTexts(n)[key] || 'không có bàn nào đủ điều kiện';
}

module.exports = { qualifyTable, pickQualifiedCandidate, freeSlotsOf, describeNoTableReason, NO_TABLE_REASON_TEXT, DEFAULT_NEED };
