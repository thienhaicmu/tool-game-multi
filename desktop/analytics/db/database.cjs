'use strict';

const Database = require('better-sqlite3');
const { runMigrations, currentVersion, LATEST_VERSION, AnalyticsDbError } = require('./migrations.cjs');

// ---------------------------------------------------------------------------
// Analytics database bootstrap (MAIN-PROCESS owned). Opens the SQLite file,
// applies safe local-app pragmas, and runs migrations. Renderer never receives
// this handle — only validated query results flow over IPC.
//
// Pragma choices (verified by tests):
//   journal_mode = WAL   -> concurrent readers + durable single writer; must be
//                           set OUTSIDE a transaction (it is, here, before migrations).
//   foreign_keys = ON    -> enforce the REFERENCES constraints in the schema.
//   busy_timeout = 5000  -> wait rather than immediately throwing SQLITE_BUSY.
//   synchronous = NORMAL -> safe with WAL for a local desktop app; good write cost.
// ---------------------------------------------------------------------------

function openDatabase({ file, readonly = false } = {}) {
  if (!file) throw new AnalyticsDbError('DB_NO_PATH', 'openDatabase requires a file path (or :memory:)');
  let db;
  try {
    db = new Database(file, { readonly });
  } catch (err) {
    throw new AnalyticsDbError('DB_OPEN_FAILED', `Could not open analytics DB at ${file}: ${err && err.message || err}`, err);
  }
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!readonly) runMigrations(db);
  return db;
}

module.exports = { openDatabase, currentVersion, LATEST_VERSION, AnalyticsDbError };
