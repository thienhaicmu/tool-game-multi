import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wvpt-reg-')); }
function makeRegistry(root, entitlement) {
  return new BrowserRegistry({
    filePath: path.join(root, 'browser-registry.json'),
    profilesRoot: path.join(root, 'browser-profiles'),
    entitlement: entitlement || (() => ({ maxBrowsers: null })),
    now: () => 1_700_000_000_000,
  });
}

// A. create → registry contains it.
test('A: create allocates B-0001 and persists it', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root);
  reg.load();
  const r = reg.create({ name: 'Main', launchUrl: 'https://game.test/a' });
  assert.equal(r.browser.id, 'B-0001');
  assert.equal(reg.count(), 1);
  assert.ok(fs.existsSync(path.join(root, 'browser-registry.json')));
});

// B. second browser → different, stable profileDir.
test('B: two browsers never share a profileDir', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const a = reg.create({ name: 'A', launchUrl: 'https://a.test' }).browser;
  const b = reg.create({ name: 'B', launchUrl: 'https://b.test' }).browser;
  assert.equal(a.id, 'B-0001');
  assert.equal(b.id, 'B-0002');
  assert.notEqual(a.profileDir, b.profileDir);
  assert.ok(a.profileDir.endsWith(path.join('browser-profiles', 'B-0001')));
  assert.ok(b.profileDir.endsWith(path.join('browser-profiles', 'B-0002')));
});

// C + D. reload from disk → identical identities/urls/profileDirs, stable ids.
test('C/D: reloading from disk preserves ids, urls and profileDirs', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const a = reg.create({ name: 'A', launchUrl: 'https://a.test' }).browser;
  const b = reg.create({ name: 'B', launchUrl: 'https://b.test' }).browser;

  const reg2 = makeRegistry(root);
  assert.equal(reg2.load().ok, true);
  const list = reg2.list();
  assert.deepEqual(list.map((x) => x.id), ['B-0001', 'B-0002']);
  assert.equal(reg2.get('B-0001').launchUrl, a.launchUrl);
  assert.equal(reg2.get('B-0001').profileDir, a.profileDir);
  assert.equal(reg2.get('B-0002').profileDir, b.profileDir);
});

// J/35. monotonic ids — not reused after deletion.
test('J: next id is monotonic and not reused after deletion', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  reg.create({ name: 'A', launchUrl: 'https://a.test' });
  const b = reg.create({ name: 'B', launchUrl: 'https://b.test' }).browser;
  reg.create({ name: 'C', launchUrl: 'https://c.test' });
  assert.equal(reg.remove(b.id).ok, true);              // delete B-0002
  const d = reg.create({ name: 'D', launchUrl: 'https://d.test' }).browser;
  assert.equal(d.id, 'B-0004', 'never reuse B-0002');
  // survives reload too
  const reg2 = makeRegistry(root); reg2.load();
  assert.deepEqual(reg2.list().map((x) => x.id), ['B-0001', 'B-0003', 'B-0004']);
});

// Missing file → valid first-run empty registry.
test('missing registry file is a valid empty first-run', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root);
  const res = reg.load();
  assert.equal(res.ok, true);
  assert.equal(res.firstRun, true);
  assert.equal(reg.count(), 0);
});

// K. corrupt registry must not be silently destroyed.
test('K: corrupt registry is reported and never overwritten', () => {
  const root = tmpRoot();
  const file = path.join(root, 'browser-registry.json');
  fs.writeFileSync(file, '{ this is : not valid json ', 'utf8');
  const reg = makeRegistry(root);
  const res = reg.load();
  assert.equal(res.error.code, 'BROWSER_REGISTRY_CORRUPT');
  assert.equal(reg.isCorrupt(), true);
  assert.deepEqual(reg.list(), []);
  // create must refuse and must not clobber the corrupt file
  const c = reg.create({ name: 'X', launchUrl: 'https://x.test' });
  assert.equal(c.error.code, 'BROWSER_REGISTRY_CORRUPT');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ this is : not valid json ', 'corrupt file preserved');
});

// Write failure does not consume an id/slot.
test('write failure rolls back and consumes no id/slot', () => {
  const root = tmpRoot();
  const failingFs = { readFileSync: fs.readFileSync, writeFileSync: () => { throw new Error('disk full'); }, renameSync: () => {} };
  const reg = new BrowserRegistry({ filePath: path.join(root, 'reg.json'), profilesRoot: path.join(root, 'p'), fs: failingFs, entitlement: () => ({ maxBrowsers: null }) });
  reg.load();
  const r = reg.create({ name: 'A', launchUrl: 'https://a.test' });
  assert.equal(r.error.code, 'BROWSER_REGISTRY_WRITE_FAILED');
  assert.equal(reg.count(), 0);
  const r2 = { ...reg.capacity() };
  assert.equal(r2.registered, 0);
});

