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
    return !!cs.clusterSessionId && (cs.connectedCount || 0) > 0;
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

  // ================= SCREEN 1 — SETUP =================
  function renderSetup(r) {
    r.appendChild(header('SETUP'));
    r.appendChild(el('div', { class: 'note faint' }, 'Cấu hình một Link Game dùng chung + proxy/thiết bị cho 3 hồ sơ, rồi mở cả ba trình duyệt bằng một nút.'));
    r.appendChild(el('div', { class: 'note', id: 'phq-note' }, ''));

    // A — Cluster Profile
    renderClusterProfiles(r);
    // B — shared Link Game + C — HOST/stake (bound to the selected cluster profile)
    renderGameLink(r);

    // D — three profile rows (device + proxy)
    r.appendChild(el('div', { class: 'section-t' }, 'HỒ SƠ 3 TRÌNH DUYỆT (PROXY + THIẾT BỊ)'));
    for (const slot of SLOTS) r.appendChild(setupRow(slot));

    // E — Quick Proxy
    renderQuickProxy(r);

    if (caps.devBypass) r.appendChild(el('label', { class: 'phq-row', style: 'font-size:12px' },
      el('input', { type: 'checkbox', id: 'phq-localtest', checked: localTest ? 'checked' : null, onchange: (e) => { localTest = e.target.checked; } }),
      el('span', null, 'Local runtime test (mở browser trang local, không dùng Link Game/proxy)')));

    // F — the SINGLE primary CTA that opens all three browsers from the saved profile.
    r.appendChild(el('button', { class: 'btn primary cta-open', onclick: openCluster }, localTest ? 'RUN GAME — MỞ 3 TRÌNH DUYỆT (LOCAL TEST)' : 'RUN GAME — MỞ 3 TRÌNH DUYỆT'));
    if (!setupReady()) r.appendChild(el('div', { class: 'warnrow' }, setupReason()));

    r.appendChild(el('div', { class: 'section-t' }, 'CÔNG CỤ'));
    r.appendChild(el('button', { class: 'btn', onclick: openAnalyzer }, 'PHÂN TÍCH LUẬT — QA OFFLINE'));
    r.appendChild(el('button', { class: 'btn', onclick: openSimulator }, 'MÔ PHỎNG REALTIME — QA OFFLINE'));

    const det = el('details', { class: 'adv' }, el('summary', null, 'Advanced Debug'));
    det.appendChild(el('pre', { style: 'font-size:11px;color:var(--text-2);max-height:160px;overflow:auto;white-space:pre-wrap' }, JSON.stringify({ caps, profiles: Object.keys(profiles) }, null, 2)));
    r.appendChild(det);
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
  function renderGameLink(r) {
    const p = selectedProfile();
    r.appendChild(el('div', { class: 'section-t' }, 'LINK GAME (DÙNG CHUNG A/B/C)'));
    if (!p) { r.appendChild(el('div', { class: 'note faint' }, 'Chọn/tạo một Cluster Profile để nhập Link Game.')); return; }
    const urlInput = el('input', {
      class: 'f', id: 'phq-gameurl', type: 'url', spellcheck: 'false', value: p.gameUrl || '',
      placeholder: 'https://game.example.com/room',
      onchange: async (e) => {
        const res = await api.clusterProfileUpdate(p.id, { gameUrl: (e.target.value || '').trim() || null });
        await refreshClusterProfiles();
        if (res && res.ok === false) glNote(errText(res), true);
        else { glNote('Đã lưu Link Game.'); renderApp(); }
      },
    });
    r.appendChild(el('div', { class: 'phq-row' }, el('span', null, 'Link'), urlInput, localTest ? el('span', { class: 'pill warn' }, 'LOCAL TEST') : null));
    r.appendChild(el('div', { class: 'note', id: 'phq-glnote' }, ''));

    // HOST only (defaultHostSlot on the profile). Stake is NOT set on Screen 1.
    const hostSel = el('select', { class: 'sel', id: 'phq-hostslot', onchange: async (e) => { await api.clusterProfileUpdate(p.id, { defaultHostSlot: e.target.value }); await refreshClusterProfiles(); } });
    for (const slot of SLOTS) { const o = el('option', { value: slot }, 'HOST = ' + slot); if ((p.defaultHostSlot || 'A') === slot) o.setAttribute('selected', 'selected'); hostSel.appendChild(o); }
    r.appendChild(el('div', { class: 'phq-row' }, el('span', null, 'HOST'), hostSel));
  }
  function glNote(msg, warn) { const n = $('phq-glnote'); if (n) { n.textContent = msg || ''; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }

  function renderClusterProfiles(r) {
    r.appendChild(el('div', { class: 'section-t' }, 'CẤU HÌNH CỤM (CLUSTER PROFILE)'));
    const sel = el('select', { id: 'cl-sel', class: 'phq-in', onchange: async (e) => { await api.clusterProfileSelect(e.target.value || ''); await refreshClusterProfiles(); renderApp(); } });
    sel.appendChild(el('option', { value: '' }, '— chưa chọn —'));
    for (const p of clusterProfiles) {
      const o = el('option', { value: p.id }, `${p.name} · ${p.state}`);
      if (p.id === selectedClusterProfileId) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    }
    r.appendChild(el('div', { class: 'phq-row' }, el('span', null, 'Hồ sơ cụm'), sel));
    r.appendChild(el('div', { class: 'phq-row' },
      el('button', { class: 'btn', onclick: clusterProfileCreate }, 'Tạo'),
      el('button', { class: 'btn', onclick: clusterProfileEdit }, 'Sửa'),
      el('button', { class: 'btn', onclick: clusterProfileDuplicate }, 'Nhân bản'),
      el('button', { class: 'btn danger', onclick: clusterProfileDelete }, 'Xóa'),
    ));
    r.appendChild(el('div', { class: 'note', id: 'cl-note' }, ''));
  }

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
  function renderQuickProxy(r) {
    r.appendChild(el('div', { class: 'section-t' }, 'THIẾT LẬP NHANH 3 PROXY'));
    const panel = el('div', { class: 'qp-panel' });
    panel.appendChild(el('div', { class: 'qp-hint' }, 'Đã xác định sẵn A/B/C — chỉ nhập proxy, không nhập A= B= C='));
    for (const slot of SLOTS) {
      const proto = el('select', { class: 'sel qp-proto', id: 'qp-proto-' + slot, 'aria-label': 'Loại proxy ' + slot });
      for (const p of ['http', 'https', 'socks5', 'socks4']) proto.appendChild(el('option', { value: p }, p.toUpperCase()));
      const inp = el('input', { class: 'f qp-in', id: 'qp-in-' + slot, 'aria-label': 'Proxy ' + slot, placeholder: 'host|port|user|password' });
      panel.appendChild(el('div', { class: 'qp-row' }, el('span', { class: 'qp-slot' }, slot), proto, inp));
    }
    panel.appendChild(el('div', { class: 'qp-actions' },
      el('button', { class: 'btn primary', onclick: applyQuickProxies }, 'Áp dụng 3 proxy'),
      el('button', { class: 'btn', onclick: testAllProxies }, 'Test tất cả'),
    ));
    panel.appendChild(el('div', { class: 'note', id: 'qp-note' }, ''));
    r.appendChild(panel);
  }
  async function applyQuickProxies() {
    // Collect the three slot-labeled rows; the slot is authoritative from the UI label.
    const rows = SLOTS.map((slot) => ({ slot, protocol: ($('qp-proto-' + slot) || {}).value || 'http', value: (($('qp-in-' + slot) || {}).value || '').trim() }));
    if (rows.some((r) => !r.value)) { qpNote('Nhập proxy cho cả ba dòng A/B/C.', false); return; }
    qpNote('Đang áp dụng…', true);
    let res;
    try { res = await api.proxyQuickApply({ rows, clusterProfileId: selectedClusterProfileId || null }); }
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
  function setupRow(slot) {
    const a = assign[slot];
    const saved = profiles[slot] || {};
    if (a.proxyRef == null && saved.proxyRef) a.proxyRef = saved.proxyRef;
    const dev = saved.device;
    return el('div', { class: 'prow', id: 'setup-' + slot },
      el('div', null, el('b', null, 'Hồ sơ ' + slot + ' '), el('span', { class: 'faint' }, saved.name || ('Profile ' + slot))),
      el('div', null, el('b', null, 'Thiết bị '),
        el('span', null, dev ? `${dev.name} · ${dev.resolution} · Ngang · Touch` : '(chưa tạo)'),
        el('button', { class: 'btn', onclick: () => openDeviceModal(slot) }, dev ? 'Sửa thiết bị' : 'Tạo thiết bị'),
      ),
      el('div', null, el('b', null, 'Proxy '), proxySelector(slot)),
      el('div', null,
        el('button', { class: 'btn', onclick: () => testProxy(slot) }, 'Test'),
        el('button', { class: 'btn', onclick: () => openProxyModal(slot, null) }, '+ Proxy'),
        a.proxyRef ? el('button', { class: 'btn', onclick: () => openProxyModal(slot, a.proxyRef) }, 'Sửa') : null,
        a.proxyRef ? el('button', { class: 'btn danger', onclick: () => deleteProxy(a.proxyRef) }, 'Xóa') : null,
        el('span', { class: 'badge ' + testBadge(a.testState) }, a.testState),
        a.ip ? el('span', { class: 'faint' }, ' IP ' + a.ip) : null,
      ),
    );
  }

  function proxySelector(slot) {
    const sel = el('select', { class: 'sel', onchange: (e) => { assign[slot].proxyRef = e.target.value; api.profileUpsert(slot, { proxyRef: e.target.value || null }); } });
    sel.appendChild(el('option', { value: '' }, '— chọn proxy —'));
    for (const p of proxies) sel.appendChild(el('option', { value: p.id, selected: assign[slot].proxyRef === p.id }, `${p.label} (${p.protocol})`));
    return sel;
  }
  function testBadge(s) { return ({ PASS: 'good', FAILED: 'bad', AUTH_FAILED: 'bad', TIMEOUT: 'warn', TESTING: 'warn' })[s] || 'faint'; }

  function setupReady() {
    if (localTest) return true; // local runtime test opens about:blank without proxy
    return SLOTS.every((s) => assign[s].proxyRef);
  }
  function setupReason() {
    if (localTest) return '';
    return 'Gán proxy cho cả 3 hồ sơ (hoặc bật Local runtime test) trước khi mở.';
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
    const opened = !!cp.profileId;
    const isHost = sp.role === 'HOST' || (s.hostId && s.hostId === cp.profileId);
    const st = sp.state;
    let cls = 'gray', label = 'CHƯA MỞ';
    if (opened) {
      if (st === 'KICKED') { cls = 'red'; label = 'BỊ KICK'; }
      else if (st === 'REJOINING') { cls = 'red'; label = 'ĐANG VÀO LẠI'; }
      else if (st === 'ERROR' || st === 'DISCONNECTED' || st === 'LEFT') { cls = 'red'; label = st === 'DISCONNECTED' ? 'MẤT KẾT NỐI' : (st === 'LEFT' ? 'ĐÃ RỜI' : 'LỖI'); }
      else if (sp.ready) { cls = 'green'; label = 'READY'; }
      else if (st === 'MISMATCH') { cls = 'yellow'; label = 'SAI BÀN'; }
      else if (st === 'AT_TABLE') { cls = 'blue'; label = 'ĐÃ VÀO'; }
      else if (st === 'JOINING') { cls = 'blue'; label = 'ĐANG VÀO'; }
      else { cls = 'yellow'; label = 'CHỜ'; }
    }
    const text = isHost ? `${slot} · HOST${sp.ready ? ' · READY' : ''}` : `${slot} · ${label}`;
    const detail = { slot, profileId: cp.profileId || null, pid: cp.pid || null, cdp: cp.cdpPort || null,
      cdpConnected: !!cp.cdpConnected, proxy: (profiles[slot] && profiles[slot].proxyRef) || null, ip: cp.observedIp || null,
      seat: sp.seat != null ? sp.seat : null, uid: sp.uid || null, state: st || (opened ? 'OPEN' : 'CLOSED') };
    return { cls: isHost ? 'orange' : cls, text, detail, isHost };
  }

  function statusToolbar(s, cs) {
    const bar = el('div', { class: 'qa-status' });
    const chips = el('div', { class: 'qa-chips' });
    for (const slot of SLOTS) {
      const st = slotStatus(slot, s, cs);
      const chip = el('span', { class: 'chip ' + st.cls, title: JSON.stringify(st.detail) }, st.text);
      chips.appendChild(chip);
    }
    bar.appendChild(chips);
    const rid = s.hostTableIdentity && s.hostTableIdentity.channelRid;
    const badges = el('div', { class: 'qa-badges' },
      el('span', { class: 'gbadge' }, rid != null ? ('BÀN ' + rid) : 'CHƯA CÓ BÀN'),
      el('span', { class: 'gbadge' }, (s.playerCount || 0) + (s.waitingFourth ? '/4' : (s.playerCount ? '/' + s.playerCount : '/4'))),
      el('span', { class: 'gbadge ' + (s.sameTable ? 'good' : '') }, s.sameTable ? 'CÙNG BÀN' : (s.tableVerdict || '—')),
      s.selectedStake ? el('span', { class: 'gbadge' }, 'CƯỢC ' + s.selectedStake) : null,
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
    return el('div', { class: 'qa-cmd' },
      el('button', { class: 'btn primary', disabled: (!ctaEnabled(s) || running) ? true : null, onclick: openFindTable }, running ? 'ĐANG CHẠY…' : 'TÌM BÀN'),
      el('button', { class: 'btn', onclick: () => clusterFocus('A') }, 'Focus A'),
      el('button', { class: 'btn', onclick: () => clusterFocus('B') }, 'Focus B'),
      el('button', { class: 'btn', onclick: () => clusterFocus('C') }, 'Focus C'),
      moreMenuButton(),
      el('button', { class: 'btn danger', onclick: stopCluster }, 'DỪNG'),
      hostLost ? el('span', { class: 'chip red', style: 'margin-left:6px' }, 'HOST MẤT BÀN — bấm TÌM BÀN') : null,
    );
  }

  // The overflow "⋯" menu keeps rarely-used / advanced actions off the main toolbar.
  function moreMenuButton() {
    const menu = el('div', { class: 'qa-more-menu', hidden: 'hidden' },
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); step(() => api.restoreLayout(), 'Đã xếp lại bố cục.')(); } }, 'Xếp lại bố cục'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); step(() => api.leaveAll(), 'Đã rời bàn.')(); } }, 'Rời bàn'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); openSimulator(); } }, 'Mô phỏng Offline (QA)'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); openAnalyzer(); } }, 'Phân tích luật Offline'),
      el('button', { class: 'menu-item', onclick: (e) => { closeMore(e); toggleAdvancedDebug(); } }, 'Advanced Debug'),
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
      el('span', { class: 'mon-dot' }), ' QA RULE MONITOR · D MÔ PHỎNG',
      el('span', { class: 'mon-src' }, 'Nguồn fixture/replay local · không dùng bài kín live'));
    mon.appendChild(banner);
    if (!snap || snap.ok === false) { mon.appendChild(el('div', { class: 'note faint' }, snap && snap.error ? (snap.error.code + ': ' + snap.error.message) : 'Đang nạp dữ liệu D mô phỏng…')); return; }
    const labels = snap.labels || {};
    const authoritative = snap.authoritative === true;
    const meldCards = new Set(snap.derivedMelds.flatMap((m) => m.cards));
    const notInMeld = snap.hand.cards.filter((c) => !meldCards.has(c));
    // ROW 1 — cards not forming a phỏm
    const row1 = el('div', { class: 'mon-row2 mon-drow' });
    row1.appendChild(el('div', { class: 'mon-drow-h' }, el('div', { class: 'section-t' }, 'ROW 1 · CÁC LÁ KHÔNG TẠO PHỎM CHO D MÔ PHỎNG'), el('span', { class: 'gbadge' }, (authoritative ? notInMeld.length : '?') + ' LÁ')));
    row1.appendChild(cardRow(authoritative ? notInMeld : [], labels, {}));
    row1.appendChild(el('div', { class: 'faint sm' }, authoritative ? 'Kết quả kiểm thử luật trên hand mô phỏng authoritative.' : 'UNKNOWN — hand D mô phỏng chưa authoritative (thiếu dữ liệu).'));
    mon.appendChild(row1);
    // ROW 2 — phỏm melds D can form
    const row2 = el('div', { class: 'mon-row2 mon-drow' });
    row2.appendChild(el('div', { class: 'mon-drow-h' }, el('div', { class: 'section-t' }, 'ROW 2 · CÁC KẾT PHỎM D MÔ PHỎNG CÓ THỂ TẠO'), el('span', { class: 'gbadge' }, (authoritative ? snap.derivedMelds.length : 0) + ' PHỎM')));
    if (!authoritative || !snap.derivedMelds.length) row2.appendChild(el('div', { class: 'faint' }, authoritative ? '(chưa có phỏm)' : 'UNKNOWN'));
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
    const status = el('div', { class: 'note' }, 'Đang lấy danh sách mức cược từ máy chủ…');
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
    status.textContent = 'PHOM_STAKE_LIST_UNAVAILABLE — máy chủ chưa trả danh sách mức cược (cần môi trường live được cấp quyền).';
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
    uiState = UI.OPENING_CLUSTER; renderApp();
    try {
      const created = await api.clusterCreate({ clusterProfileId: selectedClusterProfileId, localTest });
      if (created && created.ok === false) throw created;
      if (created && created.localTest != null) localTest = created.localTest;
      if (created && created.clusterProfileId) selectedClusterProfileId = created.clusterProfileId;
      const open = await api.clusterOpen();
      if (open && open.ok === false && !open.opened) throw open;
      // Sandbox-enabled Chromium needs a moment before its CDP endpoint answers, so the
      // connect is retried (bounded) rather than one-shot — otherwise CONTROL could land
      // showing CDP 0/3 even though the browsers are healthy.
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
      uiState = UI.CONTROL; renderApp();
      note(`Đã mở ${open.opened || 0}/3 trình duyệt.`);
    } catch (e) {
      errorMsg = errText(e) + '  (cụm chưa mở đủ — có thể Dừng và thử lại)';
      uiState = UI.ERROR; renderApp();
    }
  }

  async function stopCluster() {
    qaMonitorPlay(false); qaSnap = null; // stop the D-monitor playback on cluster stop
    uiState = UI.STOPPING; renderApp();
    try { await api.clusterStop(); } catch {}
    // Preserve saved profile/device/proxy configuration; just refresh view state.
    for (const s of SLOTS) assign[s].runId = null;
    try { const pf = await api.profileList(); profiles = Object.fromEntries(((pf && pf.profiles) || []).map((x) => [x.slot, x])); } catch {}
    try { const pl = await api.proxyList(); proxies = (pl && pl.proxies) || []; } catch {}
    try { clusterSnap = await api.clusterSnapshot(); } catch { clusterSnap = null; }
    uiState = UI.SETUP; renderApp();
    note('Đã dừng cụm. Cấu hình proxy/thiết bị được giữ nguyên.');
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
    const ids = SLOTS.map((s) => assign[s].proxyRef).filter(Boolean);
    if (!ids.length) return note('Chưa gán proxy.', true);
    const res = await api.proxyTestAll(ids);
    const results = res && res.results || {};
    for (const s of SLOTS) { const r = results[assign[s].proxyRef]; if (r) { assign[s].testState = r.state; assign[s].ip = r.observedIp || null; } }
    renderApp();
  }

  // ---------- helpers ----------
  function browserCount() { return SLOTS.filter((s) => assign[s].runId).length; }
  function proxiesReady() { return SLOTS.every((s) => assign[s].proxyRef && assign[s].testState === 'PASS'); }
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
