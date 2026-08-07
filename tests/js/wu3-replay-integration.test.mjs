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
const { ReplayEngine } = require('../../desktop/replay/replay-engine.cjs');

function chromePath() {
  const c = [process.env.OBSERVATORY_CHROME,
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  return c.find((p) => existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(80); } return null; }
async function waitEndpoint(host, port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { await CDP.Version({ host, port }); return true; } catch { await sleep(300); } } return false; }

function startServer() {
  const server = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.url === '/save' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => (body += d));
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify({ received: body })); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', ...cors }); res.end('<!doctype html><title>t</title>ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('WU3 replay: WebView-context modified body, HTTP Direct, immutability, history, target-destroyed', async (t) => {
  const chrome = chromePath();
  if (!chrome) { t.skip('Chrome not installed'); return; }

  const { server, port: httpPort } = await startServer();
  const base = `http://127.0.0.1:${httpPort}`;
  const host = '127.0.0.1';
  const cdpPort = 9540 + (process.pid % 120);
  const profile = mkdtempSync(join(tmpdir(), 'wu3-chrome-'));
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore', windowsHide: true });

  let client;
  let targetAlive = true;
  try {
    assert.ok(await waitEndpoint(host, cdpPort), 'chrome up');
    client = await CDP({ host, port: cdpPort });
    const cap = new CaptureCorrelator({ resolveClient: () => (targetAlive ? client : null) });
    const replay = new ReplayEngine({
      getCaptured: (id) => cap.get(id),
      resolveClient: () => (targetAlive ? client : null),
      httpFetch: async (url, opts) => { const r = await fetch(url, { method: opts.method, headers: opts.headers, body: opts.body }); const h = {}; r.headers.forEach((v, k) => (h[k] = v)); return { status: r.status, statusText: r.statusText, headers: h, body: await r.text() }; },
    });
    const { Network, Page, Runtime } = client;
    await Network.enable(); await Page.enable();
    Network.requestWillBeSent((p) => cap.onRequestWillBeSent('T', p));
    Network.requestWillBeSentExtraInfo((p) => cap.onRequestWillBeSentExtraInfo('T', p));
    Network.responseReceived((p) => cap.onResponseReceived('T', p));
    Network.responseReceivedExtraInfo((p) => cap.onResponseReceivedExtraInfo('T', p));
    Network.loadingFinished((p) => cap.onLoadingFinished('T', p));
    Network.loadingFailed((p) => cap.onLoadingFailed('T', p));

    await Page.navigate({ url: base + '/' });
    await sleep(500);
    // Capture an original POST with body {"v":1}
    await Runtime.evaluate({ expression: `fetch('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"v":1}'})`, awaitPromise: true });
    const captured = await waitFor(() => cap.list().find((r) => r.method === 'POST' && r.path === '/save' && r.state === 'BODY_AVAILABLE'));
    assert.ok(captured, 'original POST captured');
    assert.equal(captured.body.raw, '{"v":1}');

    // --- WebView-context replay with MODIFIED body ---
    const draft = replay.createDraft(captured.id, { mode: 'WEBVIEW_CONTEXT' });
    replay.updateDraft(draft.id, { body: '{"v":2}' });
    const exec1 = await replay.execute(draft.id);
    assert.equal(exec1.status, 'COMPLETED', JSON.stringify(exec1.error));
    assert.equal(exec1.response.status, 200);
    assert.equal(JSON.parse(exec1.response.body).received, '{"v":2}', 'server received the MODIFIED body via WebView context');
    assert.equal(exec1.response.mode, 'WEBVIEW_CONTEXT');

    // Captured request is unchanged.
    assert.equal(cap.get(captured.id).body.raw, '{"v":1}', 'CapturedRequest immutable');

    // --- Replay again with a different body -> second execution, nothing overwritten ---
    replay.updateDraft(draft.id, { body: '{"v":3}' });
    const exec2 = await replay.execute(draft.id);
    assert.equal(JSON.parse(exec2.response.body).received, '{"v":3}');
    const hist = replay.history(captured.id);
    assert.equal(hist.executions.length, 2, 'two executions in history');

    // --- HTTP_DIRECT: same ReplayResult contract ---
    const httpDraft = replay.createDraft(captured.id, { mode: 'HTTP_DIRECT' });
    replay.updateDraft(httpDraft.id, { body: '{"v":9}' });
    const execHttp = await replay.execute(httpDraft.id);
    assert.equal(execHttp.status, 'COMPLETED', JSON.stringify(execHttp.error));
    assert.equal(execHttp.response.mode, 'HTTP_DIRECT');
    assert.equal(JSON.parse(execHttp.response.body).received, '{"v":9}');
    for (const k of ['status', 'statusText', 'headers', 'body', 'duration', 'mode']) assert.ok(k in execHttp.response, `http result has ${k}`);

    // --- Target destroyed -> WebView replay returns TARGET_CONTEXT_UNAVAILABLE (never elsewhere) ---
    targetAlive = false;
    const orphan = replay.createDraft(captured.id, { mode: 'WEBVIEW_CONTEXT' });
    const execDead = await replay.execute(orphan.id);
    assert.equal(execDead.status, 'FAILED');
    assert.equal(execDead.error.code, 'TARGET_CONTEXT_UNAVAILABLE');
  } finally {
    try { if (client) await client.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
