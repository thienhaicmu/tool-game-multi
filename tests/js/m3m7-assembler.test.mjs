import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundAssembler, COMPLETENESS, CAUSE } = require('../../desktop/analytics/round-assembler.cjs');

const OPEN = 100005, LOCK = 100006, END = 100007, SNAP = 100008, ODD = 100009;
let rawId = 0;
function recv(cmd, fields = {}) { return { direction: 'RECV', cmd, rawEventId: ++rawId, timestampMs: fields.at, ...fields }; }
function mk() { return new RoundAssembler({ browserId: 'B-0001', captureSessionId: 1 }); }

// §29.18
test('OPEN→LOCK→ODD→END = one COMPLETE round', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));
  a.observe(recv(LOCK, { sid: 1, at: 100 }));
  a.observe(recv(ODD, { sid: 1, odd: 1.5, at: 200 }));
  a.observe(recv(ODD, { sid: 1, odd: 3.2, at: 300 }));
  a.observe(recv(END, { sid: 1, odd: 3.2, at: 400 }));
  const rounds = a.finalizedRounds();
  assert.equal(rounds.length, 1);
  const r = rounds[0];
  assert.equal(r.completeness, COMPLETENESS.COMPLETE);
  assert.equal(r.sid, 1);
  assert.equal(r.openedAtMs, 0); assert.equal(r.lockedAtMs, 100); assert.equal(r.endedAtMs, 400); assert.equal(r.durationMs, 400);
  assert.equal(r.maxOdd, 3.2);
});

// §29.19 / §29.20
test('duplicate OPEN same SID does not create a second normalized round', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 7, at: 0 }));
  a.observe(recv(OPEN, { sid: 7, at: 5 }));   // duplicate transport evidence
  a.observe(recv(END, { sid: 7, at: 50 }));
  assert.equal(a.finalizedRounds().length, 1);
});

// §29.21
test('new SID creates a new round; previous (no END) becomes PARTIAL_END', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));
  a.observe(recv(ODD, { sid: 1, odd: 1.3, at: 50 }));
  a.observe(recv(OPEN, { sid: 2, at: 100 }));   // new round, old superseded
  const finals = a.finalizedRounds();
  assert.equal(finals.length, 1);
  assert.equal(finals[0].sid, 1);
  assert.equal(finals[0].completeness, COMPLETENESS.PARTIAL_END);
  assert.equal(a.current().sid, 2);
});

// §29.22
test('stale old-SID ODD cannot mutate the current different-SID round', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 2, at: 0 }));
  a.observe(recv(ODD, { sid: 2, odd: 1.5, at: 50 }));
  a.observe(recv(ODD, { sid: 1, odd: 99, at: 60 }));   // stale frame for old SID 1
  assert.equal(a.current().maxOdd, 1.5);
  assert.equal(a.current().oddSampleCount, 1);
});

// §29.23
test('start mid-round (SNAPSHOT then ODD then END) = PARTIAL_START', () => {
  const a = mk();
  a.observe(recv(SNAP, { sid: 5, at: 0 }));
  a.observe(recv(ODD, { sid: 5, odd: 1.8, at: 50 }));
  a.observe(recv(END, { sid: 5, odd: 1.8, at: 100 }));
  const r = a.finalizedRounds()[0];
  assert.equal(r.completeness, COMPLETENESS.PARTIAL_START);
  assert.equal(r.openedAtMs, null, 'no fabricated open time');
});

test('ODD before any OPEN creates an anonymous partial round (evidence preserved)', () => {
  const a = mk();
  a.observe(recv(ODD, { odd: 2.0, at: 10 }));
  assert.equal(a.current().capturedFromStart, false);
  assert.equal(a.current().oddSampleCount, 1);
});

// §29.24 / §29.25
test('stop mid-round: DISCONNECT→PARTIAL_END, INTERRUPT→INTERRUPTED, no fabricated END', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));
  a.observe(recv(ODD, { sid: 1, odd: 1.4, at: 50 }));
  a.finalizeCurrent(CAUSE.DISCONNECT);
  const r = a.finalizedRounds()[0];
  assert.equal(r.completeness, COMPLETENESS.PARTIAL_END);
  assert.equal(r.endedAtMs, null);
  assert.equal(r.durationMs, null);

  const b = mk();
  b.observe(recv(OPEN, { sid: 1, at: 0 }));
  b.finalizeCurrent(CAUSE.INTERRUPT);
  assert.equal(b.finalizedRounds()[0].completeness, COMPLETENESS.INTERRUPTED);
});

// §29.27
test('SNAPSHOT for the same current SID does not create a new round', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 9, at: 0 }));
  a.observe(recv(SNAP, { sid: 9, at: 10 }));
  assert.equal(a.current().sid, 9);
  assert.equal(a.finalizedRounds().length, 0);
});

