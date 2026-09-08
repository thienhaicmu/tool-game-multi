# Jackpot Statistical Intelligence — Data Audit & Report Redesign

**Product:** Aviator Analytics (passive, observe-only). **Scope:** Report UX + display
formatting + statistical-research readiness. **Out of scope:** Control, AutoRunner,
BET/CASHOUT, protocol sending, licensing, recovery.

This document is **source-first**: every claim below is grounded in the actual schema
([migrations.cjs](../desktop/analytics/db/migrations.cjs)), the round reconstruction
([round-assembler.cjs](../desktop/analytics/round-assembler.cjs)), and the existing query
primitives ([confidence.cjs](../desktop/analytics/query/confidence.cjs),
[analytics-query-engine.cjs](../desktop/analytics/query/analytics-query-engine.cjs)).
It states **no prediction claims** and defines the leakage guard required before any
future modeling.

---

## 1. Current data inventory

Per-round facts stored in the `rounds` table (one row per reconstructed Aviator round,
isolated per `browser_id` + `capture_session_id`):

| Group | Columns | Notes |
|---|---|---|
| Identity | `sid`, `sequence_number`, `capture_session_id`, `browser_id` | `sequence_number` is per-capture-stream, allocated in order |
| Lifecycle | `opened_at_ms`, `locked_at_ms`, `first_odd_at_ms`, `ended_at_ms`, `duration_ms` | never fabricated — NULL if not observed |
| Odd | `first_odd`, `last_odd`, `max_odd` | `max_odd` is the game-round outcome target |
| Jackpot (level) | `jackpot_at_open`, `jackpot_at_lock`, `jackpot_at_first_odd`, `jackpot_at_end` | **exact-event only** (policy A): value taken from the frame at that lifecycle point, else NULL — never interpolated |
| Jackpot (aggregate) | `jackpot_min`, `jackpot_max`, `jackpot_avg`, `jackpot_delta` | recomputed over all in-round jackpot samples; `delta = last − first sample` |
| Density | `odd_sample_count`, `jackpot_sample_count` | sampling is **event-driven → irregular** |
| Quality | `completeness` (COMPLETE / PARTIAL_START / PARTIAL_END / INTERRUPTED / UNKNOWN) | plus `round_metrics.timing_censored = !capturedFromStart` |

Time-series (per round): `round_odd_samples(timestamp_ms, elapsed_from_first_odd_ms, odd)`
and `round_jackpot_samples(timestamp_ms, elapsed_ms, jackpot)` — these make slope /
volatility / time-weighted metrics **derivable**, subject to the density caveat below.

Threshold outcomes (`round_metrics`, generated from
[thresholds.cjs](../desktop/analytics/thresholds.cjs) =
`1.20, 1.50, 2, 3, 5, 10, 20, 50, 100, 500, 1000`): `reached_<k>` (0/1) and
`time_to_<k>_ms` per threshold. First authoritative sample `≥ T`, **no interpolation**.

Also stored (Advanced/technical only): `raw_protocol_events`, `raw_ws_events`,
`ws_connections`, `network_requests/responses/bodies`.

## 2. Missing-data analysis

- **Exact-event jackpot levels can be NULL.** `jackpot_at_open` exists only if the
  `ROUND_OPEN` frame carried a jackpot value; same for lock/first-odd/end. The report
  already surfaces this as `missingJackpotBasis`. Any Jackpot-basis analysis must report
  the missing count and treat NULL as **—**, never 0.
- **Lifecycle timestamps may be NULL** for rounds joined mid-stream (`PARTIAL_START`,
  `capturedFromStart = false`). `duration_ms` is NULL unless both open and end were seen.
- **`time_to_<k>` is unreliable for `timing_censored` rounds** (joined after start) — the
  timing query already excludes censored rounds.
- **Irregular jackpot sampling.** Jackpot samples are ingested only on frames that carry a
  jackpot (OPEN / LOCK / ODD / END / other RECV). `jackpot_sample_count` varies per round;
  inter-sample spacing is not fixed. A naïve slope (`delta ÷ count`) is therefore
  **misleading**; any slope/volatility must be time-normalized (using `timestamp_ms`) and
  gated on a minimum sample count + span. This is a real limitation, stated explicitly.

## 3. Jackpot feature matrix

Availability: `RAW` = stored column · `DERIVED` = computable from stored samples/prior rounds
· `DERIVABLE*` = computable but reliability-gated · `MISSING` = not capturable from current data.

