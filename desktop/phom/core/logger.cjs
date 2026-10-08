'use strict';

// ---------------------------------------------------------------------------
// LOGGER (3.2 core) — the tool's ONE diagnostic log: userData/phom-captures/coseat.jsonl, one JSON line per event.
//
//   file(entry)        a line, as is (the coordinator's PHOM-COSEAT wire events, the group's PHOM-GROUP decisions)
//   run(event, data)   a browser step (PHOM-RUN). The steps that explain "it opened but never got into the game" (and
//                      every feature error) ALWAYS reach the file; every step goes to stderr when PHOM_HEADER_LOG=1 /
//                      PHOM_LIFECYCLE_LOG=1.
//   trace(event, data) a lifecycle step (slot swaps, quit …) — stderr only, when verbose
//   flush()            write what is queued now (app quit)
//
// Every line goes through redact (diagnostic-redaction): passwords / tokens / cookies are masked, and the few server
// frames kept verbatim (a refused join, a kick) are dropped when they could hold a secret. It still names accounts,
// tables and money — share it only with whoever debugs the tool.
//
// Lines are queued and written in ONE append at most every flushMs (the capture used to do one BLOCKING append per
// frame on the main thread that also serves CDP, IPC and the bars). The first write of an app run ARCHIVES the
// previous session's log (renamed by time — history is kept); a log grown past rotateBytes is archived the same way.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const FLUSH_MS = 250;
const MAX_QUEUE = 2000;                  // a burst flushes at once rather than growing without bound
const ROTATE_BYTES = 60 * 1024 * 1024;
const FILE = 'coseat.jsonl';
// the browser steps that always reach the file
const ALWAYS_RUN_EVENTS = Object.freeze(['GAME_URL_FOLLOWS_LOGIN', 'AUTO_ENTER_DONE', 'AUTO_ENTER_GAVE_UP', 'DOCUMENT_REPLACED', 'capture-rehook', 'PROXY_AUTH_FAILED', 'PROXY_NAVIGATE', 'BROWSER_MEMORY_HIGH', 'BROWSER_MEMORY_RUNAWAY', 'feature-error', 'feature-off-unknown']);
const HEADER = '# Nhật ký chẩn đoán Phỏm QA — mật khẩu/token đã được che; vẫn có tên acc, số bàn, tiền: chỉ gửi cho người hỗ trợ.\n';

// dir() → the folder (resolved late: Electron's userData is set at startup); redact(entry) → entry
function createLogger({ dir, redact = (e) => e, verbose = () => process.env.PHOM_HEADER_LOG === '1' || process.env.PHOM_LIFECYCLE_LOG === '1', stderr = (line) => process.stderr.write(line + '\n'), now = () => new Date(), flushMs = FLUSH_MS, maxQueue = MAX_QUEUE, rotateBytes = ROTATE_BYTES, always = ALWAYS_RUN_EVENTS } = {}) {
  const alwaysSet = new Set(always);
  let queue = [];
  let timer = null;
  let started = false;
  const filePath = () => path.join(dir(), FILE);

  function archive(reason) {
    const d = dir();
    try { const p = filePath(); if (fs.existsSync(p)) fs.renameSync(p, path.join(d, 'coseat-' + now().toISOString().replace(/[:.]/g, '-') + '.jsonl')); } catch { /* best effort */ }
    try { fs.writeFileSync(filePath(), '# SESSION ' + (reason || '') + ' ' + now().toISOString() + '\n' + HEADER, 'utf8'); } catch { /* best effort */ }
  }

  function flush() {
    if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } timer = null; }
    if (!queue.length) return;
    const batch = queue; queue = [];
    try {
      fs.mkdirSync(dir(), { recursive: true });
      if (!started) { archive('start'); started = true; }
      else { try { if (fs.statSync(filePath()).size > rotateBytes) archive('rotate'); } catch { /* not there yet */ } }
      fs.appendFileSync(filePath(), batch.join('\n') + '\n', 'utf8');
    } catch { /* never throw from logging */ }
  }

  function file(entry) {
    let line; try { line = JSON.stringify(redact(entry)); } catch { return; }
    queue.push(line);
    if (queue.length >= maxQueue) flush();
    else if (!timer) { timer = setTimeout(flush, flushMs); if (timer.unref) timer.unref(); }
  }

  function run(event, data = {}) {
    if (alwaysSet.has(event)) file({ tag: 'PHOM-RUN', event, at: now().toISOString(), ...data });
    if (!verbose()) return;
    try { stderr(JSON.stringify({ t: now().toISOString(), tag: 'PHOMLC', event, ...data })); } catch { /* never throw */ }
  }

  // a lifecycle step (slots, swaps, quit…) — stderr only, when verbose
  function trace(event, data = {}) {
    if (!verbose()) return;
    try { stderr(JSON.stringify({ t: now().toISOString(), tag: 'PHOMLC', event, ...data })); } catch { /* never throw */ }
  }

  return { file, run, trace, flush, path: filePath, alwaysEvents: () => [...alwaysSet] };
}

module.exports = { createLogger, ALWAYS_RUN_EVENTS, FLUSH_MS, MAX_QUEUE, ROTATE_BYTES };
