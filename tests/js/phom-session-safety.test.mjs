import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');
const { redactFrame } = require('../../desktop/protocol/phom/frame-recorder.cjs');
const { redactDiagnostic } = require('../../desktop/protocol/phom/diagnostic-redaction.cjs');

const list = [5, { cmd: 300, rs: [{ rid: 700, b: 1000, uC: 0, Mu: 4, gid: 8, zn: 'Simms' }] }];
const table = (...uids) => [5, { cmd: 202, b: 1000, ps: uids.map((uid, sit) => ({ uid, sit, r: false })) }];
function setup(send = async () => ({ ok: true })) {
  const sent = []; let coord;
  coord = new HostTableCoordinator({ environmentAuthorized: true, hostId: 'A', leaveConfirmMs: 15, joinRejectGraceMs: 1,
    profiles: ['A', 'B', 'C'].map((id) => ({ id, uid: id, send: async (raw) => { sent.push({ id, packet: JSON.parse(raw) }); return send(id, JSON.parse(raw), coord); } })) });
  for (const id of ['A', 'B', 'C']) { feed(coord, id, [5, { cmd: 100, id: 0, uid: id, As: {} }]); coord.setIdentity(id, { aid: 1 }); }
  return { coord, sent };
}
function feed(coord, id, packet) { coord.ingest(id, { raw: JSON.stringify(packet), direction: 'recv', targetId: id, url: 'wss://fixture', now: Date.now() }); }

test('a late channel list cannot erase membership; LEAVE_ACK can', () => {
  const ctx = new PhomContext({ uid: 'A' });
  const observe = (packet) => ctx.observe({ raw: JSON.stringify(packet), direction: 'recv', targetId: 'A', url: 'wss://fixture' });
  observe(table('A')); observe(list);
  assert.equal(ctx.seat(), 0);
  observe([4, true, 1, -1, 0, '']); assert.equal(ctx.tableState(), null);
});

test('STOP while JOIN send awaits cannot publish a room from its late completion', async () => {
  let release; const { coord } = setup(() => new Promise((r) => { release = r; }));
  const joining = coord.joinTable('A', 700); coord.stop();
  feed(coord, 'A', table('A')); release({ ok: true });
  assert.equal((await joining).ok, false);
  assert.equal(coord.manualBrowserSnapshot().find((b) => b.profileId === 'A').rid, null, 'no số bàn from a stopped join');
});

test('log subscribers cannot receive auth tokens, room codes, binary previews or probe values', () => {
  const { coord } = setup(); const logs = []; coord.on('log', (e) => logs.push(e));
  feed(coord, 'A', [1, true, 1, 'SECRET_LOGIN', 'Simms']);
  feed(coord, 'A', [5, { cmd: 202, b: 1000, hpwd: 'SECRET_ROOM', ps: [{ uid: 'A', sit: 0 }] }]);
  const json = JSON.stringify(logs);
  assert.equal(json.includes('SECRET_'), false);
  assert.equal(JSON.stringify(redactDiagnostic({ result: { arbitrary: 'SECRET_PROBE' }, hex: 'SECRET_HEX', roomCode: 'SECRET_ROOM' })).includes('SECRET_'), false);
});

test('frame recorder redacts positional login and token-identity fields', () => {
  assert.equal(redactFrame('[1,true,1,"SECRET_LOGIN","Simms"]').raw.includes('SECRET_LOGIN'), false);
  assert.equal(redactFrame('[5,{"cmd":100,"id":1,"uid":"SECRET_ID","As":{}}]').raw.includes('SECRET_ID'), false);
});

test('no password ever leaves the tool: VÀO sends an empty one, whatever the session holds', async () => {
  const sent = []; const { coord } = setup(async (id, packet) => { sent.push(packet); return { ok: true }; });
  feed(coord, 'A', [1, true, 1, 'SECRET_LOGIN', 'Simms']);
  coord.joinTable('A', 700, { timeoutMs: 20 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent.find((f) => f[0] === 8), [8, 'Simms', 700, '', 8]);
  assert.equal(JSON.stringify(sent).includes('SECRET'), false);
});

