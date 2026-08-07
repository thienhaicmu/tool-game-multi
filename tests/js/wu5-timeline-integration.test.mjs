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
const { InterceptEngine } = require('../../desktop/cdp/intercept.cjs');
const { Timeline } = require('../../desktop/timeline.cjs');

function chromePath() {
  const c = [process.env.OBSERVATORY_CHROME,
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  return c.find((p) => existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(70); } return null; }
async function waitEndpoint(host, port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { await CDP.Version({ host, port }); return true; } catch { await sleep(300); } } return false; }

function startServer() {
  const server = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (req.method === 'POST' && req.url === '/api') {
      let body = ''; req.on('data', (d) => (body += d));
      req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify({ received: body, xdebug: req.headers['x-debug'] || null })); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', ...cors }); res.end('<!doctype html><title>t</title>ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function fire(client, expr) { return client.Runtime.evaluate({ expression: `(${expr}).then(()=>{}).catch(()=>{})` }); }

test('WU5 timeline aggregates capture + replays + intercept with correct diffs', async (t) => {
  const chrome = chromePath();
  if (!chrome) { t.skip('Chrome not installed'); return; }
  const { server, port: httpPort } = await startServer();
  const base = `http://127.0.0.1:${httpPort}`;
  const host = '127.0.0.1';
  const cdpPort = 9740 + (process.pid % 120);
  const profile = mkdtempSync(join(tmpdir(), 'wu5-chrome-'));
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore', windowsHide: true });

  let client;
  try {
    assert.ok(await waitEndpoint(host, cdpPort), 'chrome up');
    client = await CDP({ host, port: cdpPort });
    const clients = { A: client };
    const cap = new CaptureCorrelator({ resolveClient: (t2) => clients[t2] || null });
    const intercept = new InterceptEngine({ resolveClient: (t2) => clients[t2] || null, timeoutMs: 8000 });
    const replay = new ReplayEngine({
      getCaptured: (id) => cap.get(id), resolveClient: (t2) => clients[t2] || null,
      httpFetch: async (url, opts) => { const r = await fetch(url, { method: opts.method, headers: opts.headers, body: opts.body }); const h = {}; r.headers.forEach((v, k) => (h[k] = v)); return { status: r.status, statusText: r.statusText, headers: h, body: await r.text() }; },
    });
    const timeline = new Timeline({ capture: cap, replay, intercept });

    const { Network, Page } = client;
    await Network.enable(); await Page.enable();
    Network.requestWillBeSent((p) => cap.onRequestWillBeSent('A', p));
    Network.responseReceived((p) => cap.onResponseReceived('A', p));
    Network.loadingFinished((p) => cap.onLoadingFinished('A', p));
    Network.loadingFailed((p) => cap.onLoadingFailed('A', p));
    client.Fetch.requestPaused((p) => intercept.onRequestPaused('A', p));

    await Page.navigate({ url: base + '/' });
    await sleep(500);

    // 1) Enable intercept, fire a request, modify the header, continue -> WU2 captures it.
    assert.ok((await intercept.enable('A', { urlContains: '/api' })).ok);
    await fire(client, `fetch('/api',{method:'POST',headers:{'Content-Type':'application/json','X-Debug':'original'},body:'{"v":1}'})`);
    const rec = await waitFor(() => intercept.listPaused().find((p) => p.targetId === 'A'));
    assert.ok(rec, 'request paused');
    await intercept.continueModified(rec.id, { headers: { 'Content-Type': 'application/json', 'X-Debug': 'modified' } });

    const captured = await waitFor(() => cap.list().find((r) => r.method === 'POST' && r.cdpRequestId === rec.networkRequestId && r.state === 'BODY_AVAILABLE'));
    assert.ok(captured, 'intercepted request was captured (linked by networkId)');
    assert.equal(captured.body.raw, '{"v":1}', 'capture holds the ORIGINAL body, not the modified one (honest CDP behavior)');

    // 2) Replay it twice with different bodies.
    const draft = replay.createDraft(captured.id, { mode: 'HTTP_DIRECT' });
    await replay.execute(draft.id);                       // v1
    replay.updateDraft(draft.id, { body: '{"v":2}' });
    await replay.execute(draft.id);                       // v2

    // 3) Timeline for this one request should contain all evidence.
    const tl = timeline.build(captured.id);
    assert.equal(tl.summary.replayed, 2);
    assert.equal(tl.summary.intercepted, 1, 'intercept linked to this captured request');

    const kinds = tl.events.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['capture', 'intercept', 'replay', 'replay'], 'all evidence present');

    const interceptEv = tl.events.find((e) => e.kind === 'intercept');
    assert.equal(interceptEv.requestDiff.headers.changed.find((h) => h.name.toLowerCase() === 'x-debug').to, 'modified', 'intercept diff shows header change');

    const replayV2 = tl.events.find((e) => e.kind === 'replay' && e.requestDiff && e.requestDiff.body.changed);
    assert.ok(replayV2, 'a replay shows a body change');
    assert.equal(replayV2.requestDiff.body.changes.find((c) => c.path === 'v').to, 2);
    assert.equal(replayV2.status, 200, 'replay got a real response');

    // Original evidence unchanged after all of the above.
    assert.equal(cap.get(captured.id).body.raw, '{"v":1}', 'captured evidence immutable');
  } finally {
    try { if (client) await client.close(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
