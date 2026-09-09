'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Deterministic research fingerprints (§7/§9/§31). Two evaluation results may be
// treated as the SAME algorithm/config only if their algorithm fingerprints match,
// and as the SAME data population only if their dataset fingerprints match. Display
// names are never trusted. Fingerprints are stable SHA-256 digests over a
// canonical (sorted-key) JSON encoding, so field order never changes the hash.
// ---------------------------------------------------------------------------

const POLICY_VERSION = 1; // bump only when fingerprint composition changes (invalidates comparability across versions)

// Stable stringify: object keys sorted recursively, arrays kept in order (order is
// meaningful for things like split fractions), undefined dropped.
function canonical(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  return JSON.stringify(v);
}

function sha(obj) { return crypto.createHash('sha256').update(canonical(obj)).digest('hex'); }

// Algorithm fingerprint — identity of an evaluated CONFIGURATION (§7). A materially
// changed feature list / transform / regularization / training semantics yields a
// different fingerprint even under the same display name.
function algorithmFingerprint(cfg) {
  return 'alg_' + sha({
    v: POLICY_VERSION,
    algorithmId: cfg.algorithmId,
    version: cfg.version,
    family: cfg.family,
    modelStage: cfg.modelStage,
    target: cfg.target,
    featureNames: [...(cfg.featureNames || [])].sort(),
    hyperparameters: cfg.hyperparameters || {},
    preprocessing: cfg.preprocessing,
    splitPolicy: cfg.splitPolicy,
    guards: cfg.guards || {},
  }).slice(0, 24);
}

// Dataset fingerprint — identity of the DATA POPULATION used (§9). Deterministic,
// cheap: schema version + time bounds + eligible row count + scope + target/stage +
// (optional) a row-identity digest. Lets history distinguish "same model / different
// data" from "different model / same data".
function datasetFingerprint(meta) {
  return 'ds_' + sha({
    v: POLICY_VERSION,
    schemaVersion: meta.schemaVersion,
    modelStage: meta.modelStage,
    target: meta.target,
    browserScope: meta.browserScope == null ? 'ALL' : String(meta.browserScope),
    rowCount: meta.rowCount,
    browsers: meta.browsers,
    earliest: meta.earliest,
    latest: meta.latest,
    rowDigest: meta.rowDigest || null,
  }).slice(0, 24);
}

// A compact, deterministic digest of the exact eligible rows (browser/sid/time/target),
// so two snapshots with identical size but different membership differ. Order-independent
// (xor of per-row hashes) and streaming-cheap.
function rowIdentityDigest(rows) {
  let acc = 0n;
  for (const r of rows) {
    const h = crypto.createHash('sha256').update(`${r.browserId}|${r.sid}|${r.eventTime}|${r.target}`).digest();
    acc ^= BigInt('0x' + h.subarray(0, 8).toString('hex'));
  }
  return acc.toString(16);
}

module.exports = { algorithmFingerprint, datasetFingerprint, rowIdentityDigest, canonical, sha, POLICY_VERSION };
