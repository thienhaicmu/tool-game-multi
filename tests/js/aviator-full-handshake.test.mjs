import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const desc = require('../../desktop/protocol/aviator-entry-descriptor.cjs');
const { AviatorEntryGate } = require('../../desktop/protocol/aviator-entry.cjs');
const { AnalyticsAviatorEntryGate } = require('../../desktop/analytics/analytics-aviator-entry.cjs');
const { EntryOnlyTransport } = require('../../desktop/analytics/entry-only-transport.cjs');

const DESCRIPTOR = { gameActUrl: 'https://host.example/gwms/v1/game-act', gameId: 'vgmn_221' };
const LOBBY_FRAME = '["6","MiniGame","lobbyPlugin",{"cmd":10002}]';
const ENTER_FRAME = '["6","MiniGame","aviatorPlugin",{"cmd":100000}]';

// Execute the baked page hook in an isolated realm with a mocked fetch + WebSocket so we can
// observe the EXACT ordered operations the sealed handshake performs in the browser.
function runHook({ descriptor = DESCRIPTOR, wsHost = 'host.example', fetchImpl, socketSend } = {}) {
  const order = [];
  const sandbox = {};
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  sandbox.fetch = fetchImpl || (async (url, opts) => { order.push({ step: 'fetch', url, body: opts && opts.body, method: opts && opts.method, credentials: opts && opts.credentials }); return { ok: true, status: 200 }; });
  function WS() {}
  WS.prototype.send = function () {};
  sandbox.WebSocket = WS;
  const send = socketSend || ((data) => { order.push({ step: 'ws', data }); });
  sandbox.__wsoSocks = [{ readyState: 1, url: 'wss://host.example/game', send }];
  vm.createContext(sandbox);
  vm.runInContext(desc.buildEnterAviatorHook(descriptor, wsHost), sandbox);
  return { sandbox, order, call: () => vm.runInContext('globalThis.__avEnterAviator()', sandbox) };
}

// ---- T1: full ordered sequence game-act → 10002 → 100000 → ok ----
test('T1: hook performs game-act POST, THEN lobby 10002, THEN aviator 100000 — in order', async () => {
  const h = runHook();
  const res = await h.call();
  assert.equal(res.ok, true);
  assert.equal(h.order.length, 3);
  assert.equal(h.order[0].step, 'fetch');
  assert.equal(h.order[0].url, DESCRIPTOR.gameActUrl);
  assert.equal(h.order[0].method, 'POST');
  assert.equal(h.order[0].credentials, 'include', 'authenticated browser context (cookies attach)');
  assert.deepEqual(JSON.parse(h.order[0].body), { game_id: 'vgmn_221' });
  assert.equal(h.order[1].step, 'ws');
  assert.equal(h.order[1].data, LOBBY_FRAME, 'lobby 10002 second');
  assert.equal(h.order[2].step, 'ws');
  assert.equal(h.order[2].data, ENTER_FRAME, 'aviator 100000 third');
});

