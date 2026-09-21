import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TokenKeyPool } = require('../../desktop/protocol/phom/token-key-pool.cjs');
const { StakeCatalog } = require('../../desktop/protocol/phom/stake-catalog.cjs');
const { RoomScanner } = require('../../desktop/protocol/phom/room-scanner.cjs');
const { SharedRoomSession } = require('../../desktop/protocol/phom/shared-room-session.cjs');
const catalog = () => new StakeCatalog([{ id: 'fixture-bet', label: '1K', evidence: 'synthetic unit-test only' }]);
const candidate = { rid: 'fixture-room', betId: 'fixture-bet', gameId: 8, capacity: 4, playerCount: 0, playing: false, exists: true };
function make(list, opts = {}) {
  const pool = new TokenKeyPool(); pool.import(['SECRET_ONE', 'SECRET_TWO']);
  const scanner = new RoomScanner({ pool, catalog: catalog(), transport: { verified: true, correlated: true, list }, timeoutMs: 15, ...opts });
  return { pool, scanner };
}

test('unverified catalog and transport fail closed without sending', async () => {
  assert.deepEqual(new StakeCatalog().list(), []);
  assert.throws(() => new StakeCatalog([{ id: '<BET_ID>', label: '1K' }]));
  let sent = false; const { scanner } = make(() => { sent = true; }, { transport: { list() { sent = true; } } });
  await assert.rejects(scanner.scan({ browserId: 'A', betId: 'fixture-bet' }), { code: 'TOKEN_SCAN_PROTOCOL_UNVERIFIED' });
  assert.equal(sent, false);
});

test('pool deduplicates, masks even short keys, rotates and allows only one in use', () => {
  const pool = new TokenKeyPool(); assert.deepEqual(pool.import(['abcdef', 'abcdef', 'xyz']), { added: 2, duplicates: 1 });
  const a = pool.acquire(); assert.equal(pool.acquire(), null); pool.release(a.id);
  const b = pool.acquire(); assert.notEqual(a.id, b.id); pool.release(b.id);
  assert.equal(pool.acquire().id, a.id);
  const text = JSON.stringify(pool.snapshot()); assert.equal(text.includes('abcdef'), false); assert.equal(text.includes('xyz'), false);
});

test('scanner rotates sequentially, rejects insufficient slots and never returns raw keys', async () => {
  const attempts = []; let inFlight = 0; let maximum = 0;
  const { scanner } = make(async (ctx) => {
    attempts.push(ctx.tokenKeyId); maximum = Math.max(maximum, ++inFlight); await Promise.resolve(); inFlight--;
    return { scanId: ctx.scanId, attemptId: ctx.attemptId, candidates: [{ ...candidate, playerCount: attempts.length === 1 ? 2 : 0 }] };
  });
  const result = await scanner.scan({ browserId: 'A', betId: 'fixture-bet' });
  assert.equal(result.ok, true); assert.equal(maximum, 1); assert.equal(attempts.length, 2);
  assert.equal(JSON.stringify(result).includes('SECRET_'), false);
});

test('timeout retries once, then rotates; invalid key stays out of this session', async () => {
  const attempts = [];
  const { scanner, pool } = make(async (ctx) => { attempts.push(ctx.tokenKeyId); throw Object.assign(new Error(), { code: attempts.length <= 2 ? 'TOKEN_TIMEOUT' : 'TOKEN_INVALID' }); });
  const result = await scanner.scan({ browserId: 'A', betId: 'fixture-bet' });
  assert.equal(result.ok, false); assert.equal(attempts.length, 3); assert.equal(attempts[0], attempts[1]);
  assert.deepEqual(pool.snapshot().map((k) => k.status), ['COOLDOWN', 'INVALID']);
});

test('mismatched response correlation is never accepted as a candidate', async () => {
  const { scanner } = make(async () => ({ attemptId: 'old', scanId: 'old', candidates: [candidate] }));
  assert.equal((await scanner.scan({ browserId: 'A', betId: 'fixture-bet' })).ok, false);
});

test('STOP aborts a stalled transport and releases the token before a late response', async () => {
  let resolve; let entered; const started = new Promise((r) => { entered = r; });
  const { scanner, pool } = make((ctx) => new Promise((r) => { resolve = () => r({ scanId: ctx.scanId, attemptId: ctx.attemptId, candidates: [candidate] }); entered(); }), { timeoutMs: 500 });
  const controller = new AbortController();
  const request = scanner.scan({ browserId: 'A', betId: 'fixture-bet', signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(request, { code: 'ABORTED' }); resolve(); await Promise.resolve();
  assert.equal(scanner.active, null); assert.equal(pool.snapshot().some((k) => k.status === 'IN_USE'), false);
});

test('shared room publishes only after finder evidence and rejects mismatched IDs, versions and lost capacity', () => {
  const room = new SharedRoomSession({ expectedBrowsers: ['A', 'B', 'C'] });
  const reserved = room.reserve(candidate, 'A', 'key-id', catalog().get('fixture-bet'));
  assert.equal(room.published(), null);
  const confirm = { browserId: 'A', rid: candidate.rid, betId: candidate.betId, version: reserved.version, ownUidPresent: true, playerCount: 1 };
  assert.equal(room.confirm({ ...confirm, browserId: 'B' }), false);
  assert.equal(room.confirm({ ...confirm, rid: 'channel-id' }), false);
  assert.equal(room.confirm({ ...confirm, playerCount: 3 }), false);
  assert.equal(room.confirm(confirm), true); assert.equal(room.published().rid, candidate.rid);
  room.clear(); room.reserve(candidate, 'A', 'key-id', catalog().get('fixture-bet'));
  assert.equal(room.confirm(confirm), false);
});
