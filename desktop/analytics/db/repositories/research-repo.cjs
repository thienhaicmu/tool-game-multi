'use strict';

// ---------------------------------------------------------------------------
// ResearchRepo — persistence for the Prediction Research platform (§30/§31/§32).
//
// Writes ONLY to research_* tables; never touches capture/round history. A run is
// IMMUTABLE once written: we INSERT, never UPDATE a run's metrics. Re-evaluation on
// a different data population inserts a new run (new dataset fingerprint → new
// frozen fingerprint). Identical re-runs (same frozen fingerprint) are deduped and
// the existing run is returned, because the evaluation is deterministic.
//
// The full result is stored as result_json (immutable evidence), and the queryable
// parts (headline metrics, per-split metrics, folds, calibration, coefficients) are
// ALSO normalized into structured tables for cheap history/comparison/drift queries.
// ---------------------------------------------------------------------------

class ResearchRepo {
  constructor(db, now = () => Date.now()) {
    this._db = db; this._now = now;

    this._upsertAlgo = db.prepare(
      `INSERT INTO research_algorithms (algorithm_id, version, name, family, feature_set_id, description, code_version, kind, capability, experimental, deprecated, complexity_class, created_at_ms)
       VALUES (@algorithmId, @version, @name, @family, @featureSetId, @description, @codeVersion, @kind, @capability, @experimental, @deprecated, @complexityClass, @now)
       ON CONFLICT(algorithm_id, version) DO UPDATE SET name=@name, family=@family, feature_set_id=@featureSetId, description=@description, code_version=@codeVersion, kind=@kind, capability=@capability, experimental=@experimental, deprecated=@deprecated, complexity_class=@complexityClass`
    );
    this._findExperiment = db.prepare('SELECT * FROM research_experiments WHERE experiment_key=?');
    this._insertExperiment = db.prepare(
      `INSERT INTO research_experiments (experiment_key, algorithm_id, version, algorithm_fingerprint, target, model_stage, browser_scope, created_at_ms)
       VALUES (@experimentKey, @algorithmId, @version, @algorithmFingerprint, @target, @modelStage, @browserScope, @now)`
    );
    this._findRunByFrozen = db.prepare('SELECT * FROM research_runs WHERE frozen_fingerprint=?');
    this._insertRun = db.prepare(
      `INSERT INTO research_runs (
         experiment_id, algorithm_id, version, algorithm_fingerprint, dataset_fingerprint, frozen_fingerprint,
         target, model_stage, browser_scope, code_revision, leakage_status, leakage_policy_version, status, n,
         time_range_start_ms, time_range_end_ms, test_n, test_positives, prevalence, auc, pr_auc, brier, log_loss,
         delta_brier_test, calibration_max_diff, stability_status, conclusion_status, conclusion_magnitude, quality_status,
         family, kind, complexity_params, delta_brier_vs_linear, incremental_value, batch_id, evaluation_generation,
         search_space_version, quality_policy_version,
         result_json, evaluated_at_ms, created_at_ms)
       VALUES (@experimentId, @algorithmId, @version, @algorithmFingerprint, @datasetFingerprint, @frozenFingerprint,
         @target, @modelStage, @browserScope, @codeRevision, @leakageStatus, @leakagePolicyVersion, @status, @n,
         @timeRangeStartMs, @timeRangeEndMs, @testN, @testPositives, @prevalence, @auc, @prAuc, @brier, @logLoss,
         @deltaBrierTest, @calibrationMaxDiff, @stabilityStatus, @conclusionStatus, @conclusionMagnitude, @qualityStatus,
         @family, @kind, @complexityParams, @deltaBrierVsLinear, @incrementalValue, @batchId, @evaluationGeneration,
         @searchSpaceVersion, @qualityPolicyVersion,
         @resultJson, @evaluatedAtMs, @now)`
    );
    this._insertBatch = db.prepare(
      `INSERT INTO research_batches (batch_key, created_at_ms, browser_scope, schema_version, code_revision, quality_policy_version, comparability_policy_version, fingerprint_policy_version, dataset_fingerprints, cell_count)
       VALUES (@batchKey, @now, @browserScope, @schemaVersion, @codeRevision, @qualityPolicyVersion, @comparabilityPolicyVersion, @fingerprintPolicyVersion, @datasetFingerprints, @cellCount)`
    );
    this._insertLedger = db.prepare(
      `INSERT INTO research_search_ledger (run_id, config_json, validation_brier, status, selected, reason)
       VALUES (@runId, @configJson, @validationBrier, @status, @selected, @reason)`
    );
    this._genCount = db.prepare('SELECT COUNT(*) AS n FROM research_runs WHERE experiment_id=?');
    this._insertMetric = db.prepare(
      `INSERT INTO research_metrics (run_id, split, n, positives, prevalence, auc, pr_auc, brier, log_loss)
       VALUES (@runId, @split, @n, @positives, @prevalence, @auc, @prAuc, @brier, @logLoss)`
    );
    this._insertFold = db.prepare(
      `INSERT INTO research_walk_forward (run_id, fold, train_n, test_n, prevalence, auc, pr_auc, brier, baseline_brier, delta_brier)
       VALUES (@runId, @fold, @trainN, @testN, @prevalence, @auc, @prAuc, @brier, @baselineBrier, @deltaBrier)`
    );
    this._insertCalib = db.prepare(
      `INSERT INTO research_calibration (run_id, bin, lo, hi, n, mean_predicted, observed_rate, diff)
       VALUES (@runId, @bin, @lo, @hi, @n, @meanPredicted, @observedRate, @diff)`
    );
    this._insertCoef = db.prepare(
      `INSERT INTO research_coefficients (run_id, feature, mean_coef, sign_flips, stable)
       VALUES (@runId, @feature, @meanCoef, @signFlips, @stable)`
    );
  }

