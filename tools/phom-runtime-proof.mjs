#!/usr/bin/env node
'use strict';

// NON-LIVE runtime proof (§15) for the PHOM custom Chromium + cluster CDP + mobile
// landscape emulation. It launches THREE real custom-Chromium processes (own PID /
// user-data-dir / CDP port, loopback only), connects THREE independent CDP clients,
// applies each profile's device emulation, and verifies from inside each page:
//   window.innerWidth > innerHeight  (landscape)
//   navigator.maxTouchPoints > 0     (touch)
//   navigator.userAgent === profile UA
// It only ever navigates about:blank — NO game server, NO proxy, NO Google calls.
//
// Uses --headless=new so it runs without an interactive display. Prints a JSON
// evidence block and exits non-zero if any invariant fails.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rt = require('../desktop/browser/phom-chromium-runtime.cjs');
const dp = require('../desktop/browser-run/device-profile.cjs');
const CDP = require('chrome-remote-interface');

const PRESETS = ['android-pixel5-landscape', 'android-galaxy-s20-landscape', 'android-generic-412-landscape'];
const SLOTS = ['A', 'B', 'C'];

function freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForCdp(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const c = await CDP({ host: '127.0.0.1', port }); await c.close(); return true; } catch { await sleep(200); } }
  return false;
}

async function main() {
  const v = rt.resolveAndValidate({ env: process.env, isPackaged: false });
  if (!v.ok) { console.error('RUNTIME_INVALID', v.error); process.exit(2); }
  console.log('RUNTIME_VALID', { version: v.version, exe: v.executable });

  const runs = [];
  const evidence = { runtimeVersion: v.version, liveGameCalls: 0, liveProxyCalls: 0, googleCalls: 0, profiles: {} };
  try {
    // 1) launch three custom-Chromium processes (own port / user-data-dir).
    for (let i = 0; i < 3; i++) {
      const slot = SLOTS[i];
      const device = dp.normalizeDeviceProfile({ presetId: PRESETS[i] }).device;
      const port = await freePort();
      const udd = fs.mkdtempSync(path.join(os.tmpdir(), `phom-proof-${slot}-`));
      const args = [
        '--headless=new', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`,
        `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check', '--touch-events=enabled',
        // The runtime is copied to a location whose ACLs the Chromium sandbox helper
        // cannot access (Access denied 0x5); --no-sandbox is standard for a QA/dev proof.
        '--no-sandbox', '--disable-gpu', 'about:blank',
      ];
      const child = spawn(v.executable, args, { stdio: 'ignore' });
      runs.push({ slot, device, port, udd, child, pid: child.pid });
    }

    // 2) connect an independent CDP client per run + apply device emulation.
    for (const r of runs) {
      const up = await waitForCdp(r.port);
      if (!up) throw new Error(`CDP not up for ${r.slot} on ${r.port}`);
      r.client = await CDP({ host: '127.0.0.1', port: r.port });
      const { Emulation, Page, Runtime } = r.client;
      await Page.enable();
      for (const c of dp.emulationCommands(r.device)) { const m = c.method.split('.')[1]; try { await Emulation[m](c.params); } catch (e) { /* optional */ } }
      await Page.navigate({ url: 'about:blank' });
      await Page.loadEventFired().catch(() => {});
      await sleep(150);
      const evalJs = async (expr) => (await Runtime.evaluate({ expression: expr, returnByValue: true })).result.value;
      r.result = {
        innerWidth: await evalJs('window.innerWidth'), innerHeight: await evalJs('window.innerHeight'),
        maxTouchPoints: await evalJs('navigator.maxTouchPoints'), userAgent: await evalJs('navigator.userAgent'),
        landscape: await evalJs('window.innerWidth > window.innerHeight'),
      };
    }

    // 3) assemble evidence + invariants.
    const pids = runs.map((r) => r.pid), ports = runs.map((r) => r.port), udds = runs.map((r) => r.udd);
    const distinct = (a) => new Set(a).size === a.length;
    for (const r of runs) {
      evidence.profiles[r.slot] = { pid: r.pid, cdpPort: r.port, userDataDir: r.udd, expectedUA: r.device.userAgent, ...r.result };
    }
    const checks = {
      threeProcesses: runs.length === 3,
      distinctPids: distinct(pids), distinctPorts: distinct(ports), distinctUserDataDirs: distinct(udds),
      allLandscape: runs.every((r) => r.result.landscape === true && r.result.innerWidth > r.result.innerHeight),
      allTouch: runs.every((r) => r.result.maxTouchPoints > 0),
      uaPerProfile: runs.every((r) => r.result.userAgent === r.device.userAgent),
      uaDistinct: distinct(runs.map((r) => r.result.userAgent)),
    };
    // §15.18-20 — kill A's process; B and C must remain independently responsive.
    const a = runs[0];
    try { if (a.client) await a.client.close(); } catch {}
    try { a.child.kill('SIGKILL'); } catch {}
    await sleep(500);
    let bcStillResponsive = true;
    for (const r of runs.slice(1)) {
      try { const w = (await r.client.Runtime.evaluate({ expression: 'window.innerWidth', returnByValue: true })).result.value; if (!(w > 0)) bcStillResponsive = false; }
      catch { bcStillResponsive = false; }
    }
    checks.bcUnaffectedByAKill = bcStillResponsive;
    evidence.restart = { killedSlot: 'A', bcUnaffectedByAKill: bcStillResponsive };

    evidence.checks = checks;
    console.log('EVIDENCE', JSON.stringify(evidence, null, 2));
    const passed = Object.values(checks).every(Boolean);
    console.log(passed ? 'PROOF_PASS' : 'PROOF_FAIL');
    if (!passed) process.exitCode = 3;
  } finally {
    // 4) cleanup ONLY the processes we spawned.
    for (const r of runs) { try { if (r.client) await r.client.close(); } catch {} try { r.child.kill('SIGKILL'); } catch {} }
    await sleep(300);
    for (const r of runs) { try { fs.rmSync(r.udd, { recursive: true, force: true }); } catch {} }
  }
}

main().catch((e) => { console.error('PROOF_ERROR', e && e.message || e); process.exit(1); });
