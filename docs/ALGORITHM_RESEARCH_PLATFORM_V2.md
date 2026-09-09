# Algorithm Research & Evaluation Platform — V2 (Multi-Family)

**Extends** [ALGORITHM_RESEARCH_PLATFORM.md](./ALGORITHM_RESEARCH_PLATFORM.md) (V1). V1 history and
semantics are unchanged; V2 is **purely additive**. Same hard non-goal: descriptive,
out-of-sample research only — never BET/CASHOUT/wagering advice/Control.

**V2 research question (§5):** *Do additional algorithm families capture stable forward-safe
structure that the baseline/linear-logistic models do not?* — not "which model has the highest
AUC once". A new family must justify itself through out-of-sample **incremental** value over the
simple linear model, calibration, temporal stability, walk-forward consistency, sufficient data,
and a leakage PASS.

---

## 1. What V2 adds

| Area | V1 | V2 |
|---|---|---|
| Families | BASELINE, LOGISTIC_REGRESSION | **+ SPLINE** (GAM-like additive), **+ DECISION_TREE** (shallow CART) |
| Model interface | logistic/prevalence hardcoded in engine | **common contract** (`fit/predict/complexity/diagnostics/describe`), [models.cjs](../desktop/analytics/research/models.cjs) |
| Evaluation | `evaluateFeatureSet` (logistic) | **+ `evaluateModel`** multi-family engine reusing the SAME split/leakage/metrics/walk-forward/stability/conclusion scaffolding, [model-engine.cjs](../desktop/analytics/research/model-engine.cjs) |
| Sample guards | one global guard | **family-specific guards** derived from model DoF (below) |
| Comparison | vs baseline | **+ Δ Brier vs linear** (incremental value), complexity column |
| Selection | max-Brier view order | **simplicity preference**: a tiny gain from a much larger model is `NO_INCREMENTAL_VALUE` |
| Search | L2 grid | **hyperparameter search ledger** (all attempted configs persisted, §31) + `SEARCH_SPACE_VERSION` |
| Cohorts | per-run | **evaluation batches** (§37) + **evaluation generations** (§35) |
| Monitoring | per-experiment drift | **+ family-level monitoring** (§39), no ranking by best single run |
| Persistence | schema v3 | **schema v4** (additive tables/columns; V1 runs load unchanged, §57) |
| UI | 6 sub-views | **simple-first** 4 tabs, plain Vietnamese, progressive disclosure |

**RF / GBM are DEFERRED** (§15/§16). They are conditional on data volume the current real corpus
does not justify (0 COMPLETE rounds at time of writing) and on a residual-nonlinearity finding
from the simpler families. The registry/engine can add them later without rewriting history.

## 2. New families (common contract, §18)

Every family in [models.cjs](../desktop/analytics/research/models.cjs) implements
`fit(trainRows, featureNames, params) → { predict, complexity, diagnostics, describe }`. Families
own **no** split/leakage/TEST-lock/persistence — those stay in the shared engine.

- **SPLINE** (`kind: 'SPLINE'`) — additive **piecewise-linear (hinge) spline** logistic. Each
  *continuous* feature (≥10 distinct train values) expands to `[x, (x−k₁)₊, …, (x−kₘ)₊]` with knots
  at TRAIN quantiles; other features stay linear. Then standardize (train-only) + ridge logistic.
  Knot grid `{3,4,5}`, L2 grid reused. Tests whether continuous features have nonlinear forward
  association linear logistic misses. Dependency-light, deterministic.
- **DECISION_TREE** (`kind: 'TREE'`) — deterministic shallow **CART** (Gini). Hard overfit guards:
  `maxDepth∈{2,3}`, `minSamplesLeaf=30`, `minSamplesSplit=60`. Leaf probability uses Laplace
  smoothing (never a degenerate 0/1). Missing values route to the heavier child. Candidate
  thresholds are quantile-capped (≤32/feature) for 100k-scale usability. No randomness → seed
  trivially reproducible.

## 3. Family-specific sample guards (§7), derived BEFORE real data (§66)

| Family | MIN_TRAIN | MIN_POS_PER_SET | MIN_TEST | Rationale |
|---|---|---|---|---|
| BASELINE / LOGISTIC | 200 | 20 | 50 | V1 guard, **unchanged** (keeps V1 fingerprints, §58) |
| SPLINE | 600 | 60 | 150 | ~3× the parameters of linear logistic → V1's ~10-events-per-variable heuristic scaled ~3× |
| DECISION_TREE | 500 | 50 | 150 | depth≤3 ⇒ ≤8 leaves × `minSamplesLeaf 30` ≈ 240 in train; conservative round-up |

Guards are part of the **algorithm fingerprint**, so a spline/tree fingerprints distinctly from
linear on the same feature set. Guards are **never lowered after seeing real data** (§66).

## 4. Incremental value & simplicity preference (§24–§27)

