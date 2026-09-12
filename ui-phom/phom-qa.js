'use strict';

// Phỏm QA standalone renderer. Talks ONLY to window.phomQA (typed preload). No raw
// WS sender, no CDP, no proxy password. 2×2 workspace: 3 managed external browser
// status cells + a control cell. No gameplay automation / no strategy controls.
(function () {
  const api = window.phomQA || {};
  const SUIT_RED = new Set(['♦', '♥']);
  const SLOTS = ['A', 'B', 'C'];
  let caps = {};
  let session = null;
  let hands = [];
  let proxies = [];
  let assign = { A: { proxyRef: '', runId: null, ip: null, testState: 'NOT_TESTED' }, B: { proxyRef: '', runId: null, ip: null, testState: 'NOT_TESTED' }, C: { proxyRef: '', runId: null, ip: null, testState: 'NOT_TESTED' } };

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) { if (kid == null || kid === false) continue; n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); }
    return n;
  }
  const $ = (id) => document.getElementById(id);
  const pill = (l, v, c) => el('span', { class: 'pill ' + (c || '') }, l + ' ', el('b', null, String(v)));

  // ---------- boot / license ----------
  async function boot() {
    let status = {};
    try { status = await api.licenseStatus(); } catch { status = {}; }
    if (status && status.active) return showWorkspace();
    return showActivation(status);
  }

  async function showActivation(status) {
    $('workspace').hidden = true;
    $('activation').hidden = false;
    try { const m = await api.machineId(); $('act-machine').value = (m && m.machineId) || '—'; } catch {}
    if (status && status.error) { $('act-error').hidden = false; $('act-error').textContent = friendlyLicenseError(status.error); }
    $('act-copy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('act-machine').value); };
    $('act-go').onclick = async () => {
      $('act-error').hidden = true;
      const res = await api.activateLicense($('act-key').value.trim());
      if (res && res.active) { boot(); }
      else { $('act-error').hidden = false; $('act-error').textContent = friendlyLicenseError(res && res.error); }
    };
  }

  function friendlyLicenseError(e) {
    if (!e) return 'Kích hoạt thất bại.';
    if (e.code === 'LICENSE_GAME_PRODUCT_MISMATCH') return 'Key này dành cho Aviator, không dùng được cho Phỏm QA.';
    if (e.code === 'LICENSE_PHOM_ENTITLEMENT_REQUIRED') return 'Key cũ không có quyền Phỏm QA. Cần key có quyền PHOM.';
    if (e.code === 'LICENSE_MACHINE_MISMATCH') return 'Key không khớp thiết bị này.';
    if (e.code === 'LICENSE_EXPIRED') return 'Key đã hết hạn.';
    return e.message || e.code || 'Kích hoạt thất bại.';
  }

  async function showWorkspace() {
    $('activation').hidden = true;
    $('workspace').hidden = false;
    try { caps = await api.capabilities(); } catch { caps = {}; }
    try { const p = await api.proxyList(); proxies = (p && p.proxies) || []; } catch { proxies = []; }
    try { session = await api.sessionState(); if (session && session.hands) hands = session.hands; } catch {}
    renderAll();
  }

  function renderAll() { renderControl(); for (const s of SLOTS) renderBrowserCell(s); }

  // ---------- browser cells (managed external Chrome windows — NOT embedded) ----------
  function renderBrowserCell(slot) {
    const body = $('body-' + slot); if (!body) return;
    body.innerHTML = '';
    const a = assign[slot];
    const prof = session ? (session.profiles || []).find((p) => p.__slot === slot || (a.runId && p.id === a.runId)) : null;
    body.appendChild(el('div', { class: 'prow' },
      el('div', null, el('b', null, 'Proxy '), proxySelector(slot)),
      el('div', null,
        el('button', { class: 'btn', onclick: () => testProxy(slot) }, 'Test'),
        el('button', { class: 'btn', onclick: () => addProxyPrompt(slot) }, '+ Proxy'),
        el('span', { class: 'badge ' + testBadge(a.testState) }, a.testState),
        a.ip ? el('span', { class: 'faint' }, ' IP ' + a.ip) : null,
      ),
      el('div', null,
        el('span', { class: 'dot ' + (prof && prof.socketReady ? 'on' : 'off') }), ' Browser ',
        el('button', { class: 'btn', onclick: () => openOne(slot) }, prof ? 'Mở lại' : 'Mở game'),
      ),
      el('div', { class: 'faint' }, 'Ghế ', el('b', null, prof && prof.seat != null ? String(prof.seat) : '—'),
        ' · ', (prof && prof.ready ? 'Sẵn sàng' : 'Chưa'), prof && prof.lastError ? el('span', { class: 'warnrow' }, ' ' + prof.lastError.code) : null),
    ));
    // The game itself is in a managed external Chrome window — this cell is live status,
    // not an embedded webview.
    body.appendChild(el('div', { class: 'faint', style: 'margin-top:6px;font-size:11px' }, 'Game mở ở cửa sổ Chrome riêng (thao tác bài thủ công tại đó).'));
  }

  function proxySelector(slot) {
    const sel = el('select', { class: 'sel', onchange: (e) => { assign[slot].proxyRef = e.target.value; } });
    sel.appendChild(el('option', { value: '' }, '— chọn proxy —'));
    for (const p of proxies) sel.appendChild(el('option', { value: p.id, selected: assign[slot].proxyRef === p.id }, `${p.label} (${p.protocol})`));
    return sel;
  }
  function testBadge(s) { return ({ PASS: 'good', FAILED: 'bad', AUTH_FAILED: 'bad', TIMEOUT: 'warn', TESTING: 'warn' })[s] || 'faint'; }

  async function addProxyPrompt(slot) {
    // Minimal inline form in the control note area.
    const host = prompt('Proxy host:'); if (!host) return;
    const port = Number(prompt('Port (1-65535):') || '0');
    const protocol = (prompt('Protocol (http/https/socks4/socks5):', 'http') || 'http').toLowerCase();
    const username = prompt('Username (bỏ trống nếu không):', '') || '';
    const password = username ? (prompt('Password:', '') || '') : '';
    const res = await api.proxyUpsert({ label: `${protocol}://${host}:${port}`, protocol, host, port, username: username || null, password: password || null });
    if (!res || !res.ok) { note(errText(res), true); return; }
    assign[slot].proxyRef = res.id;
    const p = await api.proxyList(); proxies = (p && p.proxies) || [];
    renderAll();
  }

  async function testProxy(slot) {
    const ref = assign[slot].proxyRef;
    if (!ref) return note('Chọn proxy cho ' + slot + ' trước.', true);
    assign[slot].testState = 'TESTING'; renderBrowserCell(slot);
    const res = await api.proxyTest(ref);
    const r = res && res.result;
    assign[slot].testState = (r && r.state) || 'FAILED';
    assign[slot].ip = r && r.observedIp || null;
    renderBrowserCell(slot); renderControl();
  }

  async function openOne(slot) {
    const ref = assign[slot].proxyRef;
    const res = await api.openProfile({ slot, url: 'about:blank', proxyRef: ref || null, proxyRequired: true, label: 'Profile ' + slot });
    if (!res || !res.ok) return note(errText(res), true);
    assign[slot].runId = res.runId;
    note('Đã mở browser ' + slot + '. Đăng nhập rồi mở game Phỏm.');
  }

  // ---------- control cell ----------
  function renderControl() {
    const r = $('phq-root'); if (!r) return;
    r.innerHTML = '';
    const s = session || {};
    r.appendChild(el('div', null,
      el('b', { style: 'font-size:16px' }, 'PHỎM QA'),
      el('span', { class: 'faint', style: 'margin-left:8px' }, s.state || 'IDLE'),
    ));
    r.appendChild(el('div', { style: 'margin:6px 0' },
      pill('Browser', browserCount() + '/3', browserCount() === 3 ? 'good' : ''),
      pill('Connected', (s.onlineCount || 0) + '/3', (s.onlineCount || 0) === 3 ? 'good' : ''),
      pill('Cùng bàn', s.sameTable ? 'YES' : 'NO', s.sameTable ? 'good' : 'bad'),
      pill('Ready', (s.readyCount || 0) + '/3', (s.readyCount || 0) === 3 ? 'good' : ''),
      caps.authorized ? pill('Env', 'QA ✓', 'good') : pill('Env', 'passive', 'warn'),
      s.hasOutsider ? pill('Người ngoài', '!', 'warn') : null,
    ));
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));

    // table controls
    r.appendChild(el('div', { class: 'section-t' }, 'BÀN & MỨC CƯỢC'));
    const chans = collectChannels(s);
    const sel = el('select', { class: 'sel', id: 'phq-chan' });
    sel.appendChild(el('option', { value: '' }, '— mức cược —'));
    for (const c of chans) sel.appendChild(el('option', { value: c.rid }, `${c.rn || 'Phom'} · rid ${c.rid} · b=${c.b}`));
    r.appendChild(el('div', null, sel,
      el('button', { class: 'btn', onclick: step(() => api.requestChannels(), 'Đã lấy mức cược.') }, 'Lấy mức cược'),
      el('button', { class: 'btn', onclick: () => testAllProxies() }, 'Test tất cả proxy'),
    ));
    r.appendChild(el('button', { class: 'btn primary', disabled: !ctaEnabled(s), onclick: joinTogether }, 'VÀO CHUNG BÀN'));
    r.appendChild(el('div', null,
      el('button', { class: 'btn', onclick: step(() => api.rejoin(), 'ReJoin lệch bàn.') }, 'ReJoin'),
      el('button', { class: 'btn', onclick: step(() => api.readyAll(), 'Đã gửi Sẵn sàng.') }, 'Sẵn sàng'),
      el('button', { class: 'btn', onclick: step(() => api.leaveAll(), 'Đã rời bàn.') }, 'Rời bàn'),
      el('button', { class: 'btn danger', onclick: step(() => api.stop(), 'Đã dừng.') }, 'Dừng'),
    ));
    r.appendChild(el('div', { class: 'note ' + (s.sameTable ? 'ok' : '') }, 'Kết luận bàn: ' + (s.tableVerdict || '—')));
    if (!ctaEnabled(s)) r.appendChild(el('div', { class: 'warnrow' }, ctaReason(s)));

    // hands
    r.appendChild(el('div', { class: 'section-t' }, 'BA TAY BÀI'));
    const list = hands.length ? hands : (s.hands || []);
    if (!list.length) r.appendChild(el('div', { class: 'faint' }, 'Chưa nhận bài.'));
    for (const h of list) r.appendChild(handRow(h));

    const det = el('details', { class: 'adv' }, el('summary', null, 'Advanced Debug'));
    det.appendChild(el('pre', { style: 'font-size:11px;color:#9fb0cc;max-height:180px;overflow:auto;white-space:pre-wrap' }, session ? JSON.stringify(session, null, 2) : '(chưa có phiên)'));
    r.appendChild(det);
  }

  function handRow(h) {
    const meldSet = new Set(h.serverMelds || []);
    const order = (h.sortedCards && h.sortedCards.length) ? h.sortedCards : (h.cards || []);
    const byCode = new Map((h.decoded || []).map((d) => [d.code, d]));
    const cards = el('div', { class: 'cards' });
    if (!order.length) cards.appendChild(el('span', { class: 'faint' }, 'Chưa nhận bài'));
    for (const code of order) { const d = byCode.get(code) || {}; cards.appendChild(el('span', { class: 'card-face ' + (SUIT_RED.has(d.suit) ? 'red' : 'black') + (meldSet.has(code) ? ' meld' : ''), title: meldSet.has(code) ? 'Server Meld' : '' }, el('b', null, d.rank || '?'), el('span', null, d.suit || '?'))); }
    return el('div', { style: 'margin:6px 0' },
      el('div', null, el('b', null, h.displayName || h.profileId), ' ', el('span', { class: 'badge ' + syncCls(h.syncState) }, h.syncState), el('span', { class: 'faint' }, ' lá ' + (h.cardCount || 0))),
      cards);
  }

  // ---------- actions ----------
  const step = (fn, ok) => async () => { const res = await fn(); if (res && res.ok === false) note(errText(res), true); else if (ok) note(ok); refresh(); };
  async function refresh() { try { session = await api.sessionState(); if (session && session.hands) hands = session.hands; } catch {} renderAll(); }
  async function joinTogether() {
    const ch = $('phq-chan').value; if (!ch) return note('Chọn mức cược trước.', true);
    await api.selectChannel(Number(ch));
    const res = await api.joinTogether(Number(ch));
    if (res && res.ok === false) note(errText(res), true); else note('Đã gửi JOIN cho 3 hồ sơ.');
    refresh();
  }
  async function testAllProxies() {
    const ids = SLOTS.map((s) => assign[s].proxyRef).filter(Boolean);
    if (!ids.length) return note('Chưa gán proxy.', true);
    const res = await api.proxyTestAll(ids);
    const results = res && res.results || {};
    for (const s of SLOTS) { const r = results[assign[s].proxyRef]; if (r) { assign[s].testState = r.state; assign[s].ip = r.observedIp || null; } }
    renderAll();
  }

  // ---------- helpers ----------
  function browserCount() { return SLOTS.filter((s) => assign[s].runId).length; }
  function collectChannels(s) { const m = new Map(); for (const p of (s.profiles || [])) for (const c of (p.channels || [])) if (c.rid != null && !m.has(c.rid)) m.set(c.rid, c); return [...m.values()]; }
  function proxiesReady() { return SLOTS.every((s) => assign[s].proxyRef && assign[s].testState === 'PASS'); }
  function ipsDistinct() { const ips = SLOTS.map((s) => assign[s].ip).filter(Boolean); return ips.length === 3 && new Set(ips).size === 3; }
  function ctaEnabled() { return !!caps.authorized && browserCount() === 3 && proxiesReady(); }
  function ctaReason(s) {
    if (!caps.authorized) return 'Môi trường chưa được cấp quyền QA (đặt PHOM_QA_AUTHORIZED=1 hoặc allowlist).';
    if (browserCount() < 3) return 'Cần mở đủ 3 browser.';
    if (!proxiesReady()) return 'Cả 3 proxy phải Test PASS.';
    return '';
  }
  function syncCls(x) { return ({ LIVE: 'good', ENDED: 'faint', STALE: 'warn', DESYNCED: 'bad', EMPTY: 'faint' })[x] || 'faint'; }
  function errText(res) { const e = res && res.error; return e ? `${e.code}: ${e.message}` : 'Thao tác thất bại.'; }
  function note(msg, warn) { const n = $('phq-note'); if (n) { n.textContent = msg; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }

  // ---------- boot ----------
  if (api.onSession) api.onSession((snap) => { session = snap; if (snap && snap.hands) hands = snap.hands; if (!$('workspace').hidden) renderAll(); });
  if (api.onHands) api.onHands((h) => { hands = h; if (!$('workspace').hidden) renderControl(); });
  if (api.onLicense) api.onLicense((s) => { if (s && s.active && !$('activation').hidden) boot(); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
