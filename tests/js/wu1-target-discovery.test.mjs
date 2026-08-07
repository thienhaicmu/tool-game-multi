import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const CDP = require('chrome-remote-interface');
const { TargetManager } = require('../../desktop/cdp/target-manager.cjs');
const util = require('../../desktop/cdp/util.cjs');
const { CODES } = require('../../desktop/cdp/errors.cjs');

// ---------- Pure unit tests (no Chrome needed) ----------

test('classifyRuntime: connection hint wins over version string', () => {
  assert.equal(util.classifyRuntime('Chrome/120', 'page', 'ANDROID_WEBVIEW'), 'ANDROID_WEBVIEW');
});
test('classifyRuntime: Edge -> WEBVIEW2', () => {
  assert.equal(util.classifyRuntime('Edg/120.0', 'page', null), 'WEBVIEW2');
});
test('classifyRuntime: webview type -> ANDROID_WEBVIEW', () => {
  assert.equal(util.classifyRuntime('Chrome/120', 'webview', null), 'ANDROID_WEBVIEW');
});
test('classifyRuntime: plain chrome -> CHROME', () => {
  assert.equal(util.classifyRuntime('HeadlessChrome/120', 'page', null), 'CHROME');
});

test('parseWebviewSockets extracts abstract sockets', () => {
  const sample = [
    '0000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_2777',
    '0000: 00000002 00000000 00010000 0001 01 12346 @chrome_devtools_remote',
    '0000: 00000002 00000000 00010000 0001 01 12347 /dev/socket/other',
    '0000: 00000002 00000000 00010000 0001 01 12348 @webview_devtools_remote_2777',
  ].join('\n');
  assert.deepEqual(
    util.parseWebviewSockets(sample).sort(),
    ['chrome_devtools_remote', 'webview_devtools_remote_2777'],
  );
});

test('isAttachable / targetType mapping', () => {
  assert.equal(util.isAttachable('page'), true);
  assert.equal(util.isAttachable('webview'), true);
  assert.equal(util.isAttachable('service_worker'), false);
  assert.equal(util.targetType('webview'), 'WEBVIEW');
});

test('start() throws typed CDP_ENDPOINT_UNAVAILABLE on dead port', async () => {
  const mgr = new TargetManager({ host: '127.0.0.1', port: 1 });
  await assert.rejects(() => mgr.start(), (e) => e.code === CODES.CDP_ENDPOINT_UNAVAILABLE);
});

// ---------- Integration test against real Chrome ----------

function chromePath() {
  const candidates = [
    process.env.OBSERVATORY_CHROME,
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c));
}

async function waitForEndpoint(host, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await CDP.Version({ host, port }); return true; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  return false;
}

test('discovers targets, per-target context binding, and add/remove lifecycle', async (t) => {
  const chrome = chromePath();
  if (!chrome) { t.skip('Chrome not installed'); return; }

  const host = '127.0.0.1';
  const port = 9300 + (process.pid % 120);
  const profile = mkdtempSync(join(tmpdir(), 'wu1-chrome-'));
  const proc = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  const mgr = new TargetManager({ host, port, pollIntervalMs: 400 });
  try {
    assert.ok(await waitForEndpoint(host, port), 'chrome CDP endpoint came up');

    const added = [];
    const removed = [];
    mgr.on('target-added', (tg) => added.push(tg));
    mgr.on('target-removed', (id) => removed.push(id));

    await mgr.start();
    // At least the about:blank page target is discovered and classified.
    const targets = mgr.listTargets();
    assert.ok(targets.length >= 1, 'at least one target discovered');
    const page = targets.find((x) => x.type === 'PAGE') || targets[0];
    assert.equal(page.runtime, 'CHROME');
    assert.ok(page.attached);

    // Per-target context binding: evaluate in THIS target's own client.
    const { client } = mgr.getSession(page.cdpTargetId);
    const evalResult = await client.Runtime.evaluate({ expression: '1 + 41', returnByValue: true });
    assert.equal(evalResult.result.value, 42, 'Runtime.evaluate runs in the bound target');

    // Lifecycle: open a new tab -> target-added; close it -> target-removed.
    const fresh = await CDP.New({ host, port, url: 'about:blank' });
    await waitUntil(() => added.some((x) => x.cdpTargetId === fresh.id), 4000);
    assert.ok(added.some((x) => x.cdpTargetId === fresh.id), 'new tab detected as target-added');

    await CDP.Close({ host, port, id: fresh.id });
    await waitUntil(() => removed.includes(fresh.id), 4000);
    assert.ok(removed.includes(fresh.id), 'closed tab detected as target-removed');
  } finally {
    await mgr.stop();
    try { proc.kill(); } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function waitUntil(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
