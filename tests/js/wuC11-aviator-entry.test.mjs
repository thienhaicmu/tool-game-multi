import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { AviatorEntryGate, ENTER_ENVELOPE } = require('../../desktop/protocol/aviator-entry.cjs');

const EXACT_ENTER = '["6","MiniGame","aviatorPlugin",{"cmd":100000}]';

// Build a gate over a real RoundTracker with an injectable send + socket context.
function makeGate({ ctx = { targetId: 'T', cdpSessionId: 'S', host: 'game.host', wirePrefix: '' }, timeoutMs = 10000 } = {}) {
  const tracker = new RoundTracker({ ackWindowMs: 5000 });
  const sends = [];
  const gate = new AviatorEntryGate({
    roundTracker: tracker,
    send: async (c, wire) => { sends.push({ ctx: c, wire }); return { ok: true }; },
    getContext: () => ctx,
    timeoutMs,
  });
  const serverRound = (cmd, sid = 10) => tracker.observe({ direction: 'recv', targetId: 'T', url: 'wss://game.host/ws', raw: `{"cmd":${cmd},"sid":${sid}}` });
  return { tracker, gate, sends, serverRound };
}

// 19. Already entered -> 0 enter sends, ready immediately.
test('already entered: ensureEntered sends no 100000 and returns ready', async () => {
  const { gate, sends, serverRound } = makeGate();
  serverRound(100005);                 // authoritative server ROUND_OPEN -> entered
  assert.equal(gate.isEntered(), true);
  const res = await gate.ensureEntered();
  assert.deepEqual(res, { ready: true, sent: 0, alreadyEntered: true });
  assert.equal(sends.length, 0);
  assert.equal(gate.enterSends(), 0);
});

// 20. Not entered, has socket -> sends EXACT enter, not ready until server evidence.
test('not entered: sends exact 100000 then becomes ready only on server round evidence', async () => {
  const { gate, sends, serverRound } = makeGate();
  const p = gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5)); // let the send dispatch
  assert.equal(sends.length, 1, 'exactly one enter request');
  assert.equal(sends[0].wire, EXACT_ENTER, 'exact observed payload');
  assert.equal(gate.isEntered(), false, 'not ready on send alone');
  assert.equal(gate.state(), 'ENTERING');
  serverRound(100005);                 // authoritative confirmation
  const res = await p;
  assert.equal(res.ready, true);
  assert.equal(gate.isEntered(), true);
});

test('enter payload carries the observed socket wire prefix', async () => {
  const { gate, sends } = makeGate({ ctx: { targetId: 'T', cdpSessionId: 'S', host: 'h', wirePrefix: '42' } });
  gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sends[0].wire, '42' + EXACT_ENTER);
  assert.equal(JSON.stringify(ENTER_ENVELOPE), EXACT_ENTER);
});

// 21. No socket -> no send, explicit unavailable result.
test('no owning socket: no send, no start, explicit AVIATOR_ENTRY_NO_SOCKET', async () => {
  const { gate, sends } = makeGate({ ctx: null });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'AVIATOR_ENTRY_NO_SOCKET');
  assert.equal(sends.length, 0);
  assert.equal(gate.isEntered(), false);
});

// 22 + 26. Confirmation is run-isolated: B evidence never releases A.
test('cross-run isolation: each gate resolves only on its OWN server evidence', async () => {
  const A = makeGate();
  const B = makeGate();
  const pa = A.gate.ensureEntered();
  const pb = B.gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(A.sends.length, 1);
  assert.equal(B.sends.length, 1);

  // Confirm B only.
  B.serverRound(100005);
  const rb = await pb;
  assert.equal(rb.ready, true);
  assert.equal(A.gate.isEntered(), false, 'A still waiting after B confirmation');

  // Now confirm A.
  A.serverRound(100008);
  const ra = await pa;
  assert.equal(ra.ready, true);
  assert.equal(A.gate.isEntered(), true);
});

// 23. Duplicate start -> single enter attempt, both callers share the resolution.
test('duplicate ensureEntered: at most one 100000, both resolve together', async () => {
  const { gate, sends, serverRound } = makeGate();
  const p1 = gate.ensureEntered();
  const p2 = gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sends.length, 1, 'no enter spam');
  serverRound(100005);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ready, true);
  assert.equal(r2.ready, true);
  assert.equal(gate.enterSends(), 1);
});

// 24. Timeout -> AVIATOR_ENTRY_TIMEOUT, never entered.
test('timeout: no server evidence -> AVIATOR_ENTRY_TIMEOUT, never entered', async () => {
  const { gate } = makeGate({ timeoutMs: 30 });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'AVIATOR_ENTRY_TIMEOUT');
  assert.equal(gate.isEntered(), false);
});

// 25. Disconnect invalidates entry readiness.
test('disconnect: entered state is invalidated and cannot be trusted afterwards', async () => {
  const { gate, serverRound } = makeGate();
  serverRound(100005);
  assert.equal(gate.isEntered(), true);
  gate.onDisconnect();
  assert.equal(gate.isEntered(), false, 'stale entered flag cleared on socket loss');
});

test('disconnect during a pending attempt rejects with AVIATOR_ENTRY_DISCONNECTED', async () => {
  const { gate } = makeGate({ timeoutMs: 10000 });
  const p = gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5));
  gate.onDisconnect();
  const res = await p;
  assert.equal(res.error.code, 'AVIATOR_ENTRY_DISCONNECTED');
});

// Passive discovery: entry becomes ready without any ensure call.
test('passive discovery: a server round frame marks entered with zero sends', async () => {
  const { gate, sends, serverRound } = makeGate();
  serverRound(100009); // ODD frame is also authoritative in-game evidence
  assert.equal(gate.isEntered(), true);
  assert.equal(sends.length, 0);
});

// A CLIENT-direction 100000 must NOT count as entry evidence.
test('a client-sent 100000 does not count as entry evidence', () => {
  const { tracker, gate } = makeGate();
  tracker.observe({ direction: 'send', targetId: 'T', raw: '["6","MiniGame","aviatorPlugin",{"cmd":100000}]' });
  assert.equal(gate.isEntered(), false);
});
