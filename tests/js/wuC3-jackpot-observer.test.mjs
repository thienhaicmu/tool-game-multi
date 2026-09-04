import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker, classifyFrame } = require('../../desktop/protocol/aviator.cjs');
const { JackpotObserver } = require('../../desktop/protocol/jackpot-observer.cjs');

const JP_FRAME = (jp, cmd = 100008, sid = 1) => `["6","MiniGame","aviatorPlugin",{"cmd":${cmd},"sid":${sid},"eI":{"jp":${jp}}}]`;

function makeObs() {
  const tracker = new RoundTracker({ ackWindowMs: 5000 });
  const obs = new JackpotObserver({ roundTracker: tracker });
  const recv = (raw) => tracker.observe({ direction: 'recv', targetId: 'T', url: 'wss://game.host/ws', raw });
  const send = (raw) => tracker.observe({ direction: 'send', targetId: 'T', url: 'wss://game.host/ws', raw });
  return { tracker, obs, recv, send };
}

// §53 — classifier surfaces eI.jp verbatim (no scaling).
test('classifyFrame extracts eI.jp verbatim as jp', () => {
  const cls = classifyFrame(JP_FRAME(67214618));
  assert.equal(cls.jp, 67214618);
  // frames without eI.jp do not carry jp
  assert.equal(classifyFrame('["5",{"cmd":100009,"sid":1,"odd":1.55}]').jp, undefined);
});

// §53 — observer extracts current jackpot from a recv frame, no scaling.
test('observer reads current jackpot from a recv frame (no scaling)', () => {
  const { obs, recv } = makeObs();
  recv(JP_FRAME(67214618));
  assert.equal(obs.current(), 67214618);
  const snap = obs.snapshot();
  assert.equal(snap.currentJackpot, 67214618);
  assert.equal(snap.jackpotSourceCmd, 100008);
});

// §54 — a client/send frame must NOT become authoritative jackpot.
test('a send-frame jackpot value is ignored (recv-only authority)', () => {
  const { obs, send } = makeObs();
  send(JP_FRAME(99999999));
  assert.equal(obs.current(), null);
});

// §55 — unknown before any evidence.
test('current jackpot is null before any authoritative evidence', () => {
  const { obs } = makeObs();
  assert.equal(obs.current(), null);
  assert.equal(obs.snapshot().currentJackpot, null);
});

// §9 — disconnect invalidates current jackpot.
test('disconnect invalidates the current jackpot to null', () => {
  const { obs, recv } = makeObs();
  recv(JP_FRAME(50000000));
  assert.equal(obs.current(), 50000000);
  obs.onDisconnect();
  assert.equal(obs.current(), null);
});

// §35 — same broadcast value stays independent per observer (no shared state).
test('per-run observers are independent even with the same value', () => {
  const A = makeObs();
  const B = makeObs();
  A.recv(JP_FRAME(67214618));
  assert.equal(A.obs.current(), 67214618);
  assert.equal(B.obs.current(), null, 'B unaffected by A');
  B.recv(JP_FRAME(48321901));
  assert.equal(A.obs.current(), 67214618, 'A unchanged by B');
  assert.equal(B.obs.current(), 48321901);
});

// Latest recv value wins; updates are observed live.
test('observer tracks the latest recv jackpot', () => {
  const { obs, recv } = makeObs();
  recv(JP_FRAME(40000000));
  recv(JP_FRAME(50000000));
  recv(JP_FRAME(67214618));
  assert.equal(obs.current(), 67214618);
});
