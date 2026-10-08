'use strict';

// ---------------------------------------------------------------------------
// Browser MEMORY WATCH (2026-10-08). A logged-in browser's MAIN process was seen growing ~200 MB/s to 15 GB with the
// tool idle — the whole machine froze ("login xong là đơ", Task Manager 93 %). The cause was not reproducible on demand,
// so the tool now protects the machine and records the moment: every few seconds it reads the private memory of the
// Chromium/Chrome processes the tool launched (one long-lived PowerShell child, not a process per sample), groups them
// by user-data-dir, and reports
//   HIGH    — a browser's main process passed the warning line (logged once per browser), and
//   RUNAWAY — it passed the hard line → the caller closes that browser before the machine runs out.
// The decision part (parse / summarize / judge) is pure and unit-tested; the sampler is Windows-only.
// ---------------------------------------------------------------------------

const { spawn: spawnDefault } = require('node:child_process');

const DEFAULTS = Object.freeze({ intervalMs: 5000, warnMb: 1500, killMb: 3000 });

// The PowerShell loop: one JSON line per sample — [{p:pid, q:parent, t:type, u:user-data-dir, m:privateBytes}].
function samplerScript(marker, intervalMs) {
  const sec = Math.max(1, Math.round(intervalMs / 1000));
  const m = String(marker).replace(/'/g, "''");
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    'while ($true) {',
    `  $rows = @(Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${m}*' } | ForEach-Object {`,
    "    $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'main' }",
    "    $u = if ($_.CommandLine -match '--user-data-dir=\"?([^\"]+?)\"?(\\s--|$)') { $matches[1] } else { '' }",
    '    [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; t = $t; u = $u; m = $_.PrivatePageCount }',
    '  })',
    '  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress -Depth 2))',
    `  Start-Sleep -Seconds ${sec}`,
    '}',
  ].join('\n');
}

const normDir = (d) => String(d || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// rows → Map(normalized user-data-dir → { mainPid, mainMb, rendererMb, totalMb })
function summarize(rows) {
  const out = new Map();
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  const mainOf = new Map(); // pid → dir of a main process
  for (const r of list) if (r && r.t === 'main' && r.u) mainOf.set(Number(r.p), normDir(r.u));
  for (const r of list) {
    if (!r) continue;
    const dir = r.u ? normDir(r.u) : mainOf.get(Number(r.q));
    if (!dir) continue;
    const e = out.get(dir) || { mainPid: null, mainMb: 0, rendererMb: 0, totalMb: 0 };
    const mb = Number(r.m) / 1048576;
    if (r.t === 'main') { e.mainPid = Number(r.p); e.mainMb += mb; } else if (r.t === 'renderer') e.rendererMb += mb;
    e.totalMb += mb;
    out.set(dir, e);
  }
  for (const e of out.values()) { e.mainMb = Math.round(e.mainMb); e.rendererMb = Math.round(e.rendererMb); e.totalMb = Math.round(e.totalMb); }
  return out;
}

// 'RUNAWAY' | 'HIGH' | null — judged on the MAIN process (where the 15 GB was), not the game tab
function judge(entry, { warnMb = DEFAULTS.warnMb, killMb = DEFAULTS.killMb } = {}) {
  if (!entry) return null;
  if (entry.mainMb >= killMb) return 'RUNAWAY';
  if (entry.mainMb >= warnMb) return 'HIGH';
  return null;
}

// createMemoryWatch({ marker, onSample(map) }) → { start(), stop(), running() }
function createMemoryWatch({ marker, intervalMs = DEFAULTS.intervalMs, onSample = () => {}, spawn = spawnDefault, platform = process.platform, log = () => {} } = {}) {
  let child = null; let buf = '';
  function start() {
    if (child || platform !== 'win32' || !marker) return false;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', samplerScript(marker, intervalMs)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { child = null; log('memory-watch-spawn-failed', { error: String(e && e.message || e) }); return false; }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let rows; try { rows = JSON.parse(line); } catch { continue; }
        try { onSample(summarize(rows)); } catch { /* a bad sample never stops the watch */ }
      }
      if (buf.length > 1 << 20) buf = ''; // never accumulate
    });
    child.on('exit', () => { child = null; });
    if (child.unref) child.unref();
    return true;
  }
  function stop() { if (child) { try { child.kill(); } catch { /* gone */ } child = null; } }
  return { start, stop, running: () => !!child };
}

module.exports = { DEFAULTS, samplerScript, summarize, judge, normDir, createMemoryWatch };
