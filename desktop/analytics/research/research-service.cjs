'use strict';

const registry = require('./algorithm-registry.cjs');
const targets = require('./target-registry.cjs');
const engine = require('./research-engine.cjs');
const { qualityStatus, researchDecision } = require('./quality.cjs');
const comparison = require('./comparison.cjs');
const drift = require('./drift.cjs');
const { ResearchRepo } = require('../db/repositories/research-repo.cjs');
const fp = require('./fingerprint.cjs');

// ---------------------------------------------------------------------------
// ResearchService — MAIN-PROCESS owner of the Prediction Research product. Reads
// COMPLETE rounds READ-ONLY from the analytics store (never mutates capture/round
// history, §72/§78) and writes ONLY research_* tables via ResearchRepo. Orchestrates
// evaluate → persist, serves evaluation history / comparison / drift / readiness /
// overview to the renderer through structured results (no DB handle crosses IPC).
//
// Action-independent: imports NO bet/cashout/protocol/recovery modules (§78/§79).
// ---------------------------------------------------------------------------

const ROUND_COLS = 'browser_id, sid, sequence_number, opened_at_ms, ended_at_ms, max_odd, jackpot_at_open, jackpot_at_lock, jackpot_delta';

class ResearchService {
  constructor({ store, now = () => Date.now() } = {}) {
    if (!store) throw new Error('ResearchService requires a store');
    this._db = store.db; this._store = store; this._now = now;
    this.repo = new ResearchRepo(store.db, now);
    this._registerAlgorithms();
  }

  _registerAlgorithms() {
    for (const a of registry.registryView()) {
      try {
        this.repo.registerAlgorithm({
          algorithmId: a.algorithmId, version: a.version, name: a.name, family: a.family, featureSetId: a.featureSetId,
          description: a.description, codeVersion: a.codeVersion, kind: a.kind, capability: a.capability,
          experimental: a.experimental, deprecated: a.deprecated, complexityClass: a.complexityClass,
        });
      } catch { /* registry snapshot best-effort */ }
    }
  }

  _loadRounds(browserScope) {
    if (browserScope != null) return this._db.prepare(`SELECT ${ROUND_COLS} FROM rounds WHERE completeness='COMPLETE' AND browser_id=? ORDER BY browser_id, sequence_number`).all(String(browserScope));
    return this._db.prepare(`SELECT ${ROUND_COLS} FROM rounds WHERE completeness='COMPLETE' ORDER BY browser_id, sequence_number`).all();
  }

  _schemaVersion() { try { return this._store.schemaVersion(); } catch { return null; } }

  // ---- registry / discovery ----
  algorithms() { return registry.registryView(); }
  targetList() { return targets.enabledTargets(); }
  stages() { return registry.STAGES; }

