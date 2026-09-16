'use strict';

// Phỏm QA standalone renderer. Talks ONLY to window.phomQA (typed preload). No raw
// WS sender, no CDP, no proxy password.
//
// SETUP-FIRST UX (state machine, one tool window):
//   SETUP           — the idle tool: license, 3 profile setup rows (device + proxy),
//                     proxy Add/Edit/Delete/Test, ONE open-all CTA, Analyzer link,
//                     Advanced (closed). NO browser placeholders, NO per-slot open-game
//                     button, NO seat/ready/hand placeholders, NO host controls.
//   OPENING_CLUSTER — transient while the three native Chromium windows are launched.
//   CONTROL         — compact control panel AFTER the cluster is open: compact per-slot
//                     status rows + Focus/Restore/Stop + HOST/stake/Join/Ready/kick.
//   STOPPING        — transient while the cluster closes.
//   ERROR           — an open/stop failure with a "back to setup" path.
// The three managed browsers are ALWAYS separate native Chromium windows — never
// embedded cells. No gameplay automation / no strategy controls.
(function () {
  const api = window.phomQA || {};
  const SUIT_RED = new Set(['♦', '♥']);
  const SLOTS = ['A', 'B', 'C'];
  const UI = { SETUP: 'SETUP', OPENING_CLUSTER: 'OPENING_CLUSTER', CONTROL: 'CONTROL', STOPPING: 'STOPPING', ERROR: 'ERROR' };
  let uiState = UI.SETUP;
  let errorMsg = '';
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
  // Screen-2 entry gate (§1-§4): the user MUST drive each step explicitly; nothing
  // auto-advances. LOGIN (browsers open, user logs in) → CONFIRMED (user pressed ĐÃ LOGIN)
  // → ENTERING (user pressed VÀO GAME PHỎM; passive session started, waiting for the game
  // protocol context on A/B/C) → READY (3/3 in Phỏm; only now is TÌM BÀN enabled). TÌM BÀN
  // never runs until the user reaches READY and clicks it.
  const ENTRY = { LOGIN: 'LOGIN', CONFIRMED: 'CONFIRMED', ENTERING: 'ENTERING', READY: 'READY' };
  let entryPhase = ENTRY.LOGIN;   // set to LOGIN on RUN GAME; browsers stay open across all phases
  let phomSessionStarted = false; // the passive HostSession has been started (at VÀO GAME PHỎM)
  // ENTERING sub-state: the verified `vgcg_8` entry action has been triggered on A/B/C and we are
  // waiting for the authoritative in-Phỏm signal (never guessed, never faked).
  const ESUB = { ENTERING_ACTION: 'ENTERING_ACTION' };
  let entrySub = null;
  let qaSnap = null;         // FIXTURE/REPLAY monitor (D simulated) snapshot — REPLAY mode only
  let qaLoading = false, qaPlaying = false, qaTimer = null, qaSpeed = 900;
  // Screen-2 monitor source mode. DEFAULT is LIVE_INTERNAL: the monitor shows ONLY live
  // internal A/B/C data (or a truthful waiting state) and NEVER auto-loads the bundled D
  // fixture. FIXTURE_REPLAY (the simulated D engine + playback) opens ONLY on explicit
  // user selection from the ⋯ menu — it is never a fallback when live has no data.
  const MON = { LIVE: 'LIVE_INTERNAL', REPLAY: 'FIXTURE_REPLAY' };
  let monitorMode = MON.LIVE;
  let localTest = false;     // LOCAL RUNTIME TEST (dev-only: open browsers without proxy)
  let clusterOpBusy = false; // guards RUN GAME against a duplicate click opening a 2nd cluster (§41)
  // PHASE-6.1 — manual per-browser control (Browser 1/2/3): search lock + shared Room/RID.
  const MCS = (typeof window !== 'undefined' && window.ManualClusterState) ? window.ManualClusterState : null;
  let manualCluster = MCS ? MCS.create() : { searchingBrowserId: null, sharedRid: null, sharedRidOwner: null };
  let manualBrowsers = [];   // last manualBrowserSnapshot() (per-browser independent state)
  let remaining = null;      // last remainingCards() view for Screen 2
  let manualStake = '';      // (deprecated 6.2.1) — stake now comes from the discovered server table
  const ridDraft = {};       // per-browser Room/RID input draft (browserId -> string)
  const manualEntering = {}; // browserId -> true while VÀO GAME is in flight (real ENTERING state, §5)
  const manualEnterError = {}; // browserId -> message when VÀO GAME failed/timed out (retryable)
  const manualEnterTimers = {}; // browserId -> bounded entry timeout handle
  const manualJoining = {};  // browserId -> true while VÀO BÀN (join shared RID) is in flight (§4)
  const selectedStakeByBrowser = {}; // PHASE 6.2.3 — the finder's chosen REAL stake (from server bet options)
  let activeTab = 'SETUP';   // PHASE 6.2.2 — two tabs: SETUP (config/open) and PHOM (control)
  let clusterSnap = null;    // last PhomClusterCdpManager snapshot
  let clusterProfiles = [];  // saved cluster profiles (shared game URL + 3 slots)
  let selectedClusterProfileId = null;
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
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    await refreshClusterProfiles();
    // Land in CONTROL if a cluster is already open (e.g. renderer reload), else SETUP.
    uiState = clusterIsOpen() ? UI.CONTROL : UI.SETUP;
    renderApp();
  }

  function clusterIsOpen() {
    const cs = clusterSnap; if (!cs || cs.stopped) return false;
    // A browser is "open" once its run exists — independent of CDP connection (§7): the
    // cluster stays open even while CDP is still connecting.
    return !!cs.clusterSessionId && ((cs.openBrowserCount || 0) > 0 || (cs.connectedCount || 0) > 0);
  }

  // PHASE 6.2.2 — two tabs: SETUP (config + open browsers) and PHỎM (control). The Tool is a single OS
  // window; the tabs switch its content without closing the three Chromium windows.
  function renderTabBar() {
    const bar = el('div', { class: 'tab-bar' });
    const tab = (id, label) => el('button', { class: 'tab' + (activeTab === id ? ' active' : ''), onclick: () => { activeTab = id; renderApp(); } }, label);
    bar.appendChild(tab('SETUP', 'SETUP'));
    bar.appendChild(tab('PHOM', 'PHỎM'));
    return bar;
  }

  // ---------- top-level dispatch ----------
  function renderApp() {
    const r = $('phq-root'); if (!r) return;
    r.innerHTML = '';
    r.className = 'mode-' + uiState.toLowerCase();
    banners(r);
    if (uiState === UI.OPENING_CLUSTER) return renderTransient(r, 'ĐANG MỞ 3 TRÌNH DUYỆT…', 'Ba cửa sổ Chromium đang bung ra bên ngoài.');
    if (uiState === UI.STOPPING) return renderTransient(r, 'ĐANG DỪNG CỤM…', 'Đóng ba trình duyệt, giữ nguyên cấu hình đã lưu.');
    if (uiState === UI.ERROR) return renderError(r);
    // SETUP / CONTROL steady states → two-tab surface.
    const open = clusterIsOpen();
    r.appendChild(renderTabBar());
    const content = el('div', { class: 'tab-content' });
    r.appendChild(content);
    if (activeTab === 'PHOM') {
      if (open || uiState === UI.CONTROL) renderControl(content);
      else content.appendChild(el('div', { class: 'note', style: 'margin-top:10px' }, 'Chưa mở trình duyệt — sang tab SETUP để mở 3 trình duyệt.'));
    } else { renderSetup(content); }
  }

  // A BACKGROUND re-render (2s poll / onSession / onHands / onCluster pushes) must NOT destroy an OPEN
  // bet dropdown mid-selection — that was the "picked a stake but can't press TÌM BÀN" bug. Skip the
  // rebuild while a bet <select> is focused; the next event re-renders once the user has committed.
  function betSelectFocused() { const a = document.activeElement; return !!(a && a.classList && a.classList.contains('bet-sel')); }
  function bgRender() { if (betSelectFocused()) return; renderApp(); }

  function banners(r) {
    if (licenseMode === 'DEVELOPMENT_BYPASS') r.appendChild(el('div', { class: 'dev-banner' }, 'DEV MODE — LICENSE BYPASS'));
    const sb = caps.chromiumSandbox;
    if (sb && sb.disabled) r.appendChild(el('div', { class: 'danger-banner' }, sb.banner || 'DEV ONLY — CHROMIUM SANDBOX DISABLED'));
  }

  function header(state) {
    return el('div', null,
      el('b', { style: 'font-size:16px' }, 'PHỎM QA'),
      el('span', { class: 'faint', style: 'margin-left:8px' }, state),
      caps.authorized ? pill('Env', 'QA ✓', 'good') : pill('Env', 'passive', 'warn'),
      el('span', { class: 'pill ' + (licenseMode === 'DEVELOPMENT_BYPASS' ? 'warn' : 'good') }, licenseMode === 'DEVELOPMENT_BYPASS' ? 'DEV BYPASS' : 'LICENSED'),
    );
  }

  function renderTransient(r, title, sub) {
    r.appendChild(header(uiState));
    r.appendChild(el('div', { class: 'section-t', style: 'margin-top:16px' }, title));
    r.appendChild(el('div', { class: 'note' }, sub));
  }

  function renderError(r) {
    r.appendChild(header('ERROR'));
    r.appendChild(el('div', { class: 'warnrow', style: 'margin:10px 0' }, errorMsg || 'Đã xảy ra lỗi.'));
    r.appendChild(el('button', { class: 'btn primary', onclick: () => { uiState = UI.SETUP; activeTab = "SETUP"; renderApp(); } }, 'Về SETUP'));
  }

  function selectedProfile() { return clusterProfiles.find((p) => p.id === selectedClusterProfileId) || null; }

  // ================= SCREEN 1 — SETUP (two-column grid, no-scroll at ~960×516) ==========
  // Layout follows the locked design: a thin header + a 2-column grid (1fr / 0.95fr).
  //   LEFT : "CẤU HÌNH CHUNG" (Cluster+HOST row, shared Link Game) + "THIẾT BỊ VÀ PROXY
  //          ĐÃ GÁN" (A/B/C display rows — device + assigned redacted proxy + status).
  //   RIGHT: "THIẾT LẬP NHANH 3 PROXY" (per-slot protocol+input + Apply/Test) + footer
  //          (Local Runtime Test + the single RUN GAME CTA).
  // The right column is where proxies are CONFIGURED; the left rows only DISPLAY the
  // assigned proxy — never a second set of proxy controls.
  function renderSetup(r) {
    const h = header('SETUP'); h.classList.add('s1-header'); r.appendChild(h);
    r.appendChild(el('div', { class: 'note s1-note', id: 'phq-note' }, ''));

    const grid = el('div', { class: 'setup', id: 'phq-setup-grid' });
    const left = el('div', { class: 's1-col s1-left' });
    left.appendChild(panelGeneral());
    left.appendChild(panelAssigned());
    const right = el('div', { class: 's1-col s1-right' });
    right.appendChild(panelQuickProxy());
    right.appendChild(footerRunGame());
    grid.appendChild(left); grid.appendChild(right);
    r.appendChild(grid);
  }

  // LEFT panel 1 — CẤU HÌNH CHUNG: Cluster Profile + HOST on one row, shared Link below.
  function panelGeneral() {
    const p = selectedProfile();
    const panel = el('div', { class: 's1-panel' }, el('div', { class: 's1-panel-t' }, 'CẤU HÌNH CHUNG'));
    // Cluster select + HOST select + ONE cluster-management ⋯ menu.
    const sel = el('select', { id: 'cl-sel', class: 'phq-in', onchange: async (e) => { await api.clusterProfileSelect(e.target.value || ''); await refreshClusterProfiles(); renderApp(); } });
    sel.appendChild(el('option', { value: '' }, '— chọn cụm —'));
    for (const cp of clusterProfiles) { const o = el('option', { value: cp.id }, `${cp.name} · ${cp.state}`); if (cp.id === selectedClusterProfileId) o.setAttribute('selected', 'selected'); sel.appendChild(o); }
    const menu = el('div', { class: 'qa-more-menu', hidden: 'hidden' },
      el('button', { class: 'menu-item', onclick: () => { menu.hidden = true; clusterProfileCreate(); } }, 'Tạo cụm'),
      el('button', { class: 'menu-item', onclick: () => { menu.hidden = true; clusterProfileEdit(); } }, 'Sửa cụm'),
      el('button', { class: 'menu-item', onclick: () => { menu.hidden = true; clusterProfileDuplicate(); } }, 'Nhân bản'),
      el('button', { class: 'menu-item danger', onclick: () => { menu.hidden = true; clusterProfileDelete(); } }, 'Xóa cụm'));
    const more = el('div', { class: 'qa-more' }, el('button', { class: 'btn sm', title: 'Quản lý cụm', onclick: () => { menu.hidden = !menu.hidden; } }, '⋯'), menu);
    const hostSel = el('select', { class: 'sel s1-host', id: 'phq-hostslot', title: 'Chọn HOST', disabled: p ? null : true, onchange: async (e) => { if (p) { await api.clusterProfileUpdate(p.id, { defaultHostSlot: e.target.value }); await refreshClusterProfiles(); } } });
    for (const slot of SLOTS) { const o = el('option', { value: slot }, 'HOST ' + slot); if (p && (p.defaultHostSlot || 'A') === slot) o.setAttribute('selected', 'selected'); hostSel.appendChild(o); }
    panel.appendChild(el('div', { class: 's1-row' }, el('span', { class: 'lbl' }, 'Cụm'), sel, hostSel, more));
    panel.appendChild(el('div', { class: 'note', id: 'cl-note' }, ''));
    // shared Link Game (one input for A/B/C).
    if (!p) { panel.appendChild(el('div', { class: 's1-row' }, el('span', { class: 'lbl' }, 'Link'), el('span', { class: 'note faint' }, 'Chọn/tạo một Cụm để nhập Link Game.'))); return panel; }
    const urlInput = el('input', { class: 'f', id: 'phq-gameurl', type: 'url', spellcheck: 'false', value: p.gameUrl || '', placeholder: 'https://game.example.com/room',
      onchange: async (e) => { const res = await api.clusterProfileUpdate(p.id, { gameUrl: (e.target.value || '').trim() || null }); await refreshClusterProfiles(); if (res && res.ok === false) glNote(errText(res), true); else { glNote('Đã lưu Link Game.'); renderApp(); } } });
    panel.appendChild(el('div', { class: 's1-row' }, el('span', { class: 'lbl' }, 'Link'), urlInput, localTest ? el('span', { class: 'pill warn' }, 'LOCAL') : null));
    panel.appendChild(el('div', { class: 'note', id: 'phq-glnote' }, ''));
    return panel;
  }

  // LEFT panel 2 — THIẾT BỊ VÀ PROXY ĐÃ GÁN: A/B/C display rows (NO proxy selector/Test).
  function panelAssigned() {
    const panel = el('div', { class: 's1-panel' }, el('div', { class: 's1-panel-t' }, 'THIẾT BỊ VÀ PROXY ĐÃ GÁN'));
    for (const slot of SLOTS) panel.appendChild(assignedRow(slot));
    return panel;
  }
  function assignedRow(slot) {
    const a = assign[slot];
    const saved = profiles[slot] || {};
    if (a.proxyRef == null && saved.proxyRef) a.proxyRef = saved.proxyRef;
    const dev = saved.device;
    const px = proxies.find((x) => x.id === a.proxyRef);
    const pxText = px ? `${px.protocol}://${px.host}:${px.port}` : 'Trực tiếp (không proxy)';
    // Proxy is OPTIONAL — a slot with no proxyRef renders DIRECT (not an error).
    const status = !a.proxyRef ? 'DIRECT' : a.testState;
    // §8/§13 — surface BOTH OS window + game viewport independently.
    const osTxt = dev ? (dev.osWindow || 'Desktop Window') : '';
    const devText = dev ? `${dev.name} · OS ${osTxt} · VP ${dev.resolution}` : '(chưa tạo)';
    return el('div', { class: 'prow s1', id: 'setup-' + slot },
      el('span', { class: 'slot-tag' }, slot),
      el('span', { class: 'ar-dev', title: dev ? devText : '(chưa tạo thiết bị)' },
        devText,
        el('button', { class: 'icon-btn', title: dev ? 'Sửa thiết bị' : 'Tạo thiết bị', onclick: () => openDeviceModal(slot) }, '✎')),
      el('span', { class: 'ar-px', title: pxText }, pxText),
      el('span', { class: 'badge ' + testBadge(status), title: a.ip ? ('IP ' + a.ip) : '' }, status),
    );
  }

  // RIGHT footer — Local Runtime Test + the SINGLE RUN GAME CTA (visible in the column).
  function footerRunGame() {
    const footer = el('div', { class: 's1-footer' });
    if (caps.devBypass) footer.appendChild(el('label', { class: 's1-localtest' },
      el('input', { type: 'checkbox', id: 'phq-localtest', checked: localTest ? 'checked' : null, onchange: (e) => { localTest = e.target.checked; renderApp(); } }),
      ' Local Runtime Test (about:blank)'));
    footer.appendChild(el('button', { class: 'btn primary cta-open', disabled: setupReady() ? null : true, onclick: openCluster }, 'RUN GAME — MỞ 3 TRÌNH DUYỆT'));
    if (!setupReady()) footer.appendChild(el('div', { class: 'warnrow s1-warn' }, setupReason()));
    return footer;
  }

  // ---- cluster profiles (saved configs) — minimal CRUD seam (§11) ----
  async function refreshClusterProfiles() {
    try { const r = await api.clusterProfileList(); clusterProfiles = (r && r.profiles) || []; selectedClusterProfileId = (r && r.selectedId) || null; }
    catch { clusterProfiles = []; selectedClusterProfileId = null; }
  }
  function clNote(msg, ok) { const n = $('cl-note'); if (n) { n.textContent = msg || ''; n.className = 'note' + (ok ? ' ok' : (msg ? ' warn' : '')); } }
  function currentClusterSlots() {
    const slots = {};
    for (const slot of SLOTS) { const prof = profiles[slot] || {}; slots[slot] = { browserProfileId: slot, deviceProfileId: prof.device ? prof.device.id : null, proxyRef: prof.proxyRef || null }; }
    return slots;
  }

  // §4B/§4C — one shared Link Game + HOST on the Cluster Profile. The exact URL is
  // reused by all three slots at RUN GAME; there are no per-slot URLs. NO stake here —
  // the stake is chosen only at Screen 2's TÌM BÀN step (§4D/§13).
  // Compact: one row — [Link] [url ................] [HOST select]. One shared URL for
  // A/B/C. NO stake here (stake is chosen only at Screen 2's TÌM BÀN).
  function glNote(msg, warn) { const n = $('phq-glnote'); if (n) { n.textContent = msg || ''; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }

  async function clusterProfileCreate() {
    const name = (window.prompt('Tên cấu hình cụm:', 'Cụm mới') || '').trim();
    if (!name) return;
    const gameUrl = (window.prompt('Game URL (http/https, để trống = DRAFT):', '') || '').trim();
    const res = await api.clusterProfileCreate({ name, gameUrl: gameUrl || null, defaultHostSlot: 'A', slots: currentClusterSlots() });
    await refreshClusterProfiles(); renderApp();
    clNote(res && res.ok ? `Đã tạo "${name}".` : ('Lỗi: ' + ((res && res.error && (res.error.message || res.error.code)) || 'không rõ')), res && res.ok);
  }
  async function clusterProfileEdit() {
    const id = selectedClusterProfileId; if (!id) return clNote('Hãy chọn một hồ sơ cụm trước.');
    const cur = clusterProfiles.find((p) => p.id === id) || {};
    const name = (window.prompt('Tên:', cur.name || '') || '').trim();
    if (!name) return;
    const gameUrl = (window.prompt('Game URL (trống = DRAFT):', cur.gameUrl || '') || '').trim();
    const hostSlot = (window.prompt('HOST slot (A/B/C):', cur.defaultHostSlot || 'A') || 'A').trim().toUpperCase();
    const res = await api.clusterProfileUpdate(id, { name, gameUrl: gameUrl || null, defaultHostSlot: hostSlot });
    await refreshClusterProfiles(); renderApp();
    clNote(res && res.ok ? 'Đã lưu.' : ('Lỗi: ' + ((res && res.error && (res.error.message || res.error.code)) || 'không rõ')), res && res.ok);
  }
  async function clusterProfileDuplicate() {
    const id = selectedClusterProfileId; if (!id) return clNote('Hãy chọn một hồ sơ cụm trước.');
    const newName = (window.prompt('Tên bản sao:', '') || '').trim();
    if (!newName) return;
    const res = await api.clusterProfileDuplicate(id, newName);
    await refreshClusterProfiles(); renderApp();
    clNote(res && res.ok ? `Đã nhân bản sang "${newName}".` : ('Lỗi: ' + ((res && res.error && (res.error.message || res.error.code)) || 'không rõ')), res && res.ok);
  }
  async function clusterProfileDelete() {
    const id = selectedClusterProfileId; if (!id) return clNote('Hãy chọn một hồ sơ cụm trước.');
    if (!window.confirm('Xóa hồ sơ cụm này?')) return;
    const res = await api.clusterProfileDelete(id);
    await refreshClusterProfiles(); renderApp();
    clNote(res && res.ok ? 'Đã xóa.' : ('Lỗi: ' + ((res && res.error && (res.error.message || res.error.code)) || 'không rõ')), res && res.ok);
  }

  // ---- Quick 3-proxy setup (§4) — protocol selector + 3-line textarea + atomic apply.
  // The parser/apply are AUTHORITATIVE in the main process; this only collects input and
  // renders typed results. The textarea is cleared after apply (it may hold credentials).
  function qpNote(msg, ok) { const n = $('qp-note'); if (n) { n.textContent = msg || ''; n.className = 'note' + (ok ? ' ok' : (msg ? ' warn' : '')); } }
  // §4F/§6 — three LABELED rows (A/B/C). Each row already KNOWS its slot (the A/B/C
  // label is the authoritative mapping), so the user never types an A=/B=/C= prefix.
  // Each row has its own protocol selector + a plain host|port[|user|pass] input.
  // RIGHT panel — THIẾT LẬP NHANH 3 PROXY: three slot-labeled rows (protocol + input) +
  // ÁP DỤNG / TEST. Returns the panel element (placed in the right grid column).
  function panelQuickProxy() {
    const panel = el('div', { class: 's1-panel qp-panel compact' });
    panel.appendChild(el('div', { class: 's1-panel-t' }, 'THIẾT LẬP NHANH 3 PROXY',
      el('span', { class: 'qp-hint' }, ' · chỉ nhập proxy, không cần A= B= C=')));
    for (const slot of SLOTS) {
      const proto = el('select', { class: 'sel qp-proto', id: 'qp-proto-' + slot, 'aria-label': 'Loại proxy ' + slot });
      for (const p of ['http', 'https', 'socks5', 'socks4']) proto.appendChild(el('option', { value: p }, p.toUpperCase()));
      const inp = el('input', { class: 'f qp-in', id: 'qp-in-' + slot, 'aria-label': 'Proxy ' + slot, placeholder: 'host|port|user|password' });
      panel.appendChild(el('div', { class: 'qp-row' }, el('span', { class: 'qp-slot' }, slot), proto, inp));
    }
    panel.appendChild(el('div', { class: 'qp-actions' },
      el('button', { class: 'btn primary sm', onclick: applyQuickProxies }, 'ÁP DỤNG 3 PROXY'),
      el('button', { class: 'btn sm', onclick: testAllProxies }, 'TEST TẤT CẢ'),
      el('span', { class: 'note', id: 'qp-note' }, ''),
    ));
    return panel;
  }
  async function applyQuickProxies() {
    // Proxy is OPTIONAL (§10): apply ONLY the rows that have input. Blank rows are left
    // as-is (they keep DIRECT or an existing binding). Never create an empty proxy.
    const rows = SLOTS.map((slot) => ({ slot, protocol: ($('qp-proto-' + slot) || {}).value || 'http', value: (($('qp-in-' + slot) || {}).value || '').trim() }))
      .filter((r) => r.value);
    if (!rows.length) { qpNote('Nhập proxy cho ít nhất một dòng (proxy là tuỳ chọn — bỏ trống = Trực tiếp).', false); return; }
    qpNote('Đang áp dụng…', true);
    let res;
    try { res = await api.proxyQuickApply({ rows, partial: true, clusterProfileId: selectedClusterProfileId || null }); }
    catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    if (!res || res.ok === false) { qpNote(errText(res), false); return; }
    try { const pl = await api.proxyList(); proxies = (pl && pl.proxies) || []; } catch {}
    try { const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x])); } catch {}
    await refreshClusterProfiles();
    for (const s of SLOTS) { if (res.refs && res.refs[s]) { assign[s].proxyRef = res.refs[s]; assign[s].testState = 'NOT_TESTED'; assign[s].ip = null; } }
    for (const s of SLOTS) { const el2 = $('qp-in-' + s); if (el2) el2.value = ''; } // never keep raw credentials in the DOM
    renderApp();
    qpNote('Đã áp dụng 3 proxy cho A/B/C.' + (res.clusterState ? ' Cụm: ' + res.clusterState : ''), true);
  }

  // A compact setup row for one slot: device + proxy only. No browser open, no seat/ready.
  // ONE compact row per slot: [A] [device · edit] [proxy select] [Test] [status] [⋯].
  // Add/Edit/Delete proxy live in the small ⋯ menu (or Quick Proxy). No tall panels, no
  // repeated "opens in a Chrome window" text, no seat, no per-profile open button.
  function testBadge(s) { return ({ PASS: 'good', DIRECT: 'faint', FAILED: 'bad', AUTH_FAILED: 'bad', TIMEOUT: 'warn', TESTING: 'warn' })[s] || 'faint'; }

  // RUN GAME readiness (§4/§5): proxy is OPTIONAL, so it is NEVER part of this gate.
  // Requires a selected Cluster Profile + a shared game URL + a device per slot. A slot
  // with no proxy simply runs DIRECT.
  function setupReady() {
    if (localTest) return true; // local runtime test opens about:blank
    if (!selectedClusterProfileId) return false;
    const prof = selectedProfile();
    if (!prof || !prof.gameUrl) return false;
    return SLOTS.every((s) => profiles[s] && profiles[s].device);
  }
  function setupReason() {
    if (localTest) return '';
    if (!selectedClusterProfileId) return 'Chọn một Cluster Profile trước khi mở.';
    const prof = selectedProfile();
    if (!prof || !prof.gameUrl) return 'Cần Link Game dùng chung hợp lệ.';
    if (!SLOTS.every((s) => profiles[s] && profiles[s].device)) return 'Mỗi hồ sơ A/B/C cần một thiết bị (proxy là tuỳ chọn).';
    return '';
  }

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
      // Explicit, separate credential-removal action (§5). Empty password NEVER means
      // "remove" — only this checkbox clears the stored username + password.
      existing && existing.hasAuth
        ? el('div', { class: 'phq-row' }, el('span', null, 'Xác thực'), el('label', { class: 'faint' }, el('input', { type: 'checkbox', id: 'px-removeauth' }), ' Xóa xác thực (username + password)'))
        : null,
      el('details', { class: 'adv' }, el('summary', null, 'Advanced'), el('div', { class: 'phq-row' }, el('span', null, 'Bypass'), f('px-bypass', 'a.com,b.com', existing && (existing.bypassList || []).join(',')))),
      el('div', { class: 'phq-row' },
        el('button', { class: 'btn primary', onclick: async () => {
          const quick = $('px-quick').value.trim();
          const removeAuth = !!($('px-removeauth') && $('px-removeauth').checked);
          const input = quick
            ? { id: editId || undefined, label: $('px-label').value.trim() || undefined, protocol: $('px-proto').value, input: quick, bypassList: $('px-bypass').value, removeAuth }
            : { id: editId || undefined, label: $('px-label').value.trim() || undefined, protocol: $('px-proto').value, host: $('px-host').value.trim(), port: Number($('px-port').value), username: $('px-user').value.trim() || null, password: $('px-pass').value || (existing ? undefined : null), bypassList: $('px-bypass').value, removeAuth };
          const res = await api.proxyUpsert(input);
          if (!res || !res.ok) { note(errText(res), true); return; }
          assign[slot].proxyRef = res.id; await api.profileUpsert(slot, { proxyRef: res.id });
          const pl = await api.proxyList(); proxies = (pl && pl.proxies) || [];
          const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x]));
          close(); renderApp();
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
    renderApp();
  }

  // Device modal — PHASE 6.2.4. A flexible profile builder with independent axes:
  // OS Window (Chromium native window on Windows) and Game Viewport (CDP device
  // emulation). Loại profile drives preset auto-fill; user can still edit every
  // field. Presets include Desktop / Laptop / Laptop Small / Mobile Landscape and
  // the mixed "Laptop Small · Mobile Ngang" (960×540 OS + 851×393 viewport).
  function openDeviceModal(slot) {
    const saved = profiles[slot] || {};
    const dev = saved.device || {};
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const ov = el('div', { class: 'phq-analyzer' });
    const close = () => ov.remove();
    // Group presets by profile type so users pick their intent first.
    const TYPE_LABELS = { DESKTOP: 'Desktop', LAPTOP: 'Laptop', LAPTOP_SMALL: 'Laptop nhỏ', MOBILE_LANDSCAPE: 'Mobile ngang', CUSTOM: 'Tuỳ chỉnh' };
    const typeSel = el('select', { class: 'sel', id: 'dev-ptype' });
    for (const t of ['DESKTOP', 'LAPTOP', 'LAPTOP_SMALL', 'MOBILE_LANDSCAPE', 'CUSTOM']) typeSel.appendChild(el('option', { value: t }, TYPE_LABELS[t]));
    typeSel.value = dev.profileType || 'MOBILE_LANDSCAPE';
    // Preset picker (filtered by profile type when possible; CUSTOM lists all).
    const presetSel = el('select', { class: 'sel', id: 'dev-preset' });
    function refreshPresetOptions() {
      const t = typeSel.value;
      presetSel.innerHTML = '';
      presetSel.appendChild(el('option', { value: '' }, '— tuỳ chỉnh —'));
      const filtered = t === 'CUSTOM' ? presets : presets.filter((p) => p.profileType === t);
      for (const p of filtered) {
        const osWin = (p.osWindowWidth && p.osWindowHeight) ? `${p.osWindowWidth}×${p.osWindowHeight}` : 'Desktop';
        const vp = `${p.viewportWidth}×${p.viewportHeight}`;
        presetSel.appendChild(el('option', { value: p.id }, `${p.name} · OS ${osWin} · VP ${vp}`));
      }
    }
    refreshPresetOptions();
    if (dev.presetId) presetSel.value = dev.presetId;
    // OS window + viewport + orientation + touch inputs.
    const nameInput = el('input', { class: 'f', id: 'dev-name', value: saved.name || ('Profile ' + slot) });
    const osW = el('input', { class: 'f', id: 'dev-osw', type: 'number', min: '1', value: dev.osWindowWidth || '' , placeholder: '(theo viewport + chrome)' });
    const osH = el('input', { class: 'f', id: 'dev-osh', type: 'number', min: '1', value: dev.osWindowHeight || '', placeholder: '' });
    const vpW = el('input', { class: 'f', id: 'dev-vpw', type: 'number', min: '1', value: dev.viewportWidth || 851 });
    const vpH = el('input', { class: 'f', id: 'dev-vph', type: 'number', min: '1', value: dev.viewportHeight || 393 });
    const dsf = el('input', { class: 'f', id: 'dev-dsf', type: 'number', min: '0.5', step: '0.05', value: dev.deviceScaleFactor || 1 });
    const orient = el('select', { class: 'sel', id: 'dev-orient' });
    for (const o of [{ v: 'landscapePrimary', t: 'Landscape' }, { v: 'portraitPrimary', t: 'Portrait' }]) orient.appendChild(el('option', { value: o.v, selected: (dev.orientationType || 'landscapePrimary') === o.v }, o.t));
    const touchSel = el('select', { class: 'sel', id: 'dev-touch' });
    for (const o of [{ v: 'true', t: 'Touch: ON' }, { v: 'false', t: 'Touch: OFF' }]) touchSel.appendChild(el('option', { value: o.v, selected: String(dev.touch === true) === o.v }, o.t));
    // Apply a preset: overwrites every editable field so users can iterate rapidly.
    function applyPreset(pid) {
      const p = presets.find((x) => x.id === pid); if (!p) return;
      nameInput.value = p.name;
      osW.value = p.osWindowWidth || '';
      osH.value = p.osWindowHeight || '';
      vpW.value = p.viewportWidth; vpH.value = p.viewportHeight;
      dsf.value = p.deviceScaleFactor;
      orient.value = p.orientationType || 'landscapePrimary';
      touchSel.value = String(p.touch === true);
    }
    presetSel.onchange = () => { if (presetSel.value) applyPreset(presetSel.value); };
    typeSel.onchange = () => { refreshPresetOptions(); if (presetSel.options.length > 1) { presetSel.selectedIndex = 1; applyPreset(presetSel.value); } };
    const preview = el('div', { class: 'note' });
    function renderPrev() {
      const oswv = osW.value ? Number(osW.value) : null, oshv = osH.value ? Number(osH.value) : null;
      const os = (oswv && oshv) ? `${oswv} × ${oshv}` : '(theo viewport + chrome)';
      preview.textContent = `OS Window: ${os} · Viewport: ${vpW.value} × ${vpH.value} · DSF ${dsf.value} · ${orient.value === 'landscapePrimary' ? 'Ngang' : 'Dọc'} · Touch: ${touchSel.value === 'true' ? 'BẬT' : 'TẮT'}`;
    }
    for (const inp of [osW, osH, vpW, vpH, dsf, orient, touchSel]) inp.onchange = renderPrev;
    const card = el('div', { class: 'anz-card' },
      el('div', { class: 'section-t' }, 'TẠO THIẾT BỊ'),
      el('div', { class: 'phq-row' }, el('span', null, 'Tên hồ sơ'), nameInput),
      el('div', { class: 'phq-row' }, el('span', null, 'Loại profile'), typeSel),
      el('div', { class: 'phq-row' }, el('span', null, 'Preset'), presetSel),
      el('div', { class: 'section-t' }, 'OS WINDOW (Chromium)'),
      el('div', { class: 'phq-row' }, el('span', null, 'Chiều rộng'), osW, el('span', null, 'Chiều cao'), osH),
      el('div', { class: 'section-t' }, 'GAME VIEWPORT (CDP)'),
      el('div', { class: 'phq-row' }, el('span', null, 'Chiều rộng'), vpW, el('span', null, 'Chiều cao'), vpH),
      el('div', { class: 'phq-row' }, el('span', null, 'DSF'), dsf, el('span', null, 'Orientation'), orient, el('span', null, 'Input'), touchSel),
      preview,
      el('div', { class: 'phq-row' },
        el('button', { class: 'btn primary', onclick: async () => {
          const pid = presetSel.value || null;
          const patch = {
            name: nameInput.value.trim(),
            device: {
              presetId: pid,
              profileType: typeSel.value,
              osWindowWidth: osW.value ? Number(osW.value) : null,
              osWindowHeight: osH.value ? Number(osH.value) : null,
              viewportWidth: Number(vpW.value),
              viewportHeight: Number(vpH.value),
              screenWidth: Number(vpW.value),
              screenHeight: Number(vpH.value),
              deviceScaleFactor: Number(dsf.value) || 1,
              orientationType: orient.value,
              touch: touchSel.value === 'true',
              mobile: touchSel.value === 'true',
              regenerate: !(dev.presetId && pid && dev.presetId === pid),
            },
          };
          const res = await api.profileUpsert(slot, patch);
          if (!res || !res.ok) { note(errText(res), true); return; }
          const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x]));
          close(); renderApp();
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
    assign[slot].testState = 'TESTING'; renderApp();
    const res = await api.proxyTest(ref);
    const r = res && res.result;
    assign[slot].testState = (r && r.state) || 'FAILED';
    assign[slot].ip = r && r.observedIp || null;
    renderApp();
  }

  // ================= SCREEN 2 — LIVE QA WORKSPACE =================
  // Compact status toolbar + minimal command toolbar + a LIVE QA MONITOR that fills
  // the rest. Followers/Ready/ReJoin run automatically (no manual buttons).
  // PHASE 6.2 — compact final Tool UI. The Tool is its own (4th) window; the three real Chromium windows
  // are separate. The main screen is a low header (BÀN/CÒN LẠI) + a SINGLE horizontal row of Browser
  // 1/2/3 controls + remaining cards. No username, no Host/Follower, no legacy entry toolbars/monitor
  // here (those functions stay defined for other flows/tests but are not rendered on the main screen).
  function renderControl(r) {
    r.appendChild(compactHeader());
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));
    r.appendChild(compactBrowserRow());
    r.appendChild(renderRemainingCards());
  }

  // Low header: product · shared BÀN (RID) · CƯỢC (stake) · CÒN LẠI · overflow menu · ready dot. BÀN and
  // CƯỢC are SERVER-DERIVED from the discovered table (never a user-entered stake — §8/§11/§12).
  function compactHeader() {
    const rid = manualCluster.sharedRid != null ? String(manualCluster.sharedRid) : '—';
    const stake = manualCluster.sharedStake != null ? String(manualCluster.sharedStake) : '—';
    const anyOpen = SLOTS.some((s) => assign[s].runId);
    return el('div', { class: 'tool-header' },
      el('b', { class: 'th-brand' }, 'PHỎM QA'),
      el('span', { class: 'th-rid' }, 'BÀN: ', el('b', null, rid)),
      el('span', { class: 'th-bet' }, 'CƯỢC: ', el('b', null, stake)),
      el('span', { class: 'th-still' }, 'CÒN LẠI: ', el('b', null, remaining ? (remaining.count + ' LÁ') : '—')),
      moreMenuButton(),
      el('span', { class: 'chip ' + (anyOpen ? 'green' : 'gray') }, anyOpen ? '● READY' : '○'),
    );
  }

  // A single horizontal row: Browser 1 / 2 / 3. One business action per card (VÀO GAME / TÌM BÀN / VÀO BÀN
  // / THOÁT GAME) + lifecycle controls (↻ WEB, ⏻). Deterministic slot A/B/C -> Browser 1/2/3.
  function compactBrowserRow() {
    const row = el('div', { class: 'browser-row' });
    SLOTS.forEach((slot, i) => row.appendChild(compactBrowserCell(i + 1, slot, assign[slot].runId)));
    return row;
  }
  function compactBrowserCell(index, slot, runId) {
    const cell = el('div', { class: 'browser-cell' });
    const cs = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot];
    const chromiumClosed = !!(cs && cs.browserState && cs.browserState !== 'OPEN' && cs.browserState !== 'NOT_OPEN');
    const opened = !!runId && !chromiumClosed;
    const inGame = opened && slotInPhom(runId);
    const mb = opened ? manualBrowserById(runId) : null;
    const b = mb || { profileId: runId, manualState: opened ? 'READY' : 'CLOSED', canRejoin: false, rid: null, lastError: null };
    const entering = opened && !inGame && !!manualEntering[runId];
    const joining = opened && inGame && !!manualJoining[runId];
    const enterErr = opened && !inGame && manualEnterError[runId];
    const dot = !runId ? '⚪' : (chromiumClosed ? '🔴' : ((b.manualState === 'SEARCHING' || entering || joining) ? '🟡' : (inGame ? '🟢' : '⚪')));
    cell.appendChild(el('div', { class: 'bc-line' }, el('span', { class: 'bl' }, 'B' + index + ' ', dot)));

    // primary business action (single button) — from authoritative state.
    if (!runId) { cell.appendChild(el('span', { class: 'faint sm' }, 'chưa mở')); return cell; }
    if (chromiumClosed) {
      cell.appendChild(el('span', { class: 'chip red sm' }, '● OFFLINE'));
      cell.appendChild(el('button', { class: 'btn primary sm', onclick: () => onReopenBrowser(slot) }, '＋ MỞ CHROMIUM'));
      return cell;
    }
    if (entering) cell.appendChild(el('span', { class: 'chip yellow sm' }, 'ĐANG VÀO GAME…'));
    else if (joining) cell.appendChild(el('span', { class: 'chip yellow sm' }, 'ĐANG VÀO BÀN…'));
    else {
      const act = MCS ? MCS.browserAction(manualCluster, b, { opened, inGame, entering: false }) : { action: 'ENTER_GAME', label: 'VÀO GAME' };
      cell.appendChild(actionButton(act, b, runId, inGame));
    }
    if (enterErr) cell.appendChild(el('span', { class: 'chip red sm', title: enterErr }, 'VÀO GAME THẤT BẠI'));
    if (opened && inGame && b.manualState === 'ERROR' && manualCluster.sharedRid != null && b.lastError) cell.appendChild(el('span', { class: 'chip red sm', title: errText({ error: b.lastError }) }, 'VÀO BÀN THẤT BẠI'));

    // lifecycle row: ↻ WEB (reload/re-open web in the SAME Chromium) + ⏻ (close this Chromium only).
    cell.appendChild(el('div', { class: 'bc-life' },
      el('button', { class: 'btn sm', title: 'Tải lại / mở lại web trong chính Chromium này', onclick: () => onReloadWeb(runId) }, '↻ WEB'),
      el('button', { class: 'btn danger sm', title: 'Tắt Chromium này (không đóng Tool/B khác)', onclick: () => onCloseBrowser(slot, runId) }, '⏻')));
    return cell;
  }
  // Build the single business-action button from the browserAction decision.
  function actionButton(act, b, runId, inGame) {
    if (act.busy) return el('span', { class: 'chip yellow sm' }, act.label);
    if (act.action === 'ENTER_GAME') return el('button', { class: 'btn primary sm', onclick: () => manualEnterGame(runId) }, act.label);
    if (act.action === 'FIND') return betFindGroup(b, runId, inGame); // PHASE 6.2.3 — real bet selector + TÌM BÀN
    if (act.action === 'JOIN_SHARED') return el('button', { class: 'btn primary sm', onclick: () => onManualJoinShared(b) }, act.label); // VÀO BÀN → shared RID
    if (act.action === 'LEAVE') return el('button', { class: 'btn danger sm', onclick: () => onManualLeave(b) }, act.label);       // THOÁT GAME
    return el('span', { class: 'faint sm' }, act.label);
  }
  // PHASE 6.2.3 — the finder's bet selector (REAL server stakes) + TÌM BÀN. The stake list comes from this
  // browser's own betOptions (distinct rs[].b); FIND is enabled only after a stake is chosen (§5/§11). No
  // manual number input, no hard-coded list. While a search is running, FIND is search-locked as before.
  function betFindGroup(b, runId, inGame) {
    const group = el('div', { class: 'bet-find' });
    const options = (b && Array.isArray(b.betOptions)) ? b.betOptions : [];
    if (!options.length) {
      group.appendChild(el('span', { class: 'chip yellow sm' }, 'CƯỢC: đang tải…'));
      group.appendChild(el('button', { class: 'btn sm', title: 'Tải lại danh sách mức cược', onclick: () => onRefreshBets(runId) }, '↻'));
      return group;
    }
    const selected = selectedStakeByBrowser[runId];
    // The TÌM BÀN button is created up-front; picking a stake enables it IN PLACE (no renderApp), so a
    // background re-render (2s poll / pushes) can never destroy the open dropdown mid-selection (bug fix).
    const findBtn = el('button', { class: 'btn primary sm', onclick: () => onManualFind(b) }, 'TÌM BÀN');
    const setEnabled = (val) => { findBtn.disabled = (!!MCS && MCS.canFind(manualCluster, b) && inGame && val != null) ? null : true; };
    const sel = el('select', { class: 'sel sm bet-sel', onchange: (e) => { const v = e.target.value ? Number(e.target.value) : null; selectedStakeByBrowser[runId] = v; setEnabled(v); } },
      el('option', { value: '' }, 'CƯỢC…'));
    for (const s of options) { const o = el('option', { value: String(s) }, String(s)); if (selected != null && Number(selected) === Number(s)) o.setAttribute('selected', 'selected'); sel.appendChild(o); }
    group.appendChild(sel);
    setEnabled(selected); // §11 — FIND needs a chosen stake
    group.appendChild(findBtn);
    return group;
  }
  // Reload the real bet options (re-request the channel list; the server re-sends rs[]).
  async function onRefreshBets(runId) {
    note('Đang tải mức cược…');
    try { await api.requestChannels(); } catch {}
    await refreshManual(); renderApp();
  }
  // VÀO BÀN — JOIN the shared RID (never a new discovery, §3/§4). Immediate ĐANG VÀO BÀN; confirmed by ps[].
  async function onManualJoinShared(b) {
    const rid = manualCluster.sharedRid;
    if (rid == null) return note('Chưa có bàn dùng chung.', true);
    manualJoining[b.profileId] = true; note(`Đang vào bàn ${rid}…`); renderApp();
    let res; try { res = await api.manualJoin(b.profileId, rid); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    if (MCS) manualCluster = MCS.onJoinResult(manualCluster, b.profileId, res);
    delete manualJoining[b.profileId];
    if (res && res.ok === false) note(errText(res), true);
    await refreshManual(); renderApp();
  }
  // ↻ WEB — reload the page in the SAME Chromium; if the page is gone, re-navigate. Never a new window (§6).
  // After reload the browser has LEFT the game, so we clear its local entry state + refresh: the tool
  // shows VÀO GAME again (backend also resets that browser's Phỏm context so slotInPhom goes false).
  async function onReloadWeb(runId) {
    note('Đang tải lại web…');
    let res; try { res = await api.reloadWeb(runId); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    delete manualEntering[runId]; delete manualEnterError[runId]; delete selectedStakeByBrowser[runId];
    if (manualEnterTimers[runId]) { clearTimeout(manualEnterTimers[runId]); manualEnterTimers[runId] = null; }
    await refreshManual();
    if (res && res.ok === false) note(errText(res), true); else note('Đã tải lại web — bấm VÀO GAME để vào lại.');
    renderApp();
  }
  // ⏻ — close ONLY this Chromium (Tool + other browsers untouched, §7).
  async function onCloseBrowser(slot, runId) {
    note('Đang tắt Chromium…');
    try { await api.closeBrowser(runId); } catch (e) { note(String(e && e.message || e), true); }
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    await refreshManual(); renderApp();
  }
  // ＋ MỞ CHROMIUM — reopen the closed browser with its own profile/proxy/device/geometry (clusterOpen only
  // reopens CLOSED slots; live browsers untouched). No auto-rejoin (§16).
  async function onReopenBrowser(slot) {
    note('Đang mở lại Chromium…');
    try { await api.clusterOpen(); } catch (e) { return note(errText(e), true); }
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    for (const s of SLOTS) { const p = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[s]; if (p && p.profileId) assign[s].runId = p.profileId; }
    await refreshManual(); renderApp();
  }
  // Per-browser VÀO GAME (§5/§6) — fires the VERIFIED vgcg_8 entry action on THAT run only, then WAITS
  // for real game evidence (slotInPhom). The cell shows ĐANG VÀO GAME immediately; it flips to ĐÃ VÀO
  // GAME only when the authoritative in-Phỏm signal arrives (cleared in refreshManual), else THẤT BẠI on
  // a bounded timeout. Never a fake success — FIND unlocks only on real slotInPhom evidence.
  async function manualEnterGame(runId) {
    if (!runId) return;
    manualEntering[runId] = true; delete manualEnterError[runId];
    note('Đang vào game Phỏm…'); renderApp(); // immediate ĐANG VÀO GAME before any await (§17)
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
  // Clear the transient VÀO GAME states once a browser is authoritatively in game (real evidence).
  function reconcileEnterStates() {
    for (const slot of SLOTS) {
      const runId = assign[slot].runId;
      if (runId && slotInPhom(runId)) { if (manualEntering[runId]) delete manualEntering[runId]; if (manualEnterError[runId]) delete manualEnterError[runId]; if (manualEnterTimers[runId]) { clearTimeout(manualEnterTimers[runId]); manualEnterTimers[runId] = null; } }
    }
  }

  // §16 — the entry gate's per-slot status (CHỜ LOGIN → ĐÃ LOGIN → ĐANG VÀO PHỎM → PHỎM READY),
  // shown until the whole cluster is PHỎM READY. Reflects state only; drives no automation.
  function entryStatusBar() {
    if (entryPhase === ENTRY.READY) return null;
    // Title + chips reflect the REAL per-run signal (socketReady/connected/uid/channelCount), not the
    // one-shot entryPhase — so a browser that is already logged in is shown as ĐÃ LOGIN immediately,
    // never stuck on "CHỜ LOGIN" (BUG #1).
    const inLobby = SLOTS.filter((sl) => slotInPhom(assign[sl].runId)).length;
    const loggedIn = SLOTS.filter((sl) => slotLoggedIn(assign[sl].runId)).length;
    const title = entryPhase === ENTRY.ENTERING ? 'ĐANG VÀO GAME PHỎM'
      : loggedIn === 3 ? 'ĐÃ LOGIN 3/3 — bấm “VÀO GAME PHỎM”'
      : `CHỜ ĐĂNG NHẬP (${loggedIn}/3 đã có phiên)`;
    const chips = el('div', { class: 'qa-chips' });
    for (const slot of SLOTS) {
      const runId = assign[slot].runId;
      let cls = 'gray', label = 'CHƯA MỞ';
      const cp = (clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot]) || {};
      const p = slotProfile(runId);
      if (cp.browserState && cp.browserState !== 'OPEN' && cp.browserState !== 'NOT_OPEN') { cls = 'red'; label = 'BROWSER LỖI'; }
      else if (!runId) { cls = 'gray'; label = 'CHƯA MỞ'; }
      else if (assign[slot].entryError) { cls = 'red'; label = 'LỖI VÀO PHỎM'; } // failure isolated to THIS slot; browser stays open
      else if (p && p.socketReady && p.connected && (p.channelCount || 0) > 0) { cls = 'green'; label = 'PHỎM READY'; }
      else if (p && p.socketReady && p.connected && p.uid != null) { cls = 'blue'; label = 'ĐÃ LOGIN'; }
      else if (p && p.socketReady && p.connected) { cls = 'yellow'; label = 'ĐANG VÀO PHỎM'; }
      else { cls = 'yellow'; label = 'CHỜ LOGIN'; }
      chips.appendChild(el('span', { class: 'chip ' + cls }, `${slot} · ${label}`));
    }
    return el('div', { class: 'qa-status' }, el('div', { class: 'section-t', style: 'margin:0 0 4px' }, title), chips);
  }

  // Map one slot to a compact chip {cls,text,detail}. HOST is ALWAYS orange (its label
  // still carries READY when ready); Ready=green, waiting=yellow, joined-pre-ready=blue,
  // kick/error/disconnect=red, not-opened=gray (§9).
  function slotStatus(slot, s, cs) {
    const cp = (cs.profiles && cs.profiles[slot]) || {};
    const sp = (s.profiles || []).find((p) => p.id === cp.profileId) || {};
    // A slot is "closed" for ANY terminal browserState (not just a user close). Each
    // reason renders a DISTINCT chip — a crash/unexpected exit is NEVER shown as ĐÃ ĐÓNG.
    const bs = cp.browserState;
    const closed = !!bs && bs !== 'OPEN' && bs !== 'NOT_OPEN';
    const opened = !!cp.profileId && !closed;
    const isHost = sp.role === 'HOST' || (s.hostId && s.hostId === cp.profileId);
    const st = sp.state;
    let cls = 'gray', label = 'CHƯA MỞ';
    if (closed) {
      const closeLabels = { CLOSED_BY_USER: 'ĐÃ ĐÓNG', CLOSED_BY_APP: 'ĐÃ ĐÓNG (APP)', CRASHED: 'SẬP', PROFILE_LOCK: 'KHOÁ HỒ SƠ', EXITED_UNEXPECTEDLY: 'THOÁT BẤT THƯỜNG' };
      const bad = (bs === 'CRASHED' || bs === 'EXITED_UNEXPECTEDLY' || bs === 'PROFILE_LOCK');
      cls = bad ? 'red' : 'gray';
      label = closeLabels[bs] || 'ĐÃ ĐÓNG';
    }
    else if (opened) {
      if (st === 'KICKED') { cls = 'red'; label = 'BỊ KICK'; }
      else if (st === 'REJOINING') { cls = 'red'; label = 'ĐANG VÀO LẠI'; }
      else if (st === 'ERROR' || st === 'DISCONNECTED' || st === 'LEFT') { cls = 'red'; label = st === 'DISCONNECTED' ? 'MẤT KẾT NỐI' : (st === 'LEFT' ? 'ĐÃ RỜI' : 'LỖI'); }
      else if (sp.ready) { cls = 'green'; label = 'READY'; }
      else if (st === 'MISMATCH') { cls = 'yellow'; label = 'SAI BÀN'; }
      else if (st === 'AT_TABLE') { cls = 'blue'; label = 'ĐÃ VÀO'; }
      else if (st === 'JOINING') { cls = 'blue'; label = 'ĐANG VÀO'; }
      // §7 — browser open but CDP not yet attached: a benign waiting state, NOT an error,
      // and it never closes the browser.
      else if (!cp.cdpConnected) { cls = 'yellow'; label = 'CDP CHƯA KẾT NỐI'; }
      else { cls = 'yellow'; label = 'CHỜ'; }
    }
    const text = isHost && !closed ? `${slot} · HOST${sp.ready ? ' · READY' : ''}` : `${slot} · ${label}`;
    const detail = { slot, profileId: cp.profileId || null, pid: cp.pid || null, cdp: cp.cdpPort || null,
      browserState: cp.browserState || (opened ? 'OPEN' : 'NOT_OPEN'), exitReason: cp.exitReason || null,
      cdpConnected: !!cp.cdpConnected, proxy: (profiles[slot] && profiles[slot].proxyRef) || null, ip: cp.observedIp || null,
      seat: sp.seat != null ? sp.seat : null, uid: sp.uid || null, state: st || (opened ? 'OPEN' : (bs || 'NOT_OPEN')) };
    return { cls: isHost && !closed ? 'orange' : cls, text, detail, isHost, closed };
  }

  function statusToolbar(s, cs) {
    const bar = el('div', { class: 'qa-status' });
    const chips = el('div', { class: 'qa-chips' });
    let anyClosed = false;
    for (const slot of SLOTS) {
      const st = slotStatus(slot, s, cs);
      const chip = el('span', { class: 'chip ' + st.cls, title: JSON.stringify(st.detail) }, st.text);
      chips.appendChild(chip);
      if (st.closed) anyClosed = true;
    }
    // §10 — if the user closed a browser, offer a targeted reopen (reuses that slot's saved
    // profile/device/proxy/user-data-dir); the other two browsers are never touched.
    if (anyClosed) chips.appendChild(el('button', { class: 'btn sm', title: 'Mở lại các slot đã đóng (không ảnh hưởng slot đang chạy)', onclick: () => reopenSlot('closed') }, 'MỞ LẠI'));
    bar.appendChild(chips);
    const rid = s.hostTableIdentity && s.hostTableIdentity.channelRid;
    const badges = el('div', { class: 'qa-badges' },
      el('span', { class: 'gbadge' }, rid != null ? ('BÀN ' + rid) : 'CHƯA CÓ BÀN'),
      el('span', { class: 'gbadge' }, (s.playerCount || 0) + (s.waitingFourth ? '/4' : (s.playerCount ? '/' + s.playerCount : '/4'))),
      el('span', { class: 'gbadge ' + (s.sameTable ? 'good' : '') }, s.sameTable ? 'CÙNG BÀN' : (s.tableVerdict || '—')),
      s.selectedStake ? el('span', { class: 'gbadge' }, 'CƯỢC ' + s.selectedStake) : el('span', { class: 'gbadge' }, 'CHƯA CHỌN CƯỢC'),
      el('span', { class: 'gbadge ' + (s.roundRunning ? 'live' : '') }, s.roundRunning ? 'VÁN ĐANG CHẠY' : 'VÁN CHỜ'),
    );
    bar.appendChild(badges);
    return bar;
  }

  // Progress label for the host-first discovery flow. Keys are the ACTUAL HostTableCoordinator
  // SESSION states (not the legacy symmetric names) so every stage of TÌM BÀN shows truthful,
  // authoritative feedback — never faked progress (§29/§45). Unmapped states fall through to ''.
  function autoFlowLabel(s) {
    const map = {
      IDLE: '', LOBBY_WAITING: '',
      HOST_SEARCHING: 'ĐANG TÌM BÀN…',
      HOST_JOIN_SENT: 'ĐANG VÀO BÀN ỨNG VIÊN…',
      HOST_WAITING_CONFIRMATION: 'ĐANG XÁC NHẬN BÀN (chờ ps[])…',
      HOST_VALIDATING: 'ĐANG XÁC NHẬN BÀN (chờ ps[])…',
      HOST_CANDIDATE_VALID: 'ĐÃ XÁC NHẬN BÀN — ĐANG ĐƯA B & C VÀO…',
      HOST_ACQUIRED: 'ĐÃ CÓ BÀN — ĐANG ĐƯA B & C VÀO…',
      FOLLOWERS_JOINING: 'ĐANG ĐƯA B & C VÀO BÀN…',
      VERIFYING_SAME_TABLE: 'ĐANG KIỂM TRA CÙNG BÀN…',
      PARTIAL_JOIN: 'ĐANG KIỂM TRA CÙNG BÀN…',
      SAME_TABLE: 'ĐÃ VÀO CÙNG BÀN',
      CONTROLLED_THREE_PRESENT: 'ĐÃ VÀO CÙNG BÀN',
      WAITING_AUTHORIZED_FOURTH: 'CÙNG BÀN — CHỜ NGƯỜI THỨ 4',
      TABLE_FULL: 'BÀN ĐỦ NGƯỜI — SẴN SÀNG',
      READY_3_OF_3: 'ĐÃ SẴN SÀNG',
      MONITORING: 'ĐANG THEO DÕI BÀN',
      C_REJOINING: 'ĐANG ĐƯA LẠI 1 ACC VÀO BÀN…',
      INVALID_TABLE: 'BÀN KHÔNG HỢP LỆ — TÌM LẠI…',
      RESTART_SEARCH: 'TÌM LẠI BÀN…',
      TABLE_MISMATCH: 'SAI BÀN — ĐANG SỬA…',
      LEAVING_TABLE: 'ĐANG RỜI BÀN…',
      HOST_ACQUIRE_FAILED: 'KHÔNG TÌM THẤY BÀN PHÙ HỢP',
      HOST_LOST: 'HOST MẤT BÀN', HOST_TABLE_LOST: 'HOST MẤT BÀN',
      REJOIN_EXHAUSTED: 'VÀO LẠI THẤT BẠI', STOPPED: '', STOPPING: 'ĐANG DỪNG…',
    };
    if (s && s.roundRunning) return 'VÁN ĐANG CHẠY';
    if (s && s.sameTable && (s.readyCount || 0) > 0 && s.waitingFourth) return 'CÙNG BÀN — CHỜ ĐỦ NGƯỜI';
    return (s && map[s.state] != null ? map[s.state] : '') || '';
  }

  function commandToolbar(s) {
    const hostLost = s && (s.state === 'HOST_LOST' || s.state === 'HOST_TABLE_LOST');
    const running = autoFlow;
    // §1-§4 — the primary CTA is DRIVEN BY THE ENTRY PHASE. Each step is an explicit user
    // action; TÌM BÀN is unavailable until the user has confirmed login AND entered Phỏm.
    // The primary CTA reflects the REAL live state (not a one-shot phase), so it stays usable across
    // repeated attempts and recovers after a logout/drop: in the Phỏm lobby -> TÌM BÀN; otherwise ->
    // (re)enter Phỏm. This fixes "chỉ dùng được lần đầu" and "logout -> không có nút vào lại".
    const ready = allInPhom();
    const inCount = SLOTS.filter((sl) => slotInPhom(assign[sl].runId)).length;
    let primary;
    if (entryPhase === ENTRY.ENTERING) {
      primary = el('button', { class: 'btn primary', disabled: true }, 'ĐANG VÀO GAME PHỎM…');
    } else if (ready) {
      // Only DISABLE while a search is running. Do NOT mute-disable for authorization/browser-count:
      // that made the button look dead. Those are checked on click and reported with a typed reason.
      primary = el('button', { class: 'btn primary', title: 'Mở hộp chọn mức cược rồi tự tìm bàn', disabled: running ? true : null, onclick: openFindTable }, running ? 'ĐANG CHẠY…' : 'TÌM BÀN · CHỌN CƯỢC');
    } else {
      primary = el('button', { class: 'btn primary', title: 'Đưa A/B/C vào game Phỏm (fires vgcg_8 cho slot chưa ở Phỏm)', onclick: enterPhom }, inCount > 0 ? 'VÀO LẠI GAME PHỎM' : 'VÀO GAME PHỎM');
    }
    const phaseChip = entryPhase === ENTRY.ENTERING ? el('span', { class: 'chip yellow', style: 'margin-left:6px' }, 'ĐANG VÀO GAME PHỎM')
      : ready ? el('span', { class: 'chip green', style: 'margin-left:6px' }, 'PHỎM READY')
      : el('span', { class: 'chip blue', style: 'margin-left:6px' }, `Ở PHỎM ${inCount}/3 — vào game`);
    return el('div', { class: 'qa-cmd' },
      primary,
      el('button', { class: 'btn', onclick: () => clusterFocus('A') }, 'Focus A'),
      el('button', { class: 'btn', onclick: () => clusterFocus('B') }, 'Focus B'),
      el('button', { class: 'btn', onclick: () => clusterFocus('C') }, 'Focus C'),
      moreMenuButton(),
      el('button', { class: 'btn danger', title: 'Dừng tự động hoá tìm bàn (KHÔNG đóng trình duyệt)', onclick: stopOrchestration }, 'DỪNG'),
      el('button', { class: 'btn', title: 'Huỷ mọi thao tác đang chạy và quay lại màn hình cấu hình (GIỮ trình duyệt đang mở)', onclick: returnToSetup }, 'QUAY VỀ SETUP'),
      phaseChip,
      hostLost ? el('span', { class: 'chip red', style: 'margin-left:6px' }, 'HOST MẤT BÀN — bấm TÌM BÀN') : null,
    );
  }

  // §2 — user confirms login on all three browsers. This ONLY advances the gate to the
  // VÀO GAME PHỎM step. It NEVER requests channels / acquires / joins / readies, and never
  // starts orchestration.
  function confirmLogin() {
    // Minimum precondition: all three browsers still open (never close on failure — §13).
    const bad = SLOTS.filter((sl) => { const p = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[sl]; return p && p.browserState && p.browserState !== 'OPEN'; });
    if (bad.length) { note('Các browser sau không còn mở: ' + bad.join(', ') + '. Hãy MỞ LẠI trước khi tiếp tục.', true); return; }
    entryPhase = ENTRY.CONFIRMED;
    note('Đã xác nhận đăng nhập. Bấm “VÀO GAME PHỎM” để đưa A/B/C vào game.');
    renderApp();
  }

  // §1-§5 — VÀO GAME PHỎM. A distinct, explicit step that triggers the VERIFIED Phỏm entry action
  // id `vgcg_8` through the site's OWN in-engine mechanism (the same one Aviator uses): the tool
  // fires the NewLobby Cocos tile node named `vgcg_8`'s wired cc.Button on A/B/C. It performs NO
  // guessed navigation/URL/selector and sends NO protocol frame. Then it WAITS for the authoritative
  // in-Phỏm signal (socket ready + game uid) on ALL three before unlocking TÌM BÀN — firing the
  // action is NEVER treated as PHỎM READY.
  let entryTimer = null;
  async function enterPhom() {
    const runIds = SLOTS.map((sl) => assign[sl].runId).filter(Boolean);
    if (runIds.length !== 3) { note('Cần mở đủ 3 browser trước.', true); return; }
    const bad = SLOTS.filter((sl) => { const p = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[sl]; return p && p.browserState && p.browserState !== 'OPEN'; });
    if (bad.length) { note('Browser chưa sẵn sàng: ' + bad.join(', ') + '.', true); return; }
    const prof = selectedProfile();
    const hostSlot = (prof && prof.defaultHostSlot) || 'A';
    const host = (assign[hostSlot] && assign[hostSlot].runId) || runIds[0];
    hostId = host;
    for (const sl of SLOTS) assign[sl].entryError = null;
    entryPhase = ENTRY.ENTERING; entrySub = ESUB.ENTERING_ACTION; renderApp();
    // (1) passive session — start at most once; reuse on re-entry (never re-create → keeps ctx).
    if (!phomSessionStarted) {
      const start = await api.startSession({ runIds, hostId: host });
      if (start && start.ok === false) { entryPhase = ENTRY.CONFIRMED; note(errText(start), true); return; }
      phomSessionStarted = true;
    }
    armEntryTimeout();
    // (2) trigger the verified `vgcg_8` entry action on each browser (fires the game's own tile).
    // Per-slot failure is isolated (records entryError on THAT slot; other browsers untouched, none
    // closed). A failed resolve means the Phỏm tile wasn't on the lobby — the user finishes manually.
    note('Đang vào game Phỏm (action vgcg_8)… chờ tín hiệu game.');
    for (const sl of SLOTS) {
      const runId = assign[sl].runId; if (!runId) continue;
      if (slotInPhom(runId)) continue; // already in the Phỏm lobby — don't disturb it
      try { const r = await api.enterGame(runId); if (r && r.ok === false) assign[sl].entryError = errText(r); }
      catch (e) { assign[sl].entryError = String(e && e.message || e); }
    }
    refresh();
  }

  // §12 — bounded entry wait. On timeout we leave everything intact (no teardown, no reset);
  // just a friendly message; the browsers stay open so the user can retry / finish manually.
  function armEntryTimeout() {
    if (entryTimer) { clearTimeout(entryTimer); entryTimer = null; }
    entryTimer = setTimeout(() => {
      entryTimer = null;
      if (entryPhase === ENTRY.ENTERING) {
        // Don't hang on "ĐANG VÀO…": revert so the (re)enter button is usable again (e.g. a browser
        // was logged out and needs manual re-login before vgcg_8 can enter Phỏm).
        entryPhase = ENTRY.CONFIRMED;
        note('PHOM_ENTRY_TIMEOUT — chưa vào được Phỏm. Nếu browser bị logout hãy đăng nhập lại rồi bấm VÀO GAME PHỎM.', true);
        renderApp();
      }
    }, 30000);
  }

  // Authoritative "in Phỏm" signal from the game's OWN frames (never fabricated): a slot has
  // entered the Phỏm game when its socket is ready AND the game assigned it a uid. All three
  // must satisfy this before TÌM BÀN unlocks; otherwise the gate stays in ĐANG VÀO GAME PHỎM.
  function slotProfile(runId) { return (session && session.profiles || []).find((x) => x.id === runId) || null; }
  // Authoritative "has a valid Phỏm session" signal (BUG #1): the game socket is bound + connected
  // AND the game assigned a uid. This is proven from the run's OWN frames — never fabricated, never a
  // process-alive assumption — and is detected as soon as those frames arrive (no fixed timeout).
  function slotLoggedIn(runId) { const p = slotProfile(runId); return !!(p && p.socketReady && p.connected && p.uid != null); }
  // In the PHỎM LOBBY = logged in AND the stake channel list has arrived (channelCount > 0). The
  // channel list only arrives in the Phỏm lobby, so this gates TÌM BÀN (a stake list must exist).
  function slotInPhom(runId) { const p = slotProfile(runId); return !!(p && p.socketReady && p.connected && (p.channelCount || 0) > 0); }
  function allLoggedIn() { const ids = SLOTS.map((sl) => assign[sl].runId).filter(Boolean); return ids.length === 3 && ids.every(slotLoggedIn); }
  function allInPhom() {
    const runIds = SLOTS.map((sl) => assign[sl].runId).filter(Boolean);
    return runIds.length === 3 && runIds.every(slotInPhom);
  }
  // Called from the session subscription: promote ENTERING → READY only on the authoritative
  // 3/3 in-Phỏm signal. Never auto-advances past READY (TÌM BÀN stays a user action).
  function reconcileEntryPhase() {
    // Track the REAL 3/3 in-Phỏm signal both ways (auto-detect + recover): advance to READY when all
    // three are in the Phỏm lobby; revert out of READY when a slot drops/logs out so the (re)enter CTA
    // reappears. socketReady+channelList is authoritative (not fakeable); no manual clicks required.
    if (allInPhom()) {
      if (entryPhase !== ENTRY.READY) {
        entryPhase = ENTRY.READY; entrySub = null;
        if (entryTimer) { clearTimeout(entryTimer); entryTimer = null; }
        note('A/B/C đã vào game Phỏm. Có thể bấm “TÌM BÀN · CHỌN CƯỢC”.');
      }
    } else if (entryPhase === ENTRY.READY) {
      entryPhase = ENTRY.CONFIRMED; // a slot left Phỏm — allow (re)enter
    }
  }

  // The overflow "⋯" menu keeps rarely-used / advanced actions off the main toolbar.
  function moreMenuButton() {
    const menu = el('div', { class: 'qa-more-menu', hidden: 'hidden' },
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); step(() => api.restoreLayout(), 'Đã xếp lại bố cục.')(); } }, 'Xếp lại bố cục'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); step(() => api.leaveAll(), 'Đã rời bàn.')(); } }, 'Rời bàn'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); openSimulator(); } }, 'Mô phỏng Offline (QA)'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); openAnalyzer(); } }, 'Phân tích luật Offline'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); toggleAdvancedDebug(); } }, 'Advanced Debug'),
      // The ONLY UI action that closes the browsers (explicit + confirmed) — DỪNG never does.
      el('button', { class: 'menu-item danger', onclick: (e) => { closeMore(e); closeBrowsers(); } }, 'ĐÓNG 3 TRÌNH DUYỆT'),
    );
    const wrap = el('div', { class: 'qa-more' },
      el('button', { class: 'btn', onclick: () => { menu.hidden = !menu.hidden; } }, '⋯'),
      menu,
    );
    function closeMore() { menu.hidden = true; }
    return wrap;
  }
  function toggleAdvancedDebug() {
    let box = $('phq-advdebug');
    if (box) { box.remove(); return; }
    box = el('div', { id: 'phq-advdebug', class: 'adv-debug' },
      el('div', { class: 'section-t' }, 'ADVANCED DEBUG (session snapshot)'),
      el('pre', null, session ? JSON.stringify(session, null, 2) : '(chưa có phiên)'));
    const root = $('phq-root'); if (root) root.appendChild(box);
  }

  // ---- Screen-2 monitor. Two DISTINCT, non-overlapping source modes (never ambiguous):
  //   LIVE_INTERNAL (default) — the LIVE QA MONITOR. Shows ONLY live internal A/B/C data
  //     (each frame updates its OWN owning profile; no cross-profile copy, no fabrication).
  //     Before a live round arrives it shows a truthful WAITING state — no cards, no x/y,
  //     no playback controls, and NEVER the bundled D fixture.
  //   FIXTURE_REPLAY — the simulated D engine + playback. Opens ONLY on explicit user
  //     selection from the ⋯ menu; it is never an automatic fallback for empty live data.
  function liveMonitor() {
    const mon = el('div', { class: 'qa-monitor', id: 'phq-monitor' });
    if (monitorMode === MON.REPLAY) { qaMonitorEnsure(); renderReplayMonitorInto(mon); }
    else renderLiveMonitorInto(mon);
    return mon;
  }

  // Which live connection state Screen 2 is in (derived from the cluster/session — never
  // simulated). CONNECTING / WAITING ROUND / LIVE / STALE / ERROR.
  function liveConnState() {
    const cs = clusterSnap || {};
    const anyBad = SLOTS.some((s) => { const p = cs.profiles && cs.profiles[s]; return p && (p.browserState === 'CRASHED' || p.browserState === 'EXITED_UNEXPECTEDLY' || p.browserState === 'PROFILE_LOCK'); });
    if (anyBad) return 'ERROR';
    if (!clusterIsOpen()) return 'CONNECTING';
    if ((cs.connectedCount || 0) < 1) return 'CONNECTING';
    const s = session || {};
    if (s.roundRunning) return 'LIVE';
    return 'WAITING_ROUND';
  }
  const LIVE_BADGE = { CONNECTING: 'LIVE INTERNAL · CHƯA KẾT NỐI', WAITING_ROUND: 'LIVE INTERNAL · CHỜ VÁN', LIVE: 'LIVE INTERNAL · TRỰC TIẾP', STALE: 'LIVE INTERNAL · CŨ', ERROR: 'LIVE INTERNAL · LỖI' };

  // The AUTHORITATIVE live hand actually received by ONE internal slot (A/B/C). Returns
  // null when there is no authoritative hand for that slot — the caller shows UNKNOWN and
  // NEVER falls back to the D sample or fabricates cards (§E).
  function liveHandForSlot(slot) {
    const cp = (clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot]) || {};
    if (!cp.profileId) return null;
    const h = (hands || []).find((x) => x.profileId === cp.profileId) || null;
    return h && h.authoritative ? h : null;
  }

  function renderLiveMonitorInto(mon) {
    if (!mon) return;
    mon.replaceChildren();
    const s = session || {};
    const conn = liveConnState();
    const hasRound = conn === 'LIVE' && !!(s.hostTableIdentity && s.hostTableIdentity.channelRid != null);
    const banner = el('div', { class: 'qa-mon-banner qa-live' },
      el('span', { class: 'mon-dot ' + (conn === 'LIVE' ? 'live' : '') }), ' LIVE QA MONITOR',
      el('span', { class: 'mon-srcbadge live' }, LIVE_BADGE[conn] || LIVE_BADGE.CONNECTING),
      el('span', { class: 'mon-src' }, 'chỉ dữ liệu nội bộ A/B/C — không mô phỏng'));
    mon.appendChild(banner);
    // Source picker lives on the LIVE monitor too (explicit switch to REPLAY).
    mon.appendChild(el('div', { class: 'mon-srcpick' },
      el('span', { class: 'faint sm' }, 'Nguồn: '),
      el('span', { class: 'gbadge good' }, 'LIVE INTERNAL'),
      el('button', { class: 'btn sm', title: 'Mở chế độ MÔ PHỎNG / REPLAY (dữ liệu D mô phỏng, không phải live)', onclick: () => setMonitorMode(MON.REPLAY) }, 'MÔ PHỎNG / REPLAY')));
    if (!hasRound) {
      // Truthful WAITING state — no cards, no x/y, no playback (§C).
      mon.appendChild(el('div', { class: 'mon-wait' },
        el('div', { class: 'section-t' }, 'ĐANG CHỜ DỮ LIỆU LIVE'),
        el('div', { class: 'faint' }, 'Chưa nhận được ván'),
        el('div', { class: 'mon-live-row' }, el('span', { class: 'slot-tag' }, '1'), cardRow([], {}, {})),
        el('div', { class: 'mon-live-row' }, el('span', { class: 'slot-tag' }, '2'), cardRow([], {}, {}))));
      return;
    }
    // A live round exists: per-owning-profile rows. Each slot shows ONLY the hand IT
    // received (authoritative), else UNKNOWN — never another profile's hand, never D.
    mon.appendChild(el('div', { class: 'note faint sm' },
      `Ván ${s.hostTableIdentity.channelRid} · cập nhật ${liveUpdatedLabel(s)} · trạng thái ${conn}`));
    for (const slot of SLOTS) {
      const h = liveHandForSlot(slot);
      const row = el('div', { class: 'mon-live-row' }, el('span', { class: 'slot-tag' }, slot));
      if (!h) { row.appendChild(el('span', { class: 'gbadge' }, 'UNKNOWN')); row.appendChild(el('span', { class: 'faint sm' }, ' chưa có bài xác thực cho slot này')); }
      else {
        const labels = Object.fromEntries((h.decoded || []).map((d) => [d.code, d]));
        const order = (h.sortedCards && h.sortedCards.length) ? h.sortedCards : (h.cards || []);
        row.appendChild(cardRow(order, labels, {}));
        row.appendChild(el('span', { class: 'faint sm' }, ` ${h.cardCount || order.length} lá · ${h.syncState || 'LIVE'}`));
      }
      mon.appendChild(row);
    }
  }
  function liveUpdatedLabel(s) {
    let latest = 0; for (const h of (hands || [])) if (h.updatedAt && h.updatedAt > latest) latest = h.updatedAt;
    if (!latest) return '—';
    try { return new Date(latest).toLocaleTimeString(); } catch { return String(latest); }
  }

  // Explicit source switch. LIVE → REPLAY loads the fixture; REPLAY → LIVE clears the
  // simulated snapshot + stops playback so no simulated card ever lingers on the LIVE view.
  function setMonitorMode(mode) {
    if (mode === monitorMode) return;
    monitorMode = mode === MON.REPLAY ? MON.REPLAY : MON.LIVE;
    if (monitorMode === MON.LIVE) { qaMonitorPlay(false); qaSnap = null; }
    renderApp();
  }

  // FIXTURE/REPLAY monitor (explicit MÔ PHỎNG mode only). Simulated player D on
  // fixture/replay data — playback + Sự kiện x/y allowed here, NEVER a LIVE badge.
  function renderReplayMonitorInto(mon) {
    if (!mon) return;
    const snap = qaSnap;
    mon.replaceChildren();
    const banner = el('div', { class: 'qa-mon-banner qa-rule' },
      el('span', { class: 'mon-dot' }), ' MÔ PHỎNG / REPLAY',
      el('span', { class: 'mon-srcbadge replay' }, 'D — MÔ PHỎNG'),
      el('span', { class: 'mon-src' }, 'dữ liệu fixture/replay — KHÔNG phải live'));
    mon.appendChild(banner);
    mon.appendChild(el('div', { class: 'mon-srcpick' },
      el('span', { class: 'faint sm' }, 'Nguồn: '),
      el('span', { class: 'gbadge warn' }, 'D — MÔ PHỎNG'),
      el('button', { class: 'btn sm', title: 'Quay lại LIVE QA MONITOR (dữ liệu nội bộ A/B/C)', onclick: () => setMonitorMode(MON.LIVE) }, 'VỀ LIVE')));
    if (!snap || snap.ok === false) { mon.appendChild(el('div', { class: 'note faint' }, snap && snap.error ? (snap.error.code + ': ' + snap.error.message) : 'Đang nạp dữ liệu D mô phỏng…')); return; }
    const labels = snap.labels || {};
    const authoritative = snap.authoritative === true;
    // ROW 1 cards come straight from the engine (complement of the union of derived melds);
    // the renderer never recomputes or hard-codes the card set.
    const notInMeld = snap.cardsNotInMeld || [];
    // ROW 1 — cards not forming a phỏm
    const row1 = el('div', { class: 'mon-row2 mon-drow' });
    row1.appendChild(el('div', { class: 'mon-drow-h' }, el('div', { class: 'section-t' }, 'ROW 1 · CÁC LÁ D KHÔNG TẠO PHỎM'), el('span', { class: 'gbadge' }, (authoritative ? notInMeld.length + ' LÁ' : 'CHƯA ĐỦ DỮ LIỆU'))));
    row1.appendChild(cardRow(authoritative ? notInMeld : [], labels, {}));
    row1.appendChild(el('div', { class: 'faint sm' }, authoritative ? 'Kết quả kiểm thử luật trên hand D mô phỏng authoritative.' : 'CHƯA ĐỦ DỮ LIỆU — hand D mô phỏng chưa authoritative (UNKNOWN, không tạo lá giả).'));
    mon.appendChild(row1);
    // ROW 2 — phỏm melds D can form
    const row2 = el('div', { class: 'mon-row2 mon-drow' });
    row2.appendChild(el('div', { class: 'mon-drow-h' }, el('div', { class: 'section-t' }, 'ROW 2 · CÁC KẾT PHỎM D CÓ THỂ TẠO'), el('span', { class: 'gbadge' }, (authoritative ? snap.derivedMelds.length + ' PHỎM' : 'CHƯA ĐỦ DỮ LIỆU'))));
    if (!authoritative || !snap.derivedMelds.length) row2.appendChild(el('div', { class: 'faint' }, authoritative ? '(chưa có phỏm)' : 'CHƯA ĐỦ DỮ LIỆU'));
    for (const m of snap.derivedMelds) {
      const label = m.type === 'RUN' ? 'Phỏm dây cùng chất' : (m.type === 'SET' ? 'Phỏm bộ cùng rank' : 'Phỏm');
      row2.appendChild(el('div', { class: 'mon-meld' }, cardRow(m.cards, labels, { meld: true }), el('span', { class: 'faint' }, ' ' + label)));
    }
    mon.appendChild(row2);
    // compact playback strip + event counter (controls off the main toolbar — §21)
    mon.appendChild(el('div', { class: 'qa-mon-controls' },
      el('span', { class: 'faint' }, `Sự kiện ${snap.counters.currentEvent}/${snap.counters.totalEvents} · ${snap.roundIdentity || '—'}`),
      el('button', { class: 'btn', onclick: () => qaMonitorPlay(true) }, '▶'),
      el('button', { class: 'btn', onclick: () => qaMonitorPlay(false) }, '⏸'),
      el('button', { class: 'btn', onclick: () => qaMonitorStep('previous') }, '⏮'),
      el('button', { class: 'btn', onclick: () => qaMonitorStep('next') }, '⏭'),
      el('button', { class: 'btn', onclick: () => qaMonitorStep('reset') }, '⟲'),
    ));
  }

  function cardRow(codes, labels, opts) {
    const wrap = el('div', { class: 'cards' });
    if (!codes.length) { wrap.appendChild(el('span', { class: 'faint' }, '—')); return wrap; }
    for (const code of codes) {
      const d = labels[code] || {};
      const cls = ['card-face', (SUIT_RED.has(d.suit) ? 'red' : 'black')];
      if (opts && opts.meld) cls.push('meld');
      wrap.appendChild(el('span', { class: cls.join(' ') }, el('b', null, d.rank || '?'), el('span', null, d.suit || '?')));
    }
    return wrap;
  }

  // fixture-driven qa monitor lifecycle (independent of the live subscription).
  async function qaMonitorEnsure() {
    if (qaSnap || qaLoading) return;
    qaLoading = true;
    try { qaSnap = await api.qaMonitorLoad({ datasetId: 'basic-round' }); } catch (e) { qaSnap = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    qaLoading = false;
    refreshMonitor();
    if (qaPlaying) qaScheduleTick();
    else qaMonitorPlay(true); // auto-play so the two rows update event-by-event
  }
  function qaScheduleTick() { if (qaTimer) clearTimeout(qaTimer); qaTimer = setTimeout(qaTick, qaSpeed); }
  async function qaTick() {
    if (!qaPlaying || uiState !== UI.CONTROL || monitorMode !== MON.REPLAY) { qaPlaying = false; return; }
    if (qaSnap && qaSnap.counters && qaSnap.counters.currentEvent >= qaSnap.counters.totalEvents) { qaSnap = await api.qaMonitorControl('reset'); }
    else { qaSnap = await api.qaMonitorControl('next'); }
    refreshMonitor();
    if (qaPlaying) qaScheduleTick();
  }
  function qaMonitorPlay(on) { qaPlaying = !!on; if (qaTimer) { clearTimeout(qaTimer); qaTimer = null; } if (on) qaScheduleTick(); }
  async function qaMonitorStep(action) { qaMonitorPlay(false); qaSnap = await api.qaMonitorControl(action); refreshMonitor(); }
  function refreshMonitor() { const mon = $('phq-monitor'); if (!mon) return; if (monitorMode === MON.REPLAY) renderReplayMonitorInto(mon); else renderLiveMonitorInto(mon); }

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

  // Offline REALTIME simulator (§7-§11) — event-by-event replay of a redacted/fixture
  // dataset. Every player is SIMULATED; network is LOCKED; no browser is connected.
  // Refused (in the domain) whenever any live run / session / cluster exists.
  async function openSimulator() {
    let ds = {}; try { ds = await api.simDatasets(); } catch { ds = {}; }
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const overlay = el('div', { class: 'phq-analyzer' });
    let playing = false, timer = null;
    const close = () => { playing = false; if (timer) clearTimeout(timer); overlay.remove(); };
    const card = el('div', { class: 'anz-card sim-card' });
    card.appendChild(el('div', { class: 'dev-banner' }, 'SIMULATOR / QA OFFLINE'));
    card.appendChild(el('div', { class: 'note' }, 'Mạng: ĐÃ KHÓA · Browser: KHÔNG KẾT NỐI · Mọi người chơi đều là SIMULATED'));
    if (!ds.available) {
      card.appendChild(el('div', { class: 'warnrow' }, 'Không chạy được khi còn phiên/live browser/cluster (PHOM_ANALYZER_OFFLINE_ONLY). Hãy Dừng/đóng browser trước.'));
      card.appendChild(el('button', { class: 'btn', onclick: close }, 'Đóng'));
      overlay.appendChild(card); document.body.appendChild(overlay); return;
    }

    let snap = null, speedMs = 800;
    const datasets = (ds.datasets || []);
    const sel = el('select', { class: 'sim-select' });
    for (const d of datasets) sel.appendChild(el('option', { value: d.id }, `${d.name} · ${d.sourceKind} · ${d.eventCount} sự kiện`));

    const countersBar = el('div', { class: 'sim-counters' });
    const timelineBox = el('div', { class: 'sim-timeline' });
    const handBox = el('div', { class: 'sim-hand' });
    const meldBox = el('div', { class: 'sim-melds' });
    const publicBox = el('div', { class: 'sim-public' });
    const warnBox = el('div', { class: 'sim-warn' });
    const fmt = (codes) => (codes || []).map((c) => (snap && snap.labels && snap.labels[c] ? snap.labels[c].label : String(c))).join(' ') || '—';

    const counter = (label, value, cls) => el('div', { class: 'sim-counter ' + (cls || '') }, el('span', { class: 'sim-cval' }, String(value)), el('span', { class: 'sim-clbl' }, label));

    function render() {
      if (!snap || snap.ok === false) { countersBar.replaceChildren(el('div', { class: 'warnrow' }, snap && snap.error ? (snap.error.code + ': ' + snap.error.message) : '(chưa nạp dataset)')); return; }
      const c = snap.counters;
      countersBar.replaceChildren(
        counter('Sự kiện', `${c.currentEvent}/${c.totalEvents}`, 'accent'),
        counter('Ván', snap.roundIdentity || '—'),
        counter('Bài (auth)', c.authoritativeHandCount),
        counter('Server meld', c.serverMeldCount, 'server'),
        counter('Derived meld', c.derivedMeldCount, 'derived'),
        counter('Lá meld (unique)', c.uniqueMeldCardCount),
        counter('Tổ hợp meld', c.meldCombinationCount),
        counter('Ăn được', c.eatableCount, 'eat'),
        counter('Không ăn', c.notEatableCount),
        counter('Chưa rõ', c.unknownCount, 'unknown'),
        counter('Lá chưa biết', c.unknownCardCount),
        counter('Lỗi nhất quán', c.consistencyErrorCount, c.consistencyErrorCount ? 'err' : ''),
      );
      const cardsEl = el('div', { class: 'cards' });
      const meldSet = new Set(snap.serverMelds.flatMap((m) => m.cards));
      if (!snap.hand.decoded.length) cardsEl.appendChild(el('span', { class: 'faint' }, snap.authoritative ? '(rỗng)' : 'Chưa có bài xác thực'));
      for (const d of snap.hand.decoded) cardsEl.appendChild(el('span', { class: 'card-face ' + (SUIT_RED.has(d.suit) ? 'red' : 'black') + (meldSet.has(d.code) ? ' meld' : '') }, el('b', null, d.rank), el('span', null, d.suit)));
      handBox.replaceChildren(el('div', { class: 'section-t' }, `BÀI NGƯỜI CHƠI (SIMULATED · ${snap.simulatedOwnerUid || '—'}) · ${snap.syncState}`), cardsEl);
      const meldLines = [];
      snap.serverMelds.forEach((m) => meldLines.push(el('div', null, el('span', { class: 'tag server' }, 'SERVER'), ' ' + fmt(m.cards))));
      snap.derivedMelds.forEach((m) => meldLines.push(el('div', null, el('span', { class: 'tag derived' }, 'DERIVED'), ` ${m.type} ` + fmt(m.cards))));
      meldBox.replaceChildren(el('div', { class: 'section-t' }, 'MELDS'), meldLines.length ? el('div', null, ...meldLines) : el('div', { class: 'faint' }, '(chưa có)'));
      const pub = [];
      pub.push(el('div', null, el('b', null, 'Bài đánh (public): '), snap.publicDiscards.length ? fmt(snap.publicDiscards.map((d) => d.card)) : '—'));
      if (snap.publicMelds.length) pub.push(el('div', null, el('b', null, 'Public meld: '), snap.publicMelds.map((m) => fmt(m.cards)).join('  ')));
      if (snap.eatCandidates.length) {
        const ec = el('div', null, el('b', null, 'Ứng viên ăn: '));
        for (const cand of snap.eatCandidates) ec.appendChild(el('span', { class: 'eat-cand ' + cand.status.toLowerCase().replace(/_/g, '-') }, fmt([cand.card]) + ' · ' + cand.status + '  '));
        pub.push(ec);
      }
      publicBox.replaceChildren(el('div', { class: 'section-t' }, 'CÔNG KHAI & ĂN'), ...pub);
      const tl = el('div', { class: 'tl-row' });
      for (const t of snap.timeline) tl.appendChild(el('span', { class: 'tl-ev cmd-' + (t.cmd || 'x') + (t.index < snap.cursor ? ' done' : '') + (t.index === snap.cursor - 1 ? ' cur' : '') + (t.duplicateOrLate ? ' dup' : ''), title: `${t.label} seq=${t.seq} ${t.reason}` }, String(t.cmd || '?')));
      timelineBox.replaceChildren(el('div', { class: 'section-t' }, 'TIMELINE 850–854'), tl);
      warnBox.replaceChildren(...(snap.consistency.warnings || []).map((w) => el('div', { class: 'warnrow' }, '⚠ ' + w)));
    }

    async function ctrl(action, arg) { snap = await api.simControl(action, arg); if (snap && snap.ok === false) playing = false; render(); }
    async function load() { snap = await api.simLoad({ datasetId: sel.value }); render(); }
    function stopPlay() { playing = false; if (timer) { clearTimeout(timer); timer = null; } }
    function tick() { if (!playing) return; if (snap && snap.counters && snap.counters.currentEvent >= snap.counters.totalEvents) { stopPlay(); return; } ctrl('next').then(() => { if (playing) timer = setTimeout(tick, speedMs); }); }
    function startPlay() { if (playing) return; playing = true; timer = setTimeout(tick, speedMs); }

    const controls = el('div', { class: 'sim-controls' },
      el('button', { class: 'btn primary', onclick: startPlay }, '▶ Bắt đầu'),
      el('button', { class: 'btn', onclick: stopPlay }, '⏸ Tạm dừng'),
      el('button', { class: 'btn', onclick: () => { stopPlay(); ctrl('previous'); } }, '⏮ Trước'),
      el('button', { class: 'btn', onclick: () => { stopPlay(); ctrl('next'); } }, '⏭ Sau'),
      el('button', { class: 'btn', onclick: () => { stopPlay(); ctrl('reset'); } }, '⟲ Reset'),
      el('label', { class: 'sim-speed' }, 'Tốc độ ',
        (() => { const sp = el('select', null, el('option', { value: '400' }, 'Nhanh'), el('option', { value: '800' }, 'Vừa'), el('option', { value: '1500' }, 'Chậm')); sp.value = String(speedMs); sp.addEventListener('change', () => { speedMs = Number(sp.value); }); return sp; })()),
      el('button', { class: 'btn', onclick: close }, 'Đóng'),
    );

    card.appendChild(el('div', { class: 'section-t' }, 'NGUỒN DỮ LIỆU (fixture / replay redacted / local)'));
    card.appendChild(el('div', { class: 'sim-source' }, sel, el('button', { class: 'btn', onclick: load }, 'Nạp')));
    card.appendChild(countersBar);
    card.appendChild(controls);
    card.appendChild(timelineBox);
    card.appendChild(handBox);
    card.appendChild(meldBox);
    card.appendChild(publicBox);
    card.appendChild(warnBox);
    overlay.appendChild(card); document.body.appendChild(overlay);
    await load();
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
  async function refresh() { try { session = await api.sessionState(); if (session && session.hands) hands = session.hands; } catch {} renderApp(); }

  // Start the PASSIVE host session as soon as the 3 browsers are open, so the coordinator observes
  // each run's frames immediately (socketReady/uid/table state, live monitor). This is what lets the
  // tool reflect the real browser state without waiting for a manual VÀO GAME PHỎM click. It performs
  // NO orchestration (no channel request / join / ready) — that stays a user action (TÌM BÀN).
  async function ensurePassiveSession() {
    if (phomSessionStarted) return;
    const runIds = SLOTS.map((sl) => assign[sl].runId).filter(Boolean);
    if (runIds.length !== 3) return;
    const prof = selectedProfile();
    const hostSlot = (prof && prof.defaultHostSlot) || 'A';
    const host = (assign[hostSlot] && assign[hostSlot].runId) || runIds[0];
    hostId = host;
    try { const start = await api.startSession({ runIds, hostId: host }); if (start && start.ok !== false) phomSessionStarted = true; } catch {}
  }

  // Poll the session while on Screen 2 so the entry gate + monitor update promptly even before any
  // push event arrives (the coordinator only pushes on frames; at an idle lobby that can be sparse).
  let entryPollTimer = null;
  function startEntryPolling() {
    if (entryPollTimer) return;
    entryPollTimer = setInterval(async () => {
      if (uiState !== UI.CONTROL) return;
      await ensurePassiveSession();
      try { session = await api.sessionState(); if (session && session.hands) hands = session.hands; } catch {}
      try { clusterSnap = await api.clusterSnapshot(); } catch {}
      // BUG #1 latency fix: when a run is logged in (socket+uid) but the coordinator hasn't seen the
      // stake channel list yet (channelCount 0), the game only re-sends it sparsely — so actively
      // request it once so PHỎM READY is detected in seconds, not after a long wait. This is a passive
      // read of the lobby's own list (not orchestration); harmless if it fails (typed, swallowed).
      const needChannels = SLOTS.some((sl) => { const p = slotProfile(assign[sl].runId); return p && p.socketReady && p.connected && !((p.channelCount || 0) > 0); });
      if (needChannels && phomSessionStarted) { try { await api.requestChannels(); } catch {} }
      await refreshManual(); // PHASE 6.1 — keep the per-browser cards + Screen 2 + search-lock reconcile current
      reconcileEntryPhase();
      if (!$('workspace').hidden) bgRender();
    }, 2000);
  }
  function stopEntryPolling() { if (entryPollTimer) { clearInterval(entryPollTimer); entryPollTimer = null; } }

  // Primary CTA: start the session over the 3 opened runs, pick HOST + stake, then run
  // §13 — Find-Table: the ONLY place a stake is chosen. Opens a compact modal, starts
  // the session so the HOST can request the server channel list, then shows the
  // AUTHORITATIVE distinct stakes. Confirm runs the full flow; Cancel sends nothing more.
  async function openFindTable() {
    // BUG #2 §9/§10 — never fail silently: report the exact gate reason on click.
    const runIds = SLOTS.map((sl) => assign[sl].runId).filter(Boolean);
    if (runIds.length !== 3) return note('Cần mở đủ 3 browser trước.', true);
    if (!caps.authorized) return note('Không thể tìm bàn: môi trường chưa được cấp quyền QA (PHOM_QA_ENABLED=1 và PHOM_QA_AUTHORIZED=1).', true);
    const host = hostId && runIds.includes(hostId) ? hostId : runIds[0];
    hostId = host;
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const overlay = el('div', { class: 'phq-analyzer' });
    const close = () => overlay.remove();
    const card = el('div', { class: 'anz-card ft-card' });
    card.appendChild(el('div', { class: 'section-t' }, 'TÌM BÀN TRỐNG'));
    const status = el('div', { class: 'note' }, 'Đang chờ danh sách mức cược từ game…');
    const sel = el('select', { class: 'sel', id: 'ft-stake' }, el('option', { value: '' }, '— chọn mức cược —'));
    const confirmBtn = el('button', { class: 'btn primary', disabled: 'disabled', onclick: async () => {
      const stake = Number(($('ft-stake') || {}).value);
      if (!stake) { status.textContent = 'Phải chọn mức cược.'; status.className = 'note warn'; return; }
      close();
      await runFindTable(stake);
    } }, 'XÁC NHẬN TÌM BÀN');
    card.appendChild(el('div', { class: 'phq-row' }, el('span', null, 'Mức cược'), sel));
    card.appendChild(status);
    card.appendChild(el('div', { class: 'phq-row' }, confirmBtn, el('button', { class: 'btn', onclick: close }, 'HỦY')));
    overlay.appendChild(card); document.body.appendChild(overlay);

    // The passive session was already started at VÀO GAME PHỎM; reuse it (never re-create —
    // that would drop the per-profile game context). Only start here as a safety net if the
    // gate was somehow bypassed. Channel request happens ONLY now (§5), on TÌM BÀN.
    if (!phomSessionStarted) {
      const start = await api.startSession({ runIds, hostId: host });
      if (start && start.ok === false) { status.textContent = errText(start); status.className = 'note warn'; return; }
      phomSessionStarted = true;
    }
    try { await api.requestChannels(); } catch {}
    // Poll the authoritative stake list (no hard-coded fallback); typed timeout.
    for (let i = 0; i < 8; i++) {
      let res; try { res = await api.stakeChannels(); } catch { res = null; }
      const stakes = (res && res.stakes) || [];
      if (stakes.length) {
        for (const s of stakes) sel.appendChild(el('option', { value: String(s) }, String(s)));
        status.textContent = 'Chọn mức cược rồi bấm XÁC NHẬN.'; status.className = 'note';
        confirmBtn.disabled = null; return;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    // Friendly message in the focused UI; the typed code stays in a tiny advanced line.
    status.replaceChildren(document.createTextNode('Đang chờ danh sách mức cược từ game…'),
      el('span', { class: 'ft-code' }, ' (PHOM_STAKE_LIST_UNAVAILABLE)'));
    status.className = 'note warn';
  }

  // Run the full HOST/follower/Ready/ReJoin flow for a validated stake (§14).
  async function runFindTable(stake) {
    selectedStake = stake;
    note('Đang tìm bàn (mức cược ' + stake + ')…'); // FIND_TABLE_REQUESTED — immediate visible feedback
    const sel = await api.selectStake(stake);
    if (sel && sel.ok === false) { note('Không thể chọn mức cược: ' + errText(sel), true); return; }
    autoFlow = true; renderApp(); // FIND_TABLE_STARTED — button reflects the running search
    try {
      // Host-first discovery loop (§ real flow): A joins + validates first, then B/C follow. The
      // coordinator owns the whole loop; the UI just starts it and reports the typed outcome.
      const d = await api.discover();
      if (d && d.ok === false) { note('Không thể tìm bàn: ' + errText(d), true); return; }
      note('HOST đang tìm bàn hợp lệ — A vào trước → kiểm tra → B/C theo A.');
    } catch (e) {
      note('Lỗi tìm bàn: ' + String(e && e.message || e), true);
    } finally {
      // ALWAYS clear the running flag so the TÌM BÀN button re-enables — never leave it stuck
      // "ĐANG CHẠY…" (that made the button look dead on the next click). BUG #2.
      autoFlow = false; refresh();
    }
  }
  // Advance the happy path when authoritative state confirms each stage.
  // Re-entrant-safe automatic flow: HOST acquired -> followers join -> Ready policy is
  // (re)applied whenever the authoritative controlledReadyCount is below the desired
  // count. Because the desired count rises from 2 to 3 when a real 4th player sits, the
  // waiting controlled account auto-Readies on the next snapshot. applyReady is
  // idempotent in the domain, so re-issuing it never double-sends. Host loss / rejoin
  // exhaustion stops orchestration (no follower promotion — §12/§15).
  let flowBusy = false;
  // The host-first discovery loop (main-process coordinator) now owns follower join, ready policy,
  // C-rejoin and invalid-table restart. The renderer must NOT drive join/ready itself (that caused
  // B/C to join before A was validated). This only clears the local "running" flag on terminal states.
  function advanceAutoFlow(s) {
    if (!autoFlow || !s) return;
    if (s.state === 'HOST_ACQUIRE_FAILED' || s.state === 'REJOIN_EXHAUSTED' || s.state === 'STOPPED') autoFlow = false;
  }

  // Cluster CTA: SETUP → OPENING_CLUSTER → CONTROL. create → open → connect → apply
  // devices → tile (restoreLayout) via PhomClusterCdpManager.
  async function openCluster() {
    // §3 — the SAVED cluster profile drives the runtime. The renderer sends ONLY the
    // selected profile id (+ the non-persisted localTest flag); host/stake/proxy/device
    // all come authoritatively from the saved profile in the main process.
    if (!selectedClusterProfileId) { note('Hãy chọn hoặc tạo một Cluster Profile trước khi mở cụm.', true); return; }
    // §41 — a fast double-click must not open a second cluster / duplicate browser runs.
    if (clusterOpBusy) { note('Đang mở cụm — vui lòng chờ…', true); return; }
    clusterOpBusy = true;
    try { await openClusterInner(); } finally { clusterOpBusy = false; }
  }
  async function openClusterInner() {
    // §11 IDEMPOTENT: if the cluster is already open, REUSE it — never teardown/reopen.
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    if (clusterSnap && (clusterSnap.openBrowserCount || 0) >= 3 && clusterSnap.stopped !== true) {
      for (const slot of SLOTS) { const p = clusterSnap.profiles && clusterSnap.profiles[slot]; if (p && p.profileId) assign[slot].runId = p.profileId; }
      uiState = UI.CONTROL; activeTab = "PHOM"; renderApp();
      await ensurePassiveSession(); startEntryPolling();
      note('Cụm đã mở sẵn — dùng lại 3 trình duyệt hiện có (không mở lại).');
      return;
    }
    uiState = UI.OPENING_CLUSTER; renderApp();
    try {
      const created = await api.clusterCreate({ clusterProfileId: selectedClusterProfileId, localTest });
      if (created && created.ok === false) throw created;
      if (created && created.localTest != null) localTest = created.localTest;
      if (created && created.clusterProfileId) selectedClusterProfileId = created.clusterProfileId;
      const open = await api.clusterOpen();
      if (open && open.ok === false && !open.opened) throw open;
      // Sandbox-enabled Chromium needs a moment before its CDP endpoint answers, so the
      // connect is retried (bounded) rather than one-shot. A CDP miss NEVER closes a
      // browser (§6/§7): we still land on Screen 2 and show "CDP CHƯA KẾT NỐI" + retry.
      for (let i = 0; i < 8; i++) {
        const cn = await api.clusterConnect();
        if (cn && (cn.connected || 0) >= 3) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      await api.clusterApplyDevices();
      try { await api.restoreLayout(); } catch {}
      try { caps = await api.capabilities(); } catch {}
      // sync per-slot runIds from the cluster snapshot for HOST/session actions
      clusterSnap = await api.clusterSnapshot();
      for (const slot of SLOTS) { const p = clusterSnap.profiles && clusterSnap.profiles[slot]; if (p && p.profileId) assign[slot].runId = p.profileId; }
      // HOST + stake now come from the saved Cluster Profile (Screen 1), not Screen 2.
      const prof = selectedProfile();
      if (prof) {
        if (prof.defaultStake != null) selectedStake = prof.defaultStake;
        const hostSlot = prof.defaultHostSlot || 'A';
        if (assign[hostSlot] && assign[hostSlot].runId) hostId = assign[hostSlot].runId;
      }
      // §1 — after RUN GAME the tool WAITS for the user to log in on all three browsers. It
      // does NOT auto-request channels, auto-enter Phỏm, or auto-find a table; every step is
      // an explicit user action (LOGIN → VÀO GAME PHỎM → TÌM BÀN).
      entryPhase = ENTRY.LOGIN; phomSessionStarted = false; entrySub = null;
      uiState = UI.CONTROL; activeTab = "PHOM"; renderApp();
      // Observe the browsers immediately (auto-start passive session + poll) so the gate reflects
      // real state and advances to READY on its own once A/B/C are in Phỏm.
      await ensurePassiveSession(); startEntryPolling();
      note(`Đã mở ${open.opened || 0}/3 trình duyệt. Đăng nhập A/B/C — tool sẽ tự nhận khi vào Phỏm.`);
    } catch (e) {
      // A failed open NEVER closes the browsers that DID open (§6/§14). Land on Screen 2
      // if anything opened so the user keeps those browsers; only fall back to ERROR when
      // nothing opened at all.
      try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
      if (clusterSnap && (clusterSnap.openBrowserCount || 0) > 0) {
        for (const slot of SLOTS) { const p = clusterSnap.profiles && clusterSnap.profiles[slot]; if (p && p.profileId) assign[slot].runId = p.profileId; }
        entryPhase = ENTRY.LOGIN; phomSessionStarted = false; entrySub = null; uiState = UI.CONTROL; activeTab = "PHOM"; renderApp();
        note('Mở cụm chưa đủ 3 — các trình duyệt đã mở vẫn được giữ. ' + errText(e), true);
      } else {
        errorMsg = errText(e) + '  (chưa mở được trình duyệt nào — thử lại)';
        uiState = UI.ERROR; renderApp();
      }
    }
  }

  // DỪNG — ORCHESTRATION-ONLY stop (§4/§5). Cancels find-table/join/ready/rejoin
  // automation and monitor playback but NEVER closes the browsers. The tool stays on
  // Screen 2 with the 3 browsers still open, ready for another TÌM BÀN.
  async function stopOrchestration() {
    autoFlow = false; flowBusy = false;
    qaMonitorPlay(false);
    try { await api.orchestrationStop(); } catch {}
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    renderApp();
    note('Đã dừng tự động hoá tìm bàn. Ba trình duyệt vẫn đang mở (không bị đóng).');
  }

  // QUAY VỀ SETUP (§19-§22) — navigate back to the config screen WITHOUT closing the browsers.
  // Cluster-level by design: the architecture owns browser lifetime per-cluster (no per-profile
  // teardown seam), so a single return cancels ALL in-flight orchestration (search/join/ready/
  // rejoin) via the coordinator's generation guard, clears local operation flags, and returns to
  // SETUP. Any late search/join result from the cancelled generation can no longer update state
  // (§21/§22). Browsers stay open, so RUN GAME re-enters the SAME cluster idempotently.
  async function returnToSetup() {
    // Immediate acknowledgement (§7): reflect the intent before the async cancel resolves.
    autoFlow = false; flowBusy = false; clusterOpBusy = false;
    entryPhase = ENTRY.LOGIN; phomSessionStarted = false; entrySub = null;
    if (entryTimer) { clearTimeout(entryTimer); entryTimer = null; }
    stopEntryPolling(); qaMonitorPlay(false);
    uiState = UI.SETUP; activeTab = "SETUP"; renderApp();
    note('Đang quay về SETUP — huỷ tìm bàn/join, giữ nguyên 3 trình duyệt…');
    try { await api.orchestrationStop(); } catch {}
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    // Refresh the SETUP inputs so the screen is accurate after returning.
    try { const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x])); } catch {}
    try { const pl = await api.proxyList(); proxies = (pl && pl.proxies) || []; } catch {}
    await refreshClusterProfiles();
    renderApp();
    note('Đã quay về SETUP. Ba trình duyệt vẫn mở — bấm RUN GAME để dùng lại cụm hiện có.');
  }

  // ĐÓNG 3 TRÌNH DUYỆT — the ONLY UI action that closes the browsers (explicit + confirmed).
  async function closeBrowsers() {
    if (!window.confirm('Đóng cả 3 trình duyệt A/B/C? Cấu hình proxy/thiết bị được giữ nguyên.')) return;
    autoFlow = false; flowBusy = false; entryPhase = ENTRY.LOGIN; phomSessionStarted = false; entrySub = null;
    qaMonitorPlay(false); qaSnap = null;
    uiState = UI.STOPPING; renderApp();
    try { await api.closeBrowsers(); } catch {}
    for (const s of SLOTS) assign[s].runId = null;
    try { const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x])); } catch {}
    try { const pl = await api.proxyList(); proxies = (pl && pl.proxies) || []; } catch {}
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    uiState = UI.SETUP; activeTab = "SETUP"; renderApp();
    note('Đã đóng 3 trình duyệt. Cấu hình proxy/thiết bị được giữ nguyên.');
  }

  // Reopen a single slot the user closed (§10) — reuses that slot's saved profile/device/
  // proxy/user-data-dir; never touches the other two browsers.
  async function reopenSlot(slot) {
    const prof = selectedProfile();
    if (!prof) return note('Chưa chọn Cluster Profile.', true);
    try { await api.clusterOpen(); } catch (e) { return note(errText(e), true); }
    try { clusterSnap = await api.clusterSnapshot(); } catch {}
    for (const s of SLOTS) { const p = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[s]; if (p && p.profileId) assign[s].runId = p.profileId; }
    renderApp(); note('Đã mở lại ' + slot + '.');
  }

  async function refreshCluster() { try { clusterSnap = await api.clusterSnapshot(); } catch {} renderApp(); }
  async function clusterFocus(slot) {
    const p = clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot];
    if (!p || !p.profileId) return note('Browser ' + slot + ' chưa mở.', true);
    await api.focusBrowser(p.profileId); note('Focus ' + slot + '.');
  }
  async function rejoinKicked() {
    const kicked = (session && session.profiles || []).filter((p) => p.state === 'KICKED');
    if (!kicked.length) return note('Không có profile bị kick.');
    for (const p of kicked) { const res = await api.rejoinFollower(p.id); if (res && res.ok === false) note(`${p.displayName}: ${errText(res)}`, true); }
    refresh();
  }
  async function testAllProxies() {
    // §11 — test only slots that HAVE a proxy; DIRECT slots are skipped (not a failure).
    const ids = SLOTS.map((s) => assign[s].proxyRef).filter(Boolean);
    for (const s of SLOTS) { if (!assign[s].proxyRef) assign[s].testState = 'DIRECT'; }
    if (!ids.length) { renderApp(); return qpNote('Tất cả A/B/C đang chạy Trực tiếp (không proxy) — không có gì để test.', true); }
    const res = await api.proxyTestAll(ids);
    const results = res && res.results || {};
    for (const s of SLOTS) { const r = results[assign[s].proxyRef]; if (r) { assign[s].testState = r.state; assign[s].ip = r.observedIp || null; } }
    renderApp();
  }

  // ================= PHASE 6.1 — MANUAL PER-BROWSER CONTROL (Browser 1/2/3) =================
  // Consumes the tested Phase-6 backend (manualFind/Join/Rejoin/Leave/Snapshot + remainingCards) and the
  // pure search-lock/shared-RID module (window.ManualClusterState). No Host/Follower role; no game DOM
  // touch; usernames + cards come from authoritative snapshots only.

  // Refresh the manual snapshot + remaining cards, then reconcile the shared-room lifecycle (§18).
  async function refreshManual() {
    try { const r = await api.manualSnapshot(); manualBrowsers = (r && r.browsers) || []; } catch { manualBrowsers = []; }
    try { const rc = await api.remainingCards(); remaining = rc && rc.ok !== false ? rc : null; } catch { remaining = null; }
    if (MCS) manualCluster = MCS.reconcile(manualCluster, manualBrowsers);
    reconcileEnterStates(); // clear ĐANG VÀO GAME once the browser is authoritatively in game
  }
  function manualBrowserById(id) { return manualBrowsers.find((b) => String(b.profileId) === String(id)) || null; }
  function ownerIndex() { const o = manualCluster.sharedRidOwner; const b = o != null ? manualBrowserById(o) : null; return b ? b.browserIndex : null; }

  // TÌM BÀN click: if a shared RID exists → JOIN it (never a new matchmaking, §31); else start a REAL
  // search and lock the cluster immediately (§6). Terminal states always clear the lock (§13).
  async function onManualFind(b) {
    if (!MCS) return;
    const dec = MCS.onFindStart(manualCluster, b.profileId);
    if (dec.action === 'BLOCKED') { note('Một trình duyệt khác đang tìm bàn — vui lòng chờ.', true); return; }
    manualCluster = dec.state; renderApp(); // immediate lock/label before any await (§4/§6)
    let res;
    if (dec.action === 'JOIN_SHARED') {
      note(`Đang tham gia bàn ${dec.rid}…`);
      try { res = await api.manualJoin(b.profileId, dec.rid); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
      manualCluster = MCS.onJoinResult(manualCluster, b.profileId, res);
    } else {
      // PHASE 6.2.1/6.2.3 — REAL discovery filtered by the CHOSEN server stake: the backend requests the
      // channel list, picks a qualifying EMPTY table whose b === selectedStake, and JOINs its actual RID.
      // The RID + STAKE come from the SELECTED SERVER TABLE. The stake is chosen from real bet options.
      const selectedStake = selectedStakeByBrowser[b.profileId];
      if (selectedStake == null) { manualCluster = MCS.onFindResult(manualCluster, b.profileId, { ok: false }); renderApp(); return note('Chọn mức cược trước khi tìm bàn.', true); }
      note('🔍 Đang tìm bàn theo mức cược ' + selectedStake + '…');
      try { res = await api.manualDiscover(b.profileId, { selectedStake }); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
      manualCluster = MCS.onFindResult(manualCluster, b.profileId, res && res.ok ? { ok: true, rid: res.rid, stake: res.stake } : { ok: false });
    }
    if (res && res.ok === false) note(errText(res), true);
    await refreshManual(); renderApp();
  }
  async function onManualJoin(b) {
    const rid = (ridDraft[b.profileId] != null ? ridDraft[b.profileId] : (MCS ? MCS.prefillRid(manualCluster, b) : '')).trim();
    if (!rid) return note('Nhập Room/RID để vào bàn.', true);
    note(`Đang vào bàn ${rid}…`);
    let res; try { res = await api.manualJoin(b.profileId, rid); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    if (MCS) manualCluster = MCS.onJoinResult(manualCluster, b.profileId, res);
    if (res && res.ok === false) note(errText(res), true);
    await refreshManual(); renderApp();
  }
  async function onManualRejoin(b) {
    note('Đang vào lại bàn…');
    let res; try { res = await api.manualRejoin(b.profileId); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    if (res && res.ok === false) note(errText(res), true);
    await refreshManual(); renderApp();
  }
  async function onManualLeave(b) {
    note('Đang rời bàn…');
    try { await api.manualLeave(b.profileId); } catch {}
    await refreshManual(); renderApp();
  }

  // The 3-browser control grid + shared-room indicator + Screen 2 (remaining cards).
  function manualControlPanel() {
    const wrap = el('div', { class: 'manual-cluster', id: 'phq-manual' });
    wrap.appendChild(el('div', { class: 'section-t' }, 'ĐIỀU KHIỂN THỦ CÔNG — BROWSER 1 / 2 / 3'));
    // shared stake/channel used by a real FIND (join uses the RID directly).
    wrap.appendChild(el('div', { class: 'manual-stake' },
      el('span', { class: 'faint sm' }, 'Mức cược/kênh để TÌM BÀN: '),
      el('input', { class: 'f mono', id: 'phq-manual-stake', value: manualStake, placeholder: 'vd 100', oninput: (e) => { manualStake = e.target.value; } })));
    if (manualCluster.sharedRid != null) {
      wrap.appendChild(el('div', { class: 'shared-room' },
        el('b', null, 'SHARED ROOM'), ' · RID: ', el('b', { class: 'shared-rid' }, String(manualCluster.sharedRid)),
        ownerIndex() != null ? el('span', { class: 'faint' }, ` · Found by: Browser ${ownerIndex()}`) : null));
    }
    const grid = el('div', { class: 'manual-grid' });
    for (const b of manualBrowsers) grid.appendChild(manualBrowserCard(b));
    if (!manualBrowsers.length) grid.appendChild(el('div', { class: 'faint' }, 'Chưa có phiên — mở 3 trình duyệt và đăng nhập.'));
    wrap.appendChild(grid);
    wrap.appendChild(renderRemainingCards());
    return wrap;
  }

  function manualBrowserCard(b) {
    const searching = b.manualState === 'SEARCHING';
    const canFind = MCS ? MCS.canFind(manualCluster, b) : false;
    const draft = ridDraft[b.profileId] != null ? ridDraft[b.profileId] : (MCS ? MCS.prefillRid(manualCluster, b) : '');
    const canJoin = MCS ? MCS.canJoin(manualCluster, b, draft) : false;
    const canRejoin = MCS ? MCS.canRejoin(manualCluster, b) : false;
    const canLeave = MCS ? MCS.canLeave(manualCluster, b) : false;
    const uname = b.username && b.username !== 'USER_UNKNOWN' ? b.username : 'Chưa đăng nhập';
    return el('div', { class: 'browser-card' + (searching ? ' searching' : ''), id: 'bcard-' + b.profileId },
      el('div', { class: 'bc-head' }, el('b', null, 'BROWSER ' + b.browserIndex), el('span', { class: 'bc-status ' + manualStatusCls(b.manualState) }, b.manualState || 'READY')),
      el('div', { class: 'bc-user' }, 'User: ', el('b', null, uname)),
      el('button', { class: 'btn primary bc-find', disabled: canFind ? null : true, onclick: () => onManualFind(b) }, MCS ? MCS.findLabel(manualCluster, b) : 'TÌM BÀN'),
      el('div', { class: 'bc-rid' }, el('span', { class: 'faint sm' }, 'Room/RID'),
        el('input', { class: 'f mono', id: 'rid-' + b.profileId, value: draft, placeholder: manualCluster.sharedRid != null ? String(manualCluster.sharedRid) : '—', oninput: (e) => { ridDraft[b.profileId] = e.target.value; } })),
      el('div', { class: 'bc-actions' },
        el('button', { class: 'btn', disabled: canJoin ? null : true, onclick: () => onManualJoin(b) }, 'JOIN BÀN'),
        el('button', { class: 'btn', disabled: canRejoin ? null : true, onclick: () => onManualRejoin(b) }, 'REJOIN'),
        el('button', { class: 'btn danger', disabled: canLeave ? null : true, onclick: () => onManualLeave(b) }, 'THOÁT')),
      b.lastError ? el('div', { class: 'warnrow sm' }, errText({ error: b.lastError })) : null,
    );
  }
  function manualStatusCls(s) { return ({ JOINED: 'green', SEARCHING: 'yellow', JOINING: 'blue', RECONNECTING: 'blue', LEAVING: 'yellow', LEFT: 'gray', ERROR: 'red', READY: 'gray', CLOSED: 'gray' })[s] || 'gray'; }

  // Screen 2 — CARDS REMAINING (= full deck − Browser1 − Browser2 − Browser3). Renders the backend
  // result only (never recomputes); NOT "player 4".
  function renderRemainingCards() {
    const box = el('div', { class: 'remaining-cards', id: 'phq-remaining' });
    box.appendChild(el('div', { class: 'section-t' }, 'CARDS REMAINING'));
    const cards = (remaining && Array.isArray(remaining.cards)) ? remaining.cards : [];
    const row = el('div', { class: 'cards' });
    if (!cards.length) row.appendChild(el('span', { class: 'faint' }, '—'));
    for (const c of cards) row.appendChild(el('span', { class: 'card-face ' + (c.color === 'red' ? 'red' : 'black') }, el('b', null, c.rank || '?'), el('span', null, c.suit || '?')));
    box.appendChild(row);
    box.appendChild(el('div', { class: 'faint sm' }, 'Remaining: ' + (remaining ? remaining.count : 0)));
    return box;
  }

  // ---------- helpers ----------
  function browserCount() { return SLOTS.filter((s) => assign[s].runId).length; }
  // Proxy is OPTIONAL: TÌM BÀN only needs the 3 browsers open in an authorized env — a
  // slot running DIRECT is valid and never blocks the find-table flow.
  // TÌM BÀN unlocks ONLY when the full entry gate has completed: 3 browsers open in an
  // authorized env AND the user has confirmed login AND A/B/C have entered Phỏm (§1-§4).
  // Proxy is optional; CDP-not-connected doesn't gate here.
  function ctaEnabled() { return !!caps.authorized && browserCount() === 3 && entryPhase === ENTRY.READY; }
  function ctaReason(s) {
    if (!caps.authorized) return 'Môi trường chưa được cấp quyền QA (đặt PHOM_QA_AUTHORIZED=1 hoặc allowlist).';
    if (browserCount() < 3) return 'Cần mở đủ 3 browser.';
    return '';
  }
  function syncCls(x) { return ({ LIVE: 'good', ENDED: 'faint', STALE: 'warn', DESYNCED: 'bad', EMPTY: 'faint' })[x] || 'faint'; }
  function errText(res) { const e = res && res.error; return e ? `${e.code}: ${e.message}` : 'Thao tác thất bại.'; }
  function note(msg, warn) { const n = $('phq-note'); if (n) { n.textContent = msg; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }

  // ---------- boot ----------
  if (api.onSession) api.onSession((snap) => { session = snap; if (snap && snap.hands) hands = snap.hands; reconcileEntryPhase(); advanceAutoFlow(snap); if (!$('workspace').hidden) bgRender(); });
  // PHASE 6.1 — card state changed: refresh Screen 2 remaining cards + per-browser membership, then re-render.
  if (api.onHands) api.onHands((h) => { hands = h; if (!$('workspace').hidden && uiState === UI.CONTROL) refreshManual().then(() => { if (uiState === UI.CONTROL) bgRender(); }); else bgRender(); });
  if (api.onLicense) api.onLicense((s) => { if (s && s.active && !$('activation').hidden) boot(); });
  if (api.onCluster) api.onCluster((snap) => { clusterSnap = snap; if (!$('workspace').hidden && (uiState === UI.CONTROL || uiState === UI.OPENING_CLUSTER)) bgRender(); });
  // Auto ReJoin: when the domain reports a kicked controlled profile, recover it (the
  // coordinator enforces debounce/cooldown/bounded retry + round-active defer — §15).
  if (api.onKick) api.onKick(() => { if (uiState === UI.CONTROL) rejoinKicked(); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
