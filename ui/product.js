'use strict';
const api = window.desktopCapture || {};
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// WU-B: the browser run this window currently controls. It is a VIEW pointer only
// (which run the panels show); every execution IPC passes it EXPLICITLY so the
// engine binds a send/auto/b-Test to this exact run, never to whatever the main
// process happens to consider "active". Changing it never retargets a running run.
// currentRunId is a VIEW pointer to the run whose detail panels are shown, and the
// explicit runId used for execution IPC (WU-B). When the selected PERSISTENT browser
// is OFFLINE it is null, so execution is safely rejected — a selected offline browser
// can never execute against another live run. When no persistent browser exists
// (Advanced Debug / legacy launch), it falls back to mirroring main's active run.
let currentRunId = null;
function setCurrentRun(runId) {
  const next = runId || null;
  if (next === currentRunId) return;
  currentRunId = next;
  if (next && api.selectRun) api.selectRun(next).catch(() => {}); // make gated streams follow the view
  document.dispatchEvent(new CustomEvent('run-selected', { detail: { runId: next } }));
}
function pickActiveRun(runs) { const list = runs || []; return list.find((r) => r.active) || null; }
// The selected PERSISTENT browser (view). Its persistent history/stats are shown even
// when the browser is OFFLINE. Owned by the BROWSERS rail (browserListUI).
let currentBrowserId = null;
function setCurrentBrowser(browserId) {
  const next = browserId || null;
  if (next === currentBrowserId) return;
  currentBrowserId = next;
  document.dispatchEvent(new CustomEvent('browser-view-changed', { detail: { browserId: next } }));
}
let _railSel = { active: false, runId: null }; // set by the BROWSERS rail (browserListUI)
let _lastActiveRunId = null;                    // last active runtime run (advanced/legacy fallback)
function recomputeCurrentRun() { setCurrentRun(_railSel.active ? _railSel.runId : _lastActiveRunId); }
function railSelect(active, runId) { _railSel = { active: !!active, runId: runId || null }; recomputeCurrentRun(); }
if (api.onRunsChanged) api.onRunsChanged((runs) => { const a = pickActiveRun(runs); _lastActiveRunId = a ? a.id : _lastActiveRunId; recomputeCurrentRun(); });

// Session aid/eid — owned by the main process (ProtocolContext), never hardcoded /
// user-entered. All control panels read this and stay DISABLED until ready.
let protoCtx = { aid: null, eid: null, ready: false };
function protoCtxReady() { return !!(protoCtx && protoCtx.ready); }
function broadcastProtoCtx() { document.dispatchEvent(new CustomEvent('protoctx-change')); }
if (api.onProtocolContext) api.onProtocolContext((c) => { protoCtx = c || protoCtx; broadcastProtoCtx(); });
if (api.protocolContext) api.protocolContext(currentRunId).then((c) => { if (c) { protoCtx = c; broadcastProtoCtx(); } }).catch(() => {});

let licenseState = { active: false, checking: true, machineId: null };
const UTC_PLUS_7_OFFSET_SECONDS = 7 * 60 * 60;
function dateFromSecondsTrusted(seconds) {
  return seconds ? new Date((Number(seconds) + UTC_PLUS_7_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10) : '---';
}
function remainingDaysTrusted(expiresAt) {
  if (!expiresAt) return '---';
  const nowSeconds = Number(licenseState.nowSeconds || 0);
  if (!nowSeconds) return 'checking';
  const days = Math.ceil((Number(expiresAt) - nowSeconds) / 86400);
  return days < 0 ? 'đã hết hạn' : `${days} ngày`;
}
function licenseFriendly(status) {
  const code = status && status.error && status.error.code;
  if (!code) return '';
  if (code === 'LICENSE_MISSING') return 'Nhập khóa kích hoạt để mở khóa thiết bị này.';
  if (code === 'LICENSE_EXPIRED') return `BẢN QUYỀN ĐÃ HẾT HẠN\nHết hạn ${dateFromSecondsTrusted(status.error.expiredAt || (status.error.payload && status.error.payload.expiresAt))}\nLiên hệ nhà cung cấp để gia hạn.`;
  if (code === 'LICENSE_MACHINE_MISMATCH') return 'Khóa kích hoạt không thuộc máy này.';
  if (code === 'LICENSE_BAD_SIGNATURE') return 'Chữ ký khóa không hợp lệ. Kiểm tra lại khóa và thử lại.';
  if (code === 'LICENSE_CLOCK_ROLLBACK') return 'Phát hiện đồng hồ hệ thống bị chỉnh lùi. Liên hệ hỗ trợ.';
  if (code === 'TRUSTED_TIME_UNAVAILABLE') return 'Không xác minh được thời gian UTC+7 tin cậy. Kiểm tra kết nối mạng và thử lại.';
  if (code === 'LICENSE_LAUNCH_LIMIT_REACHED') return `ĐÃ ĐẠT GIỚI HẠN SỐ LẦN CHẠY\nĐã dùng ${status.error.usedLaunches || 0} / ${status.error.maxLaunches || 0} lần.\nLiên hệ nhà cung cấp để gia hạn.`;
  if (code === 'MACHINE_ID_UNAVAILABLE') return 'Không lấy được Mã máy trên máy tính này.';
  if (code === 'LICENSE_WRONG_PRODUCT') return 'Khóa này dành cho sản phẩm khác.';
  if (code === 'LICENSE_INVALID_FORMAT') return 'Khóa kích hoạt không hợp lệ.';
  return 'Bản quyền không hợp lệ.';
}
function renderLicenseStatus(status) {
  licenseState = status || licenseState;
  document.body.dataset.license = licenseState.active ? 'active' : 'locked';
  const hasStoredLicense = Boolean(licenseState.hasStoredLicense);
  const shellLicense = $('shell-license');
  if (shellLicense) {
    shellLicense.textContent = licenseState.checking
      ? 'Đang kiểm tra bản quyền...'
      : licenseState.active && licenseState.payload
      ? `Bản quyền còn ${remainingDaysTrusted(licenseState.payload.expiresAt)} · Hết hạn ${dateFromSecondsTrusted(licenseState.payload.expiresAt)}`
      : 'Chưa kích hoạt bản quyền';
  }
  if (licenseState.active) refreshEntitlement();
  const machine = $('activation-machine'); if (machine) machine.value = licenseState.machineId || 'MACHINE_ID_UNAVAILABLE';
  const err = $('activation-error');
  if (err) {
    const msg = licenseFriendly(licenseState);
    err.hidden = !msg || (licenseState.error && licenseState.error.code === 'LICENSE_MISSING');
    err.textContent = msg;
  }
  const licenseInput = $('activation-license');
  const licenseLabel = licenseInput && licenseInput.closest ? licenseInput.closest('label') : null;
  const submit = $('activation-submit');
  const storedNeedsNewKey = licenseState.error && ['LICENSE_EXPIRED', 'LICENSE_MACHINE_MISMATCH', 'LICENSE_BAD_SIGNATURE', 'LICENSE_WRONG_PRODUCT', 'LICENSE_LAUNCH_LIMIT_REACHED'].includes(licenseState.error.code);
  const hideKeyEntry = hasStoredLicense && !licenseState.active && !storedNeedsNewKey;
  if (licenseLabel) licenseLabel.hidden = hideKeyEntry;
  if (submit) submit.hidden = hideKeyEntry;
  const help = $('activation-help');
  if (help && hideKeyEntry) help.textContent = licenseState.checking ? 'Đã tìm thấy khóa đã lưu. Đang xác minh...' : 'Đã tìm thấy khóa đã lưu nhưng chưa xác minh được lúc này.';
  else if (help) help.textContent = 'Gửi Mã máy này cho nhà cung cấp bản quyền.';
  const lm = $('activation-license-machine');
  const licenseMachine = licenseState.error && licenseState.error.licenseMachineId;
  if (lm) { lm.hidden = !licenseMachine; lm.textContent = licenseMachine ? `Mã máy của khóa: ${licenseMachine}` : ''; }
  if (licenseState.active && $('activation-license')) $('activation-license').value = '';
  if (typeof renderOverview === 'function' && $('view-overview') && !$('view-overview').hidden) renderOverview();
}
// WU-C.4 — compact verified-entitlement display (plan / capacity / features). Read
// from the trusted main-process snapshot; the renderer never decides authorization.
let entitlementState = null;
const FEATURE_VI = { autoRun: 'Chạy tự động', jackpotLive: 'Jackpot trực tiếp', jackpotGate: 'Chờ Jackpot', roundHistory: 'Lịch sử vòng chơi' };
async function refreshEntitlement() {
  if (!api.licenseEntitlement) return;
  try { entitlementState = await api.licenseEntitlement(); } catch { entitlementState = null; }
  const e = entitlementState;
  const chip = $('shell-license');
  if (chip && e && e.valid && !e.error) {
    const plan = e.plan && e.plan !== 'LEGACY' ? ` · Gói ${e.plan}` : (e.legacy ? ' · Gói cũ' : '');
    if (!/Gói/.test(chip.textContent)) chip.textContent = chip.textContent + plan;
    const cap = `Hồ sơ ${e.registeredBrowsers}/${e.maxBrowsers == null ? '∞' : e.maxBrowsers} · Đang chạy ${e.runningBrowsers}/${e.maxConcurrentBrowsers == null ? '∞' : e.maxConcurrentBrowsers}`;
    const feats = Object.keys(FEATURE_VI).map((k) => (e.features && e.features[k] ? '✓' : '✕') + ' ' + FEATURE_VI[k]).join(' · ');
    chip.title = `${cap}\n${feats}`;
    // Compact always-visible capacity badge in the appbar (signed truth).
    const capBadge = $('cap-badge');
    if (capBadge) {
      capBadge.textContent = cap;
      capBadge.classList.toggle('full', e.maxBrowsers != null && e.registeredBrowsers >= e.maxBrowsers);
    }
    // Feature-locked visual states (§16/§22): drive body flags the CSS/UX react to.
    document.body.dataset.autorun = e.features && e.features.autoRun ? 'on' : 'off';
    document.body.dataset.jackpot = e.features && e.features.jackpotLive ? 'on' : 'off';
    document.body.dataset.jackpotgate = e.features && e.features.jackpotGate ? 'on' : 'off';
    document.body.dataset.history = e.features && e.features.roundHistory ? 'on' : 'off';
  }
  document.dispatchEvent(new CustomEvent('entitlement-change', { detail: e }));
}
async function refreshLicenseStatus() {
  if (!api.licenseStatus) { document.body.dataset.license = 'active'; return; }
  try { renderLicenseStatus(await api.licenseStatus()); }
  catch { renderLicenseStatus({ active: false, error: { code: 'LICENSE_MISSING', message: 'License status unavailable' } }); }
}
(function activationUI() {
  const copyBtn = $('activation-copy');
  if (copyBtn) copyBtn.onclick = () => copy($('activation-machine').value, 'Machine ID');
  const submit = $('activation-submit');
  if (submit) submit.onclick = async () => {
    submit.disabled = true; submit.textContent = 'ĐANG XÁC MINH...';
    try { renderLicenseStatus(await api.activateLicense(($('activation-license').value || '').trim())); }
    catch { renderLicenseStatus({ active: false, machineId: licenseState.machineId, error: { code: 'LICENSE_INVALID_FORMAT', message: 'Kích hoạt thất bại' } }); }
    submit.disabled = false; submit.textContent = 'KÍCH HOẠT';
  };
  refreshLicenseStatus();
  setInterval(refreshLicenseStatus, 60_000);
  if (api.onLicenseChanged) api.onLicenseChanged(renderLicenseStatus);
})();

// ---- state ----
const reqs = new Map();        // id -> { id, method, url, host, path, targetId, cdpRequestId, resourceType, status, duration }
const order = [];              // capture order (append)
const replayedIds = new Set();
const interceptedIds = new Set();
let selectedId = null, detail = null, draft = null, timelineData = null, selectedEventId = null;
let activeTab = 'overview';
let interceptOn = false, paused = [], pausedSelected = null;
let listDirty = false;
// User actions (clicks) captured in the target, and the request->click link.
const actions = [];            // newest-first click records { id, text, tag, selector, url, timestamp, count }
const actionById = new Map();
let actionFilter = null;       // when set, the request list shows only this click's requests
let actionsDirty = false;

function urlParts(u) { try { const x = new URL(u); return { host: x.host, path: x.pathname + (x.search || '') }; } catch { return { host: '', path: u }; } }

// ---- toast ----
let toastEl, toastTimer;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}
async function copy(text, label) {
  try {
    if (api.copyText) await api.copyText(text);
    else await navigator.clipboard.writeText(text);
    toast((label || 'Copied') + ' ✓');
  } catch {
    toast('Copy failed');
  }
}

// ---- capture stream ----
api.onEvent && api.onEvent((ev) => {
  if (ev.kind === 'request') {
    if (!reqs.has(ev.id)) order.push(ev.id);
    const prev = reqs.get(ev.id) || {};
    const causedBy = ev.causedBy || prev.causedBy || null;
    reqs.set(ev.id, { ...prev, id: ev.id, method: ev.method, url: ev.url, targetId: ev.targetId, cdpRequestId: ev.requestId, resourceType: (ev.resourceType || '').toLowerCase(), causedBy, status: prev.status ?? null, duration: prev.duration ?? null, ...urlParts(ev.url) });
    if (ev.causedBy && !prev.causedBy) { const a = actionById.get(ev.causedBy); if (a) { a.count = (a.count || 0) + 1; markActionsDirty(); } }
    markDirty();
  } else if (ev.kind === 'response') {
    const r = reqs.get(ev.id);
    if (r) { r.status = ev.status; r.duration = ev.duration; markDirty(); if (selectedId === ev.id && activeTab === 'overview') renderDetail(); }
  } else if (ev.kind === 'interaction') {
    const a = { id: ev.id, text: ev.text || '', tag: ev.tag || '', selector: ev.selector || '', url: ev.url || '', timestamp: ev.timestamp, count: 0 };
    actions.unshift(a); actionById.set(a.id, a);
    if (actions.length > 500) { const old = actions.pop(); actionById.delete(old.id); }
    markActionsDirty();
  }
});
function markDirty() { if (listDirty) return; listDirty = true; requestAnimationFrame(() => { listDirty = false; renderList(); }); }
function markActionsDirty() { if (actionsDirty) return; actionsDirty = true; requestAnimationFrame(() => { actionsDirty = false; renderActions(); }); }

// ---- request list (windowed) ----
const MAX_ROWS = 400;
function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const f = $('filter').value;
  const terms = q ? q.split(/\s+/) : [];
  const out = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const r = reqs.get(order[i]); if (!r) continue;
    if (actionFilter && r.causedBy !== actionFilter) continue;
    if (f === 'ws' && r.resourceType !== 'websocket') continue;
    if (f === 'wssent' && !(r.resourceType === 'websocket' && String(r.method || '').indexOf('▶') >= 0)) continue;
    if (f === 'fetch' && r.resourceType !== 'fetch') continue;
    if (f === 'xhr' && r.resourceType !== 'xhr') continue;
    if (f === 'failed' && !(r.status === 0 || (r.status != null && r.status >= 400))) continue;
    if (f === 'replayed' && !replayedIds.has(r.id)) continue;
    if (f === 'intercepted' && !interceptedIds.has(r.id)) continue;
    if (terms.length) { const hay = (r.method + ' ' + r.host + ' ' + r.path + ' ' + (r.status ?? '')).toLowerCase(); if (!terms.every((t) => hay.includes(t))) continue; }
    out.push(r);
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}
function statusClass(s) { return s == null ? 'pending' : (s === 0 || s >= 400) ? 'err' : 'ok'; }
function renderList() {
  const list = filtered();
  const total = reqs.size;
  $('count').textContent = total ? (list.length < total ? `${list.length} of ${total}` : `${total}`) : '';
  if (!total) { $('list').innerHTML = '<div class="empty">Waiting for network activity…</div>'; return; }
  if (!list.length) { $('list').innerHTML = '<div class="empty">No requests match the filter.</div>'; return; }
  $('list').innerHTML = list.map((r) => {
    const badges = (replayedIds.has(r.id) ? '<span class="badge">R</span>' : '') + (interceptedIds.has(r.id) ? '<span class="badge i">I</span>' : '');
    return `<div class="row ${selectedId === r.id ? 'selected' : ''}" data-id="${esc(r.id)}">`
      + `<span class="m" data-m="${esc(r.method)}">${esc(r.method)}</span>`
      + `<span class="u"><b>${esc(r.path)}${badges}</b><span>${esc(r.host)} · ${esc(r.resourceType || 'other')}</span></span>`
      + `<span class="t">${r.duration != null ? Math.round(r.duration) + 'ms' : ''}</span>`
      + `<span class="s ${statusClass(r.status)}">${r.status == null ? '…' : (r.status || 'ERR')}</span></div>`;
  }).join('');
  for (const el of $('list').querySelectorAll('.row')) {
    el.onclick = () => selectRequest(el.dataset.id);
    el.oncontextmenu = (e) => { e.preventDefault(); openContextMenu(e.clientX, e.clientY, el.dataset.id); };
  }
}

