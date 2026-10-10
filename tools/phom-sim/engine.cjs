'use strict';

// ---------------------------------------------------------------------------
// PHỎM SIMULATOR — offline game engine (plan GĐ3 · S4, user 2026-10-10). One round of Tá lả between 2–4 seats:
// deal (first player 10, others 9) → each turn Bốc/Ăn → Đánh; the 4th turn Hạ → Gửi → Đánh; Ù at any time after
// taking. Every step is checked here (the bot only proposes), and the round is scored in BETS (× the table stake) with
// the rules table in RULES — the user approved the plan with these values pending a live 855 check (GĐ4).
//
// Not modelled (stated, not guessed): ù khan, the "chuyển bài" shift after an eat (each seat discards exactly 4 times),
// a round where the deck runs out. The meld definition is the shared one (protocol/phom/phom-rules via play-help).
//
//   const r = createRound({ uids, rng, rules })
//   r.offered(uid) → ['BOC','AN','DANH','HA','GUI','BAO_U']   r.apply(uid, { action, cards }) → { ok, events | error }
//   r.done · r.result() → { winner, kind, net{uid→bets}, ranks, mom, eats, den }
// events are public/private facts the driver turns into observer frames.
// ---------------------------------------------------------------------------

const help = require('../../desktop/protocol/phom/phom-play-help.cjs');
const { cardPoints } = require('../../desktop/protocol/phom/phom-rules.cjs');

const RULES = Object.freeze({ rank: [0, 1, 2, 3], mom: 4, eat: 1, eatChot: 4, u: 5, den: true });
const TURNS = 4;

