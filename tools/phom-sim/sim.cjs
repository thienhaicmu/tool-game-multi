'use strict';

// ---------------------------------------------------------------------------
// PHỎM SIMULATOR — driver (plan GĐ3 · S4). Plays rounds with the REAL Tự đánh chooser (phom-auto-play nextStep) reading
// the REAL card observer (phom-card-observer), fed with the frames each seat would see:
//   tool seats ('T') share ONE observer (as the live coordinator does: P1–P3's own frames + public ones);
//   outsider seats ('L') each get their own observer (own frames + public) and play the normal scenario (no tool uids).
// Whatever the chooser cannot do (a wait, a step the engine refuses) is counted as an ANOMALY — on a live table that is
// "Tự đánh dừng" — and the round goes on with a plain fallback move so the numbers stay comparable.
//
//   simulate({ rounds, seed, seats: 'TTTL', strategy, rules, outsider, onRound }) → summary
// outsider = the chooser module the 'L' seats use (default: this checkout's). To measure a change, keep the outsiders on
// the released chooser (run.mjs --outsider-ref <commit>) so only the tool side changes.
// ---------------------------------------------------------------------------

const { createCardObserver } = require('../../desktop/protocol/phom/phom-card-observer.cjs');
const autoPlay = require('../../desktop/protocol/phom/phom-auto-play.cjs');
const help = require('../../desktop/protocol/phom/phom-play-help.cjs');
const { cardPoints } = require('../../desktop/protocol/phom/phom-rules.cjs');
const { createRound, RULES, lockedOk } = require('./engine.cjs');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function createViewers(seats) {
  const uids = seats.split('').map((k, i) => (k === 'T' ? 'T' : 'L') + (i + 1));
  const tool = uids.filter((u) => u[0] === 'T');
  if (tool.length > 3) throw new Error('at most 3 tool seats (P1–P3)');
  let clock = 0;
  const now = () => ++clock;
  const toolView = { obs: createCardObserver({ now, logEnabled: false }), owns: new Set(tool), slotOf: new Map(tool.map((u, i) => [u, 'B' + (i + 1)])) };
  const views = new Map(tool.map((u) => [u, toolView]));
  for (const u of uids.filter((x) => x[0] === 'L')) views.set(u, { obs: createCardObserver({ now, logEnabled: false }), owns: new Set([u]), slotOf: new Map([[u, 'B1']]) });
  const all = [...new Set(views.values())];
  return { uids, tool, views, all };
}

// one engine event → the frame each viewer receives
function feed(viewers, ev, order) {
  for (const v of viewers.all) {
    const own = ev.uid != null && v.owns.has(ev.uid);
    const anyOwn = [...v.owns][0];
    const send = (cls, ownUid = anyOwn) => v.obs.ingestFrame({ slot: v.slotOf.get(ownUid), ownUid, cls });
    switch (ev.type) {
      case 'DEAL': if (own) send({ type: 'DEAL', cs: ev.cards, json: [0, { lpi: ev.lpi }], tP: { uid: ev.first } }, ev.uid); break;
      case 'DRAW': if (own) send({ type: 'DRAW', sAC: ev.hand, cs: ev.card }, ev.uid); break;
      case 'EAT': send(own ? { type: 'EAT', fP: { uid: ev.uid, puid: ev.from }, cs: ev.card, sAC: ev.hand } : { type: 'EAT', fP: { uid: ev.uid, puid: ev.from }, cs: ev.card }, own ? ev.uid : anyOwn); break;
      case 'PLAY': send({ type: 'PLAY', fP: { uid: ev.uid, dCs: [ev.card] }, tP: { uid: ev.next } }); break;
      case 'MELD': send({ type: 'MELD', uid: ev.uid, mes: ev.melds.map((m) => ({ meid: m.meid, cs: m.cards })) }); break;
      case 'SEND': send({ type: 'SEND', uid: ev.uid, aMs: ev.sends.map((s) => ({ meid: s.meid, cs: [s.card] })) }); break;
      case 'ROUND_END': send({ type: 'ROUND_END', ps: order.map((uid) => ({ uid })) }); break;
      default: break;
    }
  }
}

