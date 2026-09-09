'use strict';

const { modelsForStage, GUARD } = require('../forward-research/experiment.cjs');
const reg = require('../forward-research/feature-registry.cjs');

// ---------------------------------------------------------------------------
// ALGORITHM REGISTRY (§6/§16/§52/§53). The single source of truth for which
// prediction/research algorithms exist. Algorithm identity lives HERE, never
// hardcoded in UI or queries — the UI discovers algorithms from this registry.
//
// Each algorithm maps to a forward-safe feature set (resolved per stage from the
// leakage-gated feature registry) and a shared hyperparameter policy. The same
// family at a materially different config carries a different `version`, which
// flows into the algorithm fingerprint (§7). Adding a new forward-safe algorithm
// = add one entry here + (if a new family) an engine feature set; no screen edits.
//
// The architecture allows future non-linear families (GAM/tree/GBM, §54) to be
// registered without rewriting evaluation history — but we register ONLY what the
// current engine actually supports. We do NOT manufacture models to look rich.
// ---------------------------------------------------------------------------

const PREPROCESSING = 'TRAIN_ONLY_STANDARDIZE_IMPUTE'; // scaler/imputer fit on train slice only (per fold in walk-forward)
const SPLIT_POLICY = 'CHRONO_60_20_20+EXPANDING_WALK_FORWARD';
const L2_GRID = [0.5, 1.0, 4.0];
const CODE_VERSION = 'fr-engine-2'; // bump when the shared engine's numerical semantics change

// featureSetKey resolves to a concrete, stage-eligible feature list via the engine's
// modelsForStage (M0 empty baseline / M1 single JP / M2 JP+prior context / M3 full).
const ALGORITHMS = Object.freeze([
  {
    algorithmId: 'prevalence_v1', name: 'Baseline tỉ lệ nền', family: 'BASELINE', version: 1,
    description: 'Dự đoán xác suất bằng đúng tỉ lệ nền (prevalence) học trên tập train. Là mốc mọi thuật toán phải vượt qua ngoài mẫu.',
    featureSetKey: 'M0', hyperparameters: { l2Grid: [] },
  },
  {
    algorithmId: 'jp_open_logistic_v1', name: 'Logistic Jackpot (1 biến)', family: 'LOGISTIC_REGRESSION', version: 1,
    description: 'Hồi quy logistic dùng một biến Jackpot hợp lệ tại giai đoạn dự đoán (jp_open / jp_lock). Baseline logistic đơn biến.',
    featureSetKey: 'M1', hyperparameters: { l2Grid: L2_GRID },
  },
  {
    algorithmId: 'jp_context_logistic_v1', name: 'Logistic Jackpot + ngữ cảnh trước', family: 'LOGISTIC_REGRESSION', version: 1,
    description: 'Logistic dùng Jackpot hiện tại + ngữ cảnh từ các vòng đã hoàn tất TRƯỚC đó (shift(1)/rolling theo từng trình duyệt).',
    featureSetKey: 'M2', hyperparameters: { l2Grid: L2_GRID },
  },
  {
    algorithmId: 'full_forward_logistic_v1', name: 'Logistic forward đầy đủ', family: 'LOGISTIC_REGRESSION', version: 1,
    description: 'Logistic dùng toàn bộ tập biến forward-safe hợp lệ tại giai đoạn (Jackpot sớm + ngữ cảnh trước + thời gian trong ngày).',
    featureSetKey: 'M3', hyperparameters: { l2Grid: L2_GRID },
  },
]);

const STAGES = Object.freeze([reg.STAGE.ROUND_OPEN, reg.STAGE.ROUND_LOCK]);

const byId = new Map(ALGORITHMS.map((a) => [a.algorithmId, a]));

// Resolve the concrete, stage-eligible feature list for an algorithm at a stage.
function featureNamesFor(algorithmId, modelStage) {
  const a = byId.get(algorithmId); if (!a) throw new Error('unknown algorithm: ' + algorithmId);
  const sets = modelsForStage(modelStage);
  const feats = sets[a.featureSetKey];
  if (!feats) throw new Error('unknown featureSetKey: ' + a.featureSetKey);
  return feats;
}

// A fully-resolved, fingerprint-ready config for (algorithm, stage, target).
function resolveConfig(algorithmId, modelStage, targetId) {
  const a = byId.get(algorithmId); if (!a) throw new Error('unknown algorithm: ' + algorithmId);
  return {
    algorithmId: a.algorithmId, version: a.version, family: a.family, name: a.name,
    modelStage, target: targetId,
    featureNames: featureNamesFor(algorithmId, modelStage),
    hyperparameters: a.hyperparameters,
    preprocessing: PREPROCESSING, splitPolicy: SPLIT_POLICY,
    guards: { MIN_TRAIN: GUARD.MIN_TRAIN, MIN_POS_PER_SET: GUARD.MIN_POS_PER_SET, MIN_TEST: GUARD.MIN_TEST, MIN_CALIB_BIN: GUARD.MIN_CALIB_BIN },
    codeVersion: CODE_VERSION,
  };
}

// Registry view for the UI (identity + metadata only; no results).
function registryView() {
  return ALGORITHMS.map((a) => ({
    algorithmId: a.algorithmId, name: a.name, family: a.family, version: a.version,
    description: a.description, featureSetId: a.featureSetKey,
    supportedStages: STAGES, preprocessing: PREPROCESSING, trainingPolicy: SPLIT_POLICY,
    hyperparameters: a.hyperparameters, codeVersion: CODE_VERSION,
    featuresByStage: Object.fromEntries(STAGES.map((s) => [s, featureNamesFor(a.algorithmId, s)])),
  }));
}

module.exports = { ALGORITHMS, STAGES, byId, featureNamesFor, resolveConfig, registryView, PREPROCESSING, SPLIT_POLICY, L2_GRID, CODE_VERSION };
