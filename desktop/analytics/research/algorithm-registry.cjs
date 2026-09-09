'use strict';

const { modelsForStage, GUARD } = require('../forward-research/experiment.cjs');
const reg = require('../forward-research/feature-registry.cjs');

// ---------------------------------------------------------------------------
// ALGORITHM REGISTRY (§6/§19/§20/§40). The single source of truth for which
// prediction/research algorithms exist. Algorithm identity lives HERE, never
// hardcoded in UI or queries — the UI discovers algorithms (and their FAMILY,
// complexity, capability, experimental/deprecated state) from this registry.
//
// Each algorithm maps to a forward-safe feature set (resolved per stage from the
// leakage-gated feature registry) + a model KIND + a family-specific sample guard +
// a small predeclared hyperparameter grid. The same family at a materially different
// config carries a different `version`, which flows into the algorithm fingerprint.
// Adding a new forward-safe algorithm = add one entry here; no screen edits (§19).
//
// V2 adds scientifically-distinct NON-LINEAR families (§10/§13):
//   SPLINE        — additive piecewise-linear (GAM-like) logistic: tests whether
//                   continuous features have nonlinear forward association linear
//                   logistic misses.
//   DECISION_TREE — constrained shallow CART: tests simple threshold / interaction
//                   structure on the SAME forward-safe features.
// Random forest / gradient boosting are DEFERRED (§15/§16): conditional on data the
// current real corpus does not yet justify; the architecture supports adding them
// later without rewriting evaluation history.
// ---------------------------------------------------------------------------

const PREPROCESSING = 'TRAIN_ONLY_STANDARDIZE_IMPUTE'; // scaler/imputer fit on train slice only (per fold in walk-forward)
const SPLIT_POLICY = 'CHRONO_60_20_20+EXPANDING_WALK_FORWARD';
const L2_GRID = [0.5, 1.0, 4.0];
const CODE_VERSION = 'fr-engine-2'; // bump when the shared engine's numerical semantics change

// FAMILY-SPECIFIC SAMPLE GUARDS (§7). LINEAR/BASELINE keep the V1 guard EXACTLY so
// existing fingerprints never change (§58). Non-linear families carry LARGER guards
// derived from model degrees of freedom BEFORE any real data is inspected (§66):
//   SPLINE adds ~3× the parameters of linear logistic (hinge basis over continuous
//   features), so the V1 ~10-events-per-variable heuristic is scaled ~3× → MIN_POS 60,
//   MIN_TRAIN 600, MIN_TEST 150.  TREE (depth≤3, ≤8 leaves, minSamplesLeaf 30) needs
//   ≈ leaves×minLeaf in train; conservative MIN_TRAIN 500, MIN_POS 50, MIN_TEST 150.
const FAMILY_GUARDS = Object.freeze({
  BASELINE: { MIN_TRAIN: GUARD.MIN_TRAIN, MIN_POS_PER_SET: GUARD.MIN_POS_PER_SET, MIN_TEST: GUARD.MIN_TEST, MIN_CALIB_BIN: GUARD.MIN_CALIB_BIN },
  LOGISTIC_REGRESSION: { MIN_TRAIN: GUARD.MIN_TRAIN, MIN_POS_PER_SET: GUARD.MIN_POS_PER_SET, MIN_TEST: GUARD.MIN_TEST, MIN_CALIB_BIN: GUARD.MIN_CALIB_BIN },
  SPLINE: { MIN_TRAIN: 600, MIN_POS_PER_SET: 60, MIN_TEST: 150, MIN_CALIB_BIN: 20 },
  DECISION_TREE: { MIN_TRAIN: 500, MIN_POS_PER_SET: 50, MIN_TEST: 150, MIN_CALIB_BIN: 20 },
});

// Complexity CLASS (descriptive, for UI gain-vs-complexity framing, §21/§27).
const COMPLEXITY_CLASS = Object.freeze({ BASELINE: 'BASELINE', LOGISTIC_REGRESSION: 'LINEAR', SPLINE: 'NONLINEAR_ADDITIVE', DECISION_TREE: 'NONLINEAR_TREE' });