// ---- actions panel (clicks -> requests) ----
function fmtTimeShort(t) { try { return new Date(t).toLocaleTimeString(); } catch { return ''; } }
function renderActions() {
  const badge = $('act-count'); if (badge) badge.textContent = actions.length ? String(actions.length) : '';
  const el = $('actions'); if (!el) return;
  const showall = $('act-showall'); if (showall) showall.hidden = !actionFilter;
  if (!actions.length) { el.innerHTML = '<div class="empty">Chưa có thao tác.<div class="empty-sub">Hãy click trong target (nút Cược…). Mỗi click hiện ở đây kèm số request nó tạo ra.</div></div>'; return; }
  el.innerHTML = actions.map((a) => {
    const label = a.text || a.selector || a.tag || 'click';
    return `<div class="act-item ${actionFilter === a.id ? 'sel' : ''}" data-a="${esc(a.id)}" title="${esc(a.selector || '')}">`
      + `<div class="act-main"><span class="act-ic">👆</span><b>${esc(label)}</b></div>`
      + `<div class="act-meta">${esc(a.tag || 'click')} · ${fmtTimeShort(a.timestamp)} · <span class="act-n ${a.count ? 'has' : ''}">${a.count || 0} req</span></div>`
      + `</div>`;
  }).join('');
  for (const c of el.querySelectorAll('[data-a]')) c.onclick = () => {
    actionFilter = (actionFilter === c.dataset.a) ? null : c.dataset.a; // toggle
    renderActions(); renderList();
  };
}
$('act-toggle').onclick = () => { const p = $('act-panel'); p.hidden = !p.hidden; };
$('act-close').onclick = () => { $('act-panel').hidden = true; };
$('act-showall').onclick = () => { actionFilter = null; renderActions(); renderList(); };
$('act-clear').onclick = () => { actions.length = 0; actionById.clear(); actionFilter = null; renderActions(); renderList(); };

// ---- selection -> detail + timeline + editor ----
async function selectRequest(id) {
  selectedId = id; pausedSelected = null; selectedEventId = null; renderList();
  detail = await api.getRequestDetail(id);
  timelineData = await api.timelineBuild(id);
  const d = await api.replayCreateDraft(id, {});
  draft = d && !d.error ? d : null;
  renderTimeline(); renderDetail(); renderEditor();
}

function renderTimeline() {
  const el = $('timeline');
  if (!timelineData || timelineData.error) { el.innerHTML = '<div class="empty">Select a request.</div>'; return; }
  const s = timelineData.summary;
  const glyph = { capture: '●', replay: '↻', intercept: '⧗' };
  const head = `<div class="tl-card summary"><div class="k">Summary</div><div class="l">${s.replayed} replay · ${s.intercepted} intercept · last ${s.lastStatus ?? '—'}</div>${s.lastError ? `<div class="meta errb">error: ${esc(s.lastError.code)}</div>` : ''}</div>`;
  const cards = timelineData.events.map((e) => {
    const when = fmtTime(e.time);
    const st = e.status != null ? ` → ${e.status}` : '';
    return `<div class="tl-card ${selectedEventId === e.id ? 'sel' : ''}" data-kind="${esc(e.kind)}" data-ev="${esc(e.id)}">`
      + `<div class="k">${glyph[e.kind] || '•'} ${esc(e.kind)}${e.mode ? ' · ' + esc(e.mode) : ''}</div>`
      + `<div class="l">${esc(e.method || '')} ${esc(e.summary)}${st}</div>`
      + `<div class="meta">${when} · ${esc(e.state)}${e.error ? ' · ' + esc(e.error.code) : ''}</div></div>`;
  }).join('');
  el.innerHTML = head + cards;
  for (const c of el.querySelectorAll('[data-ev]')) c.onclick = () => { selectedEventId = c.dataset.ev; activeTab = 'diff'; syncTabs(); renderTimeline(); renderDetail(); };
}

// ---- detail tabs ----
for (const t of document.querySelectorAll('#detail-tabs .tab')) t.onclick = () => { activeTab = t.dataset.tab; syncTabs(); renderDetail(); };
function syncTabs() { for (const t of document.querySelectorAll('#detail-tabs .tab')) t.classList.toggle('active', t.dataset.tab === activeTab); }

function headersTable(h) {
  const rows = Object.entries(h || {});
  if (!rows.length) return '<div class="muted">none</div>';
  return '<table>' + rows.map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>';
}
function prettyBody(raw, contentType) {
  if (raw == null || raw === '') return '<div class="muted">empty</div>';
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('json') || /^[\[{]/.test(String(raw).trim())) { try { return `<pre>${esc(JSON.stringify(JSON.parse(raw), null, 2))}</pre>`; } catch { /* fall through */ } }
  return `<pre>${esc(String(raw).slice(0, 20000))}</pre>`;
}
function renderDetail() {
  const el = $('detail');
  if (!detail || detail.error) { el.innerHTML = `<div class="empty">${detail && detail.error ? esc(detail.error.code) : 'Select a request.'}</div>`; return; }
  const r = detail, resp = r.response;
  if (activeTab === 'overview') {
    const lastErr = timelineData && timelineData.summary && timelineData.summary.lastError;
    el.innerHTML = `<div class="kv">`
      + kv('Method', r.method) + kv('Status', resp ? resp.status + ' ' + (resp.statusText || '') : (r.state === 'FAILED' ? 'FAILED' : 'pending'))
      + kv('Duration', r.durationMs != null ? Math.round(r.durationMs) + 'ms' : '—') + kv('Target', r.targetId)
      + kv('Type', r.resourceType) + kv('State', r.state) + kv('Host', r.host) + kv('Path', r.path)
      + `</div><h4>URL</h4><pre>${esc(r.url)}</pre>`
      + (r.failure ? `<h4>Failure</h4><div class="errb">${esc(r.failure.errorText || JSON.stringify(r.failure))}</div>` : '')
      + (lastErr ? `<h4>Last error</h4><div class="errb">${esc(lastErr.code)}${lastErr.message ? ' — ' + esc(lastErr.message) : ''}</div>` : '');
  } else if (activeTab === 'request') {
    el.innerHTML = `<h4>Headers</h4>${headersTable(r.headers)}`
      + `<h4>Cookies</h4>${(r.cookies && r.cookies.length) ? headersTable(Object.fromEntries(r.cookies.map((c) => [c.name, c.value]))) : '<div class="muted">none</div>'}`
      + `<h4>Body</h4>${prettyBody(r.body && r.body.raw, r.body && r.body.contentType)}`;
  } else if (activeTab === 'response') {
    if (!resp) { el.innerHTML = '<div class="empty">No response' + (r.state === 'FAILED' ? ' (request failed)' : ' yet') + '.</div>'; return; }
    el.innerHTML = `<div class="kv">${kv('Status', resp.status + ' ' + (resp.statusText || ''))}${kv('MIME', resp.mimeType || '—')}${kv('Protocol', resp.protocol || '—')}${kv('Remote', resp.remoteIP || '—')}${kv('Size', resp.encodedSize != null ? resp.encodedSize + ' B' : '—')}</div>`
      + `<h4>Headers</h4>${headersTable(resp.headers)}`
      + `<h4>Body</h4><button id="loadbody">Load response body</button><div id="respbody"></div>`;
    $('loadbody').onclick = async () => {
      const btn = $('loadbody'); btn.textContent = 'Loading…'; btn.disabled = true;
      const b = await api.getResponseBody(r.id); const out = $('respbody');
      if (b && b.available) out.innerHTML = b.base64Encoded
        ? `<div class="muted">binary · ${b.length || 0} bytes${b.truncated ? ' · truncated' : ''}</div><pre>${esc(String(b.body).slice(0, 4000))}</pre>`
        : prettyBody(b.body, resp.mimeType);
      else out.innerHTML = `<div class="errb">${esc(b && b.error && b.error.code || 'RESPONSE_BODY_UNAVAILABLE')}${b && b.error && b.error.message ? ' — ' + esc(b.error.message) : ''}</div>`;
      btn.textContent = 'Reload body'; btn.disabled = false;
    };
  } else if (activeTab === 'diff') {
    const ev = timelineData && timelineData.events.find((x) => x.id === selectedEventId);
    if (!ev) { el.innerHTML = '<div class="empty">Pick a Replay or Intercept card in the Timeline to see what changed.</div>'; return; }
    el.innerHTML = `<h4>${esc(ev.summary)}</h4><pre>${esc(fmtDiff(ev))}</pre>`;
  } else if (activeTab === 'history') {
    if (!timelineData) { el.innerHTML = '<div class="empty">No history.</div>'; return; }
    el.innerHTML = '<pre>' + esc(timelineData.events.map((e) => `${fmtTime(e.time)}  ${e.kind}  ${e.summary}  [${e.state}]  ${e.method || ''} ${e.status != null ? '→ ' + e.status : ''}${e.error ? '  ' + e.error.code : ''}`).join('\n')) + '</pre>';
  }
}
function kv(k, v) { return `<b>${esc(k)}</b><span>${esc(v)}</span>`; }

function fmtDiff(e) {
  const out = [];
  const d = e.requestDiff;
  if (d && d.changed) {
    if (d.method.changed) out.push('method: ' + d.method.from + ' → ' + d.method.to);
    if (d.url.changed) out.push('url: ' + d.url.from + ' → ' + d.url.to);
    for (const h of d.headers.changed) out.push('header ' + h.name + ': ' + h.from + ' → ' + h.to);
    for (const h of d.headers.added) out.push('+ header ' + h.name + ': ' + h.value);
    for (const h of d.headers.removed) out.push('- header ' + h.name);
    if (d.body && d.body.changed) {
      if (d.body.type === 'json') for (const c of d.body.changes) out.push('body ' + c.path + ': ' + (c.op === 'change' ? JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to) : c.op === 'add' ? '+ ' + JSON.stringify(c.to) : '- ' + JSON.stringify(c.from)));
      else out.push('body changed (' + (d.body.type || 'raw') + ')');
    }
  } else if (d) out.push('request identical to original');
  const rd = e.responseDiff;
  if (rd && rd.comparable) {
    out.push('');
    if (rd.status.changed) out.push('response status: ' + rd.status.from + ' → ' + rd.status.to);
    if (rd.headers.count) out.push('response headers changed: ' + rd.headers.count);
    if (rd.body && rd.body.comparable === false) out.push('response body: ' + (rd.body.reason || 'not comparable'));
    else if (rd.body && rd.body.changed) out.push('response body changed');
    if (rd.duration && rd.duration.deltaMs != null) out.push('duration Δ: ' + rd.duration.deltaMs + 'ms');
  }
  if (e.warnings && e.warnings.length) { out.push(''); out.push('warnings: ' + e.warnings.map((w) => w.header ? w.header + ':' + w.policy : (w.policy || w.reason)).join(', ')); }
  if (e.error) { out.push(''); out.push('error: ' + e.error.code + (e.error.message ? ' — ' + e.error.message : '')); }
  return out.join('\n') || '(no changes)';
}
function fmtTime(t) { try { return new Date(t).toLocaleTimeString(); } catch { return t; } }

// ---- editor (replay or intercept) ----
function renderEditor() {
  const el = $('editor');
  if (pausedSelected) return renderInterceptEditor(el, pausedSelected);
  if (detail && detail.isWebSocket) return renderWsEditor(el, detail);
  if (!draft) { el.innerHTML = '<div class="empty">Select a request to replay, or a paused request to intercept.</div>'; return; }
  el.innerHTML = `<h3>↺ Replay <span class="faint" style="font-weight:400;font-size:var(--t-sm)">— duplicated from captured request (original unchanged)</span></h3>`
    + `<div class="row2"><div class="field" style="flex:0 0 168px"><span class="lbl">Mode</span><select id="e-mode"><option value="WEBVIEW_CONTEXT">WebView Context</option><option value="HTTP_DIRECT">HTTP Direct</option></select></div>`
    + `<div class="field" style="flex:0 0 96px"><span class="lbl">Method</span><input id="e-method" class="mono" value="${esc(draft.method)}"></div>`
    + `<div class="field"><span class="lbl">URL</span><input id="e-url" class="url-in" value="${esc(draft.url)}"></div>`
    + `<div class="field" style="flex:0 0 auto"><span class="lbl">&nbsp;</span><button class="primary" id="e-send" title="Ctrl+Enter">Send ⌘↵</button></div></div>`
    + `<div class="row2"><div class="field"><span class="lbl">Headers (JSON)</span><textarea id="e-headers" rows="4">${esc(JSON.stringify(draft.headers, null, 2))}</textarea></div>`
    + `<div class="field"><span class="lbl">Body (raw)</span><textarea id="e-body" rows="4">${esc(draft.body && draft.body.raw || '')}</textarea></div></div>`
    + `<div id="e-result"></div>`;
  $('e-send').onclick = sendReplay;
}
async function sendReplay() {
  if (!draft) return;
  const btn = $('e-send'); btn.disabled = true; btn.textContent = 'Sending…';
  let headers; try { headers = JSON.parse($('e-headers').value || '{}'); } catch { $('e-result').innerHTML = '<div class="errb">INVALID_HEADER: headers must be valid JSON</div>'; btn.disabled = false; btn.textContent = 'Send'; return; }
  const patch = { mode: $('e-mode').value, method: $('e-method').value.trim().toUpperCase(), url: $('e-url').value.trim(), headers, body: $('e-body').value };
  const upd = await api.replayUpdateDraft(draft.id, patch);
  if (upd && upd.error) { $('e-result').innerHTML = `<div class="errb">${esc(upd.error.code)}: ${esc(upd.error.message || '')}</div>`; btn.disabled = false; btn.textContent = 'Send'; return; }
  const ex = await api.replayExecute(draft.id);
  const r = ex.response;
  if (ex.status === 'COMPLETED') {
    replayedIds.add(selectedId); markDirty();
    $('e-result').innerHTML = `<div class="result"><div class="st ${statusClass(r.status)}">${r.status} ${esc(r.statusText || '')}</div><div class="muted">${esc(r.mode)} · ${r.duration || 0}ms</div>`
      + (r.warnings && r.warnings.length ? `<div class="warnb">warnings: ${esc(r.warnings.map((w) => w.header ? w.header + ':' + w.policy : (w.policy || w.reason)).join(', '))}</div>` : '')
      + `${prettyBody(r.body, r.headers && (r.headers['content-type'] || r.headers['Content-Type']))}</div>`;
  } else {
    $('e-result').innerHTML = `<div class="errb">${esc(ex.error && ex.error.code || 'REPLAY_FAILED')}: ${esc(ex.error && ex.error.message || '')}</div>`;
  }
  timelineData = await api.timelineBuild(selectedId); renderTimeline();
  btn.disabled = false; btn.textContent = 'Send';
}

function renderWsEditor(el, r) {
  const dir = r.wsDirection === 'recv' ? 'nhận ◀' : 'gửi ▶';
  el.innerHTML = `<h3>⇄ WebSocket <span class="faint" style="font-weight:400;font-size:var(--t-sm)">— ${esc(r.host)} · frame ${esc(dir)} · sửa payload rồi gửi lại qua đúng kết nối của trang</span></h3>`
    + `<div class="row2"><div class="field"><span class="lbl">Payload</span><textarea id="ws-body" rows="6" class="mono">${esc((r.body && r.body.raw) || '')}</textarea></div></div>`
    + `<div class="row2"><button class="primary" id="ws-send" title="Ctrl+Enter">Send frame ⌘↵</button>`
    + `<span class="faint" style="align-self:center">Nếu báo WS_SEND_FAILED: Reload game rồi thử lại (socket phải gửi ≥1 frame để tool bám vào).</span></div>`
    + `<div id="ws-result"></div>`;
  $('ws-send').onclick = async () => {
    const btn = $('ws-send'); btn.disabled = true; btn.textContent = 'Sending…';
    const res = await api.wsSend(r.id, $('ws-body').value);
    $('ws-result').innerHTML = res && res.ok
      ? `<div class="result"><div class="st ok">Sent ✓</div><div class="muted">Đã gửi lại 1 frame qua WebSocket của trang.</div></div>`
      : `<div class="errb">${esc(res && res.error && res.error.code || 'WS_SEND_FAILED')}: ${esc(res && res.error && res.error.message || '')}</div>`;
    btn.disabled = false; btn.textContent = 'Send frame';
  };
}

