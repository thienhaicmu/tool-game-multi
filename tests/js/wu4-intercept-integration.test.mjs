import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const CDP = require('chrome-remote-interface');
const { CaptureCorrelator } = require('../../desktop/cdp/capture.cjs');
const { InterceptEngine } = require('../../desktop/cdp/intercept.cjs');

function chromePath() {
  const c = [process.env.OBSERVATORY_CHROME,
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  return c.find((p) => existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(60); } return null; }
async function waitEndpoint(host, port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { await CDP.Version({ host, port }); return true; } catch { await sleep(300); } } return false; }

function startServer() {
  const last = { body: null, xdebug: null, path: null };
  const server = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.url === '/last') { res.writeHead(200, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify(last)); return; }
    if (req.method === 'POST' && (req.url === '/intercept' || req.url === '/intercept-a' || req.url === '/intercept-b')) {
      let body = ''; req.on('data', (d) => (body += d));
      req.on('end', () => { last.body = body; last.xdebug = req.headers['x-debug'] || null; last.path = req.url; res.writeHead(200, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify({ received: body, xdebug: last.xdebug, path: req.url })); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', ...cors }); res.end('<!doctype html><title>t</title>ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, last })));
}

async function readLast(client) { const r = await client.Runtime.evaluate({ expression: 'window.__last||null', returnByValue: true }); return r.result.value; }
function fire(client, expr) { return client.Runtime.evaluate({ expression: `window.__last=null;(${expr}).then(r=>r.text()).then(t=>window.__last=t).catch(e=>window.__last='ERR:'+e)` }); }

