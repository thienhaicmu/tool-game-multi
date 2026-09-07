import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsPersistence } = require('../../desktop/analytics/persistence.cjs');
const { normalizeFilter } = require('../../desktop/analytics/query/analytics-filter.cjs');
const E = require('../../desktop/analytics/export/exporter.cjs');
const { THRESHOLDS } = require('../../desktop/analytics/thresholds.cjs');

function tmp(tag) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-' + tag + '-')); return { dir, file: path.join(dir, 'a.db') }; }
const OPEN = 100005, ODD = 100009, END = 100007;
function seedRound(p, b, sid, odd, jp, t) {
  p.onFrame(b, { direction: 'recv', raw: `{"cmd":${OPEN},"sid":${sid}${jp != null ? `,"eI":{"jp":${jp}}` : ''}}`, at: t });
  p.onFrame(b, { direction: 'recv', raw: `{"cmd":${ODD},"sid":${sid},"odd":${odd}}`, at: t + 50 });
  p.onFrame(b, { direction: 'recv', raw: `{"cmd":${END},"sid":${sid},"odd":${odd}}`, at: t + 100 });
}

test('CSV export: deterministic header incl. all threshold columns; NULL is empty; escaping', () => {
  const header = E.roundCsvHeader();
  assert.equal(header.length, 24 + THRESHOLDS.length * 2);
  assert.equal(header[0], 'sequenceNumber');
  assert.ok(header.includes('reached_200'));      // 2.00x
  assert.ok(header.includes('timeTo_100000_ms'));  // 1000.00x (key = 100000)
  // escaping
  assert.equal(E.csvCell('a,b'), '"a,b"');
  assert.equal(E.csvCell('he said "hi"'), '"he said ""hi"""');
  assert.equal(E.csvCell(null), '');
  assert.equal(E.csvCell(2.5), '2.5');
});

test('CSV export is filter-scoped and row-accurate', () => {
  const { dir, file } = tmp('csv');
  const store = new AnalyticsStore({ file }); const p = new AnalyticsPersistence({ store });
  let t = 1000;
  seedRound(p, 'B-1', 1, 2.5, 300, t); t += 1000;
  seedRound(p, 'B-1', 2, 9.0, 400, t); t += 1000;
  seedRound(p, 'B-2', 3, 4.0, null, t);
  const out = path.join(dir, 'r.csv');
  const res = E.exportRoundsCsv(store, normalizeFilter({ browserId: 'B-1' }), out);
  assert.equal(res.rows, 2);
  const lines = fs.readFileSync(out, 'utf8').split('\r\n').filter(Boolean);
  assert.equal(lines.length, 3); // header + 2 rows
  assert.equal(lines[0].split(',').length, E.roundCsvHeader().length);
  // rows are DESC by sequence → first data row is sid 2 (maxOdd 9)
  assert.ok(lines[1].includes(',9,') || lines[1].includes(',9.0,'));
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('Round Detail JSON export contains exact persisted samples + raw events', () => {
  const { dir, file } = tmp('json');
  const store = new AnalyticsStore({ file }); const p = new AnalyticsPersistence({ store });
  seedRound(p, 'B-1', 7, 3.2, 500, 1000);
  const rid = store.listRounds({ browserId: 'B-1' }).rounds[0].id;
  const out = path.join(dir, 'd.json');
  E.exportRoundDetailJson(store, rid, out);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.schemaVersion, E.EXPORT_SCHEMA_VERSION);
  assert.ok(j.exportedAt);
  assert.equal(j.round.id, rid);
  assert.equal(j.round.maxOdd, 3.2);
  assert.equal(j.oddSamples.length, store.rounds.getOddSamples(rid).length);
  assert.ok(j.rawEvents.length >= 3);
  // exact values, not reconstructed
  assert.equal(j.round.jackpotAtOpen, 500);
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('Raw events JSONL export: line count, parseability, rawPayload preserved', () => {
  const { dir, file } = tmp('jsonl');
  const store = new AnalyticsStore({ file }); const p = new AnalyticsPersistence({ store });
  seedRound(p, 'B-1', 1, 2, null, 1000);          // 3 recv frames
  p.onFrame('B-1', { direction: 'send', raw: '{"cmd":100002}', at: 2000 }); // + 1 website SEND
  const out = path.join(dir, 'raw.jsonl');
  const res = E.exportRawEventsJsonl(store, { browserId: 'B-1' }, out);
  const lines = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean);
  assert.equal(res.lines, 4); assert.equal(lines.length, 4);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.ok(parsed.every((e) => e.raw_payload != null));         // rawPayload preserved
  assert.ok(parsed.some((e) => e.direction === 'SEND'));         // website SEND kept as evidence
  // ordered by id ascending
  assert.deepEqual(parsed.map((e) => e.id), [...parsed.map((e) => e.id)].sort((a, b) => a - b));
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