// Capacity: hard limit enforced in the registry (main-process authority).
test('capacity: maxBrowsers=3 blocks the 4th create with BROWSER_LIMIT_REACHED', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root, () => ({ maxBrowsers: 3 })); reg.load();
  reg.create({ name: 'A', launchUrl: 'https://a.test' });
  reg.create({ name: 'B', launchUrl: 'https://b.test' });
  reg.create({ name: 'C', launchUrl: 'https://c.test' });
  const cap = reg.capacity();
  assert.equal(cap.registered, 3);
  assert.equal(cap.max, 3);
  assert.equal(cap.canCreate, false);
  const r = reg.create({ name: 'D', launchUrl: 'https://d.test' });
  assert.equal(r.error.code, 'BROWSER_LIMIT_REACHED');
  assert.equal(reg.count(), 3, 'no B-0004 registered');
});

// Upgrade: capacity grows, existing records untouched.
test('upgrade 5 -> 20 keeps existing records and updates capacity', () => {
  const root = tmpRoot();
  const ent = { maxBrowsers: 5 };
  const reg = makeRegistry(root, () => ent); reg.load();
  for (let i = 0; i < 4; i++) reg.create({ name: 'B' + i, launchUrl: 'https://x.test/' + i });
  assert.equal(reg.capacity().max, 5);
  assert.equal(reg.capacity().canCreate, true);
  ent.maxBrowsers = 20; // license upgraded
  const cap = reg.capacity();
  assert.equal(cap.max, 20);
  assert.equal(cap.registered, 4);
  assert.equal(reg.list().length, 4, 'records untouched');
});

// Downgrade: over-capacity is exposed, nothing is deleted, creation blocked.
test('downgrade 12 -> 5 preserves records, flags overCapacity, blocks new creates', () => {
  const root = tmpRoot();
  const ent = { maxBrowsers: 20 };
  const reg = makeRegistry(root, () => ent); reg.load();
  for (let i = 0; i < 12; i++) reg.create({ name: 'B' + i, launchUrl: 'https://x.test/' + i });
  assert.equal(reg.count(), 12);
  ent.maxBrowsers = 5; // downgrade
  const cap = reg.capacity();
  assert.equal(cap.registered, 12);
  assert.equal(cap.max, 5);
  assert.equal(cap.overCapacity, true);
  assert.equal(cap.canCreate, false);
  assert.equal(reg.list().length, 12, 'no automatic deletion');
  const r = reg.create({ name: 'extra', launchUrl: 'https://x.test/extra' });
  assert.equal(r.error.code, 'BROWSER_LIMIT_REACHED');
});

// Unlimited entitlement.
test('unlimited entitlement never blocks creation', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root, () => ({ maxBrowsers: null })); reg.load();
  for (let i = 0; i < 7; i++) reg.create({ name: 'B' + i, launchUrl: 'https://x.test/' + i });
  const cap = reg.capacity();
  assert.equal(cap.unlimited, true);
  assert.equal(cap.canCreate, true);
  assert.equal(cap.remaining, null);
});

// Persisted record carries NO live protocol truth.
test('I: persisted record contains no live protocol/runtime fields', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const b = reg.create({ name: 'A', launchUrl: 'https://a.test' }).browser;
  const keys = Object.keys(b).sort();
  assert.deepEqual(keys, ['createdAt', 'id', 'lastOpenedAt', 'lastRunId', 'launchUrl', 'name', 'profileDir', 'updatedAt']);
  for (const forbidden of ['currentSid', 'currentOdd', 'aid', 'eid', 'phase', 'socket', 'ackWaiters', 'running']) {
    assert.equal(forbidden in b, false, `must not persist ${forbidden}`);
  }
});

// Invalid URL is rejected before any allocation.
test('invalid launch URL is rejected and consumes no slot', () => {
  const root = tmpRoot();
  const reg = makeRegistry(root); reg.load();
  const r = reg.create({ name: 'A', launchUrl: 'not-a-url' });
  assert.equal(r.error.code, 'BROWSER_INVALID_URL');
  assert.equal(reg.count(), 0);
});
