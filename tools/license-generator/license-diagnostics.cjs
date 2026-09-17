'use strict';

// ---------------------------------------------------------------------------
// Operator activation diagnostics (PURE). Explains, step by step, why a license
// would or would not activate in a given game — WITHOUT a second verification
// implementation: the per-step rows are explanatory, and the FINAL result is always the
// runtime `verifyLicense` with the target app's `expectedGameProduct`, so the diagnosis
// cannot disagree with PHỎM / AVIATOR.
//
// Output never contains key material. The machine id is shown as a masked reference
// plus a short hash (the operator already has the full id from the customer).
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const { canonicalJson } = require('../../desktop/licensing/canonical-json.cjs');
const {
  parseLicense, validatePayloadShape, verifyLicense, effectiveGameProduct, effectiveSigningKeyId, GAME_PRODUCTS,
} = require('../../desktop/licensing/license-verifier.cjs');
const { SIGNING_KEYS, PRODUCT_KEY_IDS } = require('../../desktop/licensing/public-key.cjs');

const DAY = 86400;

function machineRef(machineId) {
  const id = String(machineId || '');
  if (!id) return '—';
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
  return `…${id.slice(-4)} #${hash}`;
}

function step(id, label, ok, detail) { return { id, label, ok, detail: detail || '' }; }

// options: { expectedGame (required), machineId (optional), nowMs (required), signingKeys, productKeyIds }
function diagnoseLicense(token, options = {}) {
  const expected = String(options.expectedGame || '').toUpperCase();
  const nowMs = Number(options.nowMs);
  const signingKeys = options.signingKeys || SIGNING_KEYS;
  const productKeyIds = options.productKeyIds || PRODUCT_KEY_IDS;
  const steps = [];
  const finish = (code) => ({ ok: code === null, result: code === null ? 'VALID' : 'INVALID', code, expectedGame: expected, steps });

  if (!GAME_PRODUCTS.has(expected)) return { ...finish('LICENSE_GAME_PRODUCT_INVALID'), steps: [step('target', 'Game kiểm tra', false, 'Chọn PHOM hoặc AVIATOR')] };

  let parsed;
  try { parsed = parseLicense(token); } catch { steps.push(step('format', 'Định dạng', false, 'Không phải token WVPT1 hợp lệ')); return finish('LICENSE_INVALID_FORMAT'); }
  const p = parsed.payload || {};
  steps.push(step('format', 'Định dạng', true, 'WVPT1'));
  steps.push(step('licenseId', 'License ID', !!p.licenseId, p.licenseId || 'thiếu'));
  steps.push(step('version', 'Phiên bản', p.v === 1 || p.v === 2, p.v != null ? `v${p.v}` : 'thiếu'));

  // Game discriminator (signed). Missing = legacy AVIATOR-only license.
  let gameDetail;
  if (p.gameProduct === undefined) gameDetail = `thiếu game (license cũ → chỉ AVIATOR)`;
  else if (!GAME_PRODUCTS.has(p.gameProduct)) gameDetail = `game không hợp lệ: ${String(p.gameProduct)}`;
  const licensed = p.gameProduct === undefined || GAME_PRODUCTS.has(p.gameProduct) ? effectiveGameProduct(p) : null;
  const gameOk = licensed === expected && !(expected === 'PHOM' && p.gameProduct === undefined);
  if (!gameDetail) gameDetail = gameOk ? expected : `cần ${expected}, license là ${licensed}`;
  else if (licensed && !gameOk) gameDetail += ` · cần ${expected}`;

  // Signature (key id resolved from the signed payload, then allowed-for-game check).
  const keyId = effectiveSigningKeyId(p);
  const pub = signingKeys[keyId];
  let sigOk = false;
  let sigDetail;
  if (!pub) sigDetail = `key id không xác định: ${keyId}`;
  else {
    try {
      const canonical = canonicalJson(p);
      sigOk = parsed.payloadRaw.toString('utf8') === canonical && crypto.verify(null, Buffer.from(canonical, 'utf8'), pub, parsed.signature);
    } catch { sigOk = false; }
    sigDetail = sigOk ? keyId : `không khớp ${keyId}`;
    if (sigOk && licensed && !((productKeyIds[licensed] || []).includes(keyId))) { sigOk = false; sigDetail = `${keyId} không được phép ký ${licensed}`; }
  }
  steps.push(step('signature', 'Chữ ký', sigOk, sigDetail));
  steps.push(step('game', 'Game', gameOk, gameDetail));

  // Machine binding (skipped when the operator did not enter the customer's id).
  const machineGiven = !!String(options.machineId || '').trim();
  const machineId = machineGiven ? String(options.machineId).trim().toUpperCase() : p.machineId;
  if (machineGiven) steps.push(step('machine', 'Máy', p.machineId === machineId, p.machineId === machineId ? machineRef(p.machineId) : `license ${machineRef(p.machineId)} ≠ ${machineRef(machineId)}`));
  else steps.push(step('machine', 'Máy', null, `${machineRef(p.machineId)} (chưa nhập Machine ID để so)`));

  // Expiration.
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Number.isInteger(p.expiresAt) && Number.isFinite(nowMs)) {
    const days = Math.ceil((p.expiresAt - nowSeconds) / DAY);
    steps.push(step('expiration', 'Hạn dùng', nowSeconds <= p.expiresAt, nowSeconds <= p.expiresAt ? `còn ${days} ngày` : `đã hết hạn ${-days} ngày`));
  } else steps.push(step('expiration', 'Hạn dùng', false, 'không đọc được'));

  // Plan + capacities (schema shape).
  const shape = Number.isFinite(nowMs) ? validatePayloadShape(p, nowSeconds) : 'TRUSTED_TIME_UNAVAILABLE';
  const planDetail = p.v === 2 ? `${p.plan} · ${p.maxBrowsers} profiles / ${p.maxConcurrentBrowsers} browsers` : 'LEGACY';
  steps.push(step('plan', 'Gói / giới hạn', shape === null, shape === null ? planDetail : shape));

  // Final: the exact runtime decision for the target app.
  const verdict = verifyLicense(token, { machineId, nowMs, expectedGameProduct: expected, signingKeys, productKeyIds });
  return finish(verdict.ok ? null : verdict.error.code);
}

module.exports = { diagnoseLicense, machineRef };
