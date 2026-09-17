'use strict';

// ---------------------------------------------------------------------------
// Game-scoped license signing core (PURE — no electron, no fs, no network).
//
//   buildGamePayload   game config + seller input -> exact schema-v2 payload. The game
//                      (`gameProduct`) and its signing key id are written INTO the payload
//                      before signing, so the signature covers them.
//   assertKeyForGame   the private key must derive the public key the runtime registry
//                      holds for that game's key id — an AVIATOR license can never be
//                      signed with the PHOM key (or any stray key) by misconfiguration.
//   issueLicense       build -> key check -> sign -> self-verify with the SAME runtime
//                      verifier + expectedGameProduct the target app uses. A token that
//                      would not activate in its own game is never returned.
//
// Private key material is only ever passed in; it is never logged, returned or embedded
// in an error message.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');
const { verifyLicense, PREFIX } = require('../../desktop/licensing/license-verifier.cjs');
const { buildLicensePayloadV2, validateEntitlementInput } = require('../../desktop/licensing/entitlements.cjs');
const { SIGNING_KEYS } = require('../../desktop/licensing/public-key.cjs');
const { resolveExpiresAt } = require('./duration.cjs');
const { gameConfig, planConfig, isDurationAllowed, signedFeaturesFor } = require('./game-configs.cjs');

const MACHINE_ID_RE = /^WVPT-PC-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/;

function typedError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail) e.detail = detail;
  return e;
}

function normalizeMachineId(input) {
  const machineId = String(input || '').trim().toUpperCase();
  if (!MACHINE_ID_RE.test(machineId)) throw typedError('LICENSE_MACHINE_ID_INVALID', 'Machine ID phải có dạng WVPT-PC-XXXX-XXXX-XXXX-XXXX.');
  return machineId;
}

function newLicenseId() {
  return 'LIC-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

// input: { game, machineId, plan, duration, maxBrowsers, maxConcurrentBrowsers, features }
function buildGamePayload(input = {}, { issuedAt, licenseId = newLicenseId() } = {}) {
  if (input.game == null || input.game === '') throw typedError('LICENSE_GAME_PRODUCT_REQUIRED', 'Hãy chọn game (PHỎM hoặc AVIATOR).');
  const cfg = gameConfig(input.game);
  if (!cfg) throw typedError('LICENSE_GAME_PRODUCT_INVALID', `Game không được hỗ trợ: ${String(input.game)}`);
  const plan = planConfig(cfg.game, input.plan);
  if (!plan) throw typedError('INVALID_PLAN', `Gói không hợp lệ cho ${cfg.label}.`);
  if (!Number.isInteger(issuedAt) || issuedAt <= 0) throw typedError('TRUSTED_TIME_UNAVAILABLE', 'Thiếu thời gian tin cậy để ký.');
  const machineId = normalizeMachineId(input.machineId);

  const duration = input.duration || { unit: 'months', value: 1 };
  if (!isDurationAllowed(cfg.game, duration)) throw typedError('INVALID_DURATION', `Thời hạn không hợp lệ cho ${cfg.label}.`);
  const expiresAt = resolveExpiresAt(issuedAt, duration);
  if (!Number.isInteger(expiresAt) || expiresAt <= issuedAt) throw typedError('INVALID_DURATION', 'Ngày hết hạn phải ở tương lai.');

  const maxBrowsers = Number(input.maxBrowsers != null ? input.maxBrowsers : plan.capacities.maxBrowsers);
  const maxConcurrentBrowsers = Number(input.maxConcurrentBrowsers != null ? input.maxConcurrentBrowsers : plan.capacities.maxConcurrentBrowsers);
  const features = signedFeaturesFor(cfg.game, input.features != null ? input.features : plan.features);
  const check = validateEntitlementInput({ plan: plan.id, maxBrowsers, maxConcurrentBrowsers, features });
  if (!check.ok) throw typedError(check.errors[0].code, check.errors.map((e) => e.message).join(' '));

  return buildLicensePayloadV2({
    machineId, plan: plan.id, issuedAt, expiresAt, maxBrowsers, maxConcurrentBrowsers, features, licenseId,
    gameProduct: cfg.game, signingKeyId: cfg.signingKeyId,
  });
}

function spkiOf(key) {
  return crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
}

// Throws unless privateKeyPem is the private half of the registry key for this game.
function assertKeyForGame(game, privateKeyPem, { signingKeys = SIGNING_KEYS } = {}) {
  const cfg = gameConfig(game);
  if (!cfg) throw typedError('LICENSE_GAME_PRODUCT_INVALID', `Game không được hỗ trợ: ${String(game)}`);
  const expectedPublic = signingKeys[cfg.signingKeyId];
  if (!expectedPublic) throw typedError('LICENSE_SIGNING_KEY_ID_INVALID', `Không có public key ${cfg.signingKeyId} trong registry.`);
  let derived;
  try { derived = spkiOf(crypto.createPrivateKey(privateKeyPem)); }
  catch { throw typedError('LICENSE_PRIVATE_KEY_LOAD_FAILED', `Private key của ${cfg.label} không đọc được.`); }
  if (derived !== spkiOf(expectedPublic)) {
    throw typedError('LICENSE_SIGNING_KEY_MISMATCH', `Private key đã cấu hình không khớp public key ${cfg.signingKeyId} của ${cfg.label}.`);
  }
  return cfg.signingKeyId;
}

function signPayload(payload, privateKeyPem) {
  const canonical = canonicalJson(payload);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
  return `${PREFIX}.${base64url(canonical)}.${base64url(signature)}`;
}

// Full issue path. `privateKeyForGame(game)` supplies the key (throws typed if absent).
function issueLicense(input, { issuedAt, privateKeyForGame, licenseId, signingKeys = SIGNING_KEYS } = {}) {
  const payload = buildGamePayload(input, { issuedAt, licenseId });
  const privateKeyPem = privateKeyForGame(payload.gameProduct);
  assertKeyForGame(payload.gameProduct, privateKeyPem, { signingKeys });
  const license = signPayload(payload, privateKeyPem);
  const self = verifyLicense(license, { machineId: payload.machineId, nowMs: issuedAt * 1000, expectedGameProduct: payload.gameProduct, signingKeys });
  if (!self.ok) throw typedError('LICENSE_SELF_VERIFY_FAILED', `License vừa ký không qua được kiểm tra của ${payload.gameProduct}.`, self.error && self.error.code);
  return { payload, license };
}

module.exports = { buildGamePayload, assertKeyForGame, signPayload, issueLicense, normalizeMachineId, newLicenseId, MACHINE_ID_RE };
