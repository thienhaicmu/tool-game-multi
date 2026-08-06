const { app, BrowserWindow, ipcMain, session, protocol, net, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventJournal } = require('./event-journal.cjs');
const { normalizeCaptureEvent } = require('./event-contract.cjs');

let shell;
let detailWindow;
let browserWindow;
let browserSession;
const pending = new Map();
const replayable = new Map();
let allowedHosts = new Set();
let capturePaused = false;
let sessionId = randomUUID();
let journal;
let importStarted = false;

function importJournalOnExit() {
  if (importStarted || !journal) return;
  const database = process.env.OBSERVATORY_DATABASE;
  if (!database) return;
  importStarted = true;
  const python = process.env.OBSERVATORY_PYTHON || 'python';
  const journalPath = path.join(app.getPath('userData'), 'sessions', sessionId + '.jsonl');
  const child = spawn(python, ['-m', 'websec_observer.cli.main', 'import-journal', journalPath, database, sessionId], { cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'ignore' });
  child.unref();
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
  attachCapture();
  shell.loadURL('app://ui/product.html');
}

function openBrowserWindow(url) {
  if (browserWindow && !browserWindow.isDestroyed()) {
    browserWindow.webContents.send('browser-target', url); browserWindow.focus(); return true;
  }
  browserWindow = new BrowserWindow({ width: 1280, height: 860, minWidth: 900, minHeight: 600, title: 'Chromium — Target browser', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, webviewTag: true } });
  browserWindow.loadURL('app://ui/browser.html');
  browserWindow.webContents.once('did-finish-load', () => browserWindow.webContents.send('browser-target', url));
  browserWindow.on('closed', () => { browserWindow = null; });
  return true;
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
app.on('before-quit', importJournalOnExit);
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