  registerAlgorithm(a) {
    this._upsertAlgo.run({
      now: this._now(), algorithmId: a.algorithmId, version: a.version, name: a.name, family: a.family,
      featureSetId: a.featureSetId, description: a.description || null, codeVersion: a.codeVersion || null,
      kind: a.kind || null, capability: a.capability || null, experimental: a.experimental ? 1 : 0,
      deprecated: a.deprecated ? 1 : 0, complexityClass: a.complexityClass || null,
    });
  }

  // Create a batch (§37): one dataset snapshot + policy versions, many algorithm cells.
  createBatch(meta) {
    const info = this._insertBatch.run({
      now: this._now(), batchKey: meta.batchKey, browserScope: meta.browserScope == null ? null : String(meta.browserScope),
      schemaVersion: meta.schemaVersion != null ? meta.schemaVersion : null, codeRevision: meta.codeRevision || null,
      qualityPolicyVersion: meta.qualityPolicyVersion != null ? meta.qualityPolicyVersion : null,
      comparabilityPolicyVersion: meta.comparabilityPolicyVersion != null ? meta.comparabilityPolicyVersion : null,
      fingerprintPolicyVersion: meta.fingerprintPolicyVersion != null ? meta.fingerprintPolicyVersion : null,
      datasetFingerprints: meta.datasetFingerprints ? JSON.stringify(meta.datasetFingerprints) : null, cellCount: meta.cellCount || 0,
    });
    return Number(info.lastInsertRowid);
  }

  _experimentId(ev) {
    const existing = this._findExperiment.get(ev.experimentKey);
    if (existing) return existing.id;
    const info = this._insertExperiment.run({ now: this._now(), experimentKey: ev.experimentKey, algorithmId: ev.algorithmId, version: ev.version, algorithmFingerprint: ev.algorithmFingerprint, target: ev.target, modelStage: ev.modelStage, browserScope: ev.browserScope == null ? null : String(ev.browserScope) });
    return info.lastInsertRowid;
  }

