// PHASE 6.3.2.3 — TÌM BÀN qualification: a table qualifies ONLY if it matches the selected stake, is a
// real table (uC <= Mu), and has >= 3 free seats so B1+B2+B3 can all JOIN. Pure module + coordinator wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const { qualifyTable, pickQualifiedCandidate, freeSlotsOf, describeNoTableReason, NO_TABLE_REASON_TEXT } = require('../../desktop/protocol/phom/table-qualify.cjs');

const T = (over = {}) => ({ rid: 700100, b: 100, Mu: 4, uC: 1, zn: null, gid: null, ...over });
const q = (over, opts = {}) => qualifyTable(T(over), { selectedStake: 100, need: 3, ...opts });

test('1. Mu=4,uC=1 → qualify (freeSlots=3)', () => { const r = q({ Mu: 4, uC: 1 }); assert.equal(r.ok, true); assert.equal(r.freeSlots, 3); });
test('2. Mu=4,uC=2 → reject NOT_ENOUGH_FREE_SLOTS (freeSlots=2)', () => { const r = q({ Mu: 4, uC: 2 }); assert.equal(r.ok, false); assert.equal(r.reason, 'NOT_ENOUGH_FREE_SLOTS'); assert.equal(r.freeSlots, 2); });
test('3. Mu=4,uC=3 → reject (freeSlots=1)', () => { assert.equal(q({ Mu: 4, uC: 3 }).ok, false); });
test('4. Mu=4,uC=4 → reject (freeSlots=0)', () => { assert.equal(q({ Mu: 4, uC: 4 }).ok, false); });
test('5. Mu=5,uC=2 → qualify (freeSlots=3)', () => { const r = q({ Mu: 5, uC: 2 }); assert.equal(r.ok, true); assert.equal(r.freeSlots, 3); });
test('6. Mu=5,uC=3 → reject (freeSlots=2)', () => { assert.equal(q({ Mu: 5, uC: 3 }).reason, 'NOT_ENOUGH_FREE_SLOTS'); });
test('7. missing Mu → reject MISSING_FIELDS', () => { assert.equal(q({ Mu: undefined }).reason, 'MISSING_FIELDS'); });
test('8. invalid uC → reject INVALID_COUNTS', () => { assert.equal(q({ uC: undefined }).reason, 'INVALID_COUNTS'); });
test('9. freeSlots exactly 3 → qualify', () => { assert.equal(q({ Mu: 6, uC: 3 }).ok, true); });
test('10. freeSlots exactly 2 → reject', () => { assert.equal(q({ Mu: 6, uC: 4 }).ok, false); });
test('11. selected stake mismatch → reject STAKE_MISMATCH', () => { assert.equal(q({ b: 500 }, { selectedStake: 100 }).reason, 'STAKE_MISMATCH'); });
test('12. missing selected stake → NO_STAKE (discovery maps to PHOM_NO_STAKE_SELECTED)', () => {
  assert.equal(qualifyTable(T(), { need: 3 }).reason, 'NO_STAKE');
  assert.match(read('desktop/protocol/phom/host-table-coordinator.cjs'), /PHOM_NO_STAKE_SELECTED/);
});
test('13. invalid/missing rid → reject INVALID_RID', () => { assert.equal(q({ rid: null }).reason, 'INVALID_RID'); });

test('stake BUCKET (uC >> Mu) is rejected as INVALID_STRUCTURE (not a real joinable table)', () => {
  assert.equal(q({ Mu: 4, uC: 250 }).reason, 'INVALID_STRUCTURE');
});
test('wrong zone / game are rejected', () => {
  assert.equal(qualifyTable(T({ zn: 9 }), { selectedStake: 100, zone: 1 }).reason, 'WRONG_ZONE');
  assert.equal(qualifyTable(T({ gid: 9 }), { selectedStake: 100, gid: 8 }).reason, 'WRONG_GAME');
});
test('a failed rid is skipped (FAILED_RID_SKIPPED)', () => {
  assert.equal(qualifyTable(T({ rid: 5 }), { selectedStake: 100, isFailedRid: (r) => r === 5 }).reason, 'FAILED_RID_SKIPPED');
});
test('freeSlotsOf returns null for non-numeric counts', () => { assert.equal(freeSlotsOf({ Mu: 'x', uC: 1 }), null); });

