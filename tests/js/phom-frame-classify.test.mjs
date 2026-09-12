import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyPhomFrame, normalizeChannel, normalizeSeat, CMD } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');

// §5/§22.B — channel list response preserves ALL fields; uC=65 with Mu=4 is kept.
test('CHANNEL_LIST preserves all room fields incl. uC > Mu', () => {
  const raw = JSON.stringify([5, { rs: [{ rid: 141, rn: 'Phom#2', gid: 8, b: 1000, mM: 10000, Mu: 4, uC: 65, hpwd: false, zn: 'Simms' }] }]);
  const cls = classifyPhomFrame(raw);
  assert.equal(cls.type, 'CHANNEL_LIST');
  assert.equal(cls.known, true);
  const ch = normalizeChannel(cls.rs[0]);
  assert.equal(ch.rid, 141);
  assert.equal(ch.rn, 'Phom#2');
  assert.equal(ch.b, 1000);
  assert.equal(ch.mM, 10000);
  assert.equal(ch.Mu, 4);
  assert.equal(ch.uC, 65); // NOT rejected because it exceeds Mu
  assert.equal(ch.hpwd, false);
  assert.equal(ch.zn, 'Simms');
});

// §5 — empty find-table response is not an error.
test('FIND_TABLE empty response classifies (not an error)', () => {
  const cls = classifyPhomFrame(JSON.stringify([5, { b: [], mB: 0 }]));
  assert.equal(cls.type, 'FIND_TABLE');
  assert.equal(cls.known, true);
});

// §5 — authoritative table state carries ps[].
test('TABLE_STATE parses seats from ps[]', () => {
  const raw = JSON.stringify([5, { b: 1000, ps: [{ sit: 1, dn: 'Alice', uid: '1_1', m: 0, r: true }, { sit: 2, dn: 'Bob', uid: '1_2', m: 5, r: false }] }]);
  const cls = classifyPhomFrame(raw);
  assert.equal(cls.type, 'TABLE_STATE');
  assert.equal(cls.ps.length, 2);
  const s = normalizeSeat(cls.ps[0]);
  assert.equal(s.sit, 1);
  assert.equal(s.uid, '1_1');
  assert.equal(s.ready, true);
});

// §5/§6 — client request frames.
test('client request frames classify by wire opcode', () => {
  assert.equal(classifyPhomFrame(JSON.stringify([6, 'Simms', 'channelPlugin', { cmd: 300, aid: 'A', gid: 8 }])).type, 'CHANNEL_LIST_REQUEST');
  assert.equal(classifyPhomFrame(JSON.stringify([6, 'Simms', 'channelPlugin', { cmd: 311, gid: 8 }])).type, 'FIND_TABLE_REQUEST');
  assert.equal(classifyPhomFrame(JSON.stringify([6, 'Simms', 'channelPlugin', { cmd: 363, aRd: 'true' }])).type, 'READY_REQUEST');
  const join = classifyPhomFrame(JSON.stringify([3, 'Simms', 139, '']));
  assert.equal(join.type, 'JOIN_REQUEST');
  assert.equal(join.channel, 139); // channel code, NOT a physical table id
  assert.equal(join.hasPassword, false);
  assert.equal(classifyPhomFrame(JSON.stringify([4, 'Simms', -1])).type, 'LEAVE_REQUEST');
});

// §12 — gameplay commands 850..854.
test('gameplay commands classify with surfaced fields', () => {
  const deal = classifyPhomFrame(JSON.stringify([5, { cs: [40, 44, 48, 3, 2, 6, 8, 27, 42], lpi: [], cmd: 850, tP: { uid: 'A' } }]));
  assert.equal(deal.type, 'DEAL');
  assert.equal(deal.cmd, CMD.DEAL);
  assert.deepEqual(deal.cs, [40, 44, 48, 3, 2, 6, 8, 27, 42]);
  assert.equal(deal.tP.uid, 'A');
  assert.equal(deal.isHandEvent, true);

  const play = classifyPhomFrame(JSON.stringify([5, { fP: { uid: 'A', dCs: 38 }, cmd: 851, tP: { uid: 'B' } }]));
  assert.equal(play.type, 'PLAY');
  assert.equal(play.fP.dCs, 38);
  assert.equal(play.tP.uid, 'B');

  const draw = classifyPhomFrame(JSON.stringify([5, { cs: 20, uid: '1_644555813', sAC: [10, 14, 18, 27, 31, 35, 13, 15, 20, 34], sMs: [10, 14, 18, 27, 31, 35], cmd: 852 }]));
  assert.equal(draw.type, 'DRAW');
  assert.equal(draw.cs, 20);
  assert.equal(draw.uid, '1_644555813');
  assert.equal(draw.sAC.length, 10);
  assert.deepEqual(draw.sMs, [10, 14, 18, 27, 31, 35]);

  const meld = classifyPhomFrame(JSON.stringify([5, { uid: 'A', mes: [{ meid: 1, cs: [10, 14, 18] }], cmd: 854 }]));
  assert.equal(meld.type, 'MELD');
  assert.equal(meld.mes[0].cs.length, 3);

  const end = classifyPhomFrame(JSON.stringify([5, { uid: 'A', sAC: [1, 2, 3], sMs: [], fP: { uid: 'A', lm: -50 }, cmd: 853 }]));
  assert.equal(end.type, 'ROUND_END');
  assert.equal(end.fP.lm, -50);
});

// Pure/total: malformed / non-JSON / binary never throw.
test('malformed frames come back UNKNOWN, never throw', () => {
  for (const bad of ['', 'not json', '[binary 12 bytes]', '{oops', '42', 'null', JSON.stringify([5, { cmd: 999999 }])]) {
    const cls = classifyPhomFrame(bad);
    assert.equal(cls.known, false);
    assert.equal(cls.isHandEvent, false);
  }
});
