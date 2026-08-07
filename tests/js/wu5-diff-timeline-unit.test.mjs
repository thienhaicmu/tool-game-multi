import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { requestDiff, responseDiff, jsonDiff } = require('../../desktop/replay/diff.cjs');
const { Timeline } = require('../../desktop/timeline.cjs');

test('jsonDiff: add / remove / change with paths', () => {
  const d = jsonDiff({ a: 1, b: { c: 2 }, d: 3 }, { a: 1, b: { c: 9 }, e: 4 });
  const byPath = Object.fromEntries(d.map((x) => [x.path, x]));
  assert.equal(byPath['b.c'].op, 'change');
  assert.equal(byPath['b.c'].from, 2); assert.equal(byPath['b.c'].to, 9);
  assert.equal(byPath.d.op, 'remove');
  assert.equal(byPath.e.op, 'add');
});

test('jsonDiff: key order does not count as a change', () => {
  assert.deepEqual(jsonDiff({ a: 1, b: 2 }, { b: 2, a: 1 }), []);
});

test('requestDiff: method/url/header/body(JSON)', () => {
  const a = { method: 'POST', url: 'https://api/x?p=1', headers: { 'X-Debug': 'original', 'Content-Type': 'application/json' }, body: '{"user":"a","n":1}' };
  const b = { method: 'PUT', url: 'https://api/x?p=2', headers: { 'X-Debug': 'modified', 'Content-Type': 'application/json' }, body: '{"user":"b","n":1}' };
  const d = requestDiff(a, b);
  assert.equal(d.changed, true);
  assert.deepEqual(d.method, { changed: true, from: 'POST', to: 'PUT' });
  assert.equal(d.query.changed.find((c) => c.name === 'p').to, '2');
  assert.equal(d.headers.changed.find((h) => h.name === 'X-Debug').to, 'modified');
  const userChange = d.body.changes.find((c) => c.path === 'user');
  assert.equal(userChange.from, 'a'); assert.equal(userChange.to, 'b');
});

test('requestDiff: identical -> changed false', () => {
  const a = { method: 'GET', url: 'https://api/x', headers: { A: '1' }, body: null };
  assert.equal(requestDiff(a, { ...a, headers: { A: '1' } }).changed, false);
});