test('pickQualifiedCandidate prefers the EMPTIEST qualifying table and reports rejects with reasons', () => {
  const cands = [
    T({ rid: 1, uC: 2 }),            // freeSlots 2 → reject
    T({ rid: 2, uC: 1 }),            // freeSlots 3 → qualify
    T({ rid: 3, uC: 0 }),            // freeSlots 4 → qualify (emptiest)
    T({ rid: 4, b: 500, uC: 0 }),    // stake mismatch → reject
  ];
  const { candidate, qualifiedCount, rejects } = pickQualifiedCandidate(cands, { selectedStake: 100, need: 3 });
  assert.equal(candidate.rid, 3, 'emptiest qualifying table wins');
  assert.equal(qualifiedCount, 2);
  assert.ok(rejects.some((r) => r.rid === 1 && r.reason === 'NOT_ENOUGH_FREE_SLOTS' && r.freeSlots === 2));
  assert.ok(rejects.some((r) => r.rid === 4 && r.reason === 'STAKE_MISMATCH'));
});

test('coordinator uses the qualifier BEFORE join and logs NOT_ENOUGH_FREE_SLOTS rejects (§B5/§B6)', () => {
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  assert.match(coord, /pickQualifiedCandidate\(chans, \{/);
  assert.match(coord, /need, selectedStake, zone: ZONE, gid: GID, isFailedRid/);
  assert.match(coord, /_mark\('TABLE_REJECT', \{[^}]*reason: r\.reason/);
  // discovery still qualifies BEFORE manualJoinRoom (pick → then JOIN)
  assert.match(coord, /_pickManualCandidate\(rec, need, selectedStake, runFailedRids\)[\s\S]*?manualJoinRoom\(profileId, candidate\.rid/);
});

// Every diagnosis code FIND can produce must have a human explanation — that text is what the header's ⚠
// tooltip and the Tool's errText actually show, so a missing entry means the user sees no reason at all.
test('describeNoTableReason explains every diagnosis code and degrades safely', () => {
  for (const code of ['NO_TABLE_RECORDS', 'NO_MATCHING_STAKE', 'ONLY_STAKE_BUCKETS', 'NOT_ENOUGH_FREE_SLOTS', 'ALL_CANDIDATES_FAILED']) {
    const text = describeNoTableReason(code);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `${code} must have an explanation`);
    assert.equal(text, NO_TABLE_REASON_TEXT[code]);
    assert.doesNotMatch(text, /[A-Z]{3,}_/, `${code} must read as prose, not as a raw code`);
  }
  // total: an unknown / missing code never throws and never leaks the raw value
  for (const bad of [undefined, null, '', 'SOMETHING_NEW', 42]) {
    assert.equal(describeNoTableReason(bad), 'không có bàn nào đủ điều kiện');
  }
});

// The free-seat requirement is stated in ONE place; the message must not drift from the qualifier.
test('the NOT_ENOUGH_FREE_SLOTS explanation quotes the real DEFAULT_NEED', () => {
  const { DEFAULT_NEED } = require('../../desktop/protocol/phom/table-qualify.cjs');
  assert.match(describeNoTableReason('NOT_ENOUGH_FREE_SLOTS'), new RegExp(`${DEFAULT_NEED} ghế trống`));
});

// Every code _diagNoTable can return must be one describeNoTableReason knows about.
test('every _diagNoTable return value has an explanation', () => {
  const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
  const body = coord.slice(coord.indexOf('_diagNoTable(rec) {'), coord.indexOf('// REAL table discovery for ONE browser'));
  const codes = [...body.matchAll(/return '([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 4, 'sanity: the diagnosis branches were found');
  for (const c of codes) assert.ok(NO_TABLE_REASON_TEXT[c], `_diagNoTable can return ${c} with no explanation`);
});
