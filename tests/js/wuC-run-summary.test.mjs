import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
const { ProtocolHarness } = require('../../desktop/protocol/harness.cjs');
const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');
const { AmountValidator } = require('../../desktop/protocol/amount-validator.cjs');
const { BrowserRunManager, STATUS } = require('../../desktop/browser-run/browser-run-manager.cjs');

// A real per-run subsystem (as main.buildProtocolSubsystem wires it).
function makeSubsystem(id, sends = []) {
  const tracker = new RoundTracker({ ackWindowMs: 5000 });
  const harness = new ProtocolHarness({ roundTracker: tracker, ackTimeoutMs: 200, getTargetUrl: () => `https://game-${id}.test/play`, send: async (ctx, payload) => { sends.push({ id, payload }); return { ok: true }; } });
  const observer = new RoundObserver({ roundTracker: tracker });
  const getTargetUrl = () => `https://game-${id}.test/play`;
  const autoRunner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl });
  const amountValidator = new AmountValidator({ roundTracker: tracker, harness, getTargetUrl });
  return { aviator: tracker, protocolContext: { get: () => ({ aid: null, eid: null, ready: false }), reset() {} }, observer, harness, autoRunner, amountValidator };
}

// Build a manager wired to real subsystems keyed by run id order (A, B, C...).
function makeManager() {
  const built = [];
  const mgr = new BrowserRunManager({
    createLauncher: () => ({ close() {}, snapshot() { return {}; } }),
    createTargetManager: (endpoint, run) => ({ async stop() {}, listTargets() { return []; }, getSession: (id) => (id && id === run.selectedTargetId ? { target: { url: `https://game-${run.id}.test/play` } } : undefined) }),
    buildSubsystem: (run) => { const s = makeSubsystem(run.id); built.push({ run, s }); return s; },
  });
  return { mgr, built };
}

const openRound = (sid) => `{"cmd":100005,"sid":${sid}}`;
const oddFrame = (sid, odd) => `{"cmd":100009,"sid":${sid},"odd":${odd}}`;
function feedRun(run, raw) { run.aviator.observe({ targetId: run.selectedTargetId || (run.id + '-T'), cdpSessionId: 'S', url: 'wss://game.host/ws', direction: 'recv', raw }); }
const byId = (list, id) => list.find((r) => r.id === id);

// A. three runs appear independently
test('A: three BrowserRuns appear independently in the run list', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({ launchUrl: 'https://a.test' });
  const b = mgr.createRun({ launchUrl: 'https://b.test' });
  const c = mgr.createRun({ launchUrl: 'https://c.test' });
  const list = mgr.list();
  assert.deepEqual(list.map((r) => r.id), [a.id, b.id, c.id]);
  assert.equal(new Set(list.map((r) => r.id)).size, 3);
});

// B. selecting BR-0002 changes only the active/view flag
test('B: selecting a run flips only the active view flag', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  assert.equal(byId(mgr.list(), a.id).active, true);
  mgr.setActive(b.id);
  const list = mgr.list();
  assert.equal(byId(list, a.id).active, false);
  assert.equal(byId(list, b.id).active, true);
});

// C. BR-0001 AutoRunner remains running after selecting BR-0002
test('C: AutoRunner keeps running after the view switches away from it', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  a.autoRunner.start('TA', { roundCount: 3, amount: 5000, stopOdd: 2 });
  mgr.setActive(b.id);
  assert.equal(byId(mgr.list(), a.id).autoRunning, true, 'A still AUTO after selecting B');
  assert.equal(a.autoRunner.isRunning(), true);
});

// D. BR-0001 and BR-0002 both show AUTO simultaneously
test('D: two runs report AUTO at the same time', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  const c = mgr.createRun({});
  a.autoRunner.start('TA', { roundCount: 3, amount: 5000, stopOdd: 2 });
  b.autoRunner.start('TB', { roundCount: 3, amount: 5000, stopOdd: 2 });
  const list = mgr.list();
  assert.equal(byId(list, a.id).autoRunning, true);
  assert.equal(byId(list, b.id).autoRunning, true);
  assert.equal(byId(list, c.id).autoRunning, false, 'C not started');
});

// E. Starting Auto on BR-0002 starts only BR-0002's runner
test('E: starting Auto on one run does not start another', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  b.autoRunner.start('TB', { roundCount: 3, amount: 5000, stopOdd: 2 });
  assert.equal(b.autoRunner.isRunning(), true);
  assert.equal(a.autoRunner.isRunning(), false);
});

// F. Stopping Auto on BR-0002 does not stop BR-0001
test('F: stopping Auto on one run leaves the other running', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  a.autoRunner.start('TA', { roundCount: 3, amount: 5000, stopOdd: 2 });
  b.autoRunner.start('TB', { roundCount: 3, amount: 5000, stopOdd: 2 });
  b.autoRunner.stop();
  assert.equal(byId(mgr.list(), b.id).autoRunning, false);
  assert.equal(byId(mgr.list(), a.id).autoRunning, true);
});

// G. SID/ODD summary for BR-0001 cannot appear on the BR-0002 row
test('G: per-run SID/ODD summaries never cross between rows', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  feedRun(a, openRound(88231));
  feedRun(a, oddFrame(88231, 1.42));
  feedRun(b, openRound(73612));
  feedRun(b, oddFrame(73612, 3.71));
  const list = mgr.list();
  assert.equal(byId(list, a.id).currentSid, 88231);
  assert.equal(byId(list, a.id).currentOdd, 1.42);
  assert.equal(byId(list, b.id).currentSid, 73612);
  assert.equal(byId(list, b.id).currentOdd, 3.71);
  assert.notEqual(byId(list, a.id).currentSid, byId(list, b.id).currentSid);
});

// H. Closing BR-0001 updates only BR-0001's row
test('H: closing one run marks only that row CLOSED', async () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  mgr.setTargetManager(a, { host: '127.0.0.1', port: 9201 });
  mgr.setTargetManager(b, { host: '127.0.0.1', port: 9202 });
  b.autoRunner.start('TB', { roundCount: 3, amount: 5000, stopOdd: 2 });
  await mgr.closeRun(a.id);
  assert.equal(byId(mgr.list(), a.id).status, STATUS.CLOSED);
  assert.equal(byId(mgr.list(), b.id).status !== STATUS.CLOSED, true);
  assert.equal(byId(mgr.list(), b.id).autoRunning, true, 'B unaffected');
});

// I. Opening another browser adds a run rather than replacing existing rows
test('I: opening another run appends without replacing existing rows', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  assert.equal(mgr.list().length, 2);
  const c = mgr.createRun({});
  const list = mgr.list();
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => r.id), [a.id, b.id, c.id]);
});

// J. Single-browser workflow still yields a coherent summary
test('J: single-run summary exposes the run list contract', () => {
  const { mgr } = makeManager();
  const a = mgr.createRun({ launchUrl: 'https://solo.test' });
  a.selectedTargetId = 'TA';
  mgr.setTargetManager(a, { host: '127.0.0.1', port: 9201 });
  feedRun(a, openRound(100));
  const s = byId(mgr.list(), a.id);
  for (const k of ['id', 'status', 'active', 'host', 'protocolReady', 'currentSid', 'currentOdd', 'autoRunning', 'testRunning']) {
    assert.ok(k in s, `summary exposes ${k}`);
  }
  assert.equal(s.active, true);
  assert.equal(s.currentSid, 100);
  assert.equal(s.host, `game-${a.id.toLowerCase()}.test`);
  assert.equal(typeof s.protocolReady, 'boolean');
});
