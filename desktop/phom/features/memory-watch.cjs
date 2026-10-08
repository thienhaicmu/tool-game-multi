'use strict';

// ---------------------------------------------------------------------------
// FEATURE memory-watch — a logged-in browser's MAIN process was seen growing ~200 MB/s to 15 GB and froze the machine
// (2026-10-08). Each browser the tool opened is sampled every 5 s (one long-lived sampler, browser-memory-watch.cjs):
// past warnMb it is logged once (with the tool's last steps for it), past killMb it is closed — gracefully first, its
// main process killed if it has not gone within killWaitMs.
//
// deps: { marker, runs(): [{ id, slot, profileDir, profileLabel, browserKind, closed }], closeRun(rid),
//         killPid(pid), log(event, data), notice(n), sessions, watch? (injectable sampler factory) }
// ---------------------------------------------------------------------------

const W = require('../../browser/browser-memory-watch.cjs');

function createMemoryWatchFeature(deps) {
  const { runs, closeRun, killPid = (pid) => process.kill(pid), log, notice, sessions, killWaitMs = 4000 } = deps;
  const limits = { warnMb: deps.warnMb || W.DEFAULTS.warnMb, killMb: deps.killMb || W.DEFAULTS.killMb };
  let watch = null;
  function start() {
    if (watch) return;
    const factory = deps.watch || ((o) => W.createMemoryWatch(o));
    watch = factory({ marker: deps.marker(), onSample, log });
    watch.start();
  }
  // byDir: Map(normalized user-data-dir → { mainPid, mainMb, rendererMb })
  function onSample(byDir) {
    for (const run of runs()) {
      if (!run || run.closed || !run.profileDir) continue;
      const e = byDir.get(W.normDir(run.profileDir));
      const verdict = W.judge(e, limits);
      if (!verdict) continue;
      const s = sessions.get(run.id);
      const info = { runId: String(run.id), slotId: run.slot || null, profile: run.profileLabel || null, kind: run.browserKind || null, mainMb: e.mainMb, rendererMb: e.rendererMb, recent: s.recent.slice() };
      if (verdict === 'HIGH' && !s.memory.warned) { s.memory.warned = true; log('BROWSER_MEMORY_HIGH', info); }
      if (verdict === 'RUNAWAY' && !s.memory.killed) {
        s.memory.killed = true;
        log('BROWSER_MEMORY_RUNAWAY', info);
        notice({ event: 'BROWSER_MEMORY_RUNAWAY', slot: run.slot || null, mb: e.mainMb });
        const pid = e.mainPid;
        Promise.race([Promise.resolve().then(() => closeRun(String(run.id))), new Promise((r) => setTimeout(r, killWaitMs))])
          .catch(() => {})
          .finally(() => { if (pid) { try { killPid(pid); } catch { /* already gone */ } } });
      }
    }
  }
  return {
    id: 'memory-watch',
    attach() { start(); },        // sampling starts with the first browser
    stop() { if (watch) { try { watch.stop(); } catch { /* gone */ } watch = null; } },
    _onSample: onSample,          // tests
  };
}

module.exports = { createMemoryWatchFeature };
