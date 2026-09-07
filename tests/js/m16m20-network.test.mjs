import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsPersistence } = require('../../desktop/analytics/persistence.cjs');
const { WebLogQuery, NetworkReport } = require('../../desktop/analytics/query/web-log-query.cjs');

function setup() {
  const store = new AnalyticsStore({ file: ':memory:' });
  const p = new AnalyticsPersistence({ store });
  return { store, p, wl: new WebLogQuery({ store }), nr: new NetworkReport({ store }) };
}
let seq = 0;
async function http(p, browser, { host, path = '/', type = 'XHR', method = 'GET', status = 200, dur = 20, mime = 'application/json', size = 100, body } = {}) {
  seq++;
  const req = { id: 'R' + seq, targetId: 'T-' + browser, cdpRequestId: String(seq), startedAt: new Date(1000 + seq * 1000).toISOString(), resourceType: type, method, url: `https://${host}${path}`, scheme: 'https', host, path, headers: { accept: mime } };
  p.onHttpRequest(browser, req);
  req.state = status ? 'BODY_AVAILABLE' : 'FAILED'; req.durationMs = dur;
  if (status) req.response = { status, statusText: 'OK', mimeType: mime, protocol: 'h2', headers: {}, encodedSize: size };
  else req.failure = { errorText: 'net::ERR' };
  await p.onHttpFinalize(browser, req, async () => (body != null ? { available: true, body, base64Encoded: false, length: body.length } : { available: false, error: { code: 'x' } }));
}
function wsConn(p, browser, id, url = 'wss://game/ws') { const c = { id: 'C' + id, targetId: 'T-' + browser, cdpRequestId: 'w' + id, startedAt: new Date().toISOString(), url }; p.onWsCreated(browser, c); return c; }
function wsFrame(p, browser, id, direction, raw, at) { p.onWsFrame(browser, { direction, raw, at: at || Date.now(), targetId: 'T-' + browser, cdpRequestId: 'w' + id }); }

test('HTTP request/response/body CAPTURED + provenance for WS-derived protocol events', async () => {
  const { store, p } = setup(); p.beginSession('B-1');
  await http(p, 'B-1', { host: 'api.x', path: '/v1/r', body: '{"ok":true}' });
  assert.equal(store.counts().networkRequests, 1);
  assert.equal(store.counts().networkResponses, 1);
  const body = store.db.prepare('SELECT * FROM network_bodies').get();
  assert.equal(body.capture_status, 'CAPTURED'); assert.equal(body.body, '{"ok":true}');
  // WS provenance
  wsConn(p, 'B-1', 1);
  wsFrame(p, 'B-1', 1, 'recv', '{"cmd":100005,"sid":42}');
  const link = store.db.prepare('SELECT rpe.source_ws_event_id AS sw, rwe.cmd AS c FROM raw_protocol_events rpe JOIN raw_ws_events rwe ON rwe.id=rpe.source_ws_event_id').get();
  assert.ok(link.sw != null); assert.equal(link.c, 100005);
  store.close();
});

test('body policy: SKIPPED_TOO_LARGE and SKIPPED_TYPE', async () => {
  const { store, p } = setup(); p.beginSession('B-1');
  await http(p, 'B-1', { host: 'cdn', path: '/big.json', mime: 'application/json', size: 5 * 1024 * 1024, body: 'x' });
  await http(p, 'B-1', { host: 'cdn', path: '/a.png', mime: 'image/png', size: 5000, body: 'x' });
  const rows = store.db.prepare('SELECT capture_status FROM network_bodies ORDER BY id').all().map((r) => r.capture_status);
  assert.deepEqual(rows, ['SKIPPED_TOO_LARGE', 'SKIPPED_TYPE']);
  store.close();
});

test('failed request: response persisted failed=1, body UNAVAILABLE', async () => {
  const { store, p } = setup(); p.beginSession('B-1');
  await http(p, 'B-1', { host: 'api.x', path: '/fail', status: 0 });
  const resp = store.db.prepare('SELECT failed, failure_reason FROM network_responses').get();
  assert.equal(resp.failed, 1); assert.ok(resp.failure_reason);
  assert.equal(store.db.prepare('SELECT capture_status FROM network_bodies').get().capture_status, 'UNAVAILABLE');
  store.close();
});

test('WS connection counts + close; website SEND recorded, 0 originated sends', () => {
  const { store, p } = setup(); p.beginSession('B-1');
  const c = wsConn(p, 'B-1', 1);
  wsFrame(p, 'B-1', 1, 'recv', '{"cmd":100005,"sid":1}');
  wsFrame(p, 'B-1', 1, 'send', '{"cmd":100002}');   // WEBSITE send
  wsFrame(p, 'B-1', 1, 'recv', '{"cmd":100007,"sid":1,"odd":2}');
  p.onWsClosed('B-1', c);
  const conn = store.db.prepare('SELECT send_count, recv_count, closed_at_ms FROM ws_connections').get();
  assert.equal(conn.send_count, 1); assert.equal(conn.recv_count, 2); assert.ok(conn.closed_at_ms != null);
  // the SEND frame is observed evidence (direction SEND / origin WEBSITE), not an Analytics action
  const send = store.db.prepare("SELECT origin FROM raw_protocol_events WHERE direction='SEND'").get();
  assert.equal(send.origin, 'WEBSITE');
  store.close();
});

