'use strict';

const crypto = require('node:crypto');
const { canonicalJson, fromBase64url } = require('./canonical-json.cjs');
const { PUBLIC_KEY_PEM, SIGNING_KEYS, LEGACY_DEFAULT_KEY_ID, PRODUCT_KEY_IDS } = require('./public-key.cjs');

const PREFIX = 'WVPT1';
const PRODUCT = 'WVPT';
const MAX_FUTURE_ISSUE_SKEW_SECONDS = 24 * 60 * 60;

function typed(code, message, extra = {}) {
  return { ok: false, active: false, error: { code, message, ...extra } };
}

function parseLicense(license) {
  const parts = String(license || '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new Error('format');
  const payloadRaw = fromBase64url(parts[1]);
  const signature = fromBase64url(parts[2]);
  const payload = JSON.parse(payloadRaw.toString('utf8'));
  return { payload, payloadRaw, signature };
}

const SUPPORTED_SCHEMAS = new Set([1, 2]);
const PLANS = new Set(['TRIAL', 'STANDARD', 'PRO']);
const FEATURE_KEYS = ['autoRun', 'jackpotLive', 'jackpotGate', 'roundHistory'];
// Signed game-product entitlement (schema v2+). Only two products exist; `ALL` was
// removed (§3) — a payload with gameProduct='ALL' now fails LICENSE_GAME_PRODUCT_INVALID.
// A license with NO `gameProduct` predates the split and is AVIATOR-only (legacy §4/§10).
const GAME_PRODUCTS = new Set(['AVIATOR', 'PHOM']);
const LEGACY_GAME_PRODUCT = 'AVIATOR';

// The effective, signed game entitlement of a verified payload. Absent => AVIATOR.
function effectiveGameProduct(payload) {
  return payload && payload.gameProduct != null ? payload.gameProduct : LEGACY_GAME_PRODUCT;
}

// The signed signing-key id (which key signed this license). Absent => legacy Aviator key.
function effectiveSigningKeyId(payload) {
  return payload && payload.signingKeyId != null ? String(payload.signingKeyId) : LEGACY_DEFAULT_KEY_ID;
}

function validatePayloadShape(payload, nowSeconds) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'LICENSE_INVALID_FORMAT';
  if (!SUPPORTED_SCHEMAS.has(payload.v)) return 'LICENSE_INVALID_FORMAT';
  if (payload.product !== PRODUCT) return 'LICENSE_WRONG_PRODUCT';
  // gameProduct is optional (legacy keys omit it) but, when present, must be a known
  // enum — an unknown value is a hard format failure, never silently coerced.
  if (payload.gameProduct !== undefined && !GAME_PRODUCTS.has(payload.gameProduct)) return 'LICENSE_GAME_PRODUCT_INVALID';
  // signingKeyId (optional; legacy keys omit it) must be a short id token when present.
  if (payload.signingKeyId !== undefined && !/^[A-Z0-9_]{1,32}$/.test(String(payload.signingKeyId))) return 'LICENSE_SIGNING_KEY_ID_INVALID';
  if (!/^WVPT-PC-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(String(payload.machineId || ''))) return 'LICENSE_INVALID_FORMAT';
  if (!/^LIC-[0-9A-F]{8,32}$/.test(String(payload.licenseId || ''))) return 'LICENSE_INVALID_FORMAT';
  if (!Number.isInteger(payload.issuedAt) || !Number.isInteger(payload.expiresAt)) return 'LICENSE_INVALID_FORMAT';
  if (payload.issuedAt <= 0 || payload.expiresAt <= 0 || payload.expiresAt <= payload.issuedAt) return 'LICENSE_INVALID_FORMAT';
  if (payload.issuedAt > nowSeconds + MAX_FUTURE_ISSUE_SKEW_SECONDS) return 'LICENSE_INVALID_FORMAT';
  if (payload.v === 1) {
    // Legacy schema — optional launch cap, no signed entitlements.
    if (payload.maxLaunches != null && (!Number.isInteger(payload.maxLaunches) || payload.maxLaunches < 1 || payload.maxLaunches > 1000000)) return 'LICENSE_INVALID_FORMAT';
    return null;
  }
  // Schema v2 — signed plan, capacities and features are all part of the trust anchor.
  if (!PLANS.has(payload.plan)) return 'LICENSE_INVALID_FORMAT';
  if (!Number.isInteger(payload.maxBrowsers) || payload.maxBrowsers < 1 || payload.maxBrowsers > 100000) return 'LICENSE_INVALID_FORMAT';
  if (!Number.isInteger(payload.maxConcurrentBrowsers) || payload.maxConcurrentBrowsers < 1 || payload.maxConcurrentBrowsers > 100000) return 'LICENSE_INVALID_FORMAT';
  if (payload.maxConcurrentBrowsers > payload.maxBrowsers) return 'LICENSE_INVALID_FORMAT';
  const f = payload.features;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'LICENSE_INVALID_FORMAT';
  for (const k of FEATURE_KEYS) if (typeof f[k] !== 'boolean') return 'LICENSE_INVALID_FORMAT';
  if (f.jackpotGate === true && f.jackpotLive !== true) return 'LICENSE_INVALID_FORMAT'; // dependency (§10)
  return null;
}