// a plain legal move when the chooser could not give one (counted as an anomaly)
function fallback(round, u, offered) {
  if (offered.includes('BAO_U')) return { action: 'BAO_U', cards: [] };
  if (offered.includes('BOC')) return { action: 'BOC', cards: [] };
  const hand = round.inHand(u); const locked = round.lockedOf(u);
  if (offered.includes('HA')) {
    const a = help.arrangements(hand).filter((x) => x.melds.length && lockedOk(x, hand, locked)).sort((x, y) => x.points - y.points)[0];
    if (a) return { action: 'HA', cards: a.melds.flat() };
  }
  if (offered.includes('GUI')) {
    const sent = help.sendChain(hand, round.tableMelds()).sent.map((s) => s.code);
    if (sent.length) return { action: 'GUI', cards: sent };
  }
  const order = hand.filter((c) => !locked.has(c)).sort((a, b) => cardPoints(b) - cardPoints(a));
  return { action: 'DANH', cards: [order[0]], candidates: order };
}

function simulate({ rounds = 100, seed = 1, seats = 'TTTL', strategy = {}, rules = RULES, startMoney = 1000, outsider = autoPlay, rotate = 'fixed', onRound = null } = {}) {
  const rng = mulberry32(seed);
  const viewers = createViewers(seats);
  const money = Object.fromEntries(viewers.uids.map((u) => [u, startMoney]));
  const sum = {
    rounds: 0, seats, seed, strategy, rules,
    net: Object.fromEntries(viewers.uids.map((u) => [u, 0])), netSq: Object.fromEntries(viewers.uids.map((u) => [u, 0])),
    toolNet: 0, toolNetSq: 0, mom: {}, u: {}, den: {}, wins: {}, eatsGiven: {}, eatsTaken: {}, chotGiven: {},
    anomalies: {}, anomalyCount: 0, decisions: 0, ms: 0, perRound: [],
  };
  const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  let order = viewers.uids.slice();
  const t0 = Date.now();
  for (let r = 0; r < rounds; r++) {
    const round = createRound({ uids: order, rng, rules });
    for (const v of viewers.all) v.obs.ingestFrame({ slot: v.slotOf.get([...v.owns][0]), ownUid: [...v.owns][0], cls: { type: 'TABLE_STATE', ps: order.map((uid, i) => ({ uid, sit: viewers.uids.indexOf(uid), dn: uid })) } });
    for (const ev of round.deal) feed(viewers, ev, order);
    const avoid = new Map();
    for (let guard = 0; !round.done && guard < 400; guard++) {
      const u = round.current(); const offered = round.offered(u);
      const isTool = viewers.tool.includes(u);
      const snap = viewers.views.get(u).obs.getSnapshot();
      const av = avoid.get(u) || new Set();
      let step;
      try { step = (isTool ? autoPlay : outsider).nextStep(snap, u, offered, av, isTool ? viewers.tool : [], { strategy, moneyByUid: money }); }
      catch (e) { step = { wait: true, why: 'LỖI ' + String(e && e.message).slice(0, 60) }; }
      sum.decisions++;
      let res = null;
      if (step && step.action) {
        res = round.apply(u, { action: step.action, cards: step.cards });
        if (!res.ok && step.action === 'AN') { av.add('AN'); avoid.set(u, av); bump(sum.anomalies, (isTool ? 'T' : 'L') + ' AN bị từ chối'); sum.anomalyCount++; continue; }
        if (!res.ok) { bump(sum.anomalies, (isTool ? 'T' : 'L') + ' ' + step.action + ' ' + res.error.code); sum.anomalyCount++; }
      } else {
        const why = String((step && (step.why || step.message)) || 'không có nước').replace(/[0-9AJQK]+[♠♣♦♥]/g, 'X');
        bump(sum.anomalies, (isTool ? 'T' : 'L') + ' chờ: ' + why); sum.anomalyCount++;
      }
      if (!res || !res.ok) {
        const fb = fallback(round, u, offered);
        res = round.apply(u, fb);
        for (const c of (!res.ok && fb.candidates) || []) { res = round.apply(u, { action: 'DANH', cards: [c] }); if (res.ok) break; }
        if (!res.ok) throw new Error('fallback refused: ' + JSON.stringify(res.error));
      }
      if (res.events.some((e) => e.type === 'PLAY' || e.type === 'DRAW' || e.type === 'EAT')) avoid.delete(u);
      for (const ev of res.events) feed(viewers, ev, order);
    }
    if (!round.done) throw new Error('round did not finish');
    const out = round.result();
    sum.rounds++;
    let toolNet = 0;
    for (const u of viewers.uids) {
      const n = out.net[u] || 0; sum.net[u] += n; sum.netSq[u] += n * n; money[u] += n;
      if (viewers.tool.includes(u)) toolNet += n;
    }
    sum.toolNet += toolNet; sum.toolNetSq += toolNet * toolNet; sum.perRound.push(toolNet);
    for (const u of out.mom) bump(sum.mom, u);
    if (out.kind === 'U') bump(sum.u, out.winner);
    if (out.den) bump(sum.den, out.den);
    if (out.winner) bump(sum.wins, out.winner);
    for (const e of out.eats) { bump(sum.eatsGiven, e.from); bump(sum.eatsTaken, e.eater); if (e.chot) bump(sum.chotGiven, e.from); }
    if (onRound) onRound({ index: r, order, result: out });
    // 'winner': the winner starts the next round (the game's rule). 'fixed' (default): round r always starts at seat
    // r mod n — with the same seed every version then plays the SAME deals from the SAME seats, so two runs can be
    // compared round by round (paired), which needs far fewer rounds than comparing two averages.
    if (rotate === 'winner' && out.winner) { const i = order.indexOf(out.winner); order = order.slice(i).concat(order.slice(0, i)); }
    else if (rotate !== 'winner') { const i = (r + 1) % viewers.uids.length; order = viewers.uids.slice(i).concat(viewers.uids.slice(0, i)); }
  }
  sum.ms = Date.now() - t0;
  return sum;
}

