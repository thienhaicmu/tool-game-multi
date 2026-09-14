import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sheetsForProduct, buildLedgerRecord, MultiSheetGoogleLicenseLedger, createLicenseLedger, SYNC } = require('../../desktop/licensing/license-ledger.cjs');

const AVIATOR_SHEET = 'Aviator License Management';
const PHOM_SHEET = 'PHOM License Management';

function config(extra = {}) {
  return { enabled: true, spreadsheetId: 'SS', credentialsPath: '/x/creds.json', aviatorSheetName: AVIATOR_SHEET, phomSheetName: PHOM_SHEET, timeoutMs: 1000, maxRetries: 2, ...extra };
}

// A fake per-sheet client. Records every upsert by (sheetTitle -> [licenseId...]) so a
// test can assert routing + idempotency. No network — LIVE_CALL_COUNT stays 0.
function fakeClientFactory({ failSheets = new Set(), failOnce = new Set() } = {}) {
  const rows = { [AVIATOR_SHEET]: [], [PHOM_SHEET]: [] };
  const calls = [];
  const factory = () => ({
    async upsertLicenseRow({ metadata, sheetTitle }) {
      calls.push(sheetTitle);
      if (failSheets.has(sheetTitle)) { const e = new Error('GOOGLE_API_ERROR'); e.code = 'GOOGLE_API_ERROR'; throw e; }
      if (failOnce.has(sheetTitle)) { failOnce.delete(sheetTitle); const e = new Error('GOOGLE_TIMEOUT'); e.code = 'GOOGLE_TIMEOUT'; throw e; }
      const list = rows[sheetTitle] || (rows[sheetTitle] = []);
      const idx = list.findIndex((r) => r.licenseId === metadata.licenseId);
      if (idx >= 0) list[idx] = metadata; else list.push({ licenseId: metadata.licenseId, gameProduct: metadata.gameProduct });
      return { sheetTitle, licenseId: metadata.licenseId };
    },
  });
  factory.rows = rows;
  factory.calls = calls;
  return factory;
}

function rec(gameProduct, licenseId = 'LIC-ABCDEF01') {
  return buildLedgerRecord({ payload: { licenseId, gameProduct, product: 'WVPT', machineId: 'WVPT-PC-AAAA-BBBB-CCCC-DDDD', issuedAt: 1, expiresAt: 2, plan: 'STANDARD' } });
}

// ---- pure routing: exactly ONE destination per product; ALL is gone (§16) ----
test('sheetsForProduct routes to a SINGLE sheet by title (no ALL fan-out)', () => {
  const c = config();
  assert.deepEqual(sheetsForProduct('AVIATOR', c), [AVIATOR_SHEET]);
  assert.deepEqual(sheetsForProduct('PHOM', c), [PHOM_SHEET]);
  assert.deepEqual(sheetsForProduct(undefined, c), [AVIATOR_SHEET]); // legacy -> Aviator
  assert.deepEqual(sheetsForProduct('ALL', c), [AVIATOR_SHEET]);     // ALL no longer fans out
  assert.deepEqual(sheetsForProduct('POKER', c), [AVIATOR_SHEET]);   // unknown -> Aviator
});

test('AVIATOR license writes ONLY the Aviator sheet', async () => {
  const factory = fakeClientFactory();
  const ledger = new MultiSheetGoogleLicenseLedger({ config: config(), clientFactory: factory });
  const r = await ledger.upsertLicense(rec('AVIATOR', 'LIC-0000AA01'));
  assert.equal(r.status, SYNC.SYNCED);
  assert.equal(factory.rows[AVIATOR_SHEET].length, 1);
  assert.equal(factory.rows[PHOM_SHEET].length, 0);
  assert.deepEqual(factory.calls, [AVIATOR_SHEET]); // exactly one client call, correct title
});

