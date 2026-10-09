'use strict';

const { app, BrowserWindow, ipcMain, clipboard, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { TrustedTimeProvider } = require('../../desktop/licensing/trusted-time.cjs');
const { resolveExpiresAt, formatUtcPlus7 } = require('./duration.cjs');
const { publicGameConfigs, gameConfig, GAME_ORDER } = require('./game-configs.cjs');
const { issueLicense, assertKeyForGame } = require('./license-signer.cjs');
const { diagnoseLicense } = require('./license-diagnostics.cjs');
const { resolveSellerResources, privateKeyPathForProduct, sheetTitleForProduct, GOOGLE_CREDENTIAL_FILE } = require('./seller-resources.cjs');
const sellerRes = { privateKeyPathForProduct, sheetTitleForProduct };
const { loadServiceAccount, GoogleSheetClient, trySaveRecord } = require('./google-sheet.cjs');
const { createKeyStore } = require('./key-store.cjs');

// LOCAL store of issued keys (alongside the Sheet). Lazy so app.getPath is ready.
let _store = null;
function store() { if (!_store) _store = createKeyStore({ dir: path.join(app.getPath('userData'), 'generator') }); return _store; }
function toStoreEntry(payload, license, metadata) {
  return {
    licenseId: payload.licenseId, gameProduct: payload.gameProduct, plan: payload.plan, machineId: payload.machineId,
    customerName: (metadata && metadata.customerName) || '', phone: (metadata && metadata.phone) || '', note: (metadata && metadata.note) || '',
    issuedAt: payload.issuedAt, expiresAt: payload.expiresAt,
    maxBrowsers: payload.maxBrowsers, maxConcurrentBrowsers: payload.maxConcurrentBrowsers,
    features: payload.features || {}, license,
  };
}

let win;

// ---- network through Chromium (electron net), not node:https ----
// On another machine node:https ignores the Windows proxy settings and the Windows certificate store (a proxy, a
// company firewall or an antivirus that inspects HTTPS then breaks the Sheet / trusted time while a browser works).
// electron net uses the same network stack as Chrome. Same { status, text, json } shape as google-sheet's httpsRequest.
async function netRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const h = { ...headers }; delete h['Content-Length']; // Chromium sets it itself
  try {
    const res = await net.fetch(url, { method, headers: h, body: body == null ? undefined : body, signal: ctrl.signal, bypassCustomProtocolHandlers: true });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, text, json };
  } catch (e) {
    if (ctrl.signal.aborted) { const t = new Error('GOOGLE_TIMEOUT'); t.code = 'GOOGLE_TIMEOUT'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}
// trusted time's Date header, through the same stack
async function netDateHeader(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { method: 'HEAD', signal: ctrl.signal, bypassCustomProtocolHandlers: true });
    const ms = Date.parse(String(res.headers.get('date') || ''));
    return Number.isFinite(ms) ? { ok: true, nowMs: ms, source: url } : { ok: false, error: 'DATE_HEADER_MISSING', source: url };
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'TIME_AUTHORITY_TIMEOUT' : ((e && e.code) || 'TIME_AUTHORITY_ERROR'), source: url };
  } finally { clearTimeout(timer); }
}
const trustedTime = new TrustedTimeProvider({ fetchDateHeader: netDateHeader });
// the Google login is signed with trusted internet time — a machine whose clock / time zone is wrong still signs in
async function sheetClock() { const r = await trustedTime.now(); return r.ok ? r.nowMs : Date.now(); }

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

// Per-product private key (§5/§8). PHOM signs with the PHOM key, AVIATOR with the
// Aviator key — the wrong product NEVER falls back to the other's key. Typed errors.
// No implicit default game: an unknown game has no key.
function readPrivateKeyForProduct(gameProduct) {
  const cfg = gameConfig(gameProduct);
  if (!cfg) { const e = new Error('Game không hợp lệ.'); e.code = 'LICENSE_GAME_PRODUCT_INVALID'; throw e; }
  const gp = cfg.game;
  if (gp === 'AVIATOR' && !app.isPackaged) { const direct = process.env.AVIATOR_LICENSE_PRIVATE_KEY || process.env.WVPT_PRIVATE_KEY; if (direct) return direct.replace(/\\n/g, '\n'); }
  const res = sellerResources();
  const p = sellerRes.privateKeyPathForProduct(res, gp);
  if (!p || !fs.existsSync(p)) { const e = new Error(`Chưa có private key ${cfg.signingKeyId} cho ${cfg.label} trong gói Generator.`); e.code = 'LICENSE_SIGNING_KEY_NOT_CONFIGURED'; throw e; }
  try { return fs.readFileSync(p, 'utf8'); } catch { const e = new Error(`Không đọc được private key của ${cfg.label}.`); e.code = 'LICENSE_PRIVATE_KEY_LOAD_FAILED'; throw e; }
}

