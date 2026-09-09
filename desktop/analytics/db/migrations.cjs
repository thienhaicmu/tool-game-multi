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

// v3 — Prediction Research & Evaluation platform. Persisted, IMMUTABLE out-of-sample
// research evidence (§30/§31). These tables are APPENDED to alongside the captured
// round history; they never modify capture/round rows. A run row, once written, is a
// permanent record of one evaluation (algorithm fingerprint + dataset fingerprint +
// policy version + full result). Re-evaluating on more data inserts a NEW run.
const SCHEMA_V3 = `
CREATE TABLE research_algorithms (
  algorithm_id   TEXT NOT NULL,
  version        INTEGER NOT NULL,
  name           TEXT NOT NULL,
  family         TEXT NOT NULL,
  feature_set_id TEXT NOT NULL,
  description    TEXT,
  code_version   TEXT,
  created_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (algorithm_id, version)
);

CREATE TABLE research_experiments (
  id                     INTEGER PRIMARY KEY,
  experiment_key         TEXT NOT NULL UNIQUE,
  algorithm_id           TEXT NOT NULL,
  version                INTEGER NOT NULL,
  algorithm_fingerprint  TEXT NOT NULL,
  target                 TEXT NOT NULL,
  model_stage            TEXT NOT NULL,
  browser_scope          TEXT,
  created_at_ms          INTEGER NOT NULL
);

CREATE TABLE research_runs (
  id                     INTEGER PRIMARY KEY,
  experiment_id          INTEGER NOT NULL REFERENCES research_experiments(id),
  algorithm_id           TEXT NOT NULL,
  version                INTEGER NOT NULL,
  algorithm_fingerprint  TEXT NOT NULL,
  dataset_fingerprint    TEXT NOT NULL,
  frozen_fingerprint     TEXT NOT NULL,
  target                 TEXT NOT NULL,
  model_stage            TEXT NOT NULL,
  browser_scope          TEXT,
  code_revision          TEXT,
  leakage_status         TEXT NOT NULL,
  leakage_policy_version INTEGER NOT NULL,
  status                 TEXT NOT NULL,
  n                      INTEGER,
  time_range_start_ms    INTEGER,
  time_range_end_ms      INTEGER,
  test_n                 INTEGER,
  test_positives         INTEGER,
  prevalence             REAL,
  auc                    REAL,
  pr_auc                 REAL,
  brier                  REAL,
  log_loss               REAL,
  delta_brier_test       REAL,
  calibration_max_diff   REAL,
  stability_status       TEXT,
  conclusion_status      TEXT,
  conclusion_magnitude   TEXT,
  quality_status         TEXT,
  result_json            TEXT NOT NULL,
  evaluated_at_ms        INTEGER NOT NULL,
  created_at_ms          INTEGER NOT NULL
);

CREATE TABLE research_metrics (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES research_runs(id),
  split      TEXT NOT NULL,
  n          INTEGER,
  positives  INTEGER,
  prevalence REAL,
  auc        REAL,
  pr_auc     REAL,
  brier      REAL,
  log_loss   REAL
);

CREATE TABLE research_walk_forward (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES research_runs(id),
  fold           INTEGER NOT NULL,
  train_n        INTEGER,
  test_n         INTEGER,
  prevalence     REAL,
  auc            REAL,
  pr_auc         REAL,
  brier          REAL,
  baseline_brier REAL,
  delta_brier    REAL
);

CREATE TABLE research_calibration (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES research_runs(id),
  bin            INTEGER NOT NULL,
  lo             REAL,
  hi             REAL,
  n              INTEGER,
  mean_predicted REAL,
  observed_rate  REAL,
  diff           REAL
);

CREATE TABLE research_coefficients (
  id         INTEGER PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES research_runs(id),
  feature    TEXT NOT NULL,
  mean_coef  REAL,
  sign_flips INTEGER,
  stable     INTEGER
);

CREATE INDEX idx_research_runs_experiment ON research_runs(experiment_id, evaluated_at_ms);
CREATE INDEX idx_research_runs_frozen     ON research_runs(frozen_fingerprint);
CREATE INDEX idx_research_runs_algo       ON research_runs(algorithm_id, version, target, model_stage);
CREATE INDEX idx_research_metrics_run     ON research_metrics(run_id);
CREATE INDEX idx_research_wf_run          ON research_walk_forward(run_id);
CREATE INDEX idx_research_calib_run       ON research_calibration(run_id);
CREATE INDEX idx_research_coef_run        ON research_coefficients(run_id);
`;

// v4 — Prediction Research V2 (multi-algorithm families + batches). PURELY ADDITIVE:
// new research_* tables + nullable columns on existing research tables. V1 research
// history keeps loading unchanged (§57); existing runs simply have NULL in the new
// columns. Never touches capture/round history. A BATCH groups algorithms evaluated
// on the SAME dataset snapshot + policy versions (§37); a run's evaluation_generation
// records that re-evaluation on more data is a new generation, never an overwrite (§35).
const SCHEMA_V4 = `
CREATE TABLE research_batches (
  id                     INTEGER PRIMARY KEY,
  batch_key              TEXT NOT NULL UNIQUE,
  created_at_ms          INTEGER NOT NULL,
  browser_scope          TEXT,
  schema_version         INTEGER,
  code_revision          TEXT,
  quality_policy_version INTEGER,
  comparability_policy_version INTEGER,
  fingerprint_policy_version   INTEGER,
  dataset_fingerprints   TEXT,
  cell_count             INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE research_search_ledger (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER NOT NULL REFERENCES research_runs(id),
  config_json      TEXT NOT NULL,
  validation_brier REAL,
  status           TEXT,
  selected         INTEGER NOT NULL DEFAULT 0,
  reason           TEXT
);

ALTER TABLE research_runs ADD COLUMN family                 TEXT;
ALTER TABLE research_runs ADD COLUMN kind                   TEXT;
ALTER TABLE research_runs ADD COLUMN complexity_params      INTEGER;
ALTER TABLE research_runs ADD COLUMN delta_brier_vs_linear  REAL;
ALTER TABLE research_runs ADD COLUMN incremental_value      TEXT;
ALTER TABLE research_runs ADD COLUMN batch_id               INTEGER;
ALTER TABLE research_runs ADD COLUMN evaluation_generation  INTEGER;
ALTER TABLE research_runs ADD COLUMN search_space_version   INTEGER;
ALTER TABLE research_runs ADD COLUMN quality_policy_version INTEGER;

ALTER TABLE research_algorithms ADD COLUMN kind            TEXT;
ALTER TABLE research_algorithms ADD COLUMN capability      TEXT;
ALTER TABLE research_algorithms ADD COLUMN experimental    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_algorithms ADD COLUMN deprecated      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_algorithms ADD COLUMN complexity_class TEXT;

CREATE INDEX idx_research_runs_family ON research_runs(family, target, model_stage);
CREATE INDEX idx_research_runs_batch  ON research_runs(batch_id);
CREATE INDEX idx_research_ledger_run  ON research_search_ledger(run_id);
`;

const MIGRATIONS = [
  { version: 1, up: (db) => { db.exec(SCHEMA_V1); } },
  { version: 2, up: (db) => { db.exec(SCHEMA_V2); } },
  { version: 3, up: (db) => { db.exec(SCHEMA_V3); } },
  { version: 4, up: (db) => { db.exec(SCHEMA_V4); } },
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
