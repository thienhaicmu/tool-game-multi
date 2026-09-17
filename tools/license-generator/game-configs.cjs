'use strict';

// ---------------------------------------------------------------------------
// GAME_CONFIGS — the single game-scoped option model for the License Generator (PURE).
//
// One renderer + one signer consume this; nothing else decides which options a game
// has. Every option here is one the runtime projects ALREADY support — nothing new is
// invented:
//   - Game ids are the canonical signed `gameProduct` values (entitlements.GAME_PRODUCTS).
//   - Signing key ids come from public-key.cjs (PRODUCT_DEFAULT_KEY_ID) — one keypair
//     per game, so the config never chooses a key on its own.
//   - Plans / capacities / durations come from PLAN_UI_DEFAULTS (plan-ui-defaults.cjs).
//   - Features: only AVIATOR consumes signed features (main.cjs enforces autoRun,
//     jackpotLive, jackpotGate, roundHistory). The PHOM runtime consumes NONE of them, so
//     PHOM exposes no feature options and signs them all `false` (schema v2 still
//     requires the four booleans; false = "not granted", the fail-closed default).
// ---------------------------------------------------------------------------

const { PLANS, GAME_PRODUCTS, FEATURE_KEYS } = require('../../desktop/licensing/entitlements.cjs');
const { PRODUCT_DEFAULT_KEY_ID } = require('../../desktop/licensing/public-key.cjs');
const { PLAN_UI_DEFAULTS } = require('./plan-ui-defaults.cjs');

const PLAN_LABELS = Object.freeze({ TRIAL: 'Trial', STANDARD: 'Standard', PRO: 'Pro' });

// The generator's supported duration choices (unchanged from the previous UI).
const DURATIONS = Object.freeze([
  Object.freeze({ id: 'd7', unit: 'days', value: 7, label: '7 ngày' }),
  Object.freeze({ id: 'm1', unit: 'months', value: 1, label: '1 tháng' }),
  Object.freeze({ id: 'm3', unit: 'months', value: 3, label: '3 tháng' }),
  Object.freeze({ id: 'm6', unit: 'months', value: 6, label: '6 tháng' }),
  Object.freeze({ id: 'm12', unit: 'months', value: 12, label: '1 năm' }),
  Object.freeze({ id: 'custom', unit: 'custom', label: 'Custom Date' }),
]);

const CAPACITIES = Object.freeze([
  Object.freeze({ key: 'maxBrowsers', label: 'Max Profiles', min: 1, max: 100000 }),
  Object.freeze({ key: 'maxConcurrentBrowsers', label: 'Max Browsers', min: 1, max: 100000, notAbove: 'maxBrowsers' }),
]);

const AVIATOR_FEATURES = Object.freeze([
  Object.freeze({ key: 'autoRun', label: 'Chạy tự động' }),
  Object.freeze({ key: 'jackpotLive', label: 'Jackpot trực tiếp' }),
  Object.freeze({ key: 'jackpotGate', label: 'Chờ Jackpot', requires: 'jackpotLive' }),
  Object.freeze({ key: 'roundHistory', label: 'Lịch sử vòng chơi' }),
]);

function durationId(spec) {
  const hit = DURATIONS.find((d) => d.unit === spec.unit && d.value === spec.value);
  return hit ? hit.id : 'm1';
}

function plansFor(withFeatures) {
  return Object.freeze(PLANS.map((id) => {
    const d = PLAN_UI_DEFAULTS[id];
    return Object.freeze({
      id,
      label: PLAN_LABELS[id],
      defaultDuration: durationId(d.duration),
      capacities: Object.freeze({ maxBrowsers: d.maxBrowsers, maxConcurrentBrowsers: d.maxConcurrentBrowsers }),
      features: Object.freeze(withFeatures ? { ...d.features } : {}),
    });
  }));
}

const GAME_CONFIGS = Object.freeze({
  PHOM: Object.freeze({
    game: 'PHOM',
    label: 'PHỎM',
    signingKeyId: PRODUCT_DEFAULT_KEY_ID.PHOM,
    defaultPlan: 'STANDARD',
    plans: plansFor(false),
    durations: DURATIONS,
    capacities: CAPACITIES,
    features: Object.freeze([]),
  }),
  AVIATOR: Object.freeze({
    game: 'AVIATOR',
    label: 'AVIATOR',
    signingKeyId: PRODUCT_DEFAULT_KEY_ID.AVIATOR,
    defaultPlan: 'STANDARD',
    plans: plansFor(true),
    durations: DURATIONS,
    capacities: CAPACITIES,
    features: AVIATOR_FEATURES,
  }),
});

const GAME_ORDER = Object.freeze(['PHOM', 'AVIATOR']);

function gameConfig(game) {
  const id = String(game || '').toUpperCase();
  return GAME_PRODUCTS.includes(id) ? GAME_CONFIGS[id] || null : null;
}

function planConfig(game, plan) {
  const cfg = gameConfig(game);
  return cfg ? cfg.plans.find((p) => p.id === String(plan || '').toUpperCase()) || null : null;
}

// Is a duration spec one this game offers? (custom needs a date; the date itself is
// validated by duration.cjs at signing time.)
function isDurationAllowed(game, spec) {
  const cfg = gameConfig(game);
  if (!cfg || !spec || typeof spec !== 'object') return false;
  if (spec.unit === 'custom') return cfg.durations.some((d) => d.unit === 'custom');
  return cfg.durations.some((d) => d.unit === spec.unit && d.value === Number(spec.value));
}

// The feature booleans that get SIGNED for a game. Only the game's own feature keys are
// taken from input; every other key is forced false, so a stale field from another game
// can never reach the signature.
function signedFeaturesFor(game, inputFeatures) {
  const cfg = gameConfig(game);
  const allowed = new Set(cfg ? cfg.features.map((f) => f.key) : []);
  const input = inputFeatures && typeof inputFeatures === 'object' ? inputFeatures : {};
  const out = {};
  for (const k of FEATURE_KEYS) out[k] = allowed.has(k) ? input[k] === true : false;
  return out;
}

// JSON-safe copy for the renderer (no keys, no paths — just option metadata).
function publicGameConfigs() {
  return { order: GAME_ORDER.slice(), games: JSON.parse(JSON.stringify(GAME_CONFIGS)) };
}

module.exports = { GAME_CONFIGS, GAME_ORDER, DURATIONS, gameConfig, planConfig, isDurationAllowed, signedFeaturesFor, publicGameConfigs };
