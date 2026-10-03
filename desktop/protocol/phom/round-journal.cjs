'use strict';

// ---------------------------------------------------------------------------
// ROUND JOURNAL (N5) — keeps every round the tool watched so LỌC BÀI can be reviewed afterwards: why a card was
// "Nên đánh" at that moment. Fed with what the tool window already gets (the card-observer snapshot + the per-slot
// analyses, throttled) — it never analyses anything itself and never sends anything.
//
// One step is recorded each time the picture changes (turn, discard pile, or a slot's verdict). When the round ends
// (the observer leaves the round, or a new round starts) the round is written as ONE JSON file:
//   { roundSeq, startedAt, endedAt, players:[{uid,name,slot,ours,cards}], discards:[...], steps:[...] }
// Only card labels, names and seats — no credentials. The newest KEEP files are kept.
// ---------------------------------------------------------------------------

const path = require('node:path');

const KEEP = 50;
const MAX_STEPS = 400;
const SLOTS = ['B1', 'B2', 'B3'];
const GROUPS = [['safe', 'safeCards'], ['likely', 'likelySafeCards'], ['unknown', 'unknownCards'], ['risky', 'riskyCards'], ['own', 'ownMeldCards']];

const label = (c) => (c && (c.label || ((c.rank || '?') + (c.suit || '')))) || '?';

class RoundJournal {
  constructor({ dir = null, fs = require('node:fs'), now = () => Date.now(), keep = KEEP } = {}) {
    this._dir = dir; this._fs = fs; this._now = now; this._keep = keep;
    this._cur = null; this._lastKey = null; this._written = [];
  }

  dir() { return this._dir; }
  current() { return this._cur; }

  observe(cards, analyses = {}) {
    if (!cards || !(Number(cards.roundSeq) > 0)) return;
    const seq = Number(cards.roundSeq);
    if (this._cur && this._cur.roundSeq !== seq) this.flush('NEW_ROUND');
    if (!cards.roundActive && !this._cur) return; // between rounds, nothing to keep
    if (!this._cur) this._cur = { roundSeq: seq, startedAt: cards.startedAt || this._now(), endedAt: null, players: [], discards: [], steps: [] };
    const cur = this._cur;
    cur.players = playersOf(cards);
    cur.discards = (cards.discardPileView || []).map(label);
    const slots = {};
    for (const sl of SLOTS) {
      const a = analyses && analyses[sl];
      if (!a || a.status !== 'OK') continue;
      const v = { next: a.nextPlayerLabel || null, recommended: a.recommendedCode != null ? recommendedLabel(a) : null };
      for (const [k, src] of GROUPS) v[k] = (a[src] || []).map(label);
      slots[sl] = v;
    }
    const key = JSON.stringify([cards.currentTurnUid, cur.discards.length, slots]);
    if (key !== this._lastKey && cur.steps.length < MAX_STEPS) {
      this._lastKey = key;
      cur.steps.push({ at: this._now(), turnUid: cards.currentTurnUid || null, discardCount: cur.discards.length, lastDiscard: cur.discards.length ? cur.discards[cur.discards.length - 1] : null, slots });
    }
    if (!cards.roundActive) this.flush('ROUND_END');
  }

  // Write the round being kept (if it has anything) and start fresh. Never throws.
  flush(reason = 'FLUSH') {
    const cur = this._cur;
    this._cur = null; this._lastKey = null;
    if (!cur || !cur.steps.length || !this._dir) return null;
    cur.endedAt = this._now(); cur.reason = reason;
    const name = 'round-' + new Date(cur.endedAt).toISOString().replace(/[:.]/g, '-') + '-' + cur.roundSeq + '.json';
    const file = path.join(this._dir, name);
    try {
      this._fs.mkdirSync(this._dir, { recursive: true });
      this._fs.writeFileSync(file, JSON.stringify(cur, null, 1), 'utf8');
      this._written.push(file);
      this._prune();
      return file;
    } catch { return null; }
  }

  _prune() {
    try {
      const files = this._fs.readdirSync(this._dir).filter((f) => /^round-.*\.json$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - this._keep))) { try { this._fs.unlinkSync(path.join(this._dir, f)); } catch { /* best effort */ } }
    } catch { /* best effort */ }
  }
}

function playersOf(cards) {
  const binding = cards.slotBinding || {};
  const slotOf = Object.fromEntries(Object.entries(binding).filter(([, u]) => u != null).map(([s, u]) => [String(u), s]));
  return Object.values(cards.players || {}).map((p) => ({
    uid: p.uid, name: p.name || null, seat: p.seat != null ? p.seat : null, slot: slotOf[String(p.uid)] || null, ours: !!p.controlled,
    cards: (p.currentCardsView || p.currentCards || []).map((c) => (typeof c === 'object' ? label(c) : c)),
  }));
}
function recommendedLabel(a) {
  const all = [].concat(a.safeCards || [], a.likelySafeCards || []);
  const c = all.find((x) => x && x.code === a.recommendedCode);
  return c ? label(c) : String(a.recommendedCode);
}

function createRoundJournal(deps) { return new RoundJournal(deps); }

module.exports = { RoundJournal, createRoundJournal, KEEP };
