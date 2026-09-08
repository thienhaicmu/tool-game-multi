import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const desc = require('../../desktop/protocol/aviator-entry-descriptor.cjs');
const { AviatorEntryGate } = require('../../desktop/protocol/aviator-entry.cjs');
const { AnalyticsAviatorEntryGate } = require('../../desktop/analytics/analytics-aviator-entry.cjs');
const { EntryOnlyTransport } = require('../../desktop/analytics/entry-only-transport.cjs');

const DESCRIPTOR = { gameActUrl: 'https://host.example/gwms/v1/game-act', gameId: 'vgmn_221' };

// Execute the sealed page hook in an isolated realm with a mocked window.__require + a fake
// LobbyViewController, so we observe the EXACT resolve-before-invoke behaviour.
function runHook({ descriptor = DESCRIPTOR, module: mod, noRequire = false } = {}) {
  const calls = [];
  const sandbox = {}; sandbox.globalThis = sandbox; sandbox.console = console;
  if (!noRequire) {
    const modules = { LobbyViewController: mod === undefined ? defaultModule(calls) : mod };
    sandbox.__require = (name) => { if (name in modules) { if (modules[name] === 'THROW') throw new Error('boom'); return modules[name]; } throw new Error('no module ' + name); };
  }
  vm.createContext(sandbox);
  vm.runInContext(desc.buildEnterAviatorHook(descriptor), sandbox);
  const val = vm.runInContext('globalThis.__avEnterAviator()', sandbox);
  return { val, calls };
}
// Fake LobbyViewController: default.Instance.onClickIConGame(t,e) + gameLaunchHandler.mapClickLobby,
// a CUSTOM map with .get/.set only (NO .has/.size — matches the live client). `tile` controls
// whether mapClickLobby.get(gameId) returns a value.
function defaultModule(calls, { hasInstance = true, hasMethod = true, tile = true, hasMap = true } = {}) {
  const glh = { launchSceneGame: () => {}, mapClickLobby: hasMap ? { get: (id) => (tile && id === 'vgmn_221' ? { node: {}, sceneName: 's' } : null), set: () => {} } : undefined };
  const inst = { gameLaunchHandler: glh };
  if (hasMethod) inst.onClickIConGame = (t, e) => { calls.push({ t, e }); };
  return { default: { Instance: hasInstance ? inst : null } };
}

// ---- 1: exact accessor resolution + invoke once with the learned gameId ----
test('T1: resolves __require("LobbyViewController").default.Instance.onClickIConGame and invokes it once (null, gameId)', () => {
  const h = runHook();
  assert.equal(h.val.ok, true);
  assert.equal(h.val.invoked, true);
  assert.equal(h.val.resolve.requireAvailable, true);
  assert.equal(h.val.resolve.moduleResolved, true);
  assert.equal(h.val.resolve.instanceResolved, true);
  assert.equal(h.val.resolve.methodResolved, true);
  assert.equal(h.val.resolve.tileRegistered, true);
  assert.equal(h.calls.length, 1, 'invoked exactly once');
  assert.equal(h.calls[0].t, null, 'first arg is null (unused by the site)');
  assert.equal(h.calls[0].e, 'vgmn_221', 'invoked with the baked learned gameId');
});

// ---- 2: resolve-before-invoke fails safe at every missing step; NOTHING invoked ----
test('T2: missing __require => no-require, invokes nothing', () => {
  const h = runHook({ noRequire: true });
  assert.equal(h.val.ok, false); assert.equal(h.val.step, 'no-require');
  assert.equal(h.val.resolve.requireAvailable, false);
  assert.equal(h.calls.length, 0);
});
test('T2: __require throws for module => no-module, invokes nothing', () => {
  const h = runHook({ module: 'THROW' });
  assert.equal(h.val.ok, false); assert.equal(h.val.step, 'no-module');
  assert.equal(h.val.resolve.requireAvailable, true);
  assert.equal(h.calls.length, 0);
});
test('T2: no module.default => no-default, invokes nothing', () => {
  const h = runHook({ module: {} });
  assert.equal(h.val.ok, false); assert.equal(h.val.step, 'no-default');
  assert.equal(h.calls.length, 0);
});
test('T2: no instance => no-instance, invokes nothing', () => {
  const calls = [];
  const h = runHook({ module: defaultModule(calls, { hasInstance: false }) });
  assert.equal(h.val.ok, false); assert.equal(h.val.step, 'no-instance');
  assert.equal(h.val.resolve.moduleResolved, true);
  assert.equal(h.calls.length, 0);
});
test('T2: method missing => no-method, invokes nothing', () => {
  const calls = [];
  const h = runHook({ module: defaultModule(calls, { hasMethod: false }) });
  assert.equal(h.val.ok, false); assert.equal(h.val.step, 'no-method');
  assert.equal(h.val.resolve.instanceResolved, true);
  assert.equal(h.val.resolve.methodResolved, false);
  assert.equal(h.calls.length, 0);
});
test('T2: Aviator tile NOT registered => tile-not-registered, invokes nothing', () => {
  const calls = [];
  const h = runHook({ module: defaultModule(calls, { tile: false }) });
  assert.equal(h.val.ok, false); assert.equal(h.val.step, 'tile-not-registered');
  assert.equal(h.val.resolve.methodResolved, true);
  assert.equal(h.val.resolve.tileRegistered, false);
  assert.equal(h.calls.length, 0);
});

