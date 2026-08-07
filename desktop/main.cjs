const { app, BrowserWindow, ipcMain, session, protocol, net, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { execFile } = require('node:child_process');
const { EventJournal } = require('./event-journal.cjs');
const { normalizeCaptureEvent } = require('./event-contract.cjs');
const CDP = require('chrome-remote-interface');
const { TargetManager } = require('./cdp/target-manager.cjs');
const androidBridge = require('./cdp/android-bridge.cjs');
const { CaptureCorrelator } = require('./cdp/capture.cjs');
const { CdpError } = require('./cdp/errors.cjs');

let shell;
let detailWindow;
let chromeProcess;
let targetManager = null;
let selectedTargetId = null;
const capturedClients = new WeakSet();
let browserSession;
const pending = new Map();
const replayable = new Map();
let allowedHosts = new Set();
let capturePaused = false;
let sessionId = randomUUID();
let journal;
let importStarted = false;
let importInProgress = false;
let importTimer;

function importJournalOnExit() {
  if (importStarted || !journal) return null;
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database) return null;
  importStarted = true;
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  const journalPath = path.join(app.getPath('userData'), 'sessions', sessionId + '.jsonl');
  return spawn(python, ['-m', 'websec_observer.cli.main', 'import-journal', journalPath, database, sessionId], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'ignore' });
}

function importJournalNow() {
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database || importInProgress || !journal) return;
  importInProgress = true;
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  const journalPath = path.join(app.getPath('userData'), 'sessions', sessionId + '.jsonl');
  const child = spawn(python, ['-m', 'websec_observer.cli.main', 'import-journal', journalPath, database, sessionId], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'ignore' });
  child.once('close', () => { importInProgress = false; });
  child.once('error', () => { importInProgress = false; });
}

function inScope(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    return allowedHosts.size === 0 || [...allowedHosts].some(pattern => pattern === host || (pattern.startsWith('*.') && host.endsWith(pattern.slice(1))));
  } catch { return false; }
}
function safeDisplayUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) if (/token|secret|password|key|session|auth/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    url.username = ''; url.password = '';
    return url.toString();
  } catch { return '[REDACTED URL]'; }
}
function safeBody(uploadData) {
  try {
    const raw = (uploadData || []).map(part => part.bytes ? Buffer.from(part.bytes).toString('utf8') : '').join('').slice(0, 20000);
    return raw.replace(/(password|passwd|token|secret|authorization|cookie|api[_-]?key|private[_-]?key)\s*([:=])\s*(["']?)[^,"'&\s}]+\3/ig, '$1$2[REDACTED]').slice(0, 4000);
  } catch { return '[REDACTED]'; }
}
function safeHeaders(headers) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) output[key] = /authorization|cookie|token|secret|api[-_]?key|password/i.test(key) ? '[REDACTED]' : String(value).slice(0, 1000);
  return output;
}

function emit(event) {
  const normalized = normalizeCaptureEvent(event, sessionId);
  if (!normalized) return;
  try { journal?.append(normalized); } catch { /* journal failure must not stop capture */ }
  if (shell && !shell.isDestroyed()) shell.webContents.send('capture-event', normalized);
}

function attachCapture() {
  browserSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (details.url.startsWith('file:') || details.url.includes('127.0.0.1:5173')) { callback({}); return; }
    if (capturePaused) { callback({}); return; }
    const id = details.id + ':' + randomUUID();
    replayable.set(id, { method: details.method, url: details.url, uploadData: details.uploadData || [] });
    if (replayable.size > 200) replayable.delete(replayable.keys().next().value);
    pending.set(details.id, { id, started: Date.now(), url: details.url });
    const allowed = inScope(details.url);
    emit({ kind: 'request', id, requestId: String(details.id), method: details.method, url: allowed ? safeDisplayUrl(details.url) : new URL(details.url).origin + '/', resourceType: details.resourceType, scope: allowed ? 'allow_full' : 'allow_metadata_only', bodyPreview: allowed ? safeBody(details.uploadData) : null, headers: {}, timestamp: new Date().toISOString() });
    callback({});
  });
  browserSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const pendingRequest = pending.get(details.id);
    const item = pendingRequest ? replayable.get(pendingRequest.id) : [...replayable.values()].find(value => value.url === details.url && value.method === details.method);
    if (item) { item.headers = details.requestHeaders; emit({ kind: 'request-headers', id: item.id, headers: inScope(details.url) ? safeHeaders(details.requestHeaders) : {} }); }
    callback({ requestHeaders: details.requestHeaders });
  });
  browserSession.webRequest.onCompleted(details => {
    const item = pending.get(details.id); if (!item) return; pending.delete(details.id);
    const allowed = inScope(item.url);
    emit({ kind: 'response', id: item.id, requestId: String(details.id), url: allowed ? safeDisplayUrl(item.url) : new URL(item.url).origin + '/', status: details.statusCode, duration: Date.now() - item.started, timestamp: new Date().toISOString() });
  });
  browserSession.webRequest.onErrorOccurred(details => {
    const item = pending.get(details.id); if (!item) return; pending.delete(details.id);
    emit({ kind: 'response', id: item.id, requestId: String(details.id), url: item.url, status: 0, error: details.error, duration: Date.now() - item.started, timestamp: new Date().toISOString() });
  });
}

