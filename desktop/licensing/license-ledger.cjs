'use strict';

const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// LicenseLedger (§4) — a config-driven abstraction over the license record ledger.
// CODE-FIRST, CONFIG-LATER: this machine has NO Google credentials, so nothing here
// hard-codes a spreadsheet id / credential / token, and nothing calls the network
// unless a real client is configured on the deploying machine.
//
// Implementations:
//   - NoopLicenseLedger  : local, in-memory; healthCheck() = NOT_CONFIGURED
//   - GoogleSheetLicenseLedger : wraps an injected Google Sheets client (built from
//     env config on the seller machine); idempotent upsert keyed by licenseId,
//     bounded retry, typed errors, explicit sync status. Never fabricates SYNCED.
//
// The Google mechanics (auth, A1 upsert) already live in the generator's
// tools/license-generator/google-sheet.cjs; production wires that as `clientFactory`.
// Tests inject a fake in-memory client so LIVE_CALL_COUNT stays 0.
// ---------------------------------------------------------------------------

const SYNC = Object.freeze({
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  LOCAL_ONLY: 'LOCAL_ONLY',
  PENDING: 'PENDING',
  SYNCED: 'SYNCED',
  FAILED: 'FAILED',
});

const LEDGER_SCHEMA_VERSION = 1;

// NON-SECRET default ledger config committed to source (§13) so the generator machine
// doesn't have to re-enter the spreadsheet id / worksheet titles. Contains NO credential
// — only the (public) spreadsheet id, service-account EMAIL and worksheet titles. Every
// field is env-overridable. The credential JSON is provisioned locally + gitignored.
const DEFAULT_LEDGER_CONFIG = Object.freeze({
  spreadsheetId: '1Pn7teMSytjheYgEV3MhwCu7KJOALosqKnrA6irblvjI',
  serviceAccountEmail: 'license-generator@aviator-license-management.iam.gserviceaccount.com',
  aviatorSheetName: 'Aviator License Management',
  phomSheetName: 'PHOM License Management',
  // A gitignored local fallback credential path (§13 priority 3). Never committed.
  localCredentialPath: 'docs/aviator-license-management-558e23b8e122.json',
});

// Config from environment with committed non-secret defaults (§13). No secret VALUE is
// read here — only the (non-secret) ids/titles and the PATH to a credential file.
function resolveLedgerConfig(env = {}) {
  return {
    enabled: env.GOOGLE_LICENSE_LEDGER_ENABLED === '1',
    spreadsheetId: env.GOOGLE_LICENSE_SPREADSHEET_ID || DEFAULT_LEDGER_CONFIG.spreadsheetId,
    serviceAccountEmail: env.GOOGLE_LICENSE_SERVICE_ACCOUNT_EMAIL || DEFAULT_LEDGER_CONFIG.serviceAccountEmail,
    sheetName: env.GOOGLE_LICENSE_SHEET_NAME || null,
    // §16 — per-gameProduct worksheet TITLES (routing is by title, never by gid).
    aviatorSheetName: env.GOOGLE_LICENSE_AVIATOR_SHEET_NAME || DEFAULT_LEDGER_CONFIG.aviatorSheetName,
    phomSheetName: env.GOOGLE_LICENSE_PHOM_SHEET_NAME || DEFAULT_LEDGER_CONFIG.phomSheetName,
    // Credential PATH: explicit env only here (pure, no fs). The gitignored local-file
    // fallback (§13 priority 3) is resolved by the generator's credential resolver, which
    // does the fs existence check; absent everywhere => NOT_CONFIGURED.
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS || null,
    localCredentialPath: DEFAULT_LEDGER_CONFIG.localCredentialPath,
    timeoutMs: Number(env.GOOGLE_LICENSE_TIMEOUT_MS) || 15000,
    maxRetries: Number.isFinite(Number(env.GOOGLE_LICENSE_MAX_RETRIES)) ? Number(env.GOOGLE_LICENSE_MAX_RETRIES) : 2,
  };
}

