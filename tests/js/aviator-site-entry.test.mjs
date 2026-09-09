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
const KNOWN_PATH = 'Canvas/MainUIParent/NewLobby/Main/ScrollView/view/Content/NodeSpines/vgmn_221';

// Build a fake live Cocos `cc` for the sandbox. Scenarios control how the Aviator node resolves,
// mirroring the LIVE-PROVEN operation: cc.find(known path) OR a bounded scene search for a node
// named GID that carries a cc.Button, then emitEvents(btn.clickEvents,node) + node.emit('click').
function makeCC({ pathHit = true, sceneNode = false, nodeHasButton = true, hasClickEvents = true,
  noCc = false, noDirector = false, noEmitter = false, depth = 3 } = {}) {
  const calls = { emitEvents: [], emit: [] };
  if (noCc) return { cc: undefined, calls };
  function Button() {}
  const mkNode = (name, hasBtn) => {
    const btn = hasBtn ? { clickEvents: hasClickEvents ? [1, 2, 3] : undefined } : null;
    const n = { name, children: [] };
    n.getComponent = (T) => (T === Button ? btn : null);
    n.emit = (ev) => calls.emit.push({ ev, name });
    return n;
  };
  const aviator = (pathHit || sceneNode) ? mkNode('vgmn_221', nodeHasButton) : null;
  const scene = mkNode('Scene', false);
  if (aviator && sceneNode) {
    let cur = scene;
    for (let i = 0; i < depth; i++) { const c = mkNode('lvl' + i, false); cur.children.push(c); cur = c; }
    cur.children.push(aviator);
  }
  const pathMap = new Map();
  if (aviator && pathHit) pathMap.set(KNOWN_PATH, aviator);
  const cc = {
    Button,
    find: (p) => pathMap.get(p) || null,
    director: noDirector ? {} : { getScene: () => scene },
    Component: noEmitter ? {} : { EventHandler: { emitEvents: (evts, node) => calls.emitEvents.push({ count: evts && evts.length, name: node && node.name }) } },
  };
  return { cc, calls };
}

// Execute the sealed page hook in an isolated realm with a mocked `cc`, so we observe the EXACT
// resolve-before-invoke behaviour and the proven double event invocation.
function runHook({ descriptor = DESCRIPTOR, ...scenario } = {}) {
  const { cc, calls } = makeCC(scenario);
  const sandbox = {}; sandbox.globalThis = sandbox; sandbox.console = console; sandbox.cc = cc;
  vm.createContext(sandbox);
  vm.runInContext(desc.buildEnterAviatorHook(descriptor), sandbox);
  const val = vm.runInContext('globalThis.__avEnterAviator()', sandbox);
  return { val, calls };
}

// ---- 1: known-path resolution + the LIVE-PROVEN double click invocation ----
test('T1: resolves the known NewLobby Cocos path and fires BOTH proven click calls once', () => {
  const h = runHook();
  assert.equal(h.val.ok, true);
  assert.equal(h.val.invoked, true);
  assert.equal(h.val.resolve.ccAvailable, true);
  assert.equal(h.val.resolve.directorAvailable, true);
  assert.equal(h.val.resolve.nodeResolved, true);
  assert.equal(h.val.resolve.buttonResolved, true);
  assert.equal(h.val.resolve.resolvedBy, 'path');
  // Proven operation: emitEvents(btn.clickEvents, node) THEN node.emit('click', btn) — both, once.
  assert.equal(h.calls.emitEvents.length, 1);
  assert.equal(h.calls.emitEvents[0].count, 3);       // btn.clickEvents.length (live had 3)
  assert.equal(h.calls.emitEvents[0].name, 'vgmn_221');
  assert.equal(h.calls.emit.length, 1);
  assert.equal(h.calls.emit[0].ev, 'click');
  assert.equal(h.calls.emit[0].name, 'vgmn_221');
});

// ---- 2: bounded live-scene fallback finds name===GID + cc.Button ----
test('T2: when the known path is absent, the bounded scene search finds vgmn_221 + cc.Button', () => {
  const h = runHook({ pathHit: false, sceneNode: true, depth: 4 });
  assert.equal(h.val.ok, true);
  assert.equal(h.val.resolve.resolvedBy, 'scene');
  assert.equal(h.calls.emitEvents.length, 1);
  assert.equal(h.calls.emit.length, 1);
});

// ---- 3: a same-name node WITHOUT cc.Button is rejected (fail closed, nothing fired) ----
test('T3: same-name node without cc.Button is rejected => node-not-found, invokes nothing', () => {
  const h = runHook({ pathHit: false, sceneNode: true, nodeHasButton: false });
  assert.equal(h.val.ok, false);
  assert.equal(h.val.step, 'node-not-found');
  assert.equal(h.val.resolve.nodeResolved, false);
  assert.equal(h.calls.emitEvents.length, 0);
  assert.equal(h.calls.emit.length, 0);
});