// mean ± 95% half-width per round
function stat(total, sq, n) {
  const mean = total / n;
  const variance = n > 1 ? Math.max(0, (sq - n * mean * mean) / (n - 1)) : 0;
  return { mean, ci95: 1.96 * Math.sqrt(variance / n) };
}

function report(sum) {
  const n = sum.rounds;
  const per = (o, u) => (o[u] || 0) / n;
  const players = Object.keys(sum.net).map((u) => ({
    uid: u, net: stat(sum.net[u], sum.netSq[u], n), mom: per(sum.mom, u), u: per(sum.u, u), den: per(sum.den, u),
    win: per(sum.wins, u), eatsGiven: per(sum.eatsGiven, u), eatsTaken: per(sum.eatsTaken, u), chotGiven: per(sum.chotGiven, u),
  }));
  const anomalies = Object.entries(sum.anomalies).sort((a, b) => b[1] - a[1]).map(([why, count]) => ({ why, count }));
  return { rounds: n, seats: sum.seats, seed: sum.seed, strategy: sum.strategy, toolNet: stat(sum.toolNet, sum.toolNetSq, n), players,
    anomalyPerRound: sum.anomalyCount / n, anomalies, decisions: sum.decisions, msPerRound: sum.ms / n, perRound: sum.perRound };
}

// two reports of the same seed/seats (fixed rotation): the tool group's gain per round, paired → mean ± 95%
function paired(a, b) {
  const n = Math.min(a.perRound.length, b.perRound.length);
  let s = 0, sq = 0;
  for (let i = 0; i < n; i++) { const d = b.perRound[i] - a.perRound[i]; s += d; sq += d * d; }
  return { rounds: n, ...stat(s, sq, n) };
}

module.exports = { simulate, report, paired, mulberry32, createViewers };
