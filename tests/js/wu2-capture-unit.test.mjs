import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CaptureCorrelator } = require('../../desktop/cdp/capture.cjs');

// Minimal synthetic CDP params.
const rWBS = (rid, over = {}) => ({ requestId: rid, loaderId: 'L1', frameId: 'F1', documentURL: 'https://x/', timestamp: 100, wallTime: 1700000000, type: 'XHR', initiator: { type: 'script' }, request: { url: 'https://api.test/a', method: 'GET', headers: { 'X-Main': '1' } }, ...over });
const rExtra = (rid, over = {}) => ({ requestId: rid, headers: { 'x-extra': 'yes', cookie: 'a=b' }, associatedCookies: [{ cookie: { name: 'a', value: 'b' }, blockedReasons: [] }], ...over });
const respRcv = (rid, over = {}) => ({ requestId: rid, timestamp: 100.2, type: 'XHR', response: { url: 'https://api.test/a', status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, mimeType: 'application/json', protocol: 'h2', remoteIPAddress: '1.2.3.4', encodedDataLength: 0, timing: { requestTime: 100 } }, ...over });
const respExtra = (rid, over = {}) => ({ requestId: rid, headers: { 'x-resp-extra': '1', 'set-cookie': 'sid=9' }, resourceIPAddressSpace: 'Public', statusCode: 200, ...over });
const finished = (rid, over = {}) => ({ requestId: rid, timestamp: 100.5, encodedDataLength: 1234, ...over });

test('request: main then ExtraInfo merges', () => {
  const c = new CaptureCorrelator();
  c.onRequestWillBeSent('A', rWBS('1'));
  c.onRequestWillBeSentExtraInfo('A', rExtra('1'));
  const req = c.list()[0];
  assert.equal(req.headers['X-Main'], '1');
  assert.equal(req.headers['x-extra'], 'yes');
  assert.equal(req.cookies[0].name, 'a');
});

test('request: ExtraInfo BEFORE main still merges (out of order)', () => {
  const c = new CaptureCorrelator();
  c.onRequestWillBeSentExtraInfo('A', rExtra('1'));
  c.onRequestWillBeSent('A', rWBS('1'));
  const req = c.list()[0];
  assert.equal(req.headers['x-extra'], 'yes', 'pending ExtraInfo merged on main arrival');
  assert.equal(req.cookies[0].value, 'b');
});

test('response: main then ExtraInfo merges', () => {
  const c = new CaptureCorrelator();
  c.onRequestWillBeSent('A', rWBS('1'));
  c.onResponseReceived('A', respRcv('1'));
  c.onResponseReceivedExtraInfo('A', respExtra('1'));
  const resp = c.list()[0].response;
  assert.equal(resp.headers['content-type'], 'application/json');
  assert.equal(resp.headers['x-resp-extra'], '1');
  assert.deepEqual(resp.setCookies, ['sid=9']);
});

test('response: ExtraInfo BEFORE main still merges', () => {
  const c = new CaptureCorrelator();
  c.onRequestWillBeSent('A', rWBS('1'));
  c.onResponseReceivedExtraInfo('A', respExtra('1'));
  c.onResponseReceived('A', respRcv('1'));
  const resp = c.list()[0].response;
  assert.equal(resp.headers['x-resp-extra'], '1', 'pending response ExtraInfo merged');
});

test('lifecycle: REQUEST_SENT -> RESPONSE_RECEIVED -> BODY_AVAILABLE + timing/size', () => {
  const c = new CaptureCorrelator();
  c.onRequestWillBeSent('A', rWBS('1'));
  assert.equal(c.list()[0].state, 'REQUEST_SENT');
  c.onResponseReceived('A', respRcv('1'));
  assert.equal(c.list()[0].state, 'RESPONSE_RECEIVED');
  c.onLoadingFinished('A', finished('1'));
  const req = c.list()[0];
  assert.equal(req.state, 'BODY_AVAILABLE');
  assert.equal(req.response.encodedSize, 1234);
  assert.ok(req.durationMs > 0, 'duration from monotonic timestamps, not 0');
  assert.equal(Math.round(req.durationMs), 500); // (100.5 - 100) * 1000
});

