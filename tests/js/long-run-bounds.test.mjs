import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { CaptureCorrelator } = require('../../desktop/cdp/capture.cjs');
const { WsReplay } = require('../../desktop/cdp/ws-replay.cjs');
const { TrafficStore } = require('../../desktop/browser-run/traffic-store.cjs');
const { EventJournal } = require('../../desktop/event-journal.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'long-run-')); }
const frame = (rid, n) => ({ requestId: rid, timestamp: n, response: { opcode: 1, payloadData: `[100006,{"odd":${n}}]` } });

// ---------------------------------------------------------------------------
// Capture store: hours of WS frames stay bounded; the open socket survives eviction.
// ---------------------------------------------------------------------------
test('capture maxEntries bounds the store and never evicts the open socket', () => {
  const c = new CaptureCorrelator({ maxEntries: 100 });
  c.onWebSocketCreated('T', { requestId: 'ws1', url: 'wss://game.test/s' });
  for (let i = 0; i < 1000; i++) c.onWebSocketFrameReceived('T', frame('ws1', i));
  assert.ok(c.list().length <= 100, `store size ${c.list().length}`);
  assert.ok(c.get('T::ws1#ws'), 'open socket row kept');
  assert.ok(c.get('T::ws1#recv999'), 'newest frame kept');
  assert.equal(c.get('T::ws1#recv0'), undefined, 'oldest frame evicted');
});

test('capture without maxEntries keeps the old unbounded behaviour', () => {
  const c = new CaptureCorrelator();
  c.onWebSocketCreated('T', { requestId: 'ws1', url: 'wss://game.test/s' });
  for (let i = 0; i < 500; i++) c.onWebSocketFrameReceived('T', frame('ws1', i));
  assert.equal(c.list().length, 501);
});

test('capture eviction keeps in-flight HTTP requests', () => {
  const c = new CaptureCorrelator({ maxEntries: 50 });
  c.onRequestWillBeSent('T', { requestId: 'slow', timestamp: 1, request: { url: 'https://api.test/poll', method: 'GET', headers: {} } });
  c.onWebSocketCreated('T', { requestId: 'ws1', url: 'wss://game.test/s' });
  for (let i = 0; i < 500; i++) c.onWebSocketFrameReceived('T', frame('ws1', i));
  assert.ok(c.get('T::slow#0'), 'in-flight request kept');
  c.onResponseReceived('T', { requestId: 'slow', response: { status: 200, headers: {} } });
  assert.equal(c.get('T::slow#0').response.status, 200);
});

// ---------------------------------------------------------------------------
// WS send-hook: one new-document registration per client+session, however many sends.
// ---------------------------------------------------------------------------
test('ws-replay registers the new-document hook once per session across many sends', async () => {
  const calls = [];
  const client = {
    Page: { addScriptToEvaluateOnNewDocument: async (_p, sid) => { calls.push(['add', sid]); return { identifier: String(calls.length) }; } },
    Runtime: { evaluate: async (p, sid) => { calls.push(['eval', sid]); return { result: { value: true } }; } },
  };
  const ws = new WsReplay({ resolveClient: () => client });
  for (let i = 0; i < 50; i++) await ws.sendProtocol({ targetId: 'T', cdpSessionId: 'S1', host: 'game.test' }, '[1]');
  await ws.sendProtocol({ targetId: 'T', cdpSessionId: 'S2', host: 'game.test' }, '[1]');
  await ws.injectSession(client, undefined);
  const adds = calls.filter((c) => c[0] === 'add');
  assert.deepEqual(adds.map((c) => c[1]), ['S1', 'S2', undefined]);
  assert.ok(calls.filter((c) => c[0] === 'eval').length >= 52, 'the hook is still evaluated on every send');
});

test('ws-replay retries the registration when it failed (e.g. a worker without Page)', async () => {
  let attempts = 0;
  const client = {
    Page: { addScriptToEvaluateOnNewDocument: async () => { attempts++; throw new Error('Page domain not found'); } },
    Runtime: { evaluate: async () => ({ result: { value: true } }) },
  };
  const ws = new WsReplay({ resolveClient: () => client });
  await ws.injectSession(client, 'W');
  await ws.injectSession(client, 'W');
  assert.equal(attempts, 2);
});

// ---------------------------------------------------------------------------
// TrafficStore: batched writes keep every record, in order, and episodes still capture.
// ---------------------------------------------------------------------------
test('traffic store with flushIntervalMs batches writes but loses nothing', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => now, flushIntervalMs: 60000 });
  const owner = { browserId: 'B-1', runId: 'run-1' };
  for (let i = 0; i < 200; i++) { now++; store.recordWsFrame(owner, { cdpRequestId: 'w', wsDirection: 'recv', url: 'wss://g/s', body: { raw: `[100006,{"odd":${i}}]` } }); }
  const active = path.join(dir, 'B-1', 'run-1', 'traffic.jsonl');
  assert.equal(fs.existsSync(active), false, 'nothing written before the flush interval');
  const rows = store.readRun('run-1'); // reads flush first
  assert.equal(rows.length, 200);
  assert.deepEqual(rows.map((r) => r.seq), [...Array(200).keys()]);
  assert.equal(fs.readFileSync(active, 'utf8').trim().split('\n').length, 200);
});

test('traffic store buffered: a failure marker pins the window and tees later frames', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => now, flushIntervalMs: 60000, postWindowMs: 100 });
  const owner = { browserId: 'B-1', runId: 'run-1' };
  const ws = (i) => store.recordWsFrame(owner, { cdpRequestId: 'w', wsDirection: 'recv', url: 'wss://g/s', body: { raw: `[${i}]` } });
  ws(1); ws(2);
  now += 10; store.recordMarker(owner, { event: 'REENTRY_FAILED' });
  now += 10; ws(3);
  now += 500; ws(4); // past the post window
  store.flushAll();
  const epDir = path.join(dir, 'B-1', 'run-1', 'episodes');
  const [ep] = fs.readdirSync(epDir);
  const lines = fs.readFileSync(path.join(epDir, ep), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const payloads = lines.filter((l) => l.kind === 'ws-frame').map((l) => l.payload);
  assert.deepEqual(payloads, ['[1]', '[2]', '[3]']);
});

// ---------------------------------------------------------------------------
// EventJournal: async batched appends; flushSync persists the tail; size cap stops growth.
// ---------------------------------------------------------------------------
test('event journal batches appends and flushSync writes everything', () => {
  const file = path.join(tmp(), 's.jsonl');
  const j = new EventJournal(file, { flushMs: 60000 });
  for (let i = 0; i < 100; i++) j.append({ kind: 'request', id: String(i) });
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', '');
  j.flushSync();
  const ids = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, [...Array(100).keys()].map(String));
});

test('event journal async flush lands on disk', async () => {
  const file = path.join(tmp(), 's.jsonl');
  const j = new EventJournal(file, { flushMs: 5 });
  for (let i = 0; i < 10; i++) j.append({ kind: 'request', id: String(i) });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 10);
});

test('event journal stops at maxBytes with one marker line', () => {
  const file = path.join(tmp(), 's.jsonl');
  const j = new EventJournal(file, { flushMs: 0, maxBytes: 2000 });
  for (let i = 0; i < 200; i++) j.append({ kind: 'request', id: String(i), url: 'https://x.test/' + 'a'.repeat(40) });
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(fs.statSync(file).size < 2200);
  assert.equal(lines[lines.length - 1].kind, 'journal-capped');
  assert.equal(lines.filter((l) => l.kind === 'journal-capped').length, 1);
});
