'use strict';

// Pure helpers for target discovery. No I/O, so they are unit-testable without Chrome.

// Map a raw CDP target type + connection hint to our DebugTarget.type.
// CDP /json "type" is one of: page, webview, iframe, worker, service_worker,
// shared_worker, background_page, browser, other.
function targetType(rawType) {
  switch (String(rawType || '').toLowerCase()) {
    case 'page': return 'PAGE';
    case 'webview': return 'WEBVIEW';
    case 'iframe': return 'IFRAME';
    case 'worker':
    case 'service_worker':
    case 'shared_worker': return 'WORKER';
    default: return 'OTHER';
  }
}

// Which targets are worth attaching for network debugging.
function isAttachable(rawType) {
  const t = String(rawType || '').toLowerCase();
  return t === 'page' || t === 'webview';
}

// Best-effort runtime classification. `runtimeHint` (from the connection source,
// e.g. an adb-forwarded endpoint) wins, because /json/version alone cannot reliably
// separate Android WebView / CEF from desktop Chrome (all report "Chrome/<v>").
function classifyRuntime(versionBrowser, rawType, runtimeHint) {
  if (runtimeHint) return runtimeHint;
  const b = String(versionBrowser || '').toLowerCase();
  const type = String(rawType || '').toLowerCase();
  if (b.includes('edg/') || b.includes('edge')) return 'WEBVIEW2';
  if (type === 'webview') return 'ANDROID_WEBVIEW';
  if (b.includes('headlesschrome') || b.includes('chrome') || b.includes('chromium')) return 'CHROME';
  if (!b) return 'OTHER';
  return 'OTHER';
}

// Normalize a raw CDP.List() entry into a DebugTarget (attached=false until we connect).
function toDebugTarget(raw, versionBrowser, runtimeHint) {
  return {
    id: String(raw.id),
    cdpTargetId: String(raw.id),
    sessionId: null,
    type: targetType(raw.type),
    runtime: classifyRuntime(versionBrowser, raw.type, runtimeHint),
    url: raw.url || '',
    title: raw.title || '',
    webSocketDebuggerUrl: raw.webSocketDebuggerUrl || null,
    attached: false,
  };
}

// Parse `adb shell cat /proc/net/unix` output and return unique abstract socket
// names used by Chromium WebView remote debugging.
// Abstract-namespace sockets are printed with a leading '@'.
function parseWebviewSockets(procNetUnix) {
  const found = new Set();
  for (const line of String(procNetUnix || '').split(/\r?\n/)) {
    const m = line.match(/@(webview_devtools_remote[^\s]*|chrome_devtools_remote[^\s]*)/);
    if (m) found.add(m[1]);
  }
  return [...found];
}

module.exports = {
  targetType,
  isAttachable,
  classifyRuntime,
  toDebugTarget,
  parseWebviewSockets,
};