| Feature | Availability | Source |
|---|---|---|
| `jp_open` / `jp_lock` / `jp_first_odd` / `jp_end` | RAW | `rounds.jackpot_at_*` |
| `jp_min` / `jp_max` / `jp_avg` / `jp_delta` | RAW | `rounds.jackpot_*` |
| `jp_range` (max−min) | DERIVED | `jackpot_max − jackpot_min` |
| `jp_pct_change` | DERIVED | `jackpot_delta ÷ first sample` (guard divide-by-0/NULL) |
| `update_count` | RAW | `jackpot_sample_count` |
| `slope` / `early_slope` / `late_slope` | DERIVABLE* | `round_jackpot_samples` (time-normalized; density-gated) |
| `volatility` (stdev of samples/increments) | DERIVABLE* | `round_jackpot_samples` (density-gated) |
| `time_weighted_avg` | DERIVABLE* | `round_jackpot_samples` (needs ≥2 timed samples) |
| prev-round `jp_open`, JP change vs prev, rolling JP mean/delta | DERIVED | prior rounds ordered by `sequence_number` within one browser/session |

## 4. Outcome feature matrix

The statistical **target is the GAME-ROUND outcome**, never user WIN/LOSS (user strategy
would contaminate the game process).

| Feature | Availability | Source |
|---|---|---|
| `max_odd` (primary target) | RAW | `rounds.max_odd` |
| `reached_1.2 … reached_1000` | RAW | `round_metrics.reached_<k>` |
| `time_to_<k>_ms` | RAW | `round_metrics.time_to_<k>_ms` (exclude `timing_censored`) |
| `duration_ms`, `first_odd`, `last_odd` | RAW | `rounds.*` |

## 5. Leakage / stage matrix (the most important audit)

Each feature is tagged by **when it first becomes known** within a round. A forward-usable
model may only consume features known **before the outcome process begins** (i.e. by round
open, at latest lock). Everything realized during/after the multiplier climb is
**retrospective-only**.

| Stage (known by) | Features | Forward-safe? |
|---|---|---|
| PRE_ROUND | hour / weekday / date, session age, all **prior-round** context (prev maxOdd, rolling median/threshold rate, low-odd streak, gap since ≥5×/≥10×, prev/rolling JP), `sequence_number` | ✅ yes |
| ROUND_OPEN | `jp_open` (when present) | ✅ yes (measure missing-rate) |
| ROUND_LOCK | `jp_lock` (when present) | ✅ yes (available before the climb resolves) |
| IN_ROUND | `jp_first_odd`, in-round jackpot/odd samples, early slope | ⚠️ contemporaneous with outcome onset — descriptive only |
| POST_ROUND | `max_odd`, `reached_<k>`, `time_to_<k>`, `jp_end`, `jp_min/max/avg/delta`, full `update_count`, full slope/volatility, `duration_ms`, `last_odd` | ❌ no (retrospective only) |

**Forward-safe whitelist:** `{ jp_open, jp_lock, prior-round context, time-of-day, session
age, sequence_number }`. **Post-round-only (leakage if used forward):** `{ max_odd,
reached_<k>, time_to_<k>, jp_end, jp_min, jp_max, jp_avg, jp_delta, full update_count,
full-round slope/volatility, duration_ms, last_odd }`.

## 6. Two analysis modes

- **MODE A — Retrospective.** "What relationships existed historically?" May use every
  field including `jp_avg/jp_max/jp_end` and `max_odd`. Must be labelled *lịch sử /
  retrospective*. **Ready now** (data is rich; Wilson CI already available).
- **MODE B — Forward-usable.** "What was knowable at/before round start?" May use only the
  forward-safe whitelist (§5). Never mixes post-round fields. Requires leakage-guarded
  feature construction + time-split validation before any modeling.

## 7. Statistical-method suitability

