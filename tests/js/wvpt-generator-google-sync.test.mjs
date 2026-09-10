import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  GoogleSheetClient, trySaveRecord, SHEET_HEADERS, columnLetter, resolveCredentialPath, signServiceAccountJwt,
} = require('../../tools/license-generator/google-sheet.cjs');
const { buildLicensePayloadV2 } = require('../../desktop/licensing/entitlements.cjs');

// ---- an in-memory Google Sheets v4 REST fake (values + metadata + batchUpdate) ----
function rowIndexOf(a1) {
  const first = String(a1).split(':')[0];
  const m = first.match(/([A-Z]+)(\d+)/);
  return m ? Number(m[2]) : 1;
}
function makeFakeSheets({ metadataStatus = 200 } = {}) {
  const state = { grid: [] };
  async function request(url, opts = {}) {
    const method = opts.method || 'GET';
    if (url === 'https://oauth2.googleapis.com/token') {
      return { status: 200, json: { access_token: 'fake', expires_in: 3600 } };
    }
    if (url.includes(':batchUpdate')) {
      for (const r of JSON.parse(opts.body).requests) {
        if (r.deleteDimension) {
          const { startIndex, endIndex } = r.deleteDimension.range;
          state.grid.splice(startIndex, endIndex - startIndex);
        }
      }
      return { status: 200, json: {} };
    }
    if (url.includes(':append')) {
      for (const row of JSON.parse(opts.body).values) state.grid.push(row.slice());
      return { status: 200, json: {} };
    }
    if (!url.includes('/values/')) {
      if (metadataStatus !== 200) return { status: metadataStatus, json: { error: { message: 'The caller does not have permission' } } };
      return { status: 200, json: { properties: { title: 'Aviator License Management' }, sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] } };
    }
    const encRange = url.split('/values/')[1].split('?')[0];
    const a1 = decodeURIComponent(encRange).split('!')[1];
    if (method === 'PUT') {
      state.grid[rowIndexOf(a1) - 1] = JSON.parse(opts.body).values[0].slice();
      return { status: 200, json: {} };
    }
    if (a1 === '1:1') return { status: 200, json: { values: state.grid[0] ? [state.grid[0]] : [] } };
    if (a1 === 'A2:A') return { status: 200, json: { values: state.grid.slice(1).map((r) => [r[0]]) } };
    return { status: 200, json: { values: [] } };
  }
  return { state, request };
}

// Real RSA key so the RS256 JWT signing (which runs before the mocked HTTP call) works.
const { privateKey: SA_KEY } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { client_email: 'x@y.iam.gserviceaccount.com', private_key: SA_KEY.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
function record(licenseId, meta = {}) {
  const payload = buildLicensePayloadV2({
    machineId: 'WVPT-PC-AB12-CD34-EF56-7890', plan: 'STANDARD', issuedAt: 1700000000, expiresAt: 1702592000,
    maxBrowsers: 5, maxConcurrentBrowsers: 2,
    features: { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true }, licenseId,
  });
  return { payload, license: `WVPT1.${licenseId}.sig`, metadata: { customerName: 'C', createdAt: '2026-09-10T00:00:00.000Z', ...meta } };
}
const dataRows = (state) => state.grid.slice(1);
const rowsWithLicenseId = (state, id) => dataRows(state).filter((r) => r[0] === id);

test('header row is created exactly once, never duplicated', async () => {
  const fake = makeFakeSheets();
  const client = new GoogleSheetClient({ serviceAccount: SA, request: fake.request });
  const a = await client.ensureHeaders();
  const b = await client.ensureHeaders();
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.deepEqual(fake.state.grid[0], SHEET_HEADERS.slice());
  assert.equal(fake.state.grid.length, 1); // header only, no data rows
});

test('upsert by licenseId is idempotent — same license twice = 1 data row', async () => {
  const fake = makeFakeSheets();
  const client = new GoogleSheetClient({ serviceAccount: SA, request: fake.request });
  const rec = record('LIC-AAAA1111');
  const first = await client.upsertLicenseRow(rec);
  const second = await client.upsertLicenseRow(rec);
  assert.equal(first.action, 'appended');
  assert.equal(second.action, 'updated');
  assert.equal(rowsWithLicenseId(fake.state, 'LIC-AAAA1111').length, 1);
  assert.equal(dataRows(fake.state).length, 1);
});

test('different licenseIds append distinct rows', async () => {
  const fake = makeFakeSheets();
  const client = new GoogleSheetClient({ serviceAccount: SA, request: fake.request });
  await client.upsertLicenseRow(record('LIC-AAAA1111'));
  await client.upsertLicenseRow(record('LIC-BBBB2222'));
  assert.equal(dataRows(fake.state).length, 2);
});

test('sync failure never loses the license; retry with the SAME record succeeds without regeneration', async () => {
  const denied = makeFakeSheets({ metadataStatus: 403 });
  const client403 = new GoogleSheetClient({ serviceAccount: SA, request: denied.request });
  const rec = record('LIC-CCCC3333');
  const beforeLicense = rec.license;
  const beforeId = rec.payload.licenseId;

  const fail = await trySaveRecord(client403, rec);
  assert.equal(fail.synced, false);
  assert.ok(fail.error && fail.error.message);
  // the record is untouched — key remains available, same identity
  assert.equal(rec.license, beforeLicense);
  assert.equal(rec.payload.licenseId, beforeId);

  // retry against a working sheet using the SAME record
  const ok = makeFakeSheets();
  const clientOk = new GoogleSheetClient({ serviceAccount: SA, request: ok.request });
  const retry = await trySaveRecord(clientOk, rec);
  assert.equal(retry.synced, true);
  assert.equal(retry.action, 'appended');
  assert.equal(rowsWithLicenseId(ok.state, 'LIC-CCCC3333').length, 1);
  // retry did not mutate identity
  assert.equal(rec.license, beforeLicense);
  assert.equal(rec.payload.licenseId, beforeId);
});

test('trySaveRecord degrades gracefully with no client / bad record', async () => {
  const noClient = await trySaveRecord(null, record('LIC-DDDD4444'));
  assert.equal(noClient.synced, false);
  assert.equal(noClient.error.code, 'GOOGLE_NOT_CONFIGURED');
  const badRecord = await trySaveRecord({}, { payload: null, license: null });
  assert.equal(badRecord.synced, false);
  assert.equal(badRecord.error.code, 'BAD_RECORD');
});

test('columnLetter maps the header count to a valid last column', () => {
  assert.equal(columnLetter(1), 'A');
  assert.equal(columnLetter(19), 'S');
  assert.equal(columnLetter(27), 'AA');
});

test('credential precedence: explicit path > env > remembered path', () => {
  assert.equal(resolveCredentialPath({ explicitPath: 'X', env: { WVPT_GOOGLE_SERVICE_ACCOUNT: 'Y' }, rememberedPath: 'Z' }), 'X');
  assert.equal(resolveCredentialPath({ env: { WVPT_GOOGLE_SERVICE_ACCOUNT: 'Y' }, rememberedPath: 'Z' }), 'Y');
  assert.equal(resolveCredentialPath({ env: {}, rememberedPath: 'Z' }), 'Z');
  assert.equal(resolveCredentialPath({ env: {} }), null);
});

test('service-account JWT is a valid RS256 assertion (verifiable, correct claims)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
  const jwt = signServiceAccountJwt(sa, 1700000000);
  const [h, p, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  assert.equal(header.alg, 'RS256');
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
  assert.equal(claims.aud, sa.token_uri);
  assert.equal(claims.exp - claims.iat, 3600);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});
