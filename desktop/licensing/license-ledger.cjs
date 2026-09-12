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

// Config from environment (names per §4). No secrets are read here — only the path
// to a credential file the deployer supplies out-of-band.
function resolveLedgerConfig(env = {}) {
  return {
    enabled: env.GOOGLE_LICENSE_LEDGER_ENABLED === '1',
    spreadsheetId: env.GOOGLE_LICENSE_SPREADSHEET_ID || null,
    sheetName: env.GOOGLE_LICENSE_SHEET_NAME || null,
    credentialsPath: env.GOOGLE_APPLICATION_CREDENTIALS || null,
    timeoutMs: Number(env.GOOGLE_LICENSE_TIMEOUT_MS) || 15000,
    maxRetries: Number.isFinite(Number(env.GOOGLE_LICENSE_MAX_RETRIES)) ? Number(env.GOOGLE_LICENSE_MAX_RETRIES) : 2,
  };
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

function isRetryable(e) { const code = e && e.code; return code === 'GOOGLE_TIMEOUT' || code === 'GOOGLE_API_ERROR' || code === 'GOOGLE_AUTH_FAILED'; }
function typedError(e) { return { code: (e && e.code) || 'LEDGER_ERROR', message: String((e && e.message) || e || '').slice(0, 200) }; }

// Factory: GoogleSheet when fully configured + a client factory is provided, else Noop.
function createLicenseLedger({ env = process.env, clientFactory = null, now } = {}) {
  const config = resolveLedgerConfig(env);
  if (config.enabled && config.spreadsheetId && config.credentialsPath && clientFactory) {
    return new GoogleSheetLicenseLedger({ config, clientFactory, now });
  }
  return new NoopLicenseLedger({ reason: config.enabled ? 'MISSING_CONFIG' : SYNC.NOT_CONFIGURED });
}

module.exports = {
  SYNC, LEDGER_SCHEMA_VERSION,
  resolveLedgerConfig, buildLedgerRecord, createLicenseLedger,
  NoopLicenseLedger, GoogleSheetLicenseLedger,
};