// ---- 5 & 6: the sealed hook performs NO fetch and sends NO WS frame itself ----
test('T5/T6: the built hook contains NO fetch, NO game-act, and NO direct 10002/100000/plugin sends', () => {
  const hook = desc.buildEnterAviatorHook(DESCRIPTOR);
  assert.equal(/fetch\s*\(/.test(hook), false, 'no fetch in the sealed hook');
  assert.equal(/game-act/.test(hook), false, 'no game-act in the sealed hook');
  assert.equal(/lobbyPlugin|aviatorPlugin/.test(hook), false, 'no plugin frame construction');
  assert.equal(/\b10002\b|\b100000\b|\b100002\b|\b100003\b/.test(hook), false, 'no cmd literals');
  assert.equal(/X-TOKEN|X-FG-ID|session_id/i.test(hook), false, 'no secret/header handling');
  assert.ok(/onClickIConGame/.test(hook) && /LobbyViewController/.test(hook) && hook.includes('vgmn_221'));
});
test('T5b: the recovery graph retired the hand-crafted game-act fetch (module source has no fetch)', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'desktop', 'protocol', 'aviator-entry-descriptor.cjs'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/fetch\s*\(/.test(stripped), false, 'no fetch( anywhere in the seam');
  assert.equal(/credentials\s*:/.test(stripped), false, 'no credentialed request construction');
});

// ---- runEnterAviatorViaSite seam: ok, diag facts, fail-safe codes ----
function fakeClient(value) {
  const exprs = [];
  return { exprs, Runtime: { evaluate: async ({ expression }) => { exprs.push(expression); return { result: { value } }; } } };
}
test('T4: runEnterAviatorViaSite invokes the sealed op once and surfaces ONLY non-secret resolve facts', async () => {
  const facts = [];
  const c = fakeClient({ ok: true, invoked: true, resolve: { requireAvailable: true, moduleResolved: true, instanceResolved: true, methodResolved: true, tileRegistered: true } });
  const res = await desc.runEnterAviatorViaSite(c, undefined, DESCRIPTOR, (f) => facts.push(f));
  assert.equal(res.ok, true);
  assert.ok(c.exprs.some((e) => /__avEnterAviator\s*=/.test(e)) && c.exprs.some((e) => /__avEnterAviator\(\)/.test(e)));
  const resolve = facts.find((f) => f.event === 'SITE_ENTRY_SEAM_RESOLVE');
  assert.ok(resolve && resolve.methodResolved === true && resolve.tileRegistered === true);
  assert.ok(facts.some((f) => f.event === 'SITE_ENTRY_INVOKED'));
  // Non-secret only: the diag facts carry no page object/token/session fields.
  assert.deepEqual(Object.keys(resolve).sort(), ['event', 'instanceResolved', 'methodResolved', 'moduleResolved', 'requireAvailable', 'tileRegistered']);
});
test('T3: no learned gameId => ENTER_NO_DESCRIPTOR, nothing evaluated', async () => {
  const c = fakeClient({ ok: true });
  assert.equal((await desc.runEnterAviatorViaSite(c, undefined, null)).error.code, 'ENTER_NO_DESCRIPTOR');
  assert.equal(c.exprs.length, 0);
  assert.equal((await desc.runEnterAviatorViaSite(null, undefined, DESCRIPTOR)).error.code, 'ENTER_NO_CLIENT');
});
test('resolve-gate failure => ENTRY_SITE_SEAM_UNAVAILABLE with the failed step (no invoke, no fallback)', async () => {
  const facts = [];
  const c = fakeClient({ ok: false, step: 'no-method', resolve: { requireAvailable: true, moduleResolved: true, instanceResolved: true, methodResolved: false, tileRegistered: null } });
  const res = await desc.runEnterAviatorViaSite(c, undefined, DESCRIPTOR, (f) => facts.push(f));
  assert.equal(res.error.code, 'ENTRY_SITE_SEAM_UNAVAILABLE');
  assert.equal(res.error.step, 'no-method');
  assert.ok(facts.some((f) => f.event === 'SITE_ENTRY_SEAM_RESOLVE' && f.methodResolved === false));
  assert.equal(facts.some((f) => f.event === 'SITE_ENTRY_INVOKED'), false, 'never logs INVOKED when a check failed');
});

