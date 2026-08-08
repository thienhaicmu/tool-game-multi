'use strict';
const api = window.desktopCapture || {};
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
async function copy(text, label) { try { await navigator.clipboard.writeText(text); toast((label || 'Copied') + ' ✓'); } catch { toast('Copy failed'); } }

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

// ---- targets / connection ----
function parseHostPort(s) { const m = String(s).trim().match(/^(?:https?:\/\/)?([^:/\s]+)(?::(\d+))?/); return m ? { host: m[1], port: Number(m[2] || 9222) } : { host: '127.0.0.1', port: 9222 }; }
$('connect').onclick = async () => { const r = await api.connect(parseHostPort($('host').value)); if (r && r.error) toast(r.error.code || 'Connect failed'); };
// Scope: when "All domains" is on, capture EVERYTHING fully (no redaction) — needed
// for games whose WS/API live on sibling domains. Off = only the launched host.
async function applyScope() { if ($('scope-all').checked) { await api.setScope([]); } else { let h = null; try { h = new URL($('url').value.trim()).hostname; } catch { /* none */ } await api.setScope(h ? [h] : []); } }
$('scope-all').onchange = () => { applyScope(); toast($('scope-all').checked ? 'Bắt tất cả domain' : 'Chỉ bắt host game'); };
applyScope();
$('launch').onclick = async () => { const url = $('url').value.trim(); if (!url) return toast('Enter a URL'); await applyScope(); await api.openBrowser(url); $('chip-cap').textContent = 'Launching…'; };
$('adb').onclick = async () => {
  const r = await api.adbListWebviews();
  if (!r || !r.ok) return toast((r && r.error && r.error.code) || 'adb unavailable');
  if (!r.sockets.length) return toast('No WebView sockets found');
  const res = await api.adbForwardWebview(r.sockets[0]);
  toast(res && res.ok ? 'Attached ' + r.sockets[0] : ((res && res.error && res.error.code) || 'adb forward failed'));
};
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

