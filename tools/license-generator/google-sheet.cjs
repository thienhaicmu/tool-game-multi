'use strict';

// ---------------------------------------------------------------------------
// SELLER-SIDE Google Sheet ledger for the License Generator.
//
// SECURITY (hard rules):
//   - Service-account credentials are seller-side only and NEVER enter the repo,
//     Control.exe, tests, or logs. This module reads the JSON from an external
//     path (env WVPT_GOOGLE_SERVICE_ACCOUNT or a generator-local remembered path).
//   - private_key is NEVER printed, returned over IPC, or serialized anywhere.
//   - Google Sheet is a management LEDGER only; it is NEVER the source of truth
//     for signed license fields — it stores the EXACT generated token + payload.
//
// Zero npm dependencies: service-account auth (RS256 JWT -> OAuth token) and the
// Sheets v4 REST calls are implemented with node:crypto + node:https so nothing
// new is added to package-lock or packaged into any build.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');

const SPREADSHEET_ID = '1Pn7teMSytjheYgEV3MhwCu7KJOALosqKnrA6irblvjI';
const SHEET_ID = 0; // gid; resolved to a sheet title lazily for A1 ranges
const TOKEN_URI = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Stable header row (management columns + ALL signed v2 fields + exact token).
// Order is deterministic; rawPayloadJson is an audit convenience, NOT a substitute
// for the individual columns.
const SHEET_HEADERS = Object.freeze([
  'licenseId',
  'machineId',
  'customerName',
  'phone',
  'plan',
  'issuedAt',
  'expiresAt',
  'maxBrowsers',
  'maxConcurrentBrowsers',
  'autoRun',
  'jackpotLive',
  'jackpotGate',
  'roundHistory',
  'product',
  'schemaVersion',
  'licenseKey',
  'note',
  'createdAt',
  'rawPayloadJson',
]);

// Date columns are written as real Google Sheets date values (not raw epochs) and
// paired with a DATE_TIME cell format so the ledger reads naturally for the seller.
const UTC_PLUS_7_OFFSET_SECONDS = 7 * 60 * 60;
const SHEETS_EPOCH_DAY = 25569; // serial day number of 1970-01-01 (days since 1899-12-30)
const DATE_COLUMNS = Object.freeze(['issuedAt', 'expiresAt', 'createdAt']);

function toEpochSeconds(value) {
  if (value == null || value === '') return Math.floor(Date.now() / 1000);
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(Date.now() / 1000);
}

// Epoch seconds -> Google Sheets serial date in UTC+7 wall clock (Vietnam-local).
function epochToSheetSerial(epochSeconds) {
  if (epochSeconds == null || !Number.isFinite(Number(epochSeconds))) return '';
  return SHEETS_EPOCH_DAY + (Number(epochSeconds) + UTC_PLUS_7_OFFSET_SECONDS) / 86400;
}

// ---- PURE mapping: signed payload + exact token + metadata -> sheet row object ----
// No mutation of the payload. Dates become Sheets serials; the exact signed epochs
// remain in rawPayloadJson (+ the signed token). Defensive for legacy v1 payloads too.
function licenseToSheetRow({ payload, license, metadata = {} } = {}) {
  if (!payload || typeof payload !== 'object') throw new Error('licenseToSheetRow: payload is required');
  if (typeof license !== 'string' || !license) throw new Error('licenseToSheetRow: license token is required');
  const f = (payload.features && typeof payload.features === 'object') ? payload.features : {};
  return {
    licenseId: payload.licenseId || '',
    machineId: payload.machineId || '',
    customerName: metadata.customerName != null ? String(metadata.customerName) : '',
    phone: metadata.phone != null ? String(metadata.phone) : '',
    plan: payload.plan != null ? payload.plan : (payload.v === 1 ? 'LEGACY' : ''),
    issuedAt: epochToSheetSerial(payload.issuedAt),
    expiresAt: epochToSheetSerial(payload.expiresAt),
    maxBrowsers: payload.maxBrowsers != null ? payload.maxBrowsers : '',
    maxConcurrentBrowsers: payload.maxConcurrentBrowsers != null ? payload.maxConcurrentBrowsers : '',
    autoRun: f.autoRun === true,
    jackpotLive: f.jackpotLive === true,
    jackpotGate: f.jackpotGate === true,
    roundHistory: f.roundHistory === true,
    product: payload.product || '',
    schemaVersion: payload.v,
    licenseKey: license, // EXACT successful token — never reconstructed
    note: metadata.note != null ? String(metadata.note) : '',
    createdAt: epochToSheetSerial(toEpochSeconds(metadata.createdAt)),
    rawPayloadJson: JSON.stringify(payload),
  };
}

