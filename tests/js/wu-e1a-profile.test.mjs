// WU-E.1A — per-B persistent profile mapping (the embed must not change the 1 BROWSER =
// 1 PROFILE model). These assert the source-of-truth mapping in BrowserRegistry that the
// launcher's --user-data-dir is derived from, matching the real isolation harness result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');

function reg(root) {
  const r = new BrowserRegistry({ filePath: join(root, 'browser-registry.json'), profilesRoot: join(root, 'browser-profiles'), entitlement: () => ({ maxBrowsers: 10 }) });
  r.load();
  return r;
}

test('each B-* gets a unique, stable profileDir under profilesRoot', () => {
  const root = mkdtempSync(join(tmpdir(), 'wu-e1a-'));
  try {
    const r = reg(root);
    const b1 = r.create({ name: 'One', launchUrl: 'https://example.com' }).browser;
    const b2 = r.create({ name: 'Two', launchUrl: 'https://example.org' }).browser;
    assert.notEqual(b1.profileDir, b2.profileDir, 'distinct profiles');
    assert.ok(b1.profileDir.endsWith(join('browser-profiles', b1.id)), 'B1 profile keyed by its id');
    assert.ok(b2.profileDir.endsWith(join('browser-profiles', b2.id)), 'B2 profile keyed by its id');
    // stable: re-get returns the same path
    assert.equal(r.get(b1.id).profileDir, b1.profileDir);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profileDir mapping persists across a registry reload (restart)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wu-e1a-'));
  try {
    const r1 = reg(root);
    const b1 = r1.create({ name: 'One', launchUrl: 'https://example.com' }).browser;
    const b2 = r1.create({ name: 'Two', launchUrl: 'https://example.org' }).browser;
    // reload (simulates app restart) — same file, fresh instance
    const r2 = reg(root);
    assert.equal(r2.get(b1.id).profileDir, b1.profileDir, 'B1 profile stable after restart');
    assert.equal(r2.get(b2.id).profileDir, b2.profileDir, 'B2 profile stable after restart');
    assert.equal(r2.count(), 2, 'no duplicate/lost records');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('editing one browser never mutates another browser profileDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'wu-e1a-'));
  try {
    const r = reg(root);
    const b1 = r.create({ name: 'One', launchUrl: 'https://example.com' }).browser;
    const b2 = r.create({ name: 'Two', launchUrl: 'https://example.org' }).browser;
    r.update(b1.id, { name: 'One renamed', launchUrl: 'https://example.net' });
    assert.equal(r.get(b1.id).profileDir, b1.profileDir, 'B1 profile unchanged by its own edit');
    assert.equal(r.get(b2.id).profileDir, b2.profileDir, 'B2 profile unchanged by B1 edit');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