Inside `evaluateModel`, alongside the prevalence baseline, a **reference linear logistic** is fit
on the SAME feature set + split. The engine reports `deltaBrierVsLinear` (test) and per-fold
`deltaBrierVsLinear` (walk-forward), then:

- `NO_INCREMENTAL_VALUE` — ≤ linear, **or** a positive but <0.001 gain from a ≥3× larger model
  (complexity penalty in interpretation, §27).
- `POSSIBLE_INCREMENTAL_VALUE` — positive but < 3 folds to judge stability.
- `STABLE_INCREMENTAL_VALUE` — positive **and** per-fold sign-consistent.
- `UNSTABLE` — positive on TEST but flips sign across folds.
- `N_A` for baseline/linear (they are not advanced candidates). `INVALID` on leakage fail.

This is the research decision surfaced by the UI (§51); it is **research-only**, never a wager.

## 5. Persistence — schema v4 (additive, §56/§57)

New tables `research_batches`, `research_search_ledger`; new **nullable** columns on
`research_runs` (`family, kind, complexity_params, delta_brier_vs_linear, incremental_value,
batch_id, evaluation_generation, search_space_version, quality_policy_version`) and on
`research_algorithms` (`kind, capability, experimental, deprecated, complexity_class`). A
pre-existing V1 run loads unchanged with NULLs in the new columns (verified by test V16). Writes
still target `research_*` only. **Batch** = one dataset snapshot + policy versions across many
cells (§37); **evaluation generation** = monotonic per-experiment snapshot id so more data → a new
generation, never an overwrite (§35).

## 6. Policy versions (§58/§59/§60)

`fingerprintPolicyVersion = 1` (unchanged — V1 fingerprints stable), `comparabilityPolicyVersion =
1` (unchanged), `qualityPolicyVersion = 2` (adds the incremental-value decision atop V1 quality),
`leakagePolicyVersion = 1`. Old results remain interpretable under their original policy; nothing
is retroactively rewritten.

## 7. UI — simple-first (Vietnamese, progressive disclosure)

Four tabs only: **Tổng quan / Thuật toán / So sánh / Lịch sử** (readiness folds into Overview's
collapsed *Chi tiết kỹ thuật*; stability into the algorithm detail's technical block). Level 1 is a
plain conclusion (`✓ Có cải thiện ổn định`, `○ Chưa đủ dữ liệu`, `! Kết quả chưa ổn định`,
`↓ Giảm hiệu năng`) + friendly metric ("Sai số xác suất 0.214 — Tốt hơn baseline 0.012"). Raw
metrics/fingerprints/folds/search-ledger live under a collapsed **Chi tiết kỹ thuật** (`<details>`).
Insufficient data shows "Cần thêm khoảng N vòng hoàn chỉnh", never a raw enum dump. No "winner"
badge; comparison leads with a plain sentence. Renderer: [analytics.js](../ui-analytics/analytics.js).

## 8. Performance (§69, full on-demand evaluation incl. grid + 4-fold walk-forward)

| n | LOGISTIC | SPLINE | TREE |
|---|---|---|---|
| 1k | ~57 ms | ~131 ms | ~48 ms |
| 10k | ~354 ms | ~1.1 s | ~440 ms |
| 100k | ~4.0 s | ~11.9 s | ~5.6 s |

100k-scale research remains usable; no family is operationally prohibitive.

## 9. Real-data status

At time of writing the real Analytics DB has **0 COMPLETE rounds**, so every family (including V1
linear) is `INSUFFICIENT_DATA` and `ADVANCED_REAL_EVALUATION = INSUFFICIENT_DATA` — the honest,
expected state (§8/§65). Implementation-readiness and real-evidence-readiness are tracked
separately: the platform is structurally complete before evidence exists.

## 10. Tests (§74)

[research-v2-platform.test.mjs](../tests/js/research-v2-platform.test.mjs) — registry discovery,
V1 fingerprint stability, family-specific readiness, shared-engine spline/tree, **known-nonlinear**
(spline beats linear), **linear simplicity preference** (no false complexity win), **threshold**
(tree detects), **regime shift** (not stable), model-failure taxonomy, determinism, numeric
stability, paired comparability, batch persistence, version generations, family monitoring, and
**V1→V4 migration compatibility**. [research-v2-ui-boundary.test.mjs](../tests/js/research-v2-ui-boundary.test.mjs)
— family/complexity/incremental discovery, four-tab simple-first + collapsed technical, plain
insufficient-data, **no wagering wording**, read-only IPC surface. The V1
[research-boundary.test.mjs](../tests/js/research-boundary.test.mjs) automatically scans the new
`research/` modules for action/protocol imports (`NEW_ALGORITHM_ACTION_IMPORTS = NONE`,
`NEW_ALGORITHM_PROTOCOL_SEND_IMPORTS = NONE`).