// ---- 3: descriptor learning + validation (no arbitrary gameId) ----
test('descriptor learns/validates ONLY a real game-act game_id (fail safe otherwise)', () => {
  assert.deepEqual(desc.parseGameActDescriptor('https://x/gwms/v1/game-act', '{"game_id":"vgmn_221"}'), { gameActUrl: 'https://x/gwms/v1/game-act', gameId: 'vgmn_221' });
  assert.equal(desc.parseGameActDescriptor('https://x/steal', '{"game_id":"vgmn_221"}'), null);
  assert.equal(desc.parseGameActDescriptor('https://x/gwms/v1/game-act', '{"game_id":"a b"}'), null);
  assert.equal(desc.isValidDescriptor({ gameId: 'vgmn_221' }), false);
  assert.throws(() => desc.buildEnterAviatorHook({ gameActUrl: 'https://x/steal', gameId: 'y' }));
});

// ---- 7/8/9: SENT != ENTERED via the Control gate over the site-open seam ----
function controlGate({ enter, timeoutMs = 30 } = {}) {
  const bus = new (require('node:events').EventEmitter)();
  const captured = [];
  const gate = new AviatorEntryGate({
    roundTracker: bus,
    enterAviator: (ctx, d) => { captured.push(d); return Promise.resolve(enter ? enter() : { ok: true }); },
    getDescriptor: () => DESCRIPTOR,
    getContext: () => ({ targetId: 'T', cdpSessionId: 'S', host: 'h' }),
    timeoutMs,
  });
  return { gate, bus, captured };
}
test('T7: site-open invocation alone does NOT mark entered — times out without server evidence', async () => {
  const { gate } = controlGate({ timeoutMs: 20 });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'AVIATOR_ENTRY_TIMEOUT');
  assert.equal(gate.isEntered(), false);
});
test('T9: fresh authoritative server round frame AFTER the attempt confirms ACTIVE', async () => {
  const { gate, bus, captured } = controlGate({ timeoutMs: 1000 });
  const p = gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(gate.isEntered(), false);
  assert.deepEqual(captured[0], DESCRIPTOR, 'gate forwarded the learned descriptor to the site-open seam');
  bus.emit('frame', { direction: 'recv', cmd: 100005, sid: 7 });
  const res = await p;
  assert.equal(res.ready, true);
  assert.equal(gate.isEntered(), true);
});
test('T10(bounded): a resolve-gate failure fails the attempt (bounded retry/escalation applies)', async () => {
  const { gate } = controlGate({ enter: () => ({ error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', step: 'no-method' } }), timeoutMs: 1000 });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'ENTRY_SITE_SEAM_UNAVAILABLE');
  assert.equal(gate.isEntered(), false);
});

// ---- 13/14: sealed surface + per-browser isolation ----
test('T13: EntryOnlyTransport exposes ONLY sendEntry (no bet/cashout/fetch/eval/send method)', () => {
  const t = new EntryOnlyTransport({ resolveClient: () => null });
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(t)).filter((n) => n !== 'constructor');
  assert.deepEqual(proto.sort(), ['sendEntry']);
});
test('T14: each browser forwards its OWN learned gameId; no cross-contamination', async () => {
  const DA = { gameActUrl: 'https://a/gwms/v1/game-act', gameId: 'vgmn_221' };
  const DB = { gameActUrl: 'https://b/gwms/v1/game-act', gameId: 'vgmn_999' };
  const seen = { a: [], b: [] };
  const mk = (bucket, d) => new AnalyticsAviatorEntryGate({
    sendEntry: (ctx, d2) => { seen[bucket].push(d2); return Promise.resolve({ ok: true }); },
    getDescriptor: () => d,
    getContext: () => ({ targetId: bucket, cdpSessionId: 'S', host: 'h' }),
    now: () => 1000, timeoutMs: 50,
  });
  mk('a', DA).requestEntry(); mk('b', DB).requestEntry();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen.a, [DA]);
  assert.deepEqual(seen.b, [DB]);
});