// featureSetKey resolves to a concrete, stage-eligible feature list via the engine's
// modelsForStage (M0 empty baseline / M1 single JP / M2 JP+prior context / M3 full).
const ALGORITHMS = Object.freeze([
  {
    algorithmId: 'prevalence_v1', name: 'Baseline tỉ lệ nền', family: 'BASELINE', kind: 'PREVALENCE', version: 1,
    description: 'Dự đoán xác suất bằng đúng tỉ lệ nền (prevalence) học trên tập train. Là mốc mọi thuật toán phải vượt qua ngoài mẫu.',
    explanation: 'Luôn đoán bằng tỉ lệ nền; là mốc so sánh cơ bản.',
    featureSetKey: 'M0', hyperparameters: { l2Grid: [] }, experimental: false, deprecated: false,
  },
  {
    algorithmId: 'jp_open_logistic_v1', name: 'Logistic Jackpot (1 biến)', family: 'LOGISTIC_REGRESSION', kind: 'LOGISTIC', version: 1,
    description: 'Hồi quy logistic dùng một biến Jackpot hợp lệ tại giai đoạn dự đoán (jp_open / jp_lock). Baseline logistic đơn biến.',
    explanation: 'Hiệu ứng tuyến tính của một biến trong log-odds.',
    featureSetKey: 'M1', hyperparameters: { l2Grid: L2_GRID }, experimental: false, deprecated: false,
  },
  {
    algorithmId: 'jp_context_logistic_v1', name: 'Logistic Jackpot + ngữ cảnh trước', family: 'LOGISTIC_REGRESSION', kind: 'LOGISTIC', version: 1,
    description: 'Logistic dùng Jackpot hiện tại + ngữ cảnh từ các vòng đã hoàn tất TRƯỚC đó (shift(1)/rolling theo từng trình duyệt).',
    explanation: 'Hiệu ứng tuyến tính của Jackpot + ngữ cảnh trước trong log-odds.',
    featureSetKey: 'M2', hyperparameters: { l2Grid: L2_GRID }, experimental: false, deprecated: false,
  },
  {
    algorithmId: 'full_forward_logistic_v1', name: 'Logistic forward đầy đủ', family: 'LOGISTIC_REGRESSION', kind: 'LOGISTIC', version: 1,
    description: 'Logistic dùng toàn bộ tập biến forward-safe hợp lệ tại giai đoạn (Jackpot sớm + ngữ cảnh trước + thời gian trong ngày).',
    explanation: 'Hiệu ứng tuyến tính của toàn bộ biến forward-safe trong log-odds.',
    featureSetKey: 'M3', hyperparameters: { l2Grid: L2_GRID }, experimental: false, deprecated: false,
  },
  // ---- V2 NON-LINEAR CANDIDATES (experimental until real-data evidence exists, §8/§20) ----
  {
    algorithmId: 'jp_context_spline_v1', name: 'Spline Jackpot + ngữ cảnh trước', family: 'SPLINE', kind: 'SPLINE', version: 1,
    description: 'Logistic spline cộng tính (GAM-like) trên Jackpot + ngữ cảnh trước. Kiểm tra hiệu ứng phi tuyến trơn mà logistic tuyến tính có thể bỏ lỡ.',
    explanation: 'Hiệu ứng trơn phi tuyến của biến liên tục (spline cộng tính) trong log-odds.',
    featureSetKey: 'M2', hyperparameters: { l2Grid: L2_GRID, knotsGrid: [3, 4, 5] }, experimental: true, deprecated: false,
  },
  {
    algorithmId: 'full_forward_spline_v1', name: 'Spline forward đầy đủ', family: 'SPLINE', kind: 'SPLINE', version: 1,
    description: 'Logistic spline cộng tính trên toàn bộ tập biến forward-safe. So trực tiếp với logistic tuyến tính cùng tập biến để đo giá trị tăng thêm của phi tuyến.',
    explanation: 'Hiệu ứng trơn phi tuyến của toàn bộ biến forward-safe trong log-odds.',
    featureSetKey: 'M3', hyperparameters: { l2Grid: L2_GRID, knotsGrid: [3, 4, 5] }, experimental: true, deprecated: false,
  },
  {
    algorithmId: 'jp_context_tree_v1', name: 'Cây quyết định nông (Jackpot + ngữ cảnh)', family: 'DECISION_TREE', kind: 'TREE', version: 1,
    description: 'Cây quyết định nông có ràng buộc (độ sâu ≤3, tối thiểu mẫu mỗi lá) trên Jackpot + ngữ cảnh trước. Phát hiện cấu trúc ngưỡng/tương tác đơn giản.',
    explanation: 'Chia theo ngưỡng của biến; phát hiện ngưỡng và tương tác đơn giản.',
    featureSetKey: 'M2', hyperparameters: { maxDepthGrid: [2, 3], minSamplesLeaf: 30, minSamplesSplit: 60 }, experimental: true, deprecated: false,
  },
]);