// ---- T5: game-act failure prevents BOTH WS sends ----
test('T5: game-act failure short-circuits — neither 10002 nor 100000 is sent', async () => {
  const h = runHook({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  const res = await h.call();
  assert.equal(res.ok, false);
  assert.equal(res.step, 'game-act');
  assert.equal(res.status, 503);
  assert.equal(h.order.filter((o) => o.step === 'ws').length, 0, 'no WS frame after a failed game-act');
});

test('T5b: game-act throwing (network/CORS) also prevents both WS sends', async () => {
  const h = runHook({ fetchImpl: async () => { throw new Error('CORS'); } });
  const res = await h.call();
  assert.equal(res.ok, false);
  assert.equal(res.step, 'game-act');
  assert.equal(h.order.filter((o) => o.step === 'ws').length, 0);
});

// ---- T6: 10002 failure prevents 100000 ----
test('T6: if the lobby 10002 send fails, the aviator 100000 is NOT sent', async () => {
  const sent = [];
  const h = runHook({ socketSend: (data) => { sent.push(data); if (data === LOBBY_FRAME) throw new Error('ws down'); } });
  const res = await h.call();
  assert.equal(res.ok, false);
  assert.equal(res.step, 'lobby-10002', 'stopped at the lobby step');
  assert.equal(sent.includes(ENTER_FRAME), false, '100000 never sent after 10002 failed');
});

// ---- T13: descriptor learning + validation (no arbitrary fetch url/body) ----
test('T13: parseGameActDescriptor learns ONLY a validated {gameActUrl, gameId} from real traffic', () => {
  const d = desc.parseGameActDescriptor('https://bodergatez.dsrcgoms.net/gwms/v1/game-act', '{"game_id":"vgmn_221"}');
  assert.deepEqual(d, { gameActUrl: 'https://bodergatez.dsrcgoms.net/gwms/v1/game-act', gameId: 'vgmn_221' });
  // Non game-act paths, bad game_id shapes, missing/extra structures → null (fail safe, no descriptor).
  assert.equal(desc.parseGameActDescriptor('https://x/steal', '{"game_id":"vgmn_221"}'), null);
  assert.equal(desc.parseGameActDescriptor('https://x/gwms/v1/game-act', '{"game_id":"a b"}'), null);
  assert.equal(desc.parseGameActDescriptor('https://x/gwms/v1/game-act', 'not-json'), null);
  assert.equal(desc.parseGameActDescriptor('https://x/gwms/v1/game-act', '{"other":1}'), null);
  assert.equal(desc.isValidDescriptor({ gameActUrl: 'https://x/steal', gameId: 'y' }), false);
  // buildEnterAviatorHook refuses to bake an invalid descriptor at all.
  assert.throws(() => desc.buildEnterAviatorHook({ gameActUrl: 'https://x/steal', gameId: 'y' }, 'h'));
});

// ---- runEnterAviatorHandshake seam: ok / no-descriptor / no-client ----
function fakeClient() {
  const exprs = [];
  return { exprs, Runtime: { evaluate: async ({ expression }) => { exprs.push(expression); return { result: { value: { ok: true } } }; } } };
}
test('runEnterAviatorHandshake evaluates the sealed hook then calls __avEnterAviator', async () => {
  const c = fakeClient();
  const res = await desc.runEnterAviatorHandshake(c, undefined, DESCRIPTOR, 'host.example');
  assert.deepEqual(res, { ok: true });
  assert.ok(c.exprs.some((e) => /__avEnterAviator\s*=/.test(e)), 'hook injected');
  assert.ok(c.exprs.some((e) => /__avEnterAviator\(\)/.test(e)), 'handshake invoked');
});
test('runEnterAviatorHandshake fails safe with no descriptor and with no client', async () => {
  const c = fakeClient();
  assert.equal((await desc.runEnterAviatorHandshake(c, undefined, null, 'h')).error.code, 'ENTER_NO_DESCRIPTOR');
  assert.equal(c.exprs.length, 0, 'nothing evaluated without a descriptor');
  assert.equal((await desc.runEnterAviatorHandshake(null, undefined, DESCRIPTOR, 'h')).error.code, 'ENTER_NO_CLIENT');
});

// ---- T2/T3/T4/T8: SENT != ENTERED for the handshake seam (Control gate) ----
function controlGate({ enter, evidenceCmd, timeoutMs = 30 } = {}) {
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
test('T2/T8: full handshake SEND alone does not enter — no server evidence → timeout, never entered', async () => {
  const { gate } = controlGate({ timeoutMs: 20 });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'AVIATOR_ENTRY_TIMEOUT');
  assert.equal(gate.isEntered(), false);
});
test('T3: fresh authoritative server round frame AFTER the handshake confirms ACTIVE', async () => {
  const { gate, bus } = controlGate({ timeoutMs: 1000 });
  const p = gate.ensureEntered();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(gate.isEntered(), false, 'not entered on send alone');
  bus.emit('frame', { direction: 'recv', cmd: 100005, sid: 7 });
  const res = await p;
  assert.equal(res.ready, true);
  assert.equal(gate.isEntered(), true);
});
test('T7: a handshake step failure (transport error) fails the attempt (bounded retry applies)', async () => {
  const { gate } = controlGate({ enter: () => ({ error: { code: 'ENTER_HANDSHAKE_FAILED', step: 'enter-100000' } }), timeoutMs: 1000 });
  const res = await gate.ensureEntered();
  assert.equal(res.error.code, 'ENTER_HANDSHAKE_FAILED');
  assert.equal(gate.isEntered(), false);
});

// ---- T15: per-browser descriptor isolation (no cross-contamination) ----
test('T15: each gate forwards its OWN learned descriptor to its OWN transport', async () => {
  const DA = { gameActUrl: 'https://a.example/gwms/v1/game-act', gameId: 'vgmn_221' };
  const DB = { gameActUrl: 'https://b.example/gwms/v1/game-act', gameId: 'vgmn_999' };
  const seen = { a: [], b: [] };
  const mk = (bucket, d) => new AnalyticsAviatorEntryGate({
    sendEntry: (ctx, desc2) => { seen[bucket].push(desc2); return Promise.resolve({ ok: true }); },
    getDescriptor: () => d,
    getContext: () => ({ targetId: bucket, cdpSessionId: 'S', host: 'h' }),
    now: () => 1000, timeoutMs: 50,
  });
  const ga = mk('a', DA); const gb = mk('b', DB);
  ga.requestEntry(); gb.requestEntry();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen.a, [DA], 'A used only A descriptor');
  assert.deepEqual(seen.b, [DB], 'B used only B descriptor');
});

// ---- T12: Analytics sealed transport surface — only sendEntry, no wager/arbitrary ops ----
test('T12: EntryOnlyTransport exposes ONLY sendEntry (no bet/cashout/arbitrary send/fetch method)', () => {
  const t = new EntryOnlyTransport({ resolveClient: () => null });
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(t)).filter((n) => n !== 'constructor');
  assert.deepEqual(proto.sort(), ['sendEntry']);
});