function toCell(value) {
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  if (value == null) return '';
  return String(value);
}

function numericCell(value) {
  return (value === '' || value == null || !Number.isFinite(Number(value))) ? '' : Number(value);
}

// Order a row object into the header-aligned array of cells. Date columns stay numeric
// (Sheets serials) so a DATE_TIME format renders them; everything else is stringified.
function rowToValues(rowObject, headers = SHEET_HEADERS) {
  return headers.map((h) => (DATE_COLUMNS.includes(h) ? numericCell(rowObject[h]) : toCell(rowObject[h])));
}

// ---- credential resolution (external, seller-side only) ----
// Precedence: explicit path arg -> env WVPT_GOOGLE_SERVICE_ACCOUNT -> rememberedPath.
function resolveCredentialPath({ explicitPath = null, env = process.env, rememberedPath = null } = {}) {
  const candidates = [explicitPath, env && env.WVPT_GOOGLE_SERVICE_ACCOUNT, rememberedPath];
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim();
  }
  return null;
}

function loadServiceAccount(path) {
  if (!path || !fs.existsSync(path)) {
    const err = new Error('Không tìm thấy tệp Service Account của Google.');
    err.code = 'GOOGLE_CREDENTIAL_MISSING';
    throw err;
  }
  let json;
  try { json = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { const e = new Error('Tệp Service Account không phải JSON hợp lệ.'); e.code = 'GOOGLE_CREDENTIAL_INVALID'; throw e; }
  if (!json.client_email || !json.private_key) {
    const e = new Error('Tệp Service Account thiếu client_email hoặc private_key.');
    e.code = 'GOOGLE_CREDENTIAL_INVALID';
    throw e;
  }
  return json; // caller must never log/return private_key
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signServiceAccountJwt(sa, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: sa.client_email,
    scope: SHEETS_SCOPE,
    aud: sa.token_uri || TOKEN_URI,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

function httpsRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('GOOGLE_TIMEOUT')); });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

class GoogleSheetClient {
  constructor({ serviceAccount, spreadsheetId = SPREADSHEET_ID, sheetId = SHEET_ID, request = httpsRequest } = {}) {
    if (!serviceAccount) throw new Error('GoogleSheetClient requires a serviceAccount');
    this._sa = serviceAccount;
    this._spreadsheetId = spreadsheetId;
    this._sheetId = sheetId;
    this._request = request;
    this._token = null; // { accessToken, expEpoch }
    this._sheetTitle = null;
  }

  get clientEmail() { return this._sa.client_email; }

