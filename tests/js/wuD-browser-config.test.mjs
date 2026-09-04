import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { BrowserConfigStore, defaultConfig, FIELD_KEYS } = require('../../desktop/browser-run/browser-config-store.cjs');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wud-cfg-'));
  return path.join(dir, 'browser-configs.json');
}

// ---------------------------------------------------------------------------
// Defaults / schema
// ---------------------------------------------------------------------------
test('defaultConfig exposes exactly the whitelisted operating fields', () => {
  const d = defaultConfig();
  assert.deepEqual(Object.keys(d).sort(), ['amount', 'jackpotThreshold', 'roundCount', 'stopAutoAt1000x', 'stopOdd', 'waitForJackpot']);
  assert.equal(d.waitForJackpot, false);
  assert.equal(d.stopAutoAt1000x, false);
  assert.equal(d.roundCount, 1);
  assert.equal(d.jackpotThreshold, null);
});

test('unknown browser returns a fully-defaulted config (coherent UI shape)', () => {
  const store = new BrowserConfigStore({ filePath: tmpFile() });
  assert.deepEqual(store.get('B-9999'), defaultConfig());
});

// ---------------------------------------------------------------------------
// Per-browser isolation + persistence
// ---------------------------------------------------------------------------
test('per-browser configs are isolated and persist across reload', () => {
  const file = tmpFile();
  const s1 = new BrowserConfigStore({ filePath: file });
  s1.set('B-0001', { amount: 5000, roundCount: 20, stopOdd: 2.0, waitForJackpot: true, jackpotThreshold: 70000000, stopAutoAt1000x: true });
  s1.set('B-0002', { amount: 10000, roundCount: 10, stopOdd: 1.8, waitForJackpot: false, jackpotThreshold: null, stopAutoAt1000x: false });
  // B-0001 config differs from B-0002 config
  assert.notDeepEqual(s1.get('B-0001'), s1.get('B-0002'));

  const s2 = new BrowserConfigStore({ filePath: file });
  s2.load();
  assert.deepEqual(s2.get('B-0001'), { amount: 5000, roundCount: 20, stopOdd: 2.0, waitForJackpot: true, jackpotThreshold: 70000000, stopAutoAt1000x: true });
  assert.deepEqual(s2.get('B-0002'), { amount: 10000, roundCount: 10, stopOdd: 1.8, waitForJackpot: false, jackpotThreshold: null, stopAutoAt1000x: false });
});

test('set merges a partial patch onto the stored config', () => {
  const store = new BrowserConfigStore({ filePath: tmpFile() });
  store.set('B-0001', { amount: 5000, roundCount: 20 });
  store.set('B-0001', { stopAutoAt1000x: true });
  const c = store.get('B-0001');
  assert.equal(c.amount, 5000);
  assert.equal(c.roundCount, 20);
  assert.equal(c.stopAutoAt1000x, true);
});

// ---------------------------------------------------------------------------
// No runtime truth / no license authority may be persisted (§8.1 / §8.2)
// ---------------------------------------------------------------------------
test('runtime-truth and license-authority keys are never persisted', () => {
  const file = tmpFile();
  const store = new BrowserConfigStore({ filePath: file });
  store.set('B-0001', {
    amount: 5000,
    // runtime truth — must be dropped
    sid: 30815, aid: 7, eid: 1, currentOdd: 2.4, currentJackpot: 99, protocolReady: true, socket: 'x', targetId: 'T', autoRunning: true,
    // license authority — must be dropped
    maxBrowsers: 999, maxConcurrentBrowsers: 999, features: { autoRun: true },
  });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  const persisted = stored.configs['B-0001'];
  assert.deepEqual(Object.keys(persisted).sort(), FIELD_KEYS.slice().sort());
  for (const k of ['sid', 'aid', 'eid', 'currentOdd', 'currentJackpot', 'protocolReady', 'socket', 'targetId', 'autoRunning', 'maxBrowsers', 'maxConcurrentBrowsers', 'features']) {
    assert.equal(k in persisted, false, `${k} must not be persisted`);
  }
  assert.equal(persisted.amount, 5000);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
test('invalid known-field values are rejected without mutating stored config', () => {
  const store = new BrowserConfigStore({ filePath: tmpFile() });
  store.set('B-0001', { amount: 5000 });
  assert.ok(store.set('B-0001', { amount: -1 }).error);
  assert.ok(store.set('B-0001', { roundCount: 0 }).error);
  assert.ok(store.set('B-0001', { roundCount: 1.5 }).error);
  assert.ok(store.set('B-0001', { stopOdd: 0 }).error);
  assert.ok(store.set('B-0001', { waitForJackpot: 'yes' }).error);
  assert.ok(store.set('B-0001', { jackpotThreshold: -5 }).error);
  assert.ok(store.set('B-0001', { stopAutoAt1000x: 1 }).error);
  // stored config unchanged after all the rejects
  assert.equal(store.get('B-0001').amount, 5000);
});

test('nullable fields accept explicit null', () => {
  const store = new BrowserConfigStore({ filePath: tmpFile() });
  const r = store.set('B-0001', { amount: null, stopOdd: null, jackpotThreshold: null });
  assert.ok(!r.error);
  assert.equal(store.get('B-0001').amount, null);
});

// ---------------------------------------------------------------------------
// Migration + corrupt-file behavior (non-destructive)
// ---------------------------------------------------------------------------
test('migration: an older file with unknown fields is sanitized, ids preserved', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 0,
    configs: {
      'B-0001': { amount: 5000, legacyMystery: 'x', aid: 7 },
      'B-0777': { roundCount: 3 },
    },
  }), 'utf8');
  const store = new BrowserConfigStore({ filePath: file });
  const res = store.load();
  assert.equal(res.ok, true);
  assert.equal(res.migrated, true);
  // ids preserved
  assert.equal(store.has('B-0001'), true);
  assert.equal(store.has('B-0777'), true);
  // unknown fields dropped, known ones kept, missing ones defaulted
  const c = store.get('B-0001');
  assert.equal(c.amount, 5000);
  assert.equal('legacyMystery' in c, false);
  assert.equal('aid' in c, false);
  assert.equal(c.roundCount, 1); // defaulted
});

test('corrupt file is reported and never silently overwritten', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not valid json', 'utf8');
  const store = new BrowserConfigStore({ filePath: file });
  const res = store.load();
  assert.ok(res.error);
  assert.equal(res.error.code, 'BROWSER_CONFIG_CORRUPT');
  assert.equal(store.isCorrupt(), true);
  // a set is refused while corrupt (evidence preserved)
  assert.ok(store.set('B-0001', { amount: 1 }).error);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not valid json', 'corrupt file left intact');
});

test('atomic write leaves no partial file and remove() drops a config', () => {
  const file = tmpFile();
  const store = new BrowserConfigStore({ filePath: file });
  store.set('B-0001', { amount: 5000 });
  assert.equal(fs.existsSync(file + '.tmp'), false, 'temp file renamed away');
  store.remove('B-0001');
  assert.equal(store.has('B-0001'), false);
  // history/profile are unaffected — this store only owns config
  const reloaded = new BrowserConfigStore({ filePath: file });
  reloaded.load();
  assert.equal(reloaded.has('B-0001'), false);
});
