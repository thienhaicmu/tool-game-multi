'use strict';

const { THRESHOLDS, columnsFor } = require('../thresholds.cjs');

// ---------------------------------------------------------------------------
// Analytics SQLite migrations. PRAGMA user_version is the authoritative schema
// version. Each migration runs inside a single transaction together with the
// user_version bump, so a failure rolls back completely and NEVER partially
// advances the schema (the existing database is preserved).
// ---------------------------------------------------------------------------

class AnalyticsDbError extends Error {
  constructor(code, message, cause) { super(message); this.name = 'AnalyticsDbError'; this.code = code; this.cause = cause; }
}

// round_metrics threshold columns, generated from the shared threshold list so
// the schema and the metric computation can never drift apart.
function roundMetricsColumns() {
  const cols = [];
  for (const t of THRESHOLDS) {
    const c = columnsFor(t);
    cols.push(`  ${c.reached} INTEGER NOT NULL DEFAULT 0`);
    cols.push(`  ${c.time} INTEGER`);
  }
  return cols.join(',\n');
}

const SCHEMA_V1 = `
CREATE TABLE capture_sessions (
  id               INTEGER PRIMARY KEY,
  browser_id       TEXT NOT NULL,
  started_at_ms    INTEGER NOT NULL,
  ended_at_ms      INTEGER,
  status           TEXT NOT NULL,
  last_event_at_ms INTEGER,
  disconnect_count INTEGER NOT NULL DEFAULT 0,
  created_at_ms    INTEGER NOT NULL,
  updated_at_ms    INTEGER NOT NULL
);

CREATE TABLE raw_protocol_events (
  id                     INTEGER PRIMARY KEY,
  capture_session_id     INTEGER NOT NULL REFERENCES capture_sessions(id),
  browser_id             TEXT NOT NULL,
  ws_connection_id       TEXT,
  direction              TEXT NOT NULL,             -- RECV | SEND
  origin                 TEXT,                      -- SERVER | WEBSITE
  wall_timestamp_ms      INTEGER NOT NULL,
  monotonic_timestamp_ms INTEGER,
  opcode                 INTEGER,
  raw_payload            TEXT,
  parse_status           TEXT NOT NULL,             -- OK | UNKNOWN_CMD | UNPARSED
  parse_error            TEXT,
  cmd                    INTEGER,
  event_type             TEXT,
  sid                    TEXT,
  odd                    REAL,
  jackpot                REAL,
  source_target_id       TEXT,
  source_session_id      TEXT,
  created_at_ms          INTEGER NOT NULL
);

CREATE TABLE rounds (
  id                   INTEGER PRIMARY KEY,
  capture_session_id   INTEGER NOT NULL REFERENCES capture_sessions(id),
  browser_id           TEXT NOT NULL,
  sid                  TEXT,
  sequence_number      INTEGER NOT NULL,
  opened_at_ms         INTEGER,
  locked_at_ms         INTEGER,
  first_odd_at_ms      INTEGER,
  ended_at_ms          INTEGER,
  duration_ms          INTEGER,
  first_odd            REAL,
  last_odd             REAL,
  max_odd              REAL,
  jackpot_at_open      REAL,
  jackpot_at_lock      REAL,
  jackpot_at_first_odd REAL,
  jackpot_at_end       REAL,
  jackpot_min          REAL,
  jackpot_max          REAL,
  jackpot_avg          REAL,
  jackpot_delta        REAL,
  odd_sample_count     INTEGER NOT NULL DEFAULT 0,
  jackpot_sample_count INTEGER NOT NULL DEFAULT 0,
  completeness         TEXT NOT NULL,
  created_at_ms        INTEGER NOT NULL,
  updated_at_ms        INTEGER NOT NULL
);

CREATE TABLE round_odd_samples (
  id                        INTEGER PRIMARY KEY,
  round_id                  INTEGER NOT NULL REFERENCES rounds(id),
  sequence                  INTEGER NOT NULL,
  timestamp_ms              INTEGER NOT NULL,
  elapsed_from_first_odd_ms INTEGER,
  odd                       REAL NOT NULL,
  source_event_id           INTEGER
);

CREATE TABLE round_jackpot_samples (
  id              INTEGER PRIMARY KEY,
  round_id        INTEGER NOT NULL REFERENCES rounds(id),
  sequence        INTEGER NOT NULL,
  timestamp_ms    INTEGER NOT NULL,
  elapsed_ms      INTEGER,
  jackpot         REAL NOT NULL,
  source_event_id INTEGER
);

CREATE TABLE round_metrics (
  round_id        INTEGER PRIMARY KEY REFERENCES rounds(id),
  timing_censored INTEGER NOT NULL DEFAULT 0,
${roundMetricsColumns()}
);

-- Minimal, query-plan-driven indexes (§6).
CREATE INDEX idx_raw_session_time ON raw_protocol_events(capture_session_id, wall_timestamp_ms);
CREATE INDEX idx_raw_browser_time ON raw_protocol_events(browser_id, wall_timestamp_ms);
CREATE INDEX idx_rounds_browser_seq ON rounds(browser_id, sequence_number);
CREATE INDEX idx_rounds_opened ON rounds(opened_at_ms);
CREATE INDEX idx_rounds_sid ON rounds(sid);
CREATE INDEX idx_rounds_session ON rounds(capture_session_id);
CREATE INDEX idx_odd_samples_round ON round_odd_samples(round_id, sequence);
CREATE INDEX idx_jp_samples_round ON round_jackpot_samples(round_id, sequence);
`;

