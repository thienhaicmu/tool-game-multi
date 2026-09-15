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

// PHASE-2 fix (live-captured evidence): the SERVER channel-list reply echoes cmd:300, i.e.
// [5,{rs:[...],cmd:300}]. It must classify as CHANNEL_LIST (server evidence), NOT as the client
// CHANNEL_LIST_REQUEST. Raw frames below are the REAL ones captured from a logged-in Phỏm session.
test('PHASE2: server channel-list reply that echoes cmd:300 => CHANNEL_LIST + server evidence', () => {
  const raw = '[5,{"rs":[{"mM":10000,"b":1000,"gid":8,"MMBI":0,"hpwd":false,"aG":"G","Mu":4,"ahp":false,"rid":141,"uC":73,"sid":1,"zn":"Simms","mMBI":0,"rn":"Phom#2","aid":1,"inc":false},{"mM":500,"b":100,"gid":8,"Mu":4,"rid":142,"uC":10,"zn":"Simms","rn":"Phom#1"}],"cmd":300}]';
  const cls = classifyPhomFrame(raw);
  assert.equal(cls.type, 'CHANNEL_LIST');
  assert.equal(cls.isServerEvidence, true);
  assert.equal(Array.isArray(cls.rs) && cls.rs.length, 2);
  assert.equal(normalizeChannel(cls.rs[0]).rid, 141);
  assert.equal(normalizeChannel(cls.rs[0]).b, 1000);
});

test('PHASE2: client cmd:300 request (op 6) stays CHANNEL_LIST_REQUEST and is NOT server evidence', () => {
  const cls = classifyPhomFrame('[6,"Simms","channelPlugin",{"cmd":300,"aid":"1","gid":8}]');
  assert.equal(cls.type, 'CHANNEL_LIST_REQUEST');
  assert.equal(cls.isServerEvidence, false);
});

test('PHASE2: self-identity push (cmd:100 with own wallet As) => SELF_IDENTITY carrying uid, server evidence', () => {
  const raw = '[5,{"uid":"Vxq2WWdg","a":"Avatar20","As":{"gold":21062,"guarranteed_gold":0},"u":"Vxq2WWdg","g":0,"dn":"baycao1002","cmd":100,"id":1}]';
  const cls = classifyPhomFrame(raw);
  assert.equal(cls.type, 'SELF_IDENTITY');
  assert.equal(cls.isServerEvidence, true);
  assert.equal(cls.uid, 'Vxq2WWdg');
  // a cmd:100 WITHOUT own-wallet As must NOT be treated as self-identity (avoids peer/other pushes).
  assert.notEqual(classifyPhomFrame('[5,{"uid":"peer","cmd":100}]').type, 'SELF_IDENTITY');
});

test('PHASE2: unrelated/malformed pushes are NOT CHANNEL_LIST', () => {
  assert.notEqual(classifyPhomFrame('[5,{"errC":10005,"gid":10889,"cmd":10004}]').type, 'CHANNEL_LIST');
  assert.notEqual(classifyPhomFrame('not json').type, 'CHANNEL_LIST');
  assert.equal(classifyPhomFrame('[5,{"bs":{"b":[]},"gid":10110,"cmd":10003}]').isServerEvidence, false);
  assert.equal(CMD.SELF_IDENTITY, 100);
});

// PHASE-2 integration: feeding the REAL server frames through PhomContext (recv) binds the
// authoritative session signal (socketReady+connected+uid) that the PHỎM READY gate requires;
// a client request alone must NOT bind it.
test('PHASE2: PhomContext binds socketReady/connected/uid + rs from real server frames only', () => {
  const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');
  const serverResp = '[5,{"rs":[{"rid":141,"rn":"Phom#2","gid":8,"b":1000,"Mu":4,"uC":73,"zn":"Simms"},{"rid":142,"b":100,"zn":"Simms"}],"cmd":300}]';
  // Authoritative game identity (id:0, "<aid>_<n>" — the SAME uid form used in ps[]); the token
  // form (id:1) must NOT bind (covered in the phom-same-table-live suite).
  const selfId = '[5,{"uid":"1_644555813","As":{"gold":21062},"u":"1_644555813","dn":"baycao1002","cmd":100,"id":0}]';
  const ctx = new PhomContext({ profileId: 'A' });
  ctx.observe({ raw: serverResp, direction: 'recv', targetId: 't1', url: 'wss://x', now: 1 });
  ctx.observe({ raw: selfId, direction: 'recv', targetId: 't1', url: 'wss://x', now: 2 });
  const g = ctx.get();
  assert.equal(g.socketReady, true);
  assert.equal(g.connected, true);
  assert.equal(g.uid, '1_644555813');
  assert.equal(g.channels.length, 2);
  // a client cmd:300 request (send) must NOT bind the socket by itself.
  const ctx2 = new PhomContext({ profileId: 'B' });
  ctx2.observe({ raw: '[6,"Simms","channelPlugin",{"cmd":300,"aid":"1","gid":8}]', direction: 'send', targetId: 't2', url: 'wss://x', now: 1 });
  assert.equal(ctx2.get().socketReady, false);
});