test('web log query: type/status/ws-only/cmd/hasOdd filters + pagination + browser isolation', async () => {
  const { store, p, wl } = setup(); p.beginSession('B-1'); p.beginSession('B-2');
  await http(p, 'B-1', { host: 'api.x', path: '/a', type: 'XHR', status: 200 });
  await http(p, 'B-1', { host: 'api.x', path: '/b', type: 'Fetch', method: 'POST', status: 500 });
  await http(p, 'B-1', { host: 'cdn', path: '/s.js', type: 'Script', status: 200 });
  await http(p, 'B-2', { host: 'other', path: '/z', type: 'XHR', status: 200 });
  wsConn(p, 'B-1', 1);
  wsFrame(p, 'B-1', 1, 'recv', '{"cmd":100009,"sid":5,"odd":2.5}');
  wsFrame(p, 'B-1', 1, 'send', '{"cmd":100002}');

  assert.equal(wl.query({ browserId: 'B-1', resourceType: 'XHR' }).total, 1);
  assert.equal(wl.query({ browserId: 'B-1', statusFamily: '5xx' }).total, 1);
  assert.equal(wl.query({ browserId: 'B-1', resourceType: 'WebSocket' }).total, 2);
  assert.equal(wl.query({ browserId: 'B-1', wsDirection: 'SEND' }).total, 1);
  assert.equal(wl.query({ browserId: 'B-1', cmd: 100009 }).total, 1);
  assert.equal(wl.query({ browserId: 'B-1', hasOdd: true }).total, 1);
  assert.equal(wl.query({ browserId: 'B-2' }).total, 1);                 // browser isolation
  // pagination + stable ordering (newest first)
  const page = wl.query({ browserId: 'B-1' }, { limit: 2, offset: 0 });
  assert.equal(page.rows.length, 2);
  assert.ok(page.total >= 5);
  store.close();
});

test('network report: overview counts, endpoints, hosts, timeline; empty set has no NaN', async () => {
  const { store, p, nr } = setup(); p.beginSession('B-1');
  await http(p, 'B-1', { host: 'api.x', path: '/r', type: 'XHR', status: 200, dur: 10 });
  await http(p, 'B-1', { host: 'api.x', path: '/r', type: 'XHR', status: 200, dur: 30 });
  await http(p, 'B-1', { host: 'api.x', path: '/bet', type: 'Fetch', method: 'POST', status: 500, dur: 100 });
  wsConn(p, 'B-1', 1);
  wsFrame(p, 'B-1', 1, 'recv', '{"cmd":100005,"sid":1}');
  wsFrame(p, 'B-1', 1, 'send', '{"cmd":100002}');
  const ov = nr.overview({ browserId: 'B-1' });
  assert.equal(ov.totalRequests, 3); assert.equal(ov.xhrCount, 2); assert.equal(ov.fetchCount, 1);
  assert.equal(ov.status['2xx'], 2); assert.equal(ov.status['5xx'], 1);
  assert.equal(ov.wsSendCount, 1); assert.equal(ov.wsRecvCount, 1);
  assert.equal(ov.durationMedianMs, 30);
  const eps = nr.endpoints({ browserId: 'B-1' });
  assert.equal(eps.endpoints[0].key, 'GET api.x /r'); assert.equal(eps.endpoints[0].count, 2);
  const hosts = nr.hosts({ browserId: 'B-1' });
  assert.equal(hosts.hosts[0].host, 'api.x'); assert.equal(hosts.hosts[0].requestCount, 3);
  const tl = nr.timeline({ browserId: 'B-1' }, '1m');
  assert.ok(tl.buckets.length >= 1);
  // empty dataset
  const empty = nr.overview({ browserId: 'NONE' });
  assert.equal(empty.totalRequests, 0);
  assert.equal(empty.requestsPerMinute, null); assert.equal(empty.durationMedianMs, null);
  assert.ok(!Number.isNaN(empty.status['2xx']));
  store.close();
});

test('explicit null time bounds do not collapse the dataset (regression)', async () => {
  const { store, p, nr, wl } = setup(); p.beginSession('B-1');
  await http(p, 'B-1', { host: 'api.x', path: '/r', status: 200 });
  // null (not undefined) time bounds — as the REPORT netFilter sends them
  assert.equal(nr.overview({ browserId: 'B-1', timeFromMs: null, timeToMs: null }).totalRequests, 1);
  assert.equal(wl.query({ browserId: 'B-1', timeFromMs: null, timeToMs: null }).total >= 1, true);
  store.close();
});
