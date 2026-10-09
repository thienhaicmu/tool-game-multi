import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const autoPlay = require('../../desktop/protocol/phom/phom-auto-play.cjs');

test('Tự đánh keeps running when the round includes a player outside the tool', () => {
  const snap = {
    roundSeq: 1,
    roundPlayers: ['me', 'stranger'],
    slotBinding: { B1: 'me', B2: null, B3: null },
    players: {
      me: { uid: 'me', currentCards: [0, 4, 8], melds: [], discardedHistory: [], sentCards: [] },
      stranger: { uid: 'stranger', currentCards: [], melds: [], discardedHistory: [], sentCards: [] },
    },
    observedDiscardEvents: [],
    eats: [],
  };

  assert.deepEqual(autoPlay.tableGuard(snap, ['me']), { ok: true });

  const step = autoPlay.nextStep(snap, 'me', ['BOC'], new Set(), ['me']);
  assert.equal(step.action, 'BOC');
  assert.equal(step.stop, undefined);
  assert.notEqual(step.code, 'AUTO_STRANGER');
});
