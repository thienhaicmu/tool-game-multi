# Algorithm Research & Evaluation Platform (V1)

> **V2 (multi-family) extends this document** — see
> [ALGORITHM_RESEARCH_PLATFORM_V2.md](./ALGORITHM_RESEARCH_PLATFORM_V2.md) for the SPLINE +
> DECISION_TREE families, family-specific guards, incremental-value evaluation, evaluation
> batches/generations, schema v4, and the simple-first UI. V1 semantics below are unchanged.

**Product:** Aviator Analytics (passive, observe-only). **Scope:** a durable, productized
research workspace for *defining → registering → evaluating → comparing → versioning →
monitoring → historically tracking* multiple forward research/evaluation algorithms over
captured Aviator round history. **Out of scope / hard non-goal:** Control, AutoRunner,
BET/CASHOUT, bet sizing, wagering advice, "bet now / skip / hot / cold / due", protocol
sending, recovery. Results are **descriptive, comparative, probabilistic, research-oriented
only** — never a recommendation to act.

This document is source-first. The scientific core is the pre-existing, leakage-safe
[forward-research](../desktop/analytics/forward-research/) engine; this platform adds the
product layer (identity, fingerprints, persistence, history, comparison, drift, UI) on top
of it in [desktop/analytics/research/](../desktop/analytics/research/).

> **Naming note.** The UI area is labelled **"Nghiên cứu & Đánh giá thuật toán"**, not
> "Nghiên cứu dự đoán". The renderer is guarded by tests that ban prediction/recommendation
> wording (`dự đoán`, `tín hiệu`, `signal`, `prediction`, …), so the conservative research
> label is used while preserving the WU's semantics.

---

## 1. Architecture

```
Algorithm Registry ─┐
Target Registry ─────┤→ Research Engine ──→ Research Service ──→ Research Repo (SQLite v3)
Feature Registry ────┘   (per-algorithm,      (orchestrate,        (immutable runs +
(forward-research)        fingerprinted,        read rounds RO,      structured metrics/
                          shared engine)        persist, history,    folds/calibration/
                                                compare, drift)      coefficients)
                                                      │
                                                      └──→ IPC (analytics-research-*) ──→ Renderer (6 sub-views)
```

| Component | File | Responsibility |
|---|---|---|
| Algorithm registry | [algorithm-registry.cjs](../desktop/analytics/research/algorithm-registry.cjs) | Canonical algorithm identities; resolves stage-eligible feature sets; UI discovery source |
| Fingerprints | [fingerprint.cjs](../desktop/analytics/research/fingerprint.cjs) | Deterministic SHA-256 algorithm + dataset fingerprints + row-identity digest |
| Target registry | [target-registry.cjs](../desktop/analytics/research/target-registry.cjs) | Canonical `reached_*` targets; rare thresholds disabled by default |
| Shared engine | [research-engine.cjs](../desktop/analytics/research/research-engine.cjs) | Per-algorithm evaluation + fingerprints + leakage status + readiness |
| Quality | [quality.cjs](../desktop/analytics/research/quality.cjs) | Conservative multi-criteria quality status |
| Comparison | [comparison.cjs](../desktop/analytics/research/comparison.cjs) | Comparability policy + side-by-side |
| Drift | [drift.cjs](../desktop/analytics/research/drift.cjs) | Performance + base-rate drift classification |
| Service | [research-service.cjs](../desktop/analytics/research/research-service.cjs) | Read-only round loading, orchestration, overview/monitoring |
| Persistence | [research-repo.cjs](../desktop/analytics/db/repositories/research-repo.cjs) | Immutable runs + structured query tables (schema v3) |
| Core engine | [experiment.cjs](../desktop/analytics/forward-research/experiment.cjs) | `evaluateFeatureSet` — the one shared fit/validate/freeze/test/walk-forward path |

## 2. Algorithm registry & fingerprint

Every algorithm has a stable identity (`algorithmId`, `name`, `family`, `version`, feature
set, hyperparameters, preprocessing, split policy). Identity lives in the registry, **never**
hardcoded in UI/queries — the UI discovers algorithms from the registry.

