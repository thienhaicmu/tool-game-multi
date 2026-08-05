const state = {
  view: "overview",
  selected: null,
  query: "",
  filter: "all",
  requests: [
    { id: "r1", method: "GET", host: "staging.example.com", path: "/", status: 200, type: "document", duration: 184, size: "18.2 KB", action: "Page navigation", url: "https://staging.example.com/" },
    { id: "r2", method: "POST", host: "api-staging.example.com", path: "/api/auth/login", status: 200, type: "fetch", duration: 311, size: "2.1 KB", action: "Click · Sign in", url: "https://api-staging.example.com/api/auth/login" },
    { id: "r3", method: "GET", host: "api-staging.example.com", path: "/api/user/profile", status: 200, type: "xhr", duration: 92, size: "8.6 KB", action: "Click · Sign in", url: "https://api-staging.example.com/api/user/profile" },
    { id: "r4", method: "GET", host: "payments.example-third-party.com", path: "/", status: 200, type: "script", duration: 126, size: "42 KB", action: "Page navigation", url: "https://payments.example-third-party.com/" },
    { id: "r5", method: "GET", host: "api-staging.example.com", path: "/api/permissions", status: 200, type: "fetch", duration: 74, size: "1.8 KB", action: "Click · Sign in", url: "https://api-staging.example.com/api/permissions" },
    { id: "r6", method: "GET", host: "api-staging.example.com", path: "/socket", status: 101, type: "websocket", duration: 34, size: "—", action: "Click · Sign in", url: "wss://api-staging.example.com/socket" }
  ],
  findings: [
    { id: "f1", title: "Access token exposed in URL query", category: "Authentication", severity: "High", confidence: "Confirmed", endpoint: "GET /oauth/callback?access_token=[REDACTED]", text: "A token-shaped query parameter was directly observed in a request URL." },
    { id: "f2", title: "Session cookie missing HttpOnly", category: "Cookie security", severity: "Medium", confidence: "High", endpoint: "staging.example.com /", text: "An observed session-like cookie did not include HttpOnly." },
    { id: "f3", title: "Security headers missing", category: "Security headers", severity: "Medium", confidence: "High", endpoint: "GET /", text: "CSP and Referrer-Policy were not observed on the document response." },
    { id: "f4", title: "Sensitive data in response body", category: "Sensitive data", severity: "High", confidence: "High", endpoint: "GET /api/user/profile", text: "The response contains a token-shaped field. Value was redacted." },
    { id: "f5", title: "Potential authorization review required", category: "Authorization", severity: "High", confidence: "Low", endpoint: "GET /api/users/{id}", text: "Object identifiers are present in an API response path." },
    { id: "f6", title: "Missing HSTS", category: "Transport security", severity: "Low", confidence: "High", endpoint: "GET /", text: "No Strict-Transport-Security header was observed." }
  ],
  actions: [
    { time: "14:32:08.221", name: "Click · Sign in", sub: "button#sign-in · /login", count: 4 },
    { time: "14:31:55.804", name: "Form submit", sub: "form#login · /login", count: 1 },
    { time: "14:31:49.112", name: "Page navigation", sub: "staging.example.com/login", count: 1 },
    { time: "14:31:42.607", name: "Click · Products", sub: "nav a[href='/products']", count: 7 }
  ]
};

const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const app = document.querySelector("#app");
const title = document.querySelector("#page-title");

