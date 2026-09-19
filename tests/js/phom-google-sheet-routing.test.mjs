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

// ---------------------------------------------------------------------------
// LEDGER FORMATTING. Two symptoms with ONE cause: Sheets copies the format of the row ABOVE onto a row
// inserted by append, so every data row inherited the dark bold HEADER style, and that same inheritance
// overwrote the date columns' DATE_TIME format so the serials rendered as raw numbers (46279,77228).
// Formatting therefore has to be re-applied after every write, not once when the header row is created.
// ---------------------------------------------------------------------------

// A transport that records the batchUpdate REQUESTS (not just that a batch happened), and lets a sheet
// pretend it already has a header row — the state the PHOM tab was actually in.
function formatTransport({ existingHeaders = null } = {}) {
  const batches = [];
  const writes = [];
  async function request(url, { method = 'GET', body = null } = {}) {
    if (url.includes('oauth2.googleapis.com/token')) return { status: 200, json: { access_token: 'tok', expires_in: 3600 } };
    if (/\/spreadsheets\/[^/]+\?fields=/.test(url)) {
      return { status: 200, json: { properties: { title: 'Ledger' }, sheets: [
        { properties: { sheetId: 0, title: AVIATOR } },
        { properties: { sheetId: 123, title: PHOM } },
      ] } };
    }
    if (url.includes(':batchUpdate')) {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      batches.push(...((parsed && parsed.requests) || []));
      return { status: 200, json: {} };
    }
    if (method === 'GET') {
      const isHeaderRead = decodeURIComponent(url).includes('!1:1');
      return { status: 200, json: { values: isHeaderRead && existingHeaders ? [existingHeaders] : [] } };
    }
    writes.push({ method, append: url.includes(':append') });
    return { status: 200, json: {} };
  }
  request.batches = batches; request.writes = writes;
  return request;
}

const repeats = (req) => req.batches.filter((r) => r.repeatCell).map((r) => r.repeatCell);
const dataRowStyle = (req) => repeats(req).find((r) => r.range.startRowIndex === 1 && r.range.startColumnIndex == null && /backgroundColor/.test(r.fields));
const headerStyle = (req) => repeats(req).find((r) => r.range.startRowIndex === 0 && r.range.endRowIndex === 1 && /backgroundColor/.test(r.fields));

test('LEDGER-FMT-01: a sheet that ALREADY has headers still gets formatted (the PHOM tab case)', async () => {
  const { SHEET_HEADERS } = require('../../tools/license-generator/google-sheet.cjs');
  const request = formatTransport({ existingHeaders: SHEET_HEADERS.slice() });
  await client(request).upsertLicenseRow({ payload, license: 'WVPT1.a.b', metadata: {}, sheetTitle: PHOM });
  assert.ok(request.batches.length > 0, 'formatting ran even though the header row already existed');
  assert.ok(headerStyle(request), 'header style applied');
});

test('LEDGER-FMT-02: date columns get a DATE_TIME format, so serials never render as raw numbers', async () => {
  const { SHEET_HEADERS, DATE_COLUMNS } = require('../../tools/license-generator/google-sheet.cjs');
  const request = formatTransport({ existingHeaders: SHEET_HEADERS.slice() });
  await client(request).upsertLicenseRow({ payload, license: 'WVPT1.a.b', metadata: {}, sheetTitle: PHOM });
  for (const h of DATE_COLUMNS) {
    const idx = SHEET_HEADERS.indexOf(h);
    const r = repeats(request).find((x) => x.range.startColumnIndex === idx && x.range.endColumnIndex === idx + 1 && /numberFormat/.test(x.fields));
    assert.ok(r, `${h} has a number-format request`);
    assert.equal(r.cell.userEnteredFormat.numberFormat.type, 'DATE_TIME');
    assert.equal(r.cell.userEnteredFormat.numberFormat.pattern, 'dd/mm/yyyy hh:mm');
    assert.equal(r.range.startRowIndex, 1, 'applies to the data rows, never the header');
  }
});

test('LEDGER-FMT-03: data rows are reset to plain white, undoing the header style append copies down', async () => {
  const { SHEET_HEADERS } = require('../../tools/license-generator/google-sheet.cjs');
  const request = formatTransport({ existingHeaders: SHEET_HEADERS.slice() });
  await client(request).upsertLicenseRow({ payload, license: 'WVPT1.a.b', metadata: {}, sheetTitle: PHOM });

  const data = dataRowStyle(request);
  assert.ok(data, 'the data rows get an explicit style reset');
  assert.deepEqual(data.cell.userEnteredFormat.backgroundColor, { red: 1, green: 1, blue: 1 }, 'white, not the header navy');
  assert.equal(data.cell.userEnteredFormat.textFormat.bold, false);
  assert.equal(data.range.endRowIndex, undefined, 'unbounded: covers rows appended later too');

  const head = headerStyle(request);
  assert.notDeepEqual(head.cell.userEnteredFormat.backgroundColor, data.cell.userEnteredFormat.backgroundColor,
    'the header keeps its own distinct colour');
  // the reset must not clear the date formats — it only touches colour/weight/alignment
  assert.equal(/numberFormat/.test(data.fields), false);
});

test('LEDGER-FMT-04: formatting re-runs after EVERY write, since each append re-inherits the header style', async () => {
  const { SHEET_HEADERS } = require('../../tools/license-generator/google-sheet.cjs');
  const request = formatTransport({ existingHeaders: SHEET_HEADERS.slice() });
  const c = client(request);
  await c.upsertLicenseRow({ payload, license: 'WVPT1.a.b', metadata: {}, sheetTitle: PHOM });
  const afterFirst = request.batches.length;
  await c.upsertLicenseRow({ payload: { ...payload, licenseId: 'LIC-SECOND1' }, license: 'WVPT1.c.d', metadata: {}, sheetTitle: PHOM });
  assert.ok(request.batches.length > afterFirst, 'the second save formats again rather than leaving the new row styled as a header');
});

test('LEDGER-FMT-05: a formatting failure never loses a license that was already written', async () => {
  const { SHEET_HEADERS } = require('../../tools/license-generator/google-sheet.cjs');
  const base = formatTransport({ existingHeaders: SHEET_HEADERS.slice() });
  const request = async (url, opts) => {
    if (url.includes(':batchUpdate')) return { status: 500, json: { error: { message: 'boom' } } };
    return base(url, opts);
  };
  const res = await client(request).upsertLicenseRow({ payload, license: 'WVPT1.a.b', metadata: {}, sheetTitle: PHOM });
  assert.equal(res.action, 'appended', 'the row write still counts as a success');
  assert.equal(res.sheetTitle, PHOM);
});
