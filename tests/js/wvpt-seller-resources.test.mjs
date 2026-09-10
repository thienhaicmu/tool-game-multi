import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveSellerResources } = require('../../tools/license-generator/seller-resources.cjs');
const { SPREADSHEET_ID, SHEET_ID } = require('../../tools/license-generator/google-sheet.cjs');

test('packaged mode resolves both secrets under process.resourcesPath/private', () => {
  const R = resolveSellerResources({ isPackaged: true, resourcesPath: '/opt/app/resources', dirname: '/src/gen', env: {} });
  assert.equal(R.privateKeyPath, path.join('/opt/app/resources', 'private', 'wvpt-ed25519-private.pem'));
  assert.equal(R.googleCredentialPath, path.join('/opt/app/resources', 'private', 'google-service-account.json'));
  assert.equal(R.spreadsheetId, SPREADSHEET_ID);
  assert.equal(R.sheetId, SHEET_ID);
});

test('dev mode resolves both secrets under the generator source dir', () => {
  const D = resolveSellerResources({ isPackaged: false, resourcesPath: '/opt/app/resources', dirname: '/src/gen', env: {} });
  assert.equal(D.privateKeyPath, path.join('/src/gen', 'private', 'wvpt-ed25519-private.pem'));
  assert.equal(D.googleCredentialPath, path.join('/src/gen', 'private', 'google-service-account.json'));
});

test('dev env overrides are honored (developer convenience)', () => {
  const E = resolveSellerResources({ isPackaged: false, dirname: '/src/gen', env: { WVPT_GOOGLE_SERVICE_ACCOUNT: '/tmp/c.json', WVPT_PRIVATE_KEY_PATH: '/tmp/k.pem' } });
  assert.equal(E.googleCredentialPath, '/tmp/c.json');
  assert.equal(E.privateKeyPath, '/tmp/k.pem');
});

test('PACKAGED production ignores env overrides (self-contained, PRODUCTION_ENV_REQUIRED=NO)', () => {
  const P = resolveSellerResources({ isPackaged: true, resourcesPath: '/opt/app/resources', env: { WVPT_GOOGLE_SERVICE_ACCOUNT: '/tmp/hijack.json', WVPT_PRIVATE_KEY_PATH: '/tmp/hijack.pem' } });
  assert.equal(P.googleCredentialPath, path.join('/opt/app/resources', 'private', 'google-service-account.json'));
  assert.equal(P.privateKeyPath, path.join('/opt/app/resources', 'private', 'wvpt-ed25519-private.pem'));
});

test('packaged resource layout resolves to files that actually exist (fixture, NOT real secrets)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wvpt-fixture-'));
  const priv = path.join(root, 'private');
  fs.mkdirSync(priv, { recursive: true });
  fs.writeFileSync(path.join(priv, 'wvpt-ed25519-private.pem'), '-----BEGIN PRIVATE KEY-----\nFIXTURE\n-----END PRIVATE KEY-----\n');
  fs.writeFileSync(path.join(priv, 'google-service-account.json'), JSON.stringify({ client_email: 'fixture@x.iam', private_key: 'FIXTURE' }));
  try {
    const R = resolveSellerResources({ isPackaged: true, resourcesPath: root, env: {} });
    assert.equal(fs.existsSync(R.privateKeyPath), true, 'PACKAGED_SIGNING_RESOURCE_RESOLVES');
    assert.equal(fs.existsSync(R.googleCredentialPath), true, 'PACKAGED_GOOGLE_RESOURCE_RESOLVES');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
