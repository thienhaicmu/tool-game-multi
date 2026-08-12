'use strict';

// Tier 2 module-sealing secret. The protocol crown-jewel modules are shipped as
// AES-256-GCM ciphertext; this module derives the symmetric key used to seal them
// at build time and to unseal them at runtime. Build and runtime MUST derive the
// exact same key, so the derivation is deterministic: HKDF(PEPPER, salt=public key,
// info) -> 32 bytes.
//
// Honest limits (pure-JS tier): PEPPER is a build-time constant embedded in the
// shipped app. A determined reverse-engineer who reads this file can reconstruct
// the key and decrypt the modules. What this DOES buy: the modules are not readable
// as plaintext on disk (no casual copy), and — because feature-key.cjs only calls
// deriveSealKey() after a genuine signature+machine license check — merely flipping
// the renderer's "active" flag never materialises the code. Bytenode (a later tier)
// compiles this file to V8 bytecode to hide PEPPER and raise the bar further.
const crypto = require('node:crypto');
const { PUBLIC_KEY_PEM } = require('./public-key.cjs');

// Rotate this (and re-seal) to invalidate every previously-sealed build.
const PEPPER = Buffer.from('34d91ca19f253340703c51b4db3e9707d127c86768fd9aafc459b9e5163def8b', 'hex');
const INFO = Buffer.from('wvpt-module-seal-v1', 'utf8');

function deriveSealKey(publicKeyPem = PUBLIC_KEY_PEM) {
  const salt = crypto.createHash('sha256').update(String(publicKeyPem), 'utf8').digest();
  // HKDF-SHA256 -> 32-byte key. Available on all supported Node/Electron versions.
  return Buffer.from(crypto.hkdfSync('sha256', PEPPER, salt, INFO, 32));
}

module.exports = { deriveSealKey };
