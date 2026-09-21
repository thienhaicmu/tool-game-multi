import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const evidence = require('../fixtures/phom/protocol-evidence.json');
const { classifyPhomFrame } = require('../../desktop/protocol/phom/phom-frame-classify.cjs');
const { PhomContext } = require('../../desktop/protocol/phom/phom-context.cjs');

test('observed foreign rs[] packet never binds a Phỏm game socket or creates channels', () => {
  const raw = JSON.stringify(evidence.foreignListShape);
  assert.equal(classifyPhomFrame(raw).isServerEvidence, false);
  const ctx = new PhomContext(); ctx.observe({ raw, direction: 'recv', targetId: 'foreign', url: 'wss://fixture' });
  assert.equal(ctx.socketReady(), false); assert.deepEqual(ctx.channels(), []);
});
