import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsPersistence } = require('../../desktop/analytics/persistence.cjs');

function memStore() { return new AnalyticsStore({ file: ':memory:' }); }
function tmpFile(tag) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'an-' + tag + '-')); return { dir, file: path.join(dir, 'analytics.db') }; }
const OPEN = 100005, LOCK = 100006, END = 100007, ODD = 100009;
function frame(cmd, o = {}) { return '{"cmd":' + cmd + (o.sid != null ? ',"sid":' + o.sid : '') + (o.odd != null ? ',"odd":' + o.odd : '') + (o.jp != null ? ',"eI":{"jp":' + o.jp + '}' : '') + '}'; }

// ---- CaptureSession (§29.7-10) ----
test('session starts CAPTURING; normal stop -> STOPPED', () => {
  const store = memStore();
  const p = new AnalyticsPersistence({ store });
  const sid = p.beginSession('B-1');
  assert.equal(store.sessions.get(sid).status, 'CAPTURING');
  p.endSession('B-1', 'STOPPED');
  const s = store.sessions.get(sid);
  assert.equal(s.status, 'STOPPED');
  assert.ok(s.ended_at_ms != null);
  store.close();
});

// ---- Raw events (§29.11-17) ----
test('RECV, website SEND, malformed and unknown frames are all persisted with correct fields', () => {
  const store = memStore();
  const p = new AnalyticsPersistence({ store });
  p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 1 }), at: 10 });
  p.onFrame('B-1', { direction: 'send', raw: frame(100002, { sid: 1 }), at: 20 });  // website SEND
  p.onFrame('B-1', { direction: 'recv', raw: 'not-json-at-all', at: 30 });          // malformed
  p.onFrame('B-1', { direction: 'recv', raw: frame(424242, { sid: 1 }), at: 40 });  // unknown cmd
  const rows = store.db.prepare('SELECT * FROM raw_protocol_events ORDER BY id ASC').all();
  assert.equal(rows.length, 4);
  assert.equal(rows[0].direction, 'RECV'); assert.equal(rows[0].origin, 'SERVER'); assert.equal(rows[0].parse_status, 'OK');
  assert.equal(rows[1].direction, 'SEND'); assert.equal(rows[1].origin, 'WEBSITE');
  assert.equal(rows[2].parse_status, 'UNPARSED'); assert.ok(rows[2].raw_payload.length > 0);
  assert.equal(rows[3].parse_status, 'UNKNOWN_CMD'); assert.equal(rows[3].cmd, 424242);
  // order preserved by id
  assert.deepEqual(rows.map((r) => r.wall_timestamp_ms), [10, 20, 30, 40]);
  store.close();
});

test('missing parsed fields stay NULL; no Number coercion of junk', () => {
  const store = memStore();
  const p = new AnalyticsPersistence({ store });
  p.onFrame('B-1', { direction: 'recv', raw: '{"cmd":100009,"odd":""}', at: 1 });   // empty odd -> NULL
  p.onFrame('B-1', { direction: 'recv', raw: '{"cmd":100006}', at: 2 });            // no sid/odd/jp
  const rows = store.db.prepare('SELECT odd, sid, jackpot FROM raw_protocol_events ORDER BY id').all();
  assert.equal(rows[0].odd, null);
  assert.equal(rows[1].sid, null); assert.equal(rows[1].odd, null); assert.equal(rows[1].jackpot, null);
  store.close();
});

test('B1/B2 raw attribution is isolated', () => {
  const store = memStore();
  const p = new AnalyticsPersistence({ store });
  p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 1 }), at: 1 });
  p.onFrame('B-2', { direction: 'recv', raw: frame(OPEN, { sid: 2 }), at: 2 });
  assert.equal(store.raw.count({ browserId: 'B-1' }), 1);
  assert.equal(store.raw.count({ browserId: 'B-2' }), 1);
  store.close();
});

// ---- Round persistence + finalize (§29.18, 43, 44) ----
test('a full round is persisted COMPLETE with samples + metrics; related raw events bounded', () => {
  const store = memStore();
  const p = new AnalyticsPersistence({ store });
  p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 50, jp: 300 }), at: 1000 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(LOCK, { sid: 50 }), at: 1050 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(ODD, { sid: 50, odd: 1.5 }), at: 1100 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(ODD, { sid: 50, odd: 3.0 }), at: 1300 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(END, { sid: 50, odd: 3.0, jp: 305 }), at: 1400 });
  const list = store.listRounds({ browserId: 'B-1' });
  assert.equal(list.total, 1);
  const d = store.getRoundDetail(list.rounds[0].id);
  assert.equal(d.round.completeness, 'COMPLETE');
  assert.equal(d.round.maxOdd, 3.0);
  assert.equal(d.oddSamples.length, 3); // 1.5, 3.0, END 3.0
  assert.equal(d.round.jackpotAtOpen, 300);
  assert.equal(d.round.jackpotAtEnd, 305);
  assert.equal(d.metrics.thresholds['2'].reached, true);
  assert.equal(d.metrics.thresholds['2'].timeToMs, 200); // first >=2 is 3.0 at 1300, firstOdd 1100
  assert.equal(d.metrics.thresholds['10'].reached, false);
  assert.ok(d.relatedRawEvents.length >= 5);
  // sample source_event_id references a real raw event
  assert.ok(d.oddSamples[0].sourceEventId != null);
  store.close();
});

