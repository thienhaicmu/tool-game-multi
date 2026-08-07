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

function chromePath() {
  const c = [process.env.OBSERVATORY_CHROME,
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  return c.find((p) => existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = pred(); if (v) return v; await sleep(80); }
  return null;
}
async function waitEndpoint(host, port, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { await CDP.Version({ host, port }); return true; } catch { await sleep(300); } }
  return false;
}

function startServer() {
  const server = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/final', ...cors }); res.end(); return; }
    if (req.url === '/final') { res.writeHead(200, { 'content-type': 'text/plain', ...cors }); res.end('FINAL-OK'); return; }
    if (req.url === '/empty') { res.writeHead(204, cors); res.end(); return; }
    if (req.url === '/binary') { res.writeHead(200, { 'content-type': 'application/octet-stream', ...cors }); res.end(Buffer.from([0, 1, 2, 3, 4, 255])); return; }
    if (req.url === '/echo' && req.method === 'POST') {
      let body = ''; req.on('data', (d) => (body += d));
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes', ...cors }); res.end(JSON.stringify({ method: req.method, received: body, ct: req.headers['content-type'] })); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', ...cors }); res.end('<!doctype html><title>t</title>ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

test('WU2 full capture against real Chrome + local server', async (t) => {
  const chrome = chromePath();
  if (!chrome) { t.skip('Chrome not installed'); return; }

  const { server, port: httpPort } = await startServer();
  const base = `http://127.0.0.1:${httpPort}`;
  const host = '127.0.0.1';
  const cdpPort = 9420 + (process.pid % 120);
  const profile = mkdtempSync(join(tmpdir(), 'wu2-chrome-'));
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore', windowsHide: true });

  let client;
  try {
    assert.ok(await waitEndpoint(host, cdpPort), 'chrome CDP up');
    client = await CDP({ host, port: cdpPort });
    const cap = new CaptureCorrelator({ resolveClient: () => client }); // single real target 'T'
    const { Network, Page, Runtime } = client;
    await Network.enable(); await Page.enable();
    Network.requestWillBeSent((p) => cap.onRequestWillBeSent('T', p));
    Network.requestWillBeSentExtraInfo((p) => cap.onRequestWillBeSentExtraInfo('T', p));
    Network.responseReceived((p) => cap.onResponseReceived('T', p));
    Network.responseReceivedExtraInfo((p) => cap.onResponseReceivedExtraInfo('T', p));
    Network.loadingFinished((p) => cap.onLoadingFinished('T', p));
    Network.loadingFailed((p) => cap.onLoadingFailed('T', p));

    // Load app content same-origin so subsequent fetches are not cross-origin.
    await Page.navigate({ url: base + '/' });
    await sleep(600);

    // POST JSON
    await Runtime.evaluate({ expression: `fetch('/echo',{method:'POST',headers:{'Content-Type':'application/json','X-Test':'42'},body:JSON.stringify({hello:'world'})})`, awaitPromise: true });
    // Redirect (follow) -> two hops
    await Runtime.evaluate({ expression: `fetch('/redirect').then(r=>r.text())`, awaitPromise: true });
    // 204 empty
    await Runtime.evaluate({ expression: `fetch('/empty')`, awaitPromise: true });
    // binary
    await Runtime.evaluate({ expression: `fetch('/binary').then(r=>r.arrayBuffer())`, awaitPromise: true });
    // failure (connection refused)
    await Runtime.evaluate({ expression: `fetch('http://127.0.0.1:1/x').catch(()=>{})` });
    await sleep(700);

    // --- POST /echo ---
    const echo = await waitFor(() => cap.list().find((r) => r.method === 'POST' && r.path === '/echo' && r.state === 'BODY_AVAILABLE'));
    assert.ok(echo, 'POST /echo captured & finished');
    assert.equal(echo.body.raw, JSON.stringify({ hello: 'world' }), 'request body exact (no reserialize)');
    assert.ok(echo.headers['Content-Type'] || echo.headers['content-type'], 'request content-type header present');
    assert.ok(echo.response.headers['content-type'], 'response headers present');
    assert.equal(echo.response.headers['x-echo'], 'yes');
    assert.ok(echo.durationMs > 0, 'timing derived, not hardcoded 0');
    const body = await cap.getResponseBody(echo.id); // through the captured target client
    assert.ok(body.available);
    const parsed = JSON.parse(body.body);
    assert.equal(parsed.received, JSON.stringify({ hello: 'world' }), 'server saw exact body; body fetched via captured client');

    // --- Redirect chain: two linked hops ---
    const hop0 = await waitFor(() => cap.list().find((r) => r.path === '/redirect'));
    const hop1 = await waitFor(() => cap.list().find((r) => r.path === '/final'));
    assert.ok(hop0 && hop1, 'both redirect hops captured');
    assert.equal(hop0.response.status, 302, 'first hop keeps 302 evidence');
    assert.equal(hop1.response.status, 200);
    assert.equal(hop1.redirectFromId, hop0.id, 'hops linked');

    // --- 204 empty ---
    const empty = await waitFor(() => cap.list().find((r) => r.path === '/empty' && r.response));
    assert.ok(empty, '204 captured'); assert.equal(empty.response.status, 204);

    // --- binary ---
    const bin = await waitFor(() => cap.list().find((r) => r.path === '/binary' && r.state === 'BODY_AVAILABLE'));
    assert.ok(bin, 'binary captured');
    const binBody = await cap.getResponseBody(bin.id);
    assert.equal(binBody.base64Encoded, true, 'binary returned as base64, not utf-8');

    // --- failed request ---
    const failed = await waitFor(() => cap.list().find((r) => r.state === 'FAILED'));
    assert.ok(failed, 'failed request stays inspectable');
    assert.ok(failed.failure.errorText, 'errorText populated');
  } finally {
    try { if (client) await client.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