// Which worksheet TITLE(s) a gameProduct routes to (§21/§23). AVIATOR -> Aviator sheet,
// PHOM -> PHOM sheet, ALL -> both. Unknown/absent product is treated AVIATOR-only
// (legacy policy). Returns [] when the needed sheet name is not configured.
function sheetsForProduct(gameProduct, config = {}) {
  const gp = String(gameProduct || 'AVIATOR').toUpperCase();
  const aviator = config.aviatorSheetName || null;
  const phom = config.phomSheetName || null;
  // Exactly ONE destination worksheet per license (§16). `ALL` was removed — it no longer
  // fans out to both sheets. PHOM -> PHOM sheet; AVIATOR / legacy / unknown -> Aviator sheet.
  if (gp === 'PHOM') return phom ? [phom] : [];
  return aviator ? [aviator] : [];
}

// The persisted ledger record (§4). NEVER contains signing key / credential / password.
function buildLedgerRecord({ payload = {}, metadata = {}, license = null, now = Date.now() } = {}) {
  const iso = new Date(now).toISOString();
  const fingerprint = license ? crypto.createHash('sha256').update(String(license), 'utf8').digest('hex').slice(0, 32) : null;
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    licenseId: payload.licenseId || null,
    product: payload.product || 'WVPT',
    gameProduct: payload.gameProduct || 'AVIATOR',
    plan: payload.plan || (payload.v === 1 ? 'LEGACY' : null),
    machineId: payload.machineId || null,
    issuedAt: payload.issuedAt != null ? payload.issuedAt : null,
    expiresAt: payload.expiresAt != null ? payload.expiresAt : null,
    maxBrowsers: payload.maxBrowsers != null ? payload.maxBrowsers : null,
    maxConcurrentBrowsers: payload.maxConcurrentBrowsers != null ? payload.maxConcurrentBrowsers : null,
    maxLaunches: payload.maxLaunches != null ? payload.maxLaunches : null,
    features: payload.features || null,
    customer: metadata.customerName || '',
    phone: metadata.phone || '',
    note: metadata.note || '',
    createdAt: metadata.createdAt || iso,
    updatedAt: iso,
    syncStatus: SYNC.PENDING,
    lastSyncError: null,
    payloadFingerprint: fingerprint,
  };
}

class NoopLicenseLedger {
  constructor({ reason = SYNC.NOT_CONFIGURED } = {}) { this._rows = new Map(); this._reason = reason; }
  configured() { return false; }
  async healthCheck() { return { status: SYNC.NOT_CONFIGURED, configured: false, reason: this._reason, message: 'Google Sheet chưa cấu hình trên máy này.' }; }
  async upsertLicense(record) {
    if (!record || !record.licenseId) return { synced: false, status: SYNC.FAILED, error: { code: 'LEDGER_NO_LICENSE_ID', message: 'licenseId is required' } };
    // Idempotent local store — a retry with the same licenseId overwrites, never dups.
    this._rows.set(record.licenseId, { ...record, syncStatus: SYNC.LOCAL_ONLY });
    return { synced: false, status: SYNC.NOT_CONFIGURED, row: this._rows.get(record.licenseId) };
  }
  async findByLicenseId(id) { return this._rows.get(String(id)) || null; }
  async markSyncStatus(id, status, error = null) { const r = this._rows.get(String(id)); if (r) { r.syncStatus = status; r.lastSyncError = error; } return r || null; }
}

class GoogleSheetLicenseLedger {
  // clientFactory({ config }) -> { upsertLicenseRow({payload,license,metadata}), verifyAccess?() }
  constructor({ config, clientFactory, now = () => Date.now() } = {}) {
    this._config = config || {};
    this._clientFactory = clientFactory;
    this._now = now;
    this._client = null;
    this._seen = new Map(); // licenseId -> last record (idempotency guard across retries)
  }

  configured() { return !!(this._config.enabled && this._config.spreadsheetId && this._config.credentialsPath && this._clientFactory); }

