import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsPersistence } = require('../../desktop/analytics/persistence.cjs');

// §11/§12 — Analytics SQLite must never persist secret header VALUES at rest. Header
// NAMES are preserved so evidence still shows the header existed.
test('Analytics persistence redacts secret request/response header values before SQLite write', async () => {
  const store = new AnalyticsStore({ file: ':memory:' });
  const p = new AnalyticsPersistence({ store });
  p.beginSession('B-1');

  const req = {
    id: 'R1', targetId: 'T-1', cdpRequestId: '1', startedAt: new Date(1000).toISOString(),
    resourceType: 'XHR', method: 'POST', url: 'https://bodergatez.dsrcgoms.net/gwms/v1/game-act',
    scheme: 'https', host: 'bodergatez.dsrcgoms.net', path: '/gwms/v1/game-act',
    headers: {
      'Authorization': 'Bearer SECRETVALUE',
      'Cookie': 'sid=SECRETSESSION',
      'X-TOKEN': 'SECRET_TOKEN',
      'X-FG-ID': 'SECRET_FG',
      'content-type': 'application/json',
    },
    body: { raw: '{"g":1}', hasBody: true },
  };
  p.onHttpRequest('B-1', req);
  req.state = 'BODY_AVAILABLE'; req.durationMs = 10;
  req.response = { status: 200, statusText: 'OK', mimeType: 'application/json', protocol: 'h2', encodedSize: 20, headers: { 'set-cookie': 'auth=SECRETCOOKIE; Path=/', 'content-type': 'application/json' } };
  await p.onHttpFinalize('B-1', req, async () => ({ available: true, body: '{"ok":1}', base64Encoded: false, length: 8 }));

  const reqRow = store.db.prepare('SELECT request_headers FROM network_requests').get();
  const respRow = store.db.prepare('SELECT response_headers FROM network_responses').get();

  // Secret VALUES must be gone from the stored JSON.
  for (const secret of ['SECRETVALUE', 'SECRETSESSION', 'SECRET_TOKEN', 'SECRET_FG', 'SECRETCOOKIE']) {
    assert.ok(!reqRow.request_headers.includes(secret), `request_headers leaked ${secret}`);
    assert.ok(!respRow.response_headers.includes(secret), `response_headers leaked ${secret}`);
  }
  // Header NAMES + non-secret values preserved.
  const rh = JSON.parse(reqRow.request_headers);
  assert.equal(rh['Authorization'], '[REDACTED]');
  assert.equal(rh['X-TOKEN'], '[REDACTED]');
  assert.equal(rh['Cookie'], '[REDACTED]');
  assert.equal(rh['content-type'], 'application/json');
  const sh = JSON.parse(respRow.response_headers);
  assert.equal(sh['set-cookie'], '[REDACTED]');
  assert.equal(sh['content-type'], 'application/json');

  // Full-DB sweep: no secret appears anywhere.
  const dump = JSON.stringify(store.db.prepare('SELECT * FROM network_requests').all()) + JSON.stringify(store.db.prepare('SELECT * FROM network_responses').all());
  for (const secret of ['SECRETVALUE', 'SECRETSESSION', 'SECRET_TOKEN', 'SECRET_FG', 'SECRETCOOKIE']) {
    assert.ok(!dump.includes(secret), `DB leaked ${secret}`);
  }
  store.close();
});

test('case-insensitive header names are still redacted', async () => {
  const store = new AnalyticsStore({ file: ':memory:' });
  const p = new AnalyticsPersistence({ store });
  p.beginSession('B-1');
  const req = { id: 'R1', targetId: 'T-1', cdpRequestId: '1', startedAt: new Date(1000).toISOString(), resourceType: 'XHR', method: 'GET', url: 'https://h/x', scheme: 'https', host: 'h', path: '/x', headers: { 'authorization': 'Bearer LOWER', 'x-token': 'lowtok', 'COOKIE': 'sid=UPPER' } };
  p.onHttpRequest('B-1', req);
  const row = store.db.prepare('SELECT request_headers FROM network_requests').get();
  for (const s of ['LOWER', 'lowtok', 'UPPER']) assert.ok(!row.request_headers.includes(s), `leaked ${s}`);
  store.close();
});