| Method | Verdict | Basis |
|---|---|---|
| Descriptive (count/mean/median/quantiles/variance) | **READY NOW** | query engine already computes median, p90/p95/p99 |
| Observed threshold rate `P(maxOdd ≥ X \| JP range)` + **Wilson 95% CI** | **READY NOW** | `confidence.wilson()` implemented & already rendered |
| Contingency JP-bucket × ODD-bucket (χ², Cramér's V) | DEFERRED | counts already produced; needs expected-cell-count ≥5 guard before χ² |
| Rank correlation JP vs maxOdd (Spearman/Kendall) | DEFERRED | data present; not yet implemented |
| Distribution comparison across JP ranges (KS / Mann–Whitney / Kruskal–Wallis) | DEFERRED | data present; not yet implemented |
| Logistic regression `reached_k ~ jp + hour + context` | DEFERRED (descriptive only) | report odds-ratios + CI, **never** "next-round prediction" |
| GAM / tree / gradient boosting | DEFERRED (exploratory) | require time-split holdout + calibration (Brier, ROC-AUC) + baseline |

**Sample-quality policy — reuse existing convention** (`confidence.sampleQuality`):
`n<30 = VERY_LOW`, `30–99 = LOW`, `100–999 = MODERATE`, `≥1000 = GOOD`. The UI already
colour-codes `n<30` / `n<100`; keep these thresholds. Small-n results are **labelled, not
hidden**.

## 8. Algorithm-readiness verdict

- **Retrospective descriptive intelligence: READY NOW.** All jackpot bases, `max_odd`,
  threshold outcomes, timing, and per-round samples are stored; Wilson CI is implemented.
- **Forward predictive model: PARTIAL / NEEDS MORE DATA + strict leakage guard.** A
  forward-safe feature set exists (§5 whitelist) but the high-signal fields are post-round
  (leakage). Before any model: enforce the stage whitelist in code, split train/test **by
  time**, prevent browser/session leakage, and validate with calibration + baseline. Not
  built in this WU (no prediction model, by directive).

## 9. Report simplification decisions

Audit of the current report ([index.html](../ui-analytics/index.html) /
[analytics.js](../ui-analytics/analytics.js)) — it is **already** largely Jackpot-first:
top nav is HOME / BÁO CÁO / LỊCH SỬ / **NÂNG CAO**, the dev-heavy views (Web Log, Network/API,
Data) are **already under Advanced**, and the report filter bar already carries time /
last-N / hour / **Jackpot basis**.

| Current report section | Decision |
|---|---|
| Tổng quan (overview: cards + threshold table + JP comparison) | **KEEP_PRIMARY** (the headline view) |
| Jackpot (range × ODD + JP delta) | **KEEP_PRIMARY** — promoted to 2nd (Jackpot-first order) |
| ODD (ODD × Jackpot matrix) | **KEEP_PRIMARY** |
| Thời gian (hour × Jackpot) | **KEEP_PRIMARY** (host of the time metric selector) |
| Tốc độ ODD (time-to-threshold × Jackpot) | **MERGE** → a metric inside *Thời gian* (reduces 6→5 sections) |
| Chuỗi & Khoảng cách (streaks + gaps + JP exposure) | **KEEP_PRIMARY** (the *Chuỗi / Xu hướng* section) |
| Web Log / Network-API / Data (Advanced) | **ALREADY IN ADVANCED** — keep; backend retained |

Target normal-user structure (Jackpot-first, 5 sections): **Tổng quan → Jackpot → ODD →
Thời gian → Chuỗi / Xu hướng**.

Global filter bar (implemented): Thời gian, Số vòng gần nhất, Giờ, **Jackpot Basis**,
**Jackpot Range**. The range is an authoritative HALF-OPEN `[min, max)` predicate on the
**selected basis** column (`jackpotRangeMin/Max` in
[analytics-filter.cjs](../desktop/analytics/query/analytics-filter.cjs)), applied inside
`buildWhere` so it propagates to every report perspective via `_load(spec)`. NULL basis
rounds are excluded (never coerced to 0). Query semantics (from source): time → hour/browser
→ **Jackpot Range on the selected basis** → deterministic order → Last-N over the qualifying
population (Last-N is applied AFTER the range).

Language guard (enforced by test): no `dự đoán / vòng tiếp theo / nên cược / tín hiệu /
jackpot nóng|lạnh`. Only descriptive terms (`tỷ lệ quan sát`, `phân phối`, `xu hướng`,
`khoảng tin cậy`, `mẫu dữ liệu`).

## 10. Deferred items (not in this WU)

1. **Landed:** the Tốc độ ODD → Thời gian merge AND the global Jackpot-**Range** filter
   (half-open `[min,max)`, basis-aligned, propagated to all report perspectives).
2. Contingency (χ²/Cramér's V), rank correlation, distribution tests — backend stats,
   deferred with cell-count / assumption guards.
3. Any forward predictive model — deferred; requires the §5 leakage guard enforced in code
   + time-split validation + calibration.
4. Real-Electron visual acceptance of the redesigned report with live captured data —
   requires a desktop session with passive traffic; see the WU final report.

*No conclusion in this document asserts a future outcome or a prediction; all statements
describe stored/derivable data and historical, sample-bounded observation.*
