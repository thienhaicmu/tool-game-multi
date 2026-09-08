import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { EntryOnlyTransport, ENTER_FRAME, ENTER_ENVELOPE } = require('../../desktop/analytics/entry-only-transport.cjs');
const { AnalyticsAviatorEntryGate } = require('../../desktop/analytics/analytics-aviator-entry.cjs');
const { AnalyticsRuntime } = require('../../desktop/analytics/analytics-runtime.cjs');

// A fake CDP client that records every Runtime.evaluate expression.
function fakeClient() {
  const exprs = [];
  return {
    exprs,
    Page: { addScriptToEvaluateOnNewDocument: async () => ({}) },
    Runtime: { evaluate: async ({ expression }) => { exprs.push(expression); return { result: { value: true } }; } },
  };
}

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

test('sendEntry emits ONLY the sealed __avEnterAviator call — never arbitrary payload or wager cmds', async () => {
  const client = fakeClient();
  const t = new EntryOnlyTransport({ resolveClient: () => client });
  // Caller tries to smuggle a payload/cmd — extra fields must be ignored entirely.
  const res = await t.sendEntry({ targetId: 'T1', cdpSessionId: 'S1', host: 'game.example', payload: 'BET', cmd: 100002 });
  assert.equal(res.ok, true);
  const evalExprs = client.exprs.join('\n');
  assert.ok(/__avEnterAviator/.test(evalExprs), 'must call the sealed entry function');
  assert.equal(/100002|100003|BET|CASHOUT/.test(evalExprs), false, 'must never reference wager cmds/payloads');
  // The only cmd literal reachable is the baked enter frame, and it lives in the injected hook only.
  const hookExpr = client.exprs.find((e) => /__avEnterVersion/.test(e));
  assert.ok(hookExpr && /aviatorPlugin/.test(hookExpr) && /100000/.test(hookExpr), 'hook bakes the fixed enter frame');
});

test('no eligible socket => sendEntry fails cleanly (never sends blindly)', async () => {
  const t = new EntryOnlyTransport({ resolveClient: () => null });
  const res = await t.sendEntry({ targetId: null });
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