  async _accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (this._token && this._token.expEpoch - 60 > now) return this._token.accessToken;
    const assertion = signServiceAccountJwt(this._sa, now);
    const form = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`;
    const res = await this._request(this._sa.token_uri || TOKEN_URI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
      body: form,
    });
    if (res.status !== 200 || !res.json || !res.json.access_token) {
      const e = new Error('Xác thực Google thất bại (không lấy được access token).');
      e.code = 'GOOGLE_AUTH_FAILED';
      throw e;
    }
    this._token = { accessToken: res.json.access_token, expEpoch: now + Number(res.json.expires_in || 3600) };
    return this._token.accessToken;
  }

  async _api(path, { method = 'GET', query = '', body = null } = {}) {
    const token = await this._accessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this._spreadsheetId}${path}${query}`;
    const headers = { Authorization: `Bearer ${token}` };
    let payload = null;
    if (body != null) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const res = await this._request(url, { method, headers, body: payload });
    if (res.status < 200 || res.status >= 300) {
      const msg = (res.json && res.json.error && res.json.error.message) || `HTTP ${res.status}`;
      const e = new Error(`Google Sheets API lỗi: ${msg}`);
      e.code = 'GOOGLE_API_ERROR';
      e.status = res.status;
      throw e;
    }
    return res.json;
  }

  // Fetch + cache the spreadsheet's sheet metadata (title -> gid), and the workbook title.
  async _loadSheetMeta() {
    if (this._sheetMeta) return this._sheetMeta;
    const meta = await this._api('', { query: '?fields=properties.title,sheets.properties(sheetId,title)' });
    const byTitle = new Map();
    for (const s of (meta && meta.sheets) || []) { if (s.properties) byTitle.set(String(s.properties.title), Number(s.properties.sheetId)); }
    this._spreadsheetTitle = (meta.properties && meta.properties.title) || null;
    this._sheetMeta = { byTitle };
    return this._sheetMeta;
  }

  // Resolve gid -> sheet title (default sheet), for callers that don't pass a title.
  async _resolveSheetTitle() {
    if (this._sheetTitle) return this._sheetTitle;
    const { byTitle } = await this._loadSheetMeta();
    for (const [title, gid] of byTitle) { if (Number(gid) === Number(this._sheetId)) { this._sheetTitle = title; return title; } }
    const e = new Error(`Không tìm thấy sheet gid=${this._sheetId}.`); e.code = 'GOOGLE_SHEET_NOT_FOUND'; throw e;
  }

  // Resolve the worksheet TITLE for a row operation (§15). An explicit title is verified
  // to EXIST (routing by title, never by gid); a missing tab is a typed error and NEVER
  // silently redirected to another sheet. No explicit title -> the default gid sheet.
  async _titleFor(explicitTitle) {
    if (explicitTitle == null || explicitTitle === '') return this._resolveSheetTitle();
    const { byTitle } = await this._loadSheetMeta();
    if (!byTitle.has(String(explicitTitle))) { const e = new Error(`Worksheet không tồn tại: ${explicitTitle}`); e.code = 'GOOGLE_SHEET_NOT_FOUND'; throw e; }
    return String(explicitTitle);
  }

  // gid for a resolved title (needed by formatting/delete batchUpdate).
  async _gidForTitle(title) { const { byTitle } = await this._loadSheetMeta(); return byTitle.get(String(title)); }

  async ping(sheetTitle) {
    const title = await this._titleFor(sheetTitle);
    return { ok: true, spreadsheetTitle: this._spreadsheetTitle || null, sheetTitle: title, email: this.clientEmail };
  }

  // §18 health check — verify BOTH product worksheets resolve (typed error if either tab
  // is missing). Used by the ledger healthCheck to fail fast, never write to a wrong tab.
  async verifyAccess({ sheetTitles = [] } = {}) {
    await this._loadSheetMeta();
    const resolved = [];
    for (const t of sheetTitles) resolved.push({ title: await this._titleFor(t) });
    return { spreadsheetTitle: this._spreadsheetTitle || null, email: this.clientEmail, sheets: resolved };
  }

  async _readRange(a1, sheetTitle) {
    const title = await this._titleFor(sheetTitle);
    const range = `${title}!${a1}`;
    const json = await this._api(`/values/${encodeURIComponent(range)}`);
    return (json && json.values) || [];
  }

  // Ensure the header row exists exactly once on the target sheet. Never destroys rows.
  async ensureHeaders(sheetTitle) {
    const title = await this._titleFor(sheetTitle);
    const firstRow = await this._readRange('1:1', title);
    const existing = firstRow[0] || [];
    if (existing.length && existing.some((c) => String(c || '').trim())) {
      return { created: false, headers: existing };
    }
    await this._api(`/values/${encodeURIComponent(`${title}!A1`)}`, {
      method: 'PUT',
      query: '?valueInputOption=RAW',
      body: { values: [SHEET_HEADERS.slice()] },
    });
    try { await this.applyFormatting(title); } catch { /* formatting is best-effort, never blocks a save */ }
    return { created: true, headers: SHEET_HEADERS.slice() };
  }

  // Make the ledger readable: frozen bold header, date columns as dd/mm/yyyy hh:mm,
  // clipped overflow, and the technical rawPayloadJson column hidden. Idempotent.
  async applyFormatting(sheetTitle) {
    const title = await this._titleFor(sheetTitle);
    const gid = Number(await this._gidForTitle(title));
    const col = (h) => SHEET_HEADERS.indexOf(h);
    const dateFormat = { numberFormat: { type: 'DATE_TIME', pattern: 'dd/mm/yyyy hh:mm' } };
    const requests = [
      { updateSheetProperties: { properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId: gid }, cell: { userEnteredFormat: { wrapStrategy: 'CLIP' } }, fields: 'userEnteredFormat.wrapStrategy' } },
      { repeatCell: { range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { backgroundColor: { red: 0.17, green: 0.24, blue: 0.31 }, textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)' } },
      { updateDimensionProperties: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: col('rawPayloadJson'), endIndex: col('rawPayloadJson') + 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
    ];
    for (const h of DATE_COLUMNS) {
      requests.push({ repeatCell: { range: { sheetId: gid, startRowIndex: 1, startColumnIndex: col(h), endColumnIndex: col(h) + 1 }, cell: { userEnteredFormat: dateFormat }, fields: 'userEnteredFormat.numberFormat' } });
    }
    await this._api(':batchUpdate', { method: 'POST', body: { requests } });
  }

  // Find the 1-based sheet row index for a licenseId (column A) on a given title, or null.
  async _findRowIndexByLicenseId(licenseId, sheetTitle) {
    const title = await this._titleFor(sheetTitle);
    const col = await this._readRange('A2:A', title); // A1 is header
    for (let i = 0; i < col.length; i += 1) {
      if (String((col[i] && col[i][0]) || '') === String(licenseId)) return i + 2; // +2: header + 0-based
    }
    return null;
  }

  // Read one license record back from a specific sheet by licenseId (§15/§24), or null.
  async findByLicenseId(licenseId, sheetTitle) {
    const title = await this._titleFor(sheetTitle);
    const index = await this._findRowIndexByLicenseId(licenseId, title);
    if (!index) return null;
    const lastCol = columnLetter(SHEET_HEADERS.length);
    const rows = await this._readRange(`A${index}:${lastCol}${index}`, title);
    const cells = rows[0] || [];
    const out = { sheetTitle: title, rowIndex: index };
    SHEET_HEADERS.forEach((h, i) => { out[h] = cells[i] != null ? cells[i] : ''; });
    return out;
  }

  // Idempotent upsert keyed by licenseId on the ROUTED worksheet (§15/§16) —
  // retry/double-click safe. Returns { action: 'appended'|'updated', rowIndex, sheetTitle }.
  async upsertLicenseRow({ payload, license, metadata, sheetTitle }) {
    const title = await this._titleFor(sheetTitle);
    await this.ensureHeaders(title);
    const row = licenseToSheetRow({ payload, license, metadata });
    const values = [rowToValues(row)];
    const licenseId = row.licenseId;
    if (!licenseId) { const e = new Error('licenseId trống — không thể lưu ledger.'); e.code = 'GOOGLE_ROW_NO_LICENSE_ID'; throw e; }
    const existingIndex = await this._findRowIndexByLicenseId(licenseId, title);
    if (existingIndex) {
      const lastCol = columnLetter(SHEET_HEADERS.length);
      await this._api(`/values/${encodeURIComponent(`${title}!A${existingIndex}:${lastCol}${existingIndex}`)}`, {
        method: 'PUT',
        query: '?valueInputOption=RAW',
        body: { values },
      });
      return { action: 'updated', rowIndex: existingIndex, sheetTitle: title };
    }
    await this._api(`/values/${encodeURIComponent(`${title}!A1`)}:append`, {
      method: 'POST',
      query: '?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
      body: { values },
    });
    return { action: 'appended', rowIndex: null, sheetTitle: title };
  }

  // Delete a single row by licenseId on a given sheet (used ONLY by the marked live smoke test).
  async deleteRowByLicenseId(licenseId, sheetTitle) {
    const title = await this._titleFor(sheetTitle);
    const gid = Number(await this._gidForTitle(title));
    const index = await this._findRowIndexByLicenseId(licenseId, title);
    if (!index) return { deleted: false };
    await this._api(':batchUpdate', {
      method: 'POST',
      body: { requests: [{ deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: index - 1, endIndex: index } } }] },
    });
    return { deleted: true, rowIndex: index, sheetTitle: title };
  }
}

