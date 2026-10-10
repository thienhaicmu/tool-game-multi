'use strict';

// Phỏm QA — the tool window. Talks ONLY to window.phomQA (typed preload): no raw WS sender, no CDP, no proxy
// password. Two tabs in one window:
//   PROFILE — the device-profile table (tick 3 → P1/P2/P3), bulk proxy, per-profile editor, MỞ TRÌNH DUYỆT.
//   PHỎM    — one status line, then ONE CARD PER ACCOUNT: who it is, what it is doing, its buttons, and its LỌC BÀI
//             (the cards the next player cannot eat). Controls at the bottom.
// Manual play is each Chromium's own bar (Dò Key · Tạo · Vào · ReJoin · Thoát); nothing automatic runs here unless
// TỰ ĐỘNG is ticked.
(function () {
  const api = window.phomQA || {};
  const SLOTS = ['A', 'B', 'C'];
  const UI = { SETUP: 'SETUP', OPENING_CLUSTER: 'OPENING_CLUSTER', CONTROL: 'CONTROL', STOPPING: 'STOPPING', ERROR: 'ERROR' };
  const PS = window.ProfileSelection || null; // ordered selection (max 3) → P1/P2/P3
  const BP = window.BulkProxy || null;        // ⚡ DÁN PROXY parser
  const ACCENT = ['#2563eb', '#16a34a', '#ea580c'];

  let uiState = UI.SETUP;
  let activeTab = 'SETUP';
  let errorMsg = '';
  let caps = {};
  let licenseMode = 'LICENSED';
  let licenseInfo = null;
  let session = null;          // coordinator session (per-run socketReady / connected / channelCount)
  let clusterSnap = null;      // the three Chromium runs
  let proxies = [];
  let agents = [];
  let defaultAgent = 'WEB';
  let profilesX = [];          // saved device profiles
  let selectedProfileIds = []; // ORDERED selection → P1/P2/P3
  let browserRuntimeInfo = null;
  let bulkProxyText = '';
  let localTest = false;       // dev-only: open without proxy
  let clusterOpBusy = false;   // a double click must not open a second cluster
  let phomSessionStarted = false;
  // the ONE ui snapshot main builds and pushes (browsers + group + cards + the three Lọc Bài analyses)
  let manualBrowsers = [];
  let manualGroup = null;
  let coSeat = null;
  let remaining = null;
  let cardsSnap = null;
  let safeBySlot = {};
  let sharedRid = null;
  let autoStake = '';
  let autoBusy = false;
  let anDanhOn = false; // ẨN DANH switch — default OFF
  let anDanhBusy = false;
  const replaceBusy = { A: false, B: false, C: false };
  const assign = { A: { runId: null }, B: { runId: null }, C: { runId: null } };
  const manualEntering = {};    // runId → VÀO GAME in flight
  const manualEnterError = {};  // runId → why VÀO GAME failed (retryable)
  const manualEnterTimers = {};
  // ĐÁNH BÀI tab: the account shown, whether the user pinned it (else it follows the turn), the picked cards
  let playTab = 'B1';
  let playPinned = false;
  let playPick = { runId: null, codes: [] };
  let autoPlayStrategy = { lowMoney: false, twoPhomCaU: true, blockThirdEat: true };
  let playBySlot = {};
  const playBusy = {}; // runId → a play action in flight
  let autoPlayByRun = {}; // TỰ ĐÁNH per runId from main: { on, message }
  let loopStatus = null;  // VÒNG TỰ ĐÁNH from main: { on, message, resting, stats }
  let loopBusy = false;
  // the pure parts, loaded before this file (ui-kit.js · ui-cards.js · ui-notices.js)
  const { el, $, icon, iconButton, playerLabel, money, errText, note, noteText, openDialog, ringBell } = window.PhomUI;
  const { remainingPanel } = window.PhomUI;
  const { ROLE_VIEW, noticeText: noticeLine } = window.PhomUI;

  // ---------- license ----------
  async function boot() {
    let status = {};
    try { status = await api.licenseStatus(); } catch { status = {}; }
    licenseMode = (status && status.mode) || 'LICENSED';
    licenseInfo = status || null;
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
      if (res && res.active) boot();
      else { $('act-error').hidden = false; $('act-error').textContent = friendlyLicenseError(res && res.error); }
    };
  }
  function friendlyLicenseError(e) {
    if (!e) return 'Kích hoạt thất bại.';
    if (e.code === 'LICENSE_GAME_PRODUCT_MISMATCH') return 'Key này dành cho Aviator, không dùng được cho Phỏm QA.';
    if (e.code === 'LICENSE_PHOM_ENTITLEMENT_REQUIRED') return 'Key cũ không có quyền Phỏm QA. Cần key có quyền PHOM.';
    if (e.code === 'LICENSE_MACHINE_MISMATCH') return 'Key không khớp thiết bị này.';
    if (e.code === 'LICENSE_EXPIRED') return 'Key đã hết hạn.';
    if (e.code === 'LICENSE_REVOKED_ONLINE') return 'Key đã bị khóa' + (e.message ? ' (' + e.message + ')' : '') + '. Liên hệ admin để cấp key mới.';
    if (e.code === 'LICENSE_OFFLINE_TOO_LONG') return 'Không kiểm tra được key quá 24 giờ (mất mạng). Kết nối mạng rồi mở lại.';
    return e.message || e.code || 'Kích hoạt thất bại.';
  }

  async function showWorkspace() {
    $('activation').hidden = true;
    $('workspace').hidden = false;
    try { caps = await api.capabilities(); } catch { caps = {}; }
    await refreshProxies();
    try { const ag = await api.agents(); agents = (ag && ag.agents) || []; defaultAgent = (ag && ag.defaultAgent) || 'WEB'; } catch { agents = []; }
    try { session = await api.sessionState(); } catch {}
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    try { const ad = await api.getAnDanh(); anDanhOn = !!(ad && ad.on); } catch { anDanhOn = false; }
    try { const st = await api.getStake(); if (st && st.stake != null) autoStake = String(st.stake); } catch { /* pick it again */ }
    await refreshProfilesX();
    await refreshBrowserRuntime();
    // a renderer reload with the browsers still open re-binds the slots (the cards never read CHƯA MỞ)
    uiState = clusterIsOpen() ? UI.CONTROL : UI.SETUP;
    if (uiState === UI.CONTROL) {
      bindSlotsFromCluster();
      activeTab = 'PHOM';
      await refreshManual();
      startEntryPolling();
    }
    renderApp();
  }
  function clusterIsOpen() {
    const cs = clusterSnap; if (!cs || cs.stopped) return false;
    return !!cs.clusterSessionId && ((cs.openBrowserCount || 0) > 0 || (cs.connectedCount || 0) > 0);
  }
  function bindSlotsFromCluster() {
    for (const s of SLOTS) { const p = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[s]; if (p && p.profileId) assign[s].runId = p.profileId; }
  }

  // ---------- frame ----------
  function renderTabBar() {
    const tab = (id, label) => el('button', { class: 'tab' + (activeTab === id ? ' active' : ''), onclick: () => { activeTab = id; renderApp(); } }, label);
    return el('header', { class: 'topbar' },
      el('span', { class: 'brand' }, el('span', { class: 'brand-mark' }, '♠'), 'Phỏm QA'),
      el('nav', { class: 'tabs' }, tab('SETUP', 'Profile'), tab('PHOM', 'Phỏm'), tab('PLAY', 'Đánh bài')),
      licenseChip());
  }
  // license: "Còn X ngày · HSD dd/mm/yyyy" from the signed expiry (payload.expiresAt, unix seconds)
  function licenseChip() {
    if (licenseMode === 'DEVELOPMENT_BYPASS') return el('span', { class: 'lic dev' }, 'DEV BYPASS');
    const li = licenseInfo || {};
    const expSec = (li.payload && li.payload.expiresAt != null) ? Number(li.payload.expiresAt) : (li.expiresAt != null ? Number(li.expiresAt) : null);
    if (!(expSec && Number.isFinite(expSec))) return el('span', { class: 'lic' }, '● Đã kích hoạt');
    const nowMs = (li.nowSeconds != null && Number.isFinite(Number(li.nowSeconds))) ? Number(li.nowSeconds) * 1000 : Date.now();
    const d = new Date(expSec * 1000);
    const days = Math.max(0, Math.ceil((d.getTime() - nowMs) / 86400000));
    const p2 = (n) => String(n).padStart(2, '0');
    return el('span', { class: 'lic' + (days <= 3 ? ' warn' : ''), title: 'Giấy phép Phỏm QA' }, `● Còn ${days} ngày · HSD ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`);
  }

  function renderApp() {
    const r = $('phq-root'); if (!r) return;
    r.replaceChildren();
    r.className = 'mode-' + uiState.toLowerCase();
    if (licenseMode === 'DEVELOPMENT_BYPASS') r.appendChild(el('div', { class: 'banner warn' }, 'DEV MODE — LICENSE BYPASS'));
    const sb = caps.chromiumSandbox;
    if (sb && sb.disabled) r.appendChild(el('div', { class: 'banner danger' }, sb.banner || 'DEV ONLY — CHROMIUM SANDBOX DISABLED'));
    r.appendChild(renderTabBar());
    const content = el('main', { class: 'tab-content' });
    r.appendChild(content);
    if (uiState === UI.OPENING_CLUSTER) return renderTransient(content, 'Đang mở 3 trình duyệt…', 'Ba cửa sổ Chromium đang bung ra bên ngoài.');
    if (uiState === UI.STOPPING) return renderTransient(content, 'Đang đóng trình duyệt…', 'Cấu hình profile và proxy được giữ nguyên.');
    if (uiState === UI.ERROR) return renderError(content);
    if (activeTab === 'PHOM' || activeTab === 'PLAY') {
      if (!(clusterIsOpen() || uiState === UI.CONTROL)) content.appendChild(el('div', { class: 'empty' }, el('b', null, 'Chưa mở trình duyệt'), el('span', null, 'Sang tab Profile, tick 3–5 profile rồi bấm Mở trình duyệt.')));
      else if (activeTab === 'PLAY') renderPlay(content);
      else renderControl(content);
    } else renderSetup(content);
  }
  function renderTransient(r, title, sub) { r.appendChild(el('div', { class: 'empty' }, el('span', { class: 'spinner' }), el('b', null, title), el('span', null, sub))); }
  function renderError(r) {
    r.appendChild(el('div', { class: 'empty' }, el('b', null, 'Không mở được trình duyệt'), el('span', { class: 'warn-text' }, errorMsg || 'Đã xảy ra lỗi.'),
      el('button', { class: 'btn primary', onclick: () => { uiState = UI.SETUP; activeTab = 'SETUP'; renderApp(); } }, 'Về Profile')));
  }

  // A background update (a push, the poll) repaints at most once per frame, and not at all when nothing shown changed.
  // A user click still renders at once (renderApp). An open stake dropdown is never rebuilt under the user.
  let _bgQueued = false;
  let _bgKey = '';
  function betSelectFocused() { const a = document.activeElement; return !!(a && a.classList && a.classList.contains('bet-sel')); }
  function bgRender() {
    if (betSelectFocused()) return;
    if (document.hidden) return;
    const key = renderKey();
    if (key === _bgKey) return;
    _bgKey = key;
    if (_bgQueued) return;
    _bgQueued = true;
    requestAnimationFrame(() => { _bgQueued = false; renderApp(); });
  }
  function renderKey() {
    // ĐÁNH BÀI: the table, every account's help and TỰ ĐÁNH status (the doc: the help is recomputed on every change)
    if (uiState === UI.CONTROL && activeTab === 'PLAY') return uiState + '|PLAY|' + manualBrowsers.length + '|' + (cardsSnap && cardsSnap.currentTurnUid) + '|' + JSON.stringify(playBySlot) + '|' + JSON.stringify(autoPlayByRun) + '|' + JSON.stringify(autoPlayStrategy) + '|' + JSON.stringify(loopStatus) + loopBusy;
    if (uiState !== UI.CONTROL || activeTab !== 'PHOM') return uiState + '|' + activeTab + '|' + manualBrowsers.length;
    const g = manualGroup;
    const browsers = manualBrowsers.map((b) => [b.profileId, b.manualState, b.rid, b.ready, b.groupRole, b.isTableHost, b.username, b.accountId, b.money, b.searchKind, b.rejoinOn, b.connected, b.socketReady, b.channelCount, b.lastError && b.lastError.code].join(',')).join(';');
    const cards = ['B1', 'B2', 'B3'].map((sl) => { const a = safeBySlot[sl]; return a ? a.roundSeq + ':' + a.nextPlayerLabel + ':' + (a.targetCards || []).map((c) => c.code + c.classification).join('') : '-'; }).join('|')
      + '|' + safeTab + safeFollowTurn + (cardsSnap && cardsSnap.currentTurnUid) + remMode + (cardsSnap && cardsSnap.remaining ? cardsSnap.remaining.count + ':' + cardsSnap.remaining.knownOutCount : '')
      + '|' + manualBrowsers.map((b) => b.state && b.state.label).join(',') + '|' + JSON.stringify((clusterSnap && clusterSnap.reserves) || {});
    const slots = SLOTS.map((s) => [assign[s].runId, manualEntering[assign[s].runId], manualEnterError[assign[s].runId], clusterSnap && clusterSnap.profiles && clusterSnap.profiles[s] && clusterSnap.profiles[s].browserState].join(',')).join(';');
    return [uiState, activeTab, g && g.rid, g && g.stake, g && g.auto, g && g.busy, g && g.recreating, autoStake, autoBusy, JSON.stringify(loopStatus), loopBusy, JSON.stringify(autoPlayStrategy),
      coSeat && coSeat.result, coSeat && coSeat.seatedCount, sharedRid, browsers, cards, slots, remainingCount(), noteText()].join('|');
  }

  function playerLabelOf(runId) {
    const b = runId != null ? manualBrowserById(runId) : null;
    if (b && b.browserIndex) return 'P' + b.browserIndex;
    const i = SLOTS.findIndex((s) => runId != null && String(assign[s].runId) === String(runId)); // before login the slot still knows
    return i >= 0 ? 'P' + (i + 1) : 'Một acc';
  }
  const noticeText = (n) => noticeLine(n, playerLabelOf);

  // ================= PROFILE tab =================
  function renderSetup(r) {
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));
    r.appendChild(profileTablePanel());
    r.appendChild(runGameFooter());
  }
  function profileTablePanel() {
    const n = selectedProfileIds.length;
    const panel = el('section', { class: 'panel profile-panel' });
    panel.appendChild(el('div', { class: 'panel-h' },
      el('div', null, el('span', { class: 'panel-title' }, 'Device profiles'), el('span', { class: 'muted' }, ` · tick 3–5 profile → P1 · P2 · P3 chơi, P4 · P5 dự bị (nằm sau tool)`)),
      el('div', { class: 'row' },
        el('button', { class: 'btn', title: 'Dán nhiều proxy — mỗi dòng một proxy, gán theo thứ tự profile', onclick: openBulkProxy }, '⚡ Dán proxy'),
        el('button', { class: 'btn primary', onclick: () => openProfileModal(null) }, icon('plus'), 'Thêm profile'))));
    const allSel = profilesX.length > 0 && n === Math.min(3, profilesX.length);
    const headCb = el('input', { type: 'checkbox', class: 'prof-cb', title: 'Chọn / bỏ chọn 3 profile đầu', onchange: () => { selectedProfileIds = allSel ? [] : profilesX.slice(0, 3).map((p) => p.id); renderApp(); } });
    headCb.checked = allSel;
    const table = el('table', { class: 'setup-table' },
      el('thead', null, el('tr', null, el('th', { class: 'col-cb' }, headCb), el('th', null, ''), el('th', null, 'Profile'), el('th', null, 'Agent'), el('th', null, 'Proxy'), el('th', null, 'Game URL'), el('th', null, ''))));
    const tbody = el('tbody');
    if (!profilesX.length) tbody.appendChild(el('tr', null, el('td', { colspan: '7', class: 'muted center' }, 'Chưa có profile — bấm Thêm profile.')));
    for (const p of profilesX) tbody.appendChild(profileRow(p));
    table.appendChild(tbody);
    panel.appendChild(el('div', { class: 'table-scroll' }, table));
    return panel;
  }
  function profileRow(p) {
    const sel = PS ? PS.isSelected(selectedProfileIds, p.id) : false;
    const canSel = PS ? PS.canSelect(selectedProfileIds, p.id) : false;
    const bLabel = PS ? PS.browserOf(selectedProfileIds, p.id) : null;
    const cb = el('input', { type: 'checkbox', class: 'prof-cb', disabled: canSel ? null : true, onchange: () => { if (PS) { selectedProfileIds = PS.toggle(selectedProfileIds, p.id); renderApp(); } } });
    cb.checked = sel;
    const px = p.proxyRef ? proxies.find((x) => x.id === p.proxyRef) : null;
    const pIdx = bLabel ? Number(playerLabel(bLabel).slice(1)) : 0;
    return el('tr', { class: sel ? 'selected' : '' },
      el('td', { class: 'col-cb' }, cb),
      el('td', { class: 'col-tag' }, bLabel ? el('span', { class: 'p-badge', style: 'background:' + (ACCENT[pIdx - 1] || '#6b7280') }, playerLabel(bLabel)) : ''),
      el('td', { class: 'col-name' }, p.name || '(chưa đặt tên)'),
      el('td', null, el('span', { class: 'tag', title: p.agent === 'MOBILE' ? 'User-agent điện thoại' : 'Giữ nguyên danh tính trình duyệt' }, p.agent === 'MOBILE' ? 'Mobile' : 'Web')),
      // proxy: TYPE host:port · auth — the credential is never shown; none = DIRECT
      el('td', null, px ? el('span', { class: 'tag good', title: 'Proxy đã gán (mật khẩu ẩn)' }, (px.protocol ? px.protocol.toUpperCase() : 'PROXY') + ' ' + (px.endpoint || (px.host + ':' + px.port)) + (px.hasAuth ? ' · auth' : ''))
        : el('span', { class: 'tag' }, p.proxyRef ? 'PROXY' : 'DIRECT')),
      el('td', { class: 'col-url' }, p.gameUrl ? el('span', { class: 'url', title: p.gameUrl }, p.gameUrl) : el('span', { class: 'warn-text', title: 'Bấm Sửa để thêm Game URL' }, 'Thiếu Game URL')),
      el('td', { class: 'col-act' },
        iconButton('edit', 'Sửa profile', () => openProfileModal(p.id)),
        iconButton('copy', 'Nhân bản profile', () => duplicateProfileX(p.id)),
        iconButton('trash', 'Xóa profile', () => deleteProfileX(p.id), 'danger')));
  }
  // MỞ TRÌNH DUYỆT — enabled with exactly 3 ticked, each with its own Game URL (unless Local Test)
  function runGameFooter() {
    const n = selectedProfileIds.length;
    const missingUrl = !localTest && selectedProfileIds.some((id) => { const p = profilesX.find((x) => x.id === id); return !(p && p.gameUrl && String(p.gameUrl).trim()); });
    const ready = n >= 3 && n <= 5 && !missingUrl;
    const rt = browserRuntimeInfo || {};
    const opt = (val, label) => { const o = el('option', { value: val }, label); o.selected = (rt.preference || 'CUSTOM_CHROMIUM') === val; return o; };
    return el('footer', { class: 'bar' },
      el('label', { class: 'field' }, 'Trình duyệt',
        el('select', { class: 'sel', onchange: async (e) => { const res = await api.browserRuntimeSet({ preference: e.target.value }); if (res && res.ok) { await refreshBrowserRuntime(); renderApp(); } } },
          opt('AUTO', 'Tự chọn'), opt('CUSTOM_CHROMIUM', 'Chromium'), opt('GOOGLE_CHROME', 'Chrome'))),
      caps.devBypass ? el('label', { class: 'field' }, el('input', { type: 'checkbox', id: 'phq-localtest', checked: localTest ? 'checked' : null, onchange: (e) => { localTest = e.target.checked; renderApp(); } }), 'Local Test') : null,
      el('span', { class: 'spacer' }),
      n >= 3 && missingUrl ? el('span', { class: 'warn-text' }, 'Có profile thiếu Game URL') : el('span', { class: 'muted' }, n > 3 ? `Đã chọn ${n} · 3 chơi + ${n - 3} dự bị` : `Đã chọn ${n} / 3`),
      el('button', { class: 'btn primary lg', disabled: ready ? null : true, onclick: openCluster }, icon('play'), 'Mở trình duyệt'));
  }

  // ⚡ DÁN PROXY — one line = one proxy, mapped to the profiles BY ORDER; all-or-nothing; a password is never echoed
  function openBulkProxy() {
    if (!BP) return note('Chưa nạp được bộ đọc proxy.', true);
    const { body, close } = openDialog('⚡ Dán proxy', 'Mỗi dòng một proxy · gán theo thứ tự profile');
    const msg = el('div', { class: 'note' }, profilesX.length ? profilesX.slice(0, 3).map((p, i) => 'Dòng ' + (i + 1) + ' → ' + p.name).join(' · ') : 'Chưa có profile nào.');
    const ta = el('textarea', { class: 'f mono', rows: '5', placeholder: BP.TEMPLATE || 'HTTP|host|port|user|pass', oninput: (e) => { bulkProxyText = e.target.value; } }, bulkProxyText);
    const apply = async () => {
      const parsed = BP.parse(bulkProxyText);
      if (!parsed.ok) { msg.textContent = parsed.error.message; msg.className = 'note warn'; return; }
      if (!parsed.proxies.length) { msg.textContent = 'Chưa có proxy nào để áp dụng.'; msg.className = 'note warn'; return; }
      const mapped = BP.mapToProfiles(parsed.proxies, profilesX.map((p) => p.id));
      if (!mapped.ok) { msg.textContent = mapped.error.message; msg.className = 'note warn'; return; }
      for (const m of mapped.mapping) {
        const r = await api.profileSetProxy(m.profileId, m.proxy);
        if (r && r.ok === false) { msg.textContent = 'Proxy dòng ' + (m.index + 1) + ': ' + errText(r); msg.className = 'note warn'; await refreshProfilesX(); renderApp(); return; }
      }
      await refreshProxies(); await refreshProfilesX();
      close(); renderApp();
      note('Đã gán ' + mapped.mapping.length + ' proxy theo thứ tự profile.');
    };
    body.append(ta, msg, el('div', { class: 'row end' },
      el('button', { class: 'btn', onclick: () => { ta.value = BP.TEMPLATE || ''; bulkProxyText = ta.value; ta.focus(); } }, 'Mẫu'),
      el('button', { class: 'btn primary', onclick: apply }, 'Áp dụng')));
    ta.focus();
  }
  function proxyLabel(px) {
    if (!px) return '';
    const parts = [String(px.protocol || 'http').toUpperCase() + ' ' + (px.endpoint || ((px.host || '?') + ':' + (px.port || '?')))];
    if (px.username) parts.push('user ' + px.username);
    parts.push(px.hasAuth ? 'có mật khẩu' : 'không mật khẩu');
    return parts.join(' · ');
  }
  function openProfileModal(id) {
    const existing = id ? profilesX.find((x) => x.id === id) : null;
    const curAgent = (existing && existing.agent) || defaultAgent;
    const curProxy = existing && existing.proxyRef ? proxies.find((x) => x.id === existing.proxyRef) || null : null;
    const { body, close } = openDialog(existing ? 'Sửa profile' : 'Thêm profile');
    const agentSel = el('select', { class: 'sel', id: 'pf-agent' });
    for (const a of (agents.length ? agents : [{ agent: 'WEB', label: 'Agent Web' }, { agent: 'MOBILE', label: 'Agent Mobile' }])) agentSel.appendChild(el('option', { value: a.agent }, a.label || a.agent));
    agentSel.value = curAgent;
    const field = (label, control, hint) => el('label', { class: 'form-row' }, el('span', null, label), control, hint ? el('small', { class: 'muted' }, hint) : null);
    body.append(
      field('Tên', el('input', { class: 'f', id: 'pf-name', placeholder: 'tên profile', value: existing ? existing.name : '' })),
      field('Agent', agentSel, 'Web = giữ nguyên trình duyệt · Mobile = user-agent điện thoại'),
      field('Game URL', el('input', { class: 'f mono', id: 'pf-url', type: 'url', spellcheck: 'false', placeholder: 'https://…', value: existing && existing.gameUrl ? existing.gameUrl : '' })),
      // the saved proxy is SHOWN (never its password); typing replaces it, empty keeps it, the box clears it
      curProxy ? field('Đang dùng', el('span', { class: 'tag good mono' }, proxyLabel(curProxy))) : null,
      field('Proxy', el('input', { class: 'f mono', id: 'pf-proxy', placeholder: curProxy ? 'để trống = giữ proxy hiện tại' : 'host:port  hoặc  host:port:user:pass  (trống = DIRECT)', value: '' })),
      existing && existing.proxyRef ? el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'pf-proxy-remove' }), 'Xóa proxy (dùng DIRECT)') : null,
      el('div', { class: 'note', id: 'pf-err' }, ''),
      el('div', { class: 'row end' }, el('button', { class: 'btn', onclick: close }, 'Hủy'), el('button', { class: 'btn primary', onclick: () => saveProfileModal(id, close) }, 'Lưu')));
  }
  async function saveProfileModal(id, close) {
    const err = $('pf-err');
    const fail = (res) => { if (err) { err.textContent = errText(res); err.className = 'note warn'; } };
    const agent = ($('pf-agent') && $('pf-agent').value) || defaultAgent;
    const name = ($('pf-name').value || '').trim() || 'Profile';
    const gameUrl = ($('pf-url') && $('pf-url').value || '').trim() || null;
    const res = id ? await api.profileUpdateX(id, { name, agent, gameUrl }) : await api.profileCreate({ name, agent, gameUrl });
    if (res && res.ok === false) return fail(res);
    const pid = id || (res && res.profile && res.profile.id) || null;
    if (pid) {
      const proxyStr = ($('pf-proxy') && $('pf-proxy').value || '').trim();
      const removeProxy = !!($('pf-proxy-remove') && $('pf-proxy-remove').checked);
      if (proxyStr) { const pr = await api.profileSetProxy(pid, proxyStr); if (pr && pr.ok === false) return fail(pr); }
      else if (removeProxy) await api.profileSetProxy(pid, null);
    }
    close(); await refreshProxies(); await refreshProfilesX(); renderApp();
  }
  async function deleteProfileX(id) {
    const p = profilesX.find((x) => x.id === id);
    if (!window.confirm(`Xóa profile "${p ? p.name : id}"?`)) return;
    const res = await api.profileDeleteX(id);
    if (res && res.ok === false) return note(errText(res), true);
    selectedProfileIds = selectedProfileIds.filter((x) => x !== id);
    await refreshProfilesX(); renderApp(); note('Đã xóa profile.');
  }
  async function duplicateProfileX(id) {
    const p = profilesX.find((x) => x.id === id);
    if (!p) return;
    const res = await api.profileCreate({ name: (p.name || 'Profile') + ' (copy)', agent: p.agent || defaultAgent, gameUrl: p.gameUrl || null });
    if (res && res.ok === false) return note(errText(res), true);
    await refreshProfilesX(); renderApp(); note('Đã nhân bản profile.');
  }
  async function refreshProxies() { try { const p = await api.proxyList(); proxies = (p && p.proxies) || []; } catch { /* keep last */ } }
  async function refreshProfilesX() {
    try { const r = await api.profilesList(); profilesX = (r && r.profiles) || []; } catch { profilesX = []; }
    if (PS) selectedProfileIds = PS.prune(selectedProfileIds, profilesX.map((p) => p.id));
  }
  async function refreshBrowserRuntime() { try { const r = await api.browserRuntimeGet(); if (r && r.ok) browserRuntimeInfo = r; } catch { /* keep last */ } }

  // a modal card (Esc / click outside closes)
  // BỐ CỤC — swap the windows' places DIRECTLY: a 2×2 picture of the screen, click one window then another and the
  // two windows trade places at once on the screen (their P numbers stay). Saved; launches and Xếp cửa sổ follow it.
  async function openLayoutDialog() {
    let res = null; try { res = await api.getLayout(); } catch { res = null; }
    const def = (res && res.defaultLayout) || { A: 'BL', B: 'TL', C: 'TR', TOOL: 'BR' };
    let layout = { ...((res && res.layout) || def) };
    let picked = null; // the window clicked first
    const { body, close } = openDialog('Đổi vị trí cửa sổ', 'Bấm 1 cửa sổ rồi bấm cửa sổ khác — 2 cửa sổ đổi chỗ ngay. P4/P5 dự bị luôn nằm sau Tool.');
    const ITEM_LABEL = { A: 'P1', B: 'P2', C: 'P3', TOOL: 'Tool' };
    const grid = el('div', { class: 'layout-grid', role: 'group', 'aria-label': 'Màn hình' });
    const msg = el('div', { class: 'note' }, '');
    const nameOf = (item) => {
      const i = { A: 0, B: 1, C: 2 }[item]; if (i == null) return 'Phỏm QA';
      const b = manualBrowserById(assign[SLOTS[i]].runId) || {};
      return b.username && b.username !== 'USER_UNKNOWN' ? b.username : '';
    };
    async function apply(next, text) {
      const prev = layout; layout = next; picked = null; paint();
      let r = null; try { r = await api.setLayout(layout); } catch (e) { r = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
      if (r && r.ok === false) { layout = prev; paint(); msg.textContent = errText(r); msg.className = 'note warn'; return; }
      msg.textContent = text; msg.className = 'note ok';
    }
    function onTile(item) {
      if (!picked) { picked = item; paint(); return; }
      if (picked === item) { picked = null; paint(); return; }
      const a = picked, b = item, next = { ...layout };
      next[a] = layout[b]; next[b] = layout[a];               // the two windows trade quarters
      apply(next, 'Đã đổi chỗ ' + ITEM_LABEL[a] + ' ⇄ ' + ITEM_LABEL[b] + '.');
    }
    function paint() {
      grid.replaceChildren();
      for (const quad of ['TL', 'TR', 'BL', 'BR']) {
        const item = Object.keys(layout).find((k) => layout[k] === quad);
        const idx = { A: 0, B: 1, C: 2 }[item];
        grid.appendChild(el('button', { class: 'layout-cell' + (item === 'TOOL' ? ' is-tool' : '') + (picked === item ? ' picked' : ''), style: idx != null ? '--accent:' + ACCENT[idx] : '',
          title: picked && picked !== item ? 'Đổi chỗ với ' + ITEM_LABEL[picked] : 'Chọn cửa sổ này để đổi chỗ', 'aria-pressed': picked === item ? 'true' : 'false', onclick: () => onTile(item) },
          el('b', null, ITEM_LABEL[item]), el('span', { class: 'muted' }, nameOf(item) || ' '),
          el('span', { class: 'lc-hint' }, picked === item ? 'đã chọn — bấm ô khác' : picked ? '⇄ đổi chỗ' : '')));
      }
    }
    paint();
    body.append(grid, msg, el('div', { class: 'row end' },
      el('button', { class: 'btn', onclick: () => apply({ ...def }, 'Đã về bố cục mặc định.') }, 'Mặc định'),
      el('button', { class: 'btn primary', onclick: () => close() }, 'Xong')));
  }

  // ================= PHỎM tab =================
  //   status line   — số bàn (copy) · cược · cùng bàn · tự động / đang xử lý
  //   note line     — what the group just did (notices)
  //   3 player cards — P1 · P2 · P3: account, state, buttons, and its own LỌC BÀI
  //   footer        — Mức cược · TỰ ĐỘNG · Bàn khác · Thoát bàn tất cả · Xếp cửa sổ · Ghi WS · Đóng tất cả
  function renderControl(r) {
    r.appendChild(statusLine());
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));
    r.appendChild(playerGrid());
    r.appendChild(safePanel());
    r.appendChild(controlFooter());
  }
  const BUSY_LABEL = { FIND: 'Đang tìm bàn…', JOIN: 'Đang vào bàn…', REJOIN: 'Đang vào lại…', LEAVE: 'Đang rời bàn…', LEAVE_ALL: 'Đang rời hết…', AUTO_ON: 'Đang bật tự động…', REGROUP: 'Đang gom bàn mới…' };
  function statusLine() {
    const g = manualGroup;
    const rid = g && g.rid != null ? g.rid : sharedRid;
    const stake = g && g.stake ? g.stake : (manualBrowsers.find((b) => b.manualState === 'JOINED' && b.stake != null) || {}).stake;
    const ridBox = el('button', { class: 'stat' + (rid != null ? ' copyable' : ''), title: rid != null ? 'Bấm để copy số bàn' : 'Chưa có số bàn — Dò Key rồi Tạo', disabled: rid != null ? null : true,
      onclick: () => { if (rid != null && navigator.clipboard) { navigator.clipboard.writeText(String(rid)); note('Đã copy số bàn ' + rid + '.'); } } },
      el('span', null, 'Số bàn'), el('b', null, rid != null ? String(rid) : '—'), rid != null ? icon('copy') : null);
    const rem = remainingCount();
    return el('div', { class: 'status-line' },
      ridBox,
      el('div', { class: 'stat' }, el('span', null, 'Cược'), el('b', null, stake ? money(stake) : '—')),
      coSeatStat(),
      rem != null ? el('div', { class: 'stat', title: 'Số lá chưa lộ trong ván' }, el('span', null, 'Còn lại'), el('b', null, rem + ' lá')) : null,
      el('span', { class: 'spacer' }),
      g && g.busy ? el('span', { class: 'pill warn', title: 'Mỗi lệnh cách nhau 0,8–2,5 giây' }, BUSY_LABEL[g.busy] || 'Đang xử lý…') : null,
      g && g.auto ? el('span', { class: 'pill good', title: 'Bị đá tự ReJoin · mất bàn tự tìm bàn khác' }, g.recreating ? 'Đang tìm bàn khác' : '● Tự động') : null);
  }
  // "cùng bàn" — proven by the backend from every browser's own table state, never derived here
  function coSeatStat() {
    const n = (coSeat && coSeat.browserCount) || 3;
    const v = !coSeat ? ['—', ''] : coSeat.ok ? [n + '/' + n, 'good'] : coSeat.result === 'TABLE_MISMATCH' ? ['Khác bàn', 'bad'] : coSeat.result === 'PARTIAL_JOIN' ? [(coSeat.seatedCount || 0) + '/' + n, 'warn'] : ['—', ''];
    return el('div', { class: 'stat ' + v[1], title: coSeat && coSeat.reason ? coSeat.reason : 'Số acc mình cùng ngồi một bàn' }, el('span', null, 'Cùng bàn'), el('b', null, v[0]));
  }

  // One row of compact cards: P1 · P2 · P3 playing, then a card per reserve (P4 · P5) — the grid takes 3, 4 or 5 columns.
  function playerGrid() {
    const reserves = clusterSnap && clusterSnap.reserves ? Object.values(clusterSnap.reserves).filter((r) => r && r.profileId) : [];
    // playing cards get more room than the reserves (their state words matter more)
    const grid = el('div', { class: 'players', style: 'grid-template-columns: repeat(3, minmax(0, 1.4fr))' + (reserves.length ? ` repeat(${reserves.length}, minmax(0, 1fr))` : '') });
    SLOTS.forEach((slot, i) => grid.appendChild(playerCard(i + 1, slot, assign[slot].runId)));
    reserves.forEach((r) => grid.appendChild(reserveCard(r)));
    return grid;
  }
  // What one account is doing, in words (never a colour alone).
  function slotState(index, slot, runId) {
    const cs = (clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot]) || {};
    const chromiumClosed = !!(cs.browserState && cs.browserState !== 'OPEN' && cs.browserState !== 'NOT_OPEN');
    const opened = !!runId && !chromiumClosed;
    const inGame = opened && slotInPhom(runId);
    const b = (opened ? manualBrowserById(runId) : null) || { manualState: opened ? 'READY' : 'CLOSED', rid: null };
    const entering = opened && !inGame && !!manualEntering[runId];
    const enterErr = opened && !inGame && manualEnterError[runId];
    const inTable = inGame && b.manualState === 'JOINED' && b.rid != null;
    // GĐ2 — the ONE state main derived for this browser (browser-state.cjs): the same words as its in-page bar
    const st = !runId ? ['Chưa mở', 'off']
      : chromiumClosed ? ['Đã tắt', 'off']
      : entering ? ['Đang vào game…', 'warn']
      : b.state && b.state.label ? [b.state.label + (b.state.inTable && b.ready ? ' · đã sẵn sàng' : ''), b.state.tone || 'info']
      : b.manualState === 'RECONNECTING' ? ['Bị đá → ReJoin', 'warn']
      : b.manualState === 'KICKED' ? ['Bị đá', 'bad']
      : b.manualState === 'JOINING' ? ['Đang vào bàn…', 'warn']
      : b.manualState === 'SEARCHING' ? [b.searchKind === 'SCAN' ? 'Đang Tạo (dò bàn KEY)…' : 'Đang Dò Key…', 'warn']
      : inTable ? [b.ready ? 'Trong bàn · đã sẵn sàng' : 'Trong bàn', 'good']
      : inGame ? ['Ở sảnh Phỏm', 'info']
      : enterErr ? ['Lỗi vào game', 'bad']
      : ['Chưa vào game', 'off'];
    return { b, opened, inGame, entering, chromiumClosed, label: st[0], cls: st[1], enterErr };
  }
  function playerCard(index, slot, runId) {
    const s = slotState(index, slot, runId);
    const b = s.b;
    const account = b.username && b.username !== 'USER_UNKNOWN' ? b.username : null;
    const role = ROLE_VIEW[b.groupRole];
    const tools = el('span', { class: 'pc-tools' });
    let extra = null; // a CLOSED slot's way back: take a reserve, reopen, or another profile
    if (!runId) tools.appendChild(el('span', { class: 'muted' }, 'Mở ở tab Profile'));
    else if (s.chromiumClosed) extra = closedSlotActions(slot);
    else {
      if (!s.inGame) tools.appendChild(el('button', { class: 'btn primary xs', disabled: s.entering ? 'disabled' : null, title: 'Vào game Phỏm', onclick: () => manualEnterGame(runId) }, s.entering ? '…' : 'Vào game'));
      tools.appendChild(iconButton('refresh', 'Tải lại web trong Chromium này', () => onReloadWeb(runId)));
      tools.appendChild(iconButton('power', 'Tắt Chromium này', () => onCloseBrowser(runId), 'danger'));
    }
    // compact card, 2 lines: [P · name · role] / [state … tools]; ID + money in the name's tooltip. Swapping is done from
    // the reserve's own card (→1/→2/→3) or, for a closed slot, below (←P4/←P5).
    const who = [account, b.accountId ? 'ID ' + b.accountId : '', b.money != null ? money(b.money) : ''].filter(Boolean).join(' · ');
    return el('section', { class: 'player st-' + s.cls, style: '--accent:' + ACCENT[index - 1] },
      el('div', { class: 'pc-head' },
        el('span', { class: 'p-badge' }, 'P' + index),
        el('div', { class: 'pc-name', title: who }, account || 'Chưa đăng nhập', b.isTableHost ? el('span', { title: 'Chủ bàn' }, ' 👑') : null),
        role ? el('span', { class: 'role ' + role[1], title: role[2] }, role[0]) : null),
      el('div', { class: 'pc-state', title: s.label + (who ? ' — ' + who : '') }, el('span', { class: 'dot ' + s.cls }), el('span', { class: 'pc-label' }, s.label), b.rejoinOn ? el('span', { class: 'pill rj', title: 'ReJoin bật — bị đá sẽ tự vào lại' }, 'RJ') : null, tools),
      s.enterErr ? el('div', { class: 'warn-text sm' }, s.enterErr) : null,
      extra);
  }
  // A RESERVE card (P4/P5): same compact look, dashed, marked DỰ BỊ; its →P1/→P2/→P3 buttons put it into that slot at
  // once (the slot's browser becomes the reserve). A closed reserve can only be reopened from the Profile tab.
  function reserveCard(r) {
    const n = 4 + ['D', 'E'].indexOf(r.slot);
    const open = r.browserState === 'OPEN';
    const b = (open ? manualBrowserById(r.profileId) : null) || {};
    const st = b.state || {};
    const account = b.username && b.username !== 'USER_UNKNOWN' ? b.username : null;
    const label = open ? (st.label ? st.label.replace(/^DỰ BỊ P\d · /, '') : 'Đang mở…') : 'Đã tắt';
    const tone = open ? (st.tone || 'off') : 'off';
    const tools = el('span', { class: 'pc-tools' });
    if (open) {
      if (st.code === 'NOT_IN_GAME') tools.appendChild(iconButton('play', 'Vào game Phỏm', () => manualEnterGame(r.profileId), 'primary'));
      tools.appendChild(iconButton('refresh', 'Tải lại web trong Chromium này', () => onReloadWeb(r.profileId)));
      tools.appendChild(iconButton('power', 'Tắt Chromium dự bị này', () => onCloseBrowser(r.profileId), 'danger'));
    } else {
      // N4 — a closed reserve comes back right here (same profile, behind the tool, warm again)
      tools.appendChild(el('button', { class: 'btn primary xs', disabled: reserveBusy[r.slot] ? 'disabled' : null, title: 'Mở lại trình duyệt dự bị này', onclick: () => onReopenReserve(r.slot) }, reserveBusy[r.slot] ? 'Đang mở…' : 'Mở lại'));
    }
    // compact, 2 lines: [P4 · name · state dot+words] / [→1 →2 →3 … tools] — the full state is in the tooltip
    const swap = open ? el('span', { class: 'pc-swap', title: 'Cho P' + n + ' vào chơi thay ô…' },
      ...SLOTS.map((slot, i) => el('button', { class: 'btn xs', disabled: replaceBusy[slot] ? 'disabled' : null, title: `P${n} vào chơi ở ô P${i + 1}; trình duyệt P${i + 1} hiện tại thành dự bị (rời bàn trước)`, onclick: () => onSwapSlot(slot, r.slot) }, '→' + (i + 1)))) : null;
    const who = [account || r.label || r.deviceProfileId, b.accountId ? 'ID ' + b.accountId : '', b.money != null ? money(b.money) : '', 'DỰ BỊ — mở sẵn sau tool, chưa chơi'].filter(Boolean).join(' · ');
    return el('section', { class: 'player reserve st-' + tone, title: label },
      el('div', { class: 'pc-head' },
        el('span', { class: 'p-badge', title: 'Dự bị' }, 'P' + n),
        el('div', { class: 'pc-name', title: who }, account || r.label || r.deviceProfileId),
        el('span', { class: 'dot res-dot ' + tone, title: label })), // the state in one dot on a short window
      el('div', { class: 'pc-state', title: label }, el('span', { class: 'dot ' + tone }), el('span', { class: 'pc-label res-label' }, label)),
      el('div', { class: 'pc-res-actions' }, swap, tools));
  }
  // A CLOSED playing slot: ←P4 / ←P5 (an open reserve, at once), Mở lại (its own profile), or another free profile.
  function closedSlotActions(slot) {
    const cs = (clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot]) || {};
    const box = el('div', { class: 'pc-into' });
    for (const r of openReserves()) box.appendChild(el('button', { class: 'btn primary xs', disabled: replaceBusy[slot] ? 'disabled' : null, title: 'Trình duyệt dự bị vào chơi ở ô này', onclick: () => onSwapSlot(slot, r.slot) }, '←P' + (4 + ['D', 'E'].indexOf(r.slot))));
    box.appendChild(el('button', { class: 'btn xs', disabled: replaceBusy[slot] ? 'disabled' : null, title: 'Mở lại profile cũ của ô này', onclick: () => onReplaceSlot(slot, cs.deviceProfileId || null) }, replaceBusy[slot] ? 'Đang mở…' : 'Mở lại'));
    const others = freeProfilesFor(slot).filter((p) => p.id !== cs.deviceProfileId);
    if (others.length) {
      const sel = el('select', { class: 'sel xs', title: 'Mở một profile khác vào ô này', disabled: replaceBusy[slot] ? 'disabled' : null, onchange: (e) => { if (e.target.value) onReplaceSlot(slot, e.target.value); } },
        el('option', { value: '' }, 'Profile khác…'), ...others.map((p) => el('option', { value: p.id }, p.name || p.id)));
      box.appendChild(sel);
    }
    return box;
  }
  // LỌC BÀI — ONE panel, a tab per playing account (P1 · P2 · P3), the selected one gets the whole width so a full hand
  // fits without scrolling late in the round. "Theo lượt" (default on) opens the tab of the account whose turn it is.
  let safeTab = 'B1';
  let safeFollowTurn = true;
  try { const v = localStorage.getItem('phq-safe-follow'); if (v != null) safeFollowTurn = v === '1'; } catch { /* per-viewer convenience only */ }
  function turnSlot() {
    const c = cardsSnap; if (!c || !c.currentTurnUid || !c.slotBinding) return null;
    for (const sl of ['B1', 'B2', 'B3']) if (c.slotBinding[sl] && String(c.slotBinding[sl]) === String(c.currentTurnUid)) return sl;
    return null;
  }
  function safePanel() {
    const turn = turnSlot();
    if (safeFollowTurn && turn) safeTab = turn;
    const tabs = el('div', { class: 'safe-tabs', role: 'tablist' });
    ['B1', 'B2', 'B3'].forEach((sl, i) => {
      const b = manualBrowserById(assign[SLOTS[i]].runId) || {};
      const name = b.username && b.username !== 'USER_UNKNOWN' ? b.username : '';
      const a = safeBySlot[sl];
      const n = a && a.status === 'OK' ? (a.safeCards || []).length : null;
      tabs.appendChild(el('button', { class: 'safe-tab' + (safeTab === sl ? ' active' : ''), role: 'tab', 'aria-selected': safeTab === sl ? 'true' : 'false', style: '--accent:' + ACCENT[i],
        title: turn === sl ? 'Đang tới lượt acc này' : '', onclick: () => { safeTab = sl; if (turn && turn !== sl) setFollow(false); renderApp(); } },
        el('b', null, 'P' + (i + 1)), name ? el('span', { class: 'st-name' }, name) : null,
        turn === sl ? el('span', { class: 'turn-dot', 'aria-label': 'đang tới lượt' }, '● lượt') : null,
        n != null ? el('span', { class: 'st-count', title: 'Số lá nên đánh' }, String(n)) : null));
    });
    const follow = el('input', { type: 'checkbox', id: 'phq-follow', onchange: (e) => { setFollow(e.target.checked); renderApp(); } });
    follow.checked = safeFollowTurn;
    tabs.appendChild(el('label', { class: 'follow', for: 'phq-follow', title: 'Tự mở tab của acc đang tới lượt' }, follow, 'Theo lượt'));
    // each account's tab: its LỌC BÀI (left) + the cards not seen anywhere yet (right, big, sorted / by phỏm)
    return el('section', { class: 'safe-panel' }, tabs, el('div', { class: 'safe-split' }, safeCardsFor(safeTab), remainingPanel(unseenCards(), remMode, setRemMode)));
  }
  function setRemMode(m) { remMode = m; try { localStorage.setItem('phq-rem-mode', m); } catch { /* ignore */ } renderApp(); }

  // ---- CÒN LẠI: the unseen cards (the card observer: 52 − our three hands − every discard − every laid meld) ----
  let remMode = 'PHOM';
  try { const v = localStorage.getItem('phq-rem-mode'); if (v === 'ORDER' || v === 'PHOM') remMode = v; } catch { /* per-viewer convenience only */ }
  function unseenCards() {
    const obs = cardsSnap && cardsSnap.remaining;
    if (!obs || !obs.knownOutCount || !Array.isArray(obs.cards)) return null; // no round seen yet → nothing honest to show
    return obs.cards.slice().sort((a, b) => a.code - b.code); // small → big (A … K), suit order within a rank
  }
  function setFollow(on) { safeFollowTurn = !!on; try { localStorage.setItem('phq-safe-follow', on ? '1' : '0'); } catch { /* ignore */ } }

  // LỌC BÀI for ONE account: the cards the NEXT player (table order) cannot eat, from all three accounts' cards.
  const SAFE_GROUPS = [
    ['safeCards', 'Nên đánh', 'g-safe', 'Người đánh sau chắc chắn không ăn được — điểm cao trước'],
    ['likelySafeCards', 'Có thể', 'g-likely', 'Có thể an toàn — gần như không ăn được'],
    ['unknownCards', 'Chưa rõ', 'g-unknown', 'Chưa chứng minh được — ít cách bị ăn đứng trước'],
    // "Đừng đánh" and "Phỏm" are not shown (user 2026-10-05): the panel lists only what CAN be played
  ];
  function safeCardsFor(slot) {
    const a = safeBySlot[slot];
    const box = el('div', { class: 'safe' });
    box.appendChild(el('div', { class: 'safe-h' }, el('span', null, '🛡 Lọc bài'), a && a.nextPlayerLabel ? el('span', { class: 'muted' }, 'Lượt sau: ' + playerLabel(a.nextPlayerLabel)) : null));
    if (!a || a.status !== 'OK') { box.appendChild(el('div', { class: 'safe-empty' }, 'Chưa có bài')); return box; }
    let any = false;
    for (const [key, label, cls, tip] of SAFE_GROUPS) {
      const cards = a[key] || [];
      if (!cards.length) continue;
      any = true;
      box.appendChild(el('div', { class: 'safe-group ' + cls, title: tip }, el('span', { class: 'g-label' }, label), safeCardRow(cards, key === 'safeCards' ? a.recommendedCode : null)));
    }
    if (!any) box.appendChild(el('div', { class: 'safe-empty' }, 'Chưa đủ dữ liệu'));
    return box;
  }
  function safeCardRow(cards, recommendedCode) {
    const row = el('div', { class: 'cards' });
    for (const c of cards) {
      const rec = recommendedCode != null && c.code === recommendedCode;
      const tip = (rec ? 'NÊN ĐÁNH — ' : '') + (c.points != null ? c.points + ' điểm' : '') + (c.openWays ? ' · ' + c.openWays + ' cách bị ăn' : '');
      row.appendChild(el('span', { class: 'card-face ' + (c.color === 'red' ? 'red' : 'black') + (rec ? ' recommended' : ''), title: tip }, el('b', null, c.rank || '?'), el('span', null, c.suit || '?')));
    }
    return row;
  }

  // ================= ĐÁNH BÀI tab =================
  // Its own tab (user 2026-10-09: not mixed into LỌC BÀI — the buttons covered it). One account at a time: its whole
  // hand (cards in its phỏm marked), click cards to pick them (again = unpick), then one of the game's own buttons:
  //   Bốc · Ăn — no card · Đánh — exactly one picked card (none = the card selected in the game window)
  //   Hạ · Gửi — the picked cards (none = the cards selected in the game window)
  // A button only works while the game is showing it in that browser; the tool never decides a move.
  // The hand of one slot from the card snapshot (cards laid on the table / sent are not in the hand any more)
  function handOf(slot) {
    const uid = cardsSnap && cardsSnap.slotBinding ? cardsSnap.slotBinding[slot] : null;
    const p = uid && cardsSnap.players ? cardsSnap.players[uid] : null;
    if (!p) return null;
    const laid = new Set((p.melds || []).flatMap((m) => m.cards || []).map(Number));
    const meld = new Set((p.serverMeldCards || []).map(Number));
    return { cards: (p.currentCardsView || []).filter((c) => !laid.has(Number(c.code))).sort((a, b) => a.code - b.code), meld, laid: p.melds || [] };
  }
  // who a uid is at the table: our P1/P2/P3, else the name the table shows, else "Acc lạ"
  function nameOfUid(uid) {
    const b = cardsSnap && cardsSnap.slotBinding ? Object.entries(cardsSnap.slotBinding).find(([, u]) => String(u) === String(uid)) : null;
    if (b) return 'P' + (['B1', 'B2', 'B3'].indexOf(b[0]) + 1);
    const p = cardsSnap && cardsSnap.players ? cardsSnap.players[uid] : null;
    return (p && p.name) || 'Acc lạ';
  }
  const labels = (cards) => (cards || []).map((x) => x.label).join(' ');
  const TIER_CLASS = ['t-safe', 't-likely', 't-risk'];
  function renderPlay(r) {
    const turn = turnSlot();
    if (safeFollowTurn && turn && !playPinned) playTab = turn;
    const tabs = el('div', { class: 'safe-tabs', role: 'tablist' });
    ['B1', 'B2', 'B3'].forEach((sl, i) => {
      const b = manualBrowserById(assign[SLOTS[i]].runId) || {};
      const name = b.username && b.username !== 'USER_UNKNOWN' ? b.username : '';
      tabs.appendChild(el('button', { class: 'safe-tab' + (playTab === sl ? ' active' : ''), role: 'tab', 'aria-selected': playTab === sl ? 'true' : 'false', style: '--accent:' + ACCENT[i],
        onclick: () => { playTab = sl; playPinned = !!(turn && turn !== sl); renderApp(); } },
        el('b', null, 'P' + (i + 1)), name ? el('span', { class: 'st-name' }, name) : null,
        turn === sl ? el('span', { class: 'turn-dot', 'aria-label': 'đang tới lượt' }, '● lượt') : null,
        (autoPlayByRun[assign[SLOTS[i]].runId] || {}).on ? el('span', { class: 'auto-dot', title: 'Đang tự đánh' }, 'tự') : null));
    });
    const runId = assign[SLOTS[['B1', 'B2', 'B3'].indexOf(playTab)]].runId;
    const hand = handOf(playTab);
    const help = playBySlot[playTab] || null;
    const picked = playPick.runId === runId ? playPick.codes : [];
    const body = el('div', { class: 'play-body' });
    if (!runId) body.appendChild(el('div', { class: 'safe-empty' }, 'Ô này chưa có trình duyệt'));
    else if (!hand || !hand.cards.length) body.appendChild(el('div', { class: 'safe-empty' }, 'Chưa có bài — vào bàn và chia bài để chọn lá'));
    else {
      // ---- TRÊN BÀN: the card the previous player just discarded to this account + the laid phỏm (public) ----
      const t = help && help.take;
      const table = el('div', { class: 'play-table' }, el('span', { class: 'g-label' }, 'Trên bàn'));
      if (t && t.ok) {
        table.appendChild(el('span', { class: 'take' + (t.canTake ? ' yes' : '') },
          'Lá ' + nameOfUid(t.prevUid) + ' vừa đánh: ', el('b', null, t.card.label),
          t.canTake ? ' — ăn được (' + labels(t.meld) + ')' + (t.pointsIfTaken != null ? ' · còn ' + t.pointsIfTaken + ' điểm' : '') : ' — không ghép được phỏm'));
      } else table.appendChild(el('span', { class: 'muted' }, t && t.eaten ? 'Lá vừa đánh đã có người ăn' : 'Chưa có lá đánh cho acc này'));
      const laid = [];
      for (const [uid, p] of Object.entries((cardsSnap && cardsSnap.players) || {})) for (const m of (p.melds || [])) laid.push(el('span', { class: 'laid', title: 'Phỏm của ' + nameOfUid(uid) }, labels(m.cardsView || []) + ' · ' + nameOfUid(uid)));
      if (laid.length) table.appendChild(el('span', { class: 'laid-list' }, ...laid));
      body.appendChild(table);
      // ---- BÀI TRÊN TAY: safety of every card, the card to play, points ----
      const tierOf = new Map(((help && help.ranking) || []).map((x) => [x.code, x]));
      const rec = help && help.recommended;
      body.appendChild(el('div', { class: 'play-h' },
        el('b', null, 'Bài trên tay · ' + hand.cards.length + ' lá' + (help && help.points != null ? ' · ' + help.points + ' điểm' : '')),
        rec ? el('span', { class: 'rec-line', title: rec.tierLabel + ' · đánh xong còn ' + rec.pointsLeft + ' điểm' }, 'Nên đánh: ', el('b', null, rec.label), ' (' + rec.tierLabel.toLowerCase() + ' · còn ' + rec.pointsLeft + ' điểm)') : null,
        el('span', { class: 'spacer' }),
        picked.length ? el('span', { class: 'muted' }, 'Đã chọn ' + picked.length + ' lá') : null,
        picked.length ? el('button', { class: 'btn ghost play-clear', onclick: () => { playPick = { runId: null, codes: [] }; renderApp(); } }, 'Bỏ chọn') : null));
      const sendable = new Map(((help && help.send) || []).map((x) => [x.code, x]));
      const row = el('div', { class: 'cards big play-hand' });
      for (const c of hand.cards) {
        const on = picked.includes(c.code);
        const info = tierOf.get(c.code);
        const inPhom = hand.meld.has(Number(c.code)) || (info && info.breaksPhom);
        const cls = ['card-face', 'big', c.color === 'red' ? 'red' : 'black', inPhom ? 'in-phom' : (info ? TIER_CLASS[info.tier] : ''), rec && rec.code === c.code ? 'recommended' : '', on ? 'picked' : ''].filter(Boolean).join(' ');
        const tip = [c.label, inPhom ? 'trong phỏm' : (info ? info.tierLabel : ''), info ? 'đánh lá này còn ' + info.pointsLeft + ' điểm' : '', sendable.has(c.code) ? 'gửi được' : '', on ? 'đã chọn' : ''].filter(Boolean).join(' · ');
        row.appendChild(el('span', { class: cls, role: 'button', title: tip,
          onclick: () => { const codes = on ? picked.filter((x) => x !== c.code) : picked.concat(c.code); playPick = { runId: codes.length ? runId : null, codes }; renderApp(); } },
        el('b', null, c.rank || '?'), el('span', null, c.suit || '?'), sendable.has(c.code) ? el('i', { class: 'send-tag', 'aria-label': 'gửi được' }, '↗') : null));
      }
      body.appendChild(row);
      body.appendChild(el('div', { class: 'rem-legend' },
        el('span', { class: 'lg lg-safe' }, 'chắc chắn không bị ăn'), el('span', { class: 'lg lg-likely' }, 'có thể không bị ăn'), el('span', { class: 'lg lg-risk' }, 'có thể bị ăn'), el('span', { class: 'lg lg-phom' }, 'trong phỏm'), el('span', null, '↗ gửi được')));
      // ---- GỢI Ý ĐÁNH: the loose cards by the user's order — chắc chắn không bị ăn, then có thể không bị ăn (each
      // group already sorted by the fewest points left); a click picks that card for Đánh ----
      const loose = ((help && help.ranking) || []).filter((x) => !x.breaksPhom);
      const pickOne = (x) => el('span', { class: 'card-face ' + (x.color === 'red' ? 'red' : 'black') + ' ' + TIER_CLASS[x.tier] + (picked.length === 1 && picked[0] === x.code ? ' picked' : ''), role: 'button',
        title: x.tierLabel + (x.inCa ? ' · cạ với ' + x.caWith.join(' ') : '') + ' · đánh lá này còn ' + x.pointsLeft + ' điểm · bấm để chọn', onclick: () => { playPick = { runId, codes: [x.code] }; renderApp(); } },
      el('b', null, x.rank || '?'), el('span', null, x.suit || '?'), x.inCa ? el('i', { class: 'ca-tag' }, 'cạ') : null);
      const group = (tier, label) => { const xs = loose.filter((x) => x.tier === tier); return xs.length ? el('div', { class: 'sug-row ' + TIER_CLASS[tier] }, el('span', { class: 'g-label' }, label + ' (' + xs.length + ')'), el('div', { class: 'cards' }, ...xs.map(pickOne))) : null; };
      const turn = help && help.turn;
      const sug = el('div', { class: 'play-sug' }, el('span', { class: 'g-label sug-title' }, 'Gợi ý đánh' + (turn ? (turn.last ? ' · lượt cuối — không bị ăn → điểm' : ' · lượt ' + turn.turn + '/4 — không bị ăn → giữ cạ → điểm') : '')),
        group(0, 'Chắc chắn không bị ăn'), group(1, 'Có thể không bị ăn'));
      if (!loose.some((x) => x.tier <= 1)) sug.appendChild(el('div', { class: 'muted sug-none' }, loose.length
        ? 'Chưa có lá nào chắc chắn / có thể không bị ăn — lá ít rủi ro nhất: ' + loose[0].label + ' (còn ' + loose[0].pointsLeft + ' điểm)'
        : 'Không còn lá rác — mọi lá đều trong phỏm'));
      body.appendChild(sug);
      // ---- gợi ý HẠ (fewest points, then the discard after it by the same order) + GỬI ----
      const ha = help && help.ha;
      // HẠ → GỬI → ĐÁNH: the three steps of the hạ turn, each with a button that picks its cards (the user presses)
      if (ha && ha.ok) {
        const pickBtn = (codes, label) => el('button', { class: 'btn ghost play-clear', onclick: () => { playPick = { runId, codes: codes.slice() }; renderApp(); } }, label);
        body.appendChild(el('div', { class: 'play-steps' },
          el('div', { class: 'step-h' }, el('span', { class: 'g-label' }, 'Gợi ý lượt hạ'), el('span', { class: 'muted' }, 'Hạ → Gửi → Đánh · còn ' + ha.pointsLeft + ' điểm')),
          el('div', { class: 'step' }, el('b', null, '① Hạ'), ...ha.melds.map((m) => el('span', { class: 'laid' }, labels(m))), pickBtn(ha.cards, 'Chọn bộ hạ')),
          el('div', { class: 'step' }, el('b', null, '② Gửi'), ...(ha.send.length
            ? ha.send.map((x) => el('span', { class: 'laid', title: 'vào phỏm ' + labels(x.into) + ' của ' + nameOfUid(x.owner) }, x.label + ' → ' + labels(x.into)))
              .concat([pickBtn(ha.sendCards, 'Chọn lá gửi')])
            : [el('span', { class: 'muted' }, 'không có lá gửi được')])),
          el('div', { class: 'step' }, el('b', null, '③ Đánh'), ha.discard
            ? el('span', { class: 'laid ' + TIER_CLASS[ha.discard.tier] }, ha.discard.label + ' — ' + ha.discard.tierLabel.toLowerCase())
            : el('span', { class: 'muted' }, 'hết bài rác'), ha.discard ? pickBtn([ha.discard.code], 'Chọn lá đánh') : null)));
      }
      if (sendable.size) body.appendChild(el('div', { class: 'play-hint' }, el('span', { class: 'g-label' }, 'Gửi được'),
        ...[...sendable.values()].map((x) => el('span', { class: 'laid' }, x.label + ' → ' + x.into.map((m) => labels(m.cards) + ' (' + nameOfUid(m.owner) + ')').join(' / '))),
        el('button', { class: 'btn ghost play-clear', onclick: () => { playPick = { runId, codes: [...sendable.keys()] }; renderApp(); } }, 'Chọn lá gửi')));
    }
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));
    r.appendChild(el('section', { class: 'play-panel' }, tabs, body, runId ? autoPlayLine(runId) : null));
  }
  // user 2026-10-10: no hand buttons any more — Tự đánh plays every account (the one TỰ ĐÁNH switch in the footer);
  // this line says what THIS account's Tự đánh is doing
  function autoPlayLine(runId) {
    const a = autoPlayByRun[runId] || {};
    return el('div', { class: 'play-bar', role: 'status', 'aria-label': 'Tự đánh acc này' },
      el('span', { class: 'auto-play' }, el('b', null, a.on ? 'Tự đánh' : 'Tự đánh tắt'),
        a.message ? el('span', { class: 'muted auto-play-msg' + (a.on && !a.resuming ? '' : ' off') }, a.message) : null,
        autoPlayStats(a.stats)));
  }
  function strategyControls() {
    const cur = autoPlayStrategy || {};
    const item = (key, label, tip) => {
      const id = 'phq-auto-strategy-' + key;
      const box = el('input', { type: 'checkbox', id, onchange: (e) => setAutoPlayStrategy({ [key]: e.target.checked }) });
      box.checked = key === 'blockThirdEat' ? cur[key] !== false : cur[key] === true;
      return el('label', { class: 'check auto-strategy-item', for: id, title: tip }, box, label);
    };
    return el('span', { class: 'auto-strategy', role: 'group', 'aria-label': 'Kịch bản Tự đánh' },
      item('lowMoney', 'Nuôi ít tiền', 'Tự đánh lá cho acc kế tiếp ăn khi acc đó đang ít tiền nhất (acc trong tool); áp dụng chung cho các acc Tự đánh'),
      item('twoPhomCaU', 'Ưu tiên 2 phỏm + cạ ù', 'Ưu tiên cạ ù hợp lệ của acc trong tool ngồi kế tiếp; áp dụng chung cho các acc Tự đánh'),
      el('span', { class: 'auto-strategy-item', title: 'Luôn chặn cho acc trong tool ăn lần 3, không ngoại lệ cạ ù; người ngoài dùng rule bình thường' }, 'Chặn ăn lần 3 · luôn bật'));
  }
  async function setAutoPlayStrategy(patch) {
    if (!api.setAutoPlayStrategy) return;
    const next = { ...(autoPlayStrategy || {}), ...patch };
    autoPlayStrategy = next;
    renderApp();
    let res; try { res = await api.setAutoPlayStrategy(next); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    if (res && res.ok) autoPlayStrategy = res.autoPlayStrategy || next;
    else note((res && res.error && res.error.message) || errText(res), true);
    renderApp();
  }
  // this session's count for the account (main keeps it): rounds played · stops · self-resumes
  function autoPlayStats(x) {
    if (!x || !(x.rounds || x.stops || x.resumed)) return null;
    return el('span', { class: 'muted auto-play-stats', title: 'Trong phiên này: số ván đã tự đánh · số lần dừng · số lần tự bật lại' },
      x.rounds + ' ván · dừng ' + x.stops + (x.resumed ? ' · tự bật lại ' + x.resumed : ''));
  }
  function controlFooter() {
    const g = manualGroup;
    const stakes = autoStakes();
    if (!autoStake && g && g.selectedStake != null) autoStake = String(g.selectedStake); // e.g. after a tool reload
    // the remembered stake stays chosen even before the server's stake list arrives (it is shown as an option)
    if (autoStake && !stakes.includes(Number(autoStake))) stakes.push(Number(autoStake)), stakes.sort((p, q) => p - q);
    const sel = el('select', { class: 'sel bet-sel', id: 'phq-stake', title: 'Mức cược dùng cho Dò Key / Tạo (cả tool và thanh trong web)', onchange: (e) => onPickStake(e.target.value) },
      el('option', { value: '' }, 'Chọn…'), ...stakes.map((v) => el('option', { value: String(v) }, money(v))));
    sel.value = autoStake;
    const loopOn = !!(loopStatus && loopStatus.on);
    const allowed = caps.autoPlayLicensed === true;
    const box = el('input', { type: 'checkbox', id: 'phq-loop', disabled: loopBusy || (!allowed && !loopOn) ? 'disabled' : null, onchange: (e) => onLoopToggle(e.target.checked) });
    box.checked = loopOn;
    const anDanhBox = el('input', { type: 'checkbox', id: 'phq-andanh', disabled: anDanhBusy ? 'disabled' : null, onchange: (e) => onAnDanhToggle(e.target.checked) });
    anDanhBox.checked = anDanhOn;
    return el('footer', { class: 'bar' },
      el('label', { class: 'field', for: 'phq-stake' }, 'Mức cược', sel),
      el('label', { class: 'switch' + (loopOn ? ' on' : '') + (allowed ? '' : ' locked'), for: 'phq-loop',
        title: allowed ? 'TỰ ĐÁNH cả nhóm, chạy vòng khép kín: tìm bàn → chờ người lạ → đánh → ván tiếp / đổi bàn. Lỗi thì tự thử lại, kẹt thì nghỉ 5 phút rồi chạy tiếp. Chỉ dừng khi tắt công tắc này hoặc key hết quyền.'
          : 'Key này chưa được cấp quyền Tự đánh — liên hệ admin để cấp key có tích "Cho dùng Tự đánh".' },
        box, el('span', { class: 'knob' }), loopBusy ? 'Đang xử lý…' : 'TỰ ĐÁNH'),
      loopStatus && loopStatus.message ? el('span', { class: 'muted auto-play-msg' + (loopOn && !loopStatus.resting ? '' : ' off'), title: loopStats(loopStatus.stats) }, loopStatus.message)
        : (allowed ? null : el('span', { class: 'muted auto-play-msg off' }, 'Key chưa có quyền Tự đánh')),
      strategyControls(),
      el('label', { class: 'switch' + (anDanhOn ? ' on' : ''), for: 'phq-andanh', title: 'Chế độ ẩn danh của game trên cả 3 trình duyệt. Tắt (mặc định): hiện số bàn thật, không có người chơi giả, xem được chat/bài/hiệu ứng. Bật: giữ ẩn danh như game (áp dụng từ bàn/ván sau).' },
        anDanhBox, el('span', { class: 'knob' }), anDanhBusy ? 'Đang xử lý…' : 'Ẩn danh'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', disabled: g ? null : 'disabled', title: 'Rời bàn này và tìm bàn chờ khác cho cả nhóm', onclick: () => onNewTable() }, 'Bàn khác'),
      el('button', { class: 'btn danger-outline', title: 'Cả 3 acc rời bàn (tắt TỰ ĐÁNH)', onclick: step(async () => { await stopLoop(); return api.leaveAll(); }, 'Đã thoát bàn tất cả.') }, 'Thoát bàn tất cả'),
      iconButton('grid', 'Xếp lại cửa sổ theo bố cục', step(() => api.restoreLayout(), 'Đã xếp lại cửa sổ.')),
      iconButton('layout', 'Đổi vị trí cửa sổ (bấm 2 cửa sổ để đổi chỗ)', () => openLayoutDialog()),
      iconButton('rec', 'Ghi WebSocket (gửi log khi báo lỗi)', () => openFrameCapture()),
      iconButton('folder', 'Các ván đã lưu (xem lại Lọc bài từng bước) — mở thư mục', async () => { const r = await api.openRounds(); if (r && r.ok === false) note(errText(r), true); }),
      el('button', { class: 'btn danger', title: 'Đóng cả 3 trình duyệt', onclick: () => closeBrowsers() }, 'Đóng tất cả'));
  }
  // stakes = the server stakes the in-game browsers saw
  function autoStakes() {
    const set = new Set();
    for (const b of manualBrowsers) for (const v of (b.betOptions || [])) set.add(Number(v));
    return [...set].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  }
  function autoCreatorRunId() {
    for (const slot of SLOTS) { const id = assign[slot].runId; if (id && slotInPhom(id)) return id; }
    return null;
  }
  // ONE stake for the whole session: the tool owns it, the in-page bars reuse it
  async function onPickStake(value) {
    autoStake = value;
    if (api.setStake) { try { await api.setStake(value ? Number(value) : null); } catch { /* the next pick retries */ } }
    bgRender();
  }
  // VÒNG TỰ ĐÁNH — the one switch (main: features/loop.cjs)
  async function onLoopToggle(on) {
    if (on && !manualGroup && !autoStake) { note('Chọn mức cược trước khi bật TỰ ĐÁNH.', true); renderApp(); return; }
    loopBusy = true; renderApp();
    let res; try { res = await api.setLoop(on); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    loopBusy = false;
    if (res && res.ok) { loopStatus = res.status || { on: !!on, message: null }; note(on ? 'TỰ ĐÁNH đang chạy — chỉ dừng khi tắt công tắc.' : 'Đã tắt TỰ ĐÁNH — các acc giữ chỗ ngồi.'); }
    else note((res && res.error && res.error.message) || errText(res), true);
    renderApp();
  }
  async function stopLoop() { if (loopStatus && loopStatus.on && api.setLoop) { try { await api.setLoop(false); } catch { /* best effort */ } loopStatus = { ...loopStatus, on: false }; } }
  function loopStats(x) { return x ? 'Trong phiên: ' + x.rounds + ' ván · đổi bàn ' + x.regroups + ' · nghỉ ' + x.rests + ' · khôi phục trình duyệt ' + x.recoveries : ''; }
  async function onAnDanhToggle(on) {
    anDanhBusy = true; renderApp();
    let res; try { res = await api.setAnDanh(on); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    anDanhBusy = false;
    if (res && res.ok === false) note(errText(res), true);
    else { anDanhOn = !!(res && res.on); note(anDanhOn ? 'Bật ẩn danh — áp dụng từ bàn/ván sau.' : 'Đã tắt ẩn danh.'); }
    renderApp();
  }
  async function onNewTable() {
    const g = manualGroup; if (!g) return;
    autoBusy = true; note('Đang tìm bàn khác…'); renderApp();
    let res; try { res = await api.newTable(g.members.find((m) => m.role === 'KEY')?.id || autoCreatorRunId()); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    autoBusy = false;
    if (res && res.ok === false) note(errText(res), true); else note('Đã sang bàn ' + (res && res.rid) + '.');
    await refreshManual(); renderApp();
  }
  const step = (fn, ok) => async () => { const res = await fn(); if (res && res.ok === false) note(errText(res), true); else if (ok) note(ok); await refreshManual(); renderApp(); };

  // ---- one browser's lifecycle (Tool + the other browsers untouched) ----
  async function onReloadWeb(runId) {
    note('Đang tải lại web…');
    let res; try { res = await api.reloadWeb(runId); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    clearEnter(runId);
    await refreshManual();
    if (res && res.ok === false) note(errText(res), true); else note('Đã tải lại web.');
    renderApp();
  }
  async function onCloseBrowser(runId) {
    note('Đang tắt Chromium…');
    try { await api.closeBrowser(runId); } catch (e) { note(String(e && e.message || e), true); }
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    await refreshManual(); renderApp();
  }
  // ĐỔI NGƯỜI CHƠI / THAY PROFILE — every slot can take an OPEN reserve browser (4th/5th ticked profile, waiting behind
  // the tool) at once — from the reserve's card (→P1/→P2/→P3) or a closed slot's card (←P4/←P5); a CLOSED slot can also
  // reopen with its own profile or any profile not open anywhere.
  function openReserves() {
    const rs = (clusterSnap && clusterSnap.reserves) || {};
    return Object.values(rs).filter((r) => r && r.profileId && r.browserState === 'OPEN');
  }
  function freeProfilesFor(slot) {
    const busy = new Set();
    for (const o of SLOTS) {
      if (o === slot) continue;
      const cs = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[o];
      if (cs && cs.deviceProfileId && cs.browserState === 'OPEN') busy.add(cs.deviceProfileId);
    }
    for (const r of openReserves()) if (r.deviceProfileId) busy.add(r.deviceProfileId);
    return profilesX.filter((p) => !busy.has(p.id));
  }
  // the Profile tab's badges follow the cluster: P1/P2/P3 = the playing profiles, then the open reserves
  function syncSelectionFromCluster() {
    const ps = (clusterSnap && clusterSnap.profiles) || {};
    const ids = SLOTS.map((sl) => ps[sl] && ps[sl].deviceProfileId).filter(Boolean);
    if (ids.length !== 3) return;
    selectedProfileIds = ids.concat(openReserves().map((r) => r.deviceProfileId).filter(Boolean));
  }
  const reserveBusy = { D: false, E: false };
  async function onReopenReserve(reserve) {
    reserveBusy[reserve] = true; note('Đang mở lại trình duyệt dự bị…'); renderApp();
    let res; try { res = await api.reopenReserve(reserve); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    reserveBusy[reserve] = false;
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    syncSelectionFromCluster();
    if (res && res.ok === false) note(errText(res), true); else note('Đã mở lại dự bị P' + (4 + ['D', 'E'].indexOf(reserve)) + ' — tool tự vào game.');
    await refreshManual(); renderApp();
  }
  async function onSwapSlot(slot, reserve) {
    const oldRun = assign[slot].runId;
    replaceBusy[slot] = true; note('Đang đổi người chơi…'); renderApp();
    let res; try { res = await api.swapSlot(slot, reserve); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    replaceBusy[slot] = false;
    if (oldRun) clearEnter(oldRun);
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    bindSlotsFromCluster(); syncSelectionFromCluster();
    if (res && res.ok === false) note(errText(res), true);
    else note(`Ô P${SLOTS.indexOf(slot) + 1} giờ là ${res && res.label ? res.label : 'trình duyệt dự bị'}; trình duyệt cũ chuyển ra sau tool.`);
    await refreshManual(); renderApp();
  }
  async function onReplaceSlot(slot, profileId) {
    const cs = (clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot]) || {};
    const oldRun = assign[slot].runId;
    replaceBusy[slot] = true;
    const p = profilesX.find((x) => x.id === profileId);
    note(profileId && profileId !== cs.deviceProfileId ? `Đang mở ${p ? p.name : profileId} vào ô P${SLOTS.indexOf(slot) + 1}…` : 'Đang mở lại Chromium…');
    renderApp();
    let res; try { res = await api.replaceSlot(slot, profileId && profileId !== cs.deviceProfileId ? profileId : null); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    replaceBusy[slot] = false;
    if (oldRun) clearEnter(oldRun);
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    bindSlotsFromCluster();
    syncSelectionFromCluster();
    if (res && res.ok === false) note(errText(res), true);
    else note(`Ô P${SLOTS.indexOf(slot) + 1} đang chạy ${res && res.label ? res.label : 'profile mới'} — đăng nhập nếu cần, tool tự vào game.`);
    await refreshManual(); renderApp();
  }
  // VÀO GAME on one browser: shows "Đang vào game…" at once, flips only on real in-Phỏm evidence, else a bounded timeout
  async function manualEnterGame(runId) {
    if (!runId) return;
    manualEntering[runId] = true; delete manualEnterError[runId];
    note('Đang vào game Phỏm…'); renderApp();
    if (!phomSessionStarted) { try { await ensurePassiveSession(); } catch {} }
    if (manualEnterTimers[runId]) clearTimeout(manualEnterTimers[runId]);
    manualEnterTimers[runId] = setTimeout(() => {
      manualEnterTimers[runId] = null;
      if (manualEntering[runId] && !slotInPhom(runId)) { delete manualEntering[runId]; manualEnterError[runId] = 'Vào game thất bại — đăng nhập rồi thử lại.'; renderApp(); }
    }, 30000);
    try { const res = await api.enterGame(runId); if (res && res.ok === false) { manualEnterError[runId] = errText(res); note(errText(res), true); } }
    catch (e) { manualEnterError[runId] = String(e && e.message || e); note(manualEnterError[runId], true); }
    await refreshManual(); renderApp();
  }
  function clearEnter(runId) {
    delete manualEntering[runId]; delete manualEnterError[runId];
    if (manualEnterTimers[runId]) { clearTimeout(manualEnterTimers[runId]); manualEnterTimers[runId] = null; }
  }
  function reconcileEnterStates() { for (const slot of SLOTS) { const runId = assign[slot].runId; if (runId && slotInPhom(runId)) clearEnter(runId); } }
  function slotProfile(runId) { return (session && session.profiles || []).find((x) => x.id === runId) || null; }
  // In the Phỏm lobby — read from the SAME snapshot as the card's state words (manualBrowsers), the session list only
  // as a fallback before the first snapshot, so the "Vào game" button and the state can never disagree.
  function slotInPhom(runId) { const p = manualBrowserById(runId) || slotProfile(runId); return !!(p && p.socketReady && p.connected && (p.channelCount || 0) > 0); }

  // GHI WEBSOCKET (Test D) — record the game's own frames while the user acts, save them (secrets redacted) for a bug report
  async function openFrameCapture() {
    const { overlay, body, close: closeDialog } = openDialog('Ghi WebSocket', 'Bắt đầu ghi → thao tác trong game → Dừng & lưu, rồi gửi file khi báo lỗi');
    let timer = null, busy = false, recording = false;
    const close = () => { clearInterval(timer); closeDialog(); };
    overlay.querySelector('.dialog-h .btn').onclick = close;
    const status = el('div', { class: 'capture-status', role: 'status', 'aria-live': 'polite' }, 'Đang kiểm tra…');
    const scope = el('select', { class: 'sel', 'aria-label': 'Trình duyệt cần ghi' }, el('option', { value: '' }, 'Cả 3 trình duyệt'));
    for (const b of manualBrowsers.slice().sort((x, y) => x.browserIndex - y.browserIndex)) scope.appendChild(el('option', { value: b.profileId }, `P${b.browserIndex}`));
    const out = el('pre', { class: 'capture-preview', hidden: true });
    const saved = el('div', { class: 'capture-saved' });
    const sync = () => { startBtn.disabled = busy || recording; stopBtn.disabled = busy || !recording; scope.disabled = busy || recording; };
    const poll = async () => {
      if (!overlay.isConnected) { clearInterval(timer); timer = null; return; } // closed by Esc / a click outside
      if (busy) return;
      try {
        const st = await api.framesRecordStatus();
        if (!overlay.isConnected || busy) return;
        if (!st || st.ok === false) throw new Error(errText(st));
        recording = !!st.recording;
        status.textContent = recording ? `● Đang ghi · ${st.frames || 0} gói${st.dropped ? ` · bỏ ${st.dropped}` : ''}` : 'Chưa ghi.';
        status.classList.toggle('recording', recording); sync();
      } catch { status.textContent = 'Không đọc được trạng thái ghi.'; startBtn.disabled = true; stopBtn.disabled = true; }
    };
    const startBtn = el('button', { class: 'btn primary', disabled: true, onclick: async () => {
      if (busy || recording) return;
      busy = true; sync();
      try {
        const r = await api.framesRecordStart({ runIds: scope.value ? [scope.value] : null, label: 'Test D — WS', keepRoomCodes: false });
        if (!r || r.ok === false) throw new Error(errText(r));
        recording = true; if (!timer) timer = setInterval(poll, 1000); saved.replaceChildren(); out.hidden = true;
        status.textContent = '● Đang ghi · hãy thao tác trong game.'; status.classList.add('recording');
      } catch (e) { status.textContent = 'Không bắt đầu được: ' + e.message; }
      finally { busy = false; sync(); }
    } }, 'Bắt đầu ghi');
    const stopBtn = el('button', { class: 'btn danger', disabled: true, onclick: async () => {
      if (busy || !recording) return;
      busy = true; sync();
      try {
        const r = await api.framesRecordStop();
        if (!r || r.ok === false) throw new Error(errText(r));
        recording = false; status.classList.remove('recording'); status.textContent = `Đã lưu ${r.frameCount} gói.`;
        saved.replaceChildren(el('span', { class: 'mono' }, r.txtPath || r.path), el('button', { class: 'btn', onclick: () => api.framesOpenFolder(r.txtPath || r.path) }, 'Mở thư mục'));
        out.textContent = (r.preview || []).join('\n'); out.hidden = false;
        clearInterval(timer); timer = null;
      } catch (e) { status.textContent = 'Không lưu được: ' + e.message; }
      finally { busy = false; sync(); }
    } }, 'Dừng & lưu');
    body.append(el('label', { class: 'form-row' }, el('span', null, 'Phạm vi'), scope), status, el('div', { class: 'row' }, startBtn, stopBtn),
      el('div', { class: 'muted' }, 'Đóng hộp này vẫn tiếp tục ghi — mở lại để dừng và lưu. Mã phòng được che.'), saved, out);
    await poll();
    if (overlay.isConnected) timer = setInterval(poll, 1000);
  }

  // ================= session plumbing =================
  // The passive session observes the runs (socket, login, table) as soon as they are open; it sends nothing. P1–P3 play,
  // the open reserves (P4/P5) follow them in order: warm members with a working bar (GĐ4).
  async function ensurePassiveSession() {
    if (phomSessionStarted) return;
    const runIds = SLOTS.map((sl) => assign[sl].runId).filter(Boolean);
    if (runIds.length !== 3) return;
    for (const r of openReserves()) if (r.profileId && !runIds.includes(r.profileId)) runIds.push(r.profileId);
    try { const start = await api.startSession({ runIds }); if (start && start.ok !== false) phomSessionStarted = true; } catch {}
  }
  // The fallback poll while the Phỏm tab is visible (pushes keep it current anyway; an idle lobby pushes rarely).
  let entryPollTimer = null;
  function startEntryPolling() {
    if (entryPollTimer) return;
    entryPollTimer = setInterval(async () => {
      if (uiState !== UI.CONTROL || activeTab !== 'PHOM' || document.hidden) return;
      await ensurePassiveSession();
      try { session = await api.sessionState(); } catch {}
      try { clusterSnap = await api.clusterSnapshot(); } catch {}
      // a logged-in browser still missing the stake channel list asks for it (each individually, never all three)
      const needChannels = SLOTS.filter((sl) => { const p = slotProfile(assign[sl].runId); return p && p.socketReady && p.connected && !((p.channelCount || 0) > 0); });
      if (needChannels.length && phomSessionStarted) { for (const sl of needChannels) { try { await api.requestChannels(assign[sl].runId); } catch {} } }
      await refreshManual();
      if (!$('workspace').hidden) bgRender();
    }, 2000);
  }

  // MỞ TRÌNH DUYỆT: PROFILE → OPENING_CLUSTER → PHỎM
  async function openCluster() {
    if (selectedProfileIds.length < 3 || selectedProfileIds.length > 5) { note('Tick 3 đến 5 profile trước khi mở.', true); return; }
    if (!localTest) {
      const missing = selectedProfileIds.map((id) => profilesX.find((x) => x.id === id)).filter((p) => !(p && p.gameUrl && String(p.gameUrl).trim())).map((p) => (p ? p.name : '?'));
      if (missing.length) { note(`Thiếu Game URL cho: ${missing.join(', ')}. Bấm Sửa để nhập.`, true); return; }
    }
    if (clusterOpBusy) { note('Đang mở — vui lòng chờ…', true); return; }
    clusterOpBusy = true;
    try { await openClusterInner(); } finally { clusterOpBusy = false; }
  }
  async function openClusterInner() {
    // already open → reuse, never tear down and reopen
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    if (clusterSnap && (clusterSnap.openBrowserCount || 0) >= 3 && clusterSnap.stopped !== true) {
      bindSlotsFromCluster();
      uiState = UI.CONTROL; activeTab = 'PHOM'; renderApp();
      await ensurePassiveSession(); startEntryPolling();
      note('Trình duyệt đã mở sẵn — dùng lại 3 cửa sổ hiện có.');
      return;
    }
    uiState = UI.OPENING_CLUSTER; renderApp();
    try {
      const created = await api.openSelected({ profileIds: selectedProfileIds, localTest });
      if (created && created.ok === false) throw created;
      if (created && created.localTest != null) localTest = created.localTest;
      const open = await api.clusterOpen();
      if (open && open.ok === false && !open.opened) throw open;
      // CDP needs a moment after launch; a miss never closes a browser
      for (let i = 0; i < 8; i++) {
        const cn = await api.clusterConnect();
        if (cn && (cn.connected || 0) >= 3) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      await api.clusterApplyAgents();
      try { await api.restoreLayout(); } catch {}
      try { caps = await api.capabilities(); } catch {}
      clusterSnap = await api.clusterSnapshot();
      bindSlotsFromCluster();
      phomSessionStarted = false;
      uiState = UI.CONTROL; activeTab = 'PHOM'; renderApp();
      await ensurePassiveSession(); startEntryPolling();
      const nRes = openReserves().length;
      note(`Đã mở ${open.opened || 0}/3 trình duyệt chơi${nRes ? ` + ${nRes} dự bị (sau tool — đổi ở nút Đổi trên thẻ P1/P2/P3)` : ''} — đăng nhập, tool tự vào game Phỏm.`);
    } catch (e) {
      // a failed open never closes the browsers that DID open
      try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
      if (clusterSnap && (clusterSnap.openBrowserCount || 0) > 0) {
        bindSlotsFromCluster();
        phomSessionStarted = false; uiState = UI.CONTROL; activeTab = 'PHOM'; renderApp();
        note('Mở chưa đủ 3 — các trình duyệt đã mở vẫn được giữ. ' + errText(e), true);
      } else {
        errorMsg = errText(e) + ' (chưa mở được trình duyệt nào — thử lại)';
        uiState = UI.ERROR; renderApp();
      }
    }
  }
  async function closeBrowsers() {
    if (!window.confirm('Đóng cả 3 trình duyệt? Cấu hình profile và proxy được giữ nguyên.')) return;
    await stopLoop(); // the loop would reopen them
    phomSessionStarted = false;
    uiState = UI.STOPPING; renderApp();
    try { await api.closeBrowsers(); } catch {}
    for (const s of SLOTS) assign[s].runId = null;
    await refreshProxies();
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    uiState = UI.SETUP; activeTab = 'SETUP'; renderApp();
    note('Đã đóng 3 trình duyệt.');
  }

  // ONE IPC for the whole Phỏm screen (main builds and also PUSHES the same object).
  async function refreshManual() {
    let snap = null;
    try { snap = await api.uiSnapshot(); } catch { snap = null; }
    applyUiSnapshot(snap);
  }
  function applyUiSnapshot(snap) {
    if (!snap) { manualBrowsers = []; coSeat = null; manualGroup = null; remaining = null; cardsSnap = null; safeBySlot = {}; playBySlot = {}; autoPlayByRun = {}; loopStatus = null; sharedRid = null; return; }
    manualBrowsers = snap.browsers || [];
    coSeat = snap.coSeat || null;
    manualGroup = snap.group || null;
    remaining = snap.remaining || null;
    cardsSnap = snap.cards || null;
    safeBySlot = snap.analyses || {};
    playBySlot = snap.play || {};
    autoPlayByRun = snap.autoPlay || {};
    loopStatus = snap.loop || null;
    autoPlayStrategy = (snap.settings && snap.settings.autoPlayStrategy) || autoPlayStrategy;
    sharedRid = snap.sharedRid != null ? snap.sharedRid : null;
    reconcileEnterStates();
  }
  function manualBrowserById(id) { return manualBrowsers.find((b) => String(b.profileId) === String(id)) || null; }
  // how many cards are still unseen (observer view preferred, else the backend 3-hands view)
  function remainingCount() {
    const obs = cardsSnap && cardsSnap.remaining ? cardsSnap.remaining : null;
    if (obs && obs.knownOutCount !== 0 && obs.count != null) return obs.count;
    return remaining && remaining.count != null ? remaining.count : null;
  }

  // ---------- pushes ----------
  if (api.onSession) api.onSession((snap) => { session = snap; if (!$('workspace').hidden) bgRender(); });
  if (api.onUi) api.onUi((snap) => { applyUiSnapshot(snap); if (!$('workspace').hidden && uiState === UI.CONTROL) bgRender(); });
  if (api.onNotice) api.onNotice(async (n) => {
    if (n && n.event === 'FOURTH_READY') ringBell(4);
    if (n && n.event === 'LOOP_REST') { ringBell(3); note(n.message || 'TỰ ĐÁNH đang nghỉ', true); return; }
    const t = noticeText(n); if (t) note(t, /KICK|FAIL|LOST|LOOP_GUARD|RUNAWAY/.test(n.event));
    // a reserve was swapped in by itself (a playing browser was closed from its window): the cards follow at once
    if (n && /^SLOT_AUTO_/.test(n.event)) {
      try { clusterSnap = await api.clusterSnapshot(); } catch {}
      bindSlotsFromCluster(); syncSelectionFromCluster();
      await refreshManual(); renderApp();
      if (t) note(t, /FAIL/.test(n.event));
    }
  });
  // a browser's proxy refused the saved credentials (or none were saved) — say which one, it cannot load the game
  if (api.onProxyAuth) api.onProxyAuth((p) => { if (p) note(playerLabelOf(p.runId) + ': proxy từ chối đăng nhập (' + (p.code === 'PROXY_AUTH_REQUIRED' ? 'proxy cần user/mật khẩu' : 'sai user/mật khẩu') + ') — sửa proxy ở tab Profile.', true); });
  // the key changed state while the app runs (expired · revoked online · offline too long · a new key): back to the
  // activation screen with the reason — the browser windows stay open; a valid key brings the workspace back
  if (api.onLicense) api.onLicense((s) => {
    if (!s) return;
    if (s.active && !$('activation').hidden) boot();
    else if (s.active === false && !$('workspace').hidden) showActivation(s);
  });
  if (api.onCluster) api.onCluster((snap) => { clusterSnap = snap; if (!$('workspace').hidden && (uiState === UI.CONTROL || uiState === UI.OPENING_CLUSTER)) bgRender(); });
  if (api.onKick) api.onKick(() => { if (uiState === UI.CONTROL) refreshManual().then(bgRender); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
