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

  // ---------- DOM helpers ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) { if (kid == null || kid === false) continue; n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); }
    return n;
  }
  const $ = (id) => document.getElementById(id);
  const ICON_PATHS = {
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    play: '<path d="m7 4 13 8-13 8Z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
    rec: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M3 12h18"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  };
  function icon(name) {
    const span = document.createElement('span');
    span.innerHTML = `<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
    return span.firstChild;
  }
  // icon-only button — always with a tooltip + aria-label
  function iconButton(name, title, onClick, variant) {
    return el('button', { class: 'icon-btn' + (variant ? ' ' + variant : ''), title, 'aria-label': title, onclick: onClick }, icon(name));
  }
  const playerLabel = (b) => { const m = /^(?:B|P|Player\s+)(\d+)$/i.exec(String(b == null ? '' : b)); return m ? 'P' + m[1] : String(b == null ? '' : b); };
  const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : Number(n).toLocaleString('vi-VN'));
  function errText(res) { const e = res && res.error; return e ? `${e.code}: ${e.message}` : 'Thao tác thất bại.'; }
  function note(msg, warn) { const n = $('phq-note'); if (n) { n.textContent = msg || ''; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }
  function noteText() { const n = $('phq-note'); return n ? n.textContent : ''; }

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
      el('nav', { class: 'tabs' }, tab('SETUP', 'Profile'), tab('PHOM', 'Phỏm')),
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
    if (activeTab === 'PHOM') {
      if (clusterIsOpen() || uiState === UI.CONTROL) renderControl(content);
      else content.appendChild(el('div', { class: 'empty' }, el('b', null, 'Chưa mở trình duyệt'), el('span', null, 'Sang tab Profile, tick 3–5 profile rồi bấm Mở trình duyệt.')));
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
    if (uiState !== UI.CONTROL || activeTab !== 'PHOM') return uiState + '|' + activeTab + '|' + manualBrowsers.length;
    const g = manualGroup;
    const browsers = manualBrowsers.map((b) => [b.profileId, b.manualState, b.rid, b.ready, b.groupRole, b.isTableHost, b.username, b.accountId, b.money, b.searchKind, b.rejoinOn, b.connected, b.socketReady, b.channelCount, b.lastError && b.lastError.code].join(',')).join(';');
    const cards = ['B1', 'B2', 'B3'].map((sl) => { const a = safeBySlot[sl]; return a ? a.roundSeq + ':' + a.nextPlayerLabel + ':' + (a.targetCards || []).map((c) => c.code + c.classification).join('') : '-'; }).join('|')
      + '|' + safeTab + safeFollowTurn + (cardsSnap && cardsSnap.currentTurnUid) + remMode + (cardsSnap && cardsSnap.remaining ? cardsSnap.remaining.count + ':' + cardsSnap.remaining.knownOutCount : '')
      + '|' + manualBrowsers.map((b) => b.state && b.state.label).join(',') + '|' + JSON.stringify((clusterSnap && clusterSnap.reserves) || {});
    const slots = SLOTS.map((s) => [assign[s].runId, manualEntering[assign[s].runId], manualEnterError[assign[s].runId], clusterSnap && clusterSnap.profiles && clusterSnap.profiles[s] && clusterSnap.profiles[s].browserState].join(',')).join(';');
    return [uiState, activeTab, g && g.rid, g && g.stake, g && g.auto, g && g.busy, g && g.recreating, autoStake, autoBusy,
      coSeat && coSeat.result, coSeat && coSeat.seatedCount, sharedRid, browsers, cards, slots, remainingCount(), noteText()].join('|');
  }

  // ---------- group notices (docs/phom-kich-ban.md) — one plain-Vietnamese line, never a raw code ----------
  const ROLE_VIEW = { KEY: ['KEY', 'role-key', 'Acc Dò Key — chủ bàn, KHÔNG tự bấm Bắt đầu'], READY: ['SẴN SÀNG', 'role-ready', 'Vào bàn trước → luôn sẵn sàng'], NOT_READY: ['CHƯA SS', 'role-wait', 'Vào bàn sau → không sẵn sàng, tự ReJoin'] };
  function roleLabel(role) { const v = ROLE_VIEW[role]; return v ? v[0] : role; }
  function playerLabelOf(runId) {
    const b = runId != null ? manualBrowserById(runId) : null;
    if (b && b.browserIndex) return 'P' + b.browserIndex;
    const i = SLOTS.findIndex((s) => runId != null && String(assign[s].runId) === String(runId)); // before login the slot still knows
    return i >= 0 ? 'P' + (i + 1) : 'Một acc';
  }
  function noticeText(n) {
    if (!n || !n.event) return '';
    const who = playerLabelOf(n.id);
    switch (n.event) {
      case 'KEY_SEATED': return who + ' là KEY (chủ bàn) — các acc khác bấm Tạo / Vào.';
      case 'TABLE_FOUND': return 'Số bàn ' + n.rid + ' — đã điền vào ô SS của mọi trình duyệt.';
      case 'READY_SENT': return who + ' đã sẵn sàng.';
      case 'FOURTH_READY': return '🔔 Người thứ 4' + (n.name ? ' (' + n.name + ')' : '') + ' đã sẵn sàng — tool tự cho ' + (n.notReadyId ? playerLabelOf(n.notReadyId) + ' sẵn sàng và ' : '') + playerLabelOf(n.keyId) + ' (KEY) bắt đầu ván.';
      case 'FULL_READY': return 'Bàn đủ 4 người — ' + who + ' đã tự sẵn sàng.';
      case 'ROUND_START_SENT': return who + ' (KEY) đã bắt đầu ván.';
      case 'SCAN_FAILED': return who + ' chưa dò ra bàn KEY: ' + errText({ error: n.error }) + '.';
      case 'GROUP_FORMED': return 'Cả nhóm đã vào bàn ' + n.rid + '.';
      case 'JOINED': return who + (n.rejoin ? ' đã vào lại bàn' : ' đã vào bàn') +(n.role ? ' · ' + roleLabel(n.role) : '') + '.';
      case 'JOIN_FAILED': return who + ' vào bàn không được: ' + errText({ error: n.error }) + '.';
      case 'FIND_FAILED': return 'Tìm bàn không được: ' + errText({ error: n.error }) + '.';
      case 'LEAVE_FAILED': return who + ' chưa rời được bàn: ' + errText({ error: n.error }) + '.';
      case 'KICKED': return who + ' bị đá khỏi bàn' + (n.message ? ' (' + n.message + ')' : '') + (n.auto ? ' — đang tự vào lại…' : ' — bấm ReJoin để vào lại.');
      case 'TABLE_LOST': return 'Bàn ' + n.rid + ' không còn' + (n.auto ? ' — đang dò bàn khác…' : ' — bấm Dò Key để vào bàn khác.');
      case 'GROUP_DISSOLVED': return n.reason === 'KEY_REPLACED' ? 'Acc KEY đã được thay — nhóm bị hủy, bấm Dò Key để lập bàn mới.' : 'Đã thoát bàn tất cả.';
      case 'MEMBER_REPLACED': return who + ' thay acc cũ, nhận vai ' + roleLabel(n.role) + ' — vào game xong sẽ tự vào bàn' + (n.rid != null ? ' ' + n.rid : '') + '.';
      case 'REPLACE_TIMEOUT': return who + ' chưa vào game sau 2 phút — đăng nhập rồi bấm Tạo / Vào.';
      case 'SLOT_AUTO_REPLACED': return 'Trình duyệt P' + (SLOTS.indexOf(n.slot) + 1) + ' bị tắt — đã tự thay bằng ' + (n.label || 'trình duyệt dự bị') + '.';
      case 'SLOT_AUTO_REPLACE_FAILED': return 'Trình duyệt P' + (SLOTS.indexOf(n.slot) + 1) + ' bị tắt — chưa thay được bằng dự bị: ' + errText({ error: n.error }) + '.';
      case 'AUTO_OFF': return 'Đã tắt tự động.';
      default: return '';
    }
  }
  // 🔔 the 4th player is ready: three bell strikes in the tool window (WebAudio, nothing to ship)
  function ringBell(times = 3) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ctx = ringBell.ctx || (ringBell.ctx = new AC());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      // A ringing bell (user 2026-10-05: "vang vang"): the inharmonic partials of a real bell, each decaying on its
      // own (the low hum lasts longest), a short echo for the ring, and a compressor so it is loud but never clips.
      const out = ctx.createDynamicsCompressor(); out.threshold.value = -14; out.ratio.value = 4; out.connect(ctx.destination);
      const echo = ctx.createDelay(1); echo.delayTime.value = 0.22;
      const fb = ctx.createGain(); fb.gain.value = 0.32;
      echo.connect(fb); fb.connect(echo); echo.connect(out);
      const BASE = 660;
      const PARTIALS = [[0.5, 0.30, 2.8], [1, 0.42, 2.4], [1.19, 0.20, 1.8], [1.56, 0.16, 1.4], [2, 0.22, 1.2], [2.74, 0.10, 0.9], [3.76, 0.06, 0.7]];
      for (let i = 0; i < times; i++) {
        const t = ctx.currentTime + i * 0.85;
        for (const [ratio, g, dur] of PARTIALS) {
          const o = ctx.createOscillator(); const v = ctx.createGain();
          o.type = 'sine'; o.frequency.value = BASE * ratio;
          v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(g, t + 0.008); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(v); v.connect(out); v.connect(echo); o.start(t); o.stop(t + dur + 0.05);
        }
      }
    } catch { /* no sound device — the notice still shows */ }
  }

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
  function openDialog(title, sub) {
    document.querySelectorAll('.overlay').forEach((n) => n.remove());
    const overlay = el('div', { class: 'overlay' });
    const close = () => overlay.remove();
    const body = el('div', { class: 'dialog-body' });
    overlay.appendChild(el('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
      el('div', { class: 'dialog-h' }, el('div', null, el('b', null, title), sub ? el('div', { class: 'muted' }, sub) : null), el('button', { class: 'btn ghost', onclick: close, 'aria-label': 'Đóng' }, '✕')),
      body));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.appendChild(overlay);
    return { overlay, body, close };
  }

  // BỐ CỤC — which quarter of the screen each window takes. A 2×2 picture of the screen; each quarter picks P1 / P2 /
  // P3 / Tool, and picking one that is elsewhere swaps the two (always one window per quarter). Áp dụng = save + arrange.
  async function openLayoutDialog() {
    let res = null; try { res = await api.getLayout(); } catch { res = null; }
    const def = (res && res.defaultLayout) || { A: 'BL', B: 'TL', C: 'TR', TOOL: 'BR' };
    let layout = { ...((res && res.layout) || def) };
    const { body, close } = openDialog('Bố cục cửa sổ', 'Chọn ô trên màn hình cho từng cửa sổ — P4/P5 dự bị luôn nằm sau Tool');
    const ITEM_LABEL = { A: 'P1', B: 'P2', C: 'P3', TOOL: 'Tool' };
    const QUAD_LABEL = { TL: 'Trên trái', TR: 'Trên phải', BL: 'Dưới trái', BR: 'Dưới phải' };
    const grid = el('div', { class: 'layout-grid' });
    const place = (item, quad) => {
      const other = Object.keys(layout).find((k) => layout[k] === quad);
      if (other && other !== item) layout[other] = layout[item];
      layout[item] = quad;
      paint();
    };
    function paint() {
      grid.replaceChildren();
      for (const quad of ['TL', 'TR', 'BL', 'BR']) {
        const item = Object.keys(layout).find((k) => layout[k] === quad);
        const idx = { A: 0, B: 1, C: 2 }[item];
        const sel = el('select', { class: 'sel', 'aria-label': QUAD_LABEL[quad], onchange: (e) => place(e.target.value, quad) },
          ...['A', 'B', 'C', 'TOOL'].map((it) => el('option', { value: it }, ITEM_LABEL[it])));
        sel.value = item;
        grid.appendChild(el('div', { class: 'layout-cell' + (item === 'TOOL' ? ' is-tool' : ''), style: idx != null ? '--accent:' + ACCENT[idx] : '' },
          el('span', { class: 'muted' }, QUAD_LABEL[quad]), el('b', null, ITEM_LABEL[item]), sel));
      }
    }
    paint();
    const msg = el('div', { class: 'note' }, '');
    body.append(grid, msg, el('div', { class: 'row end' },
      el('button', { class: 'btn', onclick: () => { layout = { ...def }; paint(); } }, 'Mặc định'),
      el('button', { class: 'btn primary', onclick: async () => {
        let r = null; try { r = await api.setLayout(layout); } catch (e) { r = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
        if (r && r.ok === false) { msg.textContent = errText(r); msg.className = 'note warn'; return; }
        close(); note('Đã lưu bố cục và xếp lại cửa sổ.');
      } }, 'Áp dụng & xếp')));
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
    return el('section', { class: 'safe-panel' }, tabs, el('div', { class: 'safe-split' }, safeCardsFor(safeTab), remainingPanel(unseenCards())));
  }
  function setRemMode(m) { remMode = m; try { localStorage.setItem('phq-rem-mode', m); } catch { /* ignore */ } renderApp(); }

  // ---- CÒN LẠI: the unseen cards (the card observer: 52 − our three hands − every discard − every laid meld) ----
  let remMode = 'PHOM';
  try { const v = localStorage.getItem('phq-rem-mode'); if (v === 'ORDER' || v === 'PHOM') remMode = v; } catch { /* per-viewer convenience only */ }
  const SUIT_ORDER = ['♠', '♣', '♦', '♥'];
  const rankOfCode = (code) => Math.floor(Number(code) / 4);   // 0 = A … 12 = K (card-codec)
  const suitOfCode = (code) => Number(code) % 4;
  function unseenCards() {
    const obs = cardsSnap && cardsSnap.remaining;
    if (!obs || !obs.knownOutCount || !Array.isArray(obs.cards)) return null; // no round seen yet → nothing honest to show
    return obs.cards.slice().sort((a, b) => a.code - b.code); // small → big (A … K), suit order within a rank
  }
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
  function remainingPanel(cards) {
    const box = el('div', { class: 'rem' });
    const mode = (m, label, tip) => el('button', { class: 'seg' + (remMode === m ? ' active' : ''), title: tip, onclick: () => setRemMode(m) }, label);
    box.appendChild(el('div', { class: 'rem-h' },
      el('span', { class: 'rem-title', title: 'Lá chưa xuất hiện — đang ở tay acc lạ hoặc còn trong nọc' }, '🂠 Còn lại' + (cards ? ' · ' + cards.length + ' lá' : '')),
      el('span', { class: 'spacer' }),
      el('span', { class: 'segs', role: 'group', 'aria-label': 'Cách xếp' }, mode('PHOM', 'Theo phỏm', 'Nhóm thành phỏm ngang / dọc có thể có, rồi lá lẻ'), mode('ORDER', 'Thứ tự', 'Tất cả từ bé tới lớn (A → K)'))));
    if (!cards) { box.appendChild(el('div', { class: 'safe-empty' }, 'Chưa có ván — vào bàn và chia bài để xem lá còn lại')); return box; }
    if (!cards.length) { box.appendChild(el('div', { class: 'safe-empty' }, 'Không còn lá nào chưa xuất hiện')); return box; }
    const g = groupByPhom(cards);
    // which possible phỏm each card belongs to — the highlight in BOTH views
    const inSet = new Set([].concat(...g.sets).map((x) => x.code)), inRun = new Set([].concat(...g.runs).map((x) => x.code));
    const kindOf = (c) => (inSet.has(c.code) && inRun.has(c.code) ? 'both' : inSet.has(c.code) ? 'set' : inRun.has(c.code) ? 'run' : 'loose');
    const row = (cs, kind) => el('div', { class: 'cards big' }, ...cs.map((c) => bigCard(c, kind || kindOf(c))));
    if (remMode === 'ORDER') {
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

  function controlFooter() {
    const g = manualGroup;
    const autoOn = !!(g && g.auto);
    const stakes = autoStakes();
    if (!autoStake && g && g.selectedStake != null) autoStake = String(g.selectedStake); // e.g. after a tool reload
    // the remembered stake stays chosen even before the server's stake list arrives (it is shown as an option)
    if (autoStake && !stakes.includes(Number(autoStake))) stakes.push(Number(autoStake)), stakes.sort((p, q) => p - q);
    const sel = el('select', { class: 'sel bet-sel', id: 'phq-stake', title: 'Mức cược dùng cho Dò Key / Tạo (cả tool và thanh trong web)', onchange: (e) => onPickStake(e.target.value) },
      el('option', { value: '' }, 'Chọn…'), ...stakes.map((v) => el('option', { value: String(v) }, money(v))));
    sel.value = autoStake;
    const box = el('input', { type: 'checkbox', id: 'phq-auto', disabled: autoBusy ? 'disabled' : null, onchange: (e) => onAutoToggle(e.target.checked) });
    box.checked = autoOn;
    const anDanhBox = el('input', { type: 'checkbox', id: 'phq-andanh', disabled: anDanhBusy ? 'disabled' : null, onchange: (e) => onAnDanhToggle(e.target.checked) });
    anDanhBox.checked = anDanhOn;
    return el('footer', { class: 'bar' },
      el('label', { class: 'field', for: 'phq-stake' }, 'Mức cược', sel),
      el('label', { class: 'switch' + (autoOn ? ' on' : ''), for: 'phq-auto', title: 'Bật: Dò Key → Tạo → Vào cho 3 acc như bấm tay; bị đá tự ReJoin; mất bàn tự tìm bàn khác. Tắt: không làm gì tự động.' },
        box, el('span', { class: 'knob' }), autoBusy ? 'Đang xử lý…' : 'Tự động'),
      el('label', { class: 'switch' + (anDanhOn ? ' on' : ''), for: 'phq-andanh', title: 'Chế độ ẩn danh của game trên cả 3 trình duyệt. Tắt (mặc định): hiện số bàn thật, không có người chơi giả, xem được chat/bài/hiệu ứng. Bật: giữ ẩn danh như game (áp dụng từ bàn/ván sau).' },
        anDanhBox, el('span', { class: 'knob' }), anDanhBusy ? 'Đang xử lý…' : 'Ẩn danh'),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn', disabled: g ? null : 'disabled', title: 'Rời bàn này và tìm bàn chờ khác cho cả nhóm', onclick: () => onNewTable() }, 'Bàn khác'),
      el('button', { class: 'btn danger-outline', title: 'Cả 3 acc rời bàn (tắt tự động)', onclick: step(() => api.leaveAll(), 'Đã thoát bàn tất cả.') }, 'Thoát bàn tất cả'),
      iconButton('grid', 'Xếp lại cửa sổ theo bố cục', step(() => api.restoreLayout(), 'Đã xếp lại cửa sổ.')),
      iconButton('layout', 'Bố cục: chọn ô cho P1 / P2 / P3 / Tool', () => openLayoutDialog()),
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
  async function onAutoToggle(on) {
    if (on && !manualGroup && !autoStake) { note('Chọn mức cược trước khi bật Tự động.', true); renderApp(); return; }
    const creator = autoCreatorRunId();
    if (on && !manualGroup && !creator) { note('Chưa có acc nào vào game.', true); renderApp(); return; }
    autoBusy = true; note(on ? (manualGroup ? 'Bật tự động — giữ bàn hiện tại…' : 'Đang tìm bàn và gọi các acc vào…') : 'Tắt tự động.'); renderApp();
    let res; try { res = await api.setAuto(on, creator, autoStake ? Number(autoStake) : null); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    autoBusy = false;
    if (res && res.ok === false) note(errText(res), true);
    else if (on) note('Tự động đang giữ bàn ' + (res && res.rid != null ? res.rid : '') + '.');
    await refreshManual(); renderApp();
  }
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
    if (!snap) { manualBrowsers = []; coSeat = null; manualGroup = null; remaining = null; cardsSnap = null; safeBySlot = {}; sharedRid = null; return; }
    manualBrowsers = snap.browsers || [];
    coSeat = snap.coSeat || null;
    manualGroup = snap.group || null;
    remaining = snap.remaining || null;
    cardsSnap = snap.cards || null;
    safeBySlot = snap.analyses || {};
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
    if (n && n.event === 'FOURTH_READY') ringBell(3);
    const t = noticeText(n); if (t) note(t, /KICK|FAIL|LOST/.test(n.event));
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
  if (api.onLicense) api.onLicense((s) => { if (s && s.active && !$('activation').hidden) boot(); });
  if (api.onCluster) api.onCluster((snap) => { clusterSnap = snap; if (!$('workspace').hidden && (uiState === UI.CONTROL || uiState === UI.OPENING_CLUSTER)) bgRender(); });
  if (api.onKick) api.onKick(() => { if (uiState === UI.CONTROL) refreshManual().then(bgRender); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