function verifyLicense(license, options = {}) {
  if (!Number.isFinite(Number(options.nowMs))) return typed('TRUSTED_TIME_UNAVAILABLE', 'Trusted UTC+7 time is required');
  const nowSeconds = Math.floor(Number(options.nowMs) / 1000);
  let parsed;
  try { parsed = parseLicense(license); } catch { return typed('LICENSE_INVALID_FORMAT', 'License format is invalid'); }
  const shapeError = validatePayloadShape(parsed.payload, nowSeconds);
  if (shapeError) return typed(shapeError, shapeError === 'LICENSE_WRONG_PRODUCT' ? 'License is for a different product' : 'License payload is invalid', { payload: parsed.payload });

  // Resolve which public key must verify this license from its SIGNED signingKeyId
  // (absent => the legacy Aviator key). A single-key override (options.publicKeyPem) is
  // honored for back-compat / tests; otherwise the registry (options.signingKeys) is used.
  const keyId = effectiveSigningKeyId(parsed.payload);
  const registry = options.signingKeys || SIGNING_KEYS;
  const verifyKey = options.publicKeyPem || registry[keyId];
  if (!verifyKey) return typed('LICENSE_SIGNING_KEY_ID_INVALID', 'License signing key id is not recognised', { payload: parsed.payload, signingKeyId: keyId });

  let canonical;
  try { canonical = canonicalJson(parsed.payload); } catch { return typed('LICENSE_INVALID_FORMAT', 'License payload is not canonical JSON'); }
  const canonicalPayload = Buffer.from(canonical, 'utf8');
  if (!crypto.verify(null, canonicalPayload, verifyKey, parsed.signature)) {
    return typed('LICENSE_BAD_SIGNATURE', 'License signature is invalid', { payload: parsed.payload });
  }
  if (parsed.payloadRaw.toString('utf8') !== canonical) return typed('LICENSE_BAD_SIGNATURE', 'License payload has been modified', { payload: parsed.payload });
  if (parsed.payload.machineId !== options.machineId) {
    return typed('LICENSE_MACHINE_MISMATCH', 'License does not match this device', { payload: parsed.payload, licenseMachineId: parsed.payload.machineId, currentMachineId: options.machineId });
  }
  // Key/product isolation (§5): the resolved signing key id must be ALLOWED for the
  // license's effective gameProduct. This blocks a crafted keyId that would otherwise let
  // a PHOM payload ride on the Aviator key (and vice-versa), even after the signature
  // itself verifies. Legacy keys (no signingKeyId, no gameProduct) => AVIATOR + AVIATOR_V1.
  const effective = effectiveGameProduct(parsed.payload);
  const allowedKeyIds = (options.productKeyIds || PRODUCT_KEY_IDS)[effective] || [];
  if (!allowedKeyIds.includes(keyId)) {
    return typed('LICENSE_SIGNING_KEY_PRODUCT_MISMATCH', 'License signing key is not valid for its game product', { payload: parsed.payload, signingKeyId: keyId, gameProduct: effective });
  }
  // Signed game-product entitlement (§3/§4). Only enforced when the calling app states
  // which game it is (Aviator app -> AVIATOR, Phom-QA app -> PHOM).
  if (options.expectedGameProduct) {
    const expected = String(options.expectedGameProduct).toUpperCase();
    if (effective !== expected) {
      // A legacy key (no signed gameProduct) may run AVIATOR but NEVER PHOM.
      if (parsed.payload.gameProduct == null && expected === 'PHOM') {
        return typed('LICENSE_PHOM_ENTITLEMENT_REQUIRED', 'This license predates Phỏm QA and does not grant Phỏm access', { payload: parsed.payload });
      }
      return typed('LICENSE_GAME_PRODUCT_MISMATCH', 'License is for a different game product', { payload: parsed.payload, licenseGameProduct: effective, expectedGameProduct: expected });
    }
  }
  if (nowSeconds > parsed.payload.expiresAt) return typed('LICENSE_EXPIRED', 'License has expired', { payload: parsed.payload, expiredAt: parsed.payload.expiresAt });
  if (options.lastTrustedSeenAt && nowSeconds < options.lastTrustedSeenAt - (options.rollbackToleranceSeconds || 300)) {
    return typed('LICENSE_CLOCK_ROLLBACK', 'System clock appears to have moved backwards', { payload: parsed.payload, lastTrustedSeenAt: options.lastTrustedSeenAt, nowSeconds });
  }
  return { ok: true, active: true, payload: parsed.payload, license };
}

module.exports = { PREFIX, PRODUCT, GAME_PRODUCTS, LEGACY_GAME_PRODUCT, effectiveGameProduct, effectiveSigningKeyId, verifyLicense, parseLicense, validatePayloadShape };
