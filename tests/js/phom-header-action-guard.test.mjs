// PHASE 6.3.2.3 — single-flight + identity guard for header actions (VÀO GAME …). A click must not stack a
// second op, must not be attributed to a stale run/profile, and must not be processed twice (dup actionId).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const { evaluateHeaderAction } = require('../../desktop/protocol/phom/header-action-guard.cjs');

const base = { payload: { action: 'ENTER_GAME', runId: 'B1', profileId: 'prof-1', actionId: 'a1' }, boundRunId: 'B1', runProfileId: 'prof-1', busy: false, lastActionId: null };

test('a valid first click is accepted', () => {
  assert.deepEqual(evaluateHeaderAction(base), { ok: true });
});

test('19. duplicate VÀO GAME while one is running → DUPLICATE_ACTION (single-flight)', () => {
  const r = evaluateHeaderAction({ ...base, busy: true });
  assert.equal(r.ok, false); assert.equal(r.reason, 'DUPLICATE_ACTION'); assert.equal(r.code, 'PHOM_HEADER_BUSY');
});

test('20. stale actionId (re-delivered) → DUPLICATE_ACTION_ID', () => {
  const r = evaluateHeaderAction({ ...base, lastActionId: 'a1' });
  assert.equal(r.ok, false); assert.equal(r.reason, 'DUPLICATE_ACTION_ID');
});

test('21. stale runId (old header after reopen) → STALE_RUN', () => {
  const r = evaluateHeaderAction({ ...base, payload: { ...base.payload, runId: 'OLD' } });
  assert.equal(r.ok, false); assert.equal(r.reason, 'STALE_RUN');
});

test('22. stale profileId → STALE_PROFILE', () => {
  const r = evaluateHeaderAction({ ...base, payload: { ...base.payload, profileId: 'other' } });
  assert.equal(r.ok, false); assert.equal(r.reason, 'STALE_PROFILE');
});

test('identity is checked BEFORE busy (a stale click is labelled stale even mid-operation)', () => {
  const r = evaluateHeaderAction({ ...base, busy: true, payload: { ...base.payload, runId: 'OLD' } });
  assert.equal(r.reason, 'STALE_RUN');
});

test('missing payload identity does not false-reject (bound runId is authoritative)', () => {
  assert.deepEqual(evaluateHeaderAction({ payload: { action: 'ENTER_GAME' }, boundRunId: 'B1', runProfileId: 'prof-1' }), { ok: true });
});

// ---- router wiring (source-level) ----
const main = read('desktop/phom-main.cjs');

test('the router uses the pure guard, tracks last accepted actionId, and keeps the dead-session guard', () => {
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf('async function phomHeaderAction(') + 5200);
  assert.match(r, /evaluateHeaderAction\(\{ payload: payload \|\| \{\}, boundRunId: rid, runProfileId: runRec && runRec\.profileId, busy: !!headerActionBusy\[rid\], lastActionId: headerLastActionId\[rid\] \|\| null \}\)/);
  assert.match(r, /if \(!guard\.ok\)/);
  assert.match(r, /headerLastActionId\[rid\] = actionId/);
  assert.match(r, /if \(!runClientFor\(rid\)\)/);            // §26 closed browser → no CDP action
  assert.match(r, /PHOM_HEADER_NO_CLIENT/);
  assert.match(r, /finally \{ delete headerActionBusy\[rid\]/); // single-flight always released
});

test('reopen yields a FRESH run identity (new runId) → an old header click is rejected as stale', () => {
  // openProfile creates a brand-new run (fresh id) each open; profileId (stable) is carried, runId is not.
  assert.match(main, /const run = runManager\.createRun\(/);
  assert.match(main, /run\.profileId = udKey/);
});
