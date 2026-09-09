'use strict';

const L = require('../forward-research/logistic.cjs');

// ---------------------------------------------------------------------------
// ALGORITHM FAMILIES — the common model contract (§18). Every family implements
// the SAME interface so the shared evaluation engine (model-engine.cjs) can FIT /
// PREDICT / describe / report complexity without knowing the family:
//
//     fit(trainRows, featureNames, params) -> model
//     model.predict(rows) -> number[]      (probabilities in [0,1])
//     model.complexity()  -> { params, features, transforms, ... }
//     model.diagnostics() -> family-specific descriptive diagnostics
//     model.describe()    -> short plain-language explanation (§48)
//
// Families are PURE and DETERMINISTIC (no randomness): prevalence, linear
// logistic (reuses logistic.cjs), additive piecewise-linear SPLINE logistic
// (GAM-like, §10/§11), and a constrained shallow DECISION TREE (§13/§14).
// Model-specific code owns NONE of split / leakage / TEST-lock / persistence —
// those live in the engine and product layers.
// ---------------------------------------------------------------------------

// Minimum distinct non-null values before a feature is treated as continuous
// (and therefore eligible for spline expansion / tree thresholds).
const CONTINUOUS_MIN_DISTINCT = 10;

function featCols(rows, featureNames) {
  return rows.map((r) => featureNames.map((f) => {
    const v = r.features[f];
    return v == null || !Number.isFinite(v) ? null : v;
  }));
}
function targets(rows) { return rows.map((r) => r.target); }
function baseRate(y) { if (!y.length) return 0; let s = 0; for (const v of y) s += v; return s / y.length; }

// ---- PREVALENCE (baseline) -------------------------------------------------
function fitPrevalence(trainRows) {
  const p = baseRate(targets(trainRows));
  return {
    kind: 'PREVALENCE', prevalence: p, converged: true,
    predict: (rows) => rows.map(() => p),
    complexity: () => ({ params: 1, features: 0, transforms: 0 }),
    diagnostics: () => ({ prevalence: p }),
    describe: () => 'Dự đoán bằng đúng tỉ lệ nền học trên tập train.',
  };
}

// ---- LINEAR LOGISTIC -------------------------------------------------------
function fitLogistic(trainRows, featureNames, { l2 = 1.0 } = {}) {
  if (!featureNames.length) return fitPrevalence(trainRows);
  const X = featCols(trainRows, featureNames);
  const y = targets(trainRows);
  const scaler = L.fitScaler(X, featureNames.length);
  const m = L.fit(L.applyScaler(X, scaler), y, { l2 });
  return {
    kind: 'LOGISTIC', featureNames, scaler, coef: m.coef, intercept: m.intercept,
    converged: m.converged, status: m.status, l2,
    predict: (rows) => L.predict({ intercept: m.intercept, coef: m.coef }, L.applyScaler(featCols(rows, featureNames), scaler)),
    complexity: () => ({ params: featureNames.length + 1, features: featureNames.length, transforms: 0 }),
    diagnostics: () => ({ coef: m.coef, intercept: m.intercept, converged: m.converged, status: m.status, l2 }),
    describe: () => 'Hiệu ứng tuyến tính của biến trong log-odds.',
  };
}

// ---- SPLINE / GAM-like LOGISTIC (§10/§11) ----------------------------------
// Additive piecewise-linear (hinge) spline basis fitted on TRAIN ONLY. Each
// CONTINUOUS feature x with interior knots k1<..<km expands to a linear term plus
// hinge terms [x, (x-k1)+, ..., (x-km)+]. Non-continuous features stay linear.
// Knots are placed at quantiles of the TRAIN distribution (no TEST peeking).
function interiorKnots(vals, count) {
  const v = vals.filter((x) => x != null && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length < count + 2) return null;
  const out = [];
  for (let i = 1; i <= count; i++) {
    const q = i / (count + 1);
    const idx = Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))));
    out.push(v[idx]);
  }
  const uniq = [...new Set(out)];
  return uniq.length >= 1 ? uniq : null;
}

