const { app, BrowserWindow, ipcMain, session, protocol, net } = require('electron');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

let shell;
let browserSession;
const pending = new Map();
const replayable = new Map();
let allowedHosts = new Set();
let capturePaused = false;

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
  if (shell && !shell.isDestroyed()) shell.webContents.send('capture-event', event);
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
    const item = [...replayable.values()].find(value => value.url === details.url && value.method === details.method);
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
  attachCapture();
  shell.loadURL('app://ui/desktop.html');
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('app', (request, callback) => {
    const pathname = new URL(request.url).pathname.replace(/^\/+/, '');
    callback({ path: path.join(__dirname, '..', 'ui', pathname === 'ui/desktop.html' ? 'desktop.html' : pathname) });
  });
  createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
ipcMain.handle('scope-set', (_event, hosts) => { allowedHosts = new Set((hosts || []).map(String).map(x => x.toLowerCase())); return true; });
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
    return { ok: true, status: response.status, statusText: response.statusText, bodyPreview: text.slice(0, 4000) };
  } catch (error) { return { ok: false, error: String(error.message || error) }; }
});
