'use strict';

const crypto = require('node:crypto');
const { canonicalJson, fromBase64url } = require('./canonical-json.cjs');
const { PUBLIC_KEY_PEM } = require('./public-key.cjs');

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

function validatePayloadShape(payload, nowSeconds) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'LICENSE_INVALID_FORMAT';
  if (!SUPPORTED_SCHEMAS.has(payload.v)) return 'LICENSE_INVALID_FORMAT';
  if (payload.product !== PRODUCT) return 'LICENSE_WRONG_PRODUCT';
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

  let canonical;
  try { canonical = canonicalJson(parsed.payload); } catch { return typed('LICENSE_INVALID_FORMAT', 'License payload is not canonical JSON'); }
  const canonicalPayload = Buffer.from(canonical, 'utf8');
  if (!crypto.verify(null, canonicalPayload, options.publicKeyPem || PUBLIC_KEY_PEM, parsed.signature)) {
    return typed('LICENSE_BAD_SIGNATURE', 'License signature is invalid', { payload: parsed.payload });
  }
  if (parsed.payloadRaw.toString('utf8') !== canonical) return typed('LICENSE_BAD_SIGNATURE', 'License payload has been modified', { payload: parsed.payload });
  if (parsed.payload.machineId !== options.machineId) {
    return typed('LICENSE_MACHINE_MISMATCH', 'License does not match this device', { payload: parsed.payload, licenseMachineId: parsed.payload.machineId, currentMachineId: options.machineId });
  }
  if (nowSeconds > parsed.payload.expiresAt) return typed('LICENSE_EXPIRED', 'License has expired', { payload: parsed.payload, expiredAt: parsed.payload.expiresAt });
  if (options.lastTrustedSeenAt && nowSeconds < options.lastTrustedSeenAt - (options.rollbackToleranceSeconds || 300)) {
    return typed('LICENSE_CLOCK_ROLLBACK', 'System clock appears to have moved backwards', { payload: parsed.payload, lastTrustedSeenAt: options.lastTrustedSeenAt, nowSeconds });
  }
  return { ok: true, active: true, payload: parsed.payload, license };
}

module.exports = { PREFIX, PRODUCT, verifyLicense, parseLicense, validatePayloadShape };
