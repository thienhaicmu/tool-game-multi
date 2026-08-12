'use strict';

// Tier 2 sealed-module loader. The crown-jewel protocol modules are shipped as
// AES-256-GCM ciphertext (`<name>.cjs.enc`) with the plaintext `<name>.cjs` excluded
// from the packaged app. install() patches Module._load so that a require of a
// sealed path is decrypted in memory and compiled — the source never touches disk.
// Non-sealed siblings (e.g. environment-gate.cjs) and builtins fall through to the
// normal loader. In development (no `.enc` present) requires resolve to plaintext,
// so `npm start` needs no build step.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

// The protocol modules that get sealed. Shared by the build script and the runtime
// so both agree on exactly which files are ciphertext.
const SEALED_BASENAMES = Object.freeze(['aviator', 'harness', 'auto-runner', 'amount-validator', 'round-observer', 'protocol-context']);

const MAGIC = Buffer.from('WSL1', 'utf8'); // 4 bytes
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER = MAGIC.length + IV_LEN + TAG_LEN;

function seal(source, key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(source)), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]);
}

function unseal(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < HEADER || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Sealed module blob is malformed');
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, HEADER);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(HEADER)), decipher.final()]);
}

let installed = false;
let sealKey = null;
const sealedSet = new Set();
const cache = new Map();

function resolveSealed(request, parent) {
  if (typeof request !== 'string' || (!request.startsWith('.') && !path.isAbsolute(request))) return null;
  const base = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
  const abs = path.resolve(base, request);
  if (sealedSet.has(abs)) return abs;
  if (!abs.endsWith('.cjs') && sealedSet.has(abs + '.cjs')) return abs + '.cjs';
  return null;
}

function loadSealed(abs, parent) {
  const cached = cache.get(abs);
  if (cached) return cached.exports;
  const src = unseal(fs.readFileSync(abs + '.enc'), sealKey).toString('utf8');
  const m = new Module(abs, parent);
  m.filename = abs;
  m.paths = Module._nodeModulePaths(path.dirname(abs));
  cache.set(abs, m); // register before compile so import cycles resolve
  try { m._compile(src, abs); m.loaded = true; }
  catch (err) { cache.delete(abs); throw err; }
  return m.exports;
}

// Install the loader. `key` is the 32-byte seal key (from deriveFeatureKey); `files`
// are absolute paths to the sealed `.cjs` modules. Idempotent — later calls just
// refresh the key/file set. Interception only fires when the key is present AND the
// corresponding `.enc` exists, so development stays on plaintext.
function install({ key, files } = {}) {
  for (const f of files || []) sealedSet.add(path.resolve(f));
  if (key) sealKey = key;
  if (installed) return;
  installed = true;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const abs = resolveSealed(request, parent);
    // Intercept only when the sealed blob is the ONLY copy present: production ships
    // `.enc` with the plaintext excluded. In development the plaintext `.cjs` exists,
    // so we always prefer it (fresh source) and ignore any stale `.enc`.
    if (abs && sealKey && !fs.existsSync(abs) && fs.existsSync(abs + '.enc')) return loadSealed(abs, parent);
    return origLoad.apply(this, arguments);
  };
}

module.exports = { seal, unseal, install, SEALED_BASENAMES };
