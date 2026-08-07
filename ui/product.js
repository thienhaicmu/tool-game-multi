const events = [];
const selected = new Set();
const rows = document.querySelector('#requests');
const workspace = document.querySelector('#workspace');
const projectCard = document.querySelector('.project-switch');
const productStyle = document.createElement('style'); productStyle.textContent = '.project-field{display:grid;gap:4px;color:var(--muted);font-size:10px}.project-field input{width:100%;height:28px;border:1px solid var(--line);border-radius:6px;padding:0 7px;background:var(--surface);color:var(--text);font-size:10px}.response-card{margin-top:25px;border:1px solid var(--line);border-radius:9px;background:var(--surface);padding:14px}.response-card small{display:block;color:var(--muted);font-size:9px;letter-spacing:.1em}.response-card strong{display:block;color:var(--accent);font-size:22px;margin:8px 0}.response-card pre{max-height:220px;overflow:auto;white-space:pre-wrap;color:var(--muted);font-size:11px}.session-row{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid var(--line);background:var(--surface)}.session-row b,.session-row span{display:block}.session-row span{color:var(--muted);font-size:11px;margin-top:4px}.session-row button{border:1px solid var(--line);background:var(--surface);color:var(--accent);border-radius:6px;padding:8px 11px}.row-replace{border:1px solid var(--accent);background:var(--surface);color:var(--accent);border-radius:5px;padding:5px 7px;font-size:10px;cursor:pointer}#selection-bar{display:none;position:absolute;bottom:18px;left:18px;right:18px;z-index:4;gap:10px;align-items:center;padding:10px 12px;background:var(--header);color:#fff;border-radius:8px;box-shadow:0 5px 20px #0003}#selection-bar button{border:1px solid #52717a;background:transparent;color:#fff;border-radius:5px;padding:6px 9px;font-size:10px}#selection-bar button:first-of-type{margin-left:auto;background:var(--accent);border-color:var(--accent)}'; document.head.appendChild(productStyle);
projectCard.insertAdjacentHTML('beforeend', '<label class="project-field">Webapp URL<input id="target-url" value="https://staging.example.com"></label><label class="project-field">Allowed domains<input id="scope" placeholder="app.local, api.local, *.cdn.com"></label>');
try { document.querySelector('#target-url').value = localStorage.getItem('observatory-target-url') || 'https://staging.example.com'; document.querySelector('#scope').value = localStorage.getItem('observatory-scope') || ''; } catch {}
const copy = { vi: { status: 'Sẵn sàng', open: 'Mở Chromium', title: 'Requests', subtitle: 'Chọn request để xem và thay giá trị.', captured: 'Requests đã bắt', select: 'Chọn tất cả', empty: 'Chưa có request', emptyHint: 'Mở Chromium và thao tác trên webapp.', workspace: 'Request workspace', workspaceHint: 'Chọn request để sửa value và replay.', search: 'Tìm host, path hoặc method' }, en: { status: 'Ready', open: 'Open Chromium', title: 'Requests', subtitle: 'Select requests to review and replace values.', captured: 'Captured requests', select: 'Select all', empty: 'No requests yet', emptyHint: 'Open Chromium and use your webapp.', workspace: 'Request workspace', workspaceHint: 'Choose a request to edit values and replay.', search: 'Search host, path or method' } };
function applyLanguage(language) { const text = copy[language] || copy.en; document.querySelector('#status').textContent = text.status; document.querySelector('#open').textContent = text.open; document.querySelector('#view-title').textContent = text.title; document.querySelector('#view-subtitle').textContent = text.subtitle; document.querySelector('.list-head b').textContent = text.captured; document.querySelector('#select-all').textContent = text.select; document.querySelector('#search').placeholder = text.search; document.documentElement.lang = language; try { localStorage.setItem('observatory-language', language); } catch {} }
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function urlInfo(raw) { try { const url = new URL(raw); return { url, path: url.pathname + (url.search || '') }; } catch { return { url: null, path: raw }; } }
function render() {
  const query = document.querySelector('#search').value.toLowerCase();
  const type = document.querySelector('#type').value;
  const list = events.filter(event => event.kind === 'request').filter(event => type === 'all' || event.resourceType === type).filter(event => !query || (event.url + event.method).toLowerCase().includes(query));
  document.querySelector('#count').textContent = list.length;
  if (!list.length) { rows.innerHTML = '<div class="empty"><strong>No requests yet</strong><span>Open Chromium and use your webapp.</span></div>'; return; }
  rows.innerHTML = list.slice().reverse().map(event => {
    const info = urlInfo(event.url); const response = events.find(item => item.kind === 'response' && item.id === event.id);
    return '<div class="row ' + (selected.has(event.id) ? 'selected' : '') + '" data-id="' + esc(event.id) + '"><input type="checkbox" ' + (selected.has(event.id) ? 'checked' : '') + '><span class="method">' + esc(event.method) + '</span><span>' + esc(event.resourceType) + '</span><span><b class="host">' + esc(info.url?.host || '') + '</b><span class="path">' + esc(info.path) + '</span></span><span class="status">' + esc(response?.status || '…') + '</span><button class="row-replace" type="button">Replace</button></div>';
  }).join('');
  rows.querySelectorAll('.row').forEach(row => { row.onclick = event => { if (event.target.tagName === 'INPUT') { event.stopPropagation(); row.querySelector('input').checked ? selected.add(row.dataset.id) : selected.delete(row.dataset.id); row.classList.toggle('selected', selected.has(row.dataset.id)); return; } openWorkspace(row.dataset.id); }; row.querySelector('.row-replace').onclick = event => { event.stopPropagation(); openWorkspace(row.dataset.id); }; });
  renderSelectionBar();
}
function renderSelectionBar() { let bar = document.querySelector('#selection-bar'); if (!bar) { bar = document.createElement('div'); bar.id = 'selection-bar'; document.querySelector('.request-list').appendChild(bar); } bar.innerHTML = selected.size ? '<b>' + selected.size + ' selected</b><button id="bulk-replay">Replay sequence</button><button id="clear-selected">Clear selection</button>' : ''; bar.style.display = selected.size ? 'flex' : 'none'; if (selected.size) { bar.querySelector('#clear-selected').onclick = () => { selected.clear(); render(); }; bar.querySelector('#bulk-replay').onclick = replaySequence; } }
async function replaySequence() {
  const chosen = [...selected]; const results = [];
  for (const id of chosen) { const draft = await window.desktopCapture?.replayCreateDraft(id, {}); if (!draft || draft.error) { results.push({ id, error: draft && draft.error }); continue; } const exec = await window.desktopCapture?.replayExecute(draft.id); results.push({ id, mode: exec.mode, status: exec.response ? exec.response.status : 0, state: exec.status, error: exec.error }); }
  workspace.innerHTML = '<div class="replace"><h2>Replay sequence</h2><p class="subtitle">Completed ' + results.length + ' request(s).</p><div class="response-card"><pre>' + esc(JSON.stringify(results, null, 2)) + '</pre></div></div>';
}
// WU3: duplicate the immutable CapturedRequest into a ReplayDraft, edit, and send.
async function openWorkspace(id) {
  const detail = await window.desktopCapture?.getRequestDetail(id);
  if (!detail || detail.error) { workspace.innerHTML = '<div class="empty"><strong>Request unavailable</strong><span>' + esc(detail && detail.error && detail.error.code || 'Not found') + '</span></div>'; return; }
  const draft = await window.desktopCapture?.replayCreateDraft(id, {});
  if (!draft || draft.error) { workspace.innerHTML = '<div class="empty"><strong>Cannot duplicate</strong><span>' + esc(draft && draft.error && draft.error.code || 'error') + '</span></div>'; return; }
  const host = (() => { try { return new URL(draft.url).host; } catch { return ''; } })();
  workspace.innerHTML = '<div class="replace"><div class="subtitle">' + esc(draft.method) + ' · ' + esc(host) + ' · duplicated from captured request (original unchanged)</div><h2>Replay</h2>'
    + '<h3>Mode</h3><select id="rmode"><option value="WEBVIEW_CONTEXT">WebView Context — uses WebView cookies/session; browser policies apply</option><option value="HTTP_DIRECT">HTTP Direct — sent from debugger; no WebView session</option></select>'
    + '<h3>Method &amp; URL</h3><input id="rmethod" value="' + esc(draft.method) + '" style="width:90px"><input id="rurl" value="' + esc(draft.url) + '" style="width:calc(100% - 100px)">'
    + '<h3>Headers (JSON)</h3><textarea id="rheaders" rows="6" style="width:100%">' + esc(JSON.stringify(draft.headers, null, 2)) + '</textarea>'
    + '<h3>Body (raw)</h3><textarea id="rbody" rows="6" style="width:100%">' + esc(draft.body && draft.body.raw || '') + '</textarea>'
    + '<button class="replay" id="rsend">Send</button>'
    + '<div class="response-card"><small>REPLAY RESULT</small><strong id="rstatus">—</strong><pre id="rresult"></pre></div>'
    + '<div class="response-card"><small>ORIGINAL RESPONSE BODY</small><button class="row-replace" id="load-body" type="button">Load response body</button><pre id="bodyout"></pre></div>'
    + '<div class="response-card"><small>REPLAY HISTORY</small><pre id="rhistory"></pre></div></div>';
  const loadBodyBtn = document.querySelector('#load-body');
  loadBodyBtn.onclick = async () => { loadBodyBtn.textContent = 'Loading…'; const r = await window.desktopCapture?.getResponseBody(id); const out = document.querySelector('#bodyout'); if (r && r.available) out.textContent = r.base64Encoded ? '[base64 ' + (r.length || 0) + ' bytes' + (r.truncated ? ', truncated' : '') + ']\n' + String(r.body).slice(0, 4000) : String(r.body).slice(0, 20000); else out.textContent = (r && r.error && r.error.code) ? r.error.code + ': ' + (r.error.message || '') : 'No body'; loadBodyBtn.textContent = 'Load response body'; };
  async function refreshHistory() { const h = await window.desktopCapture?.replayHistory(id); document.querySelector('#rhistory').textContent = (h.executions || []).map(e => '#' + (e.seq + 1) + ' ' + e.mode + ' → ' + (e.response ? e.response.status + ' (' + (e.response.duration || 0) + 'ms)' : (e.error && e.error.code) || e.status)).join('\n') || 'No replays yet'; }
  document.querySelector('#rsend').onclick = async () => {
    const btn = document.querySelector('#rsend'); btn.textContent = 'Sending…';
    let headers; try { headers = JSON.parse(document.querySelector('#rheaders').value || '{}'); } catch { document.querySelector('#rresult').textContent = 'INVALID_HEADER: headers must be valid JSON'; btn.textContent = 'Send'; return; }
    const patch = { mode: document.querySelector('#rmode').value, method: document.querySelector('#rmethod').value.trim().toUpperCase(), url: document.querySelector('#rurl').value.trim(), headers, body: document.querySelector('#rbody').value };
    const upd = await window.desktopCapture?.replayUpdateDraft(draft.id, patch);
    if (upd && upd.error) { document.querySelector('#rresult').textContent = upd.error.code + ': ' + (upd.error.message || ''); btn.textContent = 'Send'; return; }
    const exec = await window.desktopCapture?.replayExecute(draft.id);
    const status = document.querySelector('#rstatus'); const out = document.querySelector('#rresult');
    if (exec.status === 'COMPLETED') { status.textContent = exec.response.status + ' ' + (exec.response.statusText || ''); out.textContent = 'mode: ' + exec.response.mode + '\nduration: ' + (exec.response.duration || 0) + 'ms\n' + (exec.response.warnings && exec.response.warnings.length ? 'warnings: ' + JSON.stringify(exec.response.warnings) + '\n' : '') + '\nheaders: ' + JSON.stringify(exec.response.headers, null, 2) + '\n\nbody:\n' + String(exec.response.body || '').slice(0, 20000); }
    else { status.textContent = 'Failed'; out.textContent = (exec.error && exec.error.code || 'REPLAY_FAILED') + ': ' + (exec.error && exec.error.message || ''); }
    btn.textContent = 'Send'; refreshHistory();
  };
  refreshHistory();
}
function renderReplayHistory() { const items = events.filter(event => event.kind === 'replay').slice().reverse(); rows.innerHTML = items.length ? items.map(event => '<div class="row"><span></span><span class="method">REPLAY</span><span>' + esc(event.status || 0) + '</span><span><b class="host">' + esc(event.url) + '</b><span class="path">' + esc((event.overrides || []).join(', ') || 'captured values') + '</span></span><span class="status">' + esc(event.status || 0) + '</span><span>' + esc(event.timestamp || '') + '</span></div>').join('') : '<div class="empty"><strong>No replay history</strong><span>Replay results will appear here.</span></div>'; }
function renderFindings() { const sessionId = events.find(event => event.sessionId)?.sessionId; rows.innerHTML = '<div class="empty"><strong>Passive findings</strong><span>Run the Python rule engine for this session.</span><button id="run-analysis" class="replay">Run analysis</button><pre id="analysis-result"></pre></div>'; document.querySelector('#run-analysis').onclick = async () => { const result = await window.desktopCapture?.analyzeSession(sessionId); document.querySelector('#analysis-result').textContent = JSON.stringify(result, null, 2); }; }
async function renderSessions() { const sessions = await window.desktopCapture?.listSessions?.() || []; rows.innerHTML = sessions.length ? sessions.slice().reverse().map(session => '<div class="session-row"><div><b>' + esc(session.startedAt ? new Date(session.startedAt).toLocaleString() : session.id.slice(0, 8)) + '</b><span>' + esc(session.requestCount + ' requests') + '</span></div><button data-session="' + esc(session.id) + '">Load</button><button data-export="' + esc(session.id) + '">Journal</button><button data-report="' + esc(session.id) + '">HTML</button><button data-har="' + esc(session.id) + '">HAR</button></div>').join('') : '<div class="empty"><strong>No saved sessions</strong><span>Sessions appear after capture starts.</span></div>'; rows.querySelectorAll('[data-session]').forEach(button => button.onclick = async () => { const loaded = await window.desktopCapture.readSession(button.dataset.session); events.length = 0; events.push(...loaded); selected.clear(); document.querySelector('#view-title').textContent = 'Requests'; render(); }); rows.querySelectorAll('[data-export]').forEach(button => button.onclick = async () => { await window.desktopCapture.exportSession(button.dataset.export); }); rows.querySelectorAll('[data-report]').forEach(button => button.onclick = async () => { await window.desktopCapture.exportSessionReport(button.dataset.report, 'html'); }); rows.querySelectorAll('[data-har]').forEach(button => button.onclick = async () => { await window.desktopCapture.exportSessionReport(button.dataset.har, 'har'); }); }
document.querySelectorAll('.nav').forEach(item => item.onclick = () => { document.querySelectorAll('.nav').forEach(nav => nav.classList.toggle('active', nav === item)); const view = item.dataset.view; if (view === 'replays') { document.querySelector('#view-title').textContent = 'Replay history'; document.querySelector('#view-subtitle').textContent = 'Review previous replay attempts.'; renderReplayHistory(); } else if (view === 'sessions') { document.querySelector('#view-title').textContent = 'Saved sessions'; document.querySelector('#view-subtitle').textContent = 'Load a previous capture session.'; renderSessions(); } else if (view === 'findings') { document.querySelector('#view-title').textContent = 'Findings'; document.querySelector('#view-subtitle').textContent = 'Passive analysis results.'; renderFindings(); } else { document.querySelector('#view-title').textContent = 'Requests'; document.querySelector('#view-subtitle').textContent = 'Select requests to review and replace values.'; render(); } });
document.querySelector('#open').onclick = () => { const target = document.querySelector('#target-url').value.trim(); if (!target) return; const hosts = (document.querySelector('#scope').value || new URL(target).hostname).split(',').map(value => value.trim()).filter(Boolean); window.desktopCapture?.setScope(hosts); window.desktopCapture?.openBrowser(target); try { localStorage.setItem('observatory-target-url', target); localStorage.setItem('observatory-scope', hosts.join(', ')); } catch {} document.querySelector('#status').textContent = 'Capturing'; document.querySelector('#scope-label').textContent = hosts.join(', '); };
document.querySelector('#search').oninput = render;
document.querySelector('#type').onchange = render;
document.querySelector('#select-all').onclick = () => { events.filter(event => event.kind === 'request').forEach(event => selected.add(event.id)); render(); };
document.querySelector('#theme').onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('observatory-theme', next); } catch {} };
const language = document.querySelector('#lang'); const savedLanguage = (() => { try { return localStorage.getItem('observatory-language') || 'vi'; } catch { return 'vi'; } })(); language.value = savedLanguage; applyLanguage(savedLanguage); language.onchange = () => applyLanguage(language.value);
try { document.documentElement.dataset.theme = localStorage.getItem('observatory-theme') || 'light'; } catch {}
// WU1: target selector. Discovered targets (Chrome page / WebView2 / CEF / Android
// WebView) appear here; selecting one binds capture + replay to that target.
const topActions = document.querySelector('.top-actions');
if (topActions) {
  const targetSelect = document.createElement('select');
  targetSelect.id = 'targets';
  targetSelect.title = 'Debug target';
  targetSelect.style.cssText = 'height:28px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--text);font-size:11px;max-width:280px';
  targetSelect.innerHTML = '<option value="">No targets</option>';
  topActions.insertBefore(targetSelect, document.querySelector('#theme'));
  targetSelect.onchange = () => { if (targetSelect.value) window.desktopCapture?.selectTarget(targetSelect.value); };
  const runtimeBadge = { CHROME: 'Chrome', WEBVIEW2: 'WebView2', CEF: 'CEF', ANDROID_WEBVIEW: 'Android WebView', OTHER: 'Target' };
  window.desktopCapture?.onTargetsChanged(list => {
    const current = targetSelect.value;
    if (!list || !list.length) { targetSelect.innerHTML = '<option value="">No targets</option>'; return; }
    targetSelect.innerHTML = list.map(t => '<option value="' + esc(t.cdpTargetId) + '">' + esc((runtimeBadge[t.runtime] || t.runtime) + ' · ' + (t.title || t.url || t.cdpTargetId)) + '</option>').join('');
    if (list.some(t => t.cdpTargetId === current)) targetSelect.value = current;
    document.querySelector('#status').textContent = 'Connected · ' + list.length + ' target' + (list.length > 1 ? 's' : '');
  });
  window.desktopCapture?.onCdpError(err => { document.querySelector('#status').textContent = (err && err.code) || 'CDP error'; });
}
// WU4: minimal live-interception UI (nav view + rule + paused list + editor).
(function setupIntercept() {
  const navEl = document.querySelector('nav');
  if (!navEl) return;
  let interceptOn = false;
  const state = { rule: { host: '', method: '', urlContains: '' } };
  const navBtn = document.createElement('button');
  navBtn.className = 'nav'; navBtn.dataset.view = 'intercept'; navBtn.innerHTML = '⧗ <span>Intercept</span>';
  navEl.appendChild(navBtn);
  navBtn.onclick = () => {
    document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n === navBtn));
    document.querySelector('#view-title').textContent = 'Intercept';
    document.querySelector('#view-subtitle').textContent = 'Pause, edit and continue live requests before they reach the server.';
    renderIntercept();
  };
  function renderIntercept() {
    rows.innerHTML = '<div style="padding:12px;border-bottom:1px solid var(--line);display:grid;gap:8px">'
      + '<div style="display:flex;gap:8px;align-items:center"><button id="intc-toggle" class="row-replace">' + (interceptOn ? 'Intercept: ON' : 'Intercept: OFF') + '</button><span style="color:var(--muted);font-size:10px">selected target only</span></div>'
      + '<input id="intc-host" placeholder="host (optional)" value="' + esc(state.rule.host) + '" style="height:26px">'
      + '<div style="display:flex;gap:8px"><input id="intc-method" placeholder="method (optional)" value="' + esc(state.rule.method) + '" style="height:26px;width:110px"><input id="intc-url" placeholder="url contains (optional)" value="' + esc(state.rule.urlContains) + '" style="height:26px;flex:1"></div>'
      + '</div><div id="paused-list"></div>';
    document.querySelector('#intc-toggle').onclick = async () => {
      state.rule = { host: document.querySelector('#intc-host').value.trim(), method: document.querySelector('#intc-method').value.trim(), urlContains: document.querySelector('#intc-url').value.trim() };
      if (!interceptOn) { const r = await window.desktopCapture?.interceptEnable(state.rule); if (r && r.error) { document.querySelector('#view-subtitle').textContent = r.error.code + ': ' + (r.error.message || ''); return; } interceptOn = true; }
      else { await window.desktopCapture?.interceptDisable(); interceptOn = false; }
      renderIntercept();
    };
    refreshPaused();
  }
  async function refreshPaused(list) {
    const pausedList = document.querySelector('#paused-list'); if (!pausedList) return;
    const paused = list || await window.desktopCapture?.interceptList() || [];
    pausedList.innerHTML = paused.length ? paused.map(p => '<div class="row" data-intc="' + esc(p.id) + '"><span class="method">' + esc(p.draft.method) + '</span><span>' + esc(p.resourceType || '') + '</span><span><b class="host">PAUSED</b><span class="path">' + esc((() => { try { return new URL(p.draft.url).pathname; } catch { return p.draft.url; } })()) + '</span></span><span class="status">⧗</span></div>').join('') : '<div class="empty"><strong>No paused requests</strong><span>Turn intercept ON and trigger a matching request.</span></div>';
    pausedList.querySelectorAll('[data-intc]').forEach(row => { row.onclick = () => openPaused(paused.find(x => x.id === row.dataset.intc)); });
  }
  function openPaused(p) {
    if (!p) return;
    workspace.innerHTML = '<div class="replace"><div class="subtitle">Target ' + esc(p.targetId) + ' · ' + esc(p.resourceType || '') + ' · paused ' + esc(p.pausedAt) + '</div><h2>Paused request</h2>'
      + '<h3>Method &amp; URL</h3><input id="p-method" value="' + esc(p.draft.method) + '" style="width:90px"><input id="p-url" value="' + esc(p.draft.url) + '" style="width:calc(100% - 100px)">'
      + '<h3>Headers (JSON)</h3><textarea id="p-headers" rows="6" style="width:100%">' + esc(JSON.stringify(p.draft.headers, null, 2)) + '</textarea>'
      + '<h3>Body (raw)</h3><textarea id="p-body" rows="6" style="width:100%">' + esc(p.draft.body || '') + '</textarea>'
      + '<div style="display:flex;gap:8px;margin-top:10px"><button class="replay" id="p-continue">Continue</button><button class="replay" id="p-modified">Continue Modified</button><button class="row-replace" id="p-abort">Abort</button></div>'
      + '<div class="response-card"><small>RESULT</small><pre id="p-result"></pre></div></div>';
    const show = r => { document.querySelector('#p-result').textContent = r && r.error ? (r.error.code + ': ' + (r.error.message || '')) : JSON.stringify(r, null, 2); refreshPaused(); };
    document.querySelector('#p-continue').onclick = async () => show(await window.desktopCapture?.interceptContinue(p.id));
    document.querySelector('#p-abort').onclick = async () => show(await window.desktopCapture?.interceptAbort(p.id));
    document.querySelector('#p-modified').onclick = async () => {
      let headers; try { headers = JSON.parse(document.querySelector('#p-headers').value || '{}'); } catch { document.querySelector('#p-result').textContent = 'INVALID_INTERCEPT_DRAFT: headers must be valid JSON'; return; }
      show(await window.desktopCapture?.interceptContinueModified(p.id, { method: document.querySelector('#p-method').value.trim().toUpperCase(), url: document.querySelector('#p-url').value.trim(), headers, body: document.querySelector('#p-body').value }));
    };
  }
  window.desktopCapture?.onInterceptChanged(paused => { if (navBtn.classList.contains('active')) refreshPaused(paused); });
})();
window.desktopCapture?.onEvent(event => { events.push(event); render(); });
render();