// ---- 4/5: missing cc / missing director fail closed ----
test('T4: missing cc (or missing emitter) fails closed => no-cc, invokes nothing', () => {
  const h1 = runHook({ noCc: true });
  assert.equal(h1.val.ok, false);
  assert.equal(h1.val.step, 'no-cc');
  assert.equal(h1.val.resolve.ccAvailable, false);
  const h2 = runHook({ noEmitter: true });
  assert.equal(h2.val.step, 'no-cc');                 // emitEvents unavailable is part of the cc gate
  assert.equal(h2.calls.emitEvents.length, 0);
});
test('T5: missing cc.director fails closed => no-director, invokes nothing', () => {
  const h = runHook({ noDirector: true });
  assert.equal(h.val.ok, false);
  assert.equal(h.val.step, 'no-director');
  assert.equal(h.val.resolve.directorAvailable, false);
});
test('T5c: a node without btn.clickEvents fails closed => no-clickevents, invokes nothing', () => {
  const h = runHook({ hasClickEvents: false });
  assert.equal(h.val.ok, false);
  assert.equal(h.val.step, 'no-clickevents');
  assert.equal(h.calls.emitEvents.length, 0);
});
test('T5d: the scene search is depth-bounded (a node nested past the cap is not found)', () => {
  const h = runHook({ pathHit: false, sceneNode: true, depth: 15 });
  assert.equal(h.val.ok, false);
  assert.equal(h.val.step, 'node-not-found');
});

