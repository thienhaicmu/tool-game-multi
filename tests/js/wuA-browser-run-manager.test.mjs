import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserRunManager, STATUS } = require('../../desktop/browser-run/browser-run-manager.cjs');

// Fake per-run pieces so the manager can be exercised without Electron/CDP.
function makeFakes() {
  const launchers = [];
  const targetManagers = [];
  const subsystems = [];

  function fakeSubsystem(run) {
    const s = {
      _fedFrames: 0,
      _autoRunning: false,
      _autoStopped: 0,
      _bvalStopped: 0,
      _observerDisconnected: 0,
      _round: null,
      aviator: { observe(frame) { s._fedFrames += 1; s._round = { sid: frame.sid, currentOdd: frame.odd ?? null }; } },
      observer: { onDisconnect() { s._observerDisconnected += 1; }, currentRound() { return s._round; } },
      autoRunner: { isRunning() { return s._autoRunning; }, stop() { s._autoRunning = false; s._autoStopped += 1; return { ok: true }; } },
      amountValidator: { isRunning() { return false; }, stop() { s._bvalStopped += 1; return { ok: true }; } },
      protocolContext: { reset() {} },
      harness: {},
      _runId: run.id,
    };
    subsystems.push(s);
    return s;
  }

  const mgr = new BrowserRunManager({
    createLauncher: (run) => { const l = { runId: run.id, closed: 0, close() { this.closed += 1; }, snapshot() { return { cdpPort: 9200 + run.ordinal, chromePid: 1000 + run.ordinal, chromeProfile: 'profile-' + run.id }; } }; launchers.push(l); return l; },
    createTargetManager: (endpoint, run) => { const t = { endpoint, runId: run.id, stopped: 0, async stop() { this.stopped += 1; }, listTargets() { return []; }, getSession() { return undefined; } }; targetManagers.push(t); return t; },
    buildSubsystem: fakeSubsystem,
    now: () => 1_700_000_000_000,
  });

  return { mgr, launchers, targetManagers, subsystems };
}

test('createRun assigns sequential BR-000N ids and its own per-run pieces', () => {
  const { mgr, launchers, subsystems } = makeFakes();
  const a = mgr.createRun({ launchUrl: 'https://game.test/a' });
  const b = mgr.createRun({ launchUrl: 'https://game.test/b' });
  assert.equal(a.id, 'BR-0001');
  assert.equal(b.id, 'BR-0002');
  assert.equal(a.ordinal, 0);
  assert.equal(b.ordinal, 1);
  assert.notEqual(a.launcher, b.launcher);
  assert.notEqual(a.aviator, b.aviator);
  assert.equal(launchers.length, 2);
  assert.equal(subsystems.length, 2);
  assert.equal(a.status, STATUS.STARTING);
});

test('first run is active by default; setActive switches the active run', () => {
  const { mgr } = makeFakes();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  assert.equal(mgr.activeRun().id, a.id);
  assert.equal(mgr.isActive(a), true);
  assert.equal(mgr.isActive(b), false);
  assert.equal(mgr.setActive(b.id), true);
  assert.equal(mgr.activeRun().id, b.id);
  assert.equal(mgr.setActive('BR-9999'), false); // unknown id ignored
});

test('runForTarget resolves the owning run and null for unknown targets', () => {
  const { mgr } = makeFakes();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  mgr.registerTarget('T-A', a);
  mgr.registerTarget('T-B', b);
  assert.equal(mgr.runForTarget('T-A').id, a.id);
  assert.equal(mgr.runForTarget('T-B').id, b.id);
  assert.equal(mgr.runForTarget('T-X'), null);
  assert.deepEqual(mgr.targetsForRun(a.id), ['T-A']);
});

test('a frame for run A updates only A; B stays untouched', () => {
  const { mgr, subsystems } = makeFakes();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  const subA = subsystems[0];
  const subB = subsystems[1];
  mgr.registerTarget('T-A', a);
  mgr.registerTarget('T-B', b);

  mgr.runForTarget('T-A').aviator.observe({ sid: 111, odd: 1.72 });
  assert.equal(subA._fedFrames, 1);
  assert.equal(subB._fedFrames, 0);
  assert.equal(mgr.summary(a).currentSid, 111);
  assert.equal(mgr.summary(a).currentOdd, 1.72);
  assert.equal(mgr.summary(b).currentSid, null);
});

test('registerTarget on a STARTING run moves it to CONNECTED', () => {
  const { mgr } = makeFakes();
  const a = mgr.createRun({});
  assert.equal(a.status, STATUS.STARTING);
  mgr.registerTarget('T-A', a);
  assert.equal(a.status, STATUS.CONNECTED);
});

test('disconnectRun quiesces the run and sets DISCONNECTED', () => {
  const { mgr, subsystems } = makeFakes();
  const a = mgr.createRun({});
  subsystems[0]._autoRunning = true;
  mgr.disconnectRun(a);
  assert.equal(a.status, STATUS.DISCONNECTED);
  assert.equal(subsystems[0]._autoStopped, 1);
  assert.equal(subsystems[0]._observerDisconnected, 1);
});

test('closeRun(A) stops A, hands active to B, and leaves B running; history preserved', async () => {
  const { mgr, subsystems, targetManagers, launchers } = makeFakes();
  const a = mgr.createRun({});
  const b = mgr.createRun({});
  mgr.setTargetManager(a, { host: '127.0.0.1', port: 9201 });
  mgr.setTargetManager(b, { host: '127.0.0.1', port: 9202 });
  mgr.registerTarget('T-A', a);
  mgr.registerTarget('T-B', b);
  subsystems[0]._autoRunning = true;
  subsystems[1]._autoRunning = true;
  assert.equal(mgr.activeRun().id, a.id);

  await mgr.closeRun(a.id);

  assert.equal(a.status, STATUS.CLOSED);
  assert.ok(a.endedAt);
  assert.equal(subsystems[0]._autoStopped, 1, 'A auto-runner stopped');
  assert.equal(targetManagers[0].stopped, 1, 'A target manager detached');
  assert.equal(launchers[0].closed, 1, 'A browser closed');
  assert.equal(mgr.runForTarget('T-A'), null, 'A targets dropped from index');

  // B untouched, and now active.
  assert.equal(subsystems[1]._autoRunning, true, 'B still running');
  assert.equal(subsystems[1]._autoStopped, 0);
  assert.equal(mgr.activeRun().id, b.id, 'active handed to B');
  assert.equal(mgr.runForTarget('T-B').id, b.id);

  // Closing is terminal: further status changes are ignored.
  mgr.setStatus(a, STATUS.CONNECTED);
  assert.equal(a.status, STATUS.CLOSED);
});

test('summary is serialisable and never leaks the live target manager/client', () => {
  const { mgr } = makeFakes();
  const a = mgr.createRun({ launchUrl: 'https://game.test' });
  mgr.setTargetManager(a, { host: '127.0.0.1', port: 9201 });
  const s = mgr.summary(a);
  assert.equal(s.id, 'BR-0001');
  assert.equal(s.active, true);
  assert.equal(s.launchUrl, 'https://game.test');
  assert.equal('targetManager' in s, false);
  assert.equal('launcher' in s, false);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s); // fully serialisable
});
