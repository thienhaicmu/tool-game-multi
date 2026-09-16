'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.2 — thin CDP wrapper that installs the in-Chromium GAME HEADER (game-header.cjs) into a
// run's page and routes its button clicks back to the coordinator. It NEVER contains business logic —
// it only: (1) exposes a page binding window.__phomAction, (2) injects the boot script on every document
// (survives navigation/reload) + once immediately, (3) forwards Runtime.bindingCalled payloads to
// deps.onAction(runId, payload). State is pushed with pushHeaderState(). Best-effort: a CDP hiccup never
// throws across the caller.
// ---------------------------------------------------------------------------

// Install the header on one run's CDP client. Idempotent per client (guarded by __phomHeaderBridge).
async function installHeader(client, { runId, bindingName = '__phomAction', boot, onAction } = {}) {
  if (!client || !client.Runtime || !client.Page) return { ok: false, error: 'NO_CLIENT' };
  if (client.__phomHeaderBridge) return { ok: true, already: true };
  client.__phomHeaderBridge = true;
  try {
    await client.Runtime.enable().catch(() => {});
    await client.Page.enable().catch(() => {});
    await client.Runtime.addBinding({ name: bindingName }).catch(() => {});
    // Re-inject on every navigation/reload so the header persists (game reload / login redirect).
    await client.Page.addScriptToEvaluateOnNewDocument({ source: boot }).catch(() => {});
    await client.Runtime.evaluate({ expression: boot }).catch(() => {}); // current document
    client.Runtime.bindingCalled((p) => {
      if (!p || p.name !== bindingName) return;
      let payload = {}; try { payload = JSON.parse(p.payload || '{}'); } catch { payload = {}; }
      try { if (typeof onAction === 'function') Promise.resolve(onAction(runId, payload)).catch(() => {}); } catch { /* isolate */ }
    });
    // Re-run the boot on a real navigation too (addScriptToEvaluateOnNewDocument covers new docs, but
    // re-evaluate defensively so the bar reappears even if the app SPA-swaps the body).
    client.Page.frameNavigated((f) => { if (f && f.frame && !f.frame.parentId) client.Runtime.evaluate({ expression: boot }).catch(() => {}); });
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Push a derived header state object into the page (window.__phomHeaderRender). Best-effort.
function pushHeaderState(client, state) {
  if (!client || !client.Runtime) return;
  const json = JSON.stringify(state || {});
  client.Runtime.evaluate({ expression: `window.__phomHeaderRender && window.__phomHeaderRender(${json})` }).catch(() => {});
}

module.exports = { installHeader, pushHeaderState };
