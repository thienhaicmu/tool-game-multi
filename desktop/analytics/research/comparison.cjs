'use strict';

// ---------------------------------------------------------------------------
// Algorithm comparison engine (§38/§39/§41/§67). Fair side-by-side ONLY when
// results are comparable: same target, same model stage, same evaluation policy
// version, and the SAME data population (dataset fingerprint). Otherwise we refuse
// to rank and return NOT_DIRECTLY_COMPARABLE rather than mislead. No single-metric
// "winner" badge — the product surfaces plain deltas + multi-criteria quality.
// ---------------------------------------------------------------------------

// runs: normalized run records (from the repo) to compare. Returns groups that ARE
// directly comparable plus an explicit incompatibility verdict for the rest.
function compare(runs) {
  const valid = runs.filter((r) => r && r.leakageStatus === 'PASS' && r.status === 'OK');
  if (valid.length < 2) return { comparable: false, verdict: valid.length < 2 ? 'NEED_TWO_VALID_RUNS' : 'OK', rows: valid.map(row) };

  const key = (r) => `${r.target}|${r.modelStage}|${r.datasetFingerprint}|${r.leakagePolicyVersion}`;
  const first = key(valid[0]);
  const sameCell = valid.every((r) => key(r) === first);
  if (!sameCell) {
    const reasons = [];
    if (new Set(valid.map((r) => r.target)).size > 1) reasons.push('DIFFERENT_TARGET');
    if (new Set(valid.map((r) => r.modelStage)).size > 1) reasons.push('DIFFERENT_STAGE');
    if (new Set(valid.map((r) => r.datasetFingerprint)).size > 1) reasons.push('DIFFERENT_DATASET');
    if (new Set(valid.map((r) => r.leakagePolicyVersion)).size > 1) reasons.push('DIFFERENT_POLICY');
    return { comparable: false, verdict: 'NOT_DIRECTLY_COMPARABLE', reasons, rows: valid.map(row) };
  }
  // Directly comparable: plain deltas, sorted by Brier ascending as a VIEW ordering
  // only (not a quality ranking — quality is multi-criteria per run).
  const rows = valid.map(row).sort((a, b) => (a.brier == null ? 1 : b.brier == null ? -1 : a.brier - b.brier));
  return { comparable: true, verdict: 'OK', target: valid[0].target, modelStage: valid[0].modelStage, datasetFingerprint: valid[0].datasetFingerprint, rows, summary: plainSummary(rows) };
}

// Plain-language, non-ranking summary for the comparison header (§50 UX). Never a
// "winner" — only describes whether results are essentially equivalent, or whether a
// more complex family shows a (possibly unstable) incremental edge over the simplest.
function plainSummary(rows) {
  const withBrier = rows.filter((r) => r.brier != null);
  if (withBrier.length < 2) return 'Chưa đủ kết quả hợp lệ để so sánh.';
  const best = withBrier[0], worst = withBrier[withBrier.length - 1];
  const spread = (worst.brier - best.brier);
  if (spread <= 5e-4) return 'Các thuật toán đang cho kết quả tương đương (sai số xác suất gần như bằng nhau).';
  // Is the best an advanced family with stable incremental value over linear?
  const adv = withBrier.find((r) => (r.family === 'SPLINE' || r.family === 'DECISION_TREE') && r.runId === best.runId);
  if (adv) {
    if (adv.incrementalValue === 'STABLE_INCREMENTAL_VALUE') return 'Mô hình phức tạp hơn đang tốt hơn một chút và ổn định so với mô hình tuyến tính đơn giản.';
    if (adv.incrementalValue === 'UNSTABLE') return 'Mô hình phức tạp hơn có vẻ tốt hơn nhưng chưa ổn định — chưa đủ để kết luận.';
    return 'Mô hình phức tạp hơn chỉ nhỉnh hơn không đáng kể so với mô hình tuyến tính.';
  }
  return 'Có chênh lệch nhỏ giữa các thuật toán; xem bảng chi tiết bên dưới.';
}

function row(r) {
  return {
    runId: r.runId, algorithmId: r.algorithmId, algorithmName: r.algorithmName, family: r.family, version: r.version,
    target: r.target, modelStage: r.modelStage,
    kind: r.kind, complexityParams: r.complexityParams,
    testN: r.testN, testPositives: r.testPositives, auc: r.auc, prAuc: r.prAuc, brier: r.brier, deltaBrierTest: r.deltaBrierTest, logLoss: r.logLoss,
    deltaBrierVsLinear: r.deltaBrierVsLinear, incrementalValue: r.incrementalValue,
    calibrationMaxDiff: r.calibrationMaxDiff, stabilityStatus: r.stabilityStatus, leakageStatus: r.leakageStatus, quality: r.quality,
    evaluatedAtMs: r.evaluatedAtMs,
  };
}

module.exports = { compare };
