'use strict';

// ---------------------------------------------------------------------------
// FEATURE browser-agent — the browser's AGENT on the run's own client: MOBILE overrides the user agent, WEB overrides
// nothing. A user-agent override survives navigation (no re-apply listener) and there is NO metrics/touch emulation:
// that is what rendered the Cocos canvas at 2–3× the pixels and made the game lag.
//
// deps: { browserAgent (browser-agent.cjs), notify(payload) } — notify reports what applied to the tool window.
// ---------------------------------------------------------------------------

async function applyAgent(browserAgent, client, agent) {
  if (!client || !client.Emulation) return { applied: [], unsupported: ['Emulation'] };
  const applied = [], unsupported = [];
  for (const c of browserAgent.emulationCommands(agent)) {
    const short = c.method.split('.')[1];
    try { await client.Emulation[short](c.params); applied.push(short); } catch { unsupported.push(short); }
  }
  return { applied, unsupported };
}

function createBrowserAgentFeature({ browserAgent, notify = () => {} }) {
  return {
    id: 'browser-agent',
    async attach({ run, client }) {
      if (!run || !run.browserAgent) return;
      const r = await applyAgent(browserAgent, client, run.browserAgent);
      run._agentApplied = r.applied; run._agentUnsupported = r.unsupported;
      try { notify({ runId: run.id, applied: r.applied, unsupported: r.unsupported, agent: browserAgent.publicSnapshot(run.browserAgent) }); } catch { /* best effort */ }
    },
  };
}

module.exports = { createBrowserAgentFeature, applyAgent };
