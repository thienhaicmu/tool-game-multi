const events = [];
const selected = new Set();
const rows = document.querySelector('#requests');
const workspace = document.querySelector('#workspace');
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
    return '<div class="row ' + (selected.has(event.id) ? 'selected' : '') + '" data-id="' + esc(event.id) + '"><input type="checkbox" ' + (selected.has(event.id) ? 'checked' : '') + '><span class="method">' + esc(event.method) + '</span><span>' + esc(event.resourceType) + '</span><span><b class="host">' + esc(info.url?.host || '') + '</b><span class="path">' + esc(info.path) + '</span></span><span class="status">' + esc(response?.status || '…') + '</span><span>' + esc(event.scope === 'allow_metadata_only' ? 'metadata' : 'in scope') + '</span></div>';
  }).join('');
  rows.querySelectorAll('.row').forEach(row => row.onclick = event => { if (event.target.tagName === 'INPUT') { event.stopPropagation(); row.querySelector('input').checked ? selected.add(row.dataset.id) : selected.delete(row.dataset.id); row.classList.toggle('selected', selected.has(row.dataset.id)); return; } openWorkspace(row.dataset.id); });
}
function openWorkspace(id) {
  const request = events.find(event => event.kind === 'request' && event.id === id); if (!request) return;
  const info = urlInfo(request.url); if (!info.url) return;
  const params = [...info.url.searchParams.entries()];
  workspace.innerHTML = '<div class="replace"><div class="subtitle">' + esc(request.method) + ' · ' + esc(info.url.host) + '</div><h2>Replace request values</h2><p class="subtitle">Only values can be changed. Request identity stays fixed.</p><h3>Query parameters</h3>' + (params.length ? params.map(pair => '<div class="param"><label>' + esc(pair[0]) + '</label><input data-kind="query" data-key="' + esc(pair[0]) + '" value="' + esc(pair[1]) + '"></div>').join('') : '<div class="subtitle">No query parameters</div>') + '<button class="replay" id="replay">Replay request</button><pre id="result"></pre></div>';
  document.querySelector('#replay').onclick = async () => { const replacement = new URL(request.url); workspace.querySelectorAll('[data-kind="query"]').forEach(input => replacement.searchParams.set(input.dataset.key, input.value)); const result = await window.desktopCapture?.replay(request.id, { url: replacement.toString() }); document.querySelector('#result').textContent = JSON.stringify(result, null, 2); };
}
document.querySelector('#open').onclick = () => window.desktopCapture?.openBrowser('https://staging.example.com');
document.querySelector('#search').oninput = render;
document.querySelector('#type').onchange = render;
document.querySelector('#select-all').onclick = () => { events.filter(event => event.kind === 'request').forEach(event => selected.add(event.id)); render(); };
document.querySelector('#theme').onclick = () => { const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('observatory-theme', next); } catch {} };
window.desktopCapture?.onEvent(event => { events.push(event); render(); });
render();
