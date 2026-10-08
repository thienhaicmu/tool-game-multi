// 3.2 core — browser sessions + the feature set. Behaviour only (no source-text checks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { createSessionRegistry, RECENT_MAX } = require('../../desktop/phom/core/session-registry.cjs');
const { createFeatureSet, parseOff } = require('../../desktop/phom/core/feature-set.cjs');

test('a browser session is created on first use, has one namespace per feature, and is the same object after', () => {
  const reg = createSessionRegistry();
  const s = reg.get('BR-1');
  assert.deepEqual(Object.keys(s).sort(), ['capture', 'enter', 'header', 'memory', 'origin', 'recent', 'runId', 'window']);
  assert.equal(reg.get('BR-1'), s);
  assert.equal(reg.peek('BR-2'), null, 'peek never creates');
  assert.equal(reg.size(), 1);
});

test('closing a browser drops its session and lets every feature release what it holds — one failing never blocks', () => {
  const reg = createSessionRegistry();
  const released = [];
  reg.onDrop(() => { throw new Error('boom'); });
  reg.onDrop((s) => released.push(s.runId));
  reg.get('BR-1').enter.timer = 'T';
  assert.equal(reg.drop('BR-1'), true);
  assert.deepEqual(released, ['BR-1']);
  assert.equal(reg.has('BR-1'), false);
  assert.equal(reg.drop('BR-1'), false, 'idempotent');
});

test('the recent-steps trail is bounded', () => {
  const reg = createSessionRegistry({ now: () => Date.UTC(2026, 9, 8, 10, 11, 12) });
  for (let i = 0; i < RECENT_MAX + 5; i++) reg.note('BR-1', 'E' + i);
  const r = reg.get('BR-1').recent;
  assert.equal(r.length, RECENT_MAX);
  assert.equal(r[r.length - 1], 'E' + (RECENT_MAX + 4) + '@10:11:12');
});

test('features run in order, a throwing / rejecting one is logged and never stops the next', async () => {
  const seen = []; const logs = [];
  const set = createFeatureSet({ off: new Set(), log: (e, d) => logs.push([e, d.feature, d.hook]), features: [
    { id: 'a', attach: () => seen.push('a') },
    { id: 'b', attach: () => { throw new Error('x'); } },
    { id: 'c', attach: async () => { seen.push('c'); throw new Error('later'); } },
    { id: 'd', attach: () => seen.push('d') },
  ] });
  set.attach({});
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['a', 'c', 'd']);
  assert.deepEqual(logs, [['feature-error', 'b', 'attach'], ['feature-error', 'c', 'attach']]);
});

test('a feature switched off (PHOM_FEATURES_OFF) gets no hook; its IPC is still registered (told it is off)', () => {
  const seen = []; const ipc = [];
  const set = createFeatureSet({ off: parseOff(' An-Danh , header '), features: [
    { id: 'an-danh', attach: () => seen.push('an-danh'), registerIpc: (h, o) => ipc.push(['an-danh', o.enabled]) },
    { id: 'capture', attach: () => seen.push('capture'), registerIpc: (h, o) => ipc.push(['capture', o.enabled]) },
  ] });
  set.attach({}); set.registerIpc(() => {});
  assert.deepEqual(seen, ['capture']);
  assert.deepEqual(ipc, [['an-danh', false], ['capture', true]]);
  assert.equal(set.enabled('AN-DANH'), false);
});

test('duplicate or anonymous features are refused at build time', () => {
  assert.throws(() => createFeatureSet({ features: [{ id: 'x' }, { id: 'x' }] }), /duplicate/);
  assert.throws(() => createFeatureSet({ features: [{}] }), /id/);
});

test('the installer ships the whole desktop/phom tree', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../electron-builder.phom.json', import.meta.url), 'utf8'));
  assert.ok(cfg.files.includes('desktop/phom/**/*'));
});

// ---- 3.2 phase 3: the coordinator and the table group are each ONE class split over files by concern ----
test('mixin: a part\'s methods land on the class (this = the instance); a method defined twice is refused at load', () => {
  const { mixin } = require('../../desktop/protocol/phom/mixin.cjs');
  class Core { constructor() { this.n = 1; } base() { return this.n; } }
  class Part { plus() { return this.base() + 1; } }
  mixin(Core, Part);
  assert.equal(new Core().plus(), 2);
  class Clash { base() { return 0; } }
  assert.throws(() => mixin(Core, Clash), /defined twice/);
});

test('the coordinator and the table group carry every part (and the installer ships them)', () => {
  const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
  const { TableGroup } = require('../../desktop/protocol/phom/table-group.cjs');
  for (const m of ['ingest', 'snapshot', 'joinTable', 'leaveTable', 'sendTableReady', 'findKeyTable', 'scanForKeyTable', 'cancelSearch']) assert.equal(typeof HostTableCoordinator.prototype[m], 'function', m);
  for (const m of ['pace', '_enqueue', 'findTable', 'scanTable', 'joinTable', 'rejoin', 'leave', 'setAuto', '_regroup', 'replaceMember', '_onSeats', '_readyCheck', '_onRoundEnd']) assert.equal(typeof TableGroup.prototype[m], 'function', m);
  const cfg = JSON.parse(readFileSync(new URL('../../electron-builder.phom.json', import.meta.url), 'utf8'));
  assert.ok(cfg.files.includes('desktop/protocol/phom/**/*'));
});