function renderInterceptEditor(el, p) {
  el.innerHTML = `<h3>⧗ Intercept <span class="faint" style="font-weight:400;font-size:var(--t-sm)">— ${esc(p.targetId)} · paused ${esc(fmtTime(p.pausedAt))}</span></h3>`
    + `<div class="row2"><div class="field" style="flex:0 0 96px"><span class="lbl">Method</span><input id="i-method" class="mono" value="${esc(p.draft.method)}"></div>`
    + `<div class="field"><span class="lbl">URL</span><input id="i-url" class="url-in" value="${esc(p.draft.url)}"></div></div>`
    + `<div class="row2"><div class="field"><span class="lbl">Headers (JSON)</span><textarea id="i-headers" rows="4">${esc(JSON.stringify(p.draft.headers, null, 2))}</textarea></div>`
    + `<div class="field"><span class="lbl">Body (raw)</span><textarea id="i-body" rows="4">${esc(p.draft.body || '')}</textarea></div></div>`
    + `<div class="row2"><button class="primary" id="i-mod" title="Ctrl+Enter">Continue Modified</button><button id="i-cont">Continue</button><button id="i-abort" class="danger">Abort</button></div><div id="i-result"></div>`;
  const show = (r) => { $('i-result').innerHTML = r && r.error ? `<div class="errb">${esc(r.error.code)}: ${esc(r.error.message || '')}</div>` : `<div class="muted">${esc(r.state)}</div>`; };
  $('i-cont').onclick = async () => { show(await api.interceptContinue(p.id)); pausedSelected = null; };
  $('i-abort').onclick = async () => { show(await api.interceptAbort(p.id)); pausedSelected = null; };
  $('i-mod').onclick = async () => {
    let headers; try { headers = JSON.parse($('i-headers').value || '{}'); } catch { $('i-result').innerHTML = '<div class="errb">INVALID_INTERCEPT_DRAFT: headers must be valid JSON</div>'; return; }
    show(await api.interceptContinueModified(p.id, { method: $('i-method').value.trim().toUpperCase(), url: $('i-url').value.trim(), headers, body: $('i-body').value }));
    pausedSelected = null;
  };
}

// ---- context menu (copy) ----
let ctxEl;
async function openContextMenu(x, y, id) {
  closeContextMenu();
  const d = await api.getRequestDetail(id);
  if (!d || d.error) return;
  ctxEl = document.createElement('div'); ctxEl.className = 'ctx'; ctxEl.style.left = x + 'px'; ctxEl.style.top = y + 'px';
  const items = [
    ['Copy URL', () => copy(d.url, 'URL')],
    ['Copy as cURL', () => copy(toCurl(d), 'cURL')],
    ['Copy Headers', () => copy(Object.entries(d.headers || {}).map(([k, v]) => k + ': ' + v).join('\n'), 'Headers')],
    ['Copy Body', () => copy((d.body && d.body.raw) || '', 'Body')],
    ['Copy Response body', async () => { const b = await api.getResponseBody(id); copy(b && b.available ? b.body : ((b && b.error && b.error.code) || ''), 'Response'); }],
  ];
  ctxEl.innerHTML = items.map((_, i) => `<button data-i="${i}"></button>`).join('');
  [...ctxEl.querySelectorAll('button')].forEach((b, i) => { b.textContent = items[i][0]; b.onclick = () => { items[i][1](); closeContextMenu(); }; });
  document.body.appendChild(ctxEl);
}
function closeContextMenu() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
document.addEventListener('click', closeContextMenu);
function toCurl(d) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const parts = ['curl -X ' + d.method + ' ' + q(d.url)];
  for (const [k, v] of Object.entries(d.headers || {})) parts.push('-H ' + q(k + ': ' + v));
  if (d.body && d.body.raw) parts.push('--data-raw ' + q(d.body.raw));
  return parts.join(' \\\n  ');
}

// ---- targets ----
// Scope: when "All domains" is on, capture EVERYTHING fully (no redaction) — needed
// for games whose WS/API live on sibling domains. Off = only the launched host.
async function applyScope() { if ($('scope-all').checked) { await api.setScope([]); } else { let h = null; try { h = new URL($('url').value.trim()).hostname; } catch { /* none */ } await api.setScope(h ? [h] : []); } }
$('scope-all').onchange = () => { applyScope(); toast($('scope-all').checked ? 'Bắt tất cả domain' : 'Chỉ bắt host game'); };
applyScope();
$('launch').onclick = async () => { const url = $('url').value.trim(); if (!url) return toast('Enter a URL'); await applyScope(); await api.openBrowser(url); $('chip-cap').textContent = 'Launching…'; document.dispatchEvent(new CustomEvent('instance-runtime-refresh')); };
api.onTargetsChanged && api.onTargetsChanged((list) => {
  const sel = $('targets'); const cur = sel.value;
  const badge = { CHROME: 'Chrome', WEBVIEW2: 'WebView2', CEF: 'CEF', ANDROID_WEBVIEW: 'Android WebView', OTHER: 'Target' };
  sel.innerHTML = list && list.length ? list.map((t) => `<option value="${esc(t.cdpTargetId)}">${esc((badge[t.runtime] || t.runtime) + ' · ' + (t.title || t.url || t.cdpTargetId))}</option>`).join('') : '<option value="">No targets</option>';
  if (list && list.some((t) => t.cdpTargetId === cur)) sel.value = cur;
  const connected = !!(list && list.length);
  setChip('chip-conn', connected, connected ? 'Connected' : 'Disconnected');
  setChip('chip-cap', connected, connected ? 'Capturing' : 'Idle');
});
$('targets').onchange = () => { if ($('targets').value) api.selectTarget($('targets').value); };
$('ck-save').onclick = async () => { const r = await api.cookiesSave(); toast(r && r.ok ? `Saved session (${r.count} cookies${r.host ? ' · ' + r.host : ''})` : ((r && r.error && r.error.code) || 'Save failed')); };
$('ck-restore').onclick = async () => { const r = await api.cookiesRestore(undefined, true); toast(r && r.ok ? (r.count ? `Restored ${r.count} cookies${r.host ? ' · ' + r.host : ''} · reloading` : 'No saved session for this host') : ((r && r.error && r.error.code) || 'Restore failed')); };
api.onCdpError && api.onCdpError((e) => toast((e && e.code) || 'CDP error'));

// ---- intercept bar ----
$('intc-toggle').onchange = async () => {
  const rule = { host: $('intc-host').value.trim(), method: $('intc-method').value.trim(), urlContains: $('intc-url').value.trim() };
  if ($('intc-toggle').checked) { const r = await api.interceptEnable(rule); if (r && r.error) { $('intc-toggle').checked = false; toast(r.error.code); return; } interceptOn = true; }
  else { await api.interceptDisable(); interceptOn = false; }
  setChip('chip-intc', interceptOn, interceptOn ? 'Intercept ON' : 'Intercept OFF');
  $('intercept-bar').classList.toggle('armed', interceptOn);
};
api.onInterceptChanged && api.onInterceptChanged((list) => {
  paused = list || [];
  const chip = $('chip-paused'); chip.hidden = !paused.length; chip.textContent = paused.length + ' paused'; chip.className = 'chip warn';
  for (const p of paused) { const r = [...reqs.values()].find((x) => x.cdpRequestId === p.networkRequestId && x.targetId === p.targetId); if (r) interceptedIds.add(r.id); }
  renderPausedStrip();
  if (pausedSelected && !paused.some((p) => p.id === pausedSelected.id)) { pausedSelected = null; renderEditor(); }
});
function renderPausedStrip() {
  $('paused-strip').innerHTML = paused.map((p) => { let path = p.draft.url; try { path = new URL(p.draft.url).pathname; } catch { /* keep */ } return `<button class="paused-pill" data-p="${esc(p.id)}">⧗ ${esc(p.draft.method)} ${esc(path)}</button>`; }).join('');
  for (const b of $('paused-strip').querySelectorAll('[data-p]')) b.onclick = () => { pausedSelected = paused.find((x) => x.id === b.dataset.p); renderEditor(); };
}

// ---- toolbar misc ----
$('search').oninput = markDirty;
$('filter').onchange = renderList;
$('clear').onclick = () => { reqs.clear(); order.length = 0; replayedIds.clear(); interceptedIds.clear(); actions.length = 0; actionById.clear(); actionFilter = null; selectedId = null; detail = null; draft = null; timelineData = null; renderList(); renderActions(); $('timeline').innerHTML = '<div class="empty">Select a request.</div>'; $('detail').innerHTML = '<div class="empty">Select a request.</div>'; renderEditor(); };
$('theme').onclick = () => { const n = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = n; try { localStorage.setItem('wvd-theme', n); } catch { /* ignore */ } };
try { document.documentElement.dataset.theme = localStorage.getItem('wvd-theme') || 'light'; } catch { /* ignore */ }
function setChip(id, on, text) { const c = $(id); c.textContent = text; c.className = 'chip ' + (on ? 'on' : 'off'); }

// ---- keyboard ----
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); const b = $('i-mod') || $('ws-send') || $('e-send'); b && b.click(); return; }
  if (e.key === 'Escape') { if (ctxEl) { closeContextMenu(); return; } if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return; }
  if (e.key === 'Delete' && !typing) { e.preventDefault(); $('clear').click(); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !typing) {
    e.preventDefault(); const list = filtered(); if (!list.length) return;
    let idx = list.findIndex((r) => r.id === selectedId);
    idx = e.key === 'ArrowDown' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
    if (idx < 0) idx = 0; selectRequest(list[idx].id);
  }
});

renderList();
renderActions();

// ================= WU9 SMART PROTOCOL FORM (context-aware, manual send) =================
// The tool understands the protocol and builds the request. The developer never has to
// remember SID/aid/eid — those come from the Protocol Context (RoundTracker). Only the
// fields a command actually needs are shown. Send remains manual + allowlist-gated (WU7).
(function protocolHarnessUI() {
  if (!api.protocolExecute || !window.ProtocolForm) return; // preload/module missing — inert
  const PF = window.ProtocolForm;
  let round = null;                 // current server round {sid,state,lastOdd}
  let sidHistory = [];              // observed sids (for the stale-sid default)
  let env = { allowed: false, name: null, host: '' };
  const execs = [];                 // newest-first execution records
  const execById = new Map();

  const num = PF.toNum;
  const contextSid = () => (round && round.sid != null ? round.sid : null);
  const prevSid = () => (sidHistory.length >= 2 ? sidHistory[sidHistory.length - 2] : (contextSid() != null ? Number(contextSid()) - 1 : ''));

  // ---- collect the current form state (aid/eid from the session context) ----
  function collect() {
    const command = $('pf-command').value;
    const scenario = $('pf-scenario').value;
    return {
      command, scenario,
      amount: $('pf-b') ? $('pf-b').value : null,
      sid: contextSid(),
      aid: protoCtx.aid,   // session aid — never user input
      eid: protoCtx.eid,   // session eid — never user input
      staleSid: $('pf-stale-sid') ? num($('pf-stale-sid').value) : null,
      rawText: $('pf-raw') ? $('pf-raw').value : '',
    };
  }
  const ctx = () => ({ envAllowed: env.allowed, hasSid: contextSid() != null });

  // ---- Protocol Context card (read-only): SID/State/Odd + session aid/eid ----
  function renderContext() {
    $('pc-sid').textContent = contextSid() != null ? contextSid() : '—';
    $('pc-state').textContent = round && round.state ? round.state : '—';
    $('pc-odd').textContent = round && round.lastOdd != null ? round.lastOdd : '—';
    $('pc-aid').innerHTML = protoCtxReady() ? esc(protoCtx.aid) + ' <span class="faint">session</span>' : '<span class="faint">—</span>';
    $('pc-eid').innerHTML = protoCtxReady() ? esc(protoCtx.eid) + ' <span class="faint">session</span>' : '<span class="faint">—</span>';
    // Gate the whole form on the login context first, then on a live round.
    const empty = $('pf-empty');
    if (!protoCtxReady()) { empty.hidden = false; $('pf-body').hidden = true; empty.querySelector('div:nth-child(2)') && (empty.children[1].textContent = 'Waiting for login context…'); return; }
    const noRound = contextSid() == null;
    empty.hidden = !noRound;
    $('pf-body').hidden = noRound;
    if (noRound) empty.children[1].textContent = 'Waiting for cmd:100005…';
  }

  function setEnvBadge() {
    const chip = $('proto-env-chip');
    if (chip) { chip.textContent = env.allowed ? 'ENABLED' : 'OFF'; chip.className = 'chip ' + (env.allowed ? 'on' : 'off'); }
    const badge = $('proto-env');
    if (badge) {
      badge.textContent = env.allowed ? `TEST CONTROL — ENABLED · ${env.name || env.host}` : `CONTROL DISABLED${env.host ? ' · ' + env.host : ''}`;
      badge.className = 'proto-env ' + (env.allowed ? 'on' : 'off');
    }
  }
  async function refreshEnv() { try { env = await api.protocolEnvironment(currentRunId); } catch { env = { allowed: false }; } setEnvBadge(); recompute(); }

  // ---- dynamic request fields for command + scenario ----
  const SCENARIO_NOTE = {
    normal: '', stale: 'Validation mode — sends a stale round SID on purpose.',
    amount: 'Validation mode — sends an invalid amount on purpose.',
    duplicate: 'Validation mode — sends the same request twice.',
    manual: 'Manual payload — raw JSON editor.',
  };
  function renderFields() {
    const command = $('pf-command').value;
    const scenario = $('pf-scenario').value;
    $('pf-scenario-note').textContent = SCENARIO_NOTE[scenario] || '';
    const parts = [];
    if (scenario === 'manual') {
      const seed = PF.buildPayload({ command, scenario: 'normal', amount: '5000', sid: contextSid(), aid: 1, eid: 1 }).payload;
      parts.push(`<label class="pf-field">Raw JSON<textarea id="pf-raw" class="mono" rows="6">${esc(JSON.stringify(seed, null, 2))}</textarea></label>`);
    } else {
      if (command === 'bet') {
        const lbl = scenario === 'amount' ? 'Amount (invalid on purpose)' : 'Amount';
        parts.push(`<label class="pf-field">${esc(lbl)}<input id="pf-b" class="mono" value="5000"><span class="hint">Only field you need — cmd/sid/aid/eid are auto.</span></label>`);
      }
      if (scenario === 'stale') {
        parts.push(`<label class="pf-field">SID Override <span class="hint">(stale — server should reject)</span><input id="pf-stale-sid" class="mono" value="${esc(prevSid())}"></label>`);
      }
      if (command === 'cashout' && scenario !== 'stale') {
        parts.push(`<div class="pf-none">No input needed — SID / aid / eid come from the Protocol Context.</div>`);
      }
    }
    $('pf-fields').innerHTML = parts.join('');
    // aid/eid are session context (ProtocolContext), never editable here (§ context ownership).
    const advToggle = $('pf-adv-toggle'); if (advToggle) advToggle.style.display = 'none';
    const adv = $('pf-advanced'); if (adv) { adv.hidden = true; adv.innerHTML = ''; }
    // wire dynamic inputs
    for (const id of ['pf-b', 'pf-stale-sid', 'pf-raw']) { const el = $(id); if (el) el.oninput = recompute; }
    recompute();
  }

  // ---- recompute preview + summary + validation + send-enabled ----
  function recompute() {
    if (contextSid() == null && $('pf-scenario').value !== 'stale' && $('pf-scenario').value !== 'manual') { renderContext(); }
    const state = collect();
    const built = PF.buildPayload(state);
    // Gate the whole form on the session context first (§ context ownership).
    const v = protoCtxReady() ? PF.validate(state, ctx())
      : { canSend: false, level: 'block', message: 'Waiting for login context…', negative: false, expect: null, allowMismatch: false };

    // Payload preview (read-only)
    const pre = $('pf-json');
    pre.textContent = built.parseError ? '// invalid JSON' : JSON.stringify(built.payload, null, 2);

    // Command summary
    const sum = $('pf-summary');
    if (state.scenario === 'manual') sum.innerHTML = `<span class="s-k">Manual</span> ${esc(built.payload && built.payload.cmd != null ? 'cmd ' + built.payload.cmd : 'invalid JSON')}`;
    else {
      const p = built.payload || {};
      const bits = [`<span class="s-k">${state.command === 'cashout' ? 'Cashout' : 'Bet'}</span>`];
      if (state.command === 'bet') bits.push(`b <b>${esc(p.b)}</b>`);
      bits.push(`round <b>${esc(p.sid)}</b>`, `aid <b>${esc(p.aid)}</b>`, `eid <b>${esc(p.eid)}</b>`);
      sum.innerHTML = bits.join(' · ');
    }

    // Validation message
    const val = $('pf-validation');
    val.className = 'proto-validation ' + v.level;
    val.textContent = v.message;

    // Protocol lock: Send disabled unless validation allows AND a round exists.
    const send = $('pf-send');
    send.disabled = !v.canSend;
    send.dataset.negative = v.negative ? '1' : '';
    send.dataset.expect = v.expect || '';
    send.dataset.allow = v.allowMismatch ? '1' : '';
  }

  // ---- send (manual; reuses WU7 harness, allowlist-gated) ----
  $('pf-send').onclick = async () => {
    const btn = $('pf-send'); if (btn.disabled) return;
    const state = collect();
    const v = PF.validate(state, ctx());
    if (!v.canSend) return;
    const built = PF.buildPayload(state);
    btn.disabled = true; btn.textContent = 'Sending…';
    const base = { command: state.command, payload: built.payload, negative: v.negative, expect: v.expect, allowMismatch: v.allowMismatch };
    try {
      if (state.scenario === 'duplicate') {
        showSendResult(await api.protocolExecute(currentRunId, { ...base, source: 'NEGATIVE_TEST', expect: null, negative: false }), { ...base, source: 'NEGATIVE_TEST' });
        showSendResult(await api.protocolExecute(currentRunId, { ...base, source: 'NEGATIVE_TEST', expect: 'reject', negative: true }), { ...base, source: 'NEGATIVE_TEST' });
      } else {
        showSendResult(await api.protocolExecute(currentRunId, base), base);
      }
    } catch { toast('Send failed'); }
    btn.textContent = 'Send Request'; recompute();
  };

  // ---- history ----
  function renderExecs() {
    const el = $('pf-executions'); if (!el) return;
    if (!execs.length) { el.innerHTML = '<div class="muted">No actions sent yet.</div>'; return; }
    el.innerHTML = execs.slice(0, 40).map((x) => {
      const err = x.error ? `<div class="errb">${esc(x.error.code)}${x.error.message ? ' — ' + esc(x.error.message) : ''}</div>` : '';
      const resp = x.responsePayload ? ` · ack ${x.latencyMs != null ? x.latencyMs + 'ms' : ''}` : '';
      const warn = (x.warnings && x.warnings.length) ? `<div class="ptx-meta">⚠ ${x.warnings.map((w) => esc(w.code || w)).join(', ')}</div>` : '';
      return `<div class="ptx ${x.negative ? 'neg' : ''}">`
        + `<div class="ptx-head"><span class="ptx-result ${esc(x.result || 'PENDING')}">${esc(x.result || '…')}</span>`
        + `<span class="ptx-verdict ${esc(x.verdict || 'INCONCLUSIVE')}">${esc(x.verdict || '—')}</span></div>`
        + `<div class="ptx-meta">cmd ${esc(x.command)} · sid ${esc(x.sid)} · ${esc(x.source)}${resp}</div>`
        + warn + err + `</div>`;
    }).join('');
  }
  function pushExec(x) {
    if (execById.has(x.id)) { const i = execs.findIndex((e) => e.id === x.id); if (i >= 0) execs[i] = x; execById.set(x.id, x); }
    else { execs.unshift(x); execById.set(x.id, x); if (execs.length > 200) { const old = execs.pop(); execById.delete(old.id); } }
    renderExecs();
  }
  function showSendResult(result, base) {
    if (!result || !result.error) return;
    pushExec({
      id: 'uierr_' + Date.now(),
      result: 'ERROR',
      verdict: 'INCONCLUSIVE',
      source: base && base.source || 'MANUAL',
      command: base && base.payload ? base.payload.cmd : null,
      sid: base && base.payload ? base.payload.sid : null,
      error: result.error,
      warnings: [],
    });
    toast(result.error.code || 'Send failed');
  }

  // ---- controls ----
  $('pf-command').onchange = renderFields;
  $('pf-scenario').onchange = renderFields;
  $('pf-payload-toggle').onclick = () => { const el = $('pf-json'); el.hidden = !el.hidden; $('pf-payload-toggle').textContent = (el.hidden ? '▶' : '▼') + ' Auto payload'; };
  document.addEventListener('protoctx-change', () => { renderContext(); recompute(); }); // session aid/eid arrived

  // ---- live streams ----
  api.onAviatorRound && api.onAviatorRound((r) => {
    round = r;
    if (r && r.sid != null && !sidHistory.some((s) => String(s) === String(r.sid))) sidHistory.push(r.sid);
    renderContext(); recompute();
  });
  api.onProtocolExecution && api.onProtocolExecution((x) => pushExec(x));

  // ---- panel open/close ----
  async function openManual() {
    await refreshEnv();
    try { const st = await api.protocolRoundState(currentRunId); round = st.current; sidHistory = (st.sidHistory || []).map((h) => h.sid); } catch { /* ignore */ }
    try { const list = await api.protocolExecutions(currentRunId); execs.length = 0; execById.clear(); for (const x of list.reverse()) pushExec(x); } catch { /* ignore */ }
    renderContext(); renderFields();
  }
  $('proto-toggle').onclick = async () => { const p = $('proto-panel'); p.hidden = !p.hidden; if (!p.hidden) await openManual(); };
  $('proto-close').onclick = () => { $('proto-panel').hidden = true; };
  $('proto-panel').addEventListener('shell:activate', openManual); // WU11 nav hook

  // Refresh env when the selected target changes (chain the existing handler).
  const origTargetsChange = $('targets').onchange;
  $('targets').onchange = (e) => { if (origTargetsChange) origTargetsChange.call($('targets'), e); setTimeout(refreshEnv, 60); };

  renderFields();
})();

