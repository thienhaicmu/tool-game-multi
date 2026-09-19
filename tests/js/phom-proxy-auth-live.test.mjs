// §52 — the proxy-auth handler against a REAL Chrome and a REAL proxy that demands credentials (407).
// The handler was marked "RUNTIME-UNVERIFIED — no authorized authenticated proxy available", and live it never
// answered: Chromium was launched straight onto the game URL, the first request hit the proxy's 407 before the
// tool's CDP connection existed, and Chromium showed its own "Sign in" dialog. This test proves the fixed order:
// start on about:blank → bind the handler on the page's own client → only then navigate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const CDP = require('chrome-remote-interface');
const { bindProxyAuth } = require('../../desktop/browser-run/proxy-auth-handler.cjs');

function chromePath() {
  const c = [process.env.OBSERVATORY_CHROME,
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  return c.find((p) => existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(80); } return null; }
async function waitEndpoint(host, port, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { await CDP.Version({ host, port }); return true; } catch { await sleep(300); } } return false; }

const USER = 'phomuser', PASS = 'phom-secret-pw';

// The site behind the proxy.
function startOrigin() {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>t</title><body>OK-PROXIED</body>'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
// A forward HTTP proxy that REQUIRES Basic credentials — exactly what a paid proxy does (407 until answered).
function startAuthProxy() {
  const seen = { challenged: 0, authorized: 0, badCreds: 0 };
  const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const server = http.createServer((req, res) => {
    const auth = req.headers['proxy-authorization'];
    if (!auth) { seen.challenged++; res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="phom-test"' }); res.end('auth required'); return; }
    if (auth !== expected) { seen.badCreds++; res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="phom-test"' }); res.end('bad credentials'); return; }
    seen.authorized++;
    const target = new URL(req.url); // absolute-form request line from the browser
    const up = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  // HTTPS / WSS go through a CONNECT tunnel — the path the real game (https + wss) uses. Same 407 rule.
  const CRLF = '\r\n';
  server.on('connect', (req, sock) => {
    const auth = req.headers['proxy-authorization'];
    if (auth !== expected) {
      seen.connectChallenged = (seen.connectChallenged || 0) + 1;
      sock.end(['HTTP/1.1 407 Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="phom-test"', 'Content-Length: 0', '', ''].join(CRLF));
      return;
    }
    seen.connectAuthorized = (seen.connectAuthorized || 0) + 1;
    // the credentials on the CONNECT are what we are proving; no TLS origin is needed behind it
    sock.end(['HTTP/1.1 502 Bad Gateway', 'Content-Length: 0', '', ''].join(CRLF));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

// Each Chrome in this file gets its OWN debugging port (a killed Chrome can still hold its port for a moment, so
// reusing one port made the next test attach to — or fail against — the previous, dying browser). The 9840-9939
// band is not used by any other test file.
let portSeq = 0;
async function withChrome(proxyPort, fn) {
  const chrome = chromePath();
  const host = '127.0.0.1';
  const cdpPort = 9840 + ((process.pid + (portSeq++) * 17) % 100);
  const profile = mkdtempSync(join(tmpdir(), 'phom-proxy-auth-'));
  // <-loopback> forces even 127.0.0.1 through the proxy (Chrome bypasses loopback by default).
  const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>',
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  let client;
  try {
    assert.ok(await waitEndpoint(host, cdpPort), 'chrome up');
    client = await CDP({ host, port: cdpPort });
    await client.Page.enable();
    await fn(client);
  } finally {
    try { if (client) await client.close(); } catch { /* ignore */ }
    const exited = new Promise((r) => { proc.once('exit', r); setTimeout(r, 5000); });
    try { proc.kill(); } catch { /* ignore */ }
    await exited; // the port and the profile are only free once Chrome is really gone
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
const bodyText = async (client) => { try { const r = await client.Runtime.evaluate({ expression: 'document.body ? document.body.innerText : ""', returnByValue: true }); return String(r.result.value || ''); } catch { return ''; } };

test('§52 authenticated proxy: bind on about:blank, then navigate → the page loads THROUGH the proxy', async (t) => {
  if (!chromePath()) { t.skip('Chrome not installed'); return; }
  const origin = await startOrigin();
  const proxy = await startAuthProxy();
  try {
    await withChrome(proxy.port, async (client) => {
      await bindProxyAuth(client, { runProxy: { requiresAuth: true }, username: USER, resolvePassword: () => PASS });
      await client.Page.navigate({ url: `http://127.0.0.1:${origin.port}/` });
      const ok = await waitFor(async () => (await bodyText(client)).includes('OK-PROXIED'));
      assert.ok(ok, 'the game page loaded through the authenticated proxy');
      assert.ok(proxy.seen.challenged >= 1, 'the proxy really demanded credentials');
      assert.ok(proxy.seen.authorized >= 1, 'and the tool answered them');
      assert.equal(proxy.seen.badCreds, 0);
    });
  } finally { origin.server.close(); proxy.server.close(); }
});

test('§52 control: WITHOUT the handler the same proxy blocks the page (the bug the ordering fixes)', async (t) => {
  if (!chromePath()) { t.skip('Chrome not installed'); return; }
  const origin = await startOrigin();
  const proxy = await startAuthProxy();
  try {
    await withChrome(proxy.port, async (client) => {
      await client.Page.navigate({ url: `http://127.0.0.1:${origin.port}/` });
      await sleep(1500);
      assert.equal((await bodyText(client)).includes('OK-PROXIED'), false, 'unanswered 407 → the game never loads');
      assert.equal(proxy.seen.authorized, 0);
    });
  } finally { origin.server.close(); proxy.server.close(); }
});

// The real game is HTTPS + WSS: both reach the proxy as a CONNECT tunnel, a different path from plain HTTP.
test('§52 authenticated proxy: the HTTPS/WSS CONNECT tunnel carries the credentials too', async (t) => {
  if (!chromePath()) { t.skip('Chrome not installed'); return; }
  const proxy = await startAuthProxy();
  try {
    await withChrome(proxy.port, async (client) => {
      await bindProxyAuth(client, { runProxy: { requiresAuth: true }, username: USER, resolvePassword: () => PASS });
      // (not port 9: it is on Chrome's unsafe-port list, so Chrome never even sends the CONNECT)
      client.Page.navigate({ url: 'https://127.0.0.1:8443/' }).catch(() => {});
      const ok = await waitFor(() => (proxy.seen.connectAuthorized || 0) >= 1);
      assert.ok(ok, 'the CONNECT tunnel was opened WITH the tool-supplied credentials');
      assert.ok((proxy.seen.connectChallenged || 0) >= 1, 'after the proxy really demanded them');
    });
  } finally { proxy.server.close(); }
});

// Wiring in the app: a browser behind an authenticated proxy starts on about:blank and is sent to the game only
// after the handler is bound on its own page client (once — a re-attach must not reload the game).
test('§52 wiring: auth-first launch, navigate after binding, page target only, once', () => {
  const fs = require('fs');
  const main = fs.readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /const authFirst = !!\(gate\.runProxy && gate\.runProxy\.requiresAuth\);/);
  assert.match(main, /run\.launcher\.open\(authFirst \? 'about:blank' : String\(url \|\| ''\)\)/);
  assert.match(main, /if \(pending && \(!target\.type \|\| target\.type === 'PAGE'\)\) \{/);
  assert.match(main, /run\._pendingNavigateUrl = null;\s*client\.Page\.navigate\(\{ url: pending \}\)/);
  const handler = fs.readFileSync(new URL('../../desktop/browser-run/proxy-auth-handler.cjs', import.meta.url), 'utf8');
  assert.match(handler, /patterns: \[\{ urlPattern: '\*' \}\]/, 'authRequired only fires for INTERCEPTED requests');
  assert.equal(/Fetch\.enable\(\{ handleAuthRequests: true, patterns: \[\] \}\)/.test(handler), false, 'the intercept-nothing call is gone');
});

// The profile editor used to show an EMPTY proxy box for a profile that HAS a proxy, so a saved proxy looked as
// if it had not been saved. It now shows the redaction-safe snapshot, and an empty box keeps the proxy.
test('profile editor shows the saved proxy (never the password) and an empty box keeps it', () => {
  const fs = require('fs');
  const ui = fs.readFileSync(new URL('../../ui-phom/phom-qa.js', import.meta.url), 'utf8');
  assert.match(ui, /const curProxy = existing && existing\.proxyRef \? \(proxies \|\| \[\]\)\.find\(\(x\) => x\.id === existing\.proxyRef\)/);
  assert.match(ui, /el\('span', null, 'Đang dùng'\), el\('span', \{ class: 'chip green sm mono' \}, proxyLabel\(curProxy\)\)/);
  assert.match(ui, /'để trống = giữ proxy hiện tại · nhập mới để đổi'/);
  assert.match(ui, /close\(\); await refreshProxies\(\); await refreshProfilesX\(\);/);
  // the label is built only from the public snapshot — there is no password field to leak
  const fmt = ui.slice(ui.indexOf('function proxyLabel('), ui.indexOf('function openProfileModal('));
  assert.equal(/password|pass\b/i.test(fmt.replace(/có mật khẩu|không mật khẩu/g, '')), false);
  // and saving with an empty box does not touch the proxy
  assert.match(ui, /if \(proxyStr\) \{ const pr = await api\.profileSetProxy\(pid, proxyStr\);/);
});
