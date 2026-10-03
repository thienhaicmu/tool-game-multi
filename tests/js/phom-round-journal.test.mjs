// N5 — the round journal keeps every watched round for LỌC BÀI review (one JSON per round, newest 50), fed by the
// same throttled snapshot the tool window gets. Plus the regression: that push used to throw (phomUiSnapshot lived
// inside registerIpc) so LỌC BÀI only refreshed on the window's poll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRoundJournal } = require('../../desktop/protocol/phom/round-journal.cjs');
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const card = (code, label) => ({ code, label, rank: label.slice(0, -1), suit: label.slice(-1) });
const cards = (over = {}) => ({
  roundSeq: 1, roundActive: true, startedAt: 1000, currentTurnUid: 'u1',
  slotBinding: { B1: 'u1', B2: 'u2', B3: null },
  players: { u1: { uid: 'u1', name: 'acc1', seat: 0, controlled: true, currentCardsView: [card(1, 'A♠')] }, u9: { uid: 'u9', name: 'la', seat: 3, controlled: false, currentCardsView: [] } },
  discardPileView: [], ...over,
});
const analysis = (safe) => ({ status: 'OK', nextPlayerLabel: 'B2', recommendedCode: safe[0] ? safe[0].code : null, safeCards: safe, likelySafeCards: [], unknownCards: [card(9, '9♦')], riskyCards: [], ownMeldCards: [] });

test('records a step per change, writes ONE file when the round ends, with players / discards / verdicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-'));
  let t = 1000; const j = createRoundJournal({ dir, now: () => (t += 10) });
  j.observe(cards(), { B1: analysis([card(5, '5♣')]) });
  j.observe(cards(), { B1: analysis([card(5, '5♣')]) });                                  // identical → no new step
  j.observe(cards({ currentTurnUid: 'u2', discardPileView: [card(5, '5♣')] }), { B1: analysis([]) });
  assert.equal(j.current().steps.length, 2);
  j.observe(cards({ roundActive: false, discardPileView: [card(5, '5♣')] }), {});      // round over
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const round = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(round.roundSeq, 1);
  assert.equal(round.reason, 'ROUND_END');
  assert.deepEqual(round.discards, ['5♣']);
  assert.equal(round.steps[0].slots.B1.recommended, '5♣');
  assert.deepEqual(round.steps[0].slots.B1.safe, ['5♣']);
  assert.equal(round.steps[1].lastDiscard, '5♣');
  const me = round.players.find((p) => p.uid === 'u1');
  assert.deepEqual([me.slot, me.ours, me.cards], ['B1', true, ['A♠']]);
  assert.equal(j.current(), null);
});

test('a new round flushes the old one; nothing is written between rounds or for an empty round', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-'));
  const j = createRoundJournal({ dir, now: () => 5 });
  j.observe(cards({ roundActive: false }), {});
  assert.equal(j.current(), null, 'between rounds nothing is kept');
  j.observe(cards(), { B1: analysis([]) });
  j.observe(cards({ roundSeq: 2 }), { B1: analysis([]) });
  assert.equal(readdirSync(dir).length, 1, 'round 1 written when round 2 started');
  assert.equal(j.current().roundSeq, 2);
  assert.ok(j.flush(), 'round 2 written on flush');
  assert.equal(j.flush(), null, 'a second flush has nothing to write');
  assert.equal(readdirSync(dir).length, 2);
});

test('keeps only the newest N files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-'));
  for (let i = 0; i < 5; i++) writeFileSync(join(dir, `round-2000-01-0${i}.json`), '{}');
  const j = createRoundJournal({ dir, now: () => Date.now(), keep: 3 });
  j.observe(cards(), { B1: analysis([]) });
  j.flush();
  assert.equal(readdirSync(dir).length, 3);
});

test('wiring: the throttled push feeds the journal with the same snapshot; phomUiSnapshot is module-scope (the push used to throw)', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /function sendUiAndJournal\(\) \{\s*const snap = phomUiSnapshot\(\);\s*try \{ ensureRoundJournal\(\)\.observe\(snap\.cards, snap\.analyses\); \}/);
  const reg = main.indexOf('function registerIpc()');
  assert.ok(main.indexOf('function phomUiSnapshot()') < reg, 'declared outside registerIpc, reachable from the push');
  assert.match(main, /ipcMain\.handle\('phom:rounds-open'/);
  assert.match(read('ui-phom/phom-qa.js'), /api\.openRounds\(\)/);
});
