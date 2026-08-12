'use strict';

// Tier 2 — releases the module-sealing key ONLY for a license whose signature
// verifies for this machine. Time/expiry are deliberately NOT checked here: those
// are enforced by the runtime license gate (Tier 1). Decryption answers a narrower
// question — "is this a genuine license issued for THIS device?" — so that a valid
// customer can always load the code while a no-license attacker who merely flips the
// renderer's active flag gets null (the crown-jewel modules never materialise).
const crypto = require('node:crypto');
const { canonicalJson } = require('./canonical-json.cjs');
const { parseLicense, PRODUCT } = require('./license-verifier.cjs');
const { PUBLIC_KEY_PEM } = require('./public-key.cjs');
const { deriveSealKey } = require('./seal-secret.cjs');

function deriveFeatureKey({ license, machineId, publicKeyPem = PUBLIC_KEY_PEM } = {}) {
  if (!license || !machineId) return null;
  let parsed;
  try { parsed = parseLicense(license); } catch { return null; }
  const payload = parsed.payload;
  if (!payload || payload.product !== PRODUCT) return null;
  if (payload.machineId !== machineId) return null;
  let canonical;
  try { canonical = canonicalJson(payload); } catch { return null; }
  if (parsed.payloadRaw.toString('utf8') !== canonical) return null;
  if (!crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKeyPem, parsed.signature)) return null;
  return deriveSealKey(publicKeyPem);
}

module.exports = { deriveFeatureKey };