test('later stale ODD does not mutate a finalized round', () => {
  const store = memStore();
  const p = new AnalyticsPersistence({ store });
  p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 1 }), at: 0 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(ODD, { sid: 1, odd: 2 }), at: 10 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(END, { sid: 1, odd: 2 }), at: 20 });
  const before = store.getRoundDetail(store.listRounds({ browserId: 'B-1' }).rounds[0].id);
  // stale ODD for the finished SID 1 arrives after a new round opened
  p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 2 }), at: 30 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(ODD, { sid: 1, odd: 99 }), at: 40 });
  const after = store.getRoundDetail(before.round.id);
  assert.equal(after.round.maxOdd, before.round.maxOdd);
  assert.equal(after.oddSamples.length, before.oddSamples.length);
  store.close();
});

// ---- Query API (§29.46-50) ----
test('listRounds paginates and filters by browser', () => {
  const store = memStore();
  const p = new AnalyticsPersistence({ store });
  for (let i = 0; i < 5; i++) {
    p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 100 + i }), at: i * 100 });
    p.onFrame('B-1', { direction: 'recv', raw: frame(END, { sid: 100 + i, odd: 2 }), at: i * 100 + 50 });
  }
  p.onFrame('B-2', { direction: 'recv', raw: frame(OPEN, { sid: 900 }), at: 1 });
  p.onFrame('B-2', { direction: 'recv', raw: frame(END, { sid: 900, odd: 2 }), at: 2 });
  const page1 = store.listRounds({ browserId: 'B-1', limit: 2, offset: 0 });
  assert.equal(page1.total, 5);
  assert.equal(page1.rounds.length, 2);
  const page3 = store.listRounds({ browserId: 'B-1', limit: 2, offset: 4 });
  assert.equal(page3.rounds.length, 1);
  assert.equal(store.listRounds({ browserId: 'B-2' }).total, 1); // browser isolation
  store.close();
});

test('getRoundDetail rejects invalid ids', () => {
  const store = memStore();
  assert.equal(store.getRoundDetail(-1).error.code, 'INVALID_ROUND_ID');
  assert.equal(store.getRoundDetail('abc').error.code, 'INVALID_ROUND_ID');
  assert.equal(store.getRoundDetail(9999).error.code, 'ROUND_NOT_FOUND');
  store.close();
});

// ---- Durability + crash reconciliation (§29.37-45, §20) ----
test('data survives store close + reopen (restart durability)', () => {
  const { dir, file } = tmpFile('dur');
  let store = new AnalyticsStore({ file });
  let p = new AnalyticsPersistence({ store });
  p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 1 }), at: 0 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(END, { sid: 1, odd: 2 }), at: 10 });
  p.endSession('B-1', 'STOPPED');
  const countBefore = store.counts();
  store.close();

  store = new AnalyticsStore({ file });
  assert.equal(store.counts().rounds, countBefore.rounds);
  assert.equal(store.counts().rawEvents, countBefore.rawEvents);
  assert.equal(store.listRounds({ browserId: 'B-1' }).rounds[0].completeness, 'COMPLETE');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('crash (session left CAPTURING) reconciles to INTERRUPTED on restart, no fabricated END', () => {
  const { dir, file } = tmpFile('crash');
  let store = new AnalyticsStore({ file });
  let p = new AnalyticsPersistence({ store });
  const sid = p.beginSession('B-1');
  p.onFrame('B-1', { direction: 'recv', raw: frame(OPEN, { sid: 1 }), at: 0 });
  p.onFrame('B-1', { direction: 'recv', raw: frame(ODD, { sid: 1, odd: 1.7 }), at: 10 });
  // simulate crash: close WITHOUT endSession (session stays CAPTURING, round unfinished)
  store.close();

  store = new AnalyticsStore({ file });
  const rec = store.reconcileOnStartup();
  assert.ok(rec.sessions >= 1);
  assert.equal(store.sessions.get(sid).status, 'INTERRUPTED');
  assert.equal(store.sessions.get(sid).ended_at_ms, null, 'no fabricated end time');
  const r = store.listRounds({ browserId: 'B-1' }).rounds[0];
  assert.equal(r.completeness, 'INTERRUPTED');
  assert.equal(r.endedAtMs, null, 'no fabricated END');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