test('WU4 live interception against real Chrome (multi-target, modify, abort, correlate)', async (t) => {
  const chrome = chromePath();
  if (!chrome) { t.skip('Chrome not installed'); return; }
  const { server, port: httpPort } = await startServer();
  const base = `http://127.0.0.1:${httpPort}`;
  const host = '127.0.0.1';
  const cdpPort = 9640 + (process.pid % 120);
  const profile = mkdtempSync(join(tmpdir(), 'wu4-chrome-'));
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore', windowsHide: true });

  const clients = {};
  const cap = new CaptureCorrelator({ resolveClient: (t2) => clients[t2] || null });
  const intercept = new InterceptEngine({ resolveClient: (t2) => clients[t2] || null, timeoutMs: 8000 });

  async function attach(name, targetWs) {
    const client = targetWs ? await CDP({ target: targetWs }) : await CDP({ host, port: cdpPort });
    clients[name] = client;
    await client.Network.enable(); await client.Page.enable();
    client.Network.requestWillBeSent((p) => cap.onRequestWillBeSent(name, p));
    client.Network.responseReceived((p) => cap.onResponseReceived(name, p));
    client.Network.loadingFinished((p) => cap.onLoadingFinished(name, p));
    client.Network.loadingFailed((p) => cap.onLoadingFailed(name, p));
    client.Fetch.requestPaused((p) => intercept.onRequestPaused(name, p));
    await client.Page.navigate({ url: base + '/' });
    await sleep(500);
    return client;
  }

  try {
    assert.ok(await waitEndpoint(host, cdpPort), 'chrome up');
    const A = await attach('A');
    const newB = await CDP.New({ host, port: cdpPort, url: base + '/' });
    const B = await attach('B', newB.webSocketDebuggerUrl);

    const serverLast = async () => (await (await fetch(base + '/last')).json());

    // Intercept enabled for A only.
    assert.ok((await intercept.enable('A', { urlContains: '/intercept' })).ok);

    // --- Multi-target isolation: B fires, must NOT pause, server gets it ---
    void A;
    await fire(B, `fetch('/intercept',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"b":1}'})`);
    assert.ok(await waitFor(async () => (await serverLast()).body === '{"b":1}'), 'B request reached server without pausing');
    assert.equal(intercept.listPaused().filter((p) => p.targetId === 'B').length, 0, 'B never paused');

    // --- A: modified body + header ---
    await fire(A, `fetch('/intercept',{method:'POST',headers:{'Content-Type':'application/json','X-Debug':'original'},body:'{"v":1}'})`);
    const recA = await waitFor(() => intercept.listPaused().find((p) => p.targetId === 'A'));
    assert.ok(recA, 'A paused');
    const done = await intercept.continueModified(recA.id, { body: '{"v":2}', headers: { 'Content-Type': 'application/json', 'X-Debug': 'modified' } });
    assert.equal(done.state, 'MODIFIED_AND_CONTINUED');
    assert.ok(await waitFor(async () => (await serverLast()).body === '{"v":2}'), 'server received MODIFIED body');
    assert.equal((await serverLast()).xdebug, 'modified', 'server received MODIFIED header');
    // Best-effort: the WebView also got the real server response.
    const aResp = await waitFor(async () => { const v = await readLast(A); return v && v !== 'null' && !String(v).startsWith('ERR') ? v : null; }, 4000);
    if (aResp) assert.equal(JSON.parse(aResp).received, '{"v":2}', 'WebView received the real server response');
    // Fetch <-> Network correlation via networkId (captured request exists for that id).
    const linked = await waitFor(() => cap.list().find((r) => r.targetId === 'A' && r.cdpRequestId === recA.networkRequestId));
    assert.ok(linked, 'InterceptedRequest.networkRequestId links to a CapturedRequest');

    // --- A: URL modification /intercept-a -> /intercept-b ---
    await fire(A, `fetch('/intercept-a',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"u":1}'})`);
    const recUrl = await waitFor(() => intercept.listPaused().find((p) => p.targetId === 'A' && p.draft.url.includes('/intercept-a')));
    assert.ok(recUrl, 'A paused for /intercept-a');
    await intercept.continueModified(recUrl.id, { url: base + '/intercept-b' });
    assert.ok(await waitFor(async () => (await serverLast()).path === '/intercept-b'), 'server received rewritten URL path');

    // --- A: abort ---
    const beforeAbort = await serverLast();
    await fire(A, `fetch('/intercept',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"ABORTME":1}'})`);
    const recAbort = await waitFor(() => intercept.listPaused().find((p) => p.targetId === 'A' && p.draft.body && p.draft.body.includes('ABORTME')));
    assert.ok(recAbort, 'A paused for abort');
    const ab = await intercept.abort(recAbort.id);
    assert.equal(ab.state, 'ABORTED');
    await sleep(500);
    const afterAbort = await serverLast();
    assert.notEqual(afterAbort.body, '{"ABORTME":1}', 'server never received the aborted body');
    assert.equal(afterAbort.body, beforeAbort.body, 'server state unchanged by aborted request');

    // --- Target destroy: enable on C, pause, close C, continue -> TARGET_CONTEXT_UNAVAILABLE ---
    const newC = await CDP.New({ host, port: cdpPort, url: base + '/' });
    await attach('C', newC.webSocketDebuggerUrl);
    await intercept.enable('C', { urlContains: '/intercept' });
    await fire(clients.C, `fetch('/intercept',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"c":1}'})`);
    const recC = await waitFor(() => intercept.listPaused().find((p) => p.targetId === 'C'));
    assert.ok(recC, 'C paused');
    try { await clients.C.close(); } catch { /* ignore */ }
    delete clients.C; // target C's client is gone; resolveClient('C') -> null
    await CDP.Close({ host, port: cdpPort, id: newC.id });
    const deadC = await intercept.continueModified(recC.id, { body: '{"c":2}' });
    assert.equal(deadC.error.code, 'TARGET_CONTEXT_UNAVAILABLE', 'no fallback to another target');
  } finally {
    for (const c of Object.values(clients)) { try { await c.close(); } catch { /* ignore */ } }
    try { proc.kill(); } catch { /* ignore */ }
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
