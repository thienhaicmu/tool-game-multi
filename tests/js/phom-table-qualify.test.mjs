// PHASE 6.3.2.3 — TÌM BÀN qualification: a table qualifies ONLY if it matches the selected stake, is a
// real table (uC <= Mu), and has >= 3 free seats so B1+B2+B3 can all JOIN. Pure module + coordinator wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const { qualifyTable, pickQualifiedCandidate, freeSlotsOf } = require('../../desktop/protocol/phom/table-qualify.cjs');

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
  assert.match(coord, /_pickManualCandidate\(rec, need, selectedStake\)[\s\S]*?manualJoinRoom\(profileId, candidate\.rid/);
});