  // Persist one evaluation. `ev` is an enriched evaluateAlgorithm() result (+ quality
  // + evaluatedAtMs). Optional `batchId` groups a cohort (§37). Returns { runId, deduped, evaluationGeneration }.
  saveRun(ev, batchId = null) {
    const frozen = ev.algorithmFingerprint + '|' + ev.datasetFingerprint;
    const prior = this._findRunByFrozen.get(frozen);
    if (prior) return { runId: prior.id, deduped: true, evaluationGeneration: prior.evaluation_generation };

    const now = this._now();
    const evaluatedAtMs = ev.evaluatedAtMs != null ? ev.evaluatedAtMs : now;
    const tx = this._db.transaction(() => {
      const experimentId = this._experimentId(ev);
      const generation = (this._genCount.get(experimentId).n || 0) + 1; // §35: monotonic per-experiment snapshot id
      const tm = ev.testMetrics || {};
      const runInfo = this._insertRun.run({
        now, evaluatedAtMs, experimentId,
        algorithmId: ev.algorithmId, version: ev.version, algorithmFingerprint: ev.algorithmFingerprint,
        datasetFingerprint: ev.datasetFingerprint, frozenFingerprint: frozen,
        target: ev.target, modelStage: ev.modelStage, browserScope: ev.browserScope == null ? null : String(ev.browserScope),
        codeRevision: ev.codeVersion || null, leakageStatus: ev.leakageStatus, leakagePolicyVersion: ev.leakagePolicyVersion,
        status: ev.status, n: ev.n != null ? ev.n : null,
        timeRangeStartMs: ev.timeRange ? ev.timeRange.start : null, timeRangeEndMs: ev.timeRange ? ev.timeRange.end : null,
        testN: tm.n != null ? tm.n : null, testPositives: tm.positives != null ? tm.positives : null,
        prevalence: num(tm.prevalence), auc: num(tm.auc), prAuc: num(tm.prAuc), brier: num(tm.brier), logLoss: num(tm.logLoss),
        deltaBrierTest: num(ev.deltaBrierTest),
        calibrationMaxDiff: ev.conclusion ? num(ev.conclusion.calibrationMaxDiff) : null,
        stabilityStatus: ev.stability ? ev.stability.status : null,
        conclusionStatus: ev.conclusion ? ev.conclusion.status : null,
        conclusionMagnitude: ev.conclusion ? ev.conclusion.magnitude : null,
        qualityStatus: ev.quality ? ev.quality.status : null,
        family: ev.family || null, kind: ev.kind || null,
        complexityParams: ev.complexity && ev.complexity.params != null ? ev.complexity.params : null,
        deltaBrierVsLinear: num(ev.deltaBrierVsLinear), incrementalValue: ev.incrementalValue || null,
        batchId: batchId != null ? batchId : null, evaluationGeneration: generation,
        searchSpaceVersion: ev.searchSpaceVersion != null ? ev.searchSpaceVersion : null,
        qualityPolicyVersion: ev.qualityPolicyVersion != null ? ev.qualityPolicyVersion : null,
        resultJson: JSON.stringify(ev),
      });
      const runId = runInfo.lastInsertRowid;
      // Hyperparameter search ledger (§31): persist ALL attempted configs, not just the winner.
      for (const e of (ev.searchLedger || [])) this._insertLedger.run({ runId, configJson: JSON.stringify(e.params || {}), validationBrier: num(e.validationBrier), status: e.status || null, selected: e.selected ? 1 : 0, reason: e.reason || null });

      if (ev.status === 'OK') {
        const base = ev.baseline || {};
        const splitMetric = (split, m) => this._insertMetric.run({ runId, split, n: m.n != null ? m.n : null, positives: m.positives != null ? m.positives : null, prevalence: num(m.prevalence), auc: num(m.auc), prAuc: num(m.prAuc), brier: num(m.brier), logLoss: num(m.logLoss) });
        if (ev.validation) splitMetric('VALIDATION', ev.validation);
        if (ev.testMetrics) splitMetric('TEST', ev.testMetrics);
        if (base.validation) splitMetric('BASELINE_VALIDATION', base.validation);
        if (base.test) splitMetric('BASELINE_TEST', base.test);
        for (const f of (ev.walkForward || [])) this._insertFold.run({ runId, fold: f.fold, trainN: f.trainN, testN: f.testN, prevalence: num(f.prevalence), auc: num(f.auc), prAuc: num(f.prAuc), brier: num(f.brier), baselineBrier: num(f.baselineBrier), deltaBrier: num(f.deltaBrier) });
        for (const c of (ev.calibration || [])) this._insertCalib.run({ runId, bin: c.bin, lo: num(c.lo), hi: num(c.hi), n: c.n, meanPredicted: num(c.meanPredicted), observedRate: num(c.observedRate), diff: num(c.diff) });
        for (const c of (ev.coefficientStability || [])) this._insertCoef.run({ runId, feature: c.feature, meanCoef: num(c.meanCoef), signFlips: c.signFlips ? 1 : 0, stable: c.stable ? 1 : 0 });
      }
      return { runId, generation };
    });
    const out = tx();
    return { runId: out.runId, deduped: false, evaluationGeneration: out.generation };
  }

  // ---- queries ----
  getRun(runId) { const r = this._db.prepare('SELECT * FROM research_runs WHERE id=?').get(Number(runId)); return r ? mapRun(r) : null; }
  getRunFull(runId) { const r = this.getRun(runId); if (!r) return null; return { ...r, result: JSON.parse(r.resultJson) }; }
  getMetrics(runId) { return this._db.prepare('SELECT * FROM research_metrics WHERE run_id=?').all(Number(runId)); }
  getWalkForward(runId) { return this._db.prepare('SELECT * FROM research_walk_forward WHERE run_id=? ORDER BY fold').all(Number(runId)); }
  getCalibration(runId) { return this._db.prepare('SELECT * FROM research_calibration WHERE run_id=? ORDER BY bin').all(Number(runId)); }
  getCoefficients(runId) { return this._db.prepare('SELECT * FROM research_coefficients WHERE run_id=?').all(Number(runId)); }

  // Full chronological history for an experiment (§33/§46). Oldest→newest.
  history({ algorithmId, version, target, modelStage, browserScope = null }) {
    const rows = this._db.prepare(
      `SELECT * FROM research_runs WHERE algorithm_id=? AND version=? AND target=? AND model_stage=? AND (browser_scope IS ? OR browser_scope=?) ORDER BY evaluated_at_ms ASC, id ASC`
    ).all(algorithmId, version, target, modelStage, browserScope == null ? null : String(browserScope), browserScope == null ? '' : String(browserScope));
    return rows.map(mapRun);
  }