// ============================ WU8 READ-ONLY ROUND OBSERVER ============================
// Watches the server-driven round/odd stream and records per-round evidence. It NEVER
// sends anything — RoundTracker owns sid/odd/state; this panel only reads and displays.
(function roundObserverUI() {
  if (!api.observerSnapshot) return; // preload without WU8 — stay inert
  let snap = null;
  let detailSid = null;

  const fmtNum = (n, d) => (n == null || !Number.isFinite(Number(n))) ? '—' : (d != null ? Number(n).toFixed(d) : String(n));
  const ms = (n) => n == null ? '—' : Math.round(n) + 'ms';
  const secs = (n) => n == null ? '—' : (n / 1000).toFixed(1) + 's';

  function statusClassFor(s) { return (s === 'RUNNING' || s === 'OPEN' || s === 'LOCKED') ? 'on' : (s === 'ENDED' ? 'warn' : 'off'); }

  function render() {
    if (!snap) return;
    const chip = $('obs-status-chip'); if (chip) { chip.textContent = snap.status; chip.className = 'chip ' + statusClassFor(snap.status); }
    const cur = snap.current || {};
    const m = snap.metrics || {};
    $('obs-status').textContent = snap.status;
    $('obs-sid').textContent = snap.currentSid != null ? snap.currentSid : '—';
    $('obs-phase').textContent = cur.phase || '—';
    $('obs-odd').textContent = cur.currentOdd != null ? fmtNum(cur.currentOdd, 2) : '—';
    $('obs-maxodd').textContent = cur.maxOdd != null ? fmtNum(cur.maxOdd, 2) : '—';
    $('obs-frames').textContent = cur.oddFrameCount != null ? cur.oddFrameCount : '—';
    $('obs-last').textContent = cur.timeSinceLastOddMs != null ? ms(cur.timeSinceLastOddMs) + ' ago' : '—';
    $('obs-avgint').textContent = ms(cur.avgOddIntervalMs);
    $('obs-observed').textContent = m.observedRounds != null ? m.observedRounds : '—';

    const stream = $('obs-oddstream');
    const buf = (cur.recentOdds || []);
    stream.innerHTML = buf.length ? buf.slice(-40).map((o, i, arr) => `<span class="sid odd ${i === arr.length - 1 ? 'trig' : ''}">${esc(fmtNum(o.odd, 2))}</span>`).join('') : '<span class="muted">none</span>';

    $('obs-m-count').textContent = `${m.observedRounds ?? 0} / ${m.completedRounds ?? 0}`;
    $('obs-m-term').textContent = `${m.superseded ?? 0} / ${m.disconnected ?? 0}`;
    $('obs-m-dur').textContent = secs(m.avgRoundDurationMs);
    $('obs-m-minmax').textContent = `${secs(m.minRoundDurationMs)} / ${secs(m.maxRoundDurationMs)}`;
    $('obs-m-frames').textContent = m.avgOddFrames != null ? m.avgOddFrames : '—';
    $('obs-m-int').textContent = ms(m.avgOddIntervalMs);

    renderHistory(snap.history || []);
    renderDetail();
  }

  function termClass(t) { return t === 'ROUND_END' ? 'COMPLETED' : t === 'SUPERSEDED' ? 'ROUND_ENDED_BEFORE_TRIGGER' : t === 'DISCONNECTED' ? 'ENDED' : 'OBSERVING'; }

  function renderHistory(rounds) {
    const el = $('obs-history'); if (!el) return;
    if (!rounds.length) { el.innerHTML = '<div class="muted">No rounds observed yet.</div>'; return; }
    el.innerHTML = rounds.slice().reverse().slice(0, 60).map((r) => {
      return `<div class="obs-round" data-sid="${esc(r.sid)}">`
        + `<div class="obs-round-head"><b>sid ${esc(r.sid)}</b><span class="obs-res ${termClass(r.terminalReason)}">${esc(r.terminalReason || '—')}</span></div>`
        + `<div class="obs-round-meta">${esc(secs(r.durationMs))} · maxOdd ${esc(fmtNum(r.maxOdd, 2))} · end ${esc(fmtNum(r.endOdd, 2))} · ${esc(r.oddFrameCount)} frames · Δ ${esc(ms(r.avgOddIntervalMs))}</div>`
        + `</div>`;
    }).join('');
    for (const row of el.querySelectorAll('[data-sid]')) row.onclick = () => { detailSid = (detailSid === row.dataset.sid) ? null : row.dataset.sid; renderDetail(); };
  }

  function renderDetail() {
    const el = $('obs-detail'); if (!el) return;
    if (detailSid == null) { el.hidden = true; return; }
    const hist = (snap.history || []).find((r) => String(r.sid) === String(detailSid));
    const cur = snap.current && String(snap.current.sid) === String(detailSid) ? snap.current : null;
    const r = cur || hist;
    if (!r) { el.hidden = true; return; }
    const traces = (r.actionTraces || []).map((t) => `  ${t.type} cmd:${t.cmd}${t.ack ? ' → ACK' + (t.ack.odd != null ? ' odd=' + t.ack.odd : '') + (t.ack.wm != null ? ' wm=' + t.ack.wm : '') : ' (no ack)'}`).join('\n') || '  none';
    const samples = (r.recentOdds || []).slice(-20).map((o) => `  ${fmtNum(o.odd, 2)}  Δ${o.deltaMsFromPrevious == null ? '—' : Math.round(o.deltaMsFromPrevious) + 'ms'}`).join('\n') || '  none';
    el.hidden = false;
    el.textContent = `SID ${r.sid}  [${r.terminalReason || r.phase}]\n`
      + `OPEN    ${r.openedAt || '—'}\nLOCKED  ${r.lockedAt || '—'}\nRUNNING ${r.runningAt || '—'}\nENDED   ${r.endedAt || '—'}\n`
      + `duration ${secs(r.durationMs)} · maxOdd ${fmtNum(r.maxOdd, 2)} · endOdd ${fmtNum(r.endOdd, 2)} · frames ${r.oddFrameCount}\n`
      + `\nODD samples (last 20):\n${samples}\n\nActionTrace (read-only evidence):\n${traces}`;
  }

  api.onObserverUpdate && api.onObserverUpdate((s) => { snap = s; if (!$('obs-panel').hidden) render(); });

  $('obs-toggle').onclick = async () => {
    const p = $('obs-panel'); p.hidden = !p.hidden;
    if (!p.hidden) { try { snap = await api.observerSnapshot(currentRunId); } catch { snap = null; } render(); }
  };
  $('obs-close').onclick = () => { $('obs-panel').hidden = true; };
})();

