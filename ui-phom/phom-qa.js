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
  let licenseInfo = null; // PHASE 6.3.9 — full license status (expiresAt) for the compact header chip
  let session = null;
  let hands = [];
  let proxies = [];
  let presets = [];          // mobile device presets
  const DEFAULT_PROFILE_PRESET_ID = 'desktop-22-24-16x9'; // §6.3.13 — default display for NEW profiles (600×338 · 16:9)
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
  // The group's table as the backend reports it (table-group.cjs is the single source; the renderer never derives).
  let manualCluster = { sharedRid: null, sharedRidOwner: null, sharedStake: null };
  let manualBrowsers = [];   // last manualBrowserSnapshot() (per-browser independent state)
  // §co-seat — the CLUSTER verdict from the backend (coordinator.coSeatStatus()): are all browsers proven to be
  // in the SAME authoritative ps[]? Never derived here from three independent JOINED flags — three browsers can
  // each be seated, happily, at three DIFFERENT tables, which is exactly the failure this indicator exists for.
  let coSeat = null;
  let remaining = null;      // last remainingCards() view for Screen 2
  // PHASE 6.3.3.2 — last card-observation snapshot (players/discards/melds/remaining/capabilities). Read-only.
  let cardsSnap = null;
  let safeBySlot = {};         // LỌC BÀI — the read-only analyzer result per account slot (B1/B2/B3)
  let manualGroup = null;      // §group — the tool-created table: rid/key/stake/keep + each member's role
  let autoStake = '';          // Tiền picked for TỰ ĐỘNG VÀO BÀN
  let autoBusy = false;        // an automatic create/gather is in flight
  // The legacy TÌM BÀN finder slot (B1/B2/B3) or null; kept for the old find flow only.
  const manualEntering = {}; // browserId -> true while VÀO GAME is in flight (real ENTERING state, §5)
  const manualEnterError = {}; // browserId -> message when VÀO GAME failed/timed out (retryable)
  const manualEnterTimers = {}; // browserId -> bounded entry timeout handle
  const manualJoining = {};  // browserId -> true while VÀO BÀN (join shared RID) is in flight (§4)
  let activeTab = 'SETUP';   // PHASE 6.2.2 — two tabs: SETUP (config/open) and PHOM (control)
  // PHASE 6.3.1 — flexible N-profile SETUP: the profile LIST + the ordered selection (→ B1/B2/B3) + game URL.
  const PS = (typeof window !== 'undefined' && window.ProfileSelection) ? window.ProfileSelection : null;
  const BP = (typeof window !== 'undefined' && window.BulkProxy) ? window.BulkProxy : null; // PHASE 6.3.10 — bulk proxy parser
  let profilesX = [];              // all saved device profiles (from phom:profiles-list)
  let browserRuntimeInfo = null;   // PHASE 6.3.2.2 — { preference, customAvailable, chromeAvailable, resolved }
  let selectedProfileIds = [];     // ORDERED selection (max 3); selection order → B1/B2/B3
  let bulkProxyText = '';          // bulk-proxy textarea (one proxy per line)
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

  // PHASE 6.3 — Lucide-style inline SVG icon set (no emoji glyphs, §6). icon(name) returns an <svg>.
  const ICON_PATHS = {
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    play: '<path d="m7 4 13 8-13 8Z"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  };
  function icon(name, opts) {
    const span = document.createElement('span');
    span.className = 'icon-wrap'; span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg class="lucide${opts && opts.sm ? ' sm' : ''}" viewBox="0 0 24 24">${ICON_PATHS[name] || ''}</svg>`;
    return span.firstChild;
  }
  // An icon-only button with a mandatory tooltip (§6). `variant` maps to a btn class.
  function iconButton(name, title, onClick, variant) {
    return el('button', { class: 'icon-btn2' + (variant ? ' ' + variant : ''), title, 'aria-label': title, onclick: onClick }, icon(name, { sm: true }));
  }
  const pill = (l, v, c) => el('span', { class: 'pill ' + (c || '') }, l + ' ', el('b', null, String(v)));
  // PHASE 6.3.3.1 — USER-FACING browser naming. Internal slot ids stay B1/B2/B3 (stable, §14); only the
  // displayed label is P1/P2/P3. browserOf()/mapProxies() are unchanged — this maps at render time.
  const playerLabel = (b) => { const m = /^(?:B|P|Player\s+)(\d+)$/i.exec(String(b == null ? '' : b)); return m ? 'P' + m[1] : String(b == null ? '' : b); };

  // ---------- boot / license ----------
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
    await refreshProfilesX(); // PHASE 6.3.1 — load the flexible profile list
    await refreshBrowserRuntime(); // PHASE 6.3.2.2 — load the browser runtime preference/availability
    // Land in CONTROL if a cluster is already open (e.g. renderer reload), else SETUP. On a reload the slots must be
    // re-bound to the open runs, or every row reads "CHƯA MỞ" while three browsers are running.
    uiState = clusterIsOpen() ? UI.CONTROL : UI.SETUP;
    if (uiState === UI.CONTROL) {
      for (const s of SLOTS) { const p = clusterSnap.profiles && clusterSnap.profiles[s]; if (p && p.profileId) assign[s].runId = p.profileId; }
      activeTab = 'PHOM';
      await refreshManual();
    }
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
    // PHASE 6.3.9 — one unified header: brand · [PROFILE] [PHỎM] · compact license chip (no separate panel).
    bar.appendChild(el('span', { class: 'tb-brand' }, '♠ PHỎM QA'));
    bar.appendChild(tab('SETUP', 'PROFILE'));
    bar.appendChild(tab('PHOM', 'PHỎM'));
    bar.appendChild(licenseChip());
    return bar;
  }
  // Compact license status for the header (never a separate License page; no long key shown).
  function licenseChip() {
    const wrap = el('span', { class: 'tb-license' });
    if (licenseMode === 'DEVELOPMENT_BYPASS') { wrap.appendChild(el('span', { class: 'chip yellow sm' }, '● DEV BYPASS')); return wrap; }
    wrap.appendChild(el('span', { class: 'chip green sm' }, '● Đã kích hoạt'));
    // PHASE 6.3.9-fix — the real license status carries expiry at payload.expiresAt (unix SECONDS) + a trusted
    // nowSeconds. (Top-level expiresAt was wrong — it never populated, so the days/HSD went missing in the
    // packaged app.) Always show "Còn X ngày · HSD: DD/MM/YYYY" from the authoritative signed expiry.
    const li = licenseInfo || {};
    const expSec = (li.payload && li.payload.expiresAt != null) ? Number(li.payload.expiresAt)
      : (li.expiresAt != null ? Number(li.expiresAt) : null);
    if (expSec && Number.isFinite(expSec)) {
      const nowMs = (li.nowSeconds != null && Number.isFinite(Number(li.nowSeconds))) ? Number(li.nowSeconds) * 1000 : Date.now();
      const d = new Date(expSec * 1000);
      const days = Math.max(0, Math.ceil((d.getTime() - nowMs) / 86400000));
      const p2 = (n) => String(n).padStart(2, '0');
      wrap.appendChild(el('span', { class: 'faint sm tb-hsd' }, `Còn ${days} ngày · HSD: ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`));
    }
    return wrap;
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
  // A background re-render (a ui push, a poll tick) rebuilds the whole screen, and during a round those arrive
  // several times a second. Coalesce them into ONE repaint per animation frame, and skip the repaint entirely when
  // nothing that is actually displayed changed. A user click still renders immediately (renderApp).
  let _bgQueued = false;
  let _bgKey = '';
  function bgRender() {
    if (betSelectFocused()) return;              // never rebuild an open dropdown out from under the user
    if (document.hidden) return;                 // the window is not visible: the next poll/push repaints
    const key = renderKey();
    if (key === _bgKey) return;
    _bgKey = key;
    if (_bgQueued) return;
    _bgQueued = true;
    requestAnimationFrame(() => { _bgQueued = false; renderApp(); });
  }
  // What the Phỏm screen actually shows. Cheap to build, and it changes only when a pixel would.
  function renderKey() {
    if (uiState !== UI.CONTROL || activeTab !== 'PHOM') return uiState + '|' + activeTab + '|' + (manualBrowsers.length);
    const g = manualGroup;
    const browsers = manualBrowsers.map((b) => [b.profileId, b.manualState, b.rid, b.seat, b.ready, b.groupRole, b.isTableHost, b.username, b.connected, b.socketReady, b.channelCount, b.header, b.lastError && b.lastError.code].join(',')).join(';');
    const cards = ['B1', 'B2', 'B3'].map((sl) => { const a = safeBySlot[sl]; return a ? a.roundSeq + ':' + (a.targetCards || []).map((c) => c.code + c.classification).join('') : '-'; }).join('|');
    const rem = remaining ? (remaining.count + ':' + (cardsSnap && cardsSnap.remaining ? cardsSnap.remaining.count : '')) : '-';
    return [uiState, activeTab, g && g.rid, g && g.key, g && g.auto, g && g.busy, g && g.recreating, autoStake, autoBusy,
      coSeat && coSeat.result, coSeat && coSeat.seatedCount, browsers, cards, rem, noteText()].join('|');
  }
  function noteText() { const n = $('phq-note'); return n ? n.textContent : ''; }
  // Plain-Vietnamese line for a table-group event (docs/phom-kich-ban.md). Unknown events are ignored, never
  // shown as a raw code.
  function noticeText(n) {
    if (!n || !n.event) return '';
    const who = playerLabelOf(n.id);
    switch (n.event) {
      case 'GROUP_CREATED': return 'Đã tạo bàn ' + n.rid + '.';
      case 'GROUP_FORMED': return 'Cả nhóm đã vào bàn ' + n.rid + '.';
      case 'JOINED': return who + ' đã vào bàn' + (n.role ? ' · ' + roleLabel(n.role) : '') + '.';
      case 'JOIN_FAILED': return who + ' vào bàn không được: ' + errText({ error: n.error }) + '.';
      case 'CREATE_FAILED': return 'Tạo bàn không được: ' + errText({ error: n.error }) + '.';
      case 'LEAVE_FAILED': return who + ' chưa rời được bàn: ' + errText({ error: n.error }) + '.';
      case 'KICKED': return who + ' bị đá khỏi bàn' + (n.message ? ' (' + n.message + ')' : '') + (n.auto ? ' — đang tự vào lại…' : ' — bấm ReJoin để vào lại.');
      case 'REJOIN_EXHAUSTED': return who + ' bị đá quá nhiều lần trong 1 phút — tự vào lại đã dừng.';
      case 'TABLE_LOST': return 'Bàn ' + n.rid + ' không còn' + (n.auto ? ' — đang tạo bàn mới…' : ' — bấm Tạo để mở bàn mới.');
      case 'GROUP_DISSOLVED': return 'Đã thoát bàn tất cả.';
      case 'AUTO_OFF': return 'Đã tắt tự động.';
      default: return '';
    }
  }
  function playerLabelOf(runId) { const b = runId != null ? manualBrowserById(runId) : null; return b && b.browserIndex ? 'P' + b.browserIndex : 'Một acc'; }
  function roleLabel(role) { const v = ROLE_VIEW[role]; return v ? v[0] : role; }

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
  // PHASE 6.3.1 — SETUP = a flexible device-profiles TABLE (manage + select), a Game URL, bulk proxy, and
  // the RUN GAME CTA. The table checkbox is the ONLY selection UI (no B1/B2/B3 dropdowns, no selected-
  // profile panel, no cluster/CỤM concept). Selection order → B1/B2/B3.
  // PHASE 6.3.2.1 — a header + a SINGLE scrollable page (all panels) + a sticky footer (count + MỞ 3
   // TRÌNH DUYỆT). No global Game URL input: the URL is a per-profile property, edited in Edit Profile.
  // ⚡ DÁN PROXY — one line = one proxy, mapped to the profiles BY ORDER (line 1 → profile 1 …). All-or-nothing:
  // every line is parsed and validated before anything is saved, and a password is never echoed back.
  function openBulkProxy() {
    if (!BP) return note('Chưa nạp được bộ đọc proxy.', true);
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const overlay = el('div', { class: 'phq-analyzer' });
    const close = () => overlay.remove();
    const msg = el('div', { class: 'note' }, profilesX.length ? profilesX.slice(0, 3).map((p, i) => 'Dòng ' + (i + 1) + ' → ' + p.name).join(' · ') : 'Chưa có profile nào.');
    const ta = el('textarea', { class: 'f mono', rows: '4', style: 'width:100%', placeholder: BP.TEMPLATE || 'HTTP|host|port|user|pass', oninput: (e) => { bulkProxyText = e.target.value; } }, bulkProxyText);
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
      await refreshProfilesX();
      close(); renderApp();
      note('Đã gán ' + mapped.mapping.length + ' proxy theo thứ tự profile.');
    };
    overlay.appendChild(el('div', { class: 'anz-card', role: 'dialog', 'aria-label': 'Dán proxy' },
      el('div', { class: 'capture-heading' }, el('strong', null, '⚡ DÁN PROXY'), el('button', { class: 'btn sm', onclick: close }, 'Đóng')),
      el('div', { class: 'faint sm' }, 'Mỗi dòng một proxy · gán theo thứ tự profile'),
      ta, msg,
      el('div', { class: 'phq-row' },
        el('button', { class: 'btn sm', onclick: () => { ta.value = BP.TEMPLATE || ''; bulkProxyText = ta.value; ta.focus(); } }, 'MẪU'),
        el('button', { class: 'btn primary', onclick: apply }, 'ÁP DỤNG'))));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay); ta.focus();
  }

  function renderSetup(r) {
    // PHASE 6.3.9 — the unified tab bar already carries brand + license; no redundant SETUP sub-header here.
    r.appendChild(el('div', { class: 'note s1-note', id: 'phq-note' }, ''));
    const page = el('div', { class: 'setup-page' });
    // PHASE 6.3.9/6.3.10 — Profile is the compact table + a COMPACT quick bulk-proxy import (one line = one
    // proxy, mapped B1→B2→B3 by profile order). Per-profile proxy still edits in the row's Edit modal.
    page.appendChild(profileTablePanel());
    page.appendChild(el('div', { class: 'note' }, 'Chọn tối đa 3 profile rồi mở trình duyệt. Sau khi vào Phỏm, chọn mức cược để tạo bàn hoặc nhập số bàn trên thanh điều khiển trong game.'));
    r.appendChild(page);
    r.appendChild(runGameFooter());
  }

  let tokenKeyRows = null;
  let tokenKeyPanelOpen = false;
  function profileTablePanel() {
    // PHASE 6.3.3.1 — the profile table is the FLEXIBLE primary area (`profile-panel` → flex:1); it fills
    // unused Tool height and scrolls INTERNALLY, so the proxy block + footer stay put (no page-level scroll).
    const panel = el('div', { class: 'setup-panel profile-panel' });
    const n = selectedProfileIds.length;
    panel.appendChild(el('div', { class: 'setup-section-h' },
      el('span', { class: 'h-title' }, 'DEVICE PROFILES ', el('span', { class: 'faint sm' }, `· ĐÃ CHỌN ${n} / 3`)),
      el('div', { style: 'display:flex;gap:6px' },
        el('button', { class: 'btn sm', title: 'Dán nhiều proxy — mỗi dòng một proxy, gán theo thứ tự profile', onclick: openBulkProxy }, '⚡ DÁN PROXY'),
        el('button', { class: 'btn primary sm', onclick: () => openProfileModal(null) }, icon('plus', { sm: true }), ' THÊM PROFILE'))));
    const table = el('table', { class: 'setup-table' });
    // PHASE 6.3.9 — a header checkbox = Select All / Unselect All (picks up to 3 in order → B1/B2/B3).
    const allSel = profilesX.length > 0 && selectedProfileIds.length === Math.min(3, profilesX.length);
    const headCb = el('input', { type: 'checkbox', class: 'prof-cb', checked: allSel ? 'checked' : null, title: 'Chọn / bỏ chọn tất cả', onchange: () => { if (allSel) clearAllProfiles(); else selectAllProfiles(); } });
    table.appendChild(el('thead', null, el('tr', null,
      el('th', null, headCb), el('th', null, 'PLAYER'), el('th', null, 'PROFILE'), el('th', null, 'TYPE'), el('th', null, 'OS WINDOW'), el('th', null, 'VIEWPORT'), el('th', null, 'PROXY'), el('th', null, 'GAME URL'), el('th', null, 'TRẠNG THÁI'), el('th', null, ''))));
    const tbody = el('tbody');
    if (!profilesX.length) tbody.appendChild(el('tr', null, el('td', { colspan: '10', class: 'faint', style: 'text-align:center;padding:16px' }, 'Chưa có profile — bấm THÊM PROFILE.')));
    for (const p of profilesX) tbody.appendChild(profileRow(p));
    table.appendChild(tbody);
    const scroll = el('div', { class: 'table-scroll' }, table);
    panel.appendChild(scroll);
    // Below the table: Select-All / Unselect-All + the selection count (mockup layout).
    panel.appendChild(el('div', { class: 'table-actions' },
      el('button', { class: 'btn sm', onclick: selectAllProfiles }, 'Chọn tất cả'),
      el('button', { class: 'btn sm', onclick: clearAllProfiles }, 'Bỏ chọn tất cả'),
      el('span', { class: 'faint sm', style: 'margin-left:auto' }, `Đã chọn: ${n} / 3 profile`)));
    return panel;
  }
  // PHASE 6.3.9 — Select All picks the first 3 profiles (selection order → B1/B2/B3); Unselect clears.
  function selectAllProfiles() { selectedProfileIds = profilesX.slice(0, 3).map((p) => p.id); renderApp(); }
  function clearAllProfiles() { selectedProfileIds = []; renderApp(); }
  function profileRow(p) {
    const dev = p.device || {};
    const sel = PS ? PS.isSelected(selectedProfileIds, p.id) : false;
    const canSel = PS ? PS.canSelect(selectedProfileIds, p.id) : false;
    const bLabel = PS ? PS.browserOf(selectedProfileIds, p.id) : null;
    const cb = el('input', { type: 'checkbox', class: 'prof-cb', checked: sel ? 'checked' : null, disabled: canSel ? null : true,
      onchange: () => { if (PS) { selectedProfileIds = PS.toggle(selectedProfileIds, p.id); renderApp(); } } });
    const typeText = TYPE_LABEL[dev.profileType] || dev.profileType || '—';
    const osText = dev.osWindow || (dev.osWindowWidth ? `${dev.osWindowWidth}×${dev.osWindowHeight}` : 'Desktop');
    return el('tr', { class: 'prof-row' + (sel ? ' selected' : '') },
      el('td', null, cb),
      el('td', { class: 'col-tag' }, bLabel ? el('span', { class: 'b-badge' }, playerLabel(bLabel)) : ''),
      el('td', { class: 'col-name' }, p.name || '(no name)'),
      el('td', null, typeText),
      el('td', { class: 'num' }, osText),
      el('td', { class: 'num' }, dev.resolution || '—'),
      // PHASE 6.3.10 — compact proxy display: TYPE host:port · auth (credential is never shown, §10). DIRECT if none.
      el('td', null, (() => {
        if (!p.proxyRef) return el('span', { class: 'badge faint' }, 'DIRECT');
        const px = proxies.find((x) => x.id === p.proxyRef);
        const label = px ? ((px.protocol ? px.protocol.toUpperCase() : 'PROXY') + ' ' + (px.endpoint || (px.host + ':' + px.port)) + (px.hasAuth ? ' · auth' : '')) : 'PROXY';
        return el('span', { class: 'badge good', title: 'Proxy đã gán (mật khẩu ẩn)' }, label);
      })()),
      // GAME URL is a per-profile property; shown ellipsised with a full-URL tooltip, edited in Edit Profile.
      el('td', { class: 'col-url' }, p.gameUrl
        ? el('span', { class: 'url-ellipsis', title: p.gameUrl }, p.gameUrl)
        : el('span', { class: 'faint sm', title: 'Chưa có Game URL — bấm Sửa để thêm' }, '— chưa có —')),
      // TRẠNG THÁI: selected (in this run) → Sẵn sàng; otherwise not chosen yet (presentation only).
      el('td', null, sel
        ? el('span', { class: 'badge good' }, '● Sẵn sàng')
        : el('span', { class: 'badge faint' }, '○ Chưa chọn')),
      el('td', null, el('div', { style: 'display:flex;gap:4px;justify-content:flex-end' },
        iconButton('edit', 'Sửa profile', () => openProfileModal(p.id)),
        iconButton('copy', 'Nhân bản profile', () => duplicateProfileX(p.id)),
        iconButton('trash', 'Xóa profile', () => deleteProfileX(p.id), 'danger'))),
    );
  }

  async function refreshProxies() { try { const p = await api.proxyList(); proxies = (p && p.proxies) || []; } catch { /* keep last */ } }

  // RUN GAME — a STICKY footer (never scrolls out of view). Enabled only with exactly 3 selected AND, unless
  // Local Test, every selected profile has its own Game URL (edited in Edit Profile — no URL prompt at RUN).
  function runGameFooter() {
    const n = selectedProfileIds.length;
    const missingUrl = !localTest && selectedProfileIds.some((id) => { const p = profilesX.find((x) => x.id === id); return !(p && p.gameUrl && String(p.gameUrl).trim()); });
    const ready = n === 3 && !missingUrl;
    const footer = el('div', { class: 'setup-footer' });
    // PHASE 6.3.9 — compact footer-left: Môi trường (QA) · Window mode (Landscape) · the REAL browser-runtime
    // engine selector (moved here from the big BROWSER RUNTIME panel — same api.browserRuntimeSet, no new logic).
    const left = el('div', { style: 'display:flex;align-items:center;gap:14px;flex-wrap:wrap' });
    left.appendChild(el('span', { class: 'faint sm' }, 'Môi trường: ', el('b', null, 'QA')));
    left.appendChild(el('span', { class: 'faint sm' }, 'Window mode: ', el('b', null, 'Landscape (điện thoại ngang)')));
    const rt = browserRuntimeInfo || {};
    const opt = (val, label) => el('option', { value: val, selected: (rt.preference || 'AUTO') === val ? 'selected' : null }, label);
    left.appendChild(el('label', { class: 'faint sm' }, 'Trình duyệt: ',
      el('select', { class: 'sel sm', onchange: async (e) => { const res = await api.browserRuntimeSet({ preference: e.target.value }); if (res && res.ok) { await refreshBrowserRuntime(); renderApp(); } } },
        opt('AUTO', 'AUTO'), opt('CUSTOM_CHROMIUM', 'Chromium'), opt('GOOGLE_CHROME', 'Chrome'))));
    if (n === 3 && missingUrl) left.appendChild(el('span', { class: 'chip red sm', title: 'Mỗi profile cần Game URL — mở Sửa profile để nhập' }, 'THIẾU GAME URL'));
    footer.appendChild(left);
    const right = el('div', { style: 'display:flex;align-items:center;gap:10px' });
    right.appendChild(el('span', { class: 'faint sm' }, `Đã chọn: ${n} / 3`));
    if (caps.devBypass) right.appendChild(el('label', { class: 'faint sm' }, el('input', { type: 'checkbox', id: 'phq-localtest', checked: localTest ? 'checked' : null, onchange: (e) => { localTest = e.target.checked; renderApp(); } }), ' Local Test'));
    right.appendChild(el('button', { class: 'btn primary', disabled: ready ? null : true, onclick: openCluster }, icon('play', { sm: true }), ' MỞ TRÌNH DUYỆT ĐÃ CHỌN'));
    footer.appendChild(right);
    return footer;
  }

  // ---- flexible-profile handlers ----
  async function refreshProfilesX() {
    try { const r = await api.profilesList(); profilesX = (r && r.profiles) || []; } catch { profilesX = []; }
    if (PS) selectedProfileIds = PS.prune(selectedProfileIds, profilesX.map((p) => p.id));
    // PHASE 6.3.2.1 — Game URL is now a per-profile property (edited in Edit Profile), not a global input,
    // so there is nothing to pre-fill here; each profile carries + reuses its own saved URL.
  }
  // PHASE 6.3.2.2 — load the browser runtime preference + availability (Custom Chromium / Google Chrome).
  async function refreshBrowserRuntime() {
    try { const r = await api.browserRuntimeGet(); if (r && r.ok) browserRuntimeInfo = r; } catch { /* keep last */ }
  }
  async function deleteProfileX(id) {
    const p = profilesX.find((x) => x.id === id);
    if (!window.confirm(`Xóa profile "${p ? p.name : id}"?`)) return;
    const res = await api.profileDeleteX(id);
    if (res && res.ok === false) return note(errText(res), true);
    if (PS) selectedProfileIds = selectedProfileIds.filter((x) => x !== id); // remove from selection (§11)
    await refreshProfilesX(); renderApp(); note('Đã xóa profile.');
  }
  // PHASE 6.3.9 — DUPLICATE a profile by COMPOSING the existing create IPC (device + Game URL cloned under a
  // "(copy)" name). No new business logic / no new IPC; proxy is set per-profile in Edit on the copy.
  async function duplicateProfileX(id) {
    const p = profilesX.find((x) => x.id === id);
    if (!p) return;
    const res = await api.profileCreate({ name: (p.name || 'Profile') + ' (copy)', device: p.device || {}, gameUrl: p.gameUrl || null });
    if (res && res.ok === false) return note(errText(res), true);
    await refreshProfilesX(); renderApp(); note('Đã nhân bản profile.');
  }
  function proxyLabel(px) {
    if (!px) return '';
    const proto = String(px.protocol || 'http').toUpperCase();
    const parts = [proto + ' ' + (px.endpoint || ((px.host || '?') + ':' + (px.port || '?')))];
    if (px.username) parts.push('user ' + px.username);
    parts.push(px.hasAuth ? 'có mật khẩu' : 'không mật khẩu');
    return parts.join(' · ');
  }
  function openProfileModal(id) {
    const existing = id ? profilesX.find((x) => x.id === id) : null;
    // §6.3.13 — a NEW profile defaults to the standard 22/24" 16:9 preset (600×338) so three
    // browsers tile on one 1920×1080 monitor without the user configuring width/height. EXISTING
    // profiles keep their saved viewport untouched (§4/§11); Duplicate preserves the source (§10).
    const defPreset = !existing ? (presets.find((p) => p.id === DEFAULT_PROFILE_PRESET_ID) || null) : null;
    const dev = existing && existing.device ? existing.device : (defPreset ? { ...defPreset, presetId: defPreset.id } : {});
    document.querySelectorAll('.phq-analyzer').forEach((n) => n.remove());
    const ov = el('div', { class: 'phq-analyzer' });
    const close = () => ov.remove();
    const presetSel = el('select', { class: 'sel', id: 'pf-preset' }, el('option', { value: '' }, '— chọn preset (tùy chọn) —'));
    for (const pr of presets) presetSel.appendChild(el('option', { value: pr.id, selected: dev.presetId === pr.id ? 'selected' : null }, `${pr.name} · ${(pr.profileType || '').replace('_', ' ')}`));
    const f = (idv, ph, val) => el('input', { class: 'f', id: idv, placeholder: ph, value: val != null ? val : '' });
    const curProxy = existing && existing.proxyRef ? (proxies || []).find((x) => x.id === existing.proxyRef) || null : null;
    const applyPreset = () => { const pr = presets.find((x) => x.id === presetSel.value); if (!pr) return; $('pf-name').value = $('pf-name').value || pr.name; $('pf-osw').value = pr.osWindowWidth || ''; $('pf-osh').value = pr.osWindowHeight || ''; $('pf-vpw').value = pr.viewportWidth || ''; $('pf-vph').value = pr.viewportHeight || ''; if ($('pf-touch')) $('pf-touch').checked = !!pr.touch; };
    presetSel.onchange = applyPreset;
    const card = el('div', { class: 'anz-card' },
      el('div', { class: 'section-t' }, existing ? 'SỬA PROFILE' : 'THÊM PROFILE'),
      el('div', { class: 'phq-row' }, el('span', null, 'Tên'), f('pf-name', 'tên profile', existing ? existing.name : '')),
      el('div', { class: 'phq-row' }, el('span', null, 'Preset'), presetSel),
      el('div', { class: 'section-t', style: 'margin-top:8px;font-size:12px' }, 'OS WINDOW (cửa sổ Chromium)'),
      el('div', { class: 'phq-row' }, el('span', null, 'W × H'), f('pf-osw', 'width', dev.osWindowWidth), f('pf-osh', 'height', dev.osWindowHeight)),
      el('div', { class: 'section-t', style: 'margin-top:8px;font-size:12px' }, 'VIEWPORT (game emulation)'),
      el('div', { class: 'phq-row' }, el('span', null, 'W × H'), f('pf-vpw', 'width', dev.viewportWidth), f('pf-vph', 'height', dev.viewportHeight)),
      el('div', { class: 'phq-row' }, el('span', null, 'Touch'), el('label', { class: 'faint' }, el('input', { type: 'checkbox', id: 'pf-touch', checked: (dev.touch == null ? true : dev.touch) ? 'checked' : null }), ' bật cảm ứng')),
      el('div', { class: 'section-t', style: 'margin-top:8px;font-size:12px' }, 'GAME URL (lưu trong profile — không phải nhập lại khi mở)'),
      el('div', { class: 'phq-row' }, el('span', null, 'URL'), el('input', { class: 'f mono', id: 'pf-url', type: 'url', spellcheck: 'false', placeholder: 'https://game.example.com/room', value: existing && existing.gameUrl ? existing.gameUrl : '' })),
      // PHASE 6.3.9 — PROXY is now configured HERE (per-profile), replacing the bulk-proxy panel. Optional:
      // empty = DIRECT. Reuses api.profileSetProxy (same IPC the bulk panel used) — no new proxy logic.
      el('div', { class: 'section-t', style: 'margin-top:8px;font-size:12px' }, 'PROXY (tùy chọn — để trống = DIRECT)'),
      // The saved proxy is SHOWN (protocol, host:port, masked user, whether a password is stored) — the input used to
      // be blank for an existing profile, so a proxy that WAS saved looked as if it had not been. The password itself
      // never reaches the renderer; typing into the box replaces the proxy, leaving it empty keeps it.
      (curProxy ? el('div', { class: 'phq-row' }, el('span', null, 'Đang dùng'), el('span', { class: 'chip green sm mono' }, proxyLabel(curProxy))) : el('span', { style: 'display:none' })),
      el('div', { class: 'phq-row' }, el('span', null, 'Proxy'), el('input', { class: 'f mono', id: 'pf-proxy', placeholder: curProxy ? 'để trống = giữ proxy hiện tại · nhập mới để đổi' : 'host:port  hoặc  host:port:user:pass', value: '' })),
      (existing && existing.proxyRef)
        ? el('div', { class: 'phq-row' }, el('span', null, ''), el('label', { class: 'faint sm' }, el('input', { type: 'checkbox', id: 'pf-proxy-remove' }), ' Đang có proxy — tick để xóa (DIRECT), hoặc nhập proxy mới để đổi'))
        : el('span', { style: 'display:none' }),
      el('div', { class: 'note', id: 'pf-err' }, ''),
      el('div', { class: 'phq-row' },
        el('button', { class: 'btn primary', onclick: () => saveProfileModal(id, close) }, 'Lưu'),
        el('button', { class: 'btn', onclick: close }, 'Hủy')));
    ov.appendChild(card); document.body.appendChild(ov);
  }
  async function saveProfileModal(id, close) {
    const num = (v) => { const n = Number(String(v || '').trim()); return Number.isFinite(n) && n > 0 ? n : null; };
    const vpw = num($('pf-vpw').value), vph = num($('pf-vph').value);
    const err = $('pf-err');
    if (!vpw || !vph) { if (err) { err.textContent = 'Viewport width/height phải là số > 0.'; err.className = 'note warn'; } return; }
    const osw = num($('pf-osw').value), osh = num($('pf-osh').value);
    const touch = !!($('pf-touch') && $('pf-touch').checked);
    // §6.3.13 — when a preset is selected (NEW profiles default to Desktop 22/24"), carry its
    // profileType / scale / emulation so the display tag + device emulation stick. Editing an
    // existing profile with no preset selected keeps the legacy CUSTOM/MOBILE_LANDSCAPE logic (§11).
    const presetId = ($('pf-preset') && $('pf-preset').value) || null;
    const preset = presetId ? presets.find((p) => p.id === presetId) : null;
    const device = { viewportWidth: vpw, viewportHeight: vph, screenWidth: vpw, screenHeight: vph,
      deviceScaleFactor: preset ? preset.deviceScaleFactor : 2, osWindowWidth: osw, osWindowHeight: osh,
      touch, mobile: preset ? preset.mobile : touch, maxTouchPoints: preset ? preset.maxTouchPoints : (touch ? 5 : 0),
      orientationType: 'landscapePrimary', presetId: preset ? preset.id : null,
      profileType: preset ? preset.profileType : ((osw && osh) ? 'CUSTOM' : 'MOBILE_LANDSCAPE') };
    const name = ($('pf-name').value || '').trim() || 'Profile';
    const gameUrl = ($('pf-url') && $('pf-url').value || '').trim() || null;
    let res;
    if (id) res = await api.profileUpdateX(id, { name, device, gameUrl });
    else res = await api.profileCreate({ name, device, gameUrl });
    if (res && res.ok === false) { if (err) { err.textContent = errText(res); err.className = 'note warn'; } return; }
    // PHASE 6.3.9 — per-profile PROXY (optional), reusing the existing api.profileSetProxy IPC. Non-destructive:
    // a new proxy string changes it, the remove checkbox clears it (DIRECT), an untouched field leaves it alone.
    const pid = id || (res && res.profile && res.profile.id) || null;
    if (pid) {
      const proxyStr = ($('pf-proxy') && $('pf-proxy').value || '').trim();
      const removeProxy = !!($('pf-proxy-remove') && $('pf-proxy-remove').checked);
      if (proxyStr) { const pr = await api.profileSetProxy(pid, proxyStr); if (pr && pr.ok === false) { if (err) { err.textContent = errText(pr); err.className = 'note warn'; } return; } }
      else if (removeProxy) { await api.profileSetProxy(pid, null); } // refresh the proxy snapshot so reopening the editor shows the proxy that was just saved
    }
    close(); await refreshProxies(); await refreshProfilesX(); renderApp();
  }

  const SLOT_INDEX = { A: '1', B: '2', C: '3' };
  const TYPE_LABEL = { DESKTOP: 'Desktop', LAPTOP: 'Laptop', LAPTOP_SMALL: 'Laptop Small', MOBILE_LANDSCAPE: 'Mobile Ngang', DESKTOP_16_9: 'Desktop 22/24"', CUSTOM: 'Custom' };
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

  async function clusterProfileCreate() {
    const name = (window.prompt('Tên cấu hình cụm:', 'Cụm mới') || '').trim();
    if (!name) return;
    const gameUrl = (window.prompt('Game URL (http/https, để trống = DRAFT):', '') || '').trim();
    const res = await api.clusterProfileCreate({ name, gameUrl: gameUrl || null, defaultHostSlot: 'A', slots: currentClusterSlots() });
    await refreshClusterProfiles(); renderApp();
    clNote(res && res.ok ? `Đã tạo "${name}".` : ('Lỗi: ' + ((res && res.error && (res.error.message || res.error.code)) || 'không rõ')), res && res.ok);
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

  // ================= SCREEN 2 — LIVE QA WORKSPACE =================
  // Compact status toolbar + minimal command toolbar + a LIVE QA MONITOR that fills
  // the rest. Followers/Ready/ReJoin run automatically (no manual buttons).
  // PHASE 6.2 — compact final Tool UI. The Tool is its own (4th) window; the three real Chromium windows
  // are separate. The main screen is a low header (BÀN/CÒN LẠI) + a SINGLE horizontal row of Browser
  // 1/2/3 controls + remaining cards. No username, no Host/Follower, no legacy entry toolbars/monitor
  // here (those functions stay defined for other flows/tests but are not rendered on the main screen).
  // PHASE 6.3.3 — Screen 2 priority is INVERTED: B1/B2/B3 shrink to a compact one-row status header at the
  // TOP; the CARD WORKSPACE (LÁ BÀI AN TOÀN + LÁ BÀI CÒN LẠI) becomes the dominant flex-growing area.
  // ================= PHỎM control screen — the CARDS come first =================
  //   top    compactHeader     — one line: số bàn · key · cược · cùng bàn
  //          compactBrowserRow — one line of three account chips (role · state · ready · VÀO GAME / ↻ / ⏻)
  //   middle renderCardWorkspace — LỌC BÀI for all three accounts + the remaining cards (takes the free height)
  //   bottom controlFooter     — Tiền · ☐ TỰ ĐỘNG · ĐỔI KEY · THOÁT BÀN TẤT CẢ · XẾP CỬA SỔ · ⋯ · ĐÓNG TẤT CẢ
  // Manual play is each Chromium's own bar (Tạo · Vào · ReJoin · Đổi Key · Thoát). Nothing automatic runs unless
  // TỰ ĐỘNG is ticked here.
  function renderControl(r) {
    r.appendChild(compactHeader());
    r.appendChild(compactBrowserRow());
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));
    r.appendChild(renderCardWorkspace());
    r.appendChild(controlFooter());
  }
  function renderCardWorkspace() {
    const ws = el('div', { class: 'card-workspace' });
    ws.appendChild(renderSafeCards());
    ws.appendChild(renderRemainingCards());
    return ws;
  }
  const BUSY_LABEL = { CREATE: '⏳ ĐANG TẠO BÀN…', JOIN: '⏳ ĐANG VÀO BÀN…', REJOIN: '⏳ ĐANG VÀO LẠI…', LEAVE: '⏳ ĐANG RỜI BÀN…', LEAVE_ALL: '⏳ ĐANG RỜI HẾT…', AUTO_ON: '⏳ ĐANG BẬT TỰ ĐỘNG…', REGROUP: '⏳ ĐANG ĐỔI KEY…' };
  const ROLE_VIEW = { KEY: ['KEY', 'role-key', 'Chủ bàn — giữ key, KHÔNG tự bấm Bắt đầu'], READY: ['SẴN SÀNG', 'role-ready', 'Vào bàn trước → luôn sẵn sàng'], NOT_READY: ['CHƯA SS', 'role-wait', 'Vào bàn sau → không sẵn sàng'] };
  function roleChip(role, host) {
    const v = ROLE_VIEW[role];
    if (!v) return host ? el('span', { class: 'role-chip role-key', title: 'Chủ bàn' }, '👑') : null;
    return el('span', { class: 'role-chip ' + v[1], title: v[2] }, (host ? '👑 ' : '') + v[0]);
  }
  // Stakes offered for TỰ ĐỘNG: the server stakes seen by the browsers that are in the game.
  function autoStakes() {
    const set = new Set();
    for (const b of manualBrowsers) for (const v of (b.betOptions || [])) set.add(Number(v));
    return [...set].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  }
  // The creator for TỰ ĐỘNG = the first open browser (slot order) that is in the game.
  function autoCreatorRunId() {
    for (const slot of SLOTS) { const id = assign[slot].runId; if (id && slotInPhom(id)) return id; }
    return null;
  }
  function compactHeader() {
    const g = manualGroup;
    const rid = g ? g.rid : manualCluster.sharedRid;
    return el('div', { class: 'tool-header status-line' },
      el('span', { class: 'th-rid' }, 'SỐ BÀN ', el('b', null, rid != null ? String(rid) : '—')),
      el('span', { class: 'th-key' }, 'KEY ', el('b', null, g && g.key ? String(g.key) : '—')),
      el('span', { class: 'th-bet' }, 'CƯỢC ', el('b', null, g && g.stake ? String(g.stake) : (manualCluster.sharedStake != null ? String(manualCluster.sharedStake) : '—'))),
      coSeatChip(),
      g && g.auto ? el('span', { class: 'chip green sm', title: 'Bị đá tự Rejoin · mất bàn tự tạo lại' }, g.recreating ? '⟳ ĐANG TẠO LẠI BÀN' : '● TỰ ĐỘNG') : null,
      // Mỗi lệnh gửi lên server đều chờ ngẫu nhiên 0,8–2,5s (docs/phom-kich-ban.md) nên thao tác kéo dài vài giây:
      // nói rõ tool đang làm gì thay vì để người dùng tưởng bị treo.
      g && g.busy ? el('span', { class: 'chip yellow sm', title: 'Thao tác chạy tuần tự, mỗi lệnh cách nhau 0,8–2,5 giây' }, BUSY_LABEL[g.busy] || 'ĐANG XỬ LÝ…') : null);
  }
  // Bottom controls. TỰ ĐỘNG is a checkbox: ticking it forms the group at the chosen Tiền (or takes over the group
  // the user built by hand) and keeps it; unticking stops every automatic action.
  function controlFooter() {
    const g = manualGroup;
    const autoOn = !!(g && g.auto);
    const stakes = autoStakes();
    if (!autoStake && g && g.selectedStake != null) autoStake = String(g.selectedStake); // e.g. after a tool reload
    if (autoStake && !stakes.includes(Number(autoStake))) autoStake = '';
    const sel = el('select', { class: 'bet-sel auto-stake', title: 'Mức cược dùng cho TẠO BÀN (cả tool và thanh trong web)', onchange: (e) => onPickStake(e.target.value) },
      el('option', { value: '' }, 'Tiền…'), ...stakes.map((v) => el('option', { value: String(v) }, String(v))));
    sel.id = 'phq-stake';
    sel.value = autoStake;
    const box = el('input', { type: 'checkbox', id: 'phq-auto', disabled: autoBusy ? 'disabled' : null, onchange: (e) => onAutoToggle(e.target.checked) });
    box.checked = autoOn;
    return el('div', { class: 'control-footer' },
      el('label', { class: 'cf-label', for: 'phq-stake' }, 'Mức cược'), sel,
      el('label', { class: 'auto-toggle' + (autoOn ? ' on' : ''), for: 'phq-auto', title: 'Bật: acc đầu tạo bàn có key, 2 acc kia vào (vào trước SẴN SÀNG, vào sau CHƯA SẴN SÀNG); bị đá tự Rejoin; mất bàn tự tạo lại. Tắt: không làm gì tự động.' },
        box, autoBusy ? ' ĐANG XỬ LÝ…' : ' TỰ ĐỘNG'),
      el('button', { class: 'btn', disabled: g ? null : 'disabled', title: 'Tạo bàn mới với key mới cho cả nhóm', onclick: () => onChangeKey() }, 'ĐỔI KEY'),
      el('button', { class: 'btn warn-btn', title: 'Cả 3 acc rời bàn (tắt tự động)', onclick: step(() => api.leaveAll(), 'Đã thoát bàn tất cả.') }, 'THOÁT BÀN TẤT CẢ'),
      el('button', { class: 'btn', title: 'Sắp xếp cửa sổ game', onclick: step(() => api.restoreLayout(), 'Đã xếp lại bố cục.') }, 'XẾP CỬA SỔ'),
      moreMenuButton(),
      el('button', { class: 'btn danger', title: 'Đóng cả 3 trình duyệt', onclick: () => closeBrowsers() }, 'ĐÓNG TẤT CẢ'));
  }
  // ONE stake for the whole session: the tool owns it, the in-page bars reuse it (they have no picker).
  async function onPickStake(value) {
    autoStake = value;
    if (api.setStake) { try { await api.setStake(value ? Number(value) : null); } catch { /* the next pick retries */ } }
    bgRender();
  }
  async function onAutoToggle(on) {
    if (on && !manualGroup && !autoStake) { note('Chọn Tiền trước khi bật Tự động.', true); renderApp(); return; }
    const creator = autoCreatorRunId();
    if (on && !manualGroup && !creator) { note('Chưa có acc nào vào game.', true); renderApp(); return; }
    autoBusy = true; note(on ? (manualGroup ? 'Bật tự động — giữ bàn hiện tại…' : 'Đang tạo bàn và gọi các acc vào…') : 'Tắt tự động.'); renderApp();
    let res; try { res = await api.setAuto(on, creator, autoStake ? Number(autoStake) : null); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    autoBusy = false;
    if (res && res.ok === false) note(errText(res), true);
    else if (on) note('Tự động đang giữ bàn ' + (res && res.rid != null ? res.rid : '') + '.');
    await refreshManual(); renderApp();
  }
  async function onChangeKey() {
    const g = manualGroup; if (!g) return;
    autoBusy = true; note('Đang tạo bàn mới với key mới…'); renderApp();
    let res; try { res = await api.changeKey(g.members.find((m) => m.role === 'KEY')?.id || autoCreatorRunId()); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    autoBusy = false;
    if (res && res.ok === false) note(errText(res), true); else note('Đã đổi sang bàn ' + (res && res.rid) + ' · key mới.');
    await refreshManual(); renderApp();
  }

  // §co-seat — "ĐỦ 3 ACC CÙNG BÀN", proven by the backend from EVERY browser's own TABLE_STATE ps[].
  function coSeatChip() {
    if (!coSeat) return el('span', { class: 'chip gray sm', title: 'Chưa có phiên nào đang chạy' }, 'CÙNG BÀN —');
    const n = coSeat.browserCount || 0;
    if (coSeat.ok) return el('span', { class: 'chip green sm', title: 'Cả ' + n + ' acc đã được máy chủ xác nhận trong CÙNG một bàn' + (coSeat.rid != null ? ' (' + coSeat.rid + ')' : '') }, '✓ ' + n + ' ACC CÙNG BÀN');
    if (coSeat.result === 'TABLE_MISMATCH') return el('span', { class: 'chip red sm', title: 'Máy chủ xếp các acc vào những bàn KHÁC nhau: ' + (coSeat.reason || '') }, '⚠ KHÁC BÀN');
    if (coSeat.result === 'PARTIAL_JOIN') return el('span', { class: 'chip yellow sm', title: 'Chưa đủ acc trong bàn: ' + (coSeat.reason || '') }, (coSeat.seatedCount || 0) + '/' + n + ' TRONG BÀN');
    return el('span', { class: 'chip gray sm', title: 'Chưa có acc nào giữ bàn chung' }, 'CÙNG BÀN —');
  }

  // Three compact account chips on ONE line (slot order A/B/C → B1/B2/B3).
  function compactBrowserRow() {
    const row = el('div', { class: 'acc-chips' });
    SLOTS.forEach((slot, i) => row.appendChild(compactBrowserCell(i + 1, slot, assign[slot].runId)));
    return row;
  }
  function compactBrowserCell(index, slot, runId) {
    const cs = (clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot]) || {};
    const chromiumClosed = !!(cs.browserState && cs.browserState !== 'OPEN' && cs.browserState !== 'NOT_OPEN');
    const opened = !!runId && !chromiumClosed;
    const inGame = opened && slotInPhom(runId);
    const b = (opened ? manualBrowserById(runId) : null) || { manualState: opened ? 'READY' : 'CLOSED', rid: null, lastError: null };
    const entering = opened && !inGame && !!manualEntering[runId];
    const enterErr = opened && !inGame && manualEnterError[runId];
    const inTable = inGame && b.manualState === 'JOINED' && b.rid != null;
    const st = !runId ? { label: 'CHƯA MỞ', cls: 'off' }
      : chromiumClosed ? { label: 'OFFLINE', cls: 'off' }
      : entering ? { label: 'ĐANG VÀO GAME', cls: 'warn' }
      : b.manualState === 'RECONNECTING' ? { label: 'BỊ ĐÁ → REJOIN', cls: 'warn' }
      : b.manualState === 'KICKED' ? { label: 'BỊ ĐÁ', cls: 'danger' }
      : b.manualState === 'JOINING' ? { label: 'ĐANG VÀO BÀN', cls: 'warn' }
      : b.manualState === 'SEARCHING' ? { label: 'ĐANG TÌM BÀN', cls: 'warn' }
      : inTable ? { label: 'TRONG BÀN', cls: 'ok' }
      : inGame ? { label: 'Ở SẢNH', cls: 'info' }
      : enterErr ? { label: 'LỖI VÀO GAME', cls: 'danger' }
      : { label: 'CHƯA VÀO GAME', cls: 'off' };
    const ACC = index === 1 ? '#2563eb' : index === 2 ? '#16a34a' : index === 3 ? '#ea580c' : '#6b7280';
    const account = b.username && b.username !== 'USER_UNKNOWN' ? b.username : '—';
    const wsOk = !!(b.connected && b.socketReady);
    const chip = el('div', { class: 'acc-chip st-' + st.cls, title: account + ' · ' + st.label + (wsOk ? ' · WS kết nối' : ' · WS mất kết nối') + (b.lastError ? ' · ' + (b.lastError.message || b.lastError.code) : '') },
      el('span', { class: 'b-badge', style: 'background:' + ACC + ';color:#fff' }, 'P' + index),
      account !== '—' ? el('span', { class: 'bc-acc', title: account }, account) : null,
      roleChip(b.groupRole, b.isTableHost),
      el('span', { class: 'bc-badge ' + st.cls, title: st.label, 'aria-label': st.label }, el('span', { class: 'status-dot ' + st.cls })),
      inTable && b.ready ? el('span', { class: 'ready-yes', title: 'Đã sẵn sàng' }, '✓') : null);
    if (!runId) chip.appendChild(el('span', { class: 'faint xs', title: 'Mở player ở tab PROFILE' }, 'Chưa mở'));
    else if (chromiumClosed) chip.appendChild(iconButton('monitor', 'Mở lại Chromium này', () => onReopenBrowser(slot)));
    else {
      if (!inGame) chip.appendChild(el('button', { class: 'btn sm primary', title: entering ? 'Đang vào game' : 'Vào game', 'aria-label': entering ? 'Đang vào game' : 'Vào game', disabled: entering ? 'disabled' : null, onclick: () => manualEnterGame(runId) }, entering ? '…' : '▶'));
      chip.appendChild(iconButton('refresh', 'Tải lại web trong Chromium này', () => onReloadWeb(runId)));
      chip.appendChild(iconButton('power', 'Tắt Chromium này', () => onCloseBrowser(slot, runId), 'danger'));
    }
    return chip;
  }

  // LỌC BÀI — for EACH of the three accounts: which cards the NEXT player cannot eat (only the next player may eat
  // a discard). When the next player is one of our accounts the verdict is exact; a stranger → public evidence.
  function renderSafeCards() {
    const box = el('div', { class: 'safe-cards', id: 'phq-safe' },
      el('div', { class: 'safe-head' }, el('div', { class: 'sc-title' }, el('span', { class: 'section-t' }, '🛡 LỌC BÀI'), el('span', { class: 'faint xs sc-sub' }, 'Lá người đánh sau KHÔNG ăn được'))));
    const cols = el('div', { class: 'safe-cols' });
    ['B1', 'B2', 'B3'].forEach((slot, i) => cols.appendChild(safeColumn(slot, i + 1)));
    box.appendChild(cols);
    return box;
  }
  function safeColumn(slot, index) {
    const a = safeBySlot[slot];
    const col = el('div', { class: 'safe-col' });
    const who = a && a.targetPlayerLabel ? playerLabel(a.targetPlayerLabel) : '';
    col.appendChild(el('div', { class: 'safe-col-head' }, el('b', null, 'P' + index), ' ', el('span', { class: 'faint xs' }, (who === 'P' + index ? '' : who) + (a && a.nextPlayerLabel ? ' · lượt sau: ' + playerLabel(a.nextPlayerLabel) : ''))));
    if (!a || a.status !== 'OK') { col.appendChild(el('div', { class: 'faint sm' }, 'Chưa có bài')); return col; }
    const safe = a.safeCards || []; const likely = a.likelySafeCards || []; const risky = a.riskyCards || []; const own = a.ownMeldCards || [];
    if (safe.length) { col.appendChild(el('div', { class: 'faint xs' }, 'NÊN ĐÁNH (điểm cao trước)')); col.appendChild(safeCardRow(safe, 'meld', a.recommendedCode)); }
    if (likely.length) { col.appendChild(el('div', { class: 'faint xs' }, 'CÓ THỂ AN TOÀN')); col.appendChild(safeCardRow(likely, '')); }
    if (risky.length) { col.appendChild(el('div', { class: 'faint xs' }, 'ĐỪNG ĐÁNH — người sau ăn được')); col.appendChild(safeCardRow(risky, 'risky')); }
    if (own.length) { col.appendChild(el('div', { class: 'faint xs' }, 'TRONG PHỎM — giữ lại')); col.appendChild(safeCardRow(own, 'own-meld')); }
    if (!safe.length && !likely.length && !risky.length) col.appendChild(el('div', { class: 'faint sm' }, 'Chưa đủ dữ liệu'));
    return col;
  }
  function safeCardRow(cards, extra, recommendedCode) {
    const row = el('div', { class: 'cards' });
    for (const c of cards) {
      const rec = recommendedCode != null && c.code === recommendedCode;
      const tip = (rec ? 'NÊN ĐÁNH — ' : '') + (c.points != null ? c.points + ' điểm · ' : '') + (c.reasonCodes || []).join(', ');
      row.appendChild(el('span', { class: 'card-face ' + (c.color === 'red' ? 'red' : 'black') + (extra ? ' ' + extra : '') + (rec ? ' recommended' : ''), title: tip }, el('b', null, c.rank || '?'), el('span', null, c.suit || '?')));
    }
    return row;
  }

  async function onReloadWeb(runId) {
    note('Đang tải lại web…');
    let res; try { res = await api.reloadWeb(runId); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    delete manualEntering[runId]; delete manualEnterError[runId];
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

  let entryTimer = null;
  function slotProfile(runId) { return (session && session.profiles || []).find((x) => x.id === runId) || null; }
  function slotInPhom(runId) { const p = slotProfile(runId); return !!(p && p.socketReady && p.connected && (p.channelCount || 0) > 0); }
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
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); openFrameCapture(); } }, 'Ghi gói (Test D)'),
      // The ONLY UI action that closes the browsers (explicit + confirmed) — DỪNG never does.
      el('button', { class: 'menu-item danger', onclick: (e) => { closeMore(e); closeBrowsers(); } }, 'ĐÓNG 3 TRÌNH DUYỆT'),
    );
    const wrap = el('div', { class: 'qa-more' },
      el('button', { class: 'btn', title: 'Tùy chọn', 'aria-label': 'Mở tùy chọn', onclick: () => {
        const overlay = el('div', { class: 'phq-analyzer more-overlay' });
        const close = () => { overlay.remove(); };
        menu.hidden = false; menu.classList.add('menu-dialog');
        overlay.appendChild(el('div', { class: 'anz-card more-card', role: 'dialog', 'aria-label': 'Tùy chọn' },
          el('div', { class: 'capture-heading' }, el('strong', null, 'Tùy chọn'), el('button', { class: 'btn sm', onclick: close }, 'Đóng')), menu));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
        document.body.appendChild(overlay); menu.querySelector('button')?.focus();
      } }, '⋯'),
    );
    function closeMore() { menu.closest('.more-overlay')?.remove(); }
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
  // TEST D — record the game client's OWN frames while the player acts by hand (e.g. clicks a table in the lobby),
  // then save them to a file (secrets redacted). This is how the real protocol for entering a table is read
  // instead of guessed. Passive: nothing is sent; it only watches the frames the tool already sees.
  async function openFrameCapture() {
    if (document.getElementById('ws-capture-dialog')) return;
    const overlay = el('div', { id: 'ws-capture-dialog', class: 'phq-analyzer' });
    const card = el('div', { class: 'anz-card capture-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ghi WebSocket — Test D' });
    let timer = null, busy = false, recording = false;
    const close = () => { clearInterval(timer); overlay.remove(); };
    const status = el('div', { class: 'capture-status', role: 'status', 'aria-live': 'polite' }, 'Đang kiểm tra trạng thái ghi…');
    const scope = el('select', { 'aria-label': 'Browser cần ghi' }, el('option', { value: '' }, 'Tất cả browser (khuyên dùng)'));
    for (const b of (manualBrowsers || []).slice().sort((a, b) => a.browserIndex - b.browserIndex)) scope.appendChild(el('option', { value: b.profileId }, `P${b.browserIndex}`));
    const out = el('pre', { class: 'capture-preview', hidden: true });
    const saved = el('div', { class: 'capture-saved' });
    const sync = () => { startBtn.disabled = busy || recording; stopBtn.disabled = busy || !recording; scope.disabled = busy || recording; };
    const poll = async () => {
      if (busy || !overlay.isConnected) return;
      try {
        const st = await api.framesRecordStatus();
        if (!overlay.isConnected || busy) return;
        if (!st || st.ok === false) throw new Error(errText(st));
        recording = !!st.recording;
        status.textContent = recording ? `● ĐANG GHI · ${st.frames || 0} gói${st.dropped ? ` · bỏ ${st.dropped} gói` : ''} · ${st.runIds?.length ? st.runIds.join(', ') : 'Tất cả browser'}` : 'Chưa ghi. Chọn browser rồi bấm BẮT ĐẦU GHI.';
        status.classList.toggle('recording', recording); sync();
      } catch { status.textContent = 'Không đọc được trạng thái ghi. Đóng và mở lại để thử lại.'; startBtn.disabled = true; stopBtn.disabled = true; }
    };
    const startBtn = el('button', { class: 'btn primary', disabled: true, onclick: async () => {
      if (busy || recording) return;
      busy = true; sync();
      try {
        const r = await api.framesRecordStart({ runIds: scope.value ? [scope.value] : null, label: 'Test D — WS', keepRoomCodes: false });
        if (!r || r.ok === false) throw new Error(errText(r));
        recording = true; if (!timer) timer = setInterval(poll, 1000); saved.replaceChildren(); out.hidden = true;
        status.textContent = '● ĐANG GHI · Hãy thao tác trong game.'; status.classList.add('recording');
      } catch (e) { status.textContent = 'Không bắt đầu được: ' + e.message; }
      finally { busy = false; sync(); }
    } }, 'BẮT ĐẦU GHI');
    const stopBtn = el('button', { class: 'btn capture-stop', disabled: true, onclick: async () => {
      if (busy || !recording) return;
      busy = true; sync();
      try {
        const r = await api.framesRecordStop();
        if (!r || r.ok === false) throw new Error(errText(r));
        recording = false; status.classList.remove('recording'); status.textContent = `Đã lưu ${r.frameCount} gói${r.dropped ? ` · bỏ ${r.dropped} gói` : ''}.`;
        saved.replaceChildren(el('div', null, r.txtPath || r.path), el('button', { class: 'btn sm', onclick: () => api.framesOpenFolder(r.txtPath || r.path) }, 'MỞ THƯ MỤC'));
        out.textContent = (r.preview || []).join('\n'); out.hidden = false;
        clearInterval(timer); timer = null;
      } catch (e) { status.textContent = 'Không lưu được: ' + e.message; }
      finally { busy = false; sync(); }
    } }, 'DỪNG & LƯU');
    card.appendChild(el('div', { class: 'capture-heading' }, el('strong', null, 'GHI WEBSOCKET · TEST D'), el('button', { class: 'btn sm', onclick: close }, 'Đóng')));
    card.appendChild(el('p', { class: 'note' }, '1. Bắt đầu ghi → 2. Thao tác trong game → 3. Dừng & lưu. Mã phòng được che; file JSON giữ dấu đối chiếu request/response.'));
    card.appendChild(el('label', { class: 'capture-scope' }, 'Phạm vi ghi', scope));
    card.appendChild(status);
    card.appendChild(el('div', { class: 'capture-actions' }, startBtn, stopBtn));
    card.appendChild(el('p', { class: 'note' }, 'Đóng cửa sổ này vẫn tiếp tục ghi. Mở lại GHI WS · TEST D để dừng và lưu.'));
    card.appendChild(saved); card.appendChild(out); overlay.appendChild(card); document.body.appendChild(overlay);
    await poll();
    if (overlay.isConnected) timer = setInterval(poll, 1000);
  }
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
      // Only poll what is actually on screen: not on the PROFILE tab, not while the window is hidden. Pushes
      // ('phom:ui', 'phom:session') keep the state current anyway; this is the fallback for an idle lobby.
      if (uiState !== UI.CONTROL || activeTab !== 'PHOM' || document.hidden) return;
      await ensurePassiveSession();
      try { session = await api.sessionState(); if (session && session.hands) hands = session.hands; } catch {}
      try { clusterSnap = await api.clusterSnapshot(); } catch {}
      // BUG #1 latency fix: when a run is logged in (socket+uid) but the coordinator hasn't seen the
      // stake channel list yet (channelCount 0), the game only re-sends it sparsely — so actively
      // request it once so PHỎM READY is detected in seconds, not after a long wait. This is a passive
      // read of the lobby's own list (not orchestration); harmless if it fails (typed, swallowed).
      // §35 — ask ONLY the browsers still missing the list (each individually), never all three.
      const needChannels = SLOTS.filter((sl) => { const p = slotProfile(assign[sl].runId); return p && p.socketReady && p.connected && !((p.channelCount || 0) > 0); });
      if (needChannels.length && phomSessionStarted) { for (const sl of needChannels) { try { await api.requestChannels(assign[sl].runId); } catch {} } }
      await refreshManual(); // PHASE 6.1 — keep the per-browser cards + Screen 2 + search-lock reconcile current
      reconcileEntryPhase();
      if (!$('workspace').hidden) bgRender();
    }, 2000);
  }
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
    // PHASE 6.3.1 — open the 3 SELECTED profiles as B1/B2/B3 (selection order). No cluster profile.
    if (selectedProfileIds.length !== 3) { note('Chọn đúng 3 profile trong bảng trước khi mở.', true); return; }
    // PHASE 6.3.2.1 — each profile carries its OWN Game URL (edited in Edit Profile). No RUN-time URL prompt.
    if (!localTest) {
      const missing = selectedProfileIds.filter((id) => { const p = profilesX.find((x) => x.id === id); return !(p && p.gameUrl && String(p.gameUrl).trim()); }).map((id) => { const p = profilesX.find((x) => x.id === id); return p ? p.name : id; });
      if (missing.length) { note(`Thiếu Game URL cho: ${missing.join(', ')}. Mở Sửa profile để nhập.`, true); return; }
    }
    // §41 — a fast double-click must not open a second cluster / duplicate browser runs.
    if (clusterOpBusy) { note('Đang mở — vui lòng chờ…', true); return; }
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
      // PHASE 6.3.1 — create the cluster from the SELECTED profiles (order → B1/B2/B3) + game URL.
      // No global gameUrl — each profile opens with its OWN saved gameUrl (main resolves per profileId).
      const created = await api.openSelected({ profileIds: selectedProfileIds, localTest });
      if (created && created.ok === false) throw created;
      if (created && created.localTest != null) localTest = created.localTest;
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

  // ================= PHASE 6.1 — MANUAL PER-BROWSER CONTROL (Browser 1/2/3) =================
  // Consumes the tested Phase-6 backend (manualFind/Join/Rejoin/Leave/Snapshot + remainingCards) and the
  // pure search-lock/shared-RID module (window.ManualClusterState). No Host/Follower role; no game DOM
  // touch; usernames + cards come from authoritative snapshots only.

  // Refresh the manual snapshot + remaining cards, then reconcile the shared-room lifecycle (§18).
  // ONE IPC for the whole screen (browsers + group + cards + remaining + the three analyses). Main builds it and
  // also PUSHES the same object, so a live round costs one message per tick instead of six round-trips.
  async function refreshManual() {
    let snap = null;
    try { snap = await api.uiSnapshot(); } catch { snap = null; }
    applyUiSnapshot(snap);
  }
  function applyUiSnapshot(snap) {
    if (!snap) { manualBrowsers = []; coSeat = null; manualGroup = null; remaining = null; cardsSnap = null; safeBySlot = {}; return; }
    manualBrowsers = snap.browsers || [];
    coSeat = snap.coSeat || null;
    manualGroup = snap.group || null;
    remaining = snap.remaining && snap.remaining.ok !== false ? snap.remaining : (snap.remaining || null);
    cardsSnap = snap.cards || null;
    safeBySlot = snap.analyses || {};
    const seatedStake = (manualBrowsers.find((b) => b.manualState === 'JOINED' && b.stake != null) || {}).stake;
    manualCluster = { sharedRid: snap.sharedRid != null ? snap.sharedRid : null, sharedRidOwner: snap.sharedRidOwner || null, sharedStake: seatedStake != null ? seatedStake : null };
    reconcileEnterStates(); // clear ĐANG VÀO GAME once the browser is authoritatively in game
  }
  function manualBrowserById(id) { return manualBrowsers.find((b) => String(b.profileId) === String(id)) || null; }
  function renderRemainingCards() {
    // CARDS REMAINING (= LÁ BÀI CÒN LẠI): observer remaining preferred, else the backend 3-hands view.
    const box = el('div', { class: 'remaining-cards', id: 'phq-remaining' });
    const obs = cardsSnap && cardsSnap.remaining ? cardsSnap.remaining : null;
    const observing = !!(obs && obs.knownOutCount === 0);
    const view = obs && !observing ? obs : (remaining && remaining.cards ? { cards: remaining.cards, count: remaining.count } : null);
    // PHASE 6.3.9 — title + subtitle ("Chưa an toàn") + count · a NEUTRAL panel (never a negative label, §9.2).
    box.appendChild(el('div', { class: 'safe-head' },
      el('div', { class: 'sc-title' },
        el('span', { class: 'section-t' }, '🂠 CÁC LÁ BÀI CÒN LẠI'),
        el('span', { class: 'faint xs sc-sub' }, 'Chưa an toàn' + (view ? (' · ' + view.count + ' lá') : '')))));
    if (!view) { box.appendChild(el('div', { class: 'cards' }, el('span', { class: 'faint sm' }, 'Đang quan sát…'))); return box; }
    const cards = Array.isArray(view.cards) ? view.cards : [];
    const row = el('div', { class: 'cards' });
    if (!cards.length) row.appendChild(el('span', { class: 'faint' }, '—'));
    for (const c of cards) row.appendChild(el('span', { class: 'card-face ' + (c.color === 'red' ? 'red' : 'black') }, el('b', null, c.rank || '?'), el('span', null, c.suit || '?')));
    box.appendChild(row);
    return box;
  }

  // ---------- helpers ----------
  function browserCount() { return SLOTS.filter((s) => assign[s].runId).length; }
  function errText(res) { const e = res && res.error; return e ? `${e.code}: ${e.message}` : 'Thao tác thất bại.'; }
  function note(msg, warn) { const n = $('phq-note'); if (n) { n.textContent = msg; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }

  // ---------- boot ----------
  if (api.onSession) api.onSession((snap) => { session = snap; if (snap && snap.hands) hands = snap.hands; reconcileEntryPhase(); advanceAutoFlow(snap); if (!$('workspace').hidden) bgRender(); });
  // PHASE 6.1 — card state changed: refresh Screen 2 remaining cards + per-browser membership, then re-render.
  if (api.onHands) api.onHands((h) => { hands = h; bgRender(); }); // the cards themselves arrive with the ui push
  // PHASE 6.3.3.2 — a fresh card-observation snapshot arrived (push). Store it + re-render Screen 2.
  // One push carries the whole screen state (main already coalesces it), so nothing is fetched on receipt.
  if (api.onUi) api.onUi((snap) => { applyUiSnapshot(snap); if (!$('workspace').hidden && uiState === UI.CONTROL) bgRender(); });
  // The group flow reports what it just did; show it on the note line (one short sentence, never a code).
  if (api.onNotice) api.onNotice((n) => { const t = noticeText(n); if (t) note(t, /KICK|FAIL|LOST|EXHAUST/.test(n.event)); });
  // PHASE 6.3.6 — reflect the current finder choice on load (main owns it; renderer mirrors for the selector UI).
  if (api.onLicense) api.onLicense((s) => { if (s && s.active && !$('activation').hidden) boot(); });
  if (api.onCluster) api.onCluster((snap) => { clusterSnap = snap; if (!$('workspace').hidden && (uiState === UI.CONTROL || uiState === UI.OPENING_CLUSTER)) bgRender(); });
  // Auto ReJoin: when the domain reports a kicked controlled profile, recover it (the
  // coordinator enforces debounce/cooldown/bounded retry + round-active defer — §15).
  if (api.onKick) api.onKick(() => { if (uiState === UI.CONTROL) refreshManual().then(bgRender); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
