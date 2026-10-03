// PHASE 6.3.1 — profile SELECTION logic (pure): ordered selection (max 3) drives B1/B2/B3, and bulk
// proxy maps to the selection BY ORDER (all-or-nothing). Loaded as a classic browser script via vm.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
// Load the classic browser script in THIS realm so returned arrays/objects are comparable with
// deepStrictEqual (a fresh vm context would return foreign-realm values).
const code = readFileSync(new URL('../../ui-phom/profile-selection.js', import.meta.url), 'utf8');
vm.runInThisContext(code);
const P = globalThis.ProfileSelection;

// §32 — select 1/2/3, block the 4th, unselect, replace
test('select 3 to 5 (3 play + 2 reserves), block the 6th, order preserved', () => {
  let s = [];
  s = P.toggle(s, 'a'); s = P.toggle(s, 'b'); s = P.toggle(s, 'c');
  assert.deepEqual(s, ['a', 'b', 'c']);
  assert.equal(P.complete(s), true);
  assert.equal(P.complete(['a', 'b']), false, 'fewer than 3 cannot open');
  s = P.toggle(P.toggle(s, 'd'), 'e');
  assert.deepEqual(s, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(P.complete(s), true);
  assert.equal(P.browserOf(s, 'e'), 'B5');
  assert.equal(P.canSelectMore(s), false);
  assert.deepEqual(P.toggle(s, 'f'), s, '6th tick ignored');
  assert.equal(P.canSelect(s, 'f'), false, 'cannot select a 6th');
  assert.equal(P.canSelect(s, 'a'), true, 'an already-selected profile stays toggleable');
});

// §13 — selection order → B1/B2/B3 (never table/name order)
test('selection order determines B1/B2/B3', () => {
  const s = P.toggle(P.toggle(P.toggle([], 'mobile3'), 'laptopSmall'), 'desktop2');
  assert.equal(P.browserOf(s, 'mobile3'), 'B1');
  assert.equal(P.browserOf(s, 'laptopSmall'), 'B2');
  assert.equal(P.browserOf(s, 'desktop2'), 'B3');
  assert.equal(P.browserOf(s, 'other'), null);
});

test('unselect then select a replacement recomputes B1/B2/B3 from current order', () => {
  let s = ['a', 'b', 'c'];
  s = P.toggle(s, 'b');              // remove b
  assert.deepEqual(s, ['a', 'c']);
  s = P.toggle(s, 'd');              // add d
  assert.deepEqual(s, ['a', 'c', 'd']);
  assert.equal(P.browserOf(s, 'a'), 'B1');
  assert.equal(P.browserOf(s, 'c'), 'B2');
  assert.equal(P.browserOf(s, 'd'), 'B3');
});

// §11 — deleting a profile removes it from the selection (prune), order preserved
test('prune drops ids no longer in the store, preserving order', () => {
  assert.deepEqual(P.prune(['a', 'b', 'c'], ['a', 'c']), ['a', 'c']);
  assert.deepEqual(P.prune(['a', 'b', 'c'], ['x']), []);
});

// §33 — bulk proxy mapping by order, all-or-nothing
test('bulk proxy maps to selection by order when counts match', () => {
  const s = ['mobile3', 'laptopSmall', 'desktop2'];
  const r = P.mapProxies(s, 'proxy-A\nproxy-B\nproxy-C');
  assert.equal(r.ok, true);
  assert.deepEqual(r.mapping, [
    { profileId: 'mobile3', proxy: 'proxy-A', browser: 'B1' },
    { profileId: 'laptopSmall', proxy: 'proxy-B', browser: 'B2' },
    { profileId: 'desktop2', proxy: 'proxy-C', browser: 'B3' },
  ]);
});

test('bulk proxy: too few / too many proxies => typed mismatch (no partial apply)', () => {
  const s = ['a', 'b', 'c'];
  assert.equal(P.mapProxies(s, 'p1\np2').error, 'PROXY_COUNT_MISMATCH');
  assert.equal(P.mapProxies(s, 'p1\np2\np3\np4').error, 'PROXY_COUNT_MISMATCH');
});

test('bulk proxy trims whitespace and ignores blank lines', () => {
  const s = ['a', 'b', 'c'];
  const r = P.mapProxies(s, '  p1  \n\n   \n p2 \np3\n\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.mapping.map((m) => m.proxy), ['p1', 'p2', 'p3']);
});

test('bulk proxy with no selection => NO_SELECTION', () => {
  assert.equal(P.mapProxies([], 'p1').error, 'NO_SELECTION');
});
