import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLicenseLedger, resolveLedgerConfig, buildLedgerRecord, NoopLicenseLedger, GoogleSheetLicenseLedger, SYNC } = require('../../desktop/licensing/license-ledger.cjs');

const PAYLOAD = { v: 2, licenseId: 'LIC-ABC123', product: 'WVPT', gameProduct: 'PHOM', plan: 'STANDARD', machineId: 'WVPT-PC-AB12-CD34-EF56-7890', issuedAt: 1700000000, expiresAt: 1705000000, maxBrowsers: 5, maxConcurrentBrowsers: 2, features: { autoRun: true } };
const META = { customerName: 'QA Tester', phone: '090', note: 'dev', createdAt: '2026-01-01T00:00:00.000Z' };

// A fake Google client — records calls in-memory. NO network.
function fakeClientFactory(sink) {
  return () => ({
    upsertLicenseRow: async ({ metadata }) => { sink.calls.push(metadata.licenseId); sink.rows.set(metadata.licenseId, metadata); return { updated: true }; },
    findByLicenseId: async (id) => sink.rows.get(id) || null,
    verifyAccess: async () => ({ spreadsheetTitle: 'Ledger' }),
  });
}

// §4 — record schema carries gameProduct and never a secret.
test('buildLedgerRecord includes gameProduct + no secret material', () => {
  const rec = buildLedgerRecord({ payload: PAYLOAD, metadata: META, license: 'WVPT1.aaa.bbb', now: Date.parse('2026-02-02T00:00:00Z') });
  assert.equal(rec.gameProduct, 'PHOM');
  assert.equal(rec.licenseId, 'LIC-ABC123');
  assert.equal(rec.plan, 'STANDARD');
  assert.equal(rec.syncStatus, SYNC.PENDING);
  assert.ok(rec.payloadFingerprint && rec.payloadFingerprint.length === 32);
  const json = JSON.stringify(rec);
  assert.equal(/private|password|BEGIN|credential|refresh_token/i.test(json), false);
  // full license string must not be stored (only a fingerprint)
  assert.equal(/WVPT1\.aaa\.bbb/.test(json), false);
});

// §4 — missing config => Noop / NOT_CONFIGURED, zero network.
test('no config => NoopLicenseLedger, NOT_CONFIGURED, no network', async () => {
  const ledger = createLicenseLedger({ env: {}, clientFactory: null });
  assert.ok(ledger instanceof NoopLicenseLedger);
  const health = await ledger.healthCheck();
  assert.equal(health.status, SYNC.NOT_CONFIGURED);
  assert.equal(health.configured, false);
  const rec = buildLedgerRecord({ payload: PAYLOAD, metadata: META });
  const res = await ledger.upsertLicense(rec);
  assert.equal(res.status, SYNC.NOT_CONFIGURED);
  assert.equal(res.synced, false);
  // still queryable locally
  assert.equal((await ledger.findByLicenseId('LIC-ABC123')).licenseId, 'LIC-ABC123');
});

// §4 — enabled flag but missing spreadsheet/credential => still NOT_CONFIGURED (never fake SYNCED).
test('enabled but incomplete config never becomes fake SYNCED', async () => {
  const ledger = createLicenseLedger({ env: { GOOGLE_LICENSE_LEDGER_ENABLED: '1' }, clientFactory: () => ({}) });
  assert.ok(ledger instanceof NoopLicenseLedger);
  assert.notEqual((await ledger.upsertLicense(buildLedgerRecord({ payload: PAYLOAD }))).status, SYNC.SYNCED);
});

// §4 — fully configured => GoogleSheet ledger; idempotent upsert keyed by licenseId.
test('configured ledger upserts idempotently by licenseId (no duplicate rows)', async () => {
  const sink = { calls: [], rows: new Map() };
  const env = { GOOGLE_LICENSE_LEDGER_ENABLED: '1', GOOGLE_LICENSE_SPREADSHEET_ID: 'SHEET1', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' };
  const ledger = createLicenseLedger({ env, clientFactory: fakeClientFactory(sink) });
  assert.ok(ledger instanceof GoogleSheetLicenseLedger);
  const rec = buildLedgerRecord({ payload: PAYLOAD, metadata: META });
  const r1 = await ledger.upsertLicense(rec);
  const r2 = await ledger.upsertLicense(rec); // retry / re-generate same key
  assert.equal(r1.status, SYNC.SYNCED);
  assert.equal(r2.status, SYNC.SYNCED);
  assert.equal(sink.rows.size, 1, 'same licenseId must not create a second row');
  assert.equal(sink.calls.filter((x) => x === 'LIC-ABC123').length, 2);
});

// §4 — retryable failures are bounded then FAILED (typed); no infinite retry, no network fabrication.
test('bounded retry then typed FAILED on persistent error', async () => {
  let attempts = 0;
  const env = { GOOGLE_LICENSE_LEDGER_ENABLED: '1', GOOGLE_LICENSE_SPREADSHEET_ID: 'S', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json', GOOGLE_LICENSE_MAX_RETRIES: '2' };
  const ledger = createLicenseLedger({ env, clientFactory: () => ({ upsertLicenseRow: async () => { attempts++; const e = new Error('boom'); e.code = 'GOOGLE_API_ERROR'; throw e; } }) });
  const res = await ledger.upsertLicense(buildLedgerRecord({ payload: PAYLOAD }));
  assert.equal(res.synced, false);
  assert.equal(res.status, SYNC.FAILED);
  assert.equal(res.error.code, 'GOOGLE_API_ERROR');
  assert.equal(attempts, 3, '1 try + 2 retries');
});

// §4 — healthCheck on a configured ledger uses verifyAccess (fake), still zero real network.
test('configured healthCheck reports SYNCED via injected verifyAccess', async () => {
  const sink = { calls: [], rows: new Map() };
  const env = { GOOGLE_LICENSE_LEDGER_ENABLED: '1', GOOGLE_LICENSE_SPREADSHEET_ID: 'S', GOOGLE_APPLICATION_CREDENTIALS: '/tmp/sa.json' };
  const ledger = createLicenseLedger({ env, clientFactory: fakeClientFactory(sink) });
  assert.equal((await ledger.healthCheck()).status, SYNC.SYNCED);
});

test('resolveLedgerConfig maps env names', () => {
  const c = resolveLedgerConfig({ GOOGLE_LICENSE_LEDGER_ENABLED: '1', GOOGLE_LICENSE_SPREADSHEET_ID: 'X', GOOGLE_LICENSE_SHEET_NAME: 'Licenses', GOOGLE_APPLICATION_CREDENTIALS: '/c.json' });
  assert.equal(c.enabled, true); assert.equal(c.spreadsheetId, 'X'); assert.equal(c.sheetName, 'Licenses'); assert.equal(c.credentialsPath, '/c.json');
});
