import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { openDatabase, currentVersion, LATEST_VERSION } = require('../../desktop/analytics/db/database.cjs');
const { runMigrations, MIGRATIONS, AnalyticsDbError } = require('../../desktop/analytics/db/migrations.cjs');

const NETWORK_TABLES = ['network_requests', 'network_responses', 'network_bodies', 'ws_connections', 'raw_ws_events'];
const RESEARCH_TABLES = ['research_algorithms', 'research_experiments', 'research_runs', 'research_metrics', 'research_walk_forward', 'research_calibration', 'research_coefficients'];
const RESEARCH_V2_TABLES = ['research_batches', 'research_search_ledger']; // added in v4

test('fresh DB migrates to latest (v4) with network + research (V1+V2) tables + provenance column', () => {
  assert.equal(LATEST_VERSION, 4);
  const db = openDatabase({ file: ':memory:' });
  assert.equal(currentVersion(db), LATEST_VERSION);
  for (const t of RESEARCH_V2_TABLES) assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), 'missing ' + t);
  assert.ok(db.prepare('PRAGMA table_info(research_runs)').all().some((c) => c.name === 'incremental_value'), 'v4 column present');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of NETWORK_TABLES) assert.ok(tables.includes(t), 'missing ' + t);
  for (const t of RESEARCH_TABLES) assert.ok(tables.includes(t), 'missing ' + t);
  assert.ok(db.prepare('PRAGMA table_info(raw_protocol_events)').all().some((c) => c.name === 'source_ws_event_id'));
  db.close();
});

test('v2 DB upgrades in place to v3 adding research tables, preserving data', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.transaction(() => { MIGRATIONS[0].up(db); MIGRATIONS[1].up(db); db.pragma('user_version = 2'); })();
  db.prepare("INSERT INTO capture_sessions(browser_id,started_at_ms,status,created_at_ms,updated_at_ms) VALUES('B-1',1,'STOPPED',1,1)").run();
  runMigrations(db); // 2 -> latest
  assert.equal(currentVersion(db), LATEST_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_sessions').get().n, 1);
  for (const t of [...RESEARCH_TABLES, ...RESEARCH_V2_TABLES]) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  db.close();
});

test('v1 DB upgrades in place to v2 preserving all existing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm16-mig-'));
  const file = path.join(dir, 'a.db');
  const raw = new Database(file);
  raw.transaction(() => { MIGRATIONS[0].up(raw); raw.pragma('user_version = 1'); })();
  raw.prepare("INSERT INTO capture_sessions(browser_id,started_at_ms,status,created_at_ms,updated_at_ms) VALUES('B-1',1,'STOPPED',1,1)").run();
  raw.prepare("INSERT INTO rounds(capture_session_id,browser_id,sequence_number,completeness,created_at_ms,updated_at_ms) VALUES(1,'B-1',1,'COMPLETE',1,1)").run();
  raw.prepare("INSERT INTO round_odd_samples(round_id,sequence,timestamp_ms,odd) VALUES(1,0,1,2.5)").run();
  raw.prepare("INSERT INTO raw_protocol_events(capture_session_id,browser_id,direction,wall_timestamp_ms,parse_status,created_at_ms) VALUES(1,'B-1','RECV',1,'OK',1)").run();
  raw.close();

  const db = openDatabase({ file }); // triggers migration 1->latest
  assert.equal(currentVersion(db), LATEST_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM round_odd_samples').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM raw_protocol_events').get().n, 1);
  for (const t of NETWORK_TABLES) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v2 migration failure is transactional: schema stays at v1, data preserved', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.transaction(() => { MIGRATIONS[0].up(db); db.pragma('user_version = 1'); })();
  db.prepare("INSERT INTO capture_sessions(browser_id,started_at_ms,status,created_at_ms,updated_at_ms) VALUES('B-1',1,'STOPPED',1,1)").run();
  // conflict: pre-create a table the v2 migration will try to CREATE
  db.exec('CREATE TABLE network_requests(x INTEGER)');
  assert.throws(() => runMigrations(db), (e) => e instanceof AnalyticsDbError && e.code === 'DB_MIGRATION_FAILED');
  assert.equal(currentVersion(db), 1, 'must not advance past v1 on failure');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM capture_sessions').get().n, 1);
  // the WS-events table from v2 must NOT exist (rolled back)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='raw_ws_events'").get().n, 0);
  db.close();
});