// ============================ WU7 PROTOCOL TEST HARNESS ============================
// Authorized QA sender for observed Aviator WS flows. OBSERVE -> BUILD -> MODIFY ->
// SEND (authorized session) -> RECORD -> VERIFY. No prediction, no wagering automation.
(function protocolHarnessUI() {
  if (!api.protocolExecute) return; // preload without WU7 — stay inert
  let round = null;                 // current server round {sid,state,lastOdd,updatedAt}
  let env = { allowed: false, name: null, host: '' };
  let sidHistoryCache = [];
  const execs = [];                 // newest-first execution records
  const execById = new Map();

  const numOrNull = (v) => { const s = String(v).trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : s; };

  function setEnvChips() {
    const chip = $('proto-env-chip');
    if (chip) { chip.textContent = env.allowed ? 'ENABLED' : 'OFF'; chip.className = 'chip ' + (env.allowed ? 'on' : 'off'); }
    const badge = $('proto-env');
    if (badge) {
      badge.textContent = env.allowed ? `TEST CONTROL — ENABLED · ${env.name || env.host}` : `CONTROL DISABLED${env.host ? ' · ' + env.host : ''}`;
      badge.className = 'proto-env ' + (env.allowed ? 'on' : 'off');
    }
    const send = $('pf-send'); if (send) send.disabled = !env.allowed;
  }
  async function refreshEnv() { try { env = await api.protocolEnvironment(); } catch { env = { allowed: false }; } setEnvChips(); }

  function renderState() {
    $('ps-sid').textContent = round && round.sid != null ? round.sid : '—';
    $('ps-state').textContent = round ? round.state : '—';
    $('ps-odd').textContent = round && round.lastOdd != null ? round.lastOdd : '—';
    $('ps-updated').textContent = round && round.updatedAt ? fmtTime(round.updatedAt) : '—';
    refreshSidField();
  }
  function renderSidHistory(list) {
    const el = $('ps-sidhist'); if (!el) return;
    if (!list || !list.length) { el.innerHTML = '<span class="muted">none</span>'; return; }
    const cur = round && round.sid != null ? String(round.sid) : null;
    el.innerHTML = list.slice(-12).map((h) => `<span class="sid ${cur === String(h.sid) ? 'cur' : ''}">${esc(h.sid)}${h.delta != null ? `<span class="d"> ${h.delta >= 0 ? '+' : ''}${h.delta}</span>` : ''}</span>`).join('');
  }

  // sid is bound to the CURRENT server round (never guessed). Stale-sid negative
  // test intentionally fills the PREVIOUS observed sid to verify server rejection.
  function refreshSidField() {
    const input = $('pf-sid'); if (!input) return;
    const stale = $('pf-neg-stale').checked;
    if (stale) {
      const prev = sidHistoryCache.length >= 2 ? sidHistoryCache[sidHistoryCache.length - 2].sid : (round && round.sid != null ? Number(round.sid) - 1 : '');
      input.value = prev != null ? prev : '';
    } else if (round && round.sid != null) {
      input.value = round.sid;
    }
    tagSid();
  }
  async function tagSid() {
    const tag = $('pf-sid-tag'); if (!tag) return;
    const sid = numOrNull($('pf-sid').value);
    let check; try { check = await api.protocolCheckSid(sid); } catch { check = null; }
    if (!check) { tag.textContent = ''; return; }
    if (check.match) { tag.textContent = '← server'; tag.className = 'sid-tag ok'; }
    else { tag.textContent = `STALE (server ${check.current ?? '—'})`; tag.className = 'sid-tag stale'; }
  }

  function buildPayload() {
    const command = $('pf-command').value;
    const invalidAmount = $('pf-neg-amount').checked;
    const payload = command === 'cashout'
      ? { cmd: 100003, sid: numOrNull($('pf-sid').value), aid: numOrNull($('pf-aid').value), eid: numOrNull($('pf-eid').value) }
      : { cmd: 100002, b: invalidAmount ? -1 : numOrNull($('pf-b').value), sid: numOrNull($('pf-sid').value), aid: numOrNull($('pf-aid').value), eid: numOrNull($('pf-eid').value) };
    return { command, payload };
  }
  function negFlags() {
    return { stale: $('pf-neg-stale').checked, amount: $('pf-neg-amount').checked, dup: $('pf-neg-dup').checked };
  }

  $('pf-command').onchange = () => { $('pf-b').closest('label').style.display = $('pf-command').value === 'cashout' ? 'none' : ''; renderPreview(); };
  for (const id of ['pf-b', 'pf-aid', 'pf-eid']) $(id).oninput = renderPreview;
  $('pf-sid').oninput = () => { tagSid(); renderPreview(); };
  for (const id of ['pf-neg-stale', 'pf-neg-amount', 'pf-neg-dup']) $(id).onchange = () => {
    const anyNeg = $('pf-neg-stale').checked || $('pf-neg-amount').checked || $('pf-neg-dup').checked;
    $('pf-neg-note').hidden = !anyNeg;
    refreshSidField(); renderPreview();
  };

  function renderPreview() {
    const { payload } = buildPayload();
    const el = $('pf-json'); if (!el.hidden) el.textContent = JSON.stringify(payload, null, 2);
  }
  $('pf-preview').onclick = () => { const el = $('pf-json'); el.hidden = false; renderPreview(); };

  $('pf-send').onclick = async () => {
    const btn = $('pf-send'); btn.disabled = true; btn.textContent = 'Sending…';
    const { command, payload } = buildPayload();
    const neg = negFlags();
    const negative = neg.stale || neg.amount || neg.dup;
    try {
      if (neg.dup) {
        // Duplicate/replay-protection test: first send is the baseline, the SECOND
        // is expected to be rejected if the server enforces idempotency (§8).
        await api.protocolExecute({ command, payload, source: 'NEGATIVE_TEST', expect: null, allowMismatch: neg.stale });
        await api.protocolExecute({ command, payload, source: 'NEGATIVE_TEST', negative: true, expect: 'reject', allowMismatch: neg.stale });
      } else {
        await api.protocolExecute({ command, payload, negative, expect: negative ? 'reject' : null, allowMismatch: neg.stale });
      }
    } catch { toast('Send failed'); }
    btn.disabled = !env.allowed; btn.textContent = 'Send Test Request';
  };

  function renderExecs() {
    const el = $('pf-executions'); if (!el) return;
    if (!execs.length) { el.innerHTML = '<div class="muted">No tests run yet.</div>'; return; }
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

  // ---- live streams ----
  api.onAviatorRound && api.onAviatorRound((r) => { round = r; if (r && r.sid != null && !sidHistoryCache.some((h) => String(h.sid) === String(r.sid))) sidHistoryCache.push({ sid: r.sid, delta: null }); renderState(); renderSidHistory(sidHistoryCache); });
  api.onProtocolExecution && api.onProtocolExecution((x) => pushExec(x));

  // ---- panel open/close ----
  $('proto-toggle').onclick = async () => {
    const p = $('proto-panel'); p.hidden = !p.hidden;
    if (!p.hidden) {
      await refreshEnv();
      try { const st = await api.protocolRoundState(); round = st.current; sidHistoryCache = st.sidHistory || []; renderState(); renderSidHistory(sidHistoryCache); } catch { /* ignore */ }
      try { const list = await api.protocolExecutions(); execs.length = 0; execById.clear(); for (const x of list.reverse()) pushExec(x); } catch { /* ignore */ }
    }
  };
  $('proto-close').onclick = () => { $('proto-panel').hidden = true; };

  // Refresh env when the selected target changes (chain the existing handler).
  const origTargetsChange = $('targets').onchange;
  $('targets').onchange = (e) => { if (origTargetsChange) origTargetsChange.call($('targets'), e); setTimeout(refreshEnv, 60); };
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
    if (!p.hidden) { try { snap = await api.observerSnapshot(); } catch { snap = null; } render(); }
  };
  $('obs-close').onclick = () => { $('obs-panel').hidden = true; };
})();
