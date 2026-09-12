'use strict';

// Phỏm QA standalone renderer. Talks ONLY to window.phomQA (typed preload). No raw
// WS sender, no CDP, no proxy password. 2×2 workspace: 3 managed external browser
// status cells + a control cell. No gameplay automation / no strategy controls.
(function () {
  const api = window.phomQA || {};
  const SUIT_RED = new Set(['♦', '♥']);
  const SLOTS = ['A', 'B', 'C'];
  let caps = {};
  let licenseMode = 'LICENSED';
  let session = null;
  let hands = [];
  let proxies = [];
  let presets = [];          // mobile device presets
  let profiles = {};         // slot -> saved profile (device + proxyRef)
  let hostId = null;         // runId of the chosen HOST (or slot label before open)
  let selectedStake = null;
  let autoFlow = false;      // CTA-driven happy path (acquire -> join -> ready)
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
    licenseMode = (status && status.mode) || 'LICENSED';
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
    try { const pr = await api.devicePresets(); presets = (pr && pr.presets) || []; } catch { presets = []; }
    try { const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x])); } catch { profiles = {}; }
    try { session = await api.sessionState(); if (session && session.hands) hands = session.hands; } catch {}
    renderAll();
  }

  function renderAll() { renderControl(); for (const s of SLOTS) renderBrowserCell(s); }

  // ---------- browser cells (managed external Chrome windows — NOT embedded) ----------
  function renderBrowserCell(slot) {
    const body = $('body-' + slot); if (!body) return;
    body.innerHTML = '';
    const a = assign[slot];
    const saved = profiles[slot] || {};
    // keep the in-memory assign proxyRef in sync with the saved profile
    if (a.proxyRef == null && saved.proxyRef) a.proxyRef = saved.proxyRef;
    const prof = session ? (session.profiles || []).find((p) => a.runId && p.id === a.runId) : null;
    const dev = saved.device;
    body.appendChild(el('div', { class: 'prow' },
      // device row
      el('div', null, el('b', null, 'Thiết bị '),
        el('span', null, dev ? `${dev.name} · ${dev.resolution} · Ngang · Touch` : '(chưa tạo)'),
      ),
      el('div', null,
        el('button', { class: 'btn', onclick: () => openDeviceModal(slot) }, dev ? 'Sửa thiết bị' : 'Tạo thiết bị'),
      ),
      // proxy row
      el('div', null, el('b', null, 'Proxy '), proxySelector(slot)),
      el('div', null,
        el('button', { class: 'btn', onclick: () => testProxy(slot) }, 'Test'),
        el('button', { class: 'btn', onclick: () => openProxyModal(slot, null) }, '+ Proxy'),
        a.proxyRef ? el('button', { class: 'btn', onclick: () => openProxyModal(slot, a.proxyRef) }, 'Sửa') : null,
        a.proxyRef ? el('button', { class: 'btn danger', onclick: () => deleteProxy(a.proxyRef) }, 'Xóa') : null,
        el('span', { class: 'badge ' + testBadge(a.testState) }, a.testState),
        a.ip ? el('span', { class: 'faint' }, ' IP ' + a.ip) : null,
      ),
      // browser row
      el('div', null,
        el('span', { class: 'dot ' + (prof && prof.socketReady ? 'on' : 'off') }), ' Browser ',
        el('button', { class: 'btn', onclick: () => openOne(slot) }, prof ? 'Mở lại' : 'Mở game'),
        a.runId ? el('button', { class: 'btn', onclick: () => api.focusBrowser(a.runId) }, 'Focus') : null,
        el('span', { class: 'faint' }, ' Ngang'),
      ),
      el('div', { class: 'faint' }, 'Ghế ', el('b', null, prof && prof.seat != null ? String(prof.seat) : '—'),
        ' · ', (prof && prof.ready ? 'Sẵn sàng' : 'Chưa'), prof && prof.lastError ? el('span', { class: 'warnrow' }, ' ' + prof.lastError.code) : null),
    ));
    body.appendChild(el('div', { class: 'faint', style: 'margin-top:6px;font-size:11px' }, 'Game mở ở cửa sổ Chrome riêng (mobile landscape, thao tác thủ công tại đó).'));
  }

  function proxySelector(slot) {
    const sel = el('select', { class: 'sel', onchange: (e) => { assign[slot].proxyRef = e.target.value; api.profileUpsert(slot, { proxyRef: e.target.value || null }); } });
    sel.appendChild(el('option', { value: '' }, '— chọn proxy —'));
    for (const p of proxies) sel.appendChild(el('option', { value: p.id, selected: assign[slot].proxyRef === p.id }, `${p.label} (${p.protocol})`));
    return sel;
  }
  function testBadge(s) { return ({ PASS: 'good', FAILED: 'bad', AUTH_FAILED: 'bad', TIMEOUT: 'warn', TESTING: 'warn' })[s] || 'faint'; }

  // Proxy form modal (add or edit). Password goes straight to the secure store; the
  // form never shows an existing password back.
  function openProxyModal(slot, editId) {
    const existing = editId ? proxies.find((p) => p.id === editId) : null;
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const ov = el('div', { class: 'phq-analyzer' });
    const close = () => ov.remove();
    const f = (id, ph, val) => el('input', { class: 'f', id, placeholder: ph, value: val != null ? val : '' });
    const proto = el('select', { class: 'sel', id: 'px-proto' });
    for (const p of ['http', 'https', 'socks5', 'socks4']) proto.appendChild(el('option', { value: p, selected: existing && existing.protocol === p }, p));
    const card = el('div', { class: 'anz-card' },
      el('div', { class: 'section-t' }, existing ? 'SỬA PROXY' : 'THÊM PROXY'),
      el('div', { class: 'note' }, 'Dán nhanh: host:port hoặc host:port:user:pass hoặc protocol://user:pass@host:port'),
      f('px-quick', 'dán chuỗi proxy (tuỳ chọn)'),
      el('div', { class: 'phq-row' }, el('span', null, 'Tên'), f('px-label', 'tên proxy', existing && existing.label)),
      el('div', { class: 'phq-row' }, el('span', null, 'Protocol'), proto),
      el('div', { class: 'phq-row' }, el('span', null, 'Host'), f('px-host', 'host', existing && existing.host)),
      el('div', { class: 'phq-row' }, el('span', null, 'Port'), f('px-port', 'port', existing && existing.port)),
      el('div', { class: 'phq-row' }, el('span', null, 'Username'), f('px-user', 'username (nếu có)', existing && existing.username && '')),
      el('div', { class: 'phq-row' }, el('span', null, 'Password'), el('input', { class: 'f', id: 'px-pass', type: 'password', placeholder: existing && existing.hasAuth ? '(giữ nguyên nếu để trống)' : 'password (nếu có)' })),
      el('details', { class: 'adv' }, el('summary', null, 'Advanced'), el('div', { class: 'phq-row' }, el('span', null, 'Bypass'), f('px-bypass', 'a.com,b.com', existing && (existing.bypassList || []).join(',')))),
      el('div', { class: 'phq-row' },
        el('button', { class: 'btn primary', onclick: async () => {
          const quick = $('px-quick').value.trim();
          const input = quick
            ? { id: editId || undefined, label: $('px-label').value.trim() || undefined, protocol: $('px-proto').value, input: quick, bypassList: $('px-bypass').value }
            : { id: editId || undefined, label: $('px-label').value.trim() || undefined, protocol: $('px-proto').value, host: $('px-host').value.trim(), port: Number($('px-port').value), username: $('px-user').value.trim() || null, password: $('px-pass').value || (existing ? undefined : null), bypassList: $('px-bypass').value };
          const res = await api.proxyUpsert(input);
          if (!res || !res.ok) { note(errText(res), true); return; }
          assign[slot].proxyRef = res.id; await api.profileUpsert(slot, { proxyRef: res.id });
          const pl = await api.proxyList(); proxies = (pl && pl.proxies) || [];
          const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x]));
          close(); renderAll();
        } }, 'Lưu'),
        el('button', { class: 'btn', onclick: close }, 'Hủy'),
      ),
    );
    ov.appendChild(card); document.body.appendChild(ov);
  }

  async function deleteProxy(id) {
    if (!confirm('Xóa proxy này?')) return;
    const res = await api.proxyRemove(id);
    if (!res || !res.ok) return note(errText(res), true);
    for (const s of SLOTS) if (assign[s].proxyRef === id) assign[s].proxyRef = '';
    const pl = await api.proxyList(); proxies = (pl && pl.proxies) || [];
    const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x]));
    renderAll();
  }

  // Device modal: pick a mobile preset (orientation fixed Ngang) + name; preview.
  function openDeviceModal(slot) {
    const saved = profiles[slot] || {};
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const ov = el('div', { class: 'phq-analyzer' });
    const close = () => ov.remove();
    const sel = el('select', { class: 'sel', id: 'dev-preset' });
    for (const p of presets) sel.appendChild(el('option', { value: p.id, selected: saved.device && saved.device.presetId === p.id }, `${p.name} · ${p.viewportWidth}×${p.viewportHeight}`));
    const preview = el('div', { class: 'note' });
    const renderPrev = () => { const p = presets.find((x) => x.id === sel.value) || presets[0]; preview.textContent = p ? `Màn hình: ${p.viewportWidth} × ${p.viewportHeight} · DSF ${p.deviceScaleFactor} · Ngang · Touch: Bật` : ''; };
    sel.onchange = renderPrev;
    const card = el('div', { class: 'anz-card' },
      el('div', { class: 'section-t' }, 'TẠO THIẾT BỊ (MOBILE — NGANG)'),
      el('div', { class: 'phq-row' }, el('span', null, 'Tên hồ sơ'), el('input', { class: 'f', id: 'dev-name', value: saved.name || ('Profile ' + slot) })),
      el('div', { class: 'phq-row' }, el('span', null, 'Thiết bị'), sel),
      preview,
      el('div', { class: 'phq-row' },
        el('button', { class: 'btn primary', onclick: async () => {
          const res = await api.profileUpsert(slot, { name: $('dev-name').value.trim(), device: { presetId: sel.value, regenerate: !(saved.device && saved.device.presetId === sel.value) } });
          if (!res || !res.ok) { note(errText(res), true); return; }
          const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x]));
          close(); renderAll();
        } }, 'Lưu'),
        el('button', { class: 'btn', onclick: close }, 'Hủy'),
      ),
    );
    ov.appendChild(card); document.body.appendChild(ov);
    renderPrev();
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
    if (licenseMode === 'DEVELOPMENT_BYPASS') r.appendChild(el('div', { class: 'dev-banner' }, 'DEV MODE — LICENSE BYPASS'));
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

    // HOST + stake controls
    r.appendChild(el('div', { class: 'section-t' }, 'HOST & MỨC CƯỢC'));
    const hostSel = el('select', { class: 'sel', id: 'phq-host', onchange: (e) => { hostId = e.target.value; api.setHost(hostId); } });
    for (const slot of SLOTS) hostSel.appendChild(el('option', { value: assign[slot].runId || slot, selected: hostId === (assign[slot].runId || slot) }, 'HOST = Profile ' + slot));
    const stakeInput = el('input', { class: 'f', id: 'phq-stake', type: 'number', value: selectedStake || '', placeholder: 'Mức cược' });
    r.appendChild(el('div', null, hostSel, stakeInput,
      el('button', { class: 'btn', onclick: () => testAllProxies() }, 'Test tất cả proxy')));
    if (s.hostTableIdentity) r.appendChild(el('div', { class: 'faint' }, `Bàn HOST: rid ${s.hostTableIdentity.channelRid} · stake ${s.hostTableIdentity.selectedStake} · người ${s.playerCount || 0}`));

    r.appendChild(el('button', { class: 'btn primary', disabled: !ctaEnabled(s), onclick: bringThreeIn }, 'TÌM BÀN VÀ ĐƯA 3 TÀI KHOẢN VÀO'));
    r.appendChild(el('div', null,
      el('button', { class: 'btn', onclick: step(() => api.acquireHost(), 'HOST đang tìm bàn.') }, 'HOST tìm bàn'),
      el('button', { class: 'btn', onclick: step(() => api.joinFollowers(), 'Follower vào bàn HOST.') }, 'Follower vào bàn'),
      el('button', { class: 'btn', onclick: step(() => api.applyReady(), 'Áp dụng Sẵn sàng.') }, 'Sẵn sàng'),
    ));
    r.appendChild(el('div', null,
      el('button', { class: 'btn', onclick: rejoinKicked }, 'ReJoin bị kick'),
      el('button', { class: 'btn', onclick: step(() => api.recoverHost(), 'Khôi phục HOST.') }, 'Khôi phục HOST'),
      el('button', { class: 'btn', onclick: step(() => api.leaveAll(), 'Đã rời bàn.') }, 'Rời tất cả'),
      el('button', { class: 'btn danger', onclick: step(() => api.stop(), 'Đã dừng.') }, 'Dừng'),
    ));
    r.appendChild(el('div', { class: 'note ' + (s.sameTable ? 'ok' : '') }, `Kết luận: ${s.tableVerdict || '—'} · ${s.state || 'IDLE'}`));
    if (!ctaEnabled(s)) r.appendChild(el('div', { class: 'warnrow' }, ctaReason(s)));

    // hands
    r.appendChild(el('div', { class: 'section-t' }, 'BA TAY BÀI'));
    const list = hands.length ? hands : (s.hands || []);
    if (!list.length) r.appendChild(el('div', { class: 'faint' }, 'Chưa nhận bài.'));
    for (const h of list) r.appendChild(handRow(h));

    r.appendChild(el('div', { class: 'section-t' }, 'CÔNG CỤ'));
    r.appendChild(el('button', { class: 'btn', onclick: openAnalyzer }, 'PHÂN TÍCH LUẬT — QA OFFLINE'));

    const det = el('details', { class: 'adv' }, el('summary', null, 'Advanced Debug'));
    det.appendChild(el('pre', { style: 'font-size:11px;color:#9fb0cc;max-height:180px;overflow:auto;white-space:pre-wrap' }, session ? JSON.stringify(session, null, 2) : '(chưa có phiên)'));
    r.appendChild(det);
  }

  // Offline rule analyzer (§16/§23) — a separate mode, refused while any live run exists.
  async function openAnalyzer() {
    let status = {}; try { status = await api.analyzerStatus(); } catch { status = {}; }
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const overlay = el('div', { class: 'phq-analyzer' });
    const close = () => overlay.remove();
    const card = el('div', { class: 'anz-card' });
    card.appendChild(el('div', { class: 'dev-banner' }, 'SIMULATOR / QA OFFLINE'));
    card.appendChild(el('div', { class: 'note' }, 'Mạng: ĐÃ KHÓA · Browser: KHÔNG KẾT NỐI'));
    if (!status.available) {
      card.appendChild(el('div', { class: 'warnrow' }, 'Không chạy được khi còn phiên/live browser (PHOM_ANALYZER_OFFLINE_ONLY). Hãy Dừng/đóng browser trước.'));
      card.appendChild(el('button', { class: 'btn', onclick: close }, 'Đóng'));
      overlay.appendChild(card); document.body.appendChild(overlay); return;
    }
    const fixture = { sourceKind: 'TEST_FIXTURE', knownHands: [[10, 14, 18, 27, 31, 35, 0, 4, 8], [1, 5, 9, 13, 17, 21, 2, 6, 40], [3, 7, 11, 15, 19, 23, 44, 48, 12]], currentHand: [10, 14, 18, 0, 4, 8], otherHands: [[1, 5, 9, 22], [3, 7, 11, 26]], serverMelds: [10, 14, 18, 27, 31, 35] };
    const ta = el('textarea', { class: 'mono anz-ta' }); ta.value = JSON.stringify(fixture, null, 2);
    const result = el('pre', { class: 'anz-result' }, '(kết quả sẽ hiện ở đây)');
    card.appendChild(el('div', { class: 'section-t' }, 'DATASET (fixture / replay)'));
    card.appendChild(ta);
    card.appendChild(el('div', null,
      el('button', { class: 'btn primary', onclick: async () => { let input; try { input = JSON.parse(ta.value); } catch { result.textContent = 'JSON không hợp lệ.'; return; } const res = await api.analyzerAnalyze(input); result.textContent = JSON.stringify(res, null, 2); } }, 'Phân tích'),
      el('button', { class: 'btn', onclick: close }, 'Đóng'),
    ));
    card.appendChild(result);
    overlay.appendChild(card); document.body.appendChild(overlay);
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

  // Primary CTA: start the session over the 3 opened runs, pick HOST + stake, then run
  // the happy path (acquire -> join -> ready) advanced from authoritative snapshots.
  async function bringThreeIn() {
    const runIds = SLOTS.map((sl) => assign[sl].runId).filter(Boolean);
    if (runIds.length !== 3) return note('Cần mở đủ 3 browser trước.', true);
    const stake = Number(($('phq-stake') && $('phq-stake').value) || selectedStake);
    if (!stake) return note('Nhập mức cược.', true);
    selectedStake = stake;
    const host = hostId && runIds.includes(hostId) ? hostId : runIds[0];
    hostId = host;
    const start = await api.startSession({ runIds, hostId: host, selectedStake: stake });
    if (start && start.ok === false) return note(errText(start), true);
    autoFlow = true;
    const acq = await api.acquireHost();
    if (acq && acq.ok === false) { autoFlow = false; return note(errText(acq), true); }
    note('HOST đang tìm bàn trống…');
    refresh();
  }
  // Advance the happy path when authoritative state confirms each stage.
  function advanceAutoFlow(s) {
    if (!autoFlow || !s) return;
    if (s.state === 'HOST_ACQUIRED') { api.joinFollowers().then(refresh); }
    else if (s.sameTable && s.controlledReadyCount < (s.playerCount >= 4 ? 3 : 2)) { api.applyReady().then(refresh); autoFlow = false; }
  }
  async function rejoinKicked() {
    const kicked = (session && session.profiles || []).filter((p) => p.state === 'KICKED');
    if (!kicked.length) return note('Không có profile bị kick.');
    for (const p of kicked) { const res = await api.rejoinFollower(p.id); if (res && res.ok === false) note(`${p.displayName}: ${errText(res)}`, true); }
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
  if (api.onSession) api.onSession((snap) => { session = snap; if (snap && snap.hands) hands = snap.hands; advanceAutoFlow(snap); if (!$('workspace').hidden) renderAll(); });
  if (api.onHands) api.onHands((h) => { hands = h; if (!$('workspace').hidden) renderControl(); });
  if (api.onLicense) api.onLicense((s) => { if (s && s.active && !$('activation').hidden) boot(); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