// v2 — passive Web/network collection. Raw HTTP + WebSocket evidence becomes a
// first-class layer; protocol events gain provenance back to the raw WS frame.
const SCHEMA_V2 = `
CREATE TABLE network_requests (
  id                       INTEGER PRIMARY KEY,
  capture_session_id       INTEGER NOT NULL REFERENCES capture_sessions(id),
  browser_id               TEXT NOT NULL,
  target_id                TEXT,
  session_id               TEXT,
  request_id               TEXT,
  loader_id                TEXT,
  timestamp_ms             INTEGER NOT NULL,
  monotonic_ms             REAL,
  resource_type            TEXT,
  method                   TEXT,
  url                      TEXT,
  scheme                   TEXT,
  host                     TEXT,
  path                     TEXT,
  request_headers          TEXT,   -- JSON
  request_body             TEXT,
  initiator_type           TEXT,
  redirect_from_request_id INTEGER,
  created_at_ms            INTEGER NOT NULL
);

CREATE TABLE network_responses (
  id                  INTEGER PRIMARY KEY,
  network_request_id  INTEGER NOT NULL REFERENCES network_requests(id),
  timestamp_ms        INTEGER,
  status              INTEGER,
  status_text         TEXT,
  mime_type           TEXT,
  protocol            TEXT,
  response_headers    TEXT,   -- JSON
  remote_ip           TEXT,
  remote_port         INTEGER,
  from_disk_cache     INTEGER,
  from_service_worker INTEGER,
  encoded_data_length INTEGER,
  timing_json         TEXT,
  failed              INTEGER NOT NULL DEFAULT 0,
  failure_reason      TEXT,
  duration_ms         INTEGER,
  created_at_ms       INTEGER NOT NULL
);

CREATE TABLE network_bodies (
  id                 INTEGER PRIMARY KEY,
  network_request_id INTEGER NOT NULL REFERENCES network_requests(id),
  body               TEXT,
  base64_encoded     INTEGER NOT NULL DEFAULT 0,
  body_size          INTEGER,
  capture_status     TEXT NOT NULL,   -- CAPTURED | SKIPPED_TOO_LARGE | SKIPPED_TYPE | UNAVAILABLE | FAILED
  capture_error      TEXT,
  created_at_ms      INTEGER NOT NULL
);

CREATE TABLE ws_connections (
  id                 INTEGER PRIMARY KEY,
  capture_session_id INTEGER NOT NULL REFERENCES capture_sessions(id),
  browser_id         TEXT NOT NULL,
  target_id          TEXT,
  request_id         TEXT,
  url                TEXT,
  opened_at_ms       INTEGER,
  closed_at_ms       INTEGER,
  close_status       TEXT,
  send_count         INTEGER NOT NULL DEFAULT 0,
  recv_count         INTEGER NOT NULL DEFAULT 0,
  created_at_ms      INTEGER NOT NULL
);

CREATE TABLE raw_ws_events (
  id                 INTEGER PRIMARY KEY,
  ws_connection_id   INTEGER REFERENCES ws_connections(id),
  capture_session_id INTEGER NOT NULL REFERENCES capture_sessions(id),
  browser_id         TEXT NOT NULL,
  direction          TEXT NOT NULL,   -- SEND (website) | RECV (server)
  timestamp_ms       INTEGER NOT NULL,
  monotonic_ms       REAL,
  opcode             INTEGER,
  payload            TEXT,
  payload_size       INTEGER,
  parse_status       TEXT,
  cmd                INTEGER,
  event_type         TEXT,
  sid                TEXT,
  odd                REAL,
  jackpot            REAL,
  created_at_ms      INTEGER NOT NULL
);

ALTER TABLE raw_protocol_events ADD COLUMN source_ws_event_id INTEGER;

CREATE INDEX idx_netreq_browser_time  ON network_requests(browser_id, timestamp_ms);
CREATE INDEX idx_netreq_session_time  ON network_requests(capture_session_id, timestamp_ms);
CREATE INDEX idx_netreq_host          ON network_requests(host, timestamp_ms);
CREATE INDEX idx_netreq_reqid         ON network_requests(capture_session_id, request_id);
CREATE INDEX idx_netresp_req          ON network_responses(network_request_id);
CREATE INDEX idx_netbody_req          ON network_bodies(network_request_id);
CREATE INDEX idx_rawws_browser_time   ON raw_ws_events(browser_id, timestamp_ms);
CREATE INDEX idx_rawws_conn           ON raw_ws_events(ws_connection_id, id);
CREATE INDEX idx_wsconn_session       ON ws_connections(capture_session_id);
`;

const MIGRATIONS = [
  { version: 1, up: (db) => { db.exec(SCHEMA_V1); } },
  { version: 2, up: (db) => { db.exec(SCHEMA_V2); } },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function currentVersion(db) { return db.pragma('user_version', { simple: true }); }

// Run all pending migrations in order. Each (DDL + user_version bump) is one
// transaction. Returns the final schema version.
function runMigrations(db) {
  let current = currentVersion(db);
  if (current > LATEST_VERSION) {
    throw new AnalyticsDbError('DB_SCHEMA_TOO_NEW', `Database schema v${current} is newer than supported v${LATEST_VERSION}`);
  }
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const apply = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    try { apply(); }
    catch (err) {
      // Transaction rolled back: schema version NOT advanced, DB preserved.
      throw new AnalyticsDbError('DB_MIGRATION_FAILED', `Migration to v${m.version} failed: ${err && err.message || err}`, err);
    }
    current = m.version;
  }
  return current;
}

module.exports = { runMigrations, currentVersion, LATEST_VERSION, MIGRATIONS, AnalyticsDbError };