function createWindow() {
  shell = new BrowserWindow({ width: 1500, height: 950, minWidth: 1100, minHeight: 700, backgroundColor: '#f4f6f8', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true } });
  browserSession = session.fromPartition('persist:observatory-browser');
  const journalPath = path.join(app.getPath('userData'), 'sessions', sessionId + '.jsonl');
  journal = new EventJournal(journalPath);
  importTimer = setInterval(importJournalNow, 10_000);
  attachCapture();
  shell.loadURL('app://ui/product.html');
}

function openBrowserWindow(url) {
  const candidates = [process.env.OBSERVATORY_CHROME, process.env.CHROME_PATH, path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'), path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) return false;
  const cdpPort = Number(process.env.OBSERVATORY_CDP_PORT || 9222);
  if (chromeProcess && !chromeProcess.killed) { connectEndpointWithRetry({ port: cdpPort }); return true; }
  const profile = process.env.OBSERVATORY_CHROME_PROFILE || path.join(app.getPath('userData'), 'chrome-profile');
  chromeProcess = spawn(executable, [`--remote-debugging-port=${process.env.OBSERVATORY_CDP_PORT || 9222}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--new-window', url], { detached: true, windowsHide: false, stdio: 'ignore' });
  chromeProcess.unref(); chromeProcess.once('exit', () => { chromeProcess = null; });
  connectEndpointWithRetry({ port: cdpPort });
  return true;
}

// Newly launched Chrome needs ~1s before its CDP endpoint answers; retry connect.
async function connectEndpointWithRetry(endpoint, attempt = 0) {
  const result = await connectEndpoint(endpoint);
  if (!result.ok && attempt < 12) { setTimeout(() => connectEndpointWithRetry(endpoint, attempt + 1), 1000); }
  return result;
}

// Shared correlator: holds RAW evidence (unredacted) for all attached targets and
// resolves response bodies through each request's OWN target client.
const capture = new CaptureCorrelator({
  resolveClient: targetId => { const s = targetManager && targetManager.getSession(targetId); return s ? s.client : null; },
});
// Bridge raw model -> the existing display/journal pipeline (which may mask
// secrets for display only; raw evidence stays in `capture`).
capture.on('request', req => {
  let origin = '/';
  try { origin = new URL(req.url).origin + '/'; } catch { /* opaque */ }
  replayable.set(req.id, { targetId: req.targetId, method: req.method, url: req.url, uploadData: req.body && req.body.raw != null ? [{ bytes: Buffer.from(req.body.raw) }] : [], headers: req.headers || {} });
  if (replayable.size > 1000) replayable.delete(replayable.keys().next().value);
  const allowed = inScope(req.url);
  emit({ kind: 'request', id: req.id, requestId: req.cdpRequestId, targetId: req.targetId, method: req.method, url: allowed ? safeDisplayUrl(req.url) : origin, resourceType: String(req.resourceType || 'other').toLowerCase(), scope: allowed ? 'allow_full' : 'allow_metadata_only', headers: allowed ? safeHeaders(req.headers) : {}, bodyPreview: allowed ? String((req.body && req.body.raw) || '').slice(0, 4000) : null, timestamp: req.startedAt });
});
capture.on('response', req => { if (!req.response) return; emit({ kind: 'response', id: req.id, requestId: req.cdpRequestId, targetId: req.targetId, url: safeDisplayUrl(req.url), status: req.response.status, duration: Math.round(req.durationMs || 0), timestamp: new Date().toISOString() }); });
capture.on('update', req => { if (req.state === 'BODY_AVAILABLE' && req.response) emit({ kind: 'response', id: req.id, requestId: req.cdpRequestId, targetId: req.targetId, url: safeDisplayUrl(req.url), status: req.response.status, duration: Math.round(req.durationMs || 0), timestamp: new Date().toISOString() }); });

// WU2: attach full network capture to a target's own CDP client and route every
// event through the shared correlator, tagged with this target's id.
async function attachCdpCapture(client, target) {
  if (capturedClients.has(client)) return;
  capturedClients.add(client);
  const { Network } = client;
  const tid = target.cdpTargetId;
  try { await Network.enable(); } catch { return; }
  Network.requestWillBeSent(p => capture.onRequestWillBeSent(tid, p));
  Network.requestWillBeSentExtraInfo(p => capture.onRequestWillBeSentExtraInfo(tid, p));
  Network.responseReceived(p => capture.onResponseReceived(tid, p));
  Network.responseReceivedExtraInfo(p => capture.onResponseReceivedExtraInfo(tid, p));
  Network.loadingFinished(p => capture.onLoadingFinished(tid, p));
  Network.loadingFailed(p => capture.onLoadingFailed(tid, p));
}

function broadcastTargets() {
  if (shell && !shell.isDestroyed() && targetManager) shell.webContents.send('targets-changed', targetManager.listTargets());
}

async function connectEndpoint({ host = '127.0.0.1', port = 9222, runtimeHint = null } = {}) {
  if (targetManager) { try { await targetManager.stop(); } catch { /* ignore */ } targetManager = null; selectedTargetId = null; }
  const manager = new TargetManager({ host, port, runtimeHint });
  manager.on('attached', ({ target, client }) => {
    if (!selectedTargetId) selectedTargetId = target.cdpTargetId; // auto-select first attachable target
    attachCdpCapture(client, target);
    broadcastTargets();
  });
  manager.on('target-added', broadcastTargets);
  manager.on('target-updated', broadcastTargets);
  manager.on('target-removed', id => { if (selectedTargetId === id) selectedTargetId = null; broadcastTargets(); });
  manager.on('error', err => { if (shell && !shell.isDestroyed()) shell.webContents.send('cdp-error', err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) }); });
  try {
    await manager.start();
    targetManager = manager;
    broadcastTargets();
    return { ok: true, targets: manager.listTargets() };
  } catch (err) {
    return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err && err.message || err) } };
  }
}

function selectedClient() {
  if (!targetManager || !selectedTargetId) return null;
  const session = targetManager.getSession(selectedTargetId);
  return session ? session.client : null;
}

function openDetailWindow(payload) {
  if (detailWindow && !detailWindow.isDestroyed()) { detailWindow.focus(); detailWindow.webContents.send('detail-data', payload); return; }
  detailWindow = new BrowserWindow({ width: 620, height: 760, minWidth: 480, minHeight: 520, title: 'Request Detail', parent: shell, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  detailWindow.loadURL('app://ui/request-detail.html');
  detailWindow.webContents.once('did-finish-load', () => detailWindow.webContents.send('detail-data', payload));
  detailWindow.on('closed', () => { detailWindow = null; });
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('app', (request, callback) => {
    const pathname = new URL(request.url).pathname.replace(/^\/+/, '');
    callback({ path: path.join(__dirname, '..', 'ui', pathname === 'ui/desktop.html' ? 'desktop.html' : pathname) });
  });
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (importTimer) clearInterval(importTimer);
  if (importStarted) return;
  const child = importJournalOnExit();
  if (!child) return;
  event.preventDefault();
  child.once('close', () => app.quit());
  child.once('error', () => app.quit());
});
ipcMain.handle('scope-set', (_event, hosts) => { allowedHosts = new Set((hosts || []).map(String).map(x => x.toLowerCase())); return true; });
ipcMain.on('open-request-detail', (_event, payload) => openDetailWindow(payload));
ipcMain.handle('open-browser', (_event, url) => openBrowserWindow(String(url)));
ipcMain.handle('list-sessions', () => {
  const dir = path.join(app.getPath('userData'), 'sessions');
  try { return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => { const id = name.slice(0, -6); const file = path.join(dir, name); const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); const events = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); return { id, file: name, startedAt: events[0]?.timestamp || events[0]?.journaledAt || null, requestCount: events.filter(event => event.kind === 'request').length }; }); } catch { return []; }
});
ipcMain.handle('read-session', (_event, id) => {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) return [];
  const file = path.join(app.getPath('userData'), 'sessions', String(id) + '.jsonl');
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
});
ipcMain.handle('export-session', async (_event, id) => {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) return { ok: false, error: 'Invalid session id' };
  const source = path.join(app.getPath('userData'), 'sessions', String(id) + '.jsonl');
  if (!fs.existsSync(source)) return { ok: false, error: 'Session not found' };
  const choice = await dialog.showSaveDialog(shell, { defaultPath: `observatory-${id}.jsonl`, filters: [{ name: 'Session journal', extensions: ['jsonl'] }] });
  if (choice.canceled || !choice.filePath) return { ok: false, error: 'Export canceled' };
  fs.copyFileSync(source, choice.filePath); return { ok: true, path: choice.filePath };
});
ipcMain.handle('export-session-report', async (_event, id, format = 'html') => {
  if (!/^[a-f0-9-]{36}$/i.test(String(id))) return { ok: false, error: 'Invalid session id' };
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database) return { ok: false, error: 'OBSERVATORY_DATABASE is not configured' };
  const extension = format === 'har' ? 'har' : format === 'json' ? 'json' : 'html';
  const choice = await dialog.showSaveDialog(shell, { defaultPath: `observatory-${id}.${extension}`, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
  if (choice.canceled || !choice.filePath) return { ok: false, error: 'Export canceled' };
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  const args = format === 'har' ? ['-m', 'websec_observer.cli.main', 'export', database, id, '--format', 'har'] : ['-m', 'websec_observer.cli.main', 'report', database, id, '--format', format, '--output', choice.filePath];
  return await new Promise(resolve => { execFile(python, args, { cwd: path.join(__dirname, '..'), windowsHide: true }, (error, stdout, stderr) => { if (error) resolve({ ok: false, error: String(stderr || error.message) }); else if (format === 'har') { fs.writeFileSync(choice.filePath, stdout, 'utf8'); resolve({ ok: true, path: choice.filePath }); } else resolve({ ok: true, path: choice.filePath }); }); });
});
ipcMain.handle('analyze-session', async (_event, id) => {
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database || !/^[a-f0-9-]{36}$/i.test(String(id))) return { ok: false, error: 'Analysis requires database and valid session id' };
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  return await new Promise(resolve => execFile(python, ['-m', 'websec_observer.cli.main', 'analyze', database, id], { cwd: path.join(__dirname, '..'), windowsHide: true }, (error, stdout, stderr) => error ? resolve({ ok: false, error: String(stderr || error.message) }) : resolve({ ok: true, output: stdout }))); 
});
// WU3 Mode A foundation: WebView-context replay runs inside the captured target's
// OWN client. We resolve the request's target (falling back to the selected one)
// so the fetch executes in the correct WebView, never a default page.
ipcMain.handle('browser-replay', async (_event, id, payload = {}) => {
  const captured = replayable.get(id);
  const targetId = payload.targetId || captured?.targetId || selectedTargetId;
  const session = targetManager && targetId ? targetManager.getSession(targetId) : null;
  const client = session ? session.client : selectedClient();
  if (!client) return { ok: false, error: { code: 'TARGET_CONTEXT_UNAVAILABLE', message: 'The WebView that produced this request is no longer attached. Reconnect or choose another target.' } };
  try {
    const expression = `(async()=>{const r=await fetch(${JSON.stringify(payload.url)},${JSON.stringify({ method: payload.method || 'GET', headers: payload.headers || {}, body: ['GET','HEAD'].includes(payload.method || 'GET') ? undefined : payload.body, credentials: 'include' })});return {ok:true,status:r.status,statusText:r.statusText,bodyPreview:(await r.text()).slice(0,4000)}})()`;
    const result = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
    return result.result?.value || { ok: false, error: { code: 'REPLAY_FAILED', message: 'No replay result returned by the WebView' } };
  } catch (error) { return { ok: false, error: { code: 'REPLAY_FAILED', message: String(error.message || error) } }; }
});
ipcMain.handle('get-response-body', (_event, capturedId) => capture.getResponseBody(String(capturedId)));
ipcMain.handle('get-request-detail', (_event, capturedId) => { const r = capture.get(String(capturedId)); return r || { error: { code: 'REQUEST_NOT_FOUND' } }; });
ipcMain.handle('cdp-connect', (_event, endpoint = {}) => connectEndpoint(endpoint));
ipcMain.handle('list-targets', () => targetManager ? targetManager.listTargets() : []);
ipcMain.handle('select-target', (_event, id) => {
  if (!targetManager) return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'Not connected to a CDP endpoint' } };
  const session = targetManager.getSession(id);
  if (!session) return { ok: false, error: { code: 'TARGET_NOT_FOUND', message: 'Target is no longer available' } };
  selectedTargetId = String(id);
  return { ok: true, selectedTargetId };
});
ipcMain.handle('adb-list-webviews', async () => {
  try { return { ok: true, sockets: await androidBridge.listWebviewSockets(process.env.OBSERVATORY_ADB || 'adb') }; }
  catch (err) { return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) } }; }
});
ipcMain.handle('adb-forward-webview', async (_event, socket, localPort = 9223) => {
  try {
    const endpoint = await androidBridge.forwardSocket(process.env.OBSERVATORY_ADB || 'adb', localPort, String(socket));
    return await connectEndpoint(endpoint);
  } catch (err) { return { ok: false, error: err instanceof CdpError ? err.toJSON() : { code: 'CDP_ENDPOINT_UNAVAILABLE', message: String(err) } }; }
});
ipcMain.handle('capture-toggle', (_event, paused) => { capturePaused = Boolean(paused); return capturePaused; });
ipcMain.handle('replay-request', async (_event, id, overrides = {}) => {
  const item = replayable.get(id);
  if (!item) return { ok: false, error: 'Request expired from memory' };
  const target = new URL(item.url);
  if (!inScope(item.url)) return { ok: false, error: 'Target is outside current scope' };
  const method = String(overrides.method || item.method).toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { ok: false, error: 'Method is not allowed' };
  const url = new URL(String(overrides.url || item.url));
  if (url.hostname.toLowerCase() !== target.hostname.toLowerCase()) return { ok: false, error: 'Replay host must match captured host' };
  const headers = { ...(item.headers || {}), ...(overrides.headers || {}) };
  delete headers.host; delete headers['content-length']; delete headers.connection;
  const body = overrides.body !== undefined ? String(overrides.body) : (item.uploadData && item.uploadData.length ? Buffer.concat(item.uploadData.map(part => part.bytes ? Buffer.from(part.bytes) : Buffer.alloc(0))) : undefined);
  try {
    const response = await net.fetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body });
    const text = await response.text();
    const result = { ok: true, status: response.status, statusText: response.statusText, bodyPreview: text.slice(0, 4000) };
    emit({ kind: 'replay', id: String(id), method, url: safeDisplayUrl(url.toString()), status: response.status, overrides: Object.keys(overrides), timestamp: new Date().toISOString() });
    return result;
  } catch (error) {
    const message = String(error.message || error);
    emit({ kind: 'replay', id: String(id), method, url: safeDisplayUrl(url.toString()), status: 0, error: message, overrides: Object.keys(overrides), timestamp: new Date().toISOString() });
    return { ok: false, error: message };
  }
});