// §29.28-33
test('ODD timeline: repeated equal values preserved; first/last/max/count correct', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));
  a.observe(recv(ODD, { sid: 1, odd: 1.5, at: 10 }));
  a.observe(recv(ODD, { sid: 1, odd: 1.5, at: 20 }));   // legitimate repeat — not deduped
  a.observe(recv(ODD, { sid: 1, odd: 4.0, at: 30 }));
  a.observe(recv(ODD, { sid: 1, odd: 2.0, at: 40 }));
  const r = a.current();
  assert.equal(r.oddSampleCount, 4);
  assert.equal(r.firstOdd, 1.5);
  assert.equal(r.lastOdd, 2.0);
  assert.equal(r.maxOdd, 4.0);
});

// §29.34-36
test('threshold timing uses first sample >= T (no interpolation); unreached = null', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 1000 }));
  a.observe(recv(ODD, { sid: 1, odd: 1.1, at: 1000 }));  // firstOdd
  a.observe(recv(ODD, { sid: 1, odd: 1.3, at: 1100 }));
  a.observe(recv(ODD, { sid: 1, odd: 2.2, at: 1300 }));
  a.observe(recv(END, { sid: 1, at: 1400 }));
  const m = a.finalizedRounds()[0].metrics;
  assert.equal(m.reached[120], true); assert.equal(m.timings[120], 100);   // 1.20 at 1100
  assert.equal(m.reached[200], true); assert.equal(m.timings[200], 300);   // 2.00 at 1300
  assert.equal(m.reached[1000], false); assert.equal(m.timings[1000], null); // 10x never
  assert.equal(m.censored, false);
});

// §29.37
test('partial-start round marks timing censored', () => {
  const a = mk();
  a.observe(recv(SNAP, { sid: 1, at: 0 }));
  a.observe(recv(ODD, { sid: 1, odd: 5, at: 10 }));
  a.observe(recv(END, { sid: 1, at: 20 }));
  assert.equal(a.finalizedRounds()[0].metrics.censored, true);
});

// §29.38-41
test('jackpot: samples + min/max/avg/delta; exact lifecycle NULL when not on exact event', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));                         // no jp on open
  a.observe(recv(ODD, { sid: 1, odd: 1.5, jackpot: 100, at: 10 })); // jp on first odd
  a.observe(recv(ODD, { sid: 1, odd: 2.0, jackpot: 120, at: 20 }));
  a.observe(recv(END, { sid: 1, odd: 2.0, at: 30 }));              // no jp on end
  const r = a.finalizedRounds()[0];
  assert.equal(r.jackpotSampleCount, 2);
  assert.equal(r.jackpotMin, 100); assert.equal(r.jackpotMax, 120);
  assert.equal(r.jackpotAvg, 110); assert.equal(r.jackpotDelta, 20);
  assert.equal(r.jackpotAtOpen, null);      // no exact evidence
  assert.equal(r.jackpotAtFirstOdd, 100);   // exact on first odd
  assert.equal(r.jackpotAtEnd, null);       // no exact evidence
});

test('missing jackpot stays null; no samples', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));
  a.observe(recv(END, { sid: 1, at: 10 }));
  const r = a.finalizedRounds()[0];
  assert.equal(r.jackpotSampleCount, 0);
  assert.equal(r.jackpotMin, null); assert.equal(r.jackpotAtOpen, null);
});

// §29.42
test('jackpot observed outside any round is NOT forced into a round', () => {
  const a = mk();
  a.observe(recv(999999, { jackpot: 500, at: 0 })); // unknown cmd, no active round
  assert.equal(a.current(), null);
  assert.equal(a.allRounds().length, 0);
});

// §10 — SEND frames never mutate normalized state
test('website SEND frames do not mutate round state', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));
  a.observe({ direction: 'SEND', cmd: ODD, sid: 1, odd: 999, timestampMs: 10, rawEventId: ++rawId });
  assert.equal(a.current().oddSampleCount, 0);
  assert.equal(a.current().maxOdd, null);
});

// §15 — END odd is a distinct authoritative sample
test('ROUND_END odd is stored as a distinct sample and updates max/last', () => {
  const a = mk();
  a.observe(recv(OPEN, { sid: 1, at: 0 }));
  a.observe(recv(ODD, { sid: 1, odd: 1.5, at: 10 }));
  a.observe(recv(END, { sid: 1, odd: 2.5, at: 20 }));
  const r = a.finalizedRounds()[0];
  assert.equal(r.oddSampleCount, 2);
  assert.equal(r.lastOdd, 2.5); assert.equal(r.maxOdd, 2.5);
});