// Per-game signing readiness: the key must exist AND be the private half of that game's
// registry public key (a stray/misplaced key is reported, never used). Code only — no path.
function signingStateForProduct(gameProduct) {
  const gp = String(gameProduct || '').toUpperCase();
  try { assertKeyForGame(gp, readPrivateKeyForProduct(gp)); return { ready: true, code: null }; }
  catch (e) { return { ready: false, code: e.code || 'LICENSE_SIGNING_KEY_NOT_CONFIGURED' }; }
}
function signingReadyForProduct(gameProduct) { return signingStateForProduct(gameProduct).ready; }

// ---- Google Sheet client (seller-side; lazy; credentials never cross IPC) ----
let sheetClient = null;
let sheetClientCredPath = null;

// Seller drop-in location: a stable, writable folder NEXT TO the installed .exe where the
// operator can place google-service-account.json AFTER install without a rebuild. In dev this
// is the generator source dir. This is what makes the PACKAGED app able to find the credential
// (process.cwd() is unreliable when launched from a shortcut, so a bare relative path fails).
function credentialDropInDir() {
  try { if (app && app.isPackaged) return path.dirname(app.getPath('exe')); } catch { /* fall through */ }
  return __dirname;
}

// Ordered, ABSOLUTE credential candidates (first existing wins). Covers: env override /
// bundled resources/private (dev+packaged), a drop-in beside the installed exe, the app
// userData dir, and the gitignored dev local fallback resolved from the repo root (never CWD).
function credentialCandidates() {
  const res = sellerResources();
  const out = [];
  if (res.googleCredentialPath) out.push(res.googleCredentialPath);
  const fname = GOOGLE_CREDENTIAL_FILE || 'google-service-account.json';
  out.push(path.join(credentialDropInDir(), fname));
  try { out.push(path.join(app.getPath('userData'), fname)); } catch { /* userData unavailable */ }
  if (res.localCredentialPath) {
    out.push(path.isAbsolute(res.localCredentialPath)
      ? res.localCredentialPath
      : path.resolve(__dirname, '..', '..', res.localCredentialPath)); // repo-root relative, CWD-independent
  }
  // De-dupe while preserving order.
  return out.filter((p, i) => p && out.indexOf(p) === i);
}

function resolveCred() {
  for (const c of credentialCandidates()) { if (fs.existsSync(c)) return c; }
  return null;
}
// Returns a ready client or null (not configured). Throws only on a bad credential file.
function getSheetClient() {
  const p = resolveCred();
  if (!p) return null;
  if (sheetClient && sheetClientCredPath === p) return sheetClient;
  const sa = loadServiceAccount(p); // may throw GOOGLE_CREDENTIAL_*
  const { spreadsheetId, sheetId } = sellerResources();
  sheetClient = new GoogleSheetClient({ serviceAccount: sa, spreadsheetId, sheetId, request: netRequest, clock: sheetClock });
  sheetClientCredPath = p;
  return sheetClient;
}
function credentialEmail(p) {
  try { return loadServiceAccount(p).client_email || null; } catch { return null; }
}

async function trustedIssuedAt() {
  if (process.env.WVPT_TRUSTED_TIME_MS && Number.isFinite(Number(process.env.WVPT_TRUSTED_TIME_MS))) {
    return Math.floor(Number(process.env.WVPT_TRUSTED_TIME_MS) / 1000);
  }
  const result = await trustedTime.now();
  if (!result.ok) { const e = new Error('Không xác minh được giờ tin cậy UTC+7. Kiểm tra kết nối mạng rồi thử lại.'); e.code = 'TRUSTED_TIME_UNAVAILABLE'; throw e; }
  return Math.floor(result.nowMs / 1000);
}

// Best available "now" for diagnostics (trusted when cached; flagged otherwise).
function diagnosticNow() {
  if (process.env.WVPT_TRUSTED_TIME_MS && Number.isFinite(Number(process.env.WVPT_TRUSTED_TIME_MS))) return { nowMs: Number(process.env.WVPT_TRUSTED_TIME_MS), estimated: false };
  const cached = trustedTime.cachedNowMs();
  return cached != null ? { nowMs: cached, estimated: false } : { nowMs: Date.now(), estimated: true };
}

// ---- Google Sheet save (idempotent by licenseId). Never throws to the caller;
// a Google failure NEVER destroys the already-created license. ----
async function saveRecordToSheet(record) {
  let client;
  try { client = getSheetClient(); }
  catch (e) { return { synced: false, error: { code: e.code || 'GOOGLE_CREDENTIAL_ERROR', message: e.message } }; }
  // Route by the license's signed gameProduct (§16): AVIATOR -> Aviator sheet, PHOM -> PHOM sheet.
  const gp = record && record.payload && record.payload.gameProduct;
  if (!gameConfig(gp)) return { synced: false, error: { code: 'LICENSE_GAME_PRODUCT_INVALID', message: 'Bản ghi không có game hợp lệ — không lưu Sheet.' } };
  const sheetTitle = sellerRes.sheetTitleForProduct(sellerResources(), gp);
  return trySaveRecord(client, record, sheetTitle);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#eef1f7',
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'ui.html'));
}

