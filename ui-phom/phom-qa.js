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
  let awaitingLogin = false;  // WAITING_FOR_LOGIN: browsers open, user logs in before TÌM BÀN
  let qaSnap = null;         // QA RULE MONITOR (D simulated) snapshot
  let qaLoading = false, qaPlaying = false, qaTimer = null, qaSpeed = 900;
  let localTest = false;     // LOCAL RUNTIME TEST (dev-only: open browsers without proxy)
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

  // ---------- top-level dispatch ----------
  function renderApp() {
    const r = $('phq-root'); if (!r) return;
    r.innerHTML = '';
    r.className = 'mode-' + uiState.toLowerCase();
    banners(r);
    if (uiState === UI.SETUP) return renderSetup(r);
    if (uiState === UI.OPENING_CLUSTER) return renderTransient(r, 'ĐANG MỞ 3 TRÌNH DUYỆT…', 'Ba cửa sổ Chromium đang bung ra bên ngoài.');
    if (uiState === UI.STOPPING) return renderTransient(r, 'ĐANG DỪNG CỤM…', 'Đóng ba trình duyệt, giữ nguyên cấu hình đã lưu.');
    if (uiState === UI.ERROR) return renderError(r);
    return renderControl(r);
  }

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
    r.appendChild(el('button', { class: 'btn primary', onclick: () => { uiState = UI.SETUP; renderApp(); } }, 'Về SETUP'));
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
    const pxText = px ? `${px.protocol}://${px.host}:${px.port}` : 'Trực tiếp (không proxy)'; // redacted (no password)
    // Proxy is OPTIONAL: a slot with no proxyRef runs in DIRECT mode — a neutral, valid
    // state (never an error). Only a slot WITH a proxy shows its test state.
    const status = !a.proxyRef ? 'DIRECT' : a.testState;
    return el('div', { class: 'prow s1', id: 'setup-' + slot },
      el('span', { class: 'slot-tag' }, slot),
      el('span', { class: 'ar-dev', title: dev ? `${dev.name} · ${dev.resolution}` : '(chưa tạo thiết bị)' },
        dev ? `${dev.name} · ${dev.resolution}` : '(chưa tạo)',
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
  function renderControl(r) {
    const s = session || {};
    const cs = clusterSnap || {};
    r.appendChild(statusToolbar(s, cs));
    r.appendChild(commandToolbar(s));
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, autoFlowLabel(s)));
    r.appendChild(liveMonitor(s));
  }

  // Map one slot to a compact chip {cls,text,detail}. HOST is ALWAYS orange (its label
  // still carries READY when ready); Ready=green, waiting=yellow, joined-pre-ready=blue,
  // kick/error/disconnect=red, not-opened=gray (§9).
  function slotStatus(slot, s, cs) {
    const cp = (cs.profiles && cs.profiles[slot]) || {};
    const sp = (s.profiles || []).find((p) => p.id === cp.profileId) || {};
    const closed = cp.browserState === 'CLOSED_BY_USER';
    const opened = !!cp.profileId && !closed;
    const isHost = sp.role === 'HOST' || (s.hostId && s.hostId === cp.profileId);
    const st = sp.state;
    let cls = 'gray', label = 'CHƯA MỞ';
    if (closed) { cls = 'gray'; label = 'ĐÃ ĐÓNG'; }
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
      browserState: cp.browserState || (opened ? 'OPEN' : 'NOT_OPEN'),
      cdpConnected: !!cp.cdpConnected, proxy: (profiles[slot] && profiles[slot].proxyRef) || null, ip: cp.observedIp || null,
      seat: sp.seat != null ? sp.seat : null, uid: sp.uid || null, state: st || (opened ? 'OPEN' : (closed ? 'CLOSED_BY_USER' : 'CLOSED')) };
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

  // Progress label for the automatic table flow (§11).
  function autoFlowLabel(s) {
    const map = {
      IDLE: '', HOST_ACQUIRING: 'HOST ĐANG TÌM…', HOST_ACQUIRED: 'ĐÃ CÓ BÀN — ĐANG ĐƯA 2 ACC VÀO…',
      FOLLOWERS_JOINING: 'ĐANG ĐƯA 2 ACC VÀO…', SAME_TABLE: 'XÁC NHẬN CÙNG BÀN…', READY: 'ĐÃ SẴN SÀNG',
      HOST_LOST: 'HOST MẤT BÀN', HOST_TABLE_LOST: 'HOST MẤT BÀN', REJOIN_EXHAUSTED: 'REJOIN THẤT BẠI',
    };
    if (s && s.roundRunning) return 'VÁN ĐANG CHẠY';
    if (s && s.sameTable && (s.readyCount || 0) > 0) return 'CHỜ ĐỦ NGƯỜI / SẴN SÀNG';
    return (s && map[s.state]) || '';
  }

  function commandToolbar(s) {
    const hostLost = s && (s.state === 'HOST_LOST' || s.state === 'HOST_TABLE_LOST');
    const running = autoFlow;
    // §9 — while WAITING_FOR_LOGIN the primary action is "ĐÃ LOGIN — TIẾP TỤC"; TÌM BÀN is
    // disabled until the user confirms login (or 3/3 protocol context is detected).
    const primary = awaitingLogin
      ? el('button', { class: 'btn primary', title: 'Xác nhận đã đăng nhập cả 3 browser để bật tìm bàn', onclick: confirmLogin }, 'ĐÃ LOGIN — TIẾP TỤC')
      : el('button', { class: 'btn primary', title: 'Mở hộp chọn mức cược rồi tự tìm bàn', disabled: (!ctaEnabled(s) || running) ? true : null, onclick: openFindTable }, running ? 'ĐANG CHẠY…' : 'TÌM BÀN · CHỌN CƯỢC');
    return el('div', { class: 'qa-cmd' },
      primary,
      el('button', { class: 'btn', onclick: () => clusterFocus('A') }, 'Focus A'),
      el('button', { class: 'btn', onclick: () => clusterFocus('B') }, 'Focus B'),
      el('button', { class: 'btn', onclick: () => clusterFocus('C') }, 'Focus C'),
      moreMenuButton(),
      el('button', { class: 'btn danger', title: 'Dừng tự động hoá tìm bàn (KHÔNG đóng trình duyệt)', onclick: stopOrchestration }, 'DỪNG'),
      awaitingLogin ? el('span', { class: 'chip yellow', style: 'margin-left:6px' }, 'CHỜ ĐĂNG NHẬP A/B/C') : null,
      hostLost ? el('span', { class: 'chip red', style: 'margin-left:6px' }, 'HOST MẤT BÀN — bấm TÌM BÀN') : null,
    );
  }

  // §9 — user confirms login on all three browsers; enables the find-table flow.
  function confirmLogin() { awaitingLogin = false; note('Đã xác nhận đăng nhập. Có thể bấm TÌM BÀN · CHỌN CƯỢC.'); renderApp(); }

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

  // ---- QA RULE MONITOR · D MÔ PHỎNG (§19-§21) — the main Screen-2 area.
  // Exactly TWO rows analysing a SIMULATED player D on FIXTURE/REPLAY data only (never
  // live hidden hands — §20): ROW 1 cards that do NOT form a phỏm, ROW 2 the phỏm melds
  // D can form. Updates event-by-event from the fixture-driven qa monitor (network 0,
  // CDP 0, action 0). Live A/B/C data feeds ONLY the toolbar, never these rows.
  function liveMonitor() {
    const mon = el('div', { class: 'qa-monitor', id: 'phq-monitor' });
    qaMonitorEnsure(); // fire-and-forget load/play; renders into #phq-monitor
    renderMonitorInto(mon);
    return mon;
  }

  function renderMonitorInto(mon) {
    if (!mon) return;
    const snap = qaSnap;
    mon.replaceChildren();
    const banner = el('div', { class: 'qa-mon-banner qa-rule' },
      el('span', { class: 'mon-dot' }), ' LIVE QA MONITOR',
      el('span', { class: 'mon-srcbadge' }, 'D — MÔ PHỎNG · FIXTURE/REPLAY'),
      el('span', { class: 'mon-src' }, 'không dùng bài kín live'));
    mon.appendChild(banner);
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
    if (!qaPlaying || uiState !== UI.CONTROL) { qaPlaying = false; return; }
    if (qaSnap && qaSnap.counters && qaSnap.counters.currentEvent >= qaSnap.counters.totalEvents) { qaSnap = await api.qaMonitorControl('reset'); }
    else { qaSnap = await api.qaMonitorControl('next'); }
    refreshMonitor();
    if (qaPlaying) qaScheduleTick();
  }
  function qaMonitorPlay(on) { qaPlaying = !!on; if (qaTimer) { clearTimeout(qaTimer); qaTimer = null; } if (on) qaScheduleTick(); }
  async function qaMonitorStep(action) { qaMonitorPlay(false); qaSnap = await api.qaMonitorControl(action); refreshMonitor(); }
  function refreshMonitor() { const mon = $('phq-monitor'); if (mon) renderMonitorInto(mon); }

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

  // Primary CTA: start the session over the 3 opened runs, pick HOST + stake, then run
  // §13 — Find-Table: the ONLY place a stake is chosen. Opens a compact modal, starts
  // the session so the HOST can request the server channel list, then shows the
  // AUTHORITATIVE distinct stakes. Confirm runs the full flow; Cancel sends nothing more.
  async function openFindTable() {
    const runIds = SLOTS.map((sl) => assign[sl].runId).filter(Boolean);
    if (runIds.length !== 3) return note('Cần mở đủ 3 browser trước.', true);
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

    // Start the session (so the HOST socket can query channels) then request the list.
    const start = await api.startSession({ runIds, hostId: host });
    if (start && start.ok === false) { status.textContent = errText(start); status.className = 'note warn'; return; }
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
    const sel = await api.selectStake(stake);
    if (sel && sel.ok === false) return note(errText(sel), true);
    autoFlow = true;
    const acq = await api.acquireHost();
    if (acq && acq.ok === false) { autoFlow = false; return note(errText(acq), true); }
    note('HOST đang tìm bàn trống…');
    refresh();
  }
  // Advance the happy path when authoritative state confirms each stage.
  // Re-entrant-safe automatic flow: HOST acquired -> followers join -> Ready policy is
  // (re)applied whenever the authoritative controlledReadyCount is below the desired
  // count. Because the desired count rises from 2 to 3 when a real 4th player sits, the
  // waiting controlled account auto-Readies on the next snapshot. applyReady is
  // idempotent in the domain, so re-issuing it never double-sends. Host loss / rejoin
  // exhaustion stops orchestration (no follower promotion — §12/§15).
  let flowBusy = false;
  function advanceAutoFlow(s) {
    if (!autoFlow || !s || flowBusy) return;
    if (s.state === 'HOST_LOST' || s.state === 'HOST_TABLE_LOST' || s.state === 'REJOIN_EXHAUSTED') { autoFlow = false; return; }
    const desired = (s.playerCount >= 4) ? 3 : 2;
    if (s.state === 'HOST_ACQUIRED' && !s.sameTable) {
      flowBusy = true; api.joinFollowers().finally(() => { flowBusy = false; refresh(); }); return;
    }
    if (s.sameTable && (s.controlledReadyCount || 0) < desired) {
      flowBusy = true; api.applyReady().finally(() => { flowBusy = false; refresh(); }); return;
    }
  }

  // Cluster CTA: SETUP → OPENING_CLUSTER → CONTROL. create → open → connect → apply
  // devices → tile (restoreLayout) via PhomClusterCdpManager.
  async function openCluster() {
    // §3 — the SAVED cluster profile drives the runtime. The renderer sends ONLY the
    // selected profile id (+ the non-persisted localTest flag); host/stake/proxy/device
    // all come authoritatively from the saved profile in the main process.
    if (!selectedClusterProfileId) { note('Hãy chọn hoặc tạo một Cluster Profile trước khi mở cụm.', true); return; }
    // §11 IDEMPOTENT: if the cluster is already open, REUSE it — never teardown/reopen.
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    if (clusterSnap && (clusterSnap.openBrowserCount || 0) >= 3 && clusterSnap.stopped !== true) {
      for (const slot of SLOTS) { const p = clusterSnap.profiles && clusterSnap.profiles[slot]; if (p && p.profileId) assign[slot].runId = p.profileId; }
      uiState = UI.CONTROL; renderApp();
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
      // §8 — after RUN GAME the tool WAITS for the user to log in on all three browsers.
      // It does NOT auto-request channels or auto-find a table; TÌM BÀN stays disabled
      // until the user confirms login (ĐÃ LOGIN — TIẾP TỤC) or 3/3 protocol context is seen.
      awaitingLogin = true;
      uiState = UI.CONTROL; renderApp();
      note(`Đã mở ${open.opened || 0}/3 trình duyệt. Đăng nhập A/B/C rồi bấm “ĐÃ LOGIN — TIẾP TỤC”.`);
    } catch (e) {
      // A failed open NEVER closes the browsers that DID open (§6/§14). Land on Screen 2
      // if anything opened so the user keeps those browsers; only fall back to ERROR when
      // nothing opened at all.
      try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
      if (clusterSnap && (clusterSnap.openBrowserCount || 0) > 0) {
        for (const slot of SLOTS) { const p = clusterSnap.profiles && clusterSnap.profiles[slot]; if (p && p.profileId) assign[slot].runId = p.profileId; }
        awaitingLogin = true; uiState = UI.CONTROL; renderApp();
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

  // ĐÓNG 3 TRÌNH DUYỆT — the ONLY UI action that closes the browsers (explicit + confirmed).
  async function closeBrowsers() {
    if (!window.confirm('Đóng cả 3 trình duyệt A/B/C? Cấu hình proxy/thiết bị được giữ nguyên.')) return;
    autoFlow = false; flowBusy = false; awaitingLogin = false;
    qaMonitorPlay(false); qaSnap = null;
    uiState = UI.STOPPING; renderApp();
    try { await api.closeBrowsers(); } catch {}
    for (const s of SLOTS) assign[s].runId = null;
    try { const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x])); } catch {}
    try { const pl = await api.proxyList(); proxies = (pl && pl.proxies) || []; } catch {}
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    uiState = UI.SETUP; renderApp();
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

  // ---------- helpers ----------
  function browserCount() { return SLOTS.filter((s) => assign[s].runId).length; }
  // Proxy is OPTIONAL: TÌM BÀN only needs the 3 browsers open in an authorized env — a
  // slot running DIRECT is valid and never blocks the find-table flow.
  // TÌM BÀN is enabled only once the browsers are open in an authorized env AND the user
  // has finished logging in (§9). Proxy is optional; CDP-not-connected doesn't gate here.
  function ctaEnabled() { return !!caps.authorized && browserCount() === 3 && !awaitingLogin; }
  function ctaReason(s) {
    if (!caps.authorized) return 'Môi trường chưa được cấp quyền QA (đặt PHOM_QA_AUTHORIZED=1 hoặc allowlist).';
    if (browserCount() < 3) return 'Cần mở đủ 3 browser.';
    return '';
  }
  function syncCls(x) { return ({ LIVE: 'good', ENDED: 'faint', STALE: 'warn', DESYNCED: 'bad', EMPTY: 'faint' })[x] || 'faint'; }
  function errText(res) { const e = res && res.error; return e ? `${e.code}: ${e.message}` : 'Thao tác thất bại.'; }
  function note(msg, warn) { const n = $('phq-note'); if (n) { n.textContent = msg; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }

  // ---------- boot ----------
  if (api.onSession) api.onSession((snap) => { session = snap; if (snap && snap.hands) hands = snap.hands; advanceAutoFlow(snap); if (!$('workspace').hidden) renderApp(); });
  if (api.onHands) api.onHands((h) => { hands = h; if (!$('workspace').hidden && uiState === UI.CONTROL) renderApp(); });
  if (api.onLicense) api.onLicense((s) => { if (s && s.active && !$('activation').hidden) boot(); });
  if (api.onCluster) api.onCluster((snap) => { clusterSnap = snap; if (!$('workspace').hidden && (uiState === UI.CONTROL || uiState === UI.OPENING_CLUSTER)) renderApp(); });
  // Auto ReJoin: when the domain reports a kicked controlled profile, recover it (the
  // coordinator enforces debounce/cooldown/bounded retry + round-active defer — §15).
  if (api.onKick) api.onKick(() => { if (uiState === UI.CONTROL) rejoinKicked(); });
  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