  _ensureClient() {
    if (this._client) return this._client;
    if (!this.configured()) return null;
    this._client = this._clientFactory({ config: this._config });
    return this._client;
  }

  async healthCheck() {
    if (!this.configured()) return { status: SYNC.NOT_CONFIGURED, configured: false, message: 'Google Sheet chưa cấu hình trên máy này.' };
    const client = this._ensureClient();
    if (!client || typeof client.verifyAccess !== 'function') return { status: SYNC.PENDING, configured: true };
    try { const r = await this._withTimeout(client.verifyAccess()); return { status: SYNC.SYNCED, configured: true, ...r }; }
    catch (e) { return { status: SYNC.FAILED, configured: true, error: typedError(e) }; }
  }

  async upsertLicense(record) {
    if (!record || !record.licenseId) return { synced: false, status: SYNC.FAILED, error: { code: 'LEDGER_NO_LICENSE_ID', message: 'licenseId is required' } };
    if (!this.configured()) return { synced: false, status: SYNC.NOT_CONFIGURED };
    const client = this._ensureClient();
    const maxRetries = Math.max(0, this._config.maxRetries);
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Idempotent: the client upserts by licenseId, so a retry updates the same row.
        const res = await this._withTimeout(client.upsertLicenseRow({ payload: record._payload || record, license: record._license || null, metadata: record }));
        this._seen.set(record.licenseId, record);
        return { synced: true, status: SYNC.SYNCED, row: res };
      } catch (e) { lastErr = e; if (!isRetryable(e) || attempt === maxRetries) break; }
    }
    return { synced: false, status: SYNC.FAILED, error: typedError(lastErr) };
  }

  async findByLicenseId(id) {
    if (!this.configured()) return null;
    const client = this._ensureClient();
    if (typeof client.findByLicenseId !== 'function') return this._seen.get(String(id)) || null;
    try { return await this._withTimeout(client.findByLicenseId(String(id))); } catch { return null; }
  }

  async markSyncStatus(id, status, error = null) {
    const r = this._seen.get(String(id)); if (r) { r.syncStatus = status; r.lastSyncError = error; }
    return r || null;
  }

  _withTimeout(promise) {
    const ms = this._config.timeoutMs;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_res, rej) => { const t = setTimeout(() => { const e = new Error('GOOGLE_TIMEOUT'); e.code = 'GOOGLE_TIMEOUT'; rej(e); }, ms); if (t.unref) t.unref(); }),
    ]);
  }
}

const SYNC_PARTIAL = 'PARTIAL';

// §16 — routes a license record to its ONE product worksheet by gameProduct (AVIATOR ->
// Aviator sheet, PHOM -> PHOM sheet; `ALL` was removed). Idempotency is by licenseId AT
// the client (it updates the existing row), so re-syncing the same key never duplicates.
// The client upserts ONE named worksheet: upsertLicenseRow({payload,license,metadata,sheetTitle}).
class MultiSheetGoogleLicenseLedger {
  constructor({ config, clientFactory, now = () => Date.now() } = {}) {
    this._config = config || {};
    this._clientFactory = clientFactory;
    this._now = now;
    this._client = null;
  }

  configured() {
    return !!(this._config.enabled && this._config.spreadsheetId && this._config.credentialsPath && this._clientFactory
      && (this._config.aviatorSheetName || this._config.phomSheetName));
  }

  _ensureClient() { if (!this._client && this.configured()) this._client = this._clientFactory({ config: this._config }); return this._client; }

  async healthCheck() {
    if (!this.configured()) return { status: SYNC.NOT_CONFIGURED, configured: false, message: 'Google Sheet chưa cấu hình trên máy này.' };
    const client = this._ensureClient();
    if (!client || typeof client.verifyAccess !== 'function') return { status: SYNC.PENDING, configured: true };
    try { const r = await this._withTimeout(client.verifyAccess()); return { status: SYNC.SYNCED, configured: true, ...r }; }
    catch (e) { return { status: SYNC.FAILED, configured: true, error: typedError(e) }; }
  }

