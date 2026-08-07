import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InterceptEngine, ruleMatches } = require('../../desktop/cdp/intercept.cjs');

function fakeClient() {
  const calls = [];
  return {
    calls,
    Fetch: {
      enable: async (a) => calls.push(['enable', a]),
      disable: async () => calls.push(['disable']),
      continueRequest: async (a) => calls.push(['continue', a]),
      failRequest: async (a) => calls.push(['fail', a]),
    },
  };
}
const paused = (over = {}) => ({ requestId: 'F1', networkId: 'N1', resourceType: 'XHR', frameId: 'fr', request: { url: 'https://api.game/purchase', method: 'POST', headers: { 'X-Debug': 'original' }, postData: '{"v":1}' }, ...over });

test('ruleMatches: host/method/urlContains/resourceType', () => {
  assert.equal(ruleMatches({ host: 'api.game', method: 'POST', urlContains: '/purchase' }, { url: 'https://api.game/purchase', method: 'POST', resourceType: 'XHR' }), true);
  assert.equal(ruleMatches({ method: 'GET' }, { url: 'x', method: 'POST' }), false);
  assert.equal(ruleMatches({ host: 'other' }, { url: 'https://api.game/x', method: 'POST' }), false);
  assert.equal(ruleMatches({ urlContains: '/nope' }, { url: 'https://api.game/x', method: 'POST' }), false);
});

test('non-matching request is auto-continued and NOT recorded as paused', async () => {
  const client = fakeClient();
  const eng = new InterceptEngine({ resolveClient: () => client });
  await eng.enable('A', { urlContains: '/purchase' });
  const rec = eng.onRequestPaused('A', paused({ request: { url: 'https://api.game/other', method: 'GET', headers: {} } }));
  assert.equal(rec, null);
  assert.equal(eng.listPaused().length, 0);
  assert.deepEqual(client.calls.at(-1), ['continue', { requestId: 'F1' }]);
});

test('matching request pauses; PAUSED -> CONTINUED', async () => {
  const client = fakeClient();
  const eng = new InterceptEngine({ resolveClient: () => client });
  await eng.enable('A', { urlContains: '/purchase' });
  const rec = eng.onRequestPaused('A', paused());
  assert.equal(rec.state, 'PAUSED');
  assert.equal(eng.listPaused().length, 1);
  const done = await eng.continue(rec.id);
  assert.equal(done.state, 'CONTINUED');
  assert.deepEqual(client.calls.at(-1), ['continue', { requestId: 'F1' }]);
  assert.equal(eng.listPaused().length, 0);
});

test('PAUSED -> MODIFIED_AND_CONTINUED sends url/method/headers/base64 body', async () => {
  const client = fakeClient();
  const eng = new InterceptEngine({ resolveClient: () => client });
  await eng.enable('A', {});
  const rec = eng.onRequestPaused('A', paused());
  const done = await eng.continueModified(rec.id, { body: '{"v":2}', headers: { 'X-Debug': 'modified' }, url: 'https://api.game/purchase2' });
  assert.equal(done.state, 'MODIFIED_AND_CONTINUED');
  const [, params] = client.calls.at(-1);
  assert.equal(params.url, 'https://api.game/purchase2');
  assert.deepEqual(params.headers, [{ name: 'X-Debug', value: 'modified' }]);
  assert.equal(Buffer.from(params.postData, 'base64').toString('utf8'), '{"v":2}', 'body base64-encoded exactly once');
});

test('PAUSED -> ABORTED via failRequest', async () => {
  const client = fakeClient();
  const eng = new InterceptEngine({ resolveClient: () => client });
  await eng.enable('A', {});
  const rec = eng.onRequestPaused('A', paused());
  const done = await eng.abort(rec.id);
  assert.equal(done.state, 'ABORTED');
  assert.deepEqual(client.calls.at(-1), ['fail', { requestId: 'F1', errorReason: 'Aborted' }]);
});

test('illegal second action -> INTERCEPT_ALREADY_RESOLVED', async () => {
  const client = fakeClient();
  const eng = new InterceptEngine({ resolveClient: () => client });
  await eng.enable('A', {});
  const rec = eng.onRequestPaused('A', paused());
  await eng.continue(rec.id);
  assert.equal((await eng.abort(rec.id)).error.code, 'INTERCEPT_ALREADY_RESOLVED');
  assert.equal((await eng.continueModified(rec.id)).error.code, 'INTERCEPT_ALREADY_RESOLVED');
});

test('timeout fail-safe auto-continues unmodified -> TIMED_OUT', async () => {
  const client = fakeClient();
  const eng = new InterceptEngine({ resolveClient: () => client, timeoutMs: 40 });
  await eng.enable('A', {});
  const rec = eng.onRequestPaused('A', paused());
  await new Promise((r) => setTimeout(r, 120));
  const got = eng.getPaused(rec.id);
  assert.equal(got.state, 'TIMED_OUT');
  assert.ok(client.calls.some((c) => c[0] === 'continue'), 'auto-continued');
});

test('target binding: paused on A always resolves client A, never B', async () => {
  const cA = fakeClient(); const cB = fakeClient();
  const resolved = [];
  const eng = new InterceptEngine({ resolveClient: (t) => { resolved.push(t); return t === 'A' ? cA : cB; } });
  await eng.enable('A', {});
  const rec = eng.onRequestPaused('A', paused());
  await eng.continue(rec.id);
  assert.ok(cA.calls.some((c) => c[0] === 'continue'), 'A continued');
  assert.ok(!cB.calls.some((c) => c[0] === 'continue'), 'B never touched');
  assert.equal(resolved.at(-1), 'A');
});

test('target destroyed -> continue returns TARGET_CONTEXT_UNAVAILABLE, no fallback', async () => {
  let alive = true;
  const client = fakeClient();
  const eng = new InterceptEngine({ resolveClient: () => (alive ? client : null) });
  await eng.enable('A', {});
  const rec = eng.onRequestPaused('A', paused());
  alive = false;
  const done = await eng.continueModified(rec.id, { body: '{"v":2}' });
  assert.equal(done.error.code, 'TARGET_CONTEXT_UNAVAILABLE');
});

test('onTargetDetached terminates paused records for that target only', async () => {
  const eng = new InterceptEngine({ resolveClient: () => fakeClient() });
  await eng.enable('A', {});
  await eng.enable('B', {});
  const a = eng.onRequestPaused('A', paused());
  const b = eng.onRequestPaused('B', paused({ requestId: 'F2' }));
  eng.onTargetDetached('A');
  assert.equal(eng.getPaused(a.id).state, 'FAILED');
  assert.equal(eng.getPaused(a.id).error.code, 'TARGET_CONTEXT_UNAVAILABLE');
  assert.equal(eng.getPaused(b.id).state, 'PAUSED', 'B unaffected');
  assert.equal(eng.isActive('A'), false);
});

test('networkId is retained for Fetch<->Network correlation', async () => {
  const eng = new InterceptEngine({ resolveClient: () => fakeClient() });
  await eng.enable('A', {});
  const rec = eng.onRequestPaused('A', paused({ networkId: 'NET-123' }));
  assert.equal(rec.networkRequestId, 'NET-123');
});
