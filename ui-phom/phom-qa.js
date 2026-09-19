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
  const MCS = (typeof window !== 'undefined' && window.ManualClusterState) ? window.ManualClusterState : null;
  let manualCluster = MCS ? MCS.create() : { searchingBrowserId: null, sharedRid: null, sharedRidOwner: null };
  let manualBrowsers = [];   // last manualBrowserSnapshot() (per-browser independent state)
  let remaining = null;      // last remainingCards() view for Screen 2
  // PHASE 6.3.3.2 — last card-observation snapshot (players/discards/melds/remaining/capabilities). Read-only
  // data binding for Screen 2; the analysis ANGLE (selectedAnalysisPlayer) never merges the three hands (§20).
  let cardsSnap = null;
  // PHASE 6.3.3.3 — the SAFE CARD ANALYZER angle. `selectedAnalysisPlayer` is the CANONICAL target selection
  // (a slot B1/B2/B3 = Player 1/2/3; presentation only). It resolves to an authoritative uid via
  // cardsSnap.slotBinding and is passed to the read-only analyzer; the three hands are never merged (§5/§20).
  let selectedAnalysisPlayer = null;
  let safeAnalysis = null;     // last read-only analyzer result for the selected target
  // PHASE 6.3.6 — the USER-selected FINDER (room anchor) slot (B1/B2/B3), or null = none chosen (every browser
  // may FIND). SEPARATE from selectedAnalysisPlayer: Finder ≠ Analysis is fully valid (e.g. Finder B2, Analysis B3).
  let selectedFinderPlayer = null;
  let manualStake = '';      // (deprecated 6.2.1) — stake now comes from the discovered server table
  const ridDraft = {};       // per-browser Room/RID input draft (browserId -> string)
  const manualEntering = {}; // browserId -> true while VÀO GAME is in flight (real ENTERING state, §5)
  const manualEnterError = {}; // browserId -> message when VÀO GAME failed/timed out (retryable)
  const manualEnterTimers = {}; // browserId -> bounded entry timeout handle
  const manualJoining = {};  // browserId -> true while VÀO BÀN (join shared RID) is in flight (§4)
  const selectedStakeByBrowser = {}; // PHASE 6.2.3 — the finder's chosen REAL stake (from server bet options)
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
  // displayed label becomes "Player N". browserOf()/mapProxies() are unchanged — this maps at render time.
  const playerLabel = (b) => { const m = /^B(\d+)$/.exec(String(b == null ? '' : b)); return m ? 'Player ' + m[1] : String(b == null ? '' : b); };

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
  // PHASE 6.3.1 — SETUP = a flexible device-profiles TABLE (manage + select), a Game URL, bulk proxy, and
  // the RUN GAME CTA. The table checkbox is the ONLY selection UI (no B1/B2/B3 dropdowns, no selected-
  // profile panel, no cluster/CỤM concept). Selection order → B1/B2/B3.
  // PHASE 6.3.2.1 — a header + a SINGLE scrollable page (all panels) + a sticky footer (count + MỞ 3
   // TRÌNH DUYỆT). No global Game URL input: the URL is a per-profile property, edited in Edit Profile.
  function renderSetup(r) {
    // PHASE 6.3.9 — the unified tab bar already carries brand + license; no redundant SETUP sub-header here.
    r.appendChild(el('div', { class: 'note s1-note', id: 'phq-note' }, ''));
    const page = el('div', { class: 'setup-page' });
    // PHASE 6.3.9/6.3.10 — Profile is the compact table + a COMPACT quick bulk-proxy import (one line = one
    // proxy, mapped B1→B2→B3 by profile order). Per-profile proxy still edits in the row's Edit modal.
    page.appendChild(profileTablePanel());
    page.appendChild(bulkProxyQuickPanel());
    r.appendChild(page);
    r.appendChild(runGameFooter());
  }

  // PHASE 6.3.2.2 — BROWSER RUNTIME selector (AUTO / Custom Chromium / Google Chrome). AUTO prefers the
  // packaged custom Chromium and falls back to Chrome. Persisted; per-profile user-data-dir/cookie/URL are
  // unaffected by the choice. Read-only availability hints come from the main resolver.
  function browserRuntimePanel() {
    const panel = el('div', { class: 'setup-panel' });
    panel.appendChild(el('div', { class: 'setup-section-h' }, el('span', { class: 'h-title' }, 'BROWSER RUNTIME ', el('span', { class: 'faint sm' }, '· engine chạy 3 trình duyệt'))));
    const body = el('div', { style: 'padding:0 12px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap' });
    const rt = browserRuntimeInfo || {};
    const opt = (val, label) => el('option', { value: val, selected: (rt.preference || 'AUTO') === val ? 'selected' : null }, label);
    const sel = el('select', { class: 'sel sm', onchange: async (e) => { const res = await api.browserRuntimeSet({ preference: e.target.value }); if (res && res.ok) { await refreshBrowserRuntime(); renderApp(); } } },
      opt('AUTO', 'AUTO (Chromium → Chrome)'), opt('CUSTOM_CHROMIUM', 'Custom Chromium'), opt('GOOGLE_CHROME', 'Google Chrome'));
    body.appendChild(sel);
    if (rt.resolved && rt.resolved.kind) body.appendChild(el('span', { class: 'chip sm ' + (rt.resolved.fellBack ? 'yellow' : 'green') }, 'Đang dùng: ' + (rt.resolved.kind === 'chrome' ? 'Google Chrome' : 'Custom Chromium') + (rt.resolved.fellBack ? ' (fallback)' : '')));
    body.appendChild(el('span', { class: 'faint sm' }, 'Chromium: ' + (rt.customAvailable ? '✓' : '—') + ' · Chrome: ' + (rt.chromeAvailable ? '✓' : '—')));
    panel.appendChild(body);
    return panel;
  }

  // DEVICE PROFILES table — manage (add/edit/delete) + select (checkbox, max 3, order → B1/B2/B3).
  function profileTablePanel() {
    // PHASE 6.3.3.1 — the profile table is the FLEXIBLE primary area (`profile-panel` → flex:1); it fills
    // unused Tool height and scrolls INTERNALLY, so the proxy block + footer stay put (no page-level scroll).
    const panel = el('div', { class: 'setup-panel profile-panel' });
    const n = selectedProfileIds.length;
    panel.appendChild(el('div', { class: 'setup-section-h' },
      el('span', { class: 'h-title' }, 'DEVICE PROFILES ', el('span', { class: 'faint sm' }, `· ĐÃ CHỌN ${n} / 3`)),
      el('button', { class: 'btn primary sm', onclick: () => openProfileModal(null) }, icon('plus', { sm: true }), ' THÊM PROFILE')));
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

  // BULK PROXY — one proxy per line, mapped to the SELECTED profiles BY ORDER (§20/§21/§22).
  function bulkProxyPanel() {
    const panel = el('div', { class: 'setup-panel' });
    panel.appendChild(el('div', { class: 'setup-section-h' }, el('span', { class: 'h-title' }, 'PROXY ', el('span', { class: 'faint sm' }, '· mỗi dòng một proxy, theo thứ tự chọn'))));
    const body = el('div', { style: 'padding:0 12px 12px' });
    // compact selection-order preview
    if (selectedProfileIds.length) {
      const prev = el('div', { class: 'faint sm', style: 'margin-bottom:6px' });
      selectedProfileIds.forEach((id, i) => { const p = profilesX.find((x) => x.id === id); prev.appendChild(el('span', { style: 'margin-right:10px' }, `Player ${i + 1} → ${p ? p.name : id}`)); });
      body.appendChild(prev);
    }
    body.appendChild(el('textarea', { class: 'f mono', id: 'phq-bulkproxy', rows: '3', style: 'width:100%', placeholder: 'host:port:user:pass\nhost:port\n…', oninput: (e) => { bulkProxyText = e.target.value; } }, bulkProxyText));
    body.appendChild(el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn sm', onclick: applyBulkProxy }, 'ÁP DỤNG PROXY'), el('span', { class: 'note', id: 'phq-proxynote', style: 'margin-left:8px' }, '')));
    panel.appendChild(body);
    return panel;
  }

  // PHASE 6.3.10 — COMPACT quick bulk-proxy import. ONE LINE = ONE proxy (TYPE|host|port|user|pass); NEWLINE
  // maps to the NEXT profile BY ORDER (line 1 → B1, line 2 → B2, …). Reuses the existing proxy schema +
  // profileSetProxy (no new storage/IPC). This is SEPARATE from the per-row ⚡ Quick Proxy in Edit Profile.
  function bulkProxyQuickPanel() {
    const panel = el('div', { class: 'setup-panel bulk-proxy-quick' });
    panel.appendChild(el('div', { class: 'setup-section-h' },
      el('span', { class: 'h-title' }, 'THÊM NHANH PROXY ', el('span', { class: 'faint sm' }, '· mỗi dòng = 1 proxy · theo thứ tự B1 → B2 → B3'))));
    const body = el('div', { style: 'padding:0 12px 12px' });
    const ta = el('textarea', { class: 'f mono', id: 'phq-bulkproxy-quick', rows: '3', style: 'width:100%', placeholder: 'HTTP|host|port|user|pass\nHTTP|host|port|user|pass\nSOCKS5|host|port|user|pass', oninput: (e) => { bulkProxyText = e.target.value; } }, bulkProxyText);
    body.appendChild(ta);
    body.appendChild(el('div', { style: 'margin-top:8px;display:flex;gap:8px;align-items:center' },
      el('button', { class: 'btn sm', title: 'Chèn mẫu định dạng', onclick: () => { ta.value = (BP ? BP.TEMPLATE : ''); bulkProxyText = ta.value; ta.focus(); } }, 'MẪU'),
      el('button', { class: 'btn primary sm', onclick: applyBulkProxyQuick }, '⚡ ÁP DỤNG'),
      el('span', { class: 'note', id: 'phq-bulkproxy-note' }, '')));
    panel.appendChild(body);
    return panel;
  }
  async function applyBulkProxyQuick() {
    const note = $('phq-bulkproxy-note');
    const setNote = (msg, warn) => { const n = $('phq-bulkproxy-note'); if (n) { n.textContent = msg; n.className = 'note ' + (warn ? 'warn' : 'ok'); } };
    if (!BP) return;
    // 1) Parse + validate EVERY line first (all-or-nothing — nothing is applied until all pass, §6).
    const parsed = BP.parse(bulkProxyText);
    if (!parsed.ok) return setNote(parsed.error.message, true);
    if (!parsed.proxies.length) return setNote('Chưa có proxy nào để áp dụng.', true);
    // 2) Map to profiles BY ORDER (not selection); MORE proxies than profiles is rejected (§3/§7).
    const ids = profilesX.map((p) => p.id);
    const mapped = BP.mapToProfiles(parsed.proxies, ids);
    if (!mapped.ok) return setNote(mapped.error.message, true);
    // 3) Apply via the EXISTING profileSetProxy (per profile, in order). Passwords are never logged/echoed.
    for (const m of mapped.mapping) {
      const r = await api.profileSetProxy(m.profileId, m.proxy);
      if (r && r.ok === false) { await refreshProfilesX(); await refreshProxies(); renderApp(); return setNote(`Proxy dòng ${m.index + 1}: ${errText(r)}`, true); }
    }
    await refreshProfilesX(); await refreshProxies(); renderApp();
    setNote(`Đã áp dụng ${mapped.mapping.length} proxy theo thứ tự B1 → B2 → B3.`, false);
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
  async function applyBulkProxy() {
    const pn = $('phq-proxynote');
    if (!PS) return;
    const res = PS.mapProxies(selectedProfileIds, bulkProxyText);
    if (!res.ok) { if (pn) { pn.textContent = res.error === 'PROXY_COUNT_MISMATCH' ? `Cần đúng ${res.expected} proxy (đang có ${res.got}).` : 'Chọn 3 profile trước.'; pn.className = 'note warn'; } return; }
    for (const m of res.mapping) { const r = await api.profileSetProxy(m.profileId, m.proxy); if (r && r.ok === false) { if (pn) { pn.textContent = `${playerLabel(m.browser)}: ${errText(r)}`; pn.className = 'note warn'; } return; } }
    await refreshProfilesX(); renderApp();
    const pn2 = $('phq-proxynote'); if (pn2) { pn2.textContent = 'Đã áp dụng proxy theo thứ tự chọn.'; pn2.className = 'note ok'; }
  }
  // Add/Edit profile modal (name · type preset · OS window w/h · viewport w/h · touch). OS window ⟂ viewport.
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
      el('div', { class: 'phq-row' }, el('span', null, 'Proxy'), el('input', { class: 'f mono', id: 'pf-proxy', placeholder: 'host:port  hoặc  host:port:user:pass', value: '' })),
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
      else if (removeProxy) { await api.profileSetProxy(pid, null); }
    }
    close(); await refreshProfilesX(); renderApp();
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

  // LEFT panel 2 — THIẾT BỊ VÀ PROXY ĐÃ GÁN, rendered as a DEVICE PROFILES TABLE (§9/§10): one row per
  // browser (B1/B2/B3) with Type / OS Window / Viewport / Proxy columns + an Edit icon. No proxy
  // selector/Test here (Quick Proxy is the config surface). Data model unchanged (still the 3 slots).
  const SLOT_INDEX = { A: '1', B: '2', C: '3' };
  const TYPE_LABEL = { DESKTOP: 'Desktop', LAPTOP: 'Laptop', LAPTOP_SMALL: 'Laptop Small', MOBILE_LANDSCAPE: 'Mobile Ngang', DESKTOP_16_9: 'Desktop 22/24"', CUSTOM: 'Custom' };
  function panelAssigned() {
    const panel = el('div', { class: 's1-panel setup-panel' });
    panel.appendChild(el('div', { class: 'setup-section-h' }, el('span', { class: 'h-title s1-panel-t' }, 'THIẾT BỊ VÀ PROXY ĐÃ GÁN')));
    const table = el('table', { class: 'setup-table' });
    table.appendChild(el('thead', null, el('tr', null,
      el('th', null, ''), el('th', null, 'PROFILE'), el('th', null, 'TYPE'), el('th', null, 'OS WINDOW'), el('th', null, 'VIEWPORT'), el('th', null, 'PROXY'), el('th', null, ''))));
    const tbody = el('tbody');
    for (const slot of SLOTS) tbody.appendChild(assignedRow(slot));
    table.appendChild(tbody);
    panel.appendChild(table);
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
    // §8/§13 — OS window and game viewport are independent axes; show both columns.
    const typeText = dev ? (TYPE_LABEL[dev.profileType] || dev.profileType || '—') : '—';
    const osText = dev ? (dev.osWindow || (dev.osWindowWidth ? `${dev.osWindowWidth}×${dev.osWindowHeight}` : 'Desktop')) : '—';
    const vpText = dev ? dev.resolution : '—';
    return el('tr', { class: 'prow s1', id: 'setup-' + slot },
      el('td', { class: 'col-tag' }, SLOT_INDEX[slot] || slot),
      el('td', { class: 'col-name', title: dev ? dev.name : '(chưa tạo thiết bị)' }, dev ? dev.name : el('span', { class: 'faint' }, '(chưa tạo)')),
      el('td', null, typeText),
      el('td', { class: 'num' }, osText),
      el('td', { class: 'num' }, vpText),
      el('td', { class: 'ar-px', title: pxText }, el('span', { class: 'badge ' + testBadge(status) }, status)),
      el('td', null, iconButton('edit', dev ? 'Sửa thiết bị' : 'Tạo thiết bị', () => openDeviceModal(slot))),
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
  // PHASE 6.3.3 — Screen 2 priority is INVERTED: B1/B2/B3 shrink to a compact one-row status header at the
  // TOP; the CARD WORKSPACE (LÁ BÀI AN TOÀN + LÁ BÀI CÒN LẠI) becomes the dominant flex-growing area.
  function renderControl(r) {
    r.appendChild(compactHeader());
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));
    r.appendChild(compactBrowserRow());
    r.appendChild(finderSelector());
    r.appendChild(renderCardWorkspace());
  }
  // PHASE 6.3.6 — USER picks which Player is the FINDER (room anchor). No finder → every Player may TÌM BÀN;
  // pick one → only that Player finds, the others show "CHỜ PLAYER N TÌM BÀN". Re-clicking clears (back to all).
  // SEPARATE from PHÂN TÍCH (analysis): a Finder ≠ Analysis player is fully valid. Reuses the analysis-pick style.
  function finderSelector() {
    const wrap = el('div', { class: 'analysis-pick finder-pick' }, el('span', { class: 'faint xs' }, 'FINDER:'));
    ['B1', 'B2', 'B3'].forEach((slot, i) => {
      const active = selectedFinderPlayer === slot;
      wrap.appendChild(el('button', { class: 'btn sm' + (active ? ' primary' : ''), onclick: () => onSelectFinder(active ? null : slot) }, 'Player ' + (i + 1)));
    });
    wrap.appendChild(el('span', { class: 'faint xs' }, selectedFinderPlayer ? '' : ' (chưa chọn — mọi Player đều TÌM BÀN)'));
    return wrap;
  }
  function onSelectFinder(slot) {
    selectedFinderPlayer = slot; // 'B1'/'B2'/'B3' or null (toggle off)
    const index = slot ? Number(slot.slice(1)) : null;
    if (api.setFinder) { try { api.setFinder(index); } catch (e) { /* header derivation still updates on next push */ } }
    bgRender();
  }
  // The dominant content area: the two card sections, growing with the Tool window (§5).
  function renderCardWorkspace() {
    const ws = el('div', { class: 'card-workspace' });
    ws.appendChild(renderSafeCards());
    ws.appendChild(renderRemainingCards());
    return ws;
  }

  // Low header: product · shared BÀN (RID) · CƯỢC (stake) · CÒN LẠI · overflow menu · ready dot. BÀN and
  // CƯỢC are SERVER-DERIVED from the discovered table (never a user-entered stake — §8/§11/§12).
  function compactHeader() {
    const rid = manualCluster.sharedRid != null ? String(manualCluster.sharedRid) : '—';
    const stake = manualCluster.sharedStake != null ? String(manualCluster.sharedStake) : '—';
    const anyOpen = SLOTS.some((s) => assign[s].runId);
    // PHASE 6.3.9 — compact top line: BÀN (RID) · CƯỢC · 🂠 TỔNG LÁ ẨN. Brand lives in the header tab bar now.
    // The ⋯ overflow is kept ONLY as the sole home of ĐÓNG 3 TRÌNH DUYỆT / Rời bàn / offline QA (no duplicate).
    return el('div', { class: 'tool-header' },
      el('span', { class: 'th-rid' }, 'BÀN: ', el('b', null, rid)),
      el('span', { class: 'th-bet' }, 'CƯỢC: ', el('b', null, stake)),
      el('span', { class: 'th-still' }, '🂠 TỔNG LÁ ẨN: ', el('b', null, remaining ? String(remaining.count) : '—')),
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
  // PHASE 6.3 — a professional browser PANEL (card): header (B# + status badge) · device meta · body
  // (single business action) · footer (icon buttons). Presentation only — all handlers unchanged.
  function compactBrowserCell(index, slot, runId) {
    const cs = (clusterSnap && clusterSnap.profiles && clusterSnap.profiles[slot]) || {};
    const chromiumClosed = !!(cs.browserState && cs.browserState !== 'OPEN' && cs.browserState !== 'NOT_OPEN');
    const opened = !!runId && !chromiumClosed;
    const inGame = opened && slotInPhom(runId);
    const mb = opened ? manualBrowserById(runId) : null;
    const b = mb || { profileId: runId, manualState: opened ? 'READY' : 'CLOSED', canRejoin: false, rid: null, lastError: null };
    const entering = opened && !inGame && !!manualEntering[runId];
    const joining = opened && inGame && !!manualJoining[runId];
    const enterErr = opened && !inGame && manualEnterError[runId];
    const joinedShared = opened && inGame && b.manualState === 'JOINED' && manualCluster.sharedRid != null && Number(b.rid) === Number(manualCluster.sharedRid);
    const st = !runId ? { label: 'CHƯA MỞ', cls: 'off' }
      : chromiumClosed ? { label: 'OFFLINE', cls: 'off' }
      : entering ? { label: 'ĐANG VÀO GAME', cls: 'warn' }
      : joining ? { label: 'ĐANG VÀO BÀN', cls: 'warn' }
      : b.manualState === 'SEARCHING' ? { label: 'ĐANG TÌM BÀN', cls: 'warn' }
      : joinedShared ? { label: 'ĐÃ VÀO BÀN', cls: 'ok' }
      : inGame ? { label: 'ĐÃ VÀO GAME', cls: 'ok' }
      : enterErr ? { label: 'LỖI VÀO GAME', cls: 'danger' }
      : { label: 'ONLINE', cls: 'info' };
    // PHASE 6.3.3 — COMPACT read-only status chip (ONE row). Screen 2 stays read-only: game actions live in
    // the in-Chromium header. The chip mirrors only essentials — B# · ACCOUNT (truncated) · STATE badge ·
    // WS/CDP/HEADER mini-dots — plus browser lifecycle (↻ / ⏻ / MỞ CHROMIUM). RID is NOT repeated here (it is
    // shared and shown ONCE in the tool header, §3). No game-control buttons.
    const cell = el('div', { class: 'browser-cell st-' + st.cls });
    // PHASE 6.3.9 — compact identity: [open?] · colored B# badge · Player N (matches the mockup player row).
    // Accent is by browser INDEX (1/2/3), not the internal slot id (A/B/C).
    const ACC = index === 1 ? '#2563eb' : index === 2 ? '#16a34a' : index === 3 ? '#ea580c' : '#6b7280';
    cell.appendChild(el('input', { type: 'checkbox', class: 'bc-cb', checked: opened ? 'checked' : null, disabled: true, title: opened ? 'Đang mở' : 'Chưa mở' }));
    cell.appendChild(el('span', { class: 'b-badge', style: 'background:' + ACC + ';color:#fff' }, 'B' + index));
    cell.appendChild(el('span', { class: 'bc-id' }, 'Player ' + index));
    // PHASE 6.3.6 — mark which Player the USER chose as FINDER (room anchor); never defaulted to Player 1.
    if (selectedFinderPlayer === slot) cell.appendChild(el('span', { class: 'gbadge good', title: 'Player này là FINDER (tìm bàn / room anchor)' }, 'FINDER'));
    if (!runId) { cell.appendChild(el('span', { class: 'faint sm bc-hint' }, 'Mở ở SETUP')); return cell; }
    if (chromiumClosed) {
      cell.appendChild(el('span', { class: 'bc-badge off' }, el('span', { class: 'status-dot off' }), 'OFFLINE'));
      cell.appendChild(el('div', { class: 'bc-life' }, iconButton('monitor', 'Mở lại Chromium này', () => onReopenBrowser(slot))));
      return cell;
    }
    const account = (mb && mb.username && mb.username !== 'USER_UNKNOWN') ? mb.username : '—';
    // RUNTIME kind (Chromium/Chrome) is diagnostic + rarely changes → kept compactly in the chip tooltip
    // (not a visible row) so the compact header stays one line.
    const rtKind = mb && mb.runtimeKind ? (mb.runtimeKind === 'chrome' ? 'Chrome' : 'Chromium') : '—';
    cell.appendChild(el('span', { class: 'bc-acc', title: 'ACCOUNT: ' + account + ' · RUNTIME: ' + rtKind }, account));
    cell.appendChild(el('span', { class: 'bc-badge ' + st.cls }, el('span', { class: 'status-dot ' + st.cls }), st.label));
    // WS / CDP / HEADER as compact mini-dots (title carries the full text) — essential connection status only.
    const wsOk = !!(mb && mb.connected && mb.socketReady);
    const cdpOk = mb && mb.cdp === 'CONNECTED';
    const hdr = mb && mb.header;
    const hdrCls = hdr === 'READY' ? 'ok' : hdr === 'RECOVERING' ? 'warn' : 'off';
    const dot = (label, cls, title) => el('span', { class: 'mini-dot ' + cls, title }, label);
    cell.appendChild(el('div', { class: 'bc-dots' },
      dot('WS', wsOk ? 'ok' : 'off', 'WebSocket: ' + (wsOk ? 'Kết nối' : 'Mất kết nối')),
      dot('CDP', cdpOk ? 'ok' : 'off', 'CDP: ' + (cdpOk ? 'Kết nối' : 'Mất kết nối')),
      dot('HDR', hdrCls, 'Header: ' + (hdr === 'READY' ? 'Sẵn sàng' : hdr === 'RECOVERING' ? 'Đang khôi phục' : 'Chưa sẵn sàng'))));
    // lifecycle only (never game control): ↻ WEB + ⏻ — compact icon buttons.
    cell.appendChild(el('div', { class: 'bc-life' },
      iconButton('refresh', 'Tải lại / mở lại web trong chính Chromium này (Reload web)', () => onReloadWeb(runId)),
      iconButton('power', 'Tắt Chromium này (không đóng Tool/các browser khác)', () => onCloseBrowser(slot, runId), 'danger')));
    return cell;
  }
  // PHASE 6.3.3 — LÁ BÀI AN TOÀN placeholder region (UI structure only; the analysis is a future Monitor
  // feature — no card logic added here). It reserves the top of the card workspace so the future feature
  // fills it. Empty state is explicit; nothing is fabricated.
  // PHASE 6.3.3.3 — LÁ BÀI AN TOÀN is now bound to the read-only SAFE CARD ANALYZER. The user picks ONE
  // Player (1/2/3) as the analysis angle; the analyzer classifies THAT player's own cards from PUBLIC
  // observed data. It only DISPLAYS — never plays, discards or clicks (§2/§18/§22). Nothing is shown SAFE
  // without proof; insufficient evidence renders an explicit state, never a fake number (§13/§24).
  function renderSafeCards() {
    const box = el('div', { class: 'safe-cards', id: 'phq-safe' });
    // PHASE 6.3.9 — title + subtitle ("Không ăn gà") + count · a subtle green-accent section (not a full green bg).
    const a = safeAnalysis;
    const safeCount = (selectedAnalysisPlayer && a) ? ((a.safeCards || []).length + (a.likelySafeCards || []).length) : 0;
    box.appendChild(el('div', { class: 'safe-head' },
      el('div', { class: 'sc-title' },
        el('span', { class: 'section-t' }, '🛡 LÁ BÀI AN TOÀN'),
        el('span', { class: 'faint xs sc-sub' }, selectedAnalysisPlayer ? ('Không ăn gà · ' + safeCount + ' lá') : 'Không ăn gà')),
      playerAnalysisSelector()));
    box.appendChild(renderSafeBody());
    box.appendChild(el('div', { class: 'faint xs safe-src' }, 'Phân tích từ dữ liệu công khai đã quan sát'));
    return box;
  }
  // PHÂN TÍCH CHO: [Tất cả] [B1] [B2] [B3]. "Tất cả" = no single player (aggregate remaining view; the SAFE
  // analysis stays per-player — never merged, §20). SEPARATE from the finder selector.
  function playerAnalysisSelector() {
    const wrap = el('div', { class: 'analysis-pick' }, el('span', { class: 'faint xs' }, 'PHÂN TÍCH CHO:'));
    wrap.appendChild(el('button', { class: 'btn sm' + (!selectedAnalysisPlayer ? ' primary' : ''), onclick: () => { selectedAnalysisPlayer = null; refreshSafeAnalysis().then(() => bgRender()); } }, 'Tất cả'));
    ['B1', 'B2', 'B3'].forEach((slot, i) => {
      const active = selectedAnalysisPlayer === slot;
      wrap.appendChild(el('button', { class: 'btn sm' + (active ? ' primary' : ''), onclick: () => { selectedAnalysisPlayer = active ? null : slot; refreshSafeAnalysis().then(() => bgRender()); } }, 'B' + (i + 1)));
    });
    return wrap;
  }
  function renderSafeBody() {
    if (!selectedAnalysisPlayer) return el('div', { class: 'cards' }, el('span', { class: 'faint sm' }, 'Chọn B1 / B2 / B3 để xem lá an toàn của player đó'));
    const a = safeAnalysis;
    if (!a || a.status === 'NO_HAND' || a.status === 'TARGET_NOT_FOUND' || a.status === 'NO_TARGET') return el('div', { class: 'cards' }, el('span', { class: 'faint sm' }, 'ĐANG CHỜ DỮ LIỆU BÀI…'));
    const safe = a.safeCards || []; const likely = a.likelySafeCards || []; const own = a.ownMeldCards || [];
    const wrap = el('div');
    // §40 — who plays right after this player (learned from public play). Context only.
    if (a.nextPlayerLabel) wrap.appendChild(el('div', { class: 'faint xs' }, 'Lượt sau: ' + a.nextPlayerLabel));
    if (!safe.length && !likely.length) wrap.appendChild(el('div', { class: 'cards' }, el('span', { class: 'faint sm' }, 'CHƯA ĐỦ DỮ LIỆU')));
    // §42 — highest-value PROVEN-safe card first; the first one is the suggestion (still only a display — the
    // player decides; nothing is played).
    if (safe.length) { wrap.appendChild(el('div', { class: 'faint xs' }, 'AN TOÀN — lá điểm cao trước')); wrap.appendChild(safeCardRow(safe, 'meld', a.recommendedCode)); }
    if (likely.length) { wrap.appendChild(el('div', { class: 'faint xs' }, 'CÓ THỂ AN TOÀN')); wrap.appendChild(safeCardRow(likely, '')); }
    // §41 — the player's own phỏm: shown so it is clear WHY those cards are never offered.
    if (own.length) { wrap.appendChild(el('div', { class: 'faint xs' }, 'TRONG PHỎM — giữ lại' + (a.ownMeldSource === 'SERVER' ? '' : ' (tự tính)'))); wrap.appendChild(safeCardRow(own, 'own-meld')); }
    return wrap;
  }
  function safeCardRow(cards, extra, recommendedCode) {
    const row = el('div', { class: 'cards' });
    for (const c of cards) {
      const rec = recommendedCode != null && c.code === recommendedCode;
      const tip = (rec ? 'NÊN ĐÁNH — ' : '') + (c.points != null ? c.points + ' điểm · ' : '') + (c.reasonCodes || []).join(', ');
      row.appendChild(el('span', { class: 'card-face ' + (c.color === 'red' ? 'red' : 'black') + (extra ? ' ' + extra : '') + (rec ? ' recommended' : ''), title: tip }, el('b', null, c.rank || '?'), el('span', null, c.suit || '?')));
      if (rec) row.appendChild(el('span', { class: 'chip green sm' }, 'NÊN ĐÁNH'));
    }
    return row;
  }
  // Resolve the selected slot → authoritative uid (via the observer's binding) and run the read-only
  // analyzer in main. Event-driven: called on selection change + every card snapshot update (§21). No timers.
  async function refreshSafeAnalysis() {
    const slot = selectedAnalysisPlayer;
    if (!slot || !api.analyzeSafeCards) { safeAnalysis = null; return; }
    const uid = cardsSnap && cardsSnap.slotBinding ? cardsSnap.slotBinding[slot] : null;
    if (!uid) { safeAnalysis = null; return; } // Player not yet bound to a uid (waiting for table data)
    try { const r = await api.analyzeSafeCards(uid); safeAnalysis = r && r.ok !== false ? r : null; } catch { safeAnalysis = null; }
  }
  // Build the single business-action button from the browserAction decision.
  function actionButton(act, b, runId, inGame) {
    if (act.busy) return el('span', { class: 'chip yellow sm busy' }, spinner(), ' ' + act.label);
    if (act.action === 'ENTER_GAME') return el('button', { class: 'btn primary bc-main', onclick: () => manualEnterGame(runId) }, icon('play', { sm: true }), ' ' + act.label);
    if (act.action === 'FIND') return betFindGroup(b, runId, inGame); // PHASE 6.2.3 — real bet selector + TÌM BÀN
    if (act.action === 'JOIN_SHARED') return el('button', { class: 'btn primary bc-main', onclick: () => onManualJoinShared(b) }, icon('logout', { sm: true }), ' ' + act.label); // VÀO BÀN → shared RID
    if (act.action === 'LEAVE') return el('button', { class: 'btn danger bc-main', onclick: () => onManualLeave(b) }, act.label);       // THOÁT GAME
    return el('span', { class: 'faint sm' }, act.label);
  }
  // A real spinning loader icon (§27) — no emoji, no heavy animation.
  function spinner() { const s = icon('refresh', { sm: true }); try { s.classList.add('spin'); } catch {} return s; }
  // PHASE 6.2.3 — the finder's bet selector (REAL server stakes) + TÌM BÀN. The stake list comes from this
  // browser's own betOptions (distinct rs[].b); FIND is enabled only after a stake is chosen (§5/§11). No
  // manual number input, no hard-coded list. While a search is running, FIND is search-locked as before.
  function betFindGroup(b, runId, inGame) {
    const group = el('div', { class: 'bet-find' });
    // §38 — a persistent search runs up to a minute: show its live progress and the SAME HỦY the header has,
    // instead of a locked button that cannot be told apart from a hang.
    if (b && b.manualState === 'SEARCHING') {
      const el_ = Number(b.searchElapsedSec) > 0 ? ` ${Number(b.searchElapsedSec)}s` : '';
      const at = Number(b.searchAttempt) > 0 ? ` · lần ${Number(b.searchAttempt)}` : '';
      group.appendChild(el('span', { class: 'chip yellow sm busy' }, spinner(), ` ĐANG TÌM BÀN…${el_}${at}`));
      group.appendChild(el('button', { class: 'btn danger sm', title: 'Dừng tìm bàn ngay', onclick: () => onCancelFind(b) }, 'HỦY TÌM'));
      return group;
    }
    const options = (b && Array.isArray(b.betOptions)) ? b.betOptions : [];
    if (!options.length) {
      group.appendChild(el('span', { class: 'chip yellow sm busy' }, spinner(), ' CƯỢC: đang tải…'));
      group.appendChild(iconButton('refresh', 'Tải lại danh sách mức cược', () => onRefreshBets(runId)));
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
    findBtn.insertBefore(icon('search', { sm: true }), findBtn.firstChild); // TÌM BÀN with a search icon
    group.appendChild(sel);
    setEnabled(selected); // §11 — FIND needs a chosen stake
    group.appendChild(findBtn);
    return group;
  }
  // Reload the real bet options (re-request the channel list; the server re-sends rs[]).
  async function onRefreshBets(runId) {
    note('Đang tải mức cược…');
    try { await api.requestChannels(runId); } catch {} // §35 — only THIS browser (never a seated one)
    await refreshManual(); renderApp();
  }
  // VÀO BÀN — JOIN the shared RID (never a new discovery, §3/§4). Immediate ĐANG VÀO BÀN; confirmed by ps[].
  async function onManualJoinShared(b) {
    const rid = manualCluster.sharedRid;
    if (rid == null) return note('Chưa có bàn dùng chung.', true);
    manualJoining[b.profileId] = true; note(`Đang vào bàn ${rid}…`); renderApp();
    // §38 — the SAME join the header's VÀO BÀN uses: bounded retry + proof of sitting with the room holder.
    let res; try { res = await api.manualJoinShared(b.profileId, rid); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
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
      // §35 — ask ONLY the browsers still missing the list (each individually), never all three.
      const needChannels = SLOTS.filter((sl) => { const p = slotProfile(assign[sl].runId); return p && p.socketReady && p.connected && !((p.channelCount || 0) > 0); });
      if (needChannels.length && phomSessionStarted) { for (const sl of needChannels) { try { await api.requestChannels(assign[sl].runId); } catch {} } }
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

  // §44 — ONE find engine. This Tool-wide TÌM BÀN used to start the legacy HOST/FOLLOWER discovery loop
  // (api.discover), while the per-browser buttons and the in-Chromium headers used the manual PHASE-6 flow:
  // three buttons, two engines, two sets of rules. It now drives the SAME manual flow — the chosen finder
  // searches, then the other browsers join that room — so every surface behaves identically and benefits from
  // the same fixes (per-run blacklist, persistent search + HỦY, validated shared room, same-room proof).
  async function runFindTable(stake) {
    selectedStake = stake;
    const finderSlot = selectedFinderPlayer || SLOTS.find((sl) => slotInPhom(assign[sl].runId)) || SLOTS[0];
    const finderRunId = assign[finderSlot].runId;
    if (!finderRunId) { note('Chưa có browser nào sẵn sàng để tìm bàn.', true); return; }
    note('Đang tìm bàn (mức cược ' + stake + ')…'); // FIND_TABLE_REQUESTED — immediate visible feedback
    autoFlow = true; renderApp(); // FIND_TABLE_STARTED — button reflects the running search
    try {
      selectedStakeByBrowser[finderRunId] = stake;
      const d = await api.manualDiscover(finderRunId, { selectedStake: stake });
      if (!d || d.ok === false) { note('Không thể tìm bàn: ' + errText(d), true); return; }
      note('Đã tìm được bàn ' + d.rid + ' — đang đưa các browser còn lại vào bàn…');
      // The other browsers JOIN the room the finder actually landed in (bounded retry + same-room proof).
      for (const sl of SLOTS) {
        const runId = assign[sl].runId;
        if (!runId || runId === finderRunId) continue;
        const r = await api.manualJoinShared(runId, d.rid);
        if (r && r.ok === false) note(`${sl}: ` + errText(r), true);
      }
      await refreshManual();
      note('Đã vào bàn ' + d.rid + '.');
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
    let sharedAuth; // §38 — the coordinator's single shared room (undefined when the backend didn't send one)
    try { const r = await api.manualSnapshot(); manualBrowsers = (r && r.browsers) || []; if (r && 'sharedRid' in r) sharedAuth = { sharedRid: r.sharedRid, sharedRidOwner: r.sharedRidOwner }; } catch { manualBrowsers = []; }
    try { const rc = await api.remainingCards(); remaining = rc && rc.ok !== false ? rc : null; } catch { remaining = null; }
    // PHASE 6.3.3.2 — pull the card-observation snapshot (real observed data; empty/unknown when none).
    if (api.cardsSnapshot) { try { const cs = await api.cardsSnapshot(); cardsSnap = cs && cs.ok !== false ? cs : null; } catch { cardsSnap = null; } }
    // PHASE 6.3.3.3 — re-run the read-only analyzer for the selected target off the fresh snapshot (§21).
    await refreshSafeAnalysis();
    if (MCS) manualCluster = MCS.reconcile(manualCluster, manualBrowsers, sharedAuth);
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
      try { res = await api.manualJoinShared(b.profileId, dec.rid); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; } // §38 same semantics as the header
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
  // §38 — HỦY from the Tool window: the same coordinator cancel the header's HỦY uses.
  async function onCancelFind(b) {
    note('Đang hủy tìm bàn…');
    let res; try { res = await api.cancelFind(b.profileId); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    if (res && res.ok === false && !(res.error && res.error.code === 'PHOM_FIND_NOT_RUNNING')) note(errText(res), true);
    else note('Đã hủy tìm bàn.');
    await refreshManual(); renderApp();
  }
  // §49 — "BÀN SERVER TRẢ VỀ": the raw rows the lobby sent this browser for the stake it searched, with the
  // reason each one was skipped. When the game's own lobby shows joinable tables and TÌM BÀN reports none, this
  // is the only way to see WHICH picture is wrong — the tool's list or the screen's. Shown only after a failed
  // search, collapsed by default, and it contains nothing but the protocol's channel fields.
  function findRowsDetail(b) {
    const rows = (b && Array.isArray(b.lastFindRows)) ? b.lastFindRows : [];
    if (!b || !b.lastError || b.lastError.code !== 'PHOM_NO_EMPTY_TABLE' || !rows.length) return null;
    const box = el('details', { class: 'find-rows' });
    box.appendChild(el('summary', { class: 'faint xs' }, `BÀN SERVER TRẢ VỀ (${b.lastFindTotal || rows.length}) — mức cược ${b.lastFindStake != null ? b.lastFindStake : '—'}`));
    for (const r of rows) {
      box.appendChild(el('div', { class: 'faint xs' },
        `rid ${r.rid} · cược ${r.stake} · ${r.uC}/${r.Mu} người · trống ${r.freeSlots != null ? r.freeSlots : '?'} · ${r.reason}`));
    }
    return box;
  }
  async function onManualLeave(b) {
    note('Đang rời bàn…');
    // §37 — leaving is now CONFIRMED by the server; an unconfirmed leave is surfaced, never reported as clean.
    let res; try { res = await api.manualLeave(b.profileId); } catch (e) { res = { ok: false, error: { code: 'IPC_FAILED', message: String(e && e.message || e) } }; }
    if (res && res.ok === false && !res.superseded) note(errText(res), true); else note('Đã rời bàn.');
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
      findRowsDetail(b),
    );
  }
  function manualStatusCls(s) { return ({ JOINED: 'green', SEARCHING: 'yellow', JOINING: 'blue', RECONNECTING: 'blue', LEAVING: 'yellow', LEFT: 'gray', ERROR: 'red', READY: 'gray', CLOSED: 'gray' })[s] || 'gray'; }

  // Screen 2 — CARDS REMAINING (= full deck − Browser1 − Browser2 − Browser3). Renders the backend
  // result only (never recomputes); NOT "player 4".
  // Screen 2 — LÁ BÀI CÒN LẠI (CARDS REMAINING). PHASE 6.3.3.2: prefer the card OBSERVER's remaining
  // (canonical 52 − every card PROVEN out: hands + discards + melds); fall back to the 3-browser-hands
  // backend view (remaining.cards / remaining.count). Both are REAL observed data — nothing fabricated.
  // Until the observer has any evidence, show an explicit "Đang quan sát…" state (never a fake number).
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
  // PHASE 6.3.3.2 — a fresh card-observation snapshot arrived (push). Store it + re-render Screen 2.
  if (api.onCards) api.onCards((c) => { cardsSnap = c || null; refreshSafeAnalysis().then(() => { if (!$('workspace').hidden && uiState === UI.CONTROL) bgRender(); }); });
  // PHASE 6.3.6 — reflect the current finder choice on load (main owns it; renderer mirrors for the selector UI).
  if (api.getFinder) { api.getFinder().then((r) => { if (r && r.ok && r.finderIndex != null) { selectedFinderPlayer = 'B' + r.finderIndex; if (!$('workspace').hidden) bgRender(); } }).catch(() => {}); }
  if (api.onLicense) api.onLicense((s) => { if (s && s.active && !$('activation').hidden) boot(); });
  if (api.onCluster) api.onCluster((snap) => { clusterSnap = snap; if (!$('workspace').hidden && (uiState === UI.CONTROL || uiState === UI.OPENING_CLUSTER)) bgRender(); });
  // Auto ReJoin: when the domain reports a kicked controlled profile, recover it (the
  // coordinator enforces debounce/cooldown/bounded retry + round-active defer — §15).
  if (api.onKick) api.onKick(() => { if (uiState === UI.CONTROL) rejoinKicked(); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
