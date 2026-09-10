'use strict';

// ---------------------------------------------------------------------------
// Seller-generator PLAN UI DEFAULTS (PURE). These are convenience defaults the
// GUI pre-fills when a plan card is chosen — the seller may still override every
// capacity/feature before signing, and the signed payload is validated by the
// existing entitlements core. This does NOT change desktop/licensing/* presets.
//
// Feature defaults are taken verbatim from the audited PLAN_PRESETS so the
// generator never silently diverges the product's feature meaning. Capacity and
// default duration follow the V2 product rules for the generator:
//   TRIAL    -> 7 ngày,  5 profile / 5 đồng thời   (capacity override per spec)
//   STANDARD -> 1 tháng, current STANDARD source capacity
//   PRO      -> 1 tháng, current PRO source capacity
// ---------------------------------------------------------------------------

const { PLAN_PRESETS } = require('../../desktop/licensing/entitlements.cjs');

// Duration spec shape matches tools/license-generator/duration.cjs.
const PLAN_UI_DEFAULTS = Object.freeze({
  TRIAL: Object.freeze({
    duration: { unit: 'days', value: 7 },
    maxBrowsers: 5,
    maxConcurrentBrowsers: 5,
    features: { ...PLAN_PRESETS.TRIAL.features },
  }),
  STANDARD: Object.freeze({
    duration: { unit: 'months', value: 1 },
    maxBrowsers: PLAN_PRESETS.STANDARD.maxBrowsers,
    maxConcurrentBrowsers: PLAN_PRESETS.STANDARD.maxConcurrentBrowsers,
    features: { ...PLAN_PRESETS.STANDARD.features },
  }),
  PRO: Object.freeze({
    duration: { unit: 'months', value: 1 },
    maxBrowsers: PLAN_PRESETS.PRO.maxBrowsers,
    maxConcurrentBrowsers: PLAN_PRESETS.PRO.maxConcurrentBrowsers,
    features: { ...PLAN_PRESETS.PRO.features },
  }),
});

module.exports = { PLAN_UI_DEFAULTS };
