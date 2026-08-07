const { app, BrowserWindow, ipcMain, protocol, net, dialog } = require('electron');
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
const { InterceptEngine } = require('./cdp/intercept.cjs');
const { ReplayEngine } = require('./replay/replay-engine.cjs');
const { CdpError } = require('./cdp/errors.cjs');

let shell;
let detailWindow;
let chromeProcess;
let targetManager = null;
let selectedTargetId = null;
const capturedClients = new WeakSet();
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

function createWindow() {
  shell = new BrowserWindow({ width: 1500, height: 950, minWidth: 1100, minHeight: 700, backgroundColor: '#f4f6f8', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true } });
  const journalPath = path.join(app.getPath('userData'), 'sessions', sessionId + '.jsonl');
  journal = new EventJournal(journalPath);
  importTimer = setInterval(importJournalNow, 10_000);
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
function resolveTargetClient(targetId) { const s = targetManager && targetManager.getSession(targetId); return s ? s.client : null; }
const capture = new CaptureCorrelator({ resolveClient: resolveTargetClient });
// WU4: live request interception (Fetch domain), target-bound.
const intercept = new InterceptEngine({ resolveClient: resolveTargetClient });
intercept.on('changed', () => { if (shell && !shell.isDestroyed()) shell.webContents.send('intercept-changed', intercept.listPaused()); });
// WU3: replay is driven from the immutable CapturedRequest held by `capture`.
const replay = new ReplayEngine({
  getCaptured: id => capture.get(id),
  resolveClient: resolveTargetClient,
  httpFetch: async (url, opts) => {
    const response = await net.fetch(url, { method: opts.method, headers: opts.headers, body: ['GET', 'HEAD'].includes(opts.method) ? undefined : opts.body });
    const text = await response.text();
    const headers = {}; response.headers.forEach((v, k) => { headers[k] = v; });
    return { status: response.status, statusText: response.statusText, headers, body: text };
  },
});
// Bridge raw model -> the existing display/journal pipeline (which may mask
// secrets for display only; raw evidence stays in `capture`).
capture.on('request', req => {
  let origin = '/';
  try { origin = new URL(req.url).origin + '/'; } catch { /* opaque */ }
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
  // Fetch events only fire once intercept.enable() calls Fetch.enable on this
  // client; harmless to subscribe always.
  client.Fetch.requestPaused(p => intercept.onRequestPaused(tid, p));
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
  manager.on('target-removed', id => { intercept.onTargetDetached(id); if (selectedTargetId === id) selectedTargetId = null; broadcastTargets(); });
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
// WU3: replay lifecycle. Draft duplicates an immutable CapturedRequest; execute
// runs it in the request's OWN target (WEBVIEW_CONTEXT) or via HTTP_DIRECT.
ipcMain.handle('replay-create-draft', (_event, capturedRequestId, options = {}) => replay.createDraft(String(capturedRequestId), options));
ipcMain.handle('replay-update-draft', (_event, draftId, patch = {}) => replay.updateDraft(String(draftId), patch));
ipcMain.handle('replay-execute', (_event, draftId) => replay.execute(String(draftId)));
ipcMain.handle('replay-history', (_event, capturedRequestId) => replay.history(String(capturedRequestId)));
// WU4 intercept IPC. Default scope is the selected target only.
ipcMain.handle('intercept-enable', (_event, rule = {}, targetId) => intercept.enable(String(targetId || selectedTargetId || ''), rule || {}));
ipcMain.handle('intercept-disable', (_event, targetId) => intercept.disable(String(targetId || selectedTargetId || '')));
ipcMain.handle('intercept-list', () => intercept.listPaused());
ipcMain.handle('intercept-update-draft', (_event, id, patch = {}) => intercept.updateDraft(String(id), patch));
ipcMain.handle('intercept-continue', (_event, id) => intercept.continue(String(id)));
ipcMain.handle('intercept-continue-modified', (_event, id, patch) => intercept.continueModified(String(id), patch));
ipcMain.handle('intercept-abort', (_event, id) => intercept.abort(String(id)));
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
