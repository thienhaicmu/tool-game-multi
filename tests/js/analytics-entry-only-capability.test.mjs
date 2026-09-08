import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { EntryOnlyTransport, ENTER_FRAME, ENTER_ENVELOPE } = require('../../desktop/analytics/entry-only-transport.cjs');
const { AnalyticsAviatorEntryGate } = require('../../desktop/analytics/analytics-aviator-entry.cjs');
const { AnalyticsRuntime } = require('../../desktop/analytics/analytics-runtime.cjs');

// A fake CDP client that records every Runtime.evaluate expression. The sealed handshake resolves
// to { ok:true } (the shared seam checks value.ok === true), so the fake returns that shape.
function fakeClient() {
  const exprs = [];
  return {
    exprs,
    Page: { addScriptToEvaluateOnNewDocument: async () => ({}) },
    Runtime: { evaluate: async ({ expression }) => { exprs.push(expression); return { result: { value: { ok: true } } }; } },
  };
}
// A learned, validated game-act descriptor (never caller-supplied in production).
const DESCRIPTOR = { gameActUrl: 'https://host.example/gwms/v1/game-act', gameId: 'vgmn_221' };

test('the fixed enter frame is exactly the observed website request (no sid/aid/eid/odd/bet added)', () => {
  assert.equal(ENTER_FRAME, '["6","MiniGame","aviatorPlugin",{"cmd":100000}]');
  assert.deepEqual(ENTER_ENVELOPE, ['6', 'MiniGame', 'aviatorPlugin', { cmd: 100000 }]);
});

test('EntryOnlyTransport exposes ONLY sendEntry as a wire op (no send/sendRaw/sendProtocol/bet/cashout)', () => {
  const t = new EntryOnlyTransport({ resolveClient: () => null });
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(t));
  const wireish = proto.filter((n) => /send|replay|bet|cashout|protocol|raw|frame/i.test(n));
  assert.deepEqual(wireish.sort(), ['sendEntry'], 'the only wire method must be sendEntry');
});

test('sendEntry runs ONLY the sealed site-open (onClickBaseMiniGameNode) — no wager cmds, no fetch, no frames', async () => {
  const client = fakeClient();
  const t = new EntryOnlyTransport({ resolveClient: () => client });
  // Caller tries to smuggle a payload/cmd — extra ctx fields must be ignored entirely.
  const res = await t.sendEntry({ targetId: 'T1', cdpSessionId: 'S1', host: 'game.example', payload: 'BET', cmd: 100002 }, DESCRIPTOR);
  assert.equal(res.ok, true);
  const evalExprs = client.exprs.join('\n');
  assert.ok(/__avEnterAviator/.test(evalExprs), 'must call the sealed entry function');
  assert.equal(/100002|100003|BET|CASHOUT/.test(evalExprs), false, 'must never reference wager cmds/payloads');
  // The baked hook resolves + invokes the SITE's own entry with the learned gameId — it never fetches
  // or constructs a frame itself (the site owns game-act / 10002 / 100000, with its own auth).
  const hookExpr = client.exprs.find((e) => /__avEnterAviator\s*=/.test(e));
  assert.ok(hookExpr, 'a hook expression that defines __avEnterAviator is injected');
  assert.ok(/onClickIConGame/.test(hookExpr) && /LobbyViewController/.test(hookExpr), 'hook resolves the site entry accessor');
  assert.ok(hookExpr.includes('vgmn_221'), 'hook bakes the learned gameId');
  assert.equal(/fetch\s*\(/.test(hookExpr), false, 'no hand-crafted fetch in the sealed hook');
  assert.equal(/game-act|lobbyPlugin|aviatorPlugin|X-TOKEN|X-FG-ID/i.test(hookExpr), false, 'no game-act/frame/secret handling');
});

test('sendEntry without a learned descriptor fails safe — nothing is put on the wire', async () => {
  const client = fakeClient();
  const t = new EntryOnlyTransport({ resolveClient: () => client });
  const res = await t.sendEntry({ targetId: 'T1', cdpSessionId: 'S1', host: 'game.example' }, null);
  assert.equal(res.ok, undefined);
  assert.equal(res.error.code, 'ANALYTICS_ENTRY_NO_DESCRIPTOR');
  assert.equal(client.exprs.length, 0, 'no hook injected, no handshake evaluated');
});

test('sendEntry rejects a caller-supplied non-game-act / bad descriptor (no arbitrary fetch)', async () => {
  const client = fakeClient();
  const t = new EntryOnlyTransport({ resolveClient: () => client });
  for (const bad of [
    { gameActUrl: 'https://evil.example/steal', gameId: 'vgmn_221' },     // not a game-act path
    { gameActUrl: 'https://host.example/gwms/v1/game-act', gameId: 'a b' }, // invalid game_id shape
    { gameActUrl: 'https://host.example/gwms/v1/game-act' },                // missing game_id
  ]) {
    const res = await t.sendEntry({ targetId: 'T1', cdpSessionId: 'S1', host: 'game.example' }, bad);
    assert.equal(res.error.code, 'ANALYTICS_ENTRY_NO_DESCRIPTOR');
  }
  assert.equal(client.exprs.length, 0, 'no handshake evaluated for any invalid descriptor');
});

test('no eligible socket => sendEntry fails cleanly (never sends blindly)', async () => {
  const t = new EntryOnlyTransport({ resolveClient: () => null });
  const res = await t.sendEntry({ targetId: null }, DESCRIPTOR);
  assert.ok(res.error);
  assert.equal(res.ok, undefined);
});

test('AnalyticsAviatorEntryGate.requestEntry takes NO payload — caller cannot influence the wire', async () => {
  const sent = [];
  const gate = new AnalyticsAviatorEntryGate({
    sendEntry: (ctx) => { sent.push(ctx); return Promise.resolve({ ok: true }); },
    getContext: () => ({ targetId: 'T1', cdpSessionId: 'S1', host: 'h' }),
    now: () => 1000,
    timeoutMs: 50,
  });
  // Any argument passed is ignored (arity 0); the transport receives only the resolved ctx.
  gate.requestEntry({ cmd: 100002, payload: 'BET' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent.length, 1);
  assert.equal('cmd' in sent[0], false, 'ctx forwarded to transport carries no cmd/payload');
  assert.equal('payload' in sent[0], false);
});

test('the Analytics preload exposes NO send/enter/bet/cashout/protocol channel (renderer stays passive)', () => {
  const src = fs.readFileSync(path.resolve(process.cwd(), 'desktop', 'analytics-preload.cjs'), 'utf8');
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/sendProtocol|sendRaw|wsSend|\bbet\b|\bcashout\b|requestAviatorEntry|sendEntry|ipcRenderer\.invoke\(\s*['"][^'"]*(send|enter|bet|cashout)/i.test(noComments), false,
    'preload must not expose any protocol-send / entry channel');
});

test('AnalyticsRuntime exposes NO generic sender method (recovery is automatic, main-owned)', () => {
  const registry = { list: () => [], get: () => null };
  const inapp = { partitionFor: () => 'p', launcher: () => ({}), targetManager: () => ({ on() {}, start() {} }) };
  const capture = { on() {}, getResponseBody: async () => ({}) };
  const rt = new AnalyticsRuntime({ registry, inappRuntime: inapp, capture });
  for (const name of ['sendProtocol', 'sendRaw', 'wsSend', 'replay', 'bet', 'cashout', 'requestAviatorEntry', 'sendEntry']) {
    assert.equal(typeof rt[name], 'undefined', `AnalyticsRuntime must not expose ${name}`);
  }
});
