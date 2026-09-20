// PHASE 6.3.5 — FIND RESILIENCE V2 wiring (source-level, no GUI). The header JOIN_SHARED action routes to the
// bounded follower-retry path; the session manager delegates it; main only publishes a VALIDATED anchor; and
// the explicit V2 bounds/trace exist. No game-action / browser restart is added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const coord = read('desktop/protocol/phom/host-table-coordinator.cjs');
const mgr = read('desktop/protocol/phom/host-session-manager.cjs');
const main = read('desktop/phom-main.cjs');

test('explicit V2 bounds are defined (no scattered magic numbers)', () => {
  assert.match(coord, /const DISCOVER_FREE_SLOTS = 3;/);
  // §39 — the post-anchor requirement is derived (need − 1), so it follows the in-game browser count
  assert.match(coord, /const needAfter = Math\.max\(0, need - 1\);/);
  // §53 — the FIND loop re-rolls misfit tables, so its pass cap is high and the time budget is the real ceiling
  assert.match(coord, /const MAX_ANCHOR_RECOVERY = 40;/);
  assert.match(coord, /const REROLL_COOLDOWN_MS = 1500;/);
  assert.match(coord, /const MAX_SHARED_RID_JOIN_RETRIES = 2;/);
});

test('post-join capacity comes from authoritative ps[] occupancy, and a misfit table is re-rolled (§53)', () => {
  assert.match(coord, /const ts = rec\.ctx\.tableState\(\);/);
  assert.match(coord, /seatsPerTable - occupancy/);
  // §53 — a table without a seat for every other browser is LEFT (confirmed) and the stake joined again
  assert.match(coord, /if \(fitsAll === false && rerollUntilFit\)/);
  assert.match(coord, /F16_TABLE_REROLL/);
  assert.match(coord, /PHOM_NO_FITTING_TABLE/);
  assert.match(coord, /const fitsAll = freeAfter == null \? null : freeAfter >= needAfter;/);
  assert.match(coord, /const MIN_SEATS_TO_JOIN = 1;/);
  assert.equal(/F13_ANCHOR_INVALID/.test(coord), false);
  // invalid anchor: blacklist + leave + bounded re-FIND, never publish. The blacklist is scoped to THIS
  // discovery run (runFailedRids) — a coordinator-wide set was never cleared in the manual flow and
  // permanently hid every table that lost a race. §47 — only a FAILED JOIN blacklists a rid now.
  assert.match(coord, /runFailedRids\.add\(candidate\.rid\)/);
  assert.match(coord, /const runFailedRids = new Set\(\);/);
  assert.match(coord, /PHOM_FIND_RESILIENCE_EXHAUSTED/);
});

test('a discover anchor is provisional until validated; snapshot exposes anchorValid; main gates publishing', () => {
  assert.match(coord, /rec\._joinedRidValidated = !opts\.provisional;/);
  assert.match(coord, /provisional: true/);
  assert.match(coord, /rec\._joinedRidValidated = true;/); // set only after F12 capacity pass
  assert.match(coord, /anchorValid: rec\._joinedRidValidated !== false,/);
  // §38 — the published shared room comes from ONE place, and that place never publishes an unvalidated anchor
  assert.match(coord, /_holdsRoom\(rec\) \{ return !!\(rec && rec\.manualState === 'JOINED' && rec\._joinedRid != null && rec\._joinedRidValidated !== false\); \}/);
  assert.match(coord, /sharedRid\(\) \{ const a = this\._anchor\(\); return this\._holdsRoom\(a\)/);
  assert.match(main, /return phomSessions && phomSessions\.active\(\) \? phomSessions\.sharedRid\(\) : null;/);
});

test('follower JOIN is bounded + generation-safe + single-flight, with authoritative same-room proof', () => {
  assert.match(coord, /async manualJoinShared\(profileId, rid, opts = \{\}\)/);
  assert.match(coord, /rec\._followGen !== myGen/);           // generation cancellation
  assert.match(coord, /rec\._followInFlight && Number\(rec\._followRid\) === r/); // single-flight same rid
  assert.match(coord, /Number\(anchor\) !== r/);              // anchor moved → stop stale-RID retry
  assert.match(coord, /ts\.uids\.includes\(anchorUid\)/);      // same-room proof (P1 present)
  assert.match(coord, /attempt === maxRetries\) break;/);     // bounded
  // a follower NEVER discovers: manualJoinShared must not request a channel list or pick a candidate
  const region = coord.slice(coord.indexOf('async manualJoinShared('), coord.length);
  const fn = region.slice(0, region.indexOf('\n  markSocketClosed') > 0 ? region.indexOf('\n  markSocketClosed') : 4000);
  assert.equal(/buildChannelListFrame|_pickManualCandidate/.test(fn), false, 'a follower never discovers');
});

test('the session manager delegates manualJoinShared and main routes JOIN_SHARED to it', () => {
  assert.match(mgr, /manualJoinShared\(id, rid, opts\) \{ return this\._guarded\(\(c\) => c\.manualJoinShared\(String\(id\), rid, opts\)\); \}/);
  assert.match(main, /action === 'JOIN_SHARED'/);
  assert.match(main, /phomSessions\.manualJoinShared\(rid, joinRid, \{ maxRetries: 25 \}\)/);
});

test('V2 FIND trace milestones present (gated by PHOM_FIND_LOG)', () => {
  for (const m of ['F11_ANCHOR_CAPACITY_CHECK', 'F12_ANCHOR_VALID', 'F14_REANCHOR_START',
    'J0_FOLLOWER_JOIN_START', 'J3_UID_CONFIRMED', 'J4_SAME_ROOM_CONFIRMED', 'J5_RETRY', 'J6_RETRY_EXHAUSTED']) {
    assert.ok(coord.includes(m), `V2 trace ${m} present`);
  }
});