// ---- 6: the built hook performs NO fetch, NO frame send, NO coordinate click ----
test('T6: the built hook contains NO fetch/game-act/plugin/cmd/secret and NO coordinate click', () => {
  const hook = desc.buildEnterAviatorHook(DESCRIPTOR);
  assert.equal(/fetch\s*\(/.test(hook), false, 'no fetch in the sealed hook');
  assert.equal(/game-act/.test(hook), false, 'no game-act in the sealed hook');
  assert.equal(/lobbyPlugin|aviatorPlugin/.test(hook), false, 'no plugin frame construction');
  assert.equal(/\b10002\b|\b100000\b|\b100002\b|\b100003\b/.test(hook), false, 'no cmd literals');
  assert.equal(/X-TOKEN|X-FG-ID|session_id/i.test(hook), false, 'no secret/header handling');
  assert.equal(/dispatchEvent|elementFromPoint|clientX|screenX|mousedown|touchstart/i.test(hook), false, 'no coordinate/DOM click');
  // It IS the proven Cocos operation, baked with the learned gameId + known path.
  assert.ok(/cc\.find/.test(hook), 'resolves via cc.find');
  assert.ok(hook.includes('vgmn_221'), 'bakes the learned gameId (== node name)');
  assert.ok(hook.includes('NodeSpines/vgmn_221'), 'bakes the known NewLobby path');
  assert.ok(/emitEvents/.test(hook) && /clickEvents/.test(hook), 'fires the wired click handlers');
  assert.ok(/emit\('click'|emit\("click"/.test(hook), 'fires the node click event');
  assert.ok(/getComponent/.test(hook) && /cc\.Button|Button\)/.test(hook), 'requires a cc.Button');
});
test('T6b: the module source has no fetch / credentialed request anywhere', () => {
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
test('T7: runEnterAviatorViaSite runs the sealed op once and surfaces ONLY non-secret resolve facts', async () => {
  const facts = [];
  const c = fakeClient({ ok: true, invoked: true, resolve: { ccAvailable: true, directorAvailable: true, nodeResolved: true, buttonResolved: true, resolvedBy: 'path' } });
  const res = await desc.runEnterAviatorViaSite(c, undefined, DESCRIPTOR, (f) => facts.push(f));
  assert.equal(res.ok, true);
  assert.ok(c.exprs.some((e) => /__avEnterAviator\s*=/.test(e)) && c.exprs.some((e) => /__avEnterAviator\(\)/.test(e)));
  const resolve = facts.find((f) => f.event === 'COCOS_ENTRY_SEAM_RESOLVE');
  assert.ok(resolve && resolve.nodeResolved === true && resolve.buttonResolved === true && resolve.resolvedBy === 'path');
  assert.ok(facts.some((f) => f.event === 'COCOS_ENTRY_INVOKED'));
  // Non-secret only: the diag facts carry no page object/token/session fields.
  assert.deepEqual(Object.keys(resolve).sort(), ['buttonResolved', 'ccAvailable', 'directorAvailable', 'event', 'fallbackGameId', 'nodeResolved', 'resolvedBy']);
  // A genuinely learned descriptor is NOT a fallback.
  assert.equal(resolve.fallbackGameId, false);
});
test('T8: no learned gameId => falls back to the baked known Aviator gameId and still resolves; no client => ENTER_NO_CLIENT', async () => {
  // First entry (null descriptor) no longer fails ENTER_NO_DESCRIPTOR — it uses the baked known
  // gameId, fires the SAME sealed op, and flags fallbackGameId:true for diagnostics.
  const facts = [];
  const c = fakeClient({ ok: true, invoked: true, resolve: { ccAvailable: true, directorAvailable: true, nodeResolved: true, buttonResolved: true, resolvedBy: 'scene' } });
  const res = await desc.runEnterAviatorViaSite(c, undefined, null, (f) => facts.push(f));
  assert.equal(res.ok, true, 'first entry proceeds via the baked known gameId');
  assert.ok(c.exprs.some((e) => /__avEnterAviator\s*=/.test(e)), 'the sealed hook was installed');
  const resolve = facts.find((f) => f.event === 'COCOS_ENTRY_SEAM_RESOLVE');
  assert.equal(resolve.fallbackGameId, true, 'flagged as a baked-gameId fallback');
  // The baked node name is exactly the known Aviator tile — never an arbitrary/empty one.
  assert.equal(desc.KNOWN_AVIATOR_GAME_ID, 'vgmn_221');
  // No client is still a hard fail (nothing to drive).
  assert.equal((await desc.runEnterAviatorViaSite(null, undefined, DESCRIPTOR)).error.code, 'ENTER_NO_CLIENT');
});
test('T8b: an empty/garbage gameId is still rejected (no arbitrary/unnamed node search)', () => {
  assert.throws(() => desc.buildEnterAviatorHook({ gameId: '' }));
  assert.throws(() => desc.buildEnterAviatorHook({ gameId: 'a b' }));
  assert.throws(() => desc.buildEnterAviatorHook(null));
  assert.equal(desc.isValidGameId('vgmn_221'), true);
});
test('resolve-gate failure => ENTRY_SITE_SEAM_UNAVAILABLE with the failed step (no invoke, no fallback)', async () => {
  const facts = [];
  const c = fakeClient({ ok: false, step: 'node-not-found', resolve: { ccAvailable: true, directorAvailable: true, nodeResolved: false, buttonResolved: false, resolvedBy: null } });
  const res = await desc.runEnterAviatorViaSite(c, undefined, DESCRIPTOR, (f) => facts.push(f));
  assert.equal(res.error.code, 'ENTRY_SITE_SEAM_UNAVAILABLE');
  assert.equal(res.error.step, 'node-not-found');
  assert.ok(facts.some((f) => f.event === 'COCOS_ENTRY_SEAM_RESOLVE' && f.nodeResolved === false));
  assert.equal(facts.some((f) => f.event === 'COCOS_ENTRY_INVOKED'), false, 'never logs INVOKED when a check failed');
});

// ---- descriptor learning + validation (no arbitrary gameId / node) ----
test('descriptor learns/validates ONLY a real game-act game_id (fail safe otherwise)', () => {
  assert.deepEqual(desc.parseGameActDescriptor('https://x/gwms/v1/game-act', '{"game_id":"vgmn_221"}'), { gameActUrl: 'https://x/gwms/v1/game-act', gameId: 'vgmn_221' });
  assert.equal(desc.parseGameActDescriptor('https://x/steal', '{"game_id":"vgmn_221"}'), null);
  assert.equal(desc.parseGameActDescriptor('https://x/gwms/v1/game-act', '{"game_id":"a b"}'), null);
  assert.equal(desc.isValidDescriptor({ gameId: 'vgmn_221' }), false);
  // LEARNING still requires a real game-act origin (isValidDescriptor), but the click hook needs
  // only a valid gameId (a learned one or the baked known fallback); a garbage gameId is rejected.
  assert.throws(() => desc.buildEnterAviatorHook({ gameActUrl: 'https://x/steal', gameId: 'a b' }));
});

// ---- INVOKED != ENTERED via the Control gate over the sealed Cocos seam ----
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
test('T-invoked-not-active: a successful click alone does NOT mark entered — times out without server evidence', async () => {
  const { gate } = controlGate({ timeoutMs: 20 });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'AVIATOR_ENTRY_TIMEOUT');
  assert.equal(gate.isEntered(), false);
});
test('T-fresh-active: fresh authoritative server round frame AFTER the attempt confirms ACTIVE', async () => {
  const { gate, bus, captured } = controlGate({ timeoutMs: 1000 });
  const p = gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(gate.isEntered(), false);
  assert.deepEqual(captured[0], DESCRIPTOR, 'gate forwarded the learned descriptor to the sealed seam');
  bus.emit('frame', { direction: 'recv', cmd: 100005, sid: 7 });
  const res = await p;
  assert.equal(res.ready, true);
  assert.equal(gate.isEntered(), true);
});
test('T-bounded: a resolve-gate failure fails the attempt (bounded retry/escalation applies)', async () => {
  const { gate } = controlGate({ enter: () => ({ error: { code: 'ENTRY_SITE_SEAM_UNAVAILABLE', step: 'node-not-found' } }), timeoutMs: 1000 });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'ENTRY_SITE_SEAM_UNAVAILABLE');
  assert.equal(gate.isEntered(), false);
});

// ---- sealed surface + per-browser isolation ----
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