V1 registers (reusing the engine's forward-safe feature sets M0–M3):

| algorithmId | family | feature set | notes |
|---|---|---|---|
| `prevalence_v1` | BASELINE | M0 (none) | prevalence baseline — the bar every model must clear |
| `jp_open_logistic_v1` | LOGISTIC_REGRESSION | M1 (single JP) | single eligible Jackpot feature |
| `jp_context_logistic_v1` | LOGISTIC_REGRESSION | M2 (JP + prior) | + strictly-prior per-browser context |
| `full_forward_logistic_v1` | LOGISTIC_REGRESSION | M3 (full) | full forward-safe set (adds `jp_lock` at ROUND_LOCK) |

**Algorithm fingerprint** = SHA-256 over `{policyVersion, algorithmId, version, family,
modelStage, target, sorted featureNames, hyperparameters, preprocessing, splitPolicy,
guards}`. Materially changing features/transform/regularization/training → a different
fingerprint. Two results are the same config only if fingerprints match (display name is
never trusted). Non-linear families (GAM/tree/GBM) can be registered later without rewriting
history — but V1 registers **only** what the engine actually supports.

## 3. Experiment, dataset fingerprint & lifecycle

- **Experiment** = algorithm fingerprint + research scope (browser scope). It answers one
  research question. Its `experimentKey` groups runs.
- **Run** = one evaluation of an experiment on a specific data snapshot. Lifecycle inside the
  shared engine: `DEFINE → FIT(train) → VALIDATE(val, select L2 only) → FREEZE → TEST(once)`.
- **Dataset fingerprint** = SHA-256 over `{schemaVersion, stage, target, scope, rowCount,
  browsers, earliest, latest, rowIdentityDigest}`. Re-evaluating on more data yields a new
  dataset fingerprint → a **new run**, never a silent overwrite. This distinguishes
  "same model / different data" from "different model / same data".

## 4. Feature-time contract & leakage policy

The hard leakage gate is the engine's [feature-registry](../desktop/analytics/forward-research/feature-registry.cjs):
every feature declares the lifecycle stage at which its value is genuinely known. A model at
a stage may consume only features whose stage ≤ the model stage; prior-round context uses
`shift(1)`/rolling over **strictly earlier** completed rounds, isolated per `browser_id`.
Current-round post-outcome fields (`max_odd`, `jackpot_at_end`, `reached_*`, …) are forbidden
predictors. Every run stores `leakageStatus` (PASS/FAIL), machine-checked `leakageChecks`, and
`leakagePolicyVersion`. **`leakageStatus != PASS ⇒ INVALID`**, excluded from valid comparison.

## 5. Evaluation: split, walk-forward, preprocessing, TEST lock

- Chronological split **60/20/20** (train/validation/test) — no shuffling; TEST strictly later.
- TEST is never used for feature/transform/hyperparameter/model selection; L2 is selected on
  VALIDATION Brier only, then the frozen model is evaluated on TEST exactly once.
- Preprocessing (standardize + train-mean impute) is fit on **train only** — refit per fold in
  walk-forward (expanding window).
- Sample guards (reused from the engine, unchanged): `MIN_TRAIN=200`, `MIN_POS_PER_SET=20`,
  `MIN_TEST=50`, `MIN_CALIB_BIN=20`. Failing a guard → explicit `INSUFFICIENT_DATA` /
  `INSUFFICIENT_POSITIVES`, never a fabricated zero.

## 6. Metrics, calibration, stability, coefficients

- Metrics: n, positives, prevalence, ROC AUC, PR AUC, Brier, log loss, Δ Brier vs baseline,
  moving-block bootstrap AUC CI. Accuracy is **not** used as a headline metric.
- Calibration bins (mean predicted vs observed rate, n, diff) stored per run.
- Temporal stability from per-fold walk-forward Δ Brier: `STABLE / MIXED / UNSTABLE /
  INSUFFICIENT_DATA`; aggregate metrics never hide unstable folds.
- Coefficient sign stability across folds; a feature that flips sign is flagged.

## 7. Persistence, immutability & versioning (schema v3)

Tables (migration v3, [migrations.cjs](../desktop/analytics/db/migrations.cjs)):
`research_algorithms`, `research_experiments`, `research_runs` (+ full immutable `result_json`),
`research_metrics`, `research_walk_forward`, `research_calibration`, `research_coefficients`.
Capture/round history is **never** modified — research writes target `research_*` only
(enforced by [research-boundary.test](../tests/js/research-boundary.test.mjs)).

A run is immutable once written. Re-running an identical config on an identical population
(same frozen fingerprint = algoFp|dsFp) dedupes to the existing run; a different population
inserts a new run. Old stored results never change when algorithm code/config changes later —
the historical row and its `result_json` remain as research evidence. Different algorithm
versions carry different fingerprints and keep separate history.

## 8. Comparison, drift, quality

- **Comparability** (§38/§67): side-by-side only when target, stage, dataset fingerprint, and
  leakage policy version all match; otherwise `NOT_DIRECTLY_COMPARABLE`. View ordering by Brier
  is presentation only — there is **no single-metric leaderboard / winner badge**.
- **Drift** (§35/§36): latest vs previous run → `NO_MATERIAL_CHANGE / POSSIBLE_DRIFT /
  MATERIAL_DEGRADATION / IMPROVEMENT / INSUFFICIENT_DATA` with conservative thresholds; target
  prevalence change is always reported alongside metric change. No previous run ⇒
  `PREVIOUS_EVALUATION = NONE` (history is never faked).
- **Quality** (§40/§76): `NOT_EVALUATED / INSUFFICIENT_DATA / INVALID / NO_IMPROVEMENT /
  SMALL_UNSTABLE_IMPROVEMENT / SMALL_STABLE_IMPROVEMENT / MATERIAL_STABLE_IMPROVEMENT`. Derived
  from leakage + sample + Δ Brier (a proper scoring rule) + stability + calibration — never from
  AUC alone. Conflicting evidence (e.g. high AUC but negative Δ Brier, or unstable folds)
  resolves to the **conservative** status.

## 9. UI — 6 sub-views (NGHIÊN CỨU tab)

Tổng quan (overview + data coverage + drift warnings), Thuật toán (registry list + detail +
on-demand evaluation), So sánh (comparable runs side-by-side), Lịch sử đánh giá (chronological
history + drift), Độ ổn định (walk-forward + coefficient stability), Chất lượng dữ liệu
(readiness matrix with deficits). Renderer: [analytics.js](../ui-analytics/analytics.js).

## 10. Action independence (§78/§79)

`PREDICTION_ACTION_IMPORTS = NONE`, `PREDICTION_BET_IMPORTS = NONE`,
`PREDICTION_CASHOUT_IMPORTS = NONE`. The research subsystem reads captured rounds read-only
and writes only `research_*`. Guarded statically by
[research-boundary.test.mjs](../tests/js/research-boundary.test.mjs) and the existing
[m2-passive-boundary.test.mjs](../tests/js/m2-passive-boundary.test.mjs).

## 11. Scientific interpretation policy (§75)

Allowed: "no measurable out-of-sample improvement over baseline", "small improvement but
temporally unstable", "improvement persisted across N folds", "calibration poor despite
moderate discrimination", "recent evaluation degraded vs previous", "insufficient data".
Forbidden: any "will win / use to bet / high jackpot means next round / guaranteed" wording.

## 12. Tests

[research-platform.test.mjs](../tests/js/research-platform.test.mjs) — registry, fingerprint,
persistence, immutability, versioning, dataset-version, comparability, drift, base-rate drift,
readiness/overview/monitoring, quality conservatism, and known/no/regime-signal sanity through
the full platform. [research-boundary.test.mjs](../tests/js/research-boundary.test.mjs) —
action-independence + read-only-over-rounds. The pre-existing
[forward-research.test.mjs](../tests/js/forward-research.test.mjs) still covers the engine's
leakage/shift(1)/multi-browser/chronology/preprocessing/test-independence guarantees.
