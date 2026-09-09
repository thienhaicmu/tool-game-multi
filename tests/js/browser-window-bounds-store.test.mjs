import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserWindowBoundsStore, sanitizeBounds } = require('../../desktop/browser-run/browser-window-bounds-store.cjs');

// ---------------------------------------------------------------------------
// CONTROL-V3 — per-profile external browser-window geometry store. It keeps each Browser ID's
// window rectangle SEPARATE (B-0010 restores B-0010's window, B-0011 restores B-0011's — never
// mixed), mirrors BrowserConfigStore's atomic write, and never silently overwrites a corrupt file.
// Backed by an in-memory fake fs so the whole thing is deterministic and Electron-free.
// ---------------------------------------------------------------------------
function memFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {},
  };
}
const FILE = '/root/browser-window-bounds.json';

test('per-Browser-ID geometry is isolated and round-trips', () => {
  const fs = memFs();
  const store = new BrowserWindowBoundsStore({ fs, filePath: FILE });
  store.set('B-0010', { x: 10, y: 20, width: 1024, height: 576 });
  store.set('B-0011', { x: 800, y: 40, width: 960, height: 540 });

  // Reload from disk → both survive, keyed independently.
  const store2 = new BrowserWindowBoundsStore({ fs, filePath: FILE });
  assert.deepEqual(store2.get('B-0010'), { x: 10, y: 20, width: 1024, height: 576 });
  assert.deepEqual(store2.get('B-0011'), { x: 800, y: 40, width: 960, height: 540 });
  assert.equal(store2.get('B-9999'), null, 'unknown id has no saved bounds');
});

test('updating one profile never touches another', () => {
  const fs = memFs();
  const store = new BrowserWindowBoundsStore({ fs, filePath: FILE });
  store.set('B-0010', { x: 0, y: 0, width: 1024, height: 576 });
  store.set('B-0011', { x: 5, y: 5, width: 800, height: 450 });
  store.set('B-0010', { x: 100, y: 120, width: 1200, height: 700 });
  assert.deepEqual(store.get('B-0011'), { x: 5, y: 5, width: 800, height: 450 }, 'B-0011 unchanged');
  assert.deepEqual(store.get('B-0010'), { x: 100, y: 120, width: 1200, height: 700 });
});

test('invalid rectangles are refused (never poison saved geometry)', () => {
  const fs = memFs();
  const store = new BrowserWindowBoundsStore({ fs, filePath: FILE });
  store.set('B-0010', { x: 0, y: 0, width: 1024, height: 576 });
  for (const bad of [{ width: 0, height: 500 }, { width: 500, height: -1 }, { width: NaN, height: 500 }, {}, null, { width: 999999, height: 500 }]) {
    const res = store.set('B-0010', bad);
    assert.ok(res && res.error, 'invalid rect refused: ' + JSON.stringify(bad));
  }
  assert.deepEqual(store.get('B-0010'), { x: 0, y: 0, width: 1024, height: 576 }, 'previous good bounds intact');
});

test('missing position is legal (size-only) and preserved', () => {
  const fs = memFs();
  const store = new BrowserWindowBoundsStore({ fs, filePath: FILE });
  store.set('B-0010', { width: 1024, height: 576 });
  assert.deepEqual(store.get('B-0010'), { width: 1024, height: 576 });
});

test('a corrupt file is reported and NEVER silently overwritten', () => {
  const fs = memFs({ [FILE]: '{ not json' });
  const store = new BrowserWindowBoundsStore({ fs, filePath: FILE });
  const res = store.load();
  assert.ok(res && res.error && res.error.code === 'BROWSER_BOUNDS_CORRUPT', 'corruption surfaced');
  assert.equal(store.isCorrupt(), true);
  assert.equal(store.get('B-0010'), null, 'reads fall back to null while corrupt');
  const w = store.set('B-0010', { width: 1024, height: 576 });
  assert.ok(w && w.error, 'writes refused while corrupt');
  assert.equal(fs.files.get(FILE), '{ not json', 'corrupt file left untouched');
});

test('remove drops one profile only', () => {
  const fs = memFs();
  const store = new BrowserWindowBoundsStore({ fs, filePath: FILE });
  store.set('B-0010', { width: 1024, height: 576 });
  store.set('B-0011', { width: 960, height: 540 });
  store.remove('B-0010');
  assert.equal(store.get('B-0010'), null);
  assert.deepEqual(store.get('B-0011'), { width: 960, height: 540 });
});

test('sanitizeBounds rounds and clamps', () => {
  assert.deepEqual(sanitizeBounds({ x: 10.6, y: 20.4, width: 1024.7, height: 576.2 }), { x: 11, y: 20, width: 1025, height: 576 });
  assert.equal(sanitizeBounds({ width: 0, height: 10 }), null);
  assert.equal(sanitizeBounds({ x: 999999, y: 0, width: 100, height: 100 }).x, undefined, 'absurd position dropped, size kept');
});
