import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { licenseToSheetRow, rowToValues, toCell, SHEET_HEADERS, epochToSheetSerial } = require('../../tools/license-generator/google-sheet.cjs');
const { buildLicensePayloadV2 } = require('../../desktop/licensing/entitlements.cjs');

function samplePayload() {
  return buildLicensePayloadV2({
    machineId: 'WVPT-PC-AB12-CD34-EF56-7890',
    plan: 'PRO',
    issuedAt: 1700000000,
    expiresAt: 1702592000,
    maxBrowsers: 20,
    maxConcurrentBrowsers: 10,
    features: { autoRun: true, jackpotLive: true, jackpotGate: false, roundHistory: true },
    licenseId: 'LIC-DEADBEEF',
  });
}

const TOKEN = 'WVPT1.eyJmYWtlIjp0cnVlfQ.c2lnbmF0dXJl';
const META = { customerName: 'Nguyễn A', phone: '0900000000', note: 'khách VIP', createdAt: '2026-09-10T10:00:00.000Z' };

test('every signed v2 field is mapped exactly (no reconstruction, no loss)', () => {
  const payload = samplePayload();
  const row = licenseToSheetRow({ payload, license: TOKEN, metadata: META });
  assert.equal(row.v === undefined, true); // schemaVersion carries v; there is no bare "v" column
  assert.equal(row.schemaVersion, payload.v);
  assert.equal(row.product, payload.product);
  assert.equal(row.licenseId, payload.licenseId);
  assert.equal(row.machineId, payload.machineId);
  assert.equal(row.plan, payload.plan);
  // Dates are stored as Google Sheets serials (UTC+7); exact epochs live in rawPayloadJson.
  assert.equal(row.issuedAt, epochToSheetSerial(payload.issuedAt));
  assert.equal(row.expiresAt, epochToSheetSerial(payload.expiresAt));
  assert.equal(JSON.parse(row.rawPayloadJson).issuedAt, payload.issuedAt);
  assert.equal(JSON.parse(row.rawPayloadJson).expiresAt, payload.expiresAt);
  assert.equal(row.maxBrowsers, payload.maxBrowsers);
  assert.equal(row.maxConcurrentBrowsers, payload.maxConcurrentBrowsers);
  assert.equal(row.autoRun, payload.features.autoRun);
  assert.equal(row.jackpotLive, payload.features.jackpotLive);
  assert.equal(row.jackpotGate, payload.features.jackpotGate);
  assert.equal(row.roundHistory, payload.features.roundHistory);
});

test('licenseKey stores the EXACT token, not a rebuilt one', () => {
  const row = licenseToSheetRow({ payload: samplePayload(), license: TOKEN, metadata: META });
  assert.equal(row.licenseKey, TOKEN);
});

test('management-only columns come from metadata and never touch the payload', () => {
  const payload = samplePayload();
  const before = JSON.stringify(payload);
  const row = licenseToSheetRow({ payload, license: TOKEN, metadata: META });
  assert.equal(row.customerName, 'Nguyễn A');
  assert.equal(row.phone, '0900000000');
  assert.equal(row.note, 'khách VIP');
  assert.equal(row.createdAt, epochToSheetSerial(Math.floor(Date.parse(META.createdAt) / 1000)));
  // payload must be unmutated and must not have acquired management fields
  assert.equal(JSON.stringify(payload), before);
  assert.equal('customerName' in payload, false);
  assert.equal('phone' in payload, false);
  assert.equal('note' in payload, false);
});

test('rowToValues is header-aligned, complete, and stringifies booleans as TRUE/FALSE', () => {
  const row = licenseToSheetRow({ payload: samplePayload(), license: TOKEN, metadata: META });
  const values = rowToValues(row);
  assert.equal(values.length, SHEET_HEADERS.length);
  const idx = (h) => SHEET_HEADERS.indexOf(h);
  assert.equal(values[idx('licenseId')], 'LIC-DEADBEEF');
  assert.equal(values[idx('autoRun')], 'TRUE');
  assert.equal(values[idx('jackpotGate')], 'FALSE');
  assert.equal(values[idx('schemaVersion')], '2');
  assert.equal(values[idx('licenseKey')], TOKEN);
  // date columns are numeric serials (not stringified), so Sheets renders them as dates
  assert.equal(typeof values[idx('issuedAt')], 'number');
  assert.equal(values[idx('issuedAt')], epochToSheetSerial(samplePayload().issuedAt));
});

test('rawPayloadJson round-trips to the exact signed payload', () => {
  const payload = samplePayload();
  const row = licenseToSheetRow({ payload, license: TOKEN, metadata: META });
  assert.deepEqual(JSON.parse(row.rawPayloadJson), payload);
});

test('createdAt defaults to a Sheets date serial (now) when metadata omits it', () => {
  const row = licenseToSheetRow({ payload: samplePayload(), license: TOKEN, metadata: {} });
  assert.equal(typeof row.createdAt, 'number');
  assert.ok(row.createdAt > 40000, 'a plausible modern serial date'); // ~2009+
});

test('toCell renders booleans and null deterministically', () => {
  assert.equal(toCell(true), 'TRUE');
  assert.equal(toCell(false), 'FALSE');
  assert.equal(toCell(null), '');
  assert.equal(toCell(7), '7');
});