const STAGES = Object.freeze([reg.STAGE.ROUND_OPEN, reg.STAGE.ROUND_LOCK]);

const byId = new Map(ALGORITHMS.map((a) => [a.algorithmId, a]));

function familyGuard(family) { return FAMILY_GUARDS[family] || FAMILY_GUARDS.LOGISTIC_REGRESSION; }

// Resolve the concrete, stage-eligible feature list for an algorithm at a stage.
function featureNamesFor(algorithmId, modelStage) {
  const a = byId.get(algorithmId); if (!a) throw new Error('unknown algorithm: ' + algorithmId);
  const sets = modelsForStage(modelStage);
  const feats = sets[a.featureSetKey];
  if (!feats) throw new Error('unknown featureSetKey: ' + a.featureSetKey);
  return feats;
}

// A fully-resolved, fingerprint-ready config for (algorithm, stage, target). The
// family-specific guard is part of identity so a spline/tree at a different data
// requirement fingerprints distinctly; V1 linear/baseline keep the V1 guard exactly.
function resolveConfig(algorithmId, modelStage, targetId) {
  const a = byId.get(algorithmId); if (!a) throw new Error('unknown algorithm: ' + algorithmId);
  const g = familyGuard(a.family);
  return {
    algorithmId: a.algorithmId, version: a.version, family: a.family, name: a.name,
    modelStage, target: targetId,
    featureNames: featureNamesFor(algorithmId, modelStage),
    hyperparameters: a.hyperparameters,
    preprocessing: PREPROCESSING, splitPolicy: SPLIT_POLICY,
    guards: { MIN_TRAIN: g.MIN_TRAIN, MIN_POS_PER_SET: g.MIN_POS_PER_SET, MIN_TEST: g.MIN_TEST, MIN_CALIB_BIN: g.MIN_CALIB_BIN },
    codeVersion: CODE_VERSION,
  };
}

// Model spec consumed by the multi-family engine (kind + feature set + grid + guard).
function resolveModelSpec(algorithmId, modelStage, targetId) {
  const a = byId.get(algorithmId); if (!a) throw new Error('unknown algorithm: ' + algorithmId);
  return { kind: a.kind, featureNames: featureNamesFor(algorithmId, modelStage), hyperparameters: a.hyperparameters, guard: familyGuard(a.family), family: a.family, modelStage, target: targetId };
}

// Registry view for the UI (identity + metadata only; no results).
function registryView() {
  return ALGORITHMS.map((a) => ({
    algorithmId: a.algorithmId, name: a.name, family: a.family, kind: a.kind, version: a.version,
    description: a.description, explanation: a.explanation, featureSetId: a.featureSetKey,
    complexityClass: COMPLEXITY_CLASS[a.family] || 'UNKNOWN',
    experimental: !!a.experimental, deprecated: !!a.deprecated,
    capability: a.deprecated ? 'DEPRECATED' : (a.experimental ? 'EXPERIMENTAL' : 'IMPLEMENTED'),
    guards: familyGuard(a.family),
    supportedStages: STAGES, preprocessing: PREPROCESSING, trainingPolicy: SPLIT_POLICY,
    hyperparameters: a.hyperparameters, codeVersion: CODE_VERSION,
    featuresByStage: Object.fromEntries(STAGES.map((s) => [s, featureNamesFor(a.algorithmId, s)])),
  }));
}

module.exports = { ALGORITHMS, STAGES, byId, featureNamesFor, resolveConfig, resolveModelSpec, registryView, familyGuard, FAMILY_GUARDS, COMPLEXITY_CLASS, PREPROCESSING, SPLIT_POLICY, L2_GRID, CODE_VERSION };