function metric(label, value, trend, bad = false) {
  return '<div class="metric"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="trend ' + (bad ? "bad" : "") + '">' + trend + '</div></div>';
}
function badge(type) {
  return '<span class="tag ' + (type === "fetch" || type === "xhr" ? "api" : type === "websocket" ? "ws" : "") + '">' + type + '</span>';
}
function requestRows(rows) {
  return rows.map(r => '<tr class="clickable" data-request="' + r.id + '"><td><span class="method">' + r.method + '</span></td><td><span class="host">' + esc(r.host) + '</span></td><td><span class="path">' + esc(r.path) + '</span></td><td><span class="status">' + r.status + '</span></td><td>' + badge(r.type) + '</td><td class="mono">' + r.duration + ' ms</td><td class="mono">' + r.size + '</td><td>' + esc(r.action) + '</td></tr>').join("");
}
function networkTable(rows) {
  return '<div class="panel network-panel"><div class="panel-head"><div class="panel-title">Live network</div><div class="filters"><input id="network-search" class="search" placeholder="Search host or path..." value="' + esc(state.query) + '"><select id="network-filter" class="filter"><option value="all">All types</option><option value="fetch">Fetch</option><option value="xhr">XHR</option><option value="websocket">WebSocket</option></select></div></div><div class="table-wrap"><table><thead><tr><th>Method</th><th>Host</th><th>Path</th><th>Status</th><th>Type</th><th>Duration</th><th>Size</th><th>Action</th></tr></thead><tbody>' + requestRows(rows) + '</tbody></table></div></div>';
}
function findingsList(items) {
  return items.map(f => '<div class="finding"><div class="finding-icon">△</div><div class="finding-body"><div class="finding-title">' + esc(f.title) + '</div><div class="finding-meta">' + esc(f.category) + ' · ' + esc(f.confidence) + ' · ' + esc(f.endpoint) + '</div></div><span class="severity-badge ' + f.severity.toLowerCase() + '">' + f.severity + '</span></div>').join("");
}
function overview() {
  const rows = state.requests.slice(0, 5);
  return '<div class="content"><div class="grid metrics">' +
    metric("REQUESTS", "128", "↑ 18 since last session") + metric("API ENDPOINTS", "34", "↑ 6 discovered") +
    metric("FINDINGS", "6", "2 high severity", true) + metric("HOSTS", "4", "1 outside scope", true) + metric("ERROR RATE", "1.6%", "↓ 0.4% vs baseline") +
    '</div><div class="grid split"><div class="panel"><div class="panel-head"><div class="panel-title">Traffic over session</div><button class="panel-link" data-view-link="network">View network →</button></div><div class="chart"><div class="bar" style="height:36%"><span>14:20</span></div><div class="bar" style="height:58%"><span>14:24</span></div><div class="bar" style="height:42%"><span>14:28</span></div><div class="bar hot" style="height:84%"><span>14:32</span></div><div class="bar" style="height:66%"><span>14:36</span></div><div class="bar" style="height:50%"><span>14:40</span></div><div class="bar" style="height:73%"><span>14:44</span></div><div class="bar" style="height:46%"><span>14:48</span></div></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Findings by severity</div><button class="panel-link" data-view-link="findings">View all →</button></div><div class="severity-list"><div class="sev-row"><span><i class="dot critical"></i>Critical</span><div class="track"><div class="fill critical" style="width:0%"></div></div><b>0</b></div><div class="sev-row"><span><i class="dot high"></i>High</span><div class="track"><div class="fill high" style="width:62%"></div></div><b>3</b></div><div class="sev-row"><span><i class="dot medium"></i>Medium</span><div class="track"><div class="fill medium" style="width:42%"></div></div><b>2</b></div><div class="sev-row"><span><i class="dot low"></i>Low</span><div class="track"><div class="fill low" style="width:22%"></div></div><b>1</b></div></div></div></div>' +
    networkTable(rows) + '</div>';
}
function networkView() {
  const filtered = state.requests.filter(r => (state.filter === "all" || r.type === state.filter) && (state.query === "" || (r.host + r.path).toLowerCase().includes(state.query.toLowerCase())));
  return '<div class="content">' + networkTable(filtered) + '</div>';
}
function findingsView() {
  const filtered = state.findings.filter(f => state.filter === "all" || f.severity.toLowerCase() === state.filter);
  return '<div class="content"><div class="panel"><div class="panel-head"><div><div class="panel-title">Security findings</div><div class="muted">Passive signals from the current authorized session</div></div><div class="filters"><select id="finding-filter" class="filter"><option value="all">All severity</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></div></div>' + findingsList(filtered) + '</div></div>';
}
function actionsView() {
  return '<div class="content"><div class="panel"><div class="panel-head"><div><div class="panel-title">Action timeline</div><div class="muted">Requests correlated in a −2s / +8s window</div></div><span class="tag">4 actions</span></div>' + state.actions.map(a => '<div class="action-line"><div class="action-time">' + a.time + '</div><div class="action-dot"></div><div><div class="action-name">' + a.name + ' <span class="tag">' + a.count + ' requests</span></div><div class="action-sub">' + a.sub + '</div></div></div>').join("") + '</div></div>';
}
function scopeView() {
  return '<div class="content"><div class="grid scope-grid"><div class="panel"><div class="panel-head"><div class="panel-title">Scope policy</div><span class="tag">PASSIVE ONLY</span></div><div class="scope-row"><span>Base URL</span><b class="mono">https://staging.example.com</b></div><div class="scope-row"><span>Allowed hosts</span><b>2 hosts</b></div><div class="scope-row"><span>Denied hosts</span><b>2 hosts</b></div><div class="scope-row"><span>Active validation</span><span class="switch"></span></div><div class="scope-row"><span>Third-party traffic</span><b class="amber">metadata only</b></div></div><div class="panel"><div class="panel-head"><div class="panel-title">Allowed hosts</div><button class="panel-link">Edit policy</button></div><div class="code">staging.example.com<br>api-staging.example.com<br><br><span style="color:#dc8d89">DENIED</span><br>payments.example-third-party.com<br>analytics.example-third-party.com</div></div></div></div>';
}
function requestDetail(id) {
  const r = state.requests.find(item => item.id === id);
  return '<div class="content"><button class="panel-link" id="back-network">← Back to network</button><div class="detail" style="margin-top:15px"><div class="panel"><div class="panel-head"><div><div class="panel-title"><span class="method">' + r.method + '</span> ' + esc(r.path) + '</div><div class="muted">' + esc(r.url) + '</div></div>' + badge(r.type) + '</div><div class="scope-row"><span>Status</span><b class="status">' + r.status + ' OK</b></div><div class="scope-row"><span>Duration</span><b>' + r.duration + ' ms</b></div><div class="scope-row"><span>Related action</span><b>' + esc(r.action) + '</b></div><h3>Request headers</h3><div class="code">accept: application/json<br>authorization: [REDACTED]<br>x-request-id: 8f3c…</div><h3>Response body</h3><div class="code">{<br>  \"user\": \"analyst\",<br>  \"permissions\": [\"read\", \"write\"],<br>  \"token\": \"[REDACTED]\"<br>}</div></div><div class="panel"><div class="panel-head"><div class="panel-title">Findings</div></div>' + findingsList(state.findings.filter(f => f.endpoint.includes(r.path)).slice(0, 2)) + '<div class="empty" style="display:' + (state.findings.some(f => f.endpoint.includes(r.path)) ? "none" : "block") + '">No finding attached</div></div></div></div>';
}
function render() {
  const labels = { overview: "Overview", network: "Live Network", findings: "Findings", actions: "Actions", scope: "Scope & policy" };
  title.textContent = labels[state.view];
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.view === state.view));
  app.innerHTML = state.selected ? requestDetail(state.selected) : state.view === "overview" ? overview() : state.view === "network" ? networkView() : state.view === "findings" ? findingsView() : state.view === "actions" ? actionsView() : scopeView();
  bind();
}
function bind() {
  document.querySelectorAll("[data-view-link]").forEach(b => b.onclick = () => { state.view = b.dataset.viewLink; render(); });
  document.querySelectorAll("[data-request]").forEach(row => row.onclick = () => { state.selected = row.dataset.request; render(); });
  document.querySelector("#back-network")?.addEventListener("click", () => { state.selected = null; state.view = "network"; render(); });
  document.querySelector("#network-search")?.addEventListener("input", e => { state.query = e.target.value; render(); const input = document.querySelector("#network-search"); input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  document.querySelector("#network-filter")?.addEventListener("change", e => { state.filter = e.target.value; render(); });
  document.querySelector("#finding-filter")?.addEventListener("change", e => { state.filter = e.target.value; render(); });
}
document.querySelectorAll(".nav-item").forEach(n => n.onclick = () => { state.view = n.dataset.view; state.selected = null; state.query = ""; state.filter = "all"; render(); });
document.querySelector("#refresh").onclick = () => { document.querySelector("#refresh").textContent = "✓"; setTimeout(() => document.querySelector("#refresh").textContent = "↻", 900); };
render();
