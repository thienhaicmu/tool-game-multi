// Generator local key/user store (added alongside the Google Sheet): CRUD + search + users grouping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createKeyStore } = require('../../tools/license-generator/key-store.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'genstore-')); }
const entry = (over = {}) => ({ licenseId: 'LIC-' + Math.random().toString(36).slice(2, 8), gameProduct: 'PHOM', plan: 'PRO', machineId: 'WVPT-PC-1111-2222-3333-4444', customerName: 'Khách A', phone: '0900', note: '', issuedAt: 1700000000, expiresAt: 1800000000, maxBrowsers: 5, maxConcurrentBrowsers: 5, features: { autoRun: true }, license: 'WVPT2.x.y', ...over });

test('key-store: add / list / search / status / delete, persisted', () => {
  const dir = tmp();
  const store = createKeyStore({ dir });
  store.add(entry({ licenseId: 'A', customerName: 'An' }));
  store.add(entry({ licenseId: 'B', customerName: 'Bình', gameProduct: 'AVIATOR' }));
  assert.equal(store.list().length, 2);
  assert.equal(store.list()[0].licenseId, 'B', 'newest first');
  assert.equal(store.list({ q: 'an' }).length, 1);
  assert.equal(store.list({ q: 'aviator' }).length, 1);
  assert.deepEqual(store.setStatus('A', 'REVOKED', 'hết thuê'), { ok: true, found: true });
  assert.equal(store.get('A').status, 'REVOKED');
  assert.equal(store.list({ status: 'ACTIVE' }).length, 1);
  assert.equal(createKeyStore({ dir }).list().length, 2, 'persisted across reload');
  assert.deepEqual(store.remove('A'), { ok: true, found: true });
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.remove('Z'), { ok: false, found: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key-store: users groups by customer, counts active, keeps phone', () => {
  const dir = tmp();
  const store = createKeyStore({ dir });
  store.add(entry({ licenseId: 'K1', customerName: 'An', phone: '0911' }));
  store.add(entry({ licenseId: 'K2', customerName: 'An', phone: '' }));
  store.add(entry({ licenseId: 'K3', customerName: 'Bình' }));
  store.setStatus('K1', 'REVOKED');
  const an = store.users().find((u) => u.name === 'An');
  assert.equal(an.keyCount, 2);
  assert.equal(an.activeCount, 1);
  assert.equal(an.phone, '0911');
  assert.equal(store.stats().users, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
