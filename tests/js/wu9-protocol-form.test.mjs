import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// protocol-form.js is a browser classic script (the project is type:module, so it
// can't be required as CJS). Load it into a fake window to exercise the pure logic.
const src = readFileSync(new URL('../../ui/protocol-form.js', import.meta.url), 'utf8');
const win = {};
new Function('window', src)(win);
const PF = win.ProtocolForm;

const CTX_OK = { envAllowed: true, hasSid: true };

// ---------------------------------------------------------------------------
// §3/§21 — BET: only Amount is a user field; tool builds the rest.
// ---------------------------------------------------------------------------
test('BET normal: only amount editable; payload is correct protocol', () => {
  const f = PF.fieldsFor('bet', 'normal');
  assert.equal(f.amount, true);
  assert.equal(f.staleSid, false);
  assert.equal(f.raw, false);
  const { payload } = PF.buildPayload({ command: 'bet', scenario: 'normal', amount: '5000', sid: 2986908, aid: 1, eid: 1 });
  assert.deepEqual(payload, { cmd: 100002, b: 5000, sid: 2986908, aid: 1, eid: 1 });
});

// ---------------------------------------------------------------------------
// §3/§9/§12/§21 — Cashout: no Amount field, no odd; no amount validation.
// ---------------------------------------------------------------------------
test('Cashout: no amount field, payload has no b/odd, no amount validation', () => {
  const f = PF.fieldsFor('cashout', 'normal');
  assert.equal(f.amount, false);
  assert.ok(f.note);
  const { payload } = PF.buildPayload({ command: 'cashout', scenario: 'normal', sid: 2986908, aid: 1, eid: 1 });
  assert.deepEqual(payload, { cmd: 100003, sid: 2986908, aid: 1, eid: 1 });
  assert.ok(!('b' in payload) && !('odd' in payload));
  const v = PF.validate({ command: 'cashout', scenario: 'normal', sid: 2986908, aid: 1, eid: 1 }, CTX_OK);
  assert.equal(v.canSend, true);
  assert.equal(v.level, 'info');
});

// ---------------------------------------------------------------------------
// §4/§6/§21 — Negative "Stale SID": override field appears; flagged as reject test.
// ---------------------------------------------------------------------------
test('Stale SID scenario: SID override field + reject expectation', () => {
  assert.equal(PF.fieldsFor('bet', 'stale').staleSid, true);
  const v = PF.validate({ command: 'bet', scenario: 'stale', amount: '5000', staleSid: 2986907 }, CTX_OK);
  assert.equal(v.canSend, true);
  assert.equal(v.negative, true);
  assert.equal(v.expect, 'reject');
  assert.equal(v.allowMismatch, true);
  const { payload } = PF.buildPayload({ command: 'bet', scenario: 'stale', amount: '5000', sid: 2986908, staleSid: 2986907, aid: 1, eid: 1 });
  assert.equal(payload.sid, 2986907, 'uses the override sid, not the context sid');
});

test('Stale SID with empty override is blocked', () => {
  const v = PF.validate({ command: 'bet', scenario: 'stale', amount: '5000', staleSid: null }, CTX_OK);
  assert.equal(v.canSend, false);
  assert.equal(v.level, 'block');
});

// ---------------------------------------------------------------------------
// §17/§18/§21 — Protocol lock: no SID => Send disabled.
// ---------------------------------------------------------------------------
test('No SID => Send disabled (protocol lock)', () => {
  const v = PF.validate({ command: 'bet', scenario: 'normal', amount: '5000', sid: null }, { envAllowed: true, hasSid: false });
  assert.equal(v.canSend, false);
  assert.equal(v.level, 'block');
});

test('SID ready + valid amount => Send enabled', () => {
  const v = PF.validate({ command: 'bet', scenario: 'normal', amount: '5000', sid: 100 }, CTX_OK);
  assert.equal(v.canSend, true);
  assert.equal(v.level, 'ok');
});

// ---------------------------------------------------------------------------
// §9 — BET amount must be > 0 (normal / duplicate).
// ---------------------------------------------------------------------------
test('BET amount <= 0 is blocked; invalid-amount scenario allows it as a reject test', () => {
  assert.equal(PF.validate({ command: 'bet', scenario: 'normal', amount: '0' }, CTX_OK).canSend, false);
  assert.equal(PF.validate({ command: 'bet', scenario: 'normal', amount: '' }, CTX_OK).canSend, false);
  const inv = PF.validate({ command: 'bet', scenario: 'amount', amount: '-1' }, CTX_OK);
  assert.equal(inv.canSend, true);
  assert.equal(inv.negative, true);
  assert.equal(inv.expect, 'reject');
});

test('Duplicate BET is a reject test needing a valid amount', () => {
  const v = PF.validate({ command: 'bet', scenario: 'duplicate', amount: '5000' }, CTX_OK);
  assert.equal(v.canSend, true);
  assert.equal(v.negative, true);
  assert.equal(v.expect, 'reject');
});

// ---------------------------------------------------------------------------
// §6/§8 — Manual payload: raw JSON, validated for cmd.
// ---------------------------------------------------------------------------
test('Manual payload: valid JSON with cmd passes; invalid is blocked', () => {
  assert.equal(PF.fieldsFor('bet', 'manual').raw, true);
  const ok = PF.validate({ scenario: 'manual', rawText: '{"cmd":100002,"b":1,"sid":5}' }, CTX_OK);
  assert.equal(ok.canSend, true);
  assert.equal(ok.negative, true);
  const built = PF.buildPayload({ scenario: 'manual', rawText: '{"cmd":100002,"b":1}' });
  assert.deepEqual(built.payload, { cmd: 100002, b: 1 });
  const bad = PF.validate({ scenario: 'manual', rawText: 'not json' }, CTX_OK);
  assert.equal(bad.canSend, false);
  assert.equal(bad.level, 'block');
  const noCmd = PF.validate({ scenario: 'manual', rawText: '{"b":1}' }, CTX_OK);
  assert.equal(noCmd.canSend, false);
});

// ---------------------------------------------------------------------------
// §3 — environment no longer blocks product control.
// ---------------------------------------------------------------------------
test('envAllowed false does not block when SID/config are ready', () => {
  const v = PF.validate({ command: 'bet', scenario: 'normal', amount: '5000' }, { envAllowed: false, hasSid: true });
  assert.equal(v.canSend, true);
  assert.equal(v.level, 'ok');
});

// ---------------------------------------------------------------------------
// §5 — AUTO fields default to 1 and are overridable.
// ---------------------------------------------------------------------------
test('aid/eid default to 1 and honor overrides', () => {
  const def = PF.buildPayload({ command: 'bet', scenario: 'normal', amount: '5000', sid: 100 }).payload;
  assert.equal(def.aid, 1); assert.equal(def.eid, 1);
  const ov = PF.buildPayload({ command: 'bet', scenario: 'normal', amount: '5000', sid: 100, aid: 3, eid: 7 }).payload;
  assert.equal(ov.aid, 3); assert.equal(ov.eid, 7);
});
