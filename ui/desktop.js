const browser = document.querySelector('#browser');
const empty = document.querySelector('#empty');
const urlInput = document.querySelector('#url');
const eventsEl = document.querySelector('#events');
const countEl = document.querySelector('#count');
const statusEl = document.querySelector('#status');
const scopeInput = document.createElement('input');
scopeInput.id = 'scope'; scopeInput.placeholder = 'Scope: app.local, api.local, *.cdn.com'; scopeInput.spellcheck = false;
scopeInput.style.cssText = 'width:230px;flex:0 0 230px;padding:8px;border:1px solid #38505b;border-radius:4px;background:#20343e;color:#fff';
document.querySelector('#url').style.cssText += ';min-width:260px';
try { scopeInput.value = localStorage.getItem('observatory-scope') || ''; } catch { scopeInput.value = ''; }
document.querySelector('.address').insertBefore(scopeInput, document.querySelector('#open'));
const allEvents = [];
const marked = new Set();
let currentTab = 'network';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function hostPath(raw) { try { const u = new URL(raw); return { host: u.host, path: u.pathname + (u.search ? u.search : '') }; } catch { return { host: '', path: raw }; } }
function openTarget() {
  let value = urlInput.value.trim(); if (!value) return;
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;
  try { const u = new URL(value); const scopeText = scopeInput.value.trim() || u.hostname; scopeInput.value = scopeText; try { localStorage.setItem('observatory-scope', scopeText); } catch {} const hosts = scopeText.split(',').map(x => x.trim().toLowerCase()).filter(Boolean); window.desktopCapture?.setScope(hosts); } catch { return; }
  window.desktopCapture?.openBrowser(value); browser.classList.remove('open'); empty.style.display = 'grid'; statusEl.textContent = 'Capturing external browser'; document.querySelector('#session-name').textContent = new URL(value).hostname;
}
function renderEvents() {
  const query = document.querySelector('#search').value.toLowerCase(); const type = document.querySelector('#type').value;
  const rows = allEvents.filter(e => e.kind === 'request').filter(e => type === 'all' || e.resourceType === type).filter(e => !query || (e.url + e.method).toLowerCase().includes(query));
  countEl.textContent = rows.length;
  if (!rows.length) { eventsEl.innerHTML = '<div class="empty-small">Waiting for browser traffic…</div>'; return; }
  eventsEl.innerHTML = rows.slice().reverse().map(e => { const p = hostPath(e.url); const response = allEvents.find(x => x.kind === 'response' && x.id === e.id); return '<div class="event ' + (marked.has(e.id) ? 'marked' : '') + '" data-id="' + e.id + '"><span class="method">' + e.method + '</span><span>' + (e.resourceType === 'fetch' || e.resourceType === 'xhr' ? '<b class="tag">API</b>' : esc(e.resourceType)) + '</span><span><b class="host">' + esc(p.host) + '</b><br><span class="path">' + esc(p.path) + '</span></span><span class="status">' + (response ? response.status : '…') + '</span><span class="scope ' + (e.scope === 'allow_metadata_only' ? 'meta' : '') + '">' + (e.scope === 'allow_metadata_only' ? 'metadata' : 'in scope') + '</span><span class="time">' + (response ? response.duration + ' ms' : 'pending') + '</span></div>'; }).join('');
  document.querySelectorAll('.event').forEach(row => row.onclick = () => showDetail(row.dataset.id));
}
function showDetail(id) {
  const request = allEvents.find(e => e.kind === 'request' && e.id === id); const response = allEvents.find(e => e.kind === 'response' && e.id === id); if (!request) return;
  showReplacePanel(request, response); return;
  // Keep selected request in the main workspace so it can be reviewed/replaced without hiding the network list.
  const p = hostPath(request.url); const overlay = document.createElement('div'); overlay.className = 'detail-overlay'; overlay.innerHTML = '<button class="close-detail">Close</button><button class="close-detail" id="copy-curl">Copy redacted cURL</button><button class="close-detail" id="replay-request">Replay request</button><button class="close-detail" id="mark-request">' + (marked.has(id) ? 'Unmark review' : 'Mark for review') + '</button><div class="eyebrow">REQUEST DETAIL</div><h2>' + esc(request.method) + ' ' + esc(p.path) + '</h2><p>' + esc(p.host) + ' · ' + esc(request.resourceType) + ' · ' + esc(request.scope) + '</p><h3>General</h3><div class="scope-row"><b>URL</b><span class="mono">' + esc(request.url) + '</span></div><div class="scope-row"><b>Status</b><span>' + (response ? response.status : 'pending') + '</span></div><div class="scope-row"><b>Duration</b><span>' + (response ? response.duration + ' ms' : 'pending') + '</span></div><h3>Request headers</h3><div class="mono">' + esc(JSON.stringify(request.headers || {}, null, 2)) + '</div><h3>Request body preview</h3><div class="mono">' + esc(request.bodyPreview || '(empty or not captured)') + '</div><h3>Replay</h3><div class="mono">Replay is explicit, same-host and in-memory only.</div><pre id="replay-result" class="mono"></pre>';
  document.querySelector('.browser-wrap').appendChild(overlay); overlay.querySelector('.close-detail').onclick = () => overlay.remove(); overlay.querySelector('#mark-request').onclick = () => { marked.has(id) ? marked.delete(id) : marked.add(id); overlay.remove(); renderEvents(); }; overlay.querySelector('#copy-curl').onclick = async () => { await navigator.clipboard.writeText('curl -X ' + request.method + ' "' + request.url + '" -H "Authorization: [REDACTED]"'); overlay.querySelector('#copy-curl').textContent = 'Copied'; }; overlay.querySelector('#replay-request').onclick = async () => { if (!window.confirm('Replay this request to the same in-scope host?')) return; const replacementUrl = window.prompt('Optional replacement URL (same host only):', request.url); if (replacementUrl === null) return; const body = ['GET', 'HEAD'].includes(request.method) ? undefined : window.prompt('Optional replacement request body (leave blank to use captured body):', ''); const result = await window.desktopCapture?.replay(id, { url: replacementUrl, ...(body === null ? {} : { body }) }); overlay.querySelector('#replay-result').textContent = JSON.stringify(result, null, 2); };
}
function showReplacePanel(request, response) {
  document.querySelector('.detail-overlay')?.remove();
  const panel = document.createElement('div'); panel.className = 'detail-overlay replace-panel';
  panel.insertAdjacentHTML('afterbegin', '<style>.replace-panel{padding:28px 34px;background:#f6f8f9}.replace-panel h2{font-size:20px;margin:8px 0 22px;color:#17323b}.replace-panel h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#65767d;margin:22px 0 10px;border:0}.replace-panel input,.replace-panel textarea{border:1px solid #d5e0e3;border-radius:8px;background:#fff;color:#20343d;font:13px system-ui;padding:10px;box-shadow:0 1px 2px #102a3510}.replace-panel label{background:#fff;border:1px solid #e0e8ea;border-radius:8px;padding:8px 10px!important}.replace-panel .close-detail{background:#fff;border:1px solid #d5e0e3}.replace-panel #replace-send{border:0;border-radius:8px;padding:11px 18px;font-weight:700;float:none;cursor:pointer}.replace-panel #replace-result{margin-top:16px}.replace-panel .eyebrow{color:#0b9e89;font-weight:700}</style>');
  let parsed; try { parsed = new URL(request.url); } catch { parsed = null; }
  const params = parsed ? [...parsed.searchParams.entries()] : [];
  const body = request.bodyPreview || '';
  let bodyFields = [];
  try { const json = JSON.parse(body); if (json && typeof json === 'object' && !Array.isArray(json)) bodyFields = Object.entries(json); } catch {}
  panel.innerHTML = '<button class="close-detail" id="replace-close">Close</button><div class="eyebrow">REQUEST REPLACE</div><h2>' + esc(request.method + ' ' + (parsed?.pathname || request.url)) + '</h2><h3>URL</h3><input id="replace-url" style="width:100%;padding:9px" value="' + esc(request.url) + '"><h3>Query parameters</h3><div id="query-fields">' + (params.length ? params.map((p,i) => '<label style="display:flex;gap:8px;margin:6px 0;align-items:center"><input class="param-key" value="' + esc(p[0]) + '" style="width:25%"><input class="param-value" data-index="' + i + '" value="' + esc(p[1]) + '" style="flex:1"></label>').join('') : '<div class="empty-small">No query parameters</div>') + '</div><h3>Body parameters (JSON)</h3><div id="body-fields">' + (bodyFields.length ? bodyFields.map((p,i) => '<label style="display:flex;gap:8px;margin:6px 0;align-items:center"><span style="width:25%">' + esc(p[0]) + '</span><input class="body-value" data-key="' + esc(p[0]) + '" value="' + esc(typeof p[1] === 'string' ? p[1] : JSON.stringify(p[1])) + '" style="flex:1"></label>').join('') : '<textarea id="replace-body" style="width:100%;min-height:100px">' + esc(body) + '</textarea>') + '</div><h3>Replay</h3><button id="replace-send" class="close-detail" style="float:none;background:#0b9e89;color:#fff">Replay replaced request</button><pre id="replace-result" class="mono"></pre>';
  document.querySelector('.browser-wrap').appendChild(panel);
  panel.querySelector('#replace-close').onclick = () => panel.remove();
  panel.querySelector('#replace-send').onclick = async () => { let url = panel.querySelector('#replace-url').value; try { const u = new URL(url); panel.querySelectorAll('.param-value').forEach((el,i) => { const key = panel.querySelectorAll('.param-key')[i].value; u.searchParams.set(key, el.value); }); url = u.toString(); } catch {} const overrides = { url }; const fields = panel.querySelectorAll('.body-value'); if (fields.length) { const obj = {}; fields.forEach(el => { try { obj[el.dataset.key] = JSON.parse(el.value); } catch { obj[el.dataset.key] = el.value; } }); overrides.body = JSON.stringify(obj); } else if (panel.querySelector('#replace-body')) overrides.body = panel.querySelector('#replace-body').value; const result = await window.desktopCapture?.replay(request.id, overrides); panel.querySelector('#replace-result').textContent = JSON.stringify(result, null, 2); };
}
document.querySelector('#open').onclick = openTarget; document.querySelector('#empty-open').onclick = openTarget;
document.querySelector('#reload').onclick = () => browser.reload(); document.querySelector('#back').onclick = () => browser.goBack(); document.querySelector('#forward').onclick = () => browser.goForward();
document.querySelector('#search').oninput = renderEvents; document.querySelector('#type').onchange = renderEvents;
const controls = document.createElement('div'); controls.className = 'capture-controls'; controls.innerHTML = '<button id="pause-capture">Pause capture</button><button id="clear-events">Clear</button><button id="export-events">Export JSON</button>'; document.querySelector('.inspect-head').prepend(controls);
let paused = false;
document.querySelector('#pause-capture').onclick = async () => { paused = !paused; await window.desktopCapture?.setPaused(paused); document.querySelector('#pause-capture').textContent = paused ? 'Resume capture' : 'Pause capture'; statusEl.textContent = paused ? 'Paused' : 'Capturing'; };
document.querySelector('#clear-events').onclick = () => { allEvents.length = 0; marked.clear(); renderEvents(); };
document.querySelector('#export-events').onclick = () => { const blob = new Blob([JSON.stringify(allEvents, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'observatory-session.json'; link.click(); URL.revokeObjectURL(link.href); };
document.querySelectorAll('.tab').forEach(tab => tab.onclick = () => { currentTab = tab.dataset.tab; document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab)); document.querySelector('#inspect-title').textContent = currentTab === 'network' ? 'Live Network' : currentTab === 'findings' ? 'Findings' : 'Scope policy'; });
if (window.desktopCapture) window.desktopCapture.onEvent(event => { if (event.kind === 'request-headers') { const request = allEvents.find(item => item.kind === 'request' && item.id === event.id); if (request) request.headers = event.headers; } else allEvents.push(event); renderEvents(); statusEl.textContent = 'Capturing · ' + allEvents.filter(x => x.kind === 'request').length + ' requests'; });
browser.addEventListener('did-fail-load', event => { if (event.isMainFrame) statusEl.textContent = 'Load failed'; });
browser.addEventListener('did-start-loading', () => { statusEl.textContent = 'Loading'; });
browser.addEventListener('did-stop-loading', () => { statusEl.textContent = 'Capturing'; });
browser.addEventListener('did-fail-load', event => { if (event.isMainFrame) { statusEl.textContent = 'Load failed: ' + (event.errorDescription || event.errorCode); empty.style.display = 'grid'; } });