function fitSpline(trainRows, featureNames, { knots = 4, l2 = 1.0 } = {}) {
  if (!featureNames.length) return fitPrevalence(trainRows);
  const specs = [];
  for (const f of featureNames) {
    const vals = trainRows.map((r) => { const v = r.features[f]; return v == null || !Number.isFinite(v) ? null : v; });
    const distinct = new Set(vals.filter((v) => v != null)).size;
    if (distinct >= CONTINUOUS_MIN_DISTINCT) {
      const ks = interiorKnots(vals, knots);
      if (ks) { specs.push({ feature: f, type: 'spline', knots: ks }); continue; }
    }
    specs.push({ feature: f, type: 'linear' });
  }
  const expand = (rows) => rows.map((r) => {
    const out = [];
    for (const s of specs) {
      const raw = r.features[s.feature];
      const x = raw == null || !Number.isFinite(raw) ? null : raw;
      out.push(x);
      if (s.type === 'spline') for (const k of s.knots) out.push(x == null ? null : Math.max(0, x - k));
    }
    return out;
  });
  const Xtr = expand(trainRows);
  const dim = Xtr.length && Xtr[0] ? Xtr[0].length : 0;
  const y = targets(trainRows);
  const scaler = L.fitScaler(Xtr, dim);
  const m = L.fit(L.applyScaler(Xtr, scaler), y, { l2 });
  const splineFeatures = specs.filter((s) => s.type === 'spline').length;
  return {
    kind: 'SPLINE', specs, scaler, coef: m.coef, intercept: m.intercept,
    converged: m.converged, status: m.status, knots, l2, dim,
    predict: (rows) => L.predict({ intercept: m.intercept, coef: m.coef }, L.applyScaler(expand(rows), scaler)),
    complexity: () => ({ params: dim + 1, features: featureNames.length, transforms: splineFeatures, knots }),
    diagnostics: () => ({ specs: specs.map((s) => ({ feature: s.feature, type: s.type, knots: s.knots || null })), converged: m.converged, status: m.status, knots, l2 }),
    describe: () => 'Hiệu ứng trơn phi tuyến (spline cộng tính) của biến liên tục trong log-odds.',
  };
}

// ---- SHALLOW DECISION TREE (§13/§14) ---------------------------------------
// Deterministic CART (Gini). Hard overfit guards: maxDepth, minSamplesLeaf,
// minSamplesSplit. Leaf probability uses Laplace smoothing so it can never be a
// degenerate 0/1 (§29). Missing values route to the heavier child (recorded per
// node). Candidate thresholds are quantile-capped for 100k-scale usability (§69).
const TREE_MAX_THRESHOLDS = 32;

function candidateThresholds(sortedUnique) {
  const n = sortedUnique.length;
  const mids = [];
  if (n <= TREE_MAX_THRESHOLDS + 1) {
    for (let i = 1; i < n; i++) mids.push((sortedUnique[i - 1] + sortedUnique[i]) / 2);
    return mids;
  }
  for (let t = 1; t <= TREE_MAX_THRESHOLDS; t++) {
    const q = t / (TREE_MAX_THRESHOLDS + 1);
    const i = Math.min(n - 1, Math.max(1, Math.round(q * (n - 1))));
    mids.push((sortedUnique[i - 1] + sortedUnique[i]) / 2);
  }
  return [...new Set(mids)];
}
function giniOf(rows) { const n = rows.length; if (!n) return 0; let p = 0; for (const r of rows) p += r.y; p /= n; return 1 - p * p - (1 - p) * (1 - p); }

