'use strict';

// ---------------------------------------------------------------------------
// resolveSellerResources() — deterministic, PURE resolution of the seller-only
// Generator resources (signing key + Google credential + fixed ledger config).
//
// This is the single source of truth for WHERE the private signing key and the
// Google Service Account credential live, in BOTH modes:
//   - Packaged seller app: bundled under process.resourcesPath/private/ (shipped
//     by electron-builder extraResources — seller-only, never in Control).
//   - Development: the same layout under the generator source dir, with optional
//     env overrides (WVPT_PRIVATE_KEY_PATH / WVPT_GOOGLE_SERVICE_ACCOUNT).
//
// It is PURE (no fs, no electron): given inputs it returns absolute paths, so the
// packaged-vs-dev resolution is unit-testable with fixtures. The main process does
// the actual (secret) file reads; the renderer only ever sees ready/not-ready.
// ---------------------------------------------------------------------------

const path = require('node:path');
const { SPREADSHEET_ID, SHEET_ID } = require('./google-sheet.cjs');
const { resolveLedgerConfig } = require('../../desktop/licensing/license-ledger.cjs');

const PRIVATE_KEY_FILE = 'wvpt-ed25519-private.pem';        // AVIATOR (legacy) private key
const PHOM_PRIVATE_KEY_FILE = 'phom-ed25519-private.pem';   // PHOM private key (new)
const GOOGLE_CREDENTIAL_FILE = 'google-service-account.json';

function resolveSellerResources({ isPackaged = false, resourcesPath = '', dirname = '', env = {} } = {}) {
  // Bundled base: packaged resources vs the generator source dir in dev.
  const base = isPackaged ? resourcesPath : dirname;
  const bundledPrivateKey = path.join(base, 'private', PRIVATE_KEY_FILE);
  const bundledPhomKey = path.join(base, 'private', PHOM_PRIVATE_KEY_FILE);
  const bundledGoogle = path.join(base, 'private', GOOGLE_CREDENTIAL_FILE);

  // env overrides apply to DEV only — packaged production must never depend on them.
  const privateKeyPath = (!isPackaged && (env.AVIATOR_LICENSE_PRIVATE_KEY_PATH || env.WVPT_PRIVATE_KEY_PATH)) ? (env.AVIATOR_LICENSE_PRIVATE_KEY_PATH || env.WVPT_PRIVATE_KEY_PATH) : bundledPrivateKey;
  const phomPrivateKeyPath = (!isPackaged && env.PHOM_LICENSE_PRIVATE_KEY_PATH) ? env.PHOM_LICENSE_PRIVATE_KEY_PATH : bundledPhomKey;
  const googleCredentialPath = (!isPackaged && (env.GOOGLE_APPLICATION_CREDENTIALS || env.WVPT_GOOGLE_SERVICE_ACCOUNT)) ? (env.GOOGLE_APPLICATION_CREDENTIALS || env.WVPT_GOOGLE_SERVICE_ACCOUNT) : bundledGoogle;

  const led = resolveLedgerConfig(env);
  return {
    base,
    // AVIATOR keeps the legacy path name for back-compat; PHOM has its own key.
    privateKeyPath,
    aviatorPrivateKeyPath: privateKeyPath,
    phomPrivateKeyPath,
    googleCredentialPath,
    // Non-secret local credential fallback (§13 priority 3), resolved by the caller with fs.
    localCredentialPath: led.localCredentialPath || null,
    inlinePrivateKeyEnv: !isPackaged && (env.AVIATOR_LICENSE_PRIVATE_KEY || env.WVPT_PRIVATE_KEY) ? true : false,
    spreadsheetId: led.spreadsheetId || SPREADSHEET_ID,
    sheetId: SHEET_ID,
    aviatorSheetName: led.aviatorSheetName,
    phomSheetName: led.phomSheetName,
    serviceAccountEmail: led.serviceAccountEmail,
  };
}

// The private key path for a specific product (§5/§8) — never the other product's key.
function privateKeyPathForProduct(res, gameProduct) {
  return String(gameProduct || 'AVIATOR').toUpperCase() === 'PHOM' ? res.phomPrivateKeyPath : res.aviatorPrivateKeyPath;
}
// The destination worksheet title for a product (§16).
function sheetTitleForProduct(res, gameProduct) {
  return String(gameProduct || 'AVIATOR').toUpperCase() === 'PHOM' ? res.phomSheetName : res.aviatorSheetName;
}

module.exports = { resolveSellerResources, privateKeyPathForProduct, sheetTitleForProduct, PRIVATE_KEY_FILE, PHOM_PRIVATE_KEY_FILE, GOOGLE_CREDENTIAL_FILE };