// ---- IPC: only SAFE state/operations. No secret paths or key material cross here. ----
ipcMain.handle('signing-status', () => ({ ready: GAME_ORDER.every(signingReadyForProduct), games: Object.fromEntries(GAME_ORDER.map((g) => [g, signingStateForProduct(g)])) }));

// Game-scoped option model for the single form renderer (no keys, no paths).
ipcMain.handle('game-configs', () => publicGameConfigs());

// Per-product public info for the UI (§8/§19): destination worksheet + signing key id +
// whether that product's private key is available. NEVER returns a private key or a path.
ipcMain.handle('product-info', (_event, gameProduct) => {
  const cfg = gameConfig(gameProduct);
  if (!cfg) return { ok: false, error: { code: 'LICENSE_GAME_PRODUCT_INVALID' } };
  const state = signingStateForProduct(cfg.game);
  return { ok: true, gameProduct: cfg.game, targetSheet: sellerRes.sheetTitleForProduct(sellerResources(), cfg.game), signingKeyId: cfg.signingKeyId, signingReady: state.ready, signingCode: state.code };
});

ipcMain.handle('generate-license', async (_event, input) => {
  let issued;
  try {
    const issuedAt = await trustedIssuedAt();
    issued = issueLicense(input || {}, { issuedAt, privateKeyForGame: readPrivateKeyForProduct });
  } catch (error) {
    // Typed, key-free error. No stack trace crosses IPC.
    return { ok: false, error: { code: (error && error.code) || 'LICENSE_GENERATE_FAILED', message: String(error && error.message || error), detail: (error && error.detail) || null } };
  }
  const { payload, license } = issued;
  const metadata = {
    customerName: (input && input.customerName) || '',
    phone: (input && input.phone) || '',
    note: (input && input.note) || '',
    createdAt: new Date().toISOString(), // management timestamp; fixed for retries
  };
  const record = { payload, license, metadata };
  // Save to the LOCAL store first (always succeeds offline), then attempt the Google Sheet.
  try { store().add(toStoreEntry(payload, license, metadata)); } catch (e) { /* local record is best-effort */ }
  const sheet = await saveRecordToSheet(record);
  return { ok: true, payload, license, metadata, sheet };
});

// ---- LOCAL key/user management (offline; the Sheet stays the online ledger) ----
ipcMain.handle('keys-list', (_event, input) => store().list({ q: (input && input.q) || '', status: (input && input.status) || 'all' }));
ipcMain.handle('keys-users', () => store().users());
ipcMain.handle('keys-stats', () => store().stats());
ipcMain.handle('key-get', (_event, licenseId) => store().get(String(licenseId || '')));
ipcMain.handle('key-revoke', (_event, input) => { const r = store().setStatus(String((input && input.licenseId) || ''), 'REVOKED', (input && input.reason) || ''); return r.found ? { ok: true } : { ok: false, error: { code: 'KEY_NOT_FOUND', message: 'Không thấy key trong kho.' } }; });
ipcMain.handle('key-restore', (_event, licenseId) => { const r = store().setStatus(String(licenseId || ''), 'ACTIVE'); return r.found ? { ok: true } : { ok: false, error: { code: 'KEY_NOT_FOUND', message: 'Không thấy key.' } }; });
ipcMain.handle('key-delete', (_event, licenseId) => { const r = store().remove(String(licenseId || '')); return r.found ? { ok: true } : { ok: false, error: { code: 'KEY_NOT_FOUND', message: 'Không thấy key.' } }; });
ipcMain.handle('store-open-folder', () => { try { require('electron').shell.openPath(store().dir); return { ok: true }; } catch (e) { return { ok: false, error: { message: e.message } }; } });

// Retry / explicit sync of an ALREADY-generated license — no regeneration. Same
// licenseId => idempotent upsert => never a duplicate row.
ipcMain.handle('sheet-sync', async (_event, record) => saveRecordToSheet(record));

// Operator activation diagnostics for a target game (final verdict = runtime verifier).
ipcMain.handle('diagnose-license', (_event, input) => {
  const { nowMs, estimated } = diagnosticNow();
  try {
    return { ...diagnoseLicense(String((input && input.license) || '').trim(), { expectedGame: input && input.game, machineId: input && input.machineId, nowMs }), estimatedTime: estimated };
  } catch (error) {
    return { ok: false, result: 'INVALID', code: 'DIAGNOSE_FAILED', steps: [], estimatedTime: estimated };
  }
});


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
  // When no credential is found, tell the operator EXACTLY where to drop the JSON file
  // (beside the installed .exe). The file name/path are non-secret; the key never crosses IPC.
  if (!p) return { configured: false, state: 'disconnected', expectedPath: path.join(credentialDropInDir(), GOOGLE_CREDENTIAL_FILE || 'google-service-account.json') };
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