  // Latest run per experiment key (for overview/monitoring).
  latestRuns() {
    const rows = this._db.prepare(
      `SELECT r.* FROM research_runs r
       JOIN (SELECT experiment_id, MAX(evaluated_at_ms) AS m FROM research_runs GROUP BY experiment_id) x
         ON r.experiment_id=x.experiment_id AND r.evaluated_at_ms=x.m
       ORDER BY r.evaluated_at_ms DESC`
    ).all();
    return rows.map(mapRun);
  }

  latestForExperimentKey(experimentKey) {
    const exp = this._findExperiment.get(experimentKey);
    if (!exp) return null;
    const r = this._db.prepare('SELECT * FROM research_runs WHERE experiment_id=? ORDER BY evaluated_at_ms DESC, id DESC LIMIT 1').get(exp.id);
    return r ? mapRun(r) : null;
  }

  runsByIds(ids) { if (!ids.length) return []; const q = ids.map(() => '?').join(','); return this._db.prepare(`SELECT * FROM research_runs WHERE id IN (${q})`).all(...ids.map(Number)).map(mapRun); }

  // Persisted hyperparameter search ledger for a run (§31).
  getLedger(runId) { return this._db.prepare('SELECT * FROM research_search_ledger WHERE run_id=? ORDER BY id').all(Number(runId)); }

  // Latest run per experiment, grouped by FAMILY (§39). Distinct versions are kept
  // separate (never collapsed); each family row lists its cells without ranking by
  // a single best run.
  familyLatest() {
    const latest = this.latestRuns();
    const byFamily = new Map();
    for (const r of latest) {
      const fam = r.family || 'UNKNOWN';
      if (!byFamily.has(fam)) byFamily.set(fam, []);
      byFamily.get(fam).push(r);
    }
    return [...byFamily.entries()].map(([family, cells]) => ({ family, cells }));
  }

  // Fill in a batch's dataset-fingerprint set + cell count once the cohort is evaluated.
  setBatchSummary(batchId, { datasetFingerprints, cellCount }) {
    this._db.prepare('UPDATE research_batches SET dataset_fingerprints=?, cell_count=? WHERE id=?')
      .run(datasetFingerprints ? JSON.stringify(datasetFingerprints) : null, cellCount || 0, Number(batchId));
  }

  batches() { return this._db.prepare('SELECT * FROM research_batches ORDER BY created_at_ms DESC, id DESC').all(); }
  runsForBatch(batchId) { return this._db.prepare('SELECT * FROM research_runs WHERE batch_id=? ORDER BY id').all(Number(batchId)).map(mapRun); }

  counts() {
    return {
      algorithms: this._db.prepare('SELECT COUNT(*) AS n FROM research_algorithms').get().n,
      experiments: this._db.prepare('SELECT COUNT(*) AS n FROM research_experiments').get().n,
      runs: this._db.prepare('SELECT COUNT(*) AS n FROM research_runs').get().n,
    };
  }
}

function num(v) { return v == null || !Number.isFinite(Number(v)) ? null : Number(v); }
function mapRun(r) {
  return {
    runId: r.id, experimentId: r.experiment_id, algorithmId: r.algorithm_id, version: r.version,
    algorithmFingerprint: r.algorithm_fingerprint, datasetFingerprint: r.dataset_fingerprint, frozenFingerprint: r.frozen_fingerprint,
    target: r.target, modelStage: r.model_stage, browserScope: r.browser_scope,
    codeRevision: r.code_revision, leakageStatus: r.leakage_status, leakagePolicyVersion: r.leakage_policy_version,
    status: r.status, n: r.n, timeRangeStartMs: r.time_range_start_ms, timeRangeEndMs: r.time_range_end_ms,
    testN: r.test_n, testPositives: r.test_positives, prevalence: r.prevalence, auc: r.auc, prAuc: r.pr_auc, brier: r.brier, logLoss: r.log_loss,
    deltaBrierTest: r.delta_brier_test, calibrationMaxDiff: r.calibration_max_diff, stabilityStatus: r.stability_status,
    conclusionStatus: r.conclusion_status, conclusionMagnitude: r.conclusion_magnitude, quality: r.quality_status,
    family: r.family, kind: r.kind, complexityParams: r.complexity_params, deltaBrierVsLinear: r.delta_brier_vs_linear,
    incrementalValue: r.incremental_value, batchId: r.batch_id, evaluationGeneration: r.evaluation_generation,
    searchSpaceVersion: r.search_space_version, qualityPolicyVersion: r.quality_policy_version,
    evaluatedAtMs: r.evaluated_at_ms, resultJson: r.result_json,
  };
}

module.exports = { ResearchRepo };