test('responseDiff: status + body + duration; original body missing handled', () => {
  const d = responseDiff(
    { status: 500, headers: { 'content-type': 'application/json' }, body: '{"ok":false}', duration: 100 },
    { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', duration: 40 });
  assert.deepEqual(d.status, { changed: true, from: 500, to: 200 });
  assert.equal(d.body.changed, true);
  assert.equal(d.duration.deltaMs, -60);

  const d2 = responseDiff({ status: 200, headers: {}, body: null, duration: 10 }, { status: 200, headers: {}, body: '{"x":1}', duration: 12 });
  assert.equal(d2.body.comparable, false, 'original body not loaded -> not comparable, not faked');
});

// --- Timeline with in-memory fakes ---
function fakeCapture(cap) { return { get: (id) => (id === cap.id ? cap : undefined) }; }
function fakeReplay(executions) { return { history: () => ({ executions, drafts: [] }) }; }
function fakeIntercept(records) { return { listAll: () => records }; }

const captured = {
  id: 'A:1#0', targetId: 'A', cdpRequestId: '1', method: 'POST', url: 'https://api/purchase',
  headers: { 'X-Debug': 'original' }, cookies: [], body: { raw: '{"v":1}', contentType: 'application/json' },
  startedAt: '2026-08-07T10:00:00.000Z', state: 'BODY_AVAILABLE', response: { status: 500, headers: {}, body: { available: false } }, durationMs: 100,
};

test('timeline: chronological order, relationship, summary', () => {
  const executions = [
    { id: 'e1', seq: 0, mode: 'HTTP_DIRECT', startedAt: '2026-08-07T10:01:00.000Z', status: 'COMPLETED', request: { method: 'POST', url: 'https://api/purchase', headers: { 'X-Debug': 'original' }, body: '{"v":1}' }, response: { status: 500, headers: {}, body: '{"ok":false}', duration: 90, warnings: [] } },
    { id: 'e2', seq: 1, mode: 'HTTP_DIRECT', startedAt: '2026-08-07T10:02:00.000Z', status: 'COMPLETED', request: { method: 'POST', url: 'https://api/purchase', headers: { 'X-Debug': 'original' }, body: '{"v":2}' }, response: { status: 200, headers: {}, body: '{"ok":true}', duration: 40, warnings: [] } },
  ];
  const intercepts = [
    { id: 'i1', targetId: 'A', networkRequestId: '1', pausedAt: '2026-08-07T10:03:00.000Z', state: 'MODIFIED_AND_CONTINUED', original: { method: 'POST', url: 'https://api/purchase', headers: { 'X-Debug': 'original' }, body: '{"v":1}' }, draft: { method: 'POST', url: 'https://api/purchase', headers: { 'X-Debug': 'modified' }, body: '{"v":1}' } },
    { id: 'iOther', targetId: 'B', networkRequestId: '99', pausedAt: '2026-08-07T10:03:30.000Z', state: 'CONTINUED', original: {}, draft: {} },
  ];
  const tl = new Timeline({ capture: fakeCapture(captured), replay: fakeReplay(executions), intercept: fakeIntercept(intercepts) }).build('A:1#0');
  assert.equal(tl.events.length, 4, 'capture + 2 replays + 1 related intercept (B intercept excluded)');
  assert.deepEqual(tl.events.map((e) => e.kind), ['capture', 'replay', 'replay', 'intercept'], 'chronological');
  assert.equal(tl.events[0].isOriginal, true);
  // Replay #1 body diff v1->v1 (none); Replay #2 body diff v1->v2
  assert.equal(tl.events[1].requestDiff.changed, false);
  assert.equal(tl.events[2].requestDiff.body.changes.find((c) => c.path === 'v').to, 2);
  // Replay #2 response improved 500 -> 200
  assert.deepEqual(tl.events[2].responseDiff.status, { changed: true, from: 500, to: 200 });
  // Intercept shows header modification
  assert.equal(tl.events[3].requestDiff.headers.changed.find((h) => h.name === 'X-Debug').to, 'modified');
  // Summary
  assert.equal(tl.summary.replayed, 2);
  assert.equal(tl.summary.intercepted, 1);
  assert.equal(tl.summary.lastStatus, 200);
});

test('timeline: failed then succeeded replay is visible as progression', () => {
  const executions = [
    { id: 'e1', seq: 0, mode: 'WEBVIEW_CONTEXT', startedAt: '2026-08-07T10:01:00.000Z', status: 'FAILED', error: { code: 'REPLAY_BLOCKED_BY_BROWSER' }, request: { method: 'POST', url: captured.url, headers: {}, body: '{"v":1}' }, response: null },
    { id: 'e2', seq: 1, mode: 'HTTP_DIRECT', startedAt: '2026-08-07T10:02:00.000Z', status: 'COMPLETED', request: { method: 'POST', url: captured.url, headers: {}, body: '{"v":1}' }, response: { status: 200, headers: {}, body: '{"ok":true}', duration: 30, warnings: [] } },
  ];
  const tl = new Timeline({ capture: fakeCapture(captured), replay: fakeReplay(executions), intercept: fakeIntercept([]) }).build('A:1#0');
  assert.equal(tl.events[1].error.code, 'REPLAY_BLOCKED_BY_BROWSER');
  assert.equal(tl.events[2].status, 200);
  assert.equal(tl.summary.lastError, null, 'lastError reflects last erroring event only if the latest errored');
});

test('timeline: unknown request -> typed error', () => {
  const tl = new Timeline({ capture: fakeCapture(captured), replay: fakeReplay([]), intercept: fakeIntercept([]) }).build('nope');
  assert.equal(tl.error.code, 'REQUEST_NOT_FOUND');
});