// ==================== WU10 AUTOMATED RUNNER ====================
// Config -> Start. The runner takes SID/ODD only from the server (RoundTracker/Observer),
// sends one bet + at most one threshold cashout per round, N rounds.
(function autoTestUI() {
  if (!api.autotestStart) return; // preload without WU10 — inert
  const ATC = window.AutoTestConfig;
  let snap = null, env = { allowed: false, host: '' }, configValid = true, sequenceIndex = 0, sequenceRunning = false;
  let selectedDay = localTodayKey();

  function testRows() { return [...document.querySelectorAll('#at-test-rows .at-test-row')]; }
  function renumberRows() { testRows().forEach((row, i) => { row.dataset.index = String(i); row.querySelector('.at-row-number').textContent = String(i + 1); }); }
  function addTestRow(values = {}) {
    const row = document.createElement('div');
    row.className = 'at-test-row';
    row.innerHTML = `<span class="at-row-number"></span><label>Số vòng<input class="mono at-rounds" value="${esc(values.rounds ?? 10)}"><span class="cfg-err at-row-error-rounds"></span></label><label>Tiền cược<input class="mono at-amount" value="${esc(values.amount ?? 5000)}"><span class="cfg-err at-row-error-amount"></span></label><label>Dừng tại ODD<input class="mono at-stopodd" value="${esc(values.stopOdd ?? '2.00')}"><span class="cfg-err at-row-error-stopodd"></span></label><button class="btn icon at-row-remove" type="button" title="Xóa lượt">×</button>`;
    $('at-test-rows').appendChild(row);
    row.querySelector('.at-row-remove').onclick = () => { if (testRows().length > 1 && !sequenceRunning) { row.remove(); renumberRows(); validateConfigUI(); } };
    row.querySelectorAll('input').forEach((el) => { el.oninput = validateConfigUI; });
    renumberRows();
  }

  // aid/eid come from the server session (ProtocolContext), NEVER user input.
  function rawFields(row = testRows()[sequenceIndex] || testRows()[0]) {
    return { rounds: row.querySelector('.at-rounds').value, amount: row.querySelector('.at-amount').value, stopOdd: row.querySelector('.at-stopodd').value, aid: protoCtx.aid, eid: protoCtx.eid };
  }
  function validateConfigUI() {
    configValid = testRows().every((row) => { const v = ATC ? ATC.validate(rawFields(row)) : { ok: true, errors: {} }; row.querySelector('.at-row-error-rounds').textContent = v.errors.rounds || ''; row.querySelector('.at-row-error-amount').textContent = v.errors.amount || ''; row.querySelector('.at-row-error-stopodd').textContent = v.errors.stopOdd || ''; return v.ok; });
    renderCta();
    return configValid;
  }

  function localTodayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtDay(day) {
    if (!day) return 'All days';
    const m = String(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : day;
  }
  function stopOddFor(r) { return r ? (r.ackOdd ?? r.triggerOdd ?? null) : null; }
  // Net profit of a single WON round: prefer the server's win money (wm), else amount×odd.
  function winProfit(r) {
    const amt = Number(r.amount) || 0;
    if (r.wm != null && Number.isFinite(Number(r.wm))) return Number(r.wm) - amt;
    const odd = r.ackOdd ?? r.triggerOdd;
    return odd != null && Number.isFinite(Number(odd)) ? amt * (Number(odd) - 1) : 0;
  }
  function metricsForRounds(rows) {
    const completed = rows.filter((r) => r.result === 'COMPLETED');
    const lost = rows.filter((r) => r.result === 'ROUND_ENDED_BEFORE_THRESHOLD');
    // Everything else (nhấn dừng, timeout, reject, error, inconclusive) — outcome unknown, kept out of P/L.
    const pending = rows.filter((r) => r.result !== 'COMPLETED' && r.result !== 'ROUND_ENDED_BEFORE_THRESHOLD');
    const lastCompleted = completed.length ? completed[completed.length - 1] : null;
    const avg = (xs) => { const ys = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return ys.length ? Math.round((ys.reduce((a, b) => a + b, 0) / ys.length) * 100) / 100 : null; };
    const totalWin = completed.reduce((s, r) => s + winProfit(r), 0);
    const totalLose = lost.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return {
      finished: rows.length,
      completed: completed.length,
      wins: completed.length,
      losses: lost.length,
      pending: pending.length,
      totalWin,
      totalLose,
      netPnl: totalWin - totalLose,
      lastSuccessfulStopOdd: stopOddFor(lastCompleted),
      endedBeforeThreshold: lost.length,
      avgBetAckLatencyMs: avg(rows.map((r) => r.betLatencyMs)),
      avgTriggerToSendMs: avg(rows.map((r) => r.triggerToSendMs)),
      avgCashoutAckLatencyMs: avg(rows.map((r) => r.cashoutLatencyMs)),
    };
  }
  // Human-friendly, signed money — e.g. +7.750, −3.780, 0.
  function money(n) {
    const v = Math.round(Number(n) || 0);
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return sign + Math.abs(v).toLocaleString();
  }
  function visibleRounds() {
    const rows = (snap && snap.history) || [];
    return selectedDay ? rows.filter((r) => r.finishedDay === selectedDay) : rows;
  }
  function syncDayControls(rows) {
    const input = $('at-day-filter'); if (input) input.value = selectedDay || '';
    const summary = $('at-day-summary'); if (summary) summary.textContent = `${fmtDay(selectedDay)} · ${rows.length} rounds`;
  }

  // Run-level status → { text, cls } — makes it explicit WHY the run stopped:
  // the user pressed Dừng (STOPPED) vs. the runner stopped itself after the
  // configured number of rounds (COMPLETED). Neither reads like a raw enum code.
  const RUN_STATE_TEXT = {
    IDLE: 'Chưa chạy',
    WAITING_ROUND: 'Đang chờ ván…',
    BET_SENDING: 'Đang đặt cược…',
    WAITING_BET_ACK: 'Chờ xác nhận cược…',
    WATCHING_ODD: 'Đang theo dõi tỉ lệ…',
    CASHOUT_SENDING: 'Đang rút…',
    WAITING_CASHOUT_ACK: 'Chờ xác nhận rút…',
  };
  function statusInfo(state, roundCount, terminationReason) {
    // WU-D — Stop-1000x is a distinct terminal state, not a plain manual Stop.
    if (terminationReason === 'STOPPED_1000X_REACHED') return { text: '⛔ Dừng tại 1000x', cls: 'st-auto' };
    if (state === 'STOPPED') return { text: '⏹ Bạn đã nhấn Dừng', cls: 'st-user' };
    if (state === 'COMPLETED') return { text: `■ Tự dừng — đã chạy hết ${roundCount != null ? roundCount + ' ' : ''}lượt`, cls: 'st-auto' };
    if (state === 'ERROR') return { text: '✕ Lỗi — đã dừng', cls: 'st-err' };
    if (RUN_STATE_TEXT[state]) return { text: RUN_STATE_TEXT[state], cls: 'st-run' };
    return { text: state || 'Chưa chạy', cls: 'st-run' };
  }
  // Per-round result → friendly label + colour bucket.
  const RES_LABEL = {
    COMPLETED: '✓ Thắng (đã rút)',
    ROUND_ENDED_BEFORE_THRESHOLD: '✗ Thua — nổ trước mốc',
    STOPPED: '⏹ Đã nhấn dừng',
    BET_ACK_TIMEOUT: '⚠ Cược quá hạn xác nhận',
    BET_REJECTED: '⚠ Cược bị từ chối',
    CASHOUT_ACK_TIMEOUT: '⚠ Rút quá hạn xác nhận',
    CASHOUT_REJECTED: '⚠ Rút bị từ chối',
    ERROR: '✕ Lỗi',
    INCONCLUSIVE: '? Không rõ',
  };
  function resLabel(r) { return RES_LABEL[r] || r || '—'; }

  function setChip(status) {
    const chip = $('at-status-chip'); if (!chip) return;
    const on = ['WAITING_ROUND', 'BET_SENDING', 'WAITING_BET_ACK', 'WATCHING_ODD', 'CASHOUT_SENDING', 'WAITING_CASHOUT_ACK'].includes(status);
    chip.textContent = status === 'COMPLETED' ? 'DONE' : (on ? 'RUN' : (status || 'IDLE'));
    chip.className = 'chip ' + (on ? 'on' : (status === 'COMPLETED' ? 'warn' : 'off'));
  }

  async function refreshEnv() {
    try { env = await api.autotestEnvironment(currentRunId); } catch { env = { allowed: false, host: '' }; }
    const badge = $('at-env');
    badge.textContent = `Sẵn sàng · ${env.host || ''}`;
    badge.className = 'proto-env on';
    const gate = $('at-gate');
    gate.hidden = true;
    renderCta();
  }
  // The single Auto CTA: label/action by state (WU11.1), gated by context/env/config.
  function renderCta() {
    const running = !!(snap && snap.running);
    const c = (window.AppShell ? window.AppShell.autoCta(snap ? snap.state : 'IDLE', running) : { action: 'start', label: '▶ BẮT ĐẦU TỰ ĐỘNG', note: '', cls: 'primary' });
    const cta = $('at-cta');
    cta.textContent = c.label;
    cta.className = 'cta ' + c.cls;
    $('at-cta-note').textContent = c.note;
    // Feature lock (§16/§22): Auto requires the signed autoRun entitlement.
    const autoLicensed = document.body.dataset.autorun !== 'off';
    const gate = $('at-gate');
    if (gate) {
      if (!autoLicensed) { gate.hidden = false; gate.className = 'proto-validation block'; gate.textContent = '🔒 Tính năng Chạy tự động chưa được cấp phép trong gói của bạn. Liên hệ nhà cung cấp để nâng cấp.'; }
      else gate.hidden = true;
    }
    // Disable reason (§5) — license/context/config.
    let reason = '';
    if (!running) {
      if (!autoLicensed) reason = '🔒 Gói của bạn chưa có tính năng Chạy tự động.';
      else if (!protoCtxReady()) reason = 'Chờ đăng nhập & vào game…';
      else if (!configValid) reason = 'Hãy sửa các ô đang báo lỗi.';
    }
    cta.disabled = !running && reason !== '';
    $('at-cta-reason').textContent = reason;
    testRows().forEach((row) => row.querySelectorAll('input,button').forEach((el) => { el.disabled = running || sequenceRunning; }));
    testRows().forEach((row, i) => row.classList.toggle('active', sequenceRunning && i === sequenceIndex));
    // Sidebar running indicator (§8).
    const nav = document.querySelector('#shell-nav [data-view=auto]'); if (nav) nav.classList.toggle('running', running);
  }

  function render() {
    if (!snap) return;
    setChip(snap.state);
    const si = statusInfo(snap.state, snap.config ? snap.config.roundCount : null, snap.terminationReason);
    const statusEl = $('at-status');
    statusEl.textContent = si.text;
    statusEl.className = 'at-status ' + si.cls;
    const p = snap.progress || {};
    $('at-progress').textContent = `${p.finished ?? 0} / ${p.target ?? '—'}`;
    $('at-sid').textContent = snap.liveSid != null ? snap.liveSid : '—';
    const odd = snap.liveOdd;
    const oddEl = $('at-odd'); oddEl.textContent = odd != null ? Number(odd).toFixed(2) + 'x' : '—';
    const target = snap.config ? snap.config.stopOdd : (snap.active ? snap.active.stopOdd : null);
    oddEl.className = 'at-odd' + (odd != null && target != null && odd >= target ? ' trig' : '');
    $('at-target').textContent = target != null ? Number(target).toFixed(2) + 'x' : '—';
    // Show the running config's amount (snapshotted at Start, not live inputs §14).
    $('at-live-amount').textContent = snap.config && snap.config.amount != null ? Number(snap.config.amount).toLocaleString() : '—';
    const active = snap.active;
    $('at-bet').textContent = active ? (active.betResult || (['BET_SENDING', 'WAITING_BET_ACK'].includes(snap.state) ? 'đang gửi…' : '—')) : '—';
    $('at-cash').textContent = ['CASHOUT_SENDING', 'WAITING_CASHOUT_ACK'].includes(snap.state) ? 'đang gửi…' : (active && active.ackOdd != null ? 'ACK ' + active.ackOdd : '—');
    const rows = visibleRounds();
    syncDayControls(rows);
    const m = metricsForRounds(rows);
    $('at-m-winloss').textContent = `${m.wins} / ${m.losses}`;
    const winEl = $('at-m-winsum'); winEl.textContent = money(m.totalWin); winEl.className = pnlCls(m.totalWin);
    const loseEl = $('at-m-losesum'); loseEl.textContent = m.totalLose > 0 ? money(-m.totalLose) : '0'; loseEl.className = pnlCls(-m.totalLose);
    const netEl = $('at-m-net'); netEl.textContent = money(m.netPnl); netEl.className = pnlCls(m.netPnl);
    $('at-m-count').textContent = `${m.completed ?? 0} / ${m.finished ?? 0}`;
    $('at-m-last-stop').textContent = m.lastSuccessfulStopOdd != null ? Number(m.lastSuccessfulStopOdd).toFixed(2) + 'x' : '—';
    $('at-m-pending').textContent = m.pending ?? 0;
    $('at-m-bet').textContent = m.avgBetAckLatencyMs != null ? m.avgBetAckLatencyMs + 'ms' : '—';
    $('at-m-tts').textContent = m.avgTriggerToSendMs != null ? m.avgTriggerToSendMs + 'ms' : '—';
    $('at-m-cash').textContent = m.avgCashoutAckLatencyMs != null ? m.avgCashoutAckLatencyMs + 'ms' : '—';
    renderHistory(rows);
    renderCta();
  }

  function pnlCls(n) { return n > 0 ? 'pnl-pos' : (n < 0 ? 'pnl-neg' : ''); }
  // One coloured cell per round: odd (top) + tiền lãi/lỗ (bottom). Màu theo kết quả.
  function resCell(r) {
    const f2 = (n) => (n == null ? '—' : Number(n).toFixed(2));
    let cls, oddTxt, pnlTxt;
    if (r.result === 'COMPLETED') { cls = 'win'; oddTxt = stopOddFor(r) != null ? f2(stopOddFor(r)) + 'x' : '—'; pnlTxt = money(winProfit(r)); }
    else if (r.result === 'ROUND_ENDED_BEFORE_THRESHOLD') { cls = 'loss'; oddTxt = r.triggerOdd != null ? f2(r.triggerOdd) + 'x' : '—'; pnlTxt = money(-(Number(r.amount) || 0)); }
    else if (r.result === 'STOPPED') { cls = 'stopped'; oddTxt = 'dừng'; pnlTxt = '—'; }
    else { cls = 'pending'; oddTxt = '?'; pnlTxt = '—'; }
    const title = `#${(r.index ?? 0) + 1} · sid ${r.sid ?? ''} · ${resLabel(r.result)} · bet ${r.amount ?? '—'}`;
    return `<span class="at-res-cell ${cls}" title="${esc(title)}"><span class="odd">${esc(oddTxt)}</span><span class="pnl">${esc(pnlTxt)}</span></span>`;
  }
  function renderHistory(rounds) {
    const el = $('at-history'); if (!el) return;
    if (!rounds.length) { el.innerHTML = `<div class="muted">Chưa có ván nào cho ${esc(fmtDay(selectedDay))}.</div>`; return; }
    // Ván gần nhất (tối đa 300), gom theo ngày; trong mỗi ngày xếp theo thứ tự chơi (cũ → mới).
    const byDay = new Map();
    for (const r of rounds.slice(-300)) {
      const day = r.finishedDay || 'unknown';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }
    const days = [...byDay.entries()].sort((a, b) => String(b[0]).localeCompare(String(a[0])));
    el.innerHTML = days.map(([day, rows]) => {
      const dm = metricsForRounds(rows);
      const head = `<div class="at-day-group">${esc(fmtDay(day))} · thắng ${esc(dm.wins)} / thua ${esc(dm.losses)} · ròng <span class="${pnlCls(dm.netPnl)}">${esc(money(dm.netPnl))}</span></div>`;
      return head + `<div class="at-res-strip">${rows.map(resCell).join('')}</div>`;
    }).join('');
  }

  // Live odd strip from the OBSERVER (the single source of truth, §24) — no second store.
  api.onObserverUpdate && api.onObserverUpdate((s) => {
    if ($('at-panel').hidden) return;
    const cur = s && s.current;
    const strip = $('at-oddstrip');
    const buf = (cur && cur.recentOdds) || [];
    strip.innerHTML = buf.length ? buf.slice(-30).map((o, i, a) => `<span class="sid odd ${i === a.length - 1 ? 'trig' : ''}">${esc(Number(o.odd).toFixed(2))}</span>`).join('') : '<span class="muted">none</span>';
    if (snap && snap.running && cur) { snap.liveOdd = cur.currentOdd; snap.liveSid = cur.sid; render(); }
  });
  api.onAutotestUpdate && api.onAutotestUpdate(async (s) => {
    snap = s; if (!$('at-panel').hidden) render();
    if (sequenceRunning && s && s.state === 'COMPLETED') {
      sequenceRunning = false;
      render();
    }
  });

  // Live validation as the tester types (§6). aid/eid are not inputs anymore.
  addTestRow();
  $('at-add-row').onclick = () => { if (!sequenceRunning) { addTestRow(); validateConfigUI(); } };
  // WU-C.3 — Jackpot gate config (default OFF -> unchanged Auto behavior).
  const jpWaitBox = $('at-jp-wait');
  if (jpWaitBox) jpWaitBox.onchange = () => { const cfg = $('at-jp-config'); if (cfg) cfg.hidden = !jpWaitBox.checked; };
  function parseJp(v) { const s = String(v == null ? '' : v).replace(/[,\s_]/g, ''); if (s === '') return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? n : null; }
  $('at-day-filter').onchange = () => { selectedDay = $('at-day-filter').value || ''; render(); };
  $('at-day-today').onclick = () => { selectedDay = (snap && snap.currentDay) || localTodayKey(); render(); };
  $('at-day-all').onclick = () => { selectedDay = ''; render(); };
  document.addEventListener('protoctx-change', () => { if (!$('at-panel').hidden) renderCta(); });

  async function startRun() {
    if (!validateConfigUI() || !protoCtxReady()) return;
    sequenceIndex = 0; sequenceRunning = true;
    await startCurrentRow();
  }
  async function startCurrentRow() {
    const v = ATC ? ATC.validate(rawFields()) : { ok: true, config: rawFields() };
    if (!v.ok) { sequenceRunning = false; validateConfigUI(); return; }
    // WU-C.3 — snapshot the Jackpot gate config at START (locked for this session).
    const jpWait = !!($('at-jp-wait') && $('at-jp-wait').checked);
    let jpMin = null;
    if (jpWait) {
      jpMin = parseJp($('at-jp-min').value);
      if (jpMin == null) { sequenceRunning = false; $('at-jp-err').textContent = 'Nhập mức jackpot tối thiểu hợp lệ (số ≥ 0).'; renderCta(); return; }
      $('at-jp-err').textContent = '';
    }
    // WU-D — Stop-1000x session kill switch (default OFF). Distinct from stopOdd.
    const stop1000 = !!($('at-stop1000') && $('at-stop1000').checked);
    const cfg = { ...v.config, waitForJackpot: jpWait, jackpotThreshold: jpMin, stopAutoAt1000x: stop1000 };
    // WU-D — persist this browser's operating config so it restores on next open. This
    // is a saved REQUEST only; main still enforces license features at execution time.
    if (currentBrowserId && api.browserConfigSet) {
      try { api.browserConfigSet(currentBrowserId, { amount: Number(v.config.amount), roundCount: Number(v.config.roundCount), stopOdd: Number(v.config.stopOdd), waitForJackpot: jpWait, jackpotThreshold: jpMin, stopAutoAt1000x: stop1000 }); } catch { /* best-effort */ }
    }
    // WU-C.1.1 — START AUTO first ensures Aviator entry, then (if enabled) the Jackpot
    // gate. AUTO RUNNING only appears once the AutoRunner has actually started.
    const cta = $('at-cta'); const note = $('at-cta-note');
    if (cta) cta.disabled = true; if (note) note.textContent = jpWait ? 'Đang chuẩn bị (vào game · chờ jackpot)…' : 'Đang vào game (Aviator)…';
    const r = await api.autotestStart(currentRunId, cfg);
    if (cta) cta.disabled = false;
    if (r && r.error) {
      sequenceRunning = false;
      const code = String(r.error.code || '');
      // Cancellations (user STOP / disconnect) are benign, not scary errors.
      const benign = code === 'JACKPOT_GATE_CANCELLED' || code === 'AVIATOR_ENTRY_DISCONNECTED';
      const entry = code.indexOf('AVIATOR_ENTRY') === 0;
      const jp = code.indexOf('JACKPOT') === 0 || code === 'INVALID_JACKPOT_THRESHOLD';
      $('at-cfg-err').textContent = benign ? '' : ((entry ? 'Vào game thất bại — ' : jp ? 'Jackpot gate — ' : '') + `${code}: ${r.error.message || ''}`);
      renderCta();
      return;
    }
    snap = r; render();
  }
  async function stopRun() { sequenceRunning = false; const r = await api.autotestStop(currentRunId); if (r && !r.error) { snap = r; render(); } }
  $('at-cta').onclick = () => { (snap && snap.running) ? stopRun() : startRun(); };

  // WU-D — apply a browser's persisted operating config to the Auto form fields.
  async function loadBrowserConfig() {
    if (!currentBrowserId || !api.browserConfigGet) return;
    let cfg; try { cfg = await api.browserConfigGet(currentBrowserId); } catch { cfg = null; }
    if (!cfg || cfg.error) return;
    const row = testRows()[0];
    if (row) {
      if (cfg.roundCount != null) row.querySelector('.at-rounds').value = cfg.roundCount;
      if (cfg.amount != null) row.querySelector('.at-amount').value = cfg.amount;
      if (cfg.stopOdd != null) row.querySelector('.at-stopodd').value = cfg.stopOdd;
    }
    const jpWaitBox = $('at-jp-wait');
    if (jpWaitBox) { jpWaitBox.checked = !!cfg.waitForJackpot; const c = $('at-jp-config'); if (c) c.hidden = !jpWaitBox.checked; }
    if (cfg.jackpotThreshold != null && $('at-jp-min')) $('at-jp-min').value = cfg.jackpotThreshold;
    if ($('at-stop1000')) $('at-stop1000').checked = !!cfg.stopAutoAt1000x;
  }
  async function openAuto() { await refreshEnv(); await loadBrowserConfig(); try { snap = await api.autotestSnapshot(currentRunId); } catch { snap = null; } validateConfigUI(); render(); }
  $('at-toggle').onclick = async () => { const p = $('at-panel'); p.hidden = !p.hidden; if (!p.hidden) await openAuto(); };
  $('at-close').onclick = () => { $('at-panel').hidden = true; };
  $('at-panel').addEventListener('shell:activate', openAuto); // WU11 nav hook

  // Refresh target host when the selected target changes.
  const prev = $('targets').onchange;
  $('targets').onchange = (e) => { if (prev) prev.call($('targets'), e); setTimeout(() => { if (!$('at-panel').hidden) refreshEnv(); }, 80); };
})();

// ==================== WU10.2 BET AMOUNT SERVER VALIDATION (bet-only) ====================
// Sends an EXACT tester-supplied `b` on each server round and reports what the server
// does: ACCEPTED_EXACT / ACCEPTED_NORMALIZED / REJECTED / INCONCLUSIVE. No cashout,
// no odd. UI does TYPE validation only — any numeric b is allowed on purpose.
(function betValidationUI() {
  if (!api.bvalidateStart || !window.AmountValidation) return;
  const AV = window.AmountValidation;
  let snap = null, env = { allowed: false, host: '' }, valid = true;

  function setChip(status) {
    const chip = $('bv-status-chip'); if (!chip) return;
    const on = ['WAITING_ROUND', 'BET_SENDING', 'WAITING_BET_ACK'].includes(status);
    chip.textContent = status === 'COMPLETED' ? 'DONE' : (on ? 'RUN' : (status || 'IDLE'));
    chip.className = 'chip ' + (on ? 'on' : (status === 'COMPLETED' ? 'warn' : 'off'));
  }
  async function refreshEnv() {
    try { env = await api.bvalidateEnvironment(currentRunId); } catch { env = { allowed: false, host: '' }; }
    const badge = $('bv-env');
    badge.textContent = `READY · ${env.host || ''}`;
    badge.className = 'proto-env on';
    const gate = $('bv-gate');
    gate.hidden = true;
    validate();
  }

  const mode = () => $('bv-mode').value;
  function validate() {
    let ok = true;
    $('bv-err-amount').textContent = ''; $('bv-err-rounds').textContent = ''; $('bv-err-values').textContent = '';
    if (mode() === 'single') {
      const a = AV.parseAmount($('bv-amount').value); if (a.error) { $('bv-err-amount').textContent = a.error; ok = false; }
      const r = Number($('bv-rounds').value); if (!Number.isInteger(r) || r < 1) { $('bv-err-rounds').textContent = 'Whole number >= 1'; ok = false; }
    } else {
      const p = AV.parseValues($('bv-values').value);
      if (!p.values.length) { $('bv-err-values').textContent = 'Enter at least one value'; ok = false; }
      else if (p.errors.length) { $('bv-err-values').textContent = 'Invalid: ' + p.errors.map((e) => e.input).join(', '); ok = false; }
    }
    valid = ok; syncButtons(); return ok;
  }
  function syncButtons() {
    const running = snap && snap.running;
    // Disabled until the session context is ready + config valid.
    let reason = '';
    if (!running) {
      if (!protoCtxReady()) reason = 'Waiting for login context…';
      else if (!valid) reason = 'Fix the highlighted fields.';
    }
    $('bv-start').disabled = running || reason !== '';
    $('bv-cfg-err').textContent = running ? '' : reason;
    $('bv-stop').disabled = !running;
    for (const id of ['bv-mode', 'bv-amount', 'bv-rounds', 'bv-values', 'bv-expected', 'bv-uimin', 'bv-uimax']) { const el = $(id); if (el) el.disabled = running; }
  }
  function buildConfig() {
    // aid/eid come from the server session (ProtocolContext), never user input.
    const common = { expected: $('bv-expected').value, aid: protoCtx.aid, eid: protoCtx.eid, uiMin: Number($('bv-uimin').value), uiMax: Number($('bv-uimax').value) };
    if (mode() === 'single') return { mode: 'single', amount: AV.parseAmount($('bv-amount').value).value, roundCount: Number($('bv-rounds').value), ...common };
    return { mode: 'list', values: AV.parseValues($('bv-values').value).values, ...common };
  }

  function obsClass(o) { return o === 'ACCEPTED_EXACT' ? 'COMPLETED' : o === 'ACCEPTED_NORMALIZED' ? 'ROUND_ENDED_BEFORE_TRIGGER' : o === 'REJECTED' ? 'ENDED' : 'OBSERVING'; }
  function render() {
    if (!snap) return;
    setChip(snap.state);
    $('bv-status').textContent = snap.state;
    const p = snap.progress || {};
    $('bv-progress').textContent = `${p.done ?? 0} / ${p.total ?? '—'}`;
    const a = snap.active;
    $('bv-sid').innerHTML = (a && a.sid != null ? esc(a.sid) : '—') + ' <span class="faint">auto · server supplied</span>';
    $('bv-sending').textContent = a ? a.requestedB : '—';
    $('bv-cat').textContent = a ? a.category : '—';
    $('bv-observed').textContent = a && a.observed ? a.observed : (['BET_SENDING', 'WAITING_BET_ACK'].includes(snap.state) ? 'Waiting…' : '—');
    $('bv-ackb').textContent = a && a.ackB != null ? a.ackB : '—';
    const s = snap.summary || {};
    $('bv-s-tested').textContent = s.tested ?? 0;
    $('bv-s-acc').textContent = `${s.acceptedExact ?? 0} / ${s.acceptedNormalized ?? 0}`;
    $('bv-s-rej').textContent = `${s.rejected ?? 0} / ${s.inconclusive ?? 0}`;
    $('bv-s-below').textContent = (s.acceptedBelowMin && s.acceptedBelowMin.length) ? s.acceptedBelowMin.join(', ') : 'none';
    $('bv-s-above').textContent = (s.acceptedAboveMax && s.acceptedAboveMax.length) ? s.acceptedAboveMax.join(', ') : 'none';
    $('bv-s-nonpreset').textContent = (s.acceptedNonPreset && s.acceptedNonPreset.length) ? s.acceptedNonPreset.join(', ') : 'none';
    renderHistory(snap.history || []);
    syncButtons();
  }
  function renderHistory(rows) {
    const el = $('bv-history'); if (!el) return;
    if (!rows.length) { el.innerHTML = '<div class="muted">No cases checked yet.</div>'; return; }
    el.innerHTML = rows.slice().reverse().slice(0, 60).map((c) => {
      const diff = c.diff != null && c.diff !== 0 ? ` (delta ${c.diff})` : '';
      const verdict = c.verdict ? `<span class="ptx-verdict ${esc(c.verdict)}">${esc(c.verdict)}</span>` : '';
      return `<div class="obs-round">`
        + `<div class="obs-round-head"><b>#${esc(c.index + 1)} · sid ${esc(c.sid)}</b><span class="obs-res ${obsClass(c.observed)}">${esc(c.observed || '—')}</span>${verdict}</div>`
        + `<div class="obs-round-meta">sent b ${esc(c.sentB)} · ack b ${esc(c.ackB != null ? c.ackB : '—')}${esc(diff)} · ${esc(c.category)}</div>`
        + `</div>`;
    }).join('');
  }

  api.onBvalidateUpdate && api.onBvalidateUpdate((s) => { snap = s; if (!$('bv-panel').hidden) render(); });

  $('bv-mode').onchange = () => { const list = mode() === 'list'; $('bv-list-fields').hidden = !list; $('bv-single-fields').hidden = list; validate(); };
  for (const id of ['bv-amount', 'bv-rounds', 'bv-values']) { const el = $(id); if (el) el.oninput = validate; }
  $('bv-adv-toggle').onclick = () => { const el = $('bv-adv'); el.hidden = !el.hidden; $('bv-adv-toggle').textContent = (el.hidden ? '▶' : '▼') + ' Advanced (UI limits)'; };
  $('bv-gen').onclick = () => { $('bv-values').value = AV.generateAroundLimits(Number($('bv-uimin').value), Number($('bv-uimax').value)).join('\n'); validate(); };
  document.addEventListener('protoctx-change', () => { if (!$('bv-panel').hidden) syncButtons(); });
  $('bv-start').onclick = async () => {
    if (!validate() || !protoCtxReady()) return;
    $('bv-cfg-err').textContent = '';
    const r = await api.bvalidateStart(currentRunId, buildConfig()); // config carries session aid/eid
    if (r && r.error) { $('bv-cfg-err').textContent = `${r.error.code}: ${r.error.message || ''}`; return; }
    snap = r; render();
  };
  $('bv-stop').onclick = async () => { const r = await api.bvalidateStop(currentRunId); if (r && !r.error) { snap = r; render(); } };
  async function openBtest() { await refreshEnv(); try { snap = await api.bvalidateSnapshot(currentRunId); } catch { snap = null; } validate(); render(); }
  $('bv-toggle').onclick = async () => { const p = $('bv-panel'); p.hidden = !p.hidden; if (!p.hidden) await openBtest(); };
  $('bv-close').onclick = () => { $('bv-panel').hidden = true; };
  $('bv-panel').addEventListener('shell:activate', openBtest); // WU11 nav hook
  const prevCh = $('targets').onchange;
  $('targets').onchange = (e) => { if (prevCh) prevCh.call($('targets'), e); setTimeout(() => { if (!$('bv-panel').hidden) refreshEnv(); }, 80); };
})();

// ==================== FOCUSED AVIATOR CONTROL SHELL (presentation only) ====================
// A simplified default workspace: URL -> Open Browser, left nav (Overview / Manual /
// Auto / Amount Check), and diagnostics hidden behind a toggle. It only
// switches views and renders the Overview from the RoundObserver snapshot — no new
// protocol state, no engine/IPC change. The WU7-10.2 panels are reused as-is.
(function protocolShellUI() {
  const Shell = window.AppShell; if (!Shell) return;
  const state = { connected: false, targetName: '', obs: null, view: 'overview', instanceInfo: null };
  const PANELS = ['proto-panel', 'at-panel', 'bv-panel', 'obs-panel', 'act-panel'];

  // ---- mode (product | advanced), persisted; default product (§19) ----
  function applyMode(mode) {
    document.body.dataset.mode = mode;
    const box = $('shell-advanced'); if (box) box.checked = Shell.isAdvanced(mode);
    Shell.saveMode((k, v) => localStorage.setItem(k, v), mode);
    if (!Shell.isAdvanced(mode)) setView(state.view); // ensure a shell view is shown
  }
  const initialMode = Shell.loadMode((k) => localStorage.getItem(k));

  // ---- nav / views ----
  // WU-D.1 — sections live in #shell-main (overview/history/advanced); only 'auto' is a
  // reused slide-in panel. Selecting a nav tab hides every tool panel + section, then
  // shows the target. Switching a tab is a VIEW action only — never engine execution.
  const SECTION_FOR_VIEW = { overview: 'view-overview', history: 'view-history', advanced: 'view-advanced' };
  const SECTIONS = ['view-overview', 'view-history', 'view-advanced'];
  function setView(view) {
    state.view = view;
    document.body.dataset.view = view;
    for (const b of document.querySelectorAll('#shell-nav .nav-item')) b.classList.toggle('active', b.dataset.view === view);
    for (const id of PANELS) { const el = $(id); if (el) el.hidden = true; }
    for (const id of SECTIONS) { const el = $(id); if (el) el.hidden = true; }
    const panelId = Shell.PANEL_FOR_VIEW[view];
    if (panelId) { const el = $(panelId); if (el) { el.hidden = false; el.dispatchEvent(new CustomEvent('shell:activate')); } return; }
    const sectionId = SECTION_FOR_VIEW[view];
    const el = $(sectionId); if (el) el.hidden = false;
    if (view === 'overview') renderOverview();
    if (view === 'history') document.dispatchEvent(new CustomEvent('history-activate'));
    document.dispatchEvent(new CustomEvent('view-changed', { detail: { view } })); // WU-E.1 — embedded web mirror follows the visible view
  }
  for (const b of document.querySelectorAll('#shell-nav .nav-item')) b.onclick = () => setView(b.dataset.view);

  // ---- Nâng cao (Advanced) tiles → open the secondary tool panels / diagnostics ----
  document.querySelectorAll('#view-advanced [data-adv]').forEach((tile) => {
    tile.onclick = () => {
      const k = tile.dataset.adv;
      if (k === 'diagnostics') { const box = $('shell-advanced'); if (box) { box.checked = true; applyMode('advanced'); } return; }
      const toggle = { manual: 'proto-toggle', btest: 'bv-toggle', observer: 'obs-toggle' }[k];
      const btn = $(toggle);
      const panel = { manual: 'proto-panel', btest: 'bv-panel', observer: 'obs-panel' }[k];
      const el = $(panel);
      if (btn && el && el.hidden) btn.click(); // open (idempotent: only when currently hidden)
    };
  });

  // ---- Diagnostics toggle ----
  const advBox = $('shell-advanced');
  if (advBox) advBox.onchange = () => applyMode(advBox.checked ? 'advanced' : 'product');

  // ---- Open Browser (reuse the existing launch path in the legacy topbar) ----
  const openBtn = $('shell-open');
  if (openBtn) openBtn.onclick = () => {
    const u = $('shell-url').value.trim();
    if (!u) return toast('Enter a URL');
    $('url').value = u; setStatus('mid', 'Opening browser…');
    $('launch').click();
  };
  const urlInput = $('shell-url');
  if (urlInput) urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openBtn.click(); });

  // ---- connection status ----
  function setStatus(cls, text) {
    const s = $('shell-status'); if (s) s.className = 'ab-pill diag ' + (cls || ''); // stays hidden in product mode
    const t = $('shell-status-text'); if (t) t.textContent = text;
  }
  async function refreshInstanceInfo() {
    if (!api.instanceInfo) return;
    try { state.instanceInfo = await api.instanceInfo(); } catch { state.instanceInfo = null; }
    renderInstanceInfo();
    if (state.view === 'overview' && !$('view-overview').hidden) renderOverview();
  }
  function shortId(id) { return id ? String(id).slice(0, 8) : '—'; }
  function renderInstanceInfo() {
    const info = state.instanceInfo || {};
    const runtime = info.runtime || {};
    const inst = $('shell-instance'); if (inst) inst.textContent = 'Instance ' + shortId(info.instanceId);
    const cdp = $('shell-cdp'); if (cdp) cdp.textContent = runtime.cdpPort ? 'CDP ' + runtime.cdpPort : 'CDP —';
  }
  document.addEventListener('instance-runtime-refresh', () => setTimeout(refreshInstanceInfo, 250));
  api.onTargetsChanged && api.onTargetsChanged((list) => {
    state.connected = !!(list && list.length);
    if (state.connected) { const t = list[0]; state.targetName = t.title || t.url || t.cdpTargetId; setStatus('on', 'Connected'); }
    else { state.targetName = ''; setStatus('', 'Disconnected'); }
    if (state.view === 'overview') renderOverview();
  });

  // ---- Overview: protocol status + prominent ODD (from the observer snapshot) ----
  api.onObserverUpdate && api.onObserverUpdate((s) => { state.obs = s; if (state.view === 'overview' && !$('view-overview').hidden) renderOverview(); });
  document.addEventListener('protoctx-change', () => { if (state.view === 'overview' && !$('view-overview').hidden) renderOverview(); });

  // WU-C — selecting a different BrowserRun re-seeds the DETAIL view for that run.
  // It changes the VIEW only: no execution is started/stopped/retargeted here (that
  // is entirely run-scoped in the engine and driven by the explicit runId in WU-B).
  document.addEventListener('run-selected', async () => {
    try { const c = await api.protocolContext(currentRunId); protoCtx = c || { aid: null, eid: null, ready: false }; broadcastProtoCtx(); } catch { /* ignore */ }
    try { state.obs = await api.observerSnapshot(currentRunId); } catch { state.obs = null; }
    refreshInstanceInfo();
    setView(state.view); // re-activates the visible panel, which re-fetches for currentRunId
  });
  const f2 = (n) => (n == null || !Number.isFinite(Number(n))) ? '—' : Number(n).toFixed(2);

  function renderOverview() {
    const s = state.obs, cur = s && s.current;
    const empty = $('ov-empty'), body = $('ov-body'), etext = $('ov-empty-text');
    // WU-E.1 — the web area IS the login/game surface, so show it whenever the selected
    // browser is ONLINE (do NOT wait for protocol frames — the user logs in THROUGH it).
    const online = !!((typeof currentRunId !== 'undefined' && currentRunId) || state.connected);
    if (!online) { empty.hidden = false; body.hidden = true; etext.textContent = 'Chưa kết nối — mở một trình duyệt để bắt đầu.'; return; }
    empty.hidden = true; body.hidden = false;
    // Session context (aid/eid) banner — owned by ProtocolContext (§ context ownership).
    const ctxEl = $('ov-ctx');
    if (protoCtxReady()) { ctxEl.className = 'ctx-banner ready'; $('ov-ctx-text').innerHTML = `Sẵn sàng — AID <span class="mono">${esc(protoCtx.aid)}</span> · EID <span class="mono">${esc(protoCtx.eid)}</span>`; }
    else { ctxEl.className = 'ctx-banner wait'; $('ov-ctx-text').textContent = 'Chờ đăng nhập & vào game…'; }
    $('ov-aid').textContent = protoCtxReady() ? protoCtx.aid : '—';
    $('ov-eid').textContent = protoCtxReady() ? protoCtx.eid : '—';
    const info = state.instanceInfo || {}, runtime = info.runtime || {};
    $('ov-instance').textContent = info.instanceId ? shortId(info.instanceId) : '—';
    $('ov-profile').textContent = info.chromeProfile || '—';
    $('ov-cdp').textContent = runtime.cdpPort || '—';
    $('ov-browser').textContent = 'Đã kết nối';
    $('ov-license').textContent = licenseState.active ? 'Đang hoạt động' : 'Đã khóa';
    $('ov-license-exp').textContent = licenseState.payload ? dateFromSecondsTrusted(licenseState.payload.expiresAt) : '—';
    $('ov-license-rem').textContent = licenseState.payload ? remainingDaysTrusted(licenseState.payload.expiresAt) : '—';
    $('ov-license-launches').textContent = licenseState.launch ? (licenseState.launch.max ? `${licenseState.launch.used} / ${licenseState.launch.max}` : `${licenseState.launch.used} / Unlimited`) : '—';
    $('ov-target').textContent = state.targetName || '—';
    $('ov-ws').textContent = 'Đã phát hiện Aviator';
    $('ov-proto').textContent = protoCtxReady() ? (cur ? 'Sẵn sàng · đang có vòng' : 'Sẵn sàng · chờ vòng') : 'Chờ đăng nhập';
    $('ov-odd').textContent = cur && cur.currentOdd != null ? f2(cur.currentOdd) + 'x' : '—';
    $('ov-sid').textContent = cur && cur.sid != null ? cur.sid : '—';
    $('ov-phase').textContent = cur ? cur.phase : (s ? s.status : '—');
    $('ov-maxodd').textContent = cur && cur.maxOdd != null ? f2(cur.maxOdd) + 'x' : '—';
    $('ov-frames').textContent = cur && cur.oddFrameCount != null ? cur.oddFrameCount : '—';
    $('ov-age').textContent = cur && cur.roundAgeMs != null ? (cur.roundAgeMs / 1000).toFixed(1) + 's' : '—';
    $('ov-last').textContent = cur && cur.timeSinceLastOddMs != null ? Math.round(cur.timeSinceLastOddMs) + 'ms ago' : '—';
    const recent = $('ov-recent'); const buf = (cur && cur.recentOdds) || [];
    recent.innerHTML = buf.length ? buf.slice(-16).map((o, i, a) => `<span class="sid odd ${i === a.length - 1 ? 'trig' : ''}">${esc(f2(o.odd))}</span>`).join('') : '<span class="muted">none</span>';
  }

  // ---- boot ----
  applyMode(initialMode);
  // Product mode opens on Tổng quan (home): selected-browser identity + live state.
  // Tự động is one tab away; the identity band stays visible across all tabs.
  setView('overview');
  // Seed overview/status from current engine state if already connected.
  (async () => {
    await refreshInstanceInfo();
    try { const t = await api.listTargets(); if (t && t.length) { state.connected = true; state.targetName = t[0].title || t[0].url || t[0].cdpTargetId; setStatus('on', 'Connected'); } } catch { /* ignore */ }
    try { state.obs = await api.observerSnapshot(currentRunId); } catch { /* ignore */ }
    if (state.view === 'overview') renderOverview();
  })();
})();