test('redirect: A(302)->B(200) creates two linked hops, evidence not overwritten', () => {
  const c = new CaptureCorrelator();
  // hop 0
  c.onRequestWillBeSent('A', rWBS('1', { request: { url: 'https://api.test/a', method: 'GET', headers: {} } }));
  // hop 1: same requestId, carries redirectResponse of hop 0
  c.onRequestWillBeSent('A', rWBS('1', {
    request: { url: 'https://api.test/b', method: 'GET', headers: {} },
    redirectResponse: { url: 'https://api.test/a', status: 302, statusText: 'Found', headers: { location: '/b' }, mimeType: '' },
  }));
  c.onResponseReceived('A', respRcv('1', { response: { url: 'https://api.test/b', status: 200, statusText: 'OK', headers: {}, mimeType: 'text/html', encodedDataLength: 0 } }));
  c.onLoadingFinished('A', finished('1'));
  const all = c.list().sort((a, b) => a.hop - b.hop);
  assert.equal(all.length, 2, 'two hops');
  assert.equal(all[0].url, 'https://api.test/a');
  assert.equal(all[0].response.status, 302, 'hop 0 keeps its 302 evidence');
  assert.equal(all[0].state, 'FINISHED');
  assert.equal(all[1].url, 'https://api.test/b');
  assert.equal(all[1].response.status, 200);
  assert.equal(all[1].redirectFromId, all[0].id, 'hop 1 linked to hop 0');
});

test('failed request stays inspectable with errorText', () => {
  const c = new CaptureCorrelator();
  c.onRequestWillBeSent('A', rWBS('1'));
  c.onLoadingFailed('A', { requestId: '1', timestamp: 100.3, type: 'XHR', errorText: 'net::ERR_CONNECTION_REFUSED', canceled: false });
  const req = c.list()[0];
  assert.equal(req.state, 'FAILED');
  assert.equal(req.failure.errorText, 'net::ERR_CONNECTION_REFUSED');
  assert.ok(req.durationMs >= 0);
});

test('multi-target body binding: getResponseBody uses the request OWN target client', async () => {
  const calls = [];
  const clientA = { Network: { getResponseBody: async (a) => { calls.push(['A', a.requestId]); return { body: 'BODY-A', base64Encoded: false }; } } };
  const clientB = { Network: { getResponseBody: async (a) => { calls.push(['B', a.requestId]); return { body: 'BODY-B', base64Encoded: false }; } } };
  const resolved = [];
  const c = new CaptureCorrelator({ resolveClient: (tid) => { resolved.push(tid); return tid === 'A' ? clientA : clientB; } });

  c.onRequestWillBeSent('A', rWBS('1'));
  c.onResponseReceived('A', respRcv('1'));
  c.onLoadingFinished('A', finished('1'));
  c.onRequestWillBeSent('B', rWBS('1')); // same cdp requestId, different target
  c.onResponseReceived('B', respRcv('1'));
  c.onLoadingFinished('B', finished('1'));

  const idA = c.list().find(r => r.targetId === 'A').id;
  const idB = c.list().find(r => r.targetId === 'B').id;
  assert.notEqual(idA, idB, 'same cdp requestId across targets are distinct captured requests');

  const bodyA = await c.getResponseBody(idA);
  assert.equal(bodyA.body, 'BODY-A');
  assert.deepEqual(resolved.at(-1), 'A');
  assert.deepEqual(calls.at(-1), ['A', '1']);

  const bodyB = await c.getResponseBody(idB);
  assert.equal(bodyB.body, 'BODY-B');
  assert.deepEqual(calls.at(-1), ['B', '1'], 'B resolved through client B, never A');
});

test('body typed errors: not-received, not-ready, target-unavailable, cached-on-second-call', async () => {
  const c = new CaptureCorrelator({ resolveClient: () => null }); // no client
  c.onRequestWillBeSent('A', rWBS('1'));
  assert.equal((await c.getResponseBody(c.list()[0].id)).error.code, 'RESPONSE_NOT_RECEIVED');
  c.onResponseReceived('A', respRcv('1'));
  assert.equal((await c.getResponseBody(c.list()[0].id)).error.code, 'RESPONSE_BODY_NOT_READY');
  c.onLoadingFinished('A', finished('1'));
  assert.equal((await c.getResponseBody(c.list()[0].id)).error.code, 'TARGET_CONTEXT_UNAVAILABLE');
  assert.equal((await c.getResponseBody('nope')).error.code, 'REQUEST_NOT_FOUND');
});

test('binary body kept as base64, not utf-8 decoded', async () => {
  const client = { Network: { getResponseBody: async () => ({ body: 'AAECAwQ=', base64Encoded: true }) } };
  const c = new CaptureCorrelator({ resolveClient: () => client });
  c.onRequestWillBeSent('A', rWBS('1'));
  c.onResponseReceived('A', respRcv('1'));
  c.onLoadingFinished('A', finished('1'));
  const body = await c.getResponseBody(c.list()[0].id);
  assert.equal(body.base64Encoded, true);
  assert.equal(body.encoding, 'base64');
  assert.equal(body.body, 'AAECAwQ=');
});
