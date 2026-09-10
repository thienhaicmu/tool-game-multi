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

const PRIVATE_KEY_FILE = 'wvpt-ed25519-private.pem';
const GOOGLE_CREDENTIAL_FILE = 'google-service-account.json';

function resolveSellerResources({ isPackaged = false, resourcesPath = '', dirname = '', env = {} } = {}) {
  // Bundled base: packaged resources vs the generator source dir in dev.
  const base = isPackaged ? resourcesPath : dirname;
  const bundledPrivateKey = path.join(base, 'private', PRIVATE_KEY_FILE);
  const bundledGoogle = path.join(base, 'private', GOOGLE_CREDENTIAL_FILE);

  // env overrides apply to DEV only — packaged production must never depend on them.
  const privateKeyPath = (!isPackaged && env.WVPT_PRIVATE_KEY_PATH) ? env.WVPT_PRIVATE_KEY_PATH : bundledPrivateKey;
  const googleCredentialPath = (!isPackaged && env.WVPT_GOOGLE_SERVICE_ACCOUNT) ? env.WVPT_GOOGLE_SERVICE_ACCOUNT : bundledGoogle;

  return {
    base,
    privateKeyPath,
    googleCredentialPath,
    // Inline private key content override (dev/CI only); resolved by the caller.
    inlinePrivateKeyEnv: !isPackaged && env.WVPT_PRIVATE_KEY ? true : false,
    spreadsheetId: SPREADSHEET_ID,
    sheetId: SHEET_ID,
  };
}

module.exports = { resolveSellerResources, PRIVATE_KEY_FILE, GOOGLE_CREDENTIAL_FILE };
