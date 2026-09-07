import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { openDatabase, currentVersion, LATEST_VERSION } = require('../../desktop/analytics/db/database.cjs');
const { runMigrations, AnalyticsDbError } = require('../../desktop/analytics/db/migrations.cjs');

// §29.1 / §29.2
test('fresh DB migrates to latest and reports correct user_version', () => {
  const db = openDatabase({ file: ':memory:' });
  assert.equal(currentVersion(db), LATEST_VERSION);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).sort();
  for (const t of ['capture_sessions', 'raw_protocol_events', 'rounds', 'round_odd_samples', 'round_jackpot_samples', 'round_metrics']) {
    assert.ok(tables.includes(t), 'missing table ' + t);
  }
  db.close();
});

// §29.3
test('migration rerun is idempotent', () => {
  const db = openDatabase({ file: ':memory:' });
  const v1 = currentVersion(db);
  const again = runMigrations(db); // no-op second pass
  assert.equal(again, v1);
  assert.equal(currentVersion(db), LATEST_VERSION);
  db.close();
});

// §29.4
test('migration failure does not partially advance user_version', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  // Pre-create a conflicting table so CREATE TABLE rounds inside migration v1 fails.
  db.exec('CREATE TABLE rounds(x INTEGER)');
  assert.throws(() => runMigrations(db), (e) => e instanceof AnalyticsDbError && e.code === 'DB_MIGRATION_FAILED');
  assert.equal(currentVersion(db), 0, 'schema version must NOT advance on failure');
  // the pre-existing table is preserved (DB not destroyed)
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='rounds'").get());
  // and the migration left no half-created tables
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='capture_sessions'").get().n, 0);
  db.close();
});

// §29.5
test('foreign_keys are enforced', () => {
  const db = openDatabase({ file: ':memory:' });
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  // inserting a raw event referencing a non-existent session must fail
  assert.throws(() => db.prepare(
    `INSERT INTO raw_protocol_events (capture_session_id, browser_id, direction, wall_timestamp_ms, parse_status, created_at_ms)
     VALUES (9999, 'B-0001', 'RECV', 1, 'OK', 1)`
  ).run(), /FOREIGN KEY/i);
  db.close();
});

// §29.6 — DB isolated to its own file (two files are independent)
test('separate DB files are fully isolated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-db-'));
  const fileA = path.join(dir, 'a.db');
  const fileB = path.join(dir, 'b.db');
  const a = openDatabase({ file: fileA });
  a.prepare(`INSERT INTO capture_sessions (browser_id, started_at_ms, status, created_at_ms, updated_at_ms) VALUES ('B-1', 1, 'CAPTURING', 1, 1)`).run();
  a.close();
  const b = openDatabase({ file: fileB });
  assert.equal(b.prepare('SELECT COUNT(*) AS n FROM capture_sessions').get().n, 0);
  b.close();
  const a2 = openDatabase({ file: fileA });
  assert.equal(a2.prepare('SELECT COUNT(*) AS n FROM capture_sessions').get().n, 1);
  a2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// WAL is applied for file-backed databases.
test('file-backed DB uses WAL journal mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-wal-'));
  const file = path.join(dir, 'w.db');
  const db = openDatabase({ file });
  assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