// ==================== WU-C.1 PERSISTENT BROWSERS RAIL ====================
// The rail's primary entities are PERSISTENT browsers (B-xxxx), joined with their
// live runtime run (BR-xxxx) when online. Summaries come from the coalesced
// `browsers-changed` push (built from registry + each run's own state) — never from
// forwarding raw protocol frames. Selecting a browser is a VIEW change: it binds
// currentRunId to that browser's live run (or null when OFFLINE, so execution is
// safely rejected). It never starts/stops/retargets any AutoRunner.
(function browserListUI() {
  if (!api.listBrowsers) return; // preload without WU-C.1 surface — inert
  const listEl = $('run-list');
  if (!listEl) return;
  let browsers = [];
  let capacity = { registered: 0, max: null, canCreate: true, overCapacity: false, unlimited: true };
  let selectedBrowserId = null;
  const f2 = (n) => (n == null || !Number.isFinite(Number(n))) ? null : Number(n).toFixed(2);

  // Normalized, source-real badge → Vietnamese user state (§21). Đã đóng and Tự động
  // are the most visible.
  function badge(b) {
    if (!b.online) return { cls: 'disconnected', text: 'Đã đóng' };
    if (b.runtimeStatus === 'ERROR') return { cls: 'error', text: 'Lỗi' };
    if (b.runtimeStatus === 'DISCONNECTED') return { cls: 'disconnected', text: 'Mất kết nối' };
    // WU-D — a session terminated by the Stop-1000x kill switch is distinct from a plain stop.
    if (!b.autoRunning && b.stop1000State === 'STOPPED_1000X') return { cls: 'auto', text: 'Dừng 1000x' };
    if (b.autoRunning) return { cls: 'auto', text: 'Tự động' };
    if (b.entryState === 'ENTERING') return { cls: 'wait', text: 'Đang vào' };
    if (b.testRunning) return { cls: 'test', text: 'Kiểm thử' };
    if (b.protocolReady) return { cls: 'ready', text: 'Sẵn sàng' };
    if (b.runtimeStatus === 'CONNECTED' || b.runtimeStatus === 'WAITING_PROTOCOL') return { cls: 'wait', text: 'Chờ game' };
    return { cls: 'starting', text: 'Đang mở' };
  }

  function renderCap() {
    const capEl = $('rr-cap');
    if (capEl) {
      if (capacity.unlimited || capacity.max == null) { capEl.textContent = String(capacity.registered); capEl.classList.remove('full'); }
      else { capEl.textContent = `${capacity.registered}/${capacity.max}`; capEl.classList.toggle('full', !capacity.canCreate); }
    }
    const newBtn = $('rr-new');
    if (newBtn) { newBtn.disabled = !capacity.canCreate; newBtn.title = capacity.canCreate ? 'Tạo trình duyệt mới' : `Đã đạt giới hạn hồ sơ (${capacity.registered}/${capacity.max})`; }
    const running = $('shell-running');
    if (running) { const n = browsers.filter((b) => b.online).length; running.textContent = `${n} đang chạy`; }
  }

  function render() {
    renderCap();
    if (!browsers.length) { listEl.innerHTML = '<div class="rr-empty">Chưa có trình duyệt.<span class="rr-empty-sub">Nhấn <b>＋ Tạo</b> để thêm một trình duyệt.</span></div>'; return; }
    // WU-E.1 §5 — concurrency capacity from the signed entitlement. When at the limit, an
    // OFFLINE browser's Open is disabled + noted; Close/Stop/recovery stay enabled.
    const maxConc = entitlementState && entitlementState.maxConcurrentBrowsers != null ? Number(entitlementState.maxConcurrentBrowsers) : null;
    const running = browsers.filter((b) => b.online).length;
    const atConc = maxConc != null && running >= maxConc;
    const concNote = atConc ? `<div class="cap-note">Đang chạy ${running}/${maxConc} trình duyệt đồng thời (giới hạn theo key). Đóng bớt một trình duyệt để mở cái khác.</div>` : '';
    listEl.innerHTML = concNote + browsers.map((b) => {
      const bd = badge(b);
      const dotCls = b.autoRunning ? 'auto' : b.runtimeStatus === 'ERROR' ? 'err' : b.online ? 'live' : '';
      const cls = ['rr-item', b.browserId === selectedBrowserId ? 'sel' : '', dotCls, b.online ? '' : 'closed'].filter(Boolean).join(' ');
      const odd = f2(b.currentOdd);
      const runtime = b.online
        ? `<div class="rr-meta"><span>SID ${b.currentSid != null ? esc(b.currentSid) : '—'}</span><span class="rr-odd">${odd != null ? esc(odd) + 'x' : '—'}</span></div><div class="rr-brid">${esc(b.runId || '')}</div>`
        : `<div class="rr-meta"><span>${b.lastOpenedAt ? 'Dùng lần cuối ' + esc(fmtTimeShort(b.lastOpenedAt)) : 'Chưa mở lần nào'}</span></div>`;
      // A run in ERROR is a dead end without a retry affordance: offer "Mở lại"
      // (close the failed run, then open again) so the user isn't forced to Đóng→Mở.
      const errored = b.online && b.runtimeStatus === 'ERROR';
      const actions = errored
        ? `<div class="rr-actions"><button class="rr-open-btn" data-reopen="${esc(b.browserId)}">Mở lại</button><button class="rr-mini" data-edit="${esc(b.browserId)}">Sửa</button><button class="rr-mini danger" data-close="${esc(b.browserId)}">Đóng</button></div>`
        : b.online
        ? `<div class="rr-actions"><button class="rr-mini" data-edit="${esc(b.browserId)}">Sửa</button><button class="rr-mini danger" data-close="${esc(b.browserId)}">Đóng</button></div>`
        : `<div class="rr-actions"><button class="rr-open-btn" data-open="${esc(b.browserId)}"${atConc ? ' disabled title="' + esc(`Đang chạy ${running}/${maxConc} trình duyệt đồng thời.`) + '"' : ''}>Mở</button><button class="rr-mini" data-edit="${esc(b.browserId)}">Sửa</button><button class="rr-mini danger" data-del="${esc(b.browserId)}">Xóa</button></div>`;
      // WU-C.3 — compact but distinctive jackpot line (always shown; "—" when unknown).
      const jpTxt = b.currentJackpot != null ? Number(b.currentJackpot).toLocaleString() : '—';
      const jpCls = b.currentJackpot == null ? 'unknown' : ((b.jackpotGateState === 'WAITING' || b.jackpotGateState === 'READY') ? 'gated' : '');
      const jpLine = `<div class="rr-jp ${jpCls}"><span class="rr-jp-star">★</span>JP ${esc(jpTxt)}</div>`;
      return `<div class="${cls}" data-browser="${esc(b.browserId)}">`
        + `<div class="rr-item-top"><span class="rr-dot"></span><span class="rr-id">${esc(b.browserId)}</span><span class="rr-badge ${bd.cls}" style="margin-left:auto">${esc(bd.text)}</span></div>`
        + `<div class="rr-name">${esc(b.name || '')}</div>`
        + jpLine + runtime + actions + `</div>`;
    }).join('');
    for (const el of listEl.querySelectorAll('.rr-item')) {
      el.onclick = (e) => { if (e.target.closest('button')) return; select(el.dataset.browser); };
    }
    listEl.querySelectorAll('[data-open]').forEach((x) => { x.onclick = (e) => { e.stopPropagation(); openBrowser(x.dataset.open); }; });
    listEl.querySelectorAll('[data-reopen]').forEach((x) => { x.onclick = async (e) => { e.stopPropagation(); const b = browsers.find((r) => r.browserId === x.dataset.reopen); if (b && b.runId) { try { await api.closeRun(b.runId); } catch { /* ignore */ } } await openBrowser(x.dataset.reopen); }; });
    listEl.querySelectorAll('[data-close]').forEach((x) => { x.onclick = async (e) => { e.stopPropagation(); const b = browsers.find((r) => r.browserId === x.dataset.close); if (b && b.runId) { try { await api.closeRun(b.runId); } catch { /* ignore */ } } }; });
    listEl.querySelectorAll('[data-edit]').forEach((x) => { x.onclick = (e) => { e.stopPropagation(); openModal('edit', browsers.find((r) => r.browserId === x.dataset.edit)); }; });
    listEl.querySelectorAll('[data-del]').forEach((x) => { x.onclick = async (e) => { e.stopPropagation(); if (!window.confirm('Xóa trình duyệt này? Dữ liệu hồ sơ vẫn được giữ trên đĩa.')) return; const r = await api.deleteBrowser(x.dataset.del); if (r && r.error) toast(browserErrVi(r.error)); }; });
  }

  function select(browserId) { selectedBrowserId = browserId; render(); reconcile(); }
  async function openBrowser(browserId) { selectedBrowserId = browserId; const r = await api.openBrowserById(browserId); if (r && r.error) toast(browserErrVi(r.error)); }

  // Bind currentRunId to the selected browser's live run, or null when OFFLINE.
  function reconcile() {
    if (!browsers.length) { selectedBrowserId = null; railSelect(false, null); return; }
    if (!selectedBrowserId || !browsers.find((b) => b.browserId === selectedBrowserId)) {
      const online = browsers.find((b) => b.online);
      selectedBrowserId = (online || browsers[0]).browserId;
    }
    const sel = browsers.find((b) => b.browserId === selectedBrowserId);
    railSelect(true, sel && sel.online ? sel.runId : null);
    setCurrentBrowser(selectedBrowserId); // drives the persistent history panel
    renderJackpot(); renderIdent();       // keep the jackpot chip + identity band in sync on selection
  }

  // WU-C.3 — always-highlighted jackpot chip for the selected browser, plus the
  // SEPARATE gate active/ready indicator (the jackpot value stays prominent either way).
  function renderJackpot() {
    const chip = $('at-jp-chip'); if (!chip) return;
    const b = browsers.find((x) => x.browserId === selectedBrowserId);
    const jp = b ? b.currentJackpot : null;
    const txt = jp != null ? Number(jp).toLocaleString() : '—';
    const val = $('at-jp-value'); if (val) val.textContent = txt;
    const cur = $('at-jp-cur'); if (cur) cur.textContent = txt;
    chip.classList.toggle('unknown', jp == null);
    const gs = b ? b.jackpotGateState : 'IDLE';
    const gate = $('at-jp-gate');
    if (gate) {
      if (gs === 'WAITING') { gate.hidden = false; gate.className = 'jp-gate waiting'; gate.textContent = 'Gate • waiting' + (b && b.jackpotThreshold != null ? ' ≥ ' + Number(b.jackpotThreshold).toLocaleString() : ''); }
      else if (gs === 'READY') { gate.hidden = false; gate.className = 'jp-gate ready'; gate.textContent = 'Gate • ready'; }
      else { gate.hidden = true; gate.textContent = ''; }
    }
    chip.classList.toggle('gated', gs === 'WAITING' || gs === 'READY');
  }

  // WU-D.1 — the selected-browser identity band is the workspace's center of gravity.
  // It shows which B-* is in focus + its live at-a-glance state (from the signed
  // summary), and mirrors the jackpot into the Overview. It never retargets a run.
  function renderIdent() {
    const emptyEl = $('wsi-empty'), bodyEl = $('wsi-body');
    const b = browsers.find((x) => x.browserId === selectedBrowserId);
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    if (!b) { if (emptyEl) emptyEl.hidden = false; if (bodyEl) bodyEl.hidden = true; const o = $('ov-jackpot'); if (o) o.textContent = '—'; return; }
    if (emptyEl) emptyEl.hidden = true; if (bodyEl) bodyEl.hidden = false;
    const bd = badge(b);
    set('wsi-bid', b.browserId);
    set('wsi-name', b.name || '');
    const st = $('wsi-state'); if (st) { st.textContent = bd.text; st.className = 'wsi-state ' + bd.cls; }
    set('wsi-sid', b.online && b.currentSid != null ? b.currentSid : '—');
    const odd = f2(b.currentOdd);
    set('wsi-odd', b.online && odd != null ? odd + 'x' : '—');
    const jp = b.currentJackpot != null ? Number(b.currentJackpot).toLocaleString() : '—';
    set('wsi-jp', jp);
    const ovjp = $('ov-jackpot'); if (ovjp) ovjp.textContent = jp;
  }

  function apply(payload) {
    browsers = (payload && payload.browsers) || [];
    capacity = (payload && payload.capacity) || capacity;
    render(); reconcile(); renderJackpot(); renderIdent();
  }
  api.onBrowsersChanged(apply);
  api.listBrowsers().then(apply).catch(() => {});
  // Browser IPCs are license-gated; re-fetch when a license becomes active so the
  // rail populates without waiting for the next lifecycle event.
  if (api.onLicenseChanged) api.onLicenseChanged((s) => { if (s && s.active) api.listBrowsers().then(apply).catch(() => {}); });

  // Map source-real error codes → Vietnamese customer message (§22). Technical detail
  // (code) is preserved for support but never shown raw as the primary message.
  function browserErrVi(err) {
    if (!err) return 'Đã xảy ra lỗi.';
    const code = err.code || '';
    if (code === 'CHROME_NOT_FOUND') return 'Không tìm thấy Google Chrome. Hãy cài Chrome, hoặc đặt biến môi trường CHROME_PATH trỏ tới chrome.exe, rồi mở lại.';
    if (code === 'BROWSER_LIMIT_REACHED') return 'Đã đạt giới hạn số hồ sơ theo bản quyền của bạn.';
    if (code === 'BROWSER_RUNTIME_LIMIT_REACHED') return 'Đã đạt giới hạn số trình duyệt chạy đồng thời theo bản quyền.';
    if (code === 'BROWSER_ALREADY_RUNNING') return 'Trình duyệt này đang chạy.';
    return err.message || code || 'Đã xảy ra lỗi.';
  }

  // ---- New / Edit modal ----
  let modalMode = 'new', modalBrowserId = null;
  function openModal(mode, browser) {
    modalMode = mode; modalBrowserId = browser ? browser.browserId : null;
    $('bm-title').textContent = mode === 'edit' ? `Chỉnh sửa ${browser.browserId}` : 'Trình duyệt mới';
    $('bm-name').value = browser ? (browser.name || '') : '';
    $('bm-url').value = browser ? (browser.launchUrl || '') : '';
    $('bm-submit').textContent = mode === 'edit' ? 'Lưu' : 'Tạo & Mở';
    const err = $('bm-error'); err.hidden = true; err.textContent = '';
    $('browser-modal').hidden = false; $('bm-name').focus();
    // WU-E.4: the in-app browser is a NATIVE view that always paints above HTML; hide it while
    // this modal is open so its inputs (name/URL) are reachable. See overviewInAppUI.
    document.dispatchEvent(new CustomEvent('modal-changed', { detail: { open: true } }));
  }
  function closeModal() { $('browser-modal').hidden = true; document.dispatchEvent(new CustomEvent('modal-changed', { detail: { open: false } })); }
  function modalError(m) { const err = $('bm-error'); err.hidden = false; err.textContent = m; }
  async function submitModal() {
    const name = $('bm-name').value.trim(); const url = $('bm-url').value.trim();
    if (!/^https?:\/\//i.test(url)) return modalError('Hãy nhập địa chỉ http(s) hợp lệ.');
    if (modalMode === 'edit') {
      const r = await api.updateBrowser(modalBrowserId, { name, launchUrl: url });
      if (r && r.error) return modalError(browserErrVi(r.error));
      closeModal();
    } else {
      const r = await api.createBrowser({ name, url });
      if (r && r.error) return modalError(browserErrVi(r.error));
      closeModal();
      // Focus the Overview on the browser we just created & opened, so its configured URL is what
      // the user sees (not whichever browser was previously selected). select() reconciles the
      // view pointer -> currentRunId follows this run as soon as it connects.
      select(r.browserId);
    }
  }
  const newBtn = $('rr-new');
  if (newBtn) newBtn.onclick = () => { if (!capacity.canCreate) return toast(`Đã đạt giới hạn hồ sơ (${capacity.registered}/${capacity.max})`); openModal('new', null); };
  $('bm-cancel').onclick = closeModal;
  $('bm-submit').onclick = submitModal;
  $('bm-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitModal(); });
  $('browser-modal').addEventListener('click', (e) => { if (e.target.id === 'browser-modal') closeModal(); });
})();

// ==================== WU-C.2 PERSISTENT BROWSER HISTORY / STATS ====================
// Compact, read-only view of the SELECTED persistent browser's stored round history
// and aggregate statistics. It is display only — main is the source of truth and the
// renderer can never write a result. UNKNOWN is shown neutrally (never as a loss);
// unproven monetary values (payout / net) render as "—", never a fake 0.
(function browserHistoryUI() {
  if (!api.browserStats) return; // preload without WU-C.2 surface — inert
  const statsEl = $('bh-stats'); const roundsEl = $('bh-rounds'); const nameEl = $('bh-name');
  if (!statsEl || !roundsEl) return;
  const f2 = (n) => (n == null || !Number.isFinite(Number(n))) ? null : Number(n).toFixed(2);
  const money = (n) => (n == null || !Number.isFinite(Number(n))) ? null : Number(n).toLocaleString();

  function kv(label, value, na) { return `<div class="bh-kv ${na ? 'na' : ''}"><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }

  function renderStats(s) {
    if (s && s.licensed === false) { statsEl.innerHTML = '<div class="locked-state">🔒 Tính năng <b>Lịch sử vòng chơi</b> chưa được cấp phép trong gói của bạn.</div>'; return; }
    if (!s || s.corrupt) { statsEl.innerHTML = `<div class="muted">${s && s.corrupt ? 'Tệp lịch sử không đọc được (đã giữ lại để khôi phục).' : 'Chưa có lịch sử.'}</div>`; return; }
    const totalBet = s.totalBet == null ? '—' : money(s.totalBet);
    const betNote = s.betUnknownCount ? ` (+${s.betUnknownCount} không rõ)` : '';
    // Evidence-safe (§17): NO win-rate (LOSS is never inferred → it would be misleading),
    // NO LOSS row, payout/net are unproven → "Không có". UNKNOWN is first-class.
    statsEl.innerHTML =
      kv('Tổng vòng', s.totalRounds) +
      kv('Thắng (đã xác nhận)', s.wins) +
      kv('Không rõ', s.unknown) +
      kv('ODD cao nhất', s.highestObservedOdd != null ? f2(s.highestObservedOdd) + 'x' : '—', s.highestObservedOdd == null) +
      kv('Tổng cược đã nhận', (totalBet === '—' ? '—' : totalBet) + betNote, s.totalBet == null) +
      kv('Tiền thắng', 'Không có', true) +           // wm/payout semantics unproven
      kv('Lãi/Lỗ', 'Không có', true) +
      kv('SID gần nhất', s.lastSid != null ? s.lastSid : '—', s.lastSid == null);
  }

  const RESULT_VI = { WIN: 'Thắng', LOSS: 'Thua', UNKNOWN: 'Không rõ' };
  function resultBadge(r) {
    const cls = r.result === 'WIN' ? 'win' : r.result === 'LOSS' ? 'loss' : 'unknown';
    return `<span class="bh-res ${cls}">${esc(RESULT_VI[r.result] || 'Không rõ')}</span>`;
  }
  function renderRounds(list) {
    if (!list || !list.length) { roundsEl.innerHTML = '<div class="muted">Chưa ghi nhận vòng nào.</div>'; return; }
    roundsEl.innerHTML = list.map((r) => {
      const bet = r.acceptedBet != null ? money(r.acceptedBet) : (r.requestedBet != null ? money(r.requestedBet) + '?' : '—');
      const odd = r.cashoutAckOdd != null ? f2(r.cashoutAckOdd) + 'x' : (r.triggerOdd != null ? f2(r.triggerOdd) + 'x' : '—');
      const t = r.endedAt ? fmtTimeShort(r.endedAt) : '';
      return `<div class="bh-row" title="${esc(r.runId || '')} · ${esc(r.terminationReason || '')}">`
        + `<span class="bh-sid">${esc(r.sid != null ? r.sid : '—')}</span>`
        + `<span class="bh-reason">${esc(t)}</span>`
        + `<span>${esc(bet)}</span>`
        + `<span class="bh-odd">${esc(odd)}</span>`
        + resultBadge(r) + `</div>`;
    }).join('');
  }

  let loading = null;
  async function refresh() {
    const bid = currentBrowserId;
    if (nameEl) nameEl.textContent = bid ? '· ' + bid : '';
    if (!bid) { renderStats(null); renderRounds([]); return; }
    const token = {}; loading = token;
    try {
      const [stats, rounds] = await Promise.all([api.browserStats(bid), api.browserHistory(bid, { limit: 50 })]);
      if (loading !== token) return; // a newer selection superseded this fetch
      renderStats(stats); renderRounds(rounds);
    } catch { if (loading === token) { renderStats(null); renderRounds([]); } }
  }

  document.addEventListener('browser-view-changed', refresh);
  document.addEventListener('history-activate', refresh); // re-fetch when the Lịch sử tab opens
  if (api.onBrowserHistoryChanged) api.onBrowserHistoryChanged((p) => { if (p && p.browserId === currentBrowserId) refresh(); });
  refresh();
})();




// ==================== WU-E.1 SYSTEMATIC FEATURE-LOCK UI ====================
// Renders locked (dim + 🔒 + non-interactive + note) states for features the current key
// lacks. Notes name the RIGHT (entitlement), never a plan (no runtime plan->feature map).
// Main process is the real authority; this is the visible, honest UX layer over it.
(function featureLockUI() {
  function ensureNote(afterEl, id, text, ent) {
    if (!afterEl || !afterEl.parentNode) return null;
    let n = document.getElementById(id);
    if (!n) { n = document.createElement('div'); n.id = id; n.className = 'lock-note'; afterEl.parentNode.insertBefore(n, afterEl.nextSibling); }
    n.innerHTML = '<span>' + text + ' <span class="ent">Entitlement: ' + ent + '</span></span>';
    return n;
  }
  function apply(e) {
    const f = (e && e.features) || {};
    // "Chờ Jackpot" gate (jackpotGate) — the checkbox + its config become locked.
    const box = document.getElementById('at-jp-wait');
    const label = box ? box.closest('label') : null;
    const gateOk = !!f.jackpotGate;
    if (box) {
      box.disabled = !gateOk;
      if (!gateOk) { box.checked = false; const c = document.getElementById('at-jp-config'); if (c) c.hidden = true; }
      if (label) { label.classList.toggle('feature-locked', !gateOk); }
      const note = ensureNote(label || box, 'at-jp-lock', 'Key hiện tại chưa có quyền "Chờ Jackpot". Yêu cầu key có quyền này.', 'jackpotGate');
      if (note) note.hidden = gateOk;
    }
    // "Jackpot trực tiếp" (jackpotLive) — value is withheld by main; add an explicit note.
    const chip = document.getElementById('at-jp-chip');
    const liveOk = !!f.jackpotLive;
    if (chip) {
      const note = ensureNote(chip, 'at-jplive-lock', 'Key hiện tại chưa có quyền "Jackpot trực tiếp" — giá trị jackpot sẽ ẩn.', 'jackpotLive');
      if (note) note.hidden = liveOk;
    }
  }
  document.addEventListener('entitlement-change', function (ev) { apply(ev.detail || {}); });
  document.addEventListener('view-changed', function () { if (typeof entitlementState !== 'undefined' && entitlementState) apply(entitlementState); });
  if (typeof entitlementState !== 'undefined' && entitlementState) apply(entitlementState);
})();

// ==================== WU-E.4 TRUE IN-APP BROWSER VIEW (Tổng quan) ====================
// In 'inapp' mode the web/game is a native Electron WebContentsView owned by main. The
// renderer only reports the Overview web-region bounds so main positions/shows the selected
// run's view there (and hides all views on other tabs / when offline). Display+layout only:
// no screencast, no input forwarding — the user interacts with the native surface directly.
(function overviewInAppUI() {
  if (!api.inappView) return; // preload without WU-E.4 surface — inert
  const host = $('ov-web-host'), overlay = $('ov-web-overlay');
  if (!host) return;
  let viewIsOverview = (document.body.dataset.view || 'overview') === 'overview';
  // A native WebContentsView always paints above the window's HTML, so any HTML modal/dialog
  // over the web region would be occluded. Hide the view while a modal is open (a proven
  // interaction bug: the "New/Edit browser" URL field was unreachable under the native view).
  function modalOpen() { return !!document.querySelector('.bm-overlay:not([hidden])'); }
  // Report the browser host rectangle, CLAMPED to the scrollable content viewport (#shell-main).
  // The native WebContentsView paints above HTML and does not clip to a scroll container, so
  // clamping keeps it inside the content area — it never covers the header/tabs when Row 2 scrolls.
  function bounds() {
    const r = host.getBoundingClientRect();
    const main = $('shell-main');
    const m = main ? main.getBoundingClientRect() : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    const top = Math.max(r.top, m.top), bottom = Math.min(r.bottom, m.bottom);
    const left = Math.max(r.left, m.left), right = Math.min(r.right, m.right);
    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }
  function reconcile() {
    const runId = (typeof currentRunId !== 'undefined') ? currentRunId : null;
    const show = !!(viewIsOverview && runId && !modalOpen());
    if (show) { if (overlay) overlay.hidden = true; api.inappView(runId, bounds(), true).catch(function () {}); }
    else { api.inappView(runId || null, null, false).catch(function () {}); }
  }
  let rt = null; const soon = () => { clearTimeout(rt); rt = setTimeout(reconcile, 60); };
  document.addEventListener('view-changed', function (e) { viewIsOverview = e.detail && e.detail.view === 'overview'; reconcile(); });
  document.addEventListener('run-selected', reconcile);
  document.addEventListener('modal-changed', reconcile);
  if (api.onBrowsersChanged) api.onBrowsersChanged(soon);
  window.addEventListener('resize', soon);
  const main = $('shell-main'); if (main) main.addEventListener('scroll', soon, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(soon).observe(host);
  window.addEventListener('beforeunload', function () { api.inappView(null, null, false).catch(function () {}); });
  reconcile();
})();
