'use strict';

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { randomBytes, sign } = crypto;
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');
const { TrustedTimeProvider } = require('../../desktop/licensing/trusted-time.cjs');
const { parseLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { PLAN_PRESETS, PLANS, GAME_PRODUCTS, buildLicensePayloadV2, validateEntitlementInput, normalizeEntitlement } = require('../../desktop/licensing/entitlements.cjs');
const { resolveExpiresAt, formatUtcPlus7 } = require('./duration.cjs');
const { PLAN_UI_DEFAULTS } = require('./plan-ui-defaults.cjs');
const { resolveSellerResources } = require('./seller-resources.cjs');
const { loadServiceAccount, GoogleSheetClient, trySaveRecord } = require('./google-sheet.cjs');
let PUBLIC_KEY_PEM = null;
try { PUBLIC_KEY_PEM = require('../../desktop/licensing/public-key.cjs').PUBLIC_KEY_PEM; } catch { /* optional */ }

let win;
const trustedTime = new TrustedTimeProvider();

// ---- self-contained seller resource resolution (signing key + Google cred) ----
// Packaged: bundled under process.resourcesPath/private. Dev: generator source dir,
// with optional env overrides. The renderer NEVER sees any of these paths/secrets.
function sellerResources() {
  return resolveSellerResources({
    isPackaged: !!(app && app.isPackaged),
    resourcesPath: process.resourcesPath,
    dirname: __dirname,
    env: process.env,
  });
}

function readPrivateKey() {
  const direct = process.env.WVPT_PRIVATE_KEY; // dev/CI inline override only
  if (direct) return direct.replace(/\\n/g, '\n');
  const p = sellerResources().privateKeyPath;
  if (!p || !fs.existsSync(p)) throw new Error(`Private key not found: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

function signingReady() {
  if (process.env.WVPT_PRIVATE_KEY) return true;
  const p = sellerResources().privateKeyPath;
  return !!(p && fs.existsSync(p));
}

// ---- Google Sheet client (seller-side; lazy; credentials never cross IPC) ----
let sheetClient = null;
let sheetClientCredPath = null;

function resolveCred() {
  const p = sellerResources().googleCredentialPath;
  return p && fs.existsSync(p) ? p : null;
}
// Returns a ready client or null (not configured). Throws only on a bad credential file.
function getSheetClient() {
  const p = resolveCred();
  if (!p) return null;
  if (sheetClient && sheetClientCredPath === p) return sheetClient;
  const sa = loadServiceAccount(p); // may throw GOOGLE_CREDENTIAL_*
  const { spreadsheetId, sheetId } = sellerResources();
  sheetClient = new GoogleSheetClient({ serviceAccount: sa, spreadsheetId, sheetId });
  sheetClientCredPath = p;
  return sheetClient;
}
function credentialEmail(p) {
  try { return loadServiceAccount(p).client_email || null; } catch { return null; }
}

function normalizeMachineId(input) {
  const machineId = String(input || '').trim().toUpperCase();
  if (!/^WVPT-PC-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(machineId)) {
    throw new Error('Machine ID format must be WVPT-PC-XXXX-XXXX-XXXX-XXXX');
  }
  return machineId;
}

async function trustedIssuedAt() {
  if (process.env.WVPT_TRUSTED_TIME_MS && Number.isFinite(Number(process.env.WVPT_TRUSTED_TIME_MS))) {
    return Math.floor(Number(process.env.WVPT_TRUSTED_TIME_MS) / 1000);
  }
  const result = await trustedTime.now();
  if (!result.ok) throw new Error('Cannot verify trusted UTC+7 time. Check internet connection and try again.');
  return Math.floor(result.nowMs / 1000);
}

// Accept the GUI duration spec ({ unit:'days'|'months'|'custom', value/expires }).
// Falls back to the legacy { mode, durationDays, expires } shape for safety.
function durationSpecFrom(input) {
  if (input && input.duration && typeof input.duration === 'object') return input.duration;
  if (input && input.mode === 'custom') return { unit: 'custom', expires: input.expires };
  return { unit: 'days', value: Number(input && input.durationDays || 30) };
}

async function buildPayload(input) {
  const issuedAt = await trustedIssuedAt();
  const expiresAt = resolveExpiresAt(issuedAt, durationSpecFrom(input));
  if (!Number.isInteger(expiresAt) || expiresAt <= issuedAt) throw new Error('Ngày hết hạn phải ở tương lai.');
  const machineId = normalizeMachineId(input.machineId);
  const licenseId = 'LIC-' + randomBytes(4).toString('hex').toUpperCase();

  // Legacy schema v1 (kept for compatibility).
  if (Number(input.schema) === 1) {
    const maxLaunches = input.maxLaunches ? Number(input.maxLaunches) : null;
    if (maxLaunches != null && (!Number.isInteger(maxLaunches) || maxLaunches < 1 || maxLaunches > 1000000)) throw new Error('Số lần chạy phải từ 1 đến 1000000.');
    return { v: 1, product: 'WVPT', machineId, issuedAt, expiresAt, ...(maxLaunches ? { maxLaunches } : {}), licenseId };
  }

  // Schema v2 — signed plan / capacities / features. Plan is a preset only; the seller
  // may override before signing. validateEntitlementInput enforces the dependency.
  const plan = String(input.plan || 'STANDARD').toUpperCase();
  if (!PLANS.includes(plan)) throw new Error('Gói bản quyền không hợp lệ.');
  const preset = PLAN_PRESETS[plan];
  const maxBrowsers = Number(input.maxBrowsers != null ? input.maxBrowsers : preset.maxBrowsers);
  const maxConcurrentBrowsers = Number(input.maxConcurrentBrowsers != null ? input.maxConcurrentBrowsers : preset.maxConcurrentBrowsers);
  const features = input.features && typeof input.features === 'object' ? input.features : preset.features;
  const check = validateEntitlementInput({ plan, maxBrowsers, maxConcurrentBrowsers, features });
  if (!check.ok) throw new Error(check.errors.map((e) => e.message).join(' '));
  // Signed game entitlement (§5). The seller must pick a game; default AVIATOR keeps
  // existing UX but every NEW v2 key now carries a signed gameProduct.
  const gameProduct = String(input.gameProduct || 'AVIATOR').toUpperCase();
  if (!GAME_PRODUCTS.includes(gameProduct)) throw new Error('Quyền game không hợp lệ (AVIATOR/PHOM/ALL).');
  return buildLicensePayloadV2({ machineId, plan, issuedAt, expiresAt, maxBrowsers, maxConcurrentBrowsers, features, licenseId, gameProduct });
}

function createLicense(payload) {
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), readPrivateKey());
  return `WVPT1.${base64url(canonical)}.${base64url(signature)}`;
}

// Signature-verifying inspector. Verifies with the public key that matches the loaded
// signing key (round-trip), falling back to the bundled Control public key. Requires
// NO manual key selection — resolved automatically from bundled resources.
function inspectLicense(license) {
  let parsed;
  try { parsed = parseLicense(license); } catch { return { ok: false, error: 'Định dạng khóa không hợp lệ.' }; }
  let publicKey = PUBLIC_KEY_PEM;
  try { publicKey = crypto.createPublicKey(readPrivateKey()).export({ type: 'spki', format: 'pem' }); } catch { /* use bundled public key */ }
  const canonical = canonicalJson(parsed.payload);
  const canonicalOk = parsed.payloadRaw.toString('utf8') === canonical;
  let signatureValid = false;
  try { signatureValid = canonicalOk && !!publicKey && crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKey, parsed.signature); } catch { signatureValid = false; }
  return { ok: true, signatureValid, payload: parsed.payload, entitlement: normalizeEntitlement(parsed.payload) };
}

// ---- Google Sheet save (idempotent by licenseId). Never throws to the caller;
// a Google failure NEVER destroys the already-created license. ----
async function saveRecordToSheet(record) {
  let client;
  try { client = getSheetClient(); }
  catch (e) { return { synced: false, error: { code: e.code || 'GOOGLE_CREDENTIAL_ERROR', message: e.message } }; }
  return trySaveRecord(client, record);
}

function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 860,
    minWidth: 720,
    minHeight: 620,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'ui.html'));
}

// ---- IPC: only SAFE state/operations. No secret paths or key material cross here. ----
ipcMain.handle('signing-status', () => ({ ready: signingReady() }));

ipcMain.handle('generate-license', async (_event, input) => {
  try {
    const payload = await buildPayload(input || {});
    const license = createLicense(payload);
    const metadata = {
      customerName: (input && input.customerName) || '',
      phone: (input && input.phone) || '',
      note: (input && input.note) || '',
      createdAt: new Date().toISOString(), // management timestamp; fixed for retries
    };
    const record = { payload, license, metadata };
    // License is CREATED regardless of Google outcome. Attempt the ledger save now.
    const sheet = await saveRecordToSheet(record);
    return { ok: true, payload, license, metadata, sheet };
  } catch (error) {
    return { ok: false, error: { code: 'LICENSE_GENERATE_FAILED', message: String(error && error.message || error) } };
  }
});

// Retry / explicit sync of an ALREADY-generated license — no regeneration. Same
// licenseId => idempotent upsert => never a duplicate row.
ipcMain.handle('sheet-sync', async (_event, record) => saveRecordToSheet(record));

ipcMain.handle('inspect-license', (_event, license) => {
  try { return inspectLicense(String(license || '')); }
  catch (error) { return { ok: false, error: String(error && error.message || error) }; }
});

ipcMain.handle('plan-presets', () => PLAN_PRESETS);
ipcMain.handle('plan-defaults', () => PLAN_UI_DEFAULTS);

// Expiry preview: exact when trusted time is cached, otherwise a clearly-flagged
// estimate from local time (the SIGNED value always uses trusted time at generate).
ipcMain.handle('preview-expiry', (_event, input) => {
  let issuedAt;
  let estimated = false;
  const cached = trustedTime.cachedNowMs();
  if (process.env.WVPT_TRUSTED_TIME_MS && Number.isFinite(Number(process.env.WVPT_TRUSTED_TIME_MS))) {
    issuedAt = Math.floor(Number(process.env.WVPT_TRUSTED_TIME_MS) / 1000);
  } else if (cached != null) {
    issuedAt = Math.floor(cached / 1000);
  } else {
    issuedAt = Math.floor(Date.now() / 1000);
    estimated = true;
  }
  try {
    const expiresAt = resolveExpiresAt(issuedAt, (input && input.duration) || { unit: 'days', value: 30 });
    return { ok: true, issuedAt, expiresAt, estimated, issuedText: formatUtcPlus7(issuedAt), expiresText: formatUtcPlus7(expiresAt) };
  } catch (e) {
    return { ok: false, estimated, error: { message: e.message } };
  }
});

// Google Sheet connection status (auto-resolved; no private_key ever leaves main).
ipcMain.handle('sheet-status', async () => {
  const p = resolveCred();
  if (!p) return { configured: false, state: 'disconnected' };
  let client;
  try { client = getSheetClient(); }
  catch (e) { return { configured: true, state: 'error', error: { code: e.code || 'GOOGLE_CREDENTIAL_ERROR', message: e.message } }; }
  try {
    const ping = await client.ping();
    return { configured: true, state: 'connected', email: ping.email, spreadsheetTitle: ping.spreadsheetTitle, sheetTitle: ping.sheetTitle };
  } catch (e) {
    return { configured: true, state: 'error', email: credentialEmail(p), error: { code: e.code || 'GOOGLE_ERROR', message: e.message } };
  }
});

ipcMain.handle('copy', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

app.whenReady().then(() => {
  createWindow();
  // Warm the trusted-time cache so expiry previews become exact quickly.
  trustedTime.now().catch(() => {});
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