  // Round coverage context (§43/§72) — always research wording, never a signal.
  dataCoverage() {
    const row = this._db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT browser_id) AS browsers, MIN(opened_at_ms) AS earliest, MAX(opened_at_ms) AS latest FROM rounds WHERE completeness='COMPLETE'").get();
    return { completeRounds: row.n || 0, browsers: row.browsers || 0, earliestMs: row.earliest != null ? row.earliest : null, latestMs: row.latest != null ? row.latest : null, schemaVersion: this._schemaVersion() };
  }

  // ---- readiness (§28/§49) ----
  readiness({ algorithmId, modelStage, target, browserScope = null }) {
    const rounds = this._loadRounds(browserScope);
    return engine.assessReadiness({ rounds, algorithmId, modelStage, targetId: target });
  }

  readinessMatrix({ browserScope = null } = {}) {
    const rounds = this._loadRounds(browserScope);
    const cells = [];
    for (const a of registry.ALGORITHMS) for (const s of registry.STAGES) for (const t of targets.enabledTargets()) {
      const r = engine.assessReadiness({ rounds, algorithmId: a.algorithmId, modelStage: s, targetId: t.targetId });
      cells.push({ algorithmId: a.algorithmId, modelStage: s, target: t.targetId, readiness: r });
    }
    return { browserScope, cells };
  }

  // ---- evaluate (+ persist) ----
  evaluate({ algorithmId, modelStage, target, browserScope = null, persist = true, batchId = null }) {
    const rounds = this._loadRounds(browserScope);
    const ev = engine.evaluateAlgorithm({ rounds, algorithmId, modelStage, targetId: target, schemaVersion: this._schemaVersion(), browserScope });
    ev.quality = qualityStatus(ev);
    ev.researchDecision = researchDecision(ev);
    ev.evaluatedAtMs = this._now();
    let saved = null;
    if (persist) saved = this.repo.saveRun(ev, batchId);
    return { run: saved, evaluation: ev };
  }

  // Evaluate every registered (algorithm × stage × target) that is eligible; persist
  // each as part of ONE batch (§37). Returns a result matrix (§67) with honest
  // INSUFFICIENT_*/MODEL_FAILED statuses and the incremental-value research decision.
  evaluateAll({ browserScope = null, persist = true } = {}) {
    const rounds = this._loadRounds(browserScope);
    const evaluatedAtMs = this._now();
    const schemaVersion = this._schemaVersion();
    const batchKey = 'batch_' + fp.sha({ scope: browserScope == null ? 'ALL' : String(browserScope), at: evaluatedAtMs }).slice(0, 20);
    const datasetFps = new Set();
    let batchId = null;
    if (persist) {
      batchId = this.repo.createBatch({
        batchKey, browserScope, schemaVersion, codeRevision: registry.CODE_VERSION,
        qualityPolicyVersion: engine.QUALITY_POLICY_VERSION, comparabilityPolicyVersion: engine.COMPARABILITY_POLICY_VERSION,
        fingerprintPolicyVersion: engine.FINGERPRINT_POLICY_VERSION, cellCount: 0,
      });
    }
    const cells = [];
    for (const a of registry.ALGORITHMS) for (const s of registry.STAGES) for (const t of targets.enabledTargets()) {
      const ev = engine.evaluateAlgorithm({ rounds, algorithmId: a.algorithmId, modelStage: s, targetId: t.targetId, schemaVersion, browserScope });
      ev.quality = qualityStatus(ev); ev.researchDecision = researchDecision(ev); ev.evaluatedAtMs = evaluatedAtMs;
      if (ev.datasetFingerprint) datasetFps.add(ev.datasetFingerprint);
      let saved = null;
      if (persist) saved = this.repo.saveRun(ev, batchId);
      cells.push({ algorithmId: a.algorithmId, algorithmName: ev.algorithmName, family: ev.family, kind: ev.kind, complexityClass: ev.complexityClass, version: ev.version, modelStage: s, target: t.targetId, status: ev.status, leakageStatus: ev.leakageStatus, incrementalValue: ev.incrementalValue, researchDecision: ev.researchDecision, runId: saved ? saved.runId : null, deduped: saved ? saved.deduped : null, evaluationGeneration: saved ? saved.evaluationGeneration : null, summary: summarize(ev) });
    }
    if (persist && batchId != null) this.repo.setBatchSummary(batchId, { datasetFingerprints: [...datasetFps], cellCount: cells.length });
    return { browserScope, evaluatedAtMs, batchId, batchKey, cells };
  }

  // ---- history / runs ----
  history({ algorithmId, version, target, modelStage, browserScope = null }) {
    const a = registry.byId.get(algorithmId);
    return this.repo.history({ algorithmId, version: version != null ? version : (a ? a.version : 1), target, modelStage, browserScope });
  }
  getRun(runId) { return this.repo.getRunFull(runId); }
  latestRuns() { return this.repo.latestRuns(); }

  // ---- comparison (§38/§39) ----
  compare({ runIds = [] } = {}) {
    const runs = this.repo.runsByIds(runIds).map((r) => ({ ...r, ...JSON.parse(r.resultJson || '{}') }));
    // Keep normalized fields authoritative over the embedded JSON for headline metrics.
    const norm = this.repo.runsByIds(runIds);
    const byId = new Map(norm.map((r) => [r.runId, r]));
    for (const r of runs) Object.assign(r, byId.get(r.runId));
    return comparison.compare(runs);
  }

  // ---- drift / monitoring (§35/§51/§74) ----
  drift({ algorithmId, version, target, modelStage, browserScope = null }) {
    const hist = this.history({ algorithmId, version, target, modelStage, browserScope });
    const latest = hist.length ? hist[hist.length - 1] : null;
    const previous = hist.length > 1 ? hist[hist.length - 2] : null;
    return { ...drift.assess(latest, previous), history: hist.map(histRow) };
  }

  // Monitoring snapshot across every experiment that has a persisted latest run (§74).
  monitoring() {
    const latest = this.repo.latestRuns();
    const out = [];
    for (const r of latest) {
      const hist = this.repo.history({ algorithmId: r.algorithmId, version: r.version, target: r.target, modelStage: r.modelStage, browserScope: r.browserScope });
      const previous = hist.length > 1 ? hist[hist.length - 2] : null;
      out.push({ algorithmId: r.algorithmId, target: r.target, modelStage: r.modelStage, latest: histRow(r), previousEvaluation: previous ? 'PRESENT' : 'NONE', drift: drift.assess(r, previous).status });
    }
    return out;
  }

  // ---- family-level monitoring (§39) ----
  // Summarize each family across its latest runs WITHOUT collapsing distinct versions
  // and WITHOUT ranking a family by its single best run. Counts ready / stable-
  // incremental / unstable / no-incremental cells per family (§68).
  familyMonitoring() {
    const groups = this.repo.familyLatest();
    return groups.map(({ family, cells }) => {
      const okCells = cells.filter((c) => c.status === 'OK');
      const count = (pred) => cells.filter(pred).length;
      return {
        family,
        algorithms: [...new Set(cells.map((c) => `${c.algorithmId} v${c.version}`))],
        realReadyCells: okCells.length,
        stableImprovementCells: count((c) => c.quality === 'MATERIAL_STABLE_IMPROVEMENT' || c.quality === 'SMALL_STABLE_IMPROVEMENT'),
        stableIncrementalCells: count((c) => c.incrementalValue === 'STABLE_INCREMENTAL_VALUE'),
        unstableCells: count((c) => c.incrementalValue === 'UNSTABLE' || c.stabilityStatus === 'UNSTABLE' || c.stabilityStatus === 'MIXED'),
        noIncrementalValueCells: count((c) => c.incrementalValue === 'NO_INCREMENTAL_VALUE'),
        insufficientCells: count((c) => c.status !== 'OK'),
        cells: cells.map(histRow),
      };
    });
  }

  // ---- evaluation batches (§37/§54) ----
  batches() { return this.repo.batches().map(batchRow); }
  batchRuns(batchId) { return this.repo.runsForBatch(batchId).map(histRow); }
  ledger(runId) { return this.repo.getLedger(runId); }

  // ---- overview (§43) ----
  overview() {
    const coverage = this.dataCoverage();
    const algos = registry.registryView();
    const latest = this.repo.latestRuns();
    const ready = this.readinessMatrix();
    const readyCount = ready.cells.filter((c) => c.readiness.status === 'READY').length;
    const byQuality = (q) => latest.filter((r) => r.quality === q).length;
    const driftWarnings = this.monitoring().filter((m) => m.drift === 'MATERIAL_DEGRADATION' || m.drift === 'POSSIBLE_DRIFT');
    const lastEval = latest.reduce((m, r) => Math.max(m, r.evaluatedAtMs || 0), 0) || null;
    const families = [...new Set(algos.map((a) => a.family))];
    const stableIncremental = latest.filter((r) => r.incrementalValue === 'STABLE_INCREMENTAL_VALUE').length;
    return {
      coverage,
      registeredAlgorithms: algos.length,
      registeredFamilies: families,
      experimentalAlgorithms: algos.filter((a) => a.experimental && !a.deprecated).length,
      evaluatedExperiments: latest.length,
      dataReadyCells: readyCount, readyCellsTotal: ready.cells.length,
      latestEvaluationMs: lastEval,
      stableImprovement: byQuality('MATERIAL_STABLE_IMPROVEMENT') + byQuality('SMALL_STABLE_IMPROVEMENT'),
      stableIncrementalValue: stableIncremental,
      noImprovement: byQuality('NO_IMPROVEMENT'),
      insufficientData: latest.filter((r) => r.status !== 'OK').length,
      driftWarnings: driftWarnings.map((d) => ({ algorithmId: d.algorithmId, target: d.target, modelStage: d.modelStage, status: d.drift })),
      policyVersions: { quality: engine.QUALITY_POLICY_VERSION, comparability: engine.COMPARABILITY_POLICY_VERSION, fingerprint: engine.FINGERPRINT_POLICY_VERSION, leakage: engine.LEAKAGE_POLICY_VERSION },
      persistence: this.repo.counts(),
    };
  }
}

