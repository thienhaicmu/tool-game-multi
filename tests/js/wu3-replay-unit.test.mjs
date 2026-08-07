import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ReplayEngine, MODES } = require('../../desktop/replay/replay-engine.cjs');

function capturedFixture(over = {}) {
  return {
    id: 'cap1', targetId: 'A', cdpRequestId: '7', method: 'POST', url: 'https://api.test/login?x=1',
    headers: { 'Content-Type': 'application/json', 'X-Token': 'abc', Host: 'api.test', Origin: 'https://api.test' },
    cookies: [{ name: 'sid', value: '9' }],
    body: { raw: '{"user":"a"}', hasBody: true, contentType: 'application/json' },
    resourceType: 'XHR', state: 'BODY_AVAILABLE', response: { status: 200 }, ...over,
  };
}
function engineWith(captured, extra = {}) {
  const store = new Map([[captured.id, captured]]);
  return new ReplayEngine({ getCaptured: id => store.get(id), ...extra });
}

test('createDraft copies from CapturedRequest and does NOT mutate it', () => {
  const cap = capturedFixture();
  const eng = engineWith(cap);
  const draft = eng.createDraft('cap1');
  assert.equal(draft.method, 'POST');
  assert.equal(draft.body.raw, '{"user":"a"}');
  assert.equal(draft.mode, MODES.WEBVIEW_CONTEXT);
  // Mutate the draft; captured must be untouched.
  eng.updateDraft(draft.id, { method: 'PUT', body: '{"user":"b"}', headers: { 'X-New': '1' } });
  assert.equal(cap.method, 'POST', 'captured method unchanged');
  assert.equal(cap.body.raw, '{"user":"a"}', 'captured body unchanged');
  assert.equal(cap.headers['X-Token'], 'abc', 'captured headers unchanged');
  const d2 = eng.getDraft(draft.id);
  assert.equal(d2.method, 'PUT');
  assert.equal(d2.body.raw, '{"user":"b"}');
});

test('createDraft on unknown request returns REQUEST_NOT_FOUND', () => {
  const eng = engineWith(capturedFixture());
  assert.equal(eng.createDraft('nope').error.code, 'REQUEST_NOT_FOUND');
});

test('updateDraft validates method/url; malformed headers are skipped, not fatal', () => {
  const eng = engineWith(capturedFixture());
  const d = eng.createDraft('cap1');
  assert.equal(eng.updateDraft(d.id, { method: 'FOO' }).error.code, 'INVALID_DRAFT');
  assert.equal(eng.updateDraft(d.id, { url: 'not a url' }).error.code, 'INVALID_DRAFT');
  assert.equal(eng.updateDraft(d.id, { headers: [] }).error.code, 'INVALID_HEADER'); // wrong type still errors
  const r = eng.updateDraft(d.id, { headers: { 'Bad Header': 'x', 'X-OK': '1', Evil: 'a\nb' } });
  assert.ok(!r.error, 'malformed header name/value skipped, replay not blocked');
  assert.equal(r.headers['X-OK'], '1');
  assert.ok(!('Bad Header' in r.headers) && !('Evil' in r.headers));
});

test('WebView build: browser-controlled headers dropped with warning; cookies warned', async () => {
  const calls = [];
  const client = { Runtime: { evaluate: async ({ expression }) => { calls.push(expression); return { result: { value: { ok: true, status: 200, statusText: 'OK', headers: { a: 'b' }, body: 'R', duration: 5 } } }; } } };
  const eng = engineWith(capturedFixture(), { resolveClient: () => client });
  const d = eng.createDraft('cap1', { mode: 'WEBVIEW_CONTEXT' });
  const exec = await eng.execute(d.id);
  assert.equal(exec.status, 'COMPLETED');
  assert.equal(exec.response.status, 200);
  const warned = exec.warnings.map(w => (w.header || '').toLowerCase());
  assert.ok(warned.includes('host') && warned.includes('origin'), 'Host/Origin flagged as browser-controlled');
  assert.ok(exec.warnings.some(w => w.policy === 'cookies'), 'cookie override warned in WebView mode');
  // The expression sent to the target must NOT contain the dropped Host header value.
  assert.ok(!/"Host"/.test(calls[0]), 'Host not sent via fetch');
  assert.ok(/"X-Token":"abc"/.test(calls[0]), 'normal header preserved');
});

