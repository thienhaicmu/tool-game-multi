import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const evidence = require('../fixtures/phom/protocol-evidence.json');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { qualifyTable } = require('../../desktop/protocol/phom/table-qualify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');

test('observed foreign rs[] packet never binds a Phỏm game socket or creates channels', () => {
  const raw = JSON.stringify(evidence.foreignListShape);
  assert.equal(classifyPhomFrame(raw).isServerEvidence, false);
  const ctx = new PhomContext(); ctx.observe({ raw, direction: 'recv', targetId: 'foreign', url: 'wss://fixture' });
  assert.equal(ctx.socketReady(), false); assert.deepEqual(ctx.channels(), []);
});
test('observed empty stake channel does not qualify as an empty table', () => {
  const result = qualifyTable(evidence.channelRow, { selectedStake: 20000, need: 3, gid: 8, zone: 'Simms' });
  assert.equal(result.ok, false); assert.equal(result.reason, 'INVALID_STRUCTURE');
});
test('missing or negative occupancy is unknown, never zero occupied seats', () => {
  for (const uC of [null, undefined, '', -1, 0.5]) {
    assert.equal(qualifyTable({ rid: 700, b: 1000, Mu: 4, uC }, { selectedStake: 1000 }).ok, false);
  }
});
