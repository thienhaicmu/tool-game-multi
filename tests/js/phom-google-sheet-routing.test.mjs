import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GoogleSheetClient } = require('../../desktop/licensing/../../tools/license-generator/google-sheet.cjs');

const AVIATOR = 'Aviator License Management';
const PHOM = 'PHOM License Management';

// A service account with a REAL RSA key so the client's RS256 JWT actually signs (the
// fake transport returns a token). No network — `request` is injected.
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  client_email: 'license-generator@aviator-license-management.iam.gserviceaccount.com',
  private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
};

// A stateful fake Sheets transport that records every write and the sheet title it hit.
function fakeTransport() {
  const writes = []; // { method, title, kind }
  const reads = [];
  async function request(url, { method = 'GET', body = null } = {}) {
    if (url.includes('oauth2.googleapis.com/token')) return { status: 200, json: { access_token: 'tok', expires_in: 3600 } };
    // spreadsheet metadata (sheet titles + gids)
    if (/\/spreadsheets\/[^/]+\?fields=/.test(url)) {
      return { status: 200, json: { properties: { title: 'Ledger' }, sheets: [
        { properties: { sheetId: 0, title: AVIATOR } },
        { properties: { sheetId: 123, title: PHOM } },
      ] } };
    }
    const titleMatch = decodeURIComponent(url).match(/\/values\/([^!]+)!/);
    const title = titleMatch ? titleMatch[1] : null;
    if (method === 'GET') { reads.push({ title }); return { status: 200, json: { values: [] } }; } // empty sheet
    if (url.includes(':append')) { writes.push({ method: 'append', title }); return { status: 200, json: {} }; }
    if (url.includes(':batchUpdate')) { writes.push({ method: 'batchUpdate', title: 'BATCH' }); return { status: 200, json: {} }; }
    writes.push({ method, title }); // PUT (headers/update)
    return { status: 200, json: {} };
  }
  request.writes = writes; request.reads = reads;
  return request;
}

function client(request) { return new GoogleSheetClient({ serviceAccount, spreadsheetId: 'SS', sheetId: 0, request }); }
const payload = { v: 2, product: 'WVPT', gameProduct: 'PHOM', licenseId: 'LIC-ABC12345', machineId: 'WVPT-PC-AB12-CD34-EF56-7890', issuedAt: 1, expiresAt: 2, plan: 'STANDARD', maxBrowsers: 5, maxConcurrentBrowsers: 2, features: { autoRun: true, jackpotLive: true, jackpotGate: false, roundHistory: true } };

test('upsertLicenseRow writes to the EXACT sheetTitle passed (routing by title)', async () => {
  const request = fakeTransport();
  const c = client(request);
  const res = await c.upsertLicenseRow({ payload, license: 'WVPT1.a.b', metadata: {}, sheetTitle: PHOM });
  assert.equal(res.sheetTitle, PHOM);
  // every append/PUT (non-batch) row-write must target the PHOM sheet, never Aviator.
  const rowWrites = request.writes.filter((w) => w.title && w.title !== 'BATCH');
  assert.ok(rowWrites.length >= 1);
  assert.ok(rowWrites.every((w) => w.title === PHOM), `all row writes hit PHOM: ${JSON.stringify(rowWrites)}`);
  assert.equal(rowWrites.some((w) => w.title === AVIATOR), false);
});

test('AVIATOR routing hits ONLY the Aviator sheet', async () => {
  const request = fakeTransport();
  const c = client(request);
  await c.upsertLicenseRow({ payload: { ...payload, gameProduct: 'AVIATOR' }, license: 'WVPT1.a.b', metadata: {}, sheetTitle: AVIATOR });
  const rowWrites = request.writes.filter((w) => w.title && w.title !== 'BATCH');
  assert.ok(rowWrites.every((w) => w.title === AVIATOR));
  assert.equal(rowWrites.some((w) => w.title === PHOM), false);
});

test('findByLicenseId reads from the SAME title (never cross-sheet)', async () => {
  const request = fakeTransport();
  const c = client(request);
  await c.findByLicenseId('LIC-ABC12345', PHOM);
  assert.ok(request.reads.length >= 1);
  assert.ok(request.reads.every((r) => r.title === PHOM));
});

test('a missing worksheet title is a typed error (never redirected)', async () => {
  const request = fakeTransport();
  const c = client(request);
  await assert.rejects(
    () => c.upsertLicenseRow({ payload, license: 'WVPT1.a.b', metadata: {}, sheetTitle: 'No Such Sheet' }),
    (e) => e.code === 'GOOGLE_SHEET_NOT_FOUND',
  );
  // and NOTHING was written anywhere.
  assert.equal(request.writes.filter((w) => w.title && w.title !== 'BATCH').length, 0);
});

test('verifyAccess resolves BOTH product sheet titles', async () => {
  const request = fakeTransport();
  const c = client(request);
  const r = await c.verifyAccess({ sheetTitles: [AVIATOR, PHOM] });
  assert.deepEqual(r.sheets.map((s) => s.title).sort(), [AVIATOR, PHOM].sort());
});
