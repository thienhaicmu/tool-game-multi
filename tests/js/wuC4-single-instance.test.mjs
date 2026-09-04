import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { acquireSingleInstance, focusExistingWindow } = require('../../desktop/instance/single-instance.cjs');

function fakeApp(gotLock) {
  const handlers = {};
  return {
    requestSingleInstanceLock: () => gotLock,
    on: (ev, fn) => { handlers[ev] = fn; },
    emit: (ev, ...a) => { if (handlers[ev]) handlers[ev](...a); },
  };
}

// §29/§30 — the first instance becomes primary and listens for second launches.
test('first instance acquires the lock and is primary', () => {
  let focused = 0;
  const app = fakeApp(true);
  const res = acquireSingleInstance(app, { onSecondInstance: () => { focused += 1; } });
  assert.equal(res.primary, true);
  app.emit('second-instance');           // a second launch arrives
  assert.equal(focused, 1, 'existing window is focused on second launch');
});

// §30 — a secondary instance does not get the lock (caller must quit without runtime).
test('second instance does not acquire the lock', () => {
  const app = fakeApp(false);
  const res = acquireSingleInstance(app, { onSecondInstance: () => {} });
  assert.equal(res.primary, false);
});

// focusExistingWindow restores/shows/focuses; safe on destroyed/missing windows.
test('focusExistingWindow restores, shows and focuses', () => {
  const calls = [];
  const win = {
    isDestroyed: () => false, isMinimized: () => true, isVisible: () => false,
    restore: () => calls.push('restore'), show: () => calls.push('show'), focus: () => calls.push('focus'),
  };
  assert.equal(focusExistingWindow(win), true);
  assert.deepEqual(calls, ['restore', 'show', 'focus']);
  assert.equal(focusExistingWindow(null), false);
  assert.equal(focusExistingWindow({ isDestroyed: () => true }), false);
});

// The bootstrap wiring must guard product runtime behind primary ownership.
test('main.cjs guards product runtime behind single-instance primary', () => {
  const { readFileSync } = require('node:fs');
  const main = readFileSync(new URL('../../desktop/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /acquireSingleInstance\(app/);
  assert.match(main, /if \(!singleInstance\.primary\)\s*\{\s*app\.quit\(\);\s*return;/);
});
