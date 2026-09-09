'use strict';

const registry = require('./algorithm-registry.cjs');
const targets = require('./target-registry.cjs');
const engine = require('./research-engine.cjs');
const { qualityStatus } = require('./quality.cjs');
const comparison = require('./comparison.cjs');
const drift = require('./drift.cjs');
const { ResearchRepo } = require('../db/repositories/research-repo.cjs');

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
      try { this.repo.registerAlgorithm({ algorithmId: a.algorithmId, version: a.version, name: a.name, family: a.family, featureSetId: a.featureSetId, description: a.description, codeVersion: a.codeVersion }); } catch { /* registry snapshot best-effort */ }
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
  evaluate({ algorithmId, modelStage, target, browserScope = null, persist = true }) {
    const rounds = this._loadRounds(browserScope);
    const ev = engine.evaluateAlgorithm({ rounds, algorithmId, modelStage, targetId: target, schemaVersion: this._schemaVersion(), browserScope });
    ev.quality = qualityStatus(ev);
    ev.evaluatedAtMs = this._now();
    let saved = null;
    if (persist) saved = this.repo.saveRun(ev);
    return { run: saved, evaluation: ev };
  }

  // Evaluate every registered (algorithm × stage × target) that is eligible; persist
  // each. Returns a result matrix (§73) with honest INSUFFICIENT_* statuses.
  evaluateAll({ browserScope = null, persist = true } = {}) {
    const rounds = this._loadRounds(browserScope);
    const evaluatedAtMs = this._now();
    const schemaVersion = this._schemaVersion();
    const cells = [];
    for (const a of registry.ALGORITHMS) for (const s of registry.STAGES) for (const t of targets.enabledTargets()) {
      const ev = engine.evaluateAlgorithm({ rounds, algorithmId: a.algorithmId, modelStage: s, targetId: t.targetId, schemaVersion, browserScope });
      ev.quality = qualityStatus(ev); ev.evaluatedAtMs = evaluatedAtMs;
      let saved = null;
      if (persist) saved = this.repo.saveRun(ev);
      cells.push({ algorithmId: a.algorithmId, algorithmName: ev.algorithmName, family: ev.family, version: ev.version, modelStage: s, target: t.targetId, status: ev.status, leakageStatus: ev.leakageStatus, runId: saved ? saved.runId : null, deduped: saved ? saved.deduped : null, summary: summarize(ev) });
    }
    return { browserScope, evaluatedAtMs, cells };
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
    return {
      coverage,
      registeredAlgorithms: algos.length,
      evaluatedExperiments: latest.length,
      dataReadyCells: readyCount, readyCellsTotal: ready.cells.length,
      latestEvaluationMs: lastEval,
      stableImprovement: byQuality('MATERIAL_STABLE_IMPROVEMENT') + byQuality('SMALL_STABLE_IMPROVEMENT'),
      noImprovement: byQuality('NO_IMPROVEMENT'),
      insufficientData: latest.filter((r) => r.status !== 'OK').length,
      driftWarnings: driftWarnings.map((d) => ({ algorithmId: d.algorithmId, target: d.target, modelStage: d.modelStage, status: d.drift })),
      persistence: this.repo.counts(),
    };
  }
}

function summarize(ev) {
  if (ev.status !== 'OK') return { status: ev.status, leakageStatus: ev.leakageStatus, quality: ev.quality ? ev.quality.status : null };
  const tm = ev.testMetrics || {};
  return {
    status: ev.status, leakageStatus: ev.leakageStatus, quality: ev.quality ? ev.quality.status : null,
    testN: tm.n, testPositives: tm.positives, prevalence: tm.prevalence, auc: tm.auc, prAuc: tm.prAuc, brier: tm.brier, logLoss: tm.logLoss,
    deltaBrierTest: ev.deltaBrierTest, stability: ev.stability ? ev.stability.status : null, conclusion: ev.conclusion ? ev.conclusion.status : null,
  };
}
function histRow(r) { return { runId: r.runId, evaluatedAtMs: r.evaluatedAtMs, datasetFingerprint: r.datasetFingerprint, algorithmFingerprint: r.algorithmFingerprint, status: r.status, testN: r.testN, prevalence: r.prevalence, auc: r.auc, prAuc: r.prAuc, brier: r.brier, deltaBrierTest: r.deltaBrierTest, stabilityStatus: r.stabilityStatus, quality: r.quality, leakageStatus: r.leakageStatus }; }

module.exports = { ResearchService };
