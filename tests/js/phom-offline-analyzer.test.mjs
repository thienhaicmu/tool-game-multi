import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../../desktop/protocol/phom/offline-analyzer.cjs');

const OFFLINE = { sourceKind: 'TEST_FIXTURE', networkEnabled: false, liveRunCount: 0 };

// §16 — hard offline boundary: refuses when a live run / network / live session exists.
test('analyzer refuses outside an offline context (PHOM_ANALYZER_OFFLINE_ONLY)', () => {
  for (const bad of [
    { sourceKind: 'TEST_FIXTURE', networkEnabled: true, liveRunCount: 0 },
    { sourceKind: 'TEST_FIXTURE', networkEnabled: false, liveRunCount: 1 },
    { sourceKind: 'TEST_FIXTURE', networkEnabled: false, liveRunCount: 0, liveSessionId: 'S1' },
    { sourceKind: 'LIVE', networkEnabled: false, liveRunCount: 0 },
    { sourceKind: 'TEST_FIXTURE', networkEnabled: false, liveRunCount: 0, endpoint: 'wss://x' },
  ]) {
    const r = A.analyzeConsistency({ knownHands: [[0, 1, 2]] }, bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'PHOM_ANALYZER_OFFLINE_ONLY');
  }
});

// §16 — meld classification (SET / RUN) with the confirmed codec.
test('classifyMeld recognises SET and RUN', () => {
  assert.equal(A.classifyMeld([0, 1, 2]), 'SET');        // A♠ A♣ A♦ (same rank)
  assert.equal(A.classifyMeld([10, 14, 18]), 'RUN');     // 3♦ 4♦ 5♦ (same suit, consecutive)
  assert.equal(A.classifyMeld([10, 14, 19]), null);      // not consecutive
  assert.equal(A.classifyMeld([0, 1]), null);            // too few
});

test('findMelds extracts sets and runs from a simulated hand', () => {
  const melds = A.findMelds([10, 14, 18, 27, 31, 35, 0, 1, 2]);
  const types = melds.map((m) => m.type).sort();
  assert.deepEqual(types, ['RUN', 'RUN', 'SET']);
});

// §15 — validate a server sMs partitions into melds (never asserts a specific grouping).
test('validateServerMelds confirms sMs cards form melds', () => {
  const r = A.validateServerMelds([10, 14, 18, 27, 31, 35], OFFLINE);
  assert.equal(r.ok, true);
  assert.equal(r.allCardsFormMelds, true);
  assert.equal(r.melds.length, 2);
});

// §16 — simulator: does a drawn card create a new phom? (QA only, offline-gated)
test('discardFormsPhom detects a new meld from a simulated draw', () => {
  // hand has 3♦ 4♦ (10,14); adding 5♦ (18) completes a RUN
  const r = A.discardFormsPhom([10, 14, 0, 1], 18, OFFLINE);
  assert.equal(r.ok, true);
  assert.equal(r.forms, true);
  assert.equal(r.melds[0].type, 'RUN');
  // gated outside offline
  assert.equal(A.discardFormsPhom([10, 14], 18, { sourceKind: 'LIVE' }).error.code, 'PHOM_ANALYZER_OFFLINE_ONLY');
});

// §16 — consistency outputs: duplicate + conservation + unknown count.
test('analyzeConsistency reports duplicates, conservation and unknown count', () => {
  const clean = A.analyzeConsistency({ knownHands: [[0, 1, 2]], publicCards: [3, 4] }, OFFLINE);
  assert.equal(clean.DUPLICATE_CARD_ERROR, null);
  assert.equal(clean.KNOWN_PROFILE_CARDS, 3);
  assert.equal(clean.PUBLIC_CARDS, 2);
  assert.equal(clean.UNKNOWN_CARD_COUNT, 52 - 5);
  const dup = A.analyzeConsistency({ knownHands: [[0, 1]], publicCards: [1] }, OFFLINE);
  assert.equal(dup.DUPLICATE_CARD_ERROR.count, 1);
  assert.deepEqual(dup.DUPLICATE_CARD_ERROR.codes, [1]);
});

// §16 — dependency boundary: the analyzer imports nothing that can touch a live game.
test('offline analyzer imports only pure card codec (no launcher/CDP/ws/coordinator)', () => {
  const src = readFileSync(new URL('../../desktop/protocol/phom/offline-analyzer.cjs', import.meta.url), 'utf8');
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./card-codec.cjs']);
  for (const dep of requires) assert.equal(/ws-replay|chrome-launcher|chrome-runtime|target-manager|coordinator|session-manager|node:net|electron/.test(dep), false, `forbidden import: ${dep}`);
});