function fitTree(trainRows, featureNames, { maxDepth = 3, minSamplesLeaf = 30, minSamplesSplit = 60 } = {}) {
  const data = trainRows.map((r) => ({ x: featureNames.map((f) => { const v = r.features[f]; return v == null || !Number.isFinite(v) ? null : v; }), y: r.target }));
  let leafCount = 0, nodeCount = 0, depthReached = 0;
  const importance = new Array(featureNames.length).fill(0);

  function makeLeaf(rows, depth) {
    leafCount++; depthReached = Math.max(depthReached, depth);
    let pos = 0; for (const r of rows) pos += r.y;
    return { leaf: true, prob: (pos + 1) / (rows.length + 2), n: rows.length, pos };
  }
  function build(rows, depth) {
    nodeCount++;
    if (depth >= maxDepth || rows.length < minSamplesSplit) return makeLeaf(rows, depth);
    const base = giniOf(rows);
    let best = null;
    const nullRows = rows.filter((r) => r.x[best ? best.j : 0] == null); void nullRows;
    for (let j = 0; j < featureNames.length; j++) {
      const present = rows.filter((r) => r.x[j] != null);
      const missing = rows.filter((r) => r.x[j] == null);
      const vals = present.map((r) => r.x[j]);
      const sorted = [...new Set(vals)].sort((a, b) => a - b);
      if (sorted.length < 2) continue;
      for (const thr of candidateThresholds(sorted)) {
        const left = [], right = [];
        for (const r of present) (r.x[j] <= thr ? left : right).push(r);
        const nullsLeft = left.length >= right.length;
        const lRows = nullsLeft ? left.concat(missing) : left;
        const rRows = nullsLeft ? right : right.concat(missing);
        if (lRows.length < minSamplesLeaf || rRows.length < minSamplesLeaf) continue;
        const g = (lRows.length * giniOf(lRows) + rRows.length * giniOf(rRows)) / rows.length;
        const gain = base - g;
        if (!best || gain > best.gain + 1e-12) best = { j, thr, gain, nullsLeft };
      }
    }
    if (!best || best.gain <= 1e-9) return makeLeaf(rows, depth);
    importance[best.j] += best.gain * rows.length;
    const left = [], right = [];
    for (const r of rows) {
      const v = r.x[best.j];
      const goLeft = v == null ? best.nullsLeft : v <= best.thr;
      (goLeft ? left : right).push(r);
    }
    depthReached = Math.max(depthReached, depth + 1);
    return { leaf: false, feature: best.j, threshold: best.thr, nullsLeft: best.nullsLeft, gain: best.gain, left: build(left, depth + 1), right: build(right, depth + 1) };
  }
  const root = build(data, 0);
  const predictVec = (xrow) => { let node = root; while (!node.leaf) { const v = xrow[node.feature]; const goLeft = v == null ? node.nullsLeft : v <= node.threshold; node = goLeft ? node.left : node.right; } return node.prob; };
  const totalImp = importance.reduce((a, b) => a + b, 0) || 1;
  return {
    kind: 'TREE', root, maxDepth, minSamplesLeaf, minSamplesSplit, depthReached, leaves: leafCount, nodes: nodeCount, converged: true,
    predict: (rows) => rows.map((r) => predictVec(featureNames.map((f) => { const v = r.features[f]; return v == null || !Number.isFinite(v) ? null : v; }))),
    complexity: () => ({ params: leafCount, features: featureNames.length, transforms: 0, maxDepth, depthReached, leaves: leafCount }),
    diagnostics: () => ({ depthReached, leaves: leafCount, nodes: nodeCount, importance: featureNames.map((f, j) => ({ feature: f, modelImportance: importance[j] / totalImp })) }),
    describe: () => 'Cây quyết định nông: dự đoán theo các ngưỡng chia của biến (phát hiện cấu trúc ngưỡng/tương tác đơn giản).',
  };
}

// ---- FACTORY (kind dispatch) ----------------------------------------------
function makeModel(kind, trainRows, featureNames, params = {}) {
  switch (kind) {
    case 'PREVALENCE': return fitPrevalence(trainRows);
    case 'LOGISTIC': return fitLogistic(trainRows, featureNames, params);
    case 'SPLINE': return fitSpline(trainRows, featureNames, params);
    case 'TREE': return fitTree(trainRows, featureNames, params);
    default: throw new Error('unknown model kind: ' + kind);
  }
}

// Expand a family param grid descriptor into an ordered list of concrete configs.
// Small + predeclared only (§32). Deterministic order → deterministic selection.
function expandGrid(kind, hyperparameters = {}) {
  const l2Grid = hyperparameters.l2Grid && hyperparameters.l2Grid.length ? hyperparameters.l2Grid : [1.0];
  if (kind === 'PREVALENCE') return [{}];
  if (kind === 'LOGISTIC') return l2Grid.map((l2) => ({ l2 }));
  if (kind === 'SPLINE') {
    const knotsGrid = hyperparameters.knotsGrid && hyperparameters.knotsGrid.length ? hyperparameters.knotsGrid : [3, 4, 5];
    const out = [];
    for (const knots of knotsGrid) for (const l2 of l2Grid) out.push({ knots, l2 });
    return out;
  }
  if (kind === 'TREE') {
    const depthGrid = hyperparameters.maxDepthGrid && hyperparameters.maxDepthGrid.length ? hyperparameters.maxDepthGrid : [2, 3];
    const minLeaf = hyperparameters.minSamplesLeaf != null ? hyperparameters.minSamplesLeaf : 30;
    const minSplit = hyperparameters.minSamplesSplit != null ? hyperparameters.minSamplesSplit : 60;
    return depthGrid.map((maxDepth) => ({ maxDepth, minSamplesLeaf: minLeaf, minSamplesSplit: minSplit }));
  }
  throw new Error('unknown model kind: ' + kind);
}

module.exports = { makeModel, expandGrid, fitPrevalence, fitLogistic, fitSpline, fitTree, CONTINUOUS_MIN_DISTINCT };
