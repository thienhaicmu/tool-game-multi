'use strict';

// Phỏm QA tool window — card views: CÒN LẠI grouped into the possible phỏm (sets / runs / loose). Pure: the cards and
// the view mode come in as arguments. Needs ui-kit.js.

(function () {
  const UI = window.PhomUI = window.PhomUI || {};
  const { el } = UI;
  const rankOfCode = (code) => Math.floor(Number(code) / 4);   // 0 = A … 12 = K (card-codec)
  const suitOfCode = (code) => Number(code) % 4;
  // Possible PHỎM among the unseen cards: SETS (3–4 of one rank) and RUNS (3+ consecutive of one suit), each sorted
  // small → big; a card in no possible phỏm is LẺ. A card may sit in a set AND a run (both are possible).
  function groupByPhom(cards) {
    const byRank = new Map(), bySuit = new Map();
    for (const c of cards) {
      const r = rankOfCode(c.code), s = suitOfCode(c.code);
      (byRank.get(r) || byRank.set(r, []).get(r)).push(c);
      (bySuit.get(s) || bySuit.set(s, []).get(s)).push(c);
    }
    const sets = [...byRank.entries()].filter(([, cs]) => cs.length >= 3).sort((a, b) => a[0] - b[0]).map(([, cs]) => cs);
    const runs = [];
    for (const s of [0, 1, 2, 3]) {
      const cs = (bySuit.get(s) || []).slice().sort((a, b) => rankOfCode(a.code) - rankOfCode(b.code));
      let cur = [];
      for (const c of cs) {
        if (cur.length && rankOfCode(c.code) !== rankOfCode(cur[cur.length - 1].code) + 1) { if (cur.length >= 3) runs.push(cur); cur = []; }
        cur.push(c);
      }
      if (cur.length >= 3) runs.push(cur);
    }
    const inPhom = new Set([].concat(...sets, ...runs).map((c) => c.code));
    return { sets, runs, loose: cards.filter((c) => !inPhom.has(c.code)) };
  }
  // kind: 'set' / 'run' / 'both' (a card that can be in a phỏm of either kind) / 'loose' — drives the highlight
  function bigCard(c, kind) {
    const tip = (c.label || '') + (kind === 'set' ? ' · trong phỏm ngang' : kind === 'run' ? ' · trong phỏm dọc' : kind === 'both' ? ' · trong phỏm ngang và dọc' : kind === 'loose' ? ' · lá lẻ' : '');
    return el('span', { class: 'card-face big ' + (c.color === 'red' ? 'red' : 'black') + (kind ? ' k-' + kind : ''), title: tip }, el('b', null, c.rank || '?'), el('span', null, c.suit || '?'));
  }
  // mode: 'PHOM' (grouped into possible phỏm) | 'ORDER' (A → K); onMode(m) switches it
  function remainingPanel(cards, mode, onMode) {
    const box = el('div', { class: 'rem' });
    const seg = (m, label, tip) => el('button', { class: 'seg' + (mode === m ? ' active' : ''), title: tip, onclick: () => onMode(m) }, label);
    box.appendChild(el('div', { class: 'rem-h' },
      el('span', { class: 'rem-title', title: 'Lá chưa xuất hiện — đang ở tay acc lạ hoặc còn trong nọc' }, '🂠 Còn lại' + (cards ? ' · ' + cards.length + ' lá' : '')),
      el('span', { class: 'spacer' }),
      el('span', { class: 'segs', role: 'group', 'aria-label': 'Cách xếp' }, seg('PHOM', 'Theo phỏm', 'Nhóm thành phỏm ngang / dọc có thể có, rồi lá lẻ'), seg('ORDER', 'Thứ tự', 'Tất cả từ bé tới lớn (A → K)'))));
    if (!cards) { box.appendChild(el('div', { class: 'safe-empty' }, 'Chưa có ván — vào bàn và chia bài để xem lá còn lại')); return box; }
    if (!cards.length) { box.appendChild(el('div', { class: 'safe-empty' }, 'Không còn lá nào chưa xuất hiện')); return box; }
    const g = groupByPhom(cards);
    // which possible phỏm each card belongs to — the highlight in BOTH views
    const inSet = new Set([].concat(...g.sets).map((x) => x.code)), inRun = new Set([].concat(...g.runs).map((x) => x.code));
    const kindOf = (c) => (inSet.has(c.code) && inRun.has(c.code) ? 'both' : inSet.has(c.code) ? 'set' : inRun.has(c.code) ? 'run' : 'loose');
    const row = (cs, kind) => el('div', { class: 'cards big' }, ...cs.map((c) => bigCard(c, kind || kindOf(c))));
    if (mode === 'ORDER') {
      box.appendChild(row(cards));
      box.appendChild(el('div', { class: 'rem-legend' }, el('span', { class: 'lg lg-set' }, 'phỏm ngang'), el('span', { class: 'lg lg-run' }, 'phỏm dọc'), el('span', { class: 'lg lg-loose' }, 'lá lẻ (mờ)')));
      return box;
    }
    // each possible phỏm in its own tinted frame (sets purple, runs blue), then the loose cards
    const phom = (cs, kind, title) => el('div', { class: 'phom-box pb-' + kind, title }, row(cs, kind));
    const section = (title, cls, groups, kind, tip) => el('div', { class: 'rem-sec ' + cls, title: tip },
      el('div', { class: 'g-label' }, title + ' (' + groups.length + ')'),
      el('div', { class: 'rem-groups' }, ...groups.map((cs) => phom(cs, kind, cs.map((x) => x.label).join(' ')))));
    if (g.sets.length) box.appendChild(section('Phỏm ngang', 'g-set', g.sets, 'set', '3–4 lá cùng số chưa xuất hiện'));
    if (g.runs.length) box.appendChild(section('Phỏm dọc', 'g-run', g.runs, 'run', '3+ lá cùng chất liền nhau chưa xuất hiện'));
    if (g.loose.length) box.appendChild(el('div', { class: 'rem-sec g-loose', title: 'Không nằm trong phỏm nào có thể có' }, el('div', { class: 'g-label' }, 'Lá lẻ (' + g.loose.length + ')'), row(g.loose, 'loose')));
    if (!g.sets.length && !g.runs.length) box.appendChild(el('div', { class: 'muted rem-note' }, 'Không còn phỏm nào có thể có trong các lá chưa xuất hiện.'));
    return box;
  }
  Object.assign(UI, { groupByPhom, bigCard, remainingPanel });
})();
