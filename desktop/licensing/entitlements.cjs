'use strict';

// ---------------------------------------------------------------------------
// WU-C.4 — License entitlements. Pure, customer-safe (no private key, no crypto):
//   - normalizeEntitlement(payload): the single trusted representation consumed by
//     BrowserRegistry, browser launch, Auto Run, Jackpot and History enforcement.
//   - validateEntitlementInput(input): seller-side pre-sign validation (shared by
//     the CLI and GUI generators) so an invalid combination is never signed.
//   - buildLicensePayloadV2(input): the exact signed v2 payload shape.
//
// Legacy policy (§37): a v2 license grants a feature ONLY when it is explicitly
// signed `true` — a MISSING feature is false (never accidental access). A v1
// license predates entitlements entirely and is treated by ONE explicit documented
// policy (LEGACY_V1_ENTITLEMENT): full product access with capacity taken from the
// signed maxBrowsers if present, else unlimited. This preserves already-issued v1
// keys without silently upgrading them field-by-field.
// ---------------------------------------------------------------------------

const PLANS = Object.freeze(['TRIAL', 'STANDARD', 'PRO']);
const FEATURE_KEYS = Object.freeze(['autoRun', 'jackpotLive', 'jackpotGate', 'roundHistory']);

function isInt(n) { return Number.isInteger(n); }
function toCap(v) { return v != null && Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : null; }

// The explicit, documented policy for pre-entitlement (v1) licenses.
function legacyV1Entitlement(payload) {
  return {
    valid: true,
    schemaVersion: 1,
    legacy: true,
    licenseId: payload && payload.licenseId || null,
    plan: 'LEGACY',
    expiresAt: payload ? payload.expiresAt : null,
    // v1 had no per-browser capacity concept beyond an optional maxBrowsers seam.
    maxBrowsers: payload && payload.maxBrowsers != null ? toCap(payload.maxBrowsers) : null, // null = unlimited
    maxConcurrentBrowsers: null, // unlimited for legacy keys
    features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true },
  };
}

/**
 * normalizeEntitlement(payload) — turn a VERIFIED signed payload into the single
 * trusted entitlement snapshot. Assumes the caller has already verified signature,
 * machine and expiry; this only maps fields (no trust decisions).
 */
function normalizeEntitlement(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.v === 2) {
    const f = (payload.features && typeof payload.features === 'object') ? payload.features : {};
    const jackpotLive = f.jackpotLive === true;
    return {
      valid: true,
      schemaVersion: 2,
      legacy: false,
      licenseId: payload.licenseId || null,
      plan: PLANS.includes(payload.plan) ? payload.plan : 'STANDARD',
      expiresAt: payload.expiresAt,
      maxBrowsers: toCap(payload.maxBrowsers),
      maxConcurrentBrowsers: toCap(payload.maxConcurrentBrowsers),
      features: {
        autoRun: f.autoRun === true,
        jackpotLive,
        // dependency enforced structurally: gate is only ever true with live (§10)
        jackpotGate: f.jackpotGate === true && jackpotLive,
        roundHistory: f.roundHistory === true,
      },
    };
  }
  // v1 (or any pre-entitlement schema) -> explicit legacy policy.
  return legacyV1Entitlement(payload);
}

// A no-license / invalid snapshot: everything denied. Used as the fail-closed default.
function deniedEntitlement() {
  return { valid: false, schemaVersion: null, legacy: false, licenseId: null, plan: null, expiresAt: null, maxBrowsers: 0, maxConcurrentBrowsers: 0, features: { autoRun: false, jackpotLive: false, jackpotGate: false, roundHistory: false } };
}

// ---- seller-side pre-sign validation (shared by CLI + GUI) ----
function validateEntitlementInput(input = {}) {
  const errors = [];
  if (!PLANS.includes(input.plan)) errors.push({ field: 'plan', code: 'INVALID_PLAN', message: 'Gói bản quyền không hợp lệ.' });
  const mb = Number(input.maxBrowsers);
  if (!isInt(mb) || mb < 1 || mb > 100000) errors.push({ field: 'maxBrowsers', code: 'INVALID_MAX_BROWSERS', message: 'Số hồ sơ tối đa phải là số nguyên ≥ 1.' });
  const mc = Number(input.maxConcurrentBrowsers);
  if (!isInt(mc) || mc < 1 || mc > 100000) errors.push({ field: 'maxConcurrentBrowsers', code: 'INVALID_MAX_CONCURRENT', message: 'Số trình duyệt chạy đồng thời phải là số nguyên ≥ 1.' });
  if (isInt(mb) && isInt(mc) && mc > mb) errors.push({ field: 'maxConcurrentBrowsers', code: 'CONCURRENT_EXCEEDS_TOTAL', message: 'Số trình duyệt chạy đồng thời không được lớn hơn số hồ sơ tối đa.' });
  const f = input.features || {};
  for (const k of FEATURE_KEYS) if (typeof f[k] !== 'boolean') errors.push({ field: 'features.' + k, code: 'INVALID_FEATURE', message: `Tính năng ${k} phải là true/false.` });
  // dependency: jackpotGate requires jackpotLive (§10) — validated independently of any UI.
  if (f.jackpotGate === true && f.jackpotLive !== true) errors.push({ field: 'features.jackpotGate', code: 'JACKPOT_GATE_REQUIRES_LIVE', message: '"Chờ Jackpot" cần bật "Jackpot trực tiếp".' });
  return { ok: errors.length === 0, errors };
}

// The exact signed v2 payload (canonicalJson later sorts keys; signature covers all).
function buildLicensePayloadV2({ machineId, plan, issuedAt, expiresAt, maxBrowsers, maxConcurrentBrowsers, features, licenseId }) {
  const f = features || {};
  return {
    v: 2,
    product: 'WVPT',
    machineId,
    plan,
    issuedAt,
    expiresAt,
    maxBrowsers: Number(maxBrowsers),
    maxConcurrentBrowsers: Number(maxConcurrentBrowsers),
    features: {
      autoRun: f.autoRun === true,
      jackpotLive: f.jackpotLive === true,
      jackpotGate: f.jackpotGate === true,
      roundHistory: f.roundHistory === true,
    },
    licenseId,
  };
}

// Default per-plan presets (seller convenience only — NOT runtime authority). Kept in
// ONE place so limits can be changed without touching the rest of the source (§8).
const PLAN_PRESETS = Object.freeze({
  TRIAL: { maxBrowsers: 1, maxConcurrentBrowsers: 1, features: { autoRun: true, jackpotLive: true, jackpotGate: false, roundHistory: true } },
  STANDARD: { maxBrowsers: 5, maxConcurrentBrowsers: 2, features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true } },
  PRO: { maxBrowsers: 20, maxConcurrentBrowsers: 10, features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true } },
});

module.exports = {
  PLANS, FEATURE_KEYS, PLAN_PRESETS,
  normalizeEntitlement, deniedEntitlement, legacyV1Entitlement,
  validateEntitlementInput, buildLicensePayloadV2,
};
