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
  ok.sort((a, b) => (Number(a.uC) || 0) - (Number(b.uC) || 0));
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