test('PHOM license writes ONLY the PHOM sheet', async () => {
  const factory = fakeClientFactory();
  const ledger = new MultiSheetGoogleLicenseLedger({ config: config(), clientFactory: factory });
  const r = await ledger.upsertLicense(rec('PHOM', 'LIC-0000BB01'));
  assert.equal(r.status, SYNC.SYNCED);
  assert.equal(factory.rows[PHOM_SHEET].length, 1);
  assert.equal(factory.rows[AVIATOR_SHEET].length, 0);
  assert.deepEqual(factory.calls, [PHOM_SHEET]);
});

test('a license never cross-writes to the other product sheet', async () => {
  const factory = fakeClientFactory();
  const ledger = new MultiSheetGoogleLicenseLedger({ config: config(), clientFactory: factory });
  await ledger.upsertLicense(rec('PHOM', 'LIC-PHOM0001'));
  await ledger.upsertLicense(rec('AVIATOR', 'LIC-AVIA0001'));
  assert.equal(factory.rows[PHOM_SHEET].some((r) => r.licenseId === 'LIC-AVIA0001'), false);
  assert.equal(factory.rows[AVIATOR_SHEET].some((r) => r.licenseId === 'LIC-PHOM0001'), false);
});

test('single-sheet upsert is idempotent by licenseId (no duplicate on retry)', async () => {
  const factory = fakeClientFactory();
  const ledger = new MultiSheetGoogleLicenseLedger({ config: config(), clientFactory: factory });
  await ledger.upsertLicense(rec('PHOM', 'LIC-DUP00001'));
  await ledger.upsertLicense(rec('PHOM', 'LIC-DUP00001'));
  assert.equal(factory.rows[PHOM_SHEET].length, 1);
});

test('destination sheet failure => FAILED (SYNCED only when the one sheet succeeds)', async () => {
  const factory = fakeClientFactory({ failSheets: new Set([PHOM_SHEET]) });
  const ledger = new MultiSheetGoogleLicenseLedger({ config: config({ maxRetries: 0 }), clientFactory: factory });
  const r = await ledger.upsertLicense(rec('PHOM', 'LIC-FAIL0001'));
  assert.equal(r.status, SYNC.FAILED);
  assert.equal(r.synced, false);
  assert.equal(factory.rows[PHOM_SHEET].length, 0);
  assert.equal(factory.rows[AVIATOR_SHEET].length, 0); // never falls back to the other sheet
});

test('retry re-attempts the SAME destination sheet (bounded retry)', async () => {
  const factory = fakeClientFactory({ failOnce: new Set([PHOM_SHEET]) });
  const ledger = new MultiSheetGoogleLicenseLedger({ config: config({ maxRetries: 2 }), clientFactory: factory });
  const r = await ledger.upsertLicense(rec('PHOM', 'LIC-RETRY001'));
  assert.equal(r.status, SYNC.SYNCED); // first attempt timed out, retry succeeded
  assert.equal(factory.rows[PHOM_SHEET].length, 1);
});

test('createLicenseLedger picks MultiSheet when product sheet titles are configured', () => {
  const env = { GOOGLE_LICENSE_LEDGER_ENABLED: '1', GOOGLE_LICENSE_SPREADSHEET_ID: 'SS', GOOGLE_APPLICATION_CREDENTIALS: '/x.json', GOOGLE_LICENSE_AVIATOR_SHEET_NAME: AVIATOR_SHEET, GOOGLE_LICENSE_PHOM_SHEET_NAME: PHOM_SHEET };
  const ledger = createLicenseLedger({ env, clientFactory: fakeClientFactory() });
  assert.equal(ledger instanceof MultiSheetGoogleLicenseLedger, true);
  assert.equal(ledger.configured(), true);
});

test('unconfigured ledger returns NOT_CONFIGURED (no network)', async () => {
  const ledger = new MultiSheetGoogleLicenseLedger({ config: { enabled: false }, clientFactory: fakeClientFactory() });
  assert.equal(ledger.configured(), false);
  const r = await ledger.upsertLicense(rec('PHOM'));
  assert.equal(r.status, SYNC.NOT_CONFIGURED);
});