test('HTTP_DIRECT: strips hop-by-hop, uses injected client, uniform result shape', async () => {
  let seen;
  const eng = engineWith(capturedFixture(), { httpFetch: async (url, opts) => { seen = { url, opts }; return { status: 201, statusText: 'Created', headers: { 'content-type': 'application/json' }, body: 'OK' }; } });
  const d = eng.createDraft('cap1', { mode: 'HTTP_DIRECT' });
  const exec = await eng.execute(d.id);
  assert.equal(exec.status, 'COMPLETED');
  assert.equal(exec.response.mode, 'HTTP_DIRECT');
  assert.equal(exec.response.status, 201);
  assert.ok(!('host' in Object.fromEntries(Object.entries(seen.opts.headers).map(([k, v]) => [k.toLowerCase(), v]))), 'Host stripped');
  assert.equal(seen.opts.body, '{"user":"a"}', 'raw body passed unchanged');
  // Same ReplayResult contract as WebView mode.
  for (const k of ['status', 'statusText', 'headers', 'body', 'duration', 'mode']) assert.ok(k in exec.response, `result has ${k}`);
});

test('WebView replay with no live target -> TARGET_CONTEXT_UNAVAILABLE', async () => {
  const eng = engineWith(capturedFixture(), { resolveClient: () => null });
  const d = eng.createDraft('cap1', { mode: 'WEBVIEW_CONTEXT' });
  const exec = await eng.execute(d.id);
  assert.equal(exec.status, 'FAILED');
  assert.equal(exec.error.code, 'TARGET_CONTEXT_UNAVAILABLE');
});

test('each execute appends history; nothing overwritten', async () => {
  const eng = engineWith(capturedFixture(), { httpFetch: async () => ({ status: 200, headers: {}, body: 'x' }) });
  const d = eng.createDraft('cap1', { mode: 'HTTP_DIRECT' });
  await eng.execute(d.id);
  eng.updateDraft(d.id, { body: '{"user":"b"}' });
  await eng.execute(d.id);
  const h = eng.history('cap1');
  assert.equal(h.executions.length, 2, 'two executions retained');
  assert.equal(h.executions[0].seq, 0);
  assert.equal(h.executions[1].seq, 1);
  assert.equal(h.drafts.length, 1);
});

test('HTTP/2 pseudo-headers are stripped, not rejected (real bug: :authority)', async () => {
  const cap = capturedFixture({
    headers: { ':authority': 'chamhinh.vinasoy.com', ':method': 'POST', ':path': '/x', ':scheme': 'https', 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: { raw: 'Modal=keyshop&Param=53', contentType: 'application/x-www-form-urlencoded' },
  });
  let sent;
  const eng = engineWith(cap, { httpFetch: async (url, opts) => { sent = opts; return { status: 200, headers: {}, body: 'ok' }; } });
  const draft = eng.createDraft('cap1', { mode: 'HTTP_DIRECT' });
  // createDraft must not carry pseudo-headers into the editable draft.
  assert.ok(!Object.keys(draft.headers).some((k) => k.startsWith(':')), 'pseudo-headers stripped from draft');
  assert.equal(draft.headers['X-Requested-With'], 'XMLHttpRequest');
  // Re-sending the full header set (as the UI does) must NOT error on ":authority".
  const upd = eng.updateDraft(draft.id, { headers: { ':authority': 'h', 'X-Requested-With': 'XMLHttpRequest' } });
  assert.ok(!upd.error, 'update tolerates pseudo-headers');
  assert.ok(!('/:authority/' in upd.headers) && !Object.keys(upd.headers).some((k) => k.startsWith(':')));
  const ex = await eng.execute(draft.id);
  assert.equal(ex.status, 'COMPLETED');
  assert.ok(!Object.keys(sent.headers).some((k) => k.startsWith(':')), 'no pseudo-header reaches the transport');
});

test('WebView fetch rejection surfaces REPLAY_BLOCKED_BY_BROWSER', async () => {
  const client = { Runtime: { evaluate: async () => ({ result: { value: { ok: false, error: 'Failed to fetch' } } }) } };
  const eng = engineWith(capturedFixture(), { resolveClient: () => client });
  const d = eng.createDraft('cap1', { mode: 'WEBVIEW_CONTEXT' });
  const exec = await eng.execute(d.id);
  assert.equal(exec.error.code, 'REPLAY_BLOCKED_BY_BROWSER');
});