// Attempt to persist a generated license to the ledger WITHOUT ever throwing.
// A Google failure returns { synced:false, error } and leaves the record (token,
// licenseId, signature) completely untouched — the caller keeps the created key.
async function trySaveRecord(client, record, sheetTitle) {
  if (!record || !record.payload || !record.license) {
    return { synced: false, error: { code: 'BAD_RECORD', message: 'Thiếu dữ liệu khóa để đồng bộ.' } };
  }
  if (!client) return { synced: false, error: { code: 'GOOGLE_NOT_CONFIGURED', message: 'Chưa cấu hình Google Service Account.' } };
  try {
    // Route to the product's OWN worksheet (§16) — never a default/active tab.
    const res = await client.upsertLicenseRow({ payload: record.payload, license: record.license, metadata: record.metadata || {}, sheetTitle: sheetTitle || undefined });
    return { synced: true, action: res.action, sheetTitle: res.sheetTitle };
  } catch (e) {
    return { synced: false, error: { code: e.code || 'GOOGLE_ERROR', message: e.message } };
  }
}

// A1 column letter for a 1-based column number (1 -> A, 27 -> AA).
function columnLetter(n) {
  let s = '';
  let x = Number(n);
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s || 'A';
}

module.exports = {
  SPREADSHEET_ID,
  SHEET_ID,
  SHEET_HEADERS,
  DATE_COLUMNS,
  licenseToSheetRow,
  rowToValues,
  toCell,
  epochToSheetSerial,
  toEpochSeconds,
  columnLetter,
  resolveCredentialPath,
  loadServiceAccount,
  signServiceAccountJwt,
  GoogleSheetClient,
  trySaveRecord,
};