function shuffle(cards, rng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// a hand arrangement that keeps every eaten card in a phỏm, one eaten card per phỏm
function lockedOk(a, hand, locked) {
  return [...locked].filter((c) => hand.includes(c)).every((c) => a.melds.some((m) => m.includes(c))) &&
    a.melds.every((m) => m.filter((c) => locked.has(c)).length <= 1);
}

function createRound({ uids, rng = Math.random, rules = RULES, deck = null }) {
  if (!Array.isArray(uids) || uids.length < 2 || uids.length > 4) throw new Error('2–4 seats');
  const order = uids.map(String);
  const cards = deck ? deck.slice() : shuffle(Array.from({ length: 52 }, (_, i) => i), rng);
  const hands = new Map(order.map((u, i) => [u, cards.splice(0, i === 0 ? 10 : 9)]));
  const st = {
    deck: cards, hands, order, turn: 0, phase: 'PLAY', // the first player starts by discarding (10 cards)
    discards: new Map(order.map((u) => [u, []])), last: null, locked: new Map(order.map((u) => [u, new Set()])),
    laid: new Map(order.map((u) => [u, []])), layOrder: [], sent: new Map(order.map((u) => [u, []])),
    eats: [], done: false, u: null, meid: 0,
  };
  const deal = order.map((u) => ({ type: 'DEAL', uid: u, cards: hands.get(u).slice(), lpi: order.slice(), first: order[0] }));

  const cur = () => order[st.turn];
  const prevOf = (u) => order[(order.indexOf(u) - 1 + order.length) % order.length];
  const nextOf = (u) => order[(order.indexOf(u) + 1) % order.length];
  const handOf = (u) => st.hands.get(u);
  const laidCards = (u) => st.laid.get(u).flatMap((m) => m.cards);
  const inHand = (u) => { const laid = new Set(laidCards(u)); return handOf(u).filter((c) => !laid.has(c)); };
  const tableMelds = () => order.flatMap((u) => st.laid.get(u).map((m) => ({ owner: u, meid: m.meid, cards: m.cards })));

  function canEat(u, code) {
    const hand = inHand(u); const locked = st.locked.get(u);
    if (st.laid.get(u).length) return false;
    return help.arrangements(hand.concat(code)).some((a) => a.melds.some((m) => m.includes(code)) &&
      lockedOk(a, hand.concat(code), new Set([...locked, code])));
  }
  function canU(u) {
    const hand = inHand(u); const locked = st.locked.get(u);
    if (st.laid.get(u).length) return false;
    return help.arrangements(hand).some((a) => a.loose.length <= 1 && a.melds.flat().length >= 9 && lockedOk(a, hand, locked));
  }
  function haPossible(u) {
    const hand = inHand(u); const locked = st.locked.get(u);
    return help.arrangements(hand).some((a) => a.melds.length && lockedOk(a, hand, locked));
  }
  function sendable(u) {
    const melds = tableMelds();
    return melds.length > 0 && inHand(u).some((c) => help.sendChain([c], melds).sent.length);
  }
  const lastTurn = (u) => st.discards.get(u).length === TURNS - 1;

  function offered(u) {
    if (st.done || u !== cur()) return [];
    if (st.phase === 'TAKE') {
      const out = ['BOC'];
      if (st.last && st.last.uid === prevOf(u) && canEat(u, st.last.code)) out.push('AN');
      return out;
    }
    const out = ['DANH'];
    if (canU(u)) out.push('BAO_U');
    if (lastTurn(u)) {
      if (!st.laid.get(u).length && haPossible(u)) out.push('HA');
      if (st.laid.get(u).length && sendable(u)) out.push('GUI');
    }
    return out;
  }

  const fail = (code, message) => ({ ok: false, error: { code, message } });

  function apply(u, { action, cards = [] } = {}) {
    u = String(u);
    if (st.done) return fail('DONE', 'Ván đã kết thúc');
    if (!offered(u).includes(action)) return fail('NOT_OFFERED', action + ' không có trong nút game');
    const events = [];
    if (action === 'BOC') {
      const code = st.deck.shift();
      if (code == null) return fail('DECK_EMPTY', 'Hết nọc');
      handOf(u).push(code); st.phase = 'PLAY';
      events.push({ type: 'DRAW', uid: u, card: code, hand: handOf(u).slice() });
    } else if (action === 'AN') {
      const { code, uid: from } = st.last;
      const chot = st.discards.get(from).length === TURNS; // the discarder's 4th discard
      handOf(u).push(code); st.locked.get(u).add(code); // still counts as the discarder's turn (as the observer counts it)
      st.eats.push({ eater: u, from, card: code, chot });
      st.last = null; st.phase = 'PLAY';
      events.push({ type: 'EAT', uid: u, from, card: code, hand: handOf(u).slice() });
    } else if (action === 'BAO_U') {
      st.done = true; st.u = u;
      events.push({ type: 'ROUND_END', uid: u, u: true });
    } else if (action === 'HA') {
      const hand = inHand(u); const locked = st.locked.get(u);
      if (cards.some((c) => !hand.includes(c))) return fail('NOT_IN_HAND', 'Lá không có trên tay');
      const splits = help.arrangements(cards).filter((a) => !a.loose.length && a.melds.length);
      if (!splits.length) return fail('NOT_MELDS', 'Các lá chưa thành phỏm');
      const rest = hand.filter((c) => !cards.includes(c));
      if ([...locked].some((c) => rest.includes(c))) return fail('EATEN_NOT_LAID', 'Lá ăn phải được hạ');
      const parts = splits.find((a) => a.melds.every((m) => m.filter((c) => locked.has(c)).length <= 1));
      if (!parts) return fail('TWO_EATEN', 'Một phỏm có 2 lá ăn');
      const mes = parts.melds.map((m) => ({ meid: ++st.meid, cards: m.slice() }));
      st.laid.get(u).push(...mes); st.layOrder.push(u);
      events.push({ type: 'MELD', uid: u, melds: mes.map((m) => ({ meid: m.meid, cards: m.cards.slice() })) });
    } else if (action === 'GUI') {
      const hand = inHand(u);
      if (!cards.length || cards.some((c) => !hand.includes(c))) return fail('NOT_IN_HAND', 'Lá không có trên tay');
      const chain = help.sendChain(cards, tableMelds());
      if (chain.rest.length) return fail('NO_FIT', 'Lá không gửi được');
      for (const s of chain.sent) {
        const owner = st.laid.get(s.owner).find((m) => m.meid === s.meid); owner.cards.push(s.code);
        handOf(u).splice(handOf(u).indexOf(s.code), 1); st.sent.get(u).push(s.code);
      }
      events.push({ type: 'SEND', uid: u, sends: chain.sent.map((s) => ({ meid: s.meid, card: s.code })) });
    } else if (action === 'DANH') {
      const code = cards[0];
      const hand = inHand(u); const locked = st.locked.get(u);
      if (cards.length !== 1 || !hand.includes(code)) return fail('NOT_IN_HAND', 'Lá không có trên tay');
      if (locked.has(code)) return fail('EATEN_CARD', 'Không đánh lá đã ăn');
      const rest = hand.filter((c) => c !== code);
      if (!st.laid.get(u).length && locked.size && !help.arrangements(rest).some((a) => lockedOk(a, rest, locked))) return fail('BREAKS_EATEN', 'Phá phỏm có lá ăn');
      handOf(u).splice(handOf(u).indexOf(code), 1);
      st.discards.get(u).push(code); st.last = { uid: u, code };
      const next = nextOf(u);
      events.push({ type: 'PLAY', uid: u, card: code, next });
      if (order.every((x) => st.discards.get(x).length >= TURNS)) { st.done = true; events.push({ type: 'ROUND_END' }); }
      else { st.turn = order.indexOf(next); st.phase = 'TAKE'; }
    }
    return { ok: true, events };
  }

  function result() {
    if (!st.done) return null;
    const net = Object.fromEntries(order.map((u) => [u, 0]));
    const pay = (from, to, n) => { net[from] -= n; net[to] += n; };
    for (const e of st.eats) pay(e.from, e.eater, e.chot ? rules.eatChot : rules.eat);
    if (st.u) {
      const eatsByU = st.eats.filter((e) => e.eater === st.u);
      const den = rules.den && eatsByU.length >= 3 ? prevOf(st.u) : null;
      for (const x of order) if (x !== st.u) pay(den || x, st.u, rules.u);
      return { winner: st.u, kind: 'U', den, net, ranks: [st.u], mom: [], eats: st.eats.slice(), points: {} };
    }
    const points = {};
    const mom = order.filter((u) => !st.laid.get(u).length);
    // on points the loose cards count (laid and sent are gone); a tie goes to who laid first
    const ranked = order.filter((u) => !mom.includes(u))
      .map((u) => ({ u, pts: inHand(u).reduce((s, c) => s + cardPoints(c), 0) }))
      .sort((a, b) => (a.pts - b.pts) || (st.layOrder.indexOf(a.u) - st.layOrder.indexOf(b.u))).map((x) => x.u);
    const winner = ranked[0] || null; // everyone móm: no ranking payment
    if (winner) {
      ranked.forEach((u, i) => { if (i > 0) pay(u, winner, rules.rank[Math.min(i, rules.rank.length - 1)]); });
      for (const u of mom) pay(u, winner, rules.mom);
    }
    for (const u of order) points[u] = inHand(u).reduce((s, c) => s + cardPoints(c), 0);
    return { winner, kind: 'POINTS', den: null, net, ranks: ranked.concat(mom), mom, eats: st.eats.slice(), points };
  }

  return {
    deal, order, offered, apply, result, current: cur,
    get done() { return st.done; },
    inHand, canEat, canU, lastTurn, lockedOf: (u) => new Set(st.locked.get(u)), tableMelds, discardsOf: (u) => st.discards.get(u).slice(),
  };
}

module.exports = { createRound, RULES, TURNS, shuffle, lockedOk };
