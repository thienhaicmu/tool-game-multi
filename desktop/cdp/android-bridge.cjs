'use strict';

const { execFile } = require('node:child_process');
const { parseWebviewSockets } = require('./util.cjs');
const { CODES, CdpError } = require('./errors.cjs');

// Helper for attaching to an Android WebView over adb. The tool locates the
// WebView's abstract debugging socket and forwards it to a local TCP port, after
// which it is a normal host:port CDP endpoint (runtimeHint = ANDROID_WEBVIEW).
// A manual host:port fallback is always available in the UI, so adb is optional.

function runAdb(adbPath, args, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(adbPath || 'adb', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new CdpError(CODES.CDP_ENDPOINT_UNAVAILABLE,
        `adb ${args.join(' ')} failed`, { cause: String(stderr || err.message) }));
      else resolve(String(stdout || ''));
    });
  });
}

async function listWebviewSockets(adbPath) {
  const out = await runAdb(adbPath, ['shell', 'cat', '/proc/net/unix']);
  return parseWebviewSockets(out);
}

async function forwardSocket(adbPath, localPort, socketName) {
  await runAdb(adbPath, ['forward', `tcp:${localPort}`, `localabstract:${socketName}`]);
  return { host: '127.0.0.1', port: Number(localPort), runtimeHint: 'ANDROID_WEBVIEW', socket: socketName };
}

async function removeForward(adbPath, localPort) {
  try { await runAdb(adbPath, ['forward', '--remove', `tcp:${localPort}`]); } catch { /* best effort */ }
}

module.exports = { runAdb, listWebviewSockets, forwardSocket, removeForward };
