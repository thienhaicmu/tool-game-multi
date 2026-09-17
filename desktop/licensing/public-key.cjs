'use strict';

// ---------------------------------------------------------------------------
// Signing-key REGISTRY (public keys only — NEVER a private key). Each game product
// has its OWN Ed25519 keypair so a PHOM key can never verify as an Aviator key and
// vice-versa (§5/§6):
//   - AVIATOR_V1 : the ORIGINAL Aviator key. It also verifies LEGACY keys (which carry
//                  no signingKeyId / no gameProduct) so already-sold Aviator licenses
//                  keep working unchanged.
//   - PHOM_V1    : a NEW keypair dedicated to Phỏm QA.
// Private halves live only in the gitignored tools/license-generator/private/ dir and
// the INTERNAL seller Generator package — never in any customer app (see
// tools/license-generator/seller-resources.cjs for that trust model).
//
// Verification resolves the license's signed `signingKeyId` to a public key here, then
// checks that key id is ALLOWED for the license's gameProduct (PRODUCT_KEY_IDS).
// ---------------------------------------------------------------------------

// The original Aviator public key (unchanged — do NOT rotate; legacy keys depend on it).
const AVIATOR_V1_PUBLIC = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYjszulji4WVzmTbVDrP+MODHbyB+tHv8D5UMTm+yozw=
-----END PUBLIC KEY-----`;

// The new Phỏm public key (private half is generator-local only, never committed/shipped).
const PHOM_V1_PUBLIC = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzBqfLUCeQUUS2Ip2It22Fm2X3h4gDrmlkhSmeYx4XyQ=
-----END PUBLIC KEY-----`;

const SIGNING_KEYS = Object.freeze({
  AVIATOR_V1: AVIATOR_V1_PUBLIC,
  PHOM_V1: PHOM_V1_PUBLIC,
});

// A license with NO signingKeyId predates the split — it is a legacy Aviator key and is
// verified with the Aviator key (legacy policy §10).
const LEGACY_DEFAULT_KEY_ID = 'AVIATOR_V1';

// Which signing key id(s) may sign a given gameProduct. Isolation is enforced BOTH by the
// distinct keypair (signature) AND by this allow-list (a crafted keyId can't cross over).
const PRODUCT_KEY_IDS = Object.freeze({
  AVIATOR: Object.freeze(['AVIATOR_V1']),
  PHOM: Object.freeze(['PHOM_V1']),
});

// The default signing key id the generator uses per product (its PRIVATE half must be
// configured on the generator machine — never here).
const PRODUCT_DEFAULT_KEY_ID = Object.freeze({ AVIATOR: 'AVIATOR_V1', PHOM: 'PHOM_V1' });

function publicKeyForId(id) { return SIGNING_KEYS[id] || null; }

// Backward-compatible single-key export (the Aviator key) — kept so existing callers and
// tests that pass a single publicKeyPem override continue to work.
const PUBLIC_KEY_PEM = AVIATOR_V1_PUBLIC;

module.exports = {
  PUBLIC_KEY_PEM,
  SIGNING_KEYS, LEGACY_DEFAULT_KEY_ID, PRODUCT_KEY_IDS, PRODUCT_DEFAULT_KEY_ID,
  publicKeyForId,
};
