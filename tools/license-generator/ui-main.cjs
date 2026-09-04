'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { randomBytes, sign } = crypto;
const { canonicalJson, base64url } = require('../../desktop/licensing/canonical-json.cjs');
const { TrustedTimeProvider } = require('../../desktop/licensing/trusted-time.cjs');
const { parseLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { PLAN_PRESETS, PLANS, buildLicensePayloadV2, validateEntitlementInput, normalizeEntitlement } = require('../../desktop/licensing/entitlements.cjs');
let PUBLIC_KEY_PEM = null;
try { PUBLIC_KEY_PEM = require('../../desktop/licensing/public-key.cjs').PUBLIC_KEY_PEM; } catch { /* optional */ }

let win;
let privateKeyPath = process.env.WVPT_PRIVATE_KEY_PATH || defaultPrivateKeyPath();
const trustedTime = new TrustedTimeProvider();

function defaultPrivateKeyPath() {
  if (app && app.isPackaged) return path.join(process.resourcesPath, 'private', 'wvpt-ed25519-private.pem');
  return path.join(__dirname, 'private', 'wvpt-ed25519-private.pem');
}

function readPrivateKey() {
  const direct = process.env.WVPT_PRIVATE_KEY;
  if (direct) return direct.replace(/\\n/g, '\n');
  if (!privateKeyPath || !fs.existsSync(privateKeyPath)) throw new Error(`Private key not found: ${privateKeyPath}`);
  return fs.readFileSync(privateKeyPath, 'utf8');
}

function utcDateSeconds(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ''))) throw new Error('Custom expiry must be YYYY-MM-DD');
  const ms = Date.parse(`${dateText}T00:00:00.000+07:00`);
  if (!Number.isFinite(ms)) throw new Error('Invalid expiry date');
  return Math.floor(ms / 1000);
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

async function buildPayload(input) {
  const issuedAt = await trustedIssuedAt();
  const mode = input.mode === 'custom' ? 'custom' : 'duration';
  const expiresAt = mode === 'custom'
    ? utcDateSeconds(input.expires)
    : issuedAt + Number(input.durationDays || 30) * 24 * 60 * 60;
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
  return buildLicensePayloadV2({ machineId, plan, issuedAt, expiresAt, maxBrowsers, maxConcurrentBrowsers, features, licenseId });
}

function createLicense(payload) {
  const canonical = canonicalJson(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), readPrivateKey());
  return `WVPT1.${base64url(canonical)}.${base64url(signature)}`;
}

// Signature-verifying inspector (§47/§48). Verifies with the public key that matches
// the loaded signing key (round-trip), falling back to the bundled public key. Reports
// exactly what the key grants — independent of the customer machine/expiry.
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

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 680,
    minHeight: 560,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'ui.html'));
}

ipcMain.handle('key-status', () => ({
  privateKeyPath,
  exists: !!(privateKeyPath && fs.existsSync(privateKeyPath)),
  envKey: !!process.env.WVPT_PRIVATE_KEY,
  packagedHint: app.isPackaged ? path.join(path.dirname(process.execPath), 'private', 'wvpt-ed25519-private.pem') : null,
}));

ipcMain.handle('choose-private-key', async () => {
  const choice = await dialog.showOpenDialog(win, {
    title: 'Select WVPT Ed25519 private key',
    filters: [{ name: 'PEM private key', extensions: ['pem'] }],
    properties: ['openFile'],
  });
  if (!choice.canceled && choice.filePaths && choice.filePaths[0]) privateKeyPath = choice.filePaths[0];
  return { privateKeyPath, exists: !!(privateKeyPath && fs.existsSync(privateKeyPath)) };
});

ipcMain.handle('generate-license', async (_event, input) => {
  try {
    const payload = await buildPayload(input || {});
    return { ok: true, payload, license: createLicense(payload) };
  } catch (error) {
    return { ok: false, error: { code: 'LICENSE_GENERATE_FAILED', message: String(error && error.message || error) } };
  }
});

ipcMain.handle('inspect-license', (_event, license) => {
  try { return inspectLicense(String(license || '')); }
  catch (error) { return { ok: false, error: String(error && error.message || error) }; }
});

ipcMain.handle('plan-presets', () => PLAN_PRESETS);

ipcMain.handle('copy', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