  async upsertLicense(record) {
    if (!record || !record.licenseId) return { synced: false, status: SYNC.FAILED, error: { code: 'LEDGER_NO_LICENSE_ID', message: 'licenseId is required' } };
    if (!this.configured()) return { synced: false, status: SYNC.NOT_CONFIGURED };
    const targets = sheetsForProduct(record.gameProduct, this._config);
    if (!targets.length) return { synced: false, status: SYNC.FAILED, error: { code: 'LEDGER_SHEET_NOT_CONFIGURED', message: `No worksheet configured for gameProduct ${record.gameProduct}` } };
    const client = this._ensureClient();
    const perSheet = {};
    for (const title of targets) {
      // The client upserts by licenseId (updates the existing row), so a repeat call is
      // idempotent — never a duplicate row.
      perSheet[title] = await this._upsertOne(client, record, title);
    }
    const results = targets.map((t) => perSheet[t]);
    const okCount = results.filter((r) => r.status === SYNC.SYNCED).length;
    let status;
    if (okCount === targets.length) status = SYNC.SYNCED;
    else if (okCount === 0) status = SYNC.FAILED;
    else status = SYNC_PARTIAL;
    // Surface the first failing sheet's typed error at the top level (single-sheet routing
    // means there is normally exactly one target). Never fabricates SYNCED.
    const firstErr = results.find((r) => r.error);
    const out = { synced: status === SYNC.SYNCED, status, sheets: perSheet, targets };
    if (firstErr) out.error = firstErr.error;
    return out;
  }

  async _upsertOne(client, record, sheetTitle) {
    const maxRetries = Math.max(0, this._config.maxRetries);
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await this._withTimeout(client.upsertLicenseRow({ payload: record._payload || record, license: record._license || null, metadata: record, sheetTitle }));
        return { status: SYNC.SYNCED, row: res };
      } catch (e) { lastErr = e; if (!isRetryable(e) || attempt === maxRetries) break; }
    }
    return { status: SYNC.FAILED, error: typedError(lastErr) };
  }

  _withTimeout(promise) {
    const ms = this._config.timeoutMs;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_res, rej) => { const t = setTimeout(() => { const e = new Error('GOOGLE_TIMEOUT'); e.code = 'GOOGLE_TIMEOUT'; rej(e); }, ms); if (t.unref) t.unref(); }),
    ]);
  }
}

function isRetryable(e) { const code = e && e.code; return code === 'GOOGLE_TIMEOUT' || code === 'GOOGLE_API_ERROR' || code === 'GOOGLE_AUTH_FAILED'; }
function typedError(e) { return { code: (e && e.code) || 'LEDGER_ERROR', message: String((e && e.message) || e || '').slice(0, 200) }; }

// Factory: GoogleSheet when fully configured + a client factory is provided, else Noop.
function createLicenseLedger({ env = process.env, clientFactory = null, now } = {}) {
  const config = resolveLedgerConfig(env);
  if (config.enabled && config.spreadsheetId && config.credentialsPath && clientFactory) {
    // Two-sheet routing when per-product worksheet titles are configured (§21); else the
    // legacy single-sheet ledger keeps working unchanged.
    if (config.aviatorSheetName || config.phomSheetName) {
      return new MultiSheetGoogleLicenseLedger({ config, clientFactory, now });
    }
    return new GoogleSheetLicenseLedger({ config, clientFactory, now });
  }
  return new NoopLicenseLedger({ reason: config.enabled ? 'MISSING_CONFIG' : SYNC.NOT_CONFIGURED });
}

module.exports = {
  SYNC, SYNC_PARTIAL, LEDGER_SCHEMA_VERSION,
  resolveLedgerConfig, sheetsForProduct, buildLedgerRecord, createLicenseLedger,
  NoopLicenseLedger, GoogleSheetLicenseLedger, MultiSheetGoogleLicenseLedger,
};