function batchRow(b) {
  return { batchId: b.id, batchKey: b.batch_key, createdAtMs: b.created_at_ms, browserScope: b.browser_scope, schemaVersion: b.schema_version, codeRevision: b.code_revision, cellCount: b.cell_count, datasetFingerprints: b.dataset_fingerprints ? JSON.parse(b.dataset_fingerprints) : [], policyVersions: { quality: b.quality_policy_version, comparability: b.comparability_policy_version, fingerprint: b.fingerprint_policy_version } };
}

function summarize(ev) {
  if (ev.status !== 'OK') return { status: ev.status, leakageStatus: ev.leakageStatus, quality: ev.quality ? ev.quality.status : null };
  const tm = ev.testMetrics || {};
  return {
    status: ev.status, leakageStatus: ev.leakageStatus, quality: ev.quality ? ev.quality.status : null,
    testN: tm.n, testPositives: tm.positives, prevalence: tm.prevalence, auc: tm.auc, prAuc: tm.prAuc, brier: tm.brier, logLoss: tm.logLoss,
    deltaBrierTest: ev.deltaBrierTest, deltaBrierVsLinear: ev.deltaBrierVsLinear, incrementalValue: ev.incrementalValue,
    complexity: ev.complexity || null, stability: ev.stability ? ev.stability.status : null, conclusion: ev.conclusion ? ev.conclusion.status : null,
  };
}
function histRow(r) { return { runId: r.runId, algorithmId: r.algorithmId, version: r.version, family: r.family, kind: r.kind, modelStage: r.modelStage, target: r.target, evaluatedAtMs: r.evaluatedAtMs, evaluationGeneration: r.evaluationGeneration, datasetFingerprint: r.datasetFingerprint, algorithmFingerprint: r.algorithmFingerprint, status: r.status, testN: r.testN, prevalence: r.prevalence, auc: r.auc, prAuc: r.prAuc, brier: r.brier, deltaBrierTest: r.deltaBrierTest, deltaBrierVsLinear: r.deltaBrierVsLinear, incrementalValue: r.incrementalValue, complexityParams: r.complexityParams, stabilityStatus: r.stabilityStatus, quality: r.quality, leakageStatus: r.leakageStatus }; }

module.exports = { ResearchService };
