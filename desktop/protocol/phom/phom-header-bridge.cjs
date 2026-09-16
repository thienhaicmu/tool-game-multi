'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.2 / 6.3.2.2 — the CDP wrapper that installs the in-Chromium GAME HEADER (game-header.cjs) into
// a run's page and routes its button clicks back to the coordinator. It contains NO business logic.
//
// 6.3.2.2 RELIABILITY: the header was intermittent because target discovery is poll-based (the CDP
// `attached` event can fire at ANY point in the page load) and the old code injected the boot script
// ONCE, re-injecting only on frameNavigated, while swallowing every CDP error. If `attached` landed after
// the page had already loaded (fast load) — or the single evaluate lost a race with a navigation/context
// swap — the header silently never appeared and VÀO GAME did nothing. This rewrite:
//   1. drives the (idempotent) boot from EVERY lifecycle signal: attach, load, DOMContentLoaded,
//      top-frame navigation — plus a bounded presence re-check — so the bar is always present.
//   2. exposes window.__phomAction ONCE per client (guarded) and re-uses it across navigations.
//   3. logs each step (install / inject / action-received / errors) instead of swallowing, so an
//      intermittent failure is diagnosable. Never logs secrets.
// ---------------------------------------------------------------------------

// Install the header on one run's CDP client. Idempotent per client (guarded by __phomHeaderBridge).
async function installHeader(client, { runId, slotId, bindingName = '__phomAction', boot, onAction, log } = {}) {
  if (!client || !client.Runtime || !client.Page) return { ok: false, error: 'NO_CLIENT' };
  const tag = slotId || runId || '?';
  const dbg = (event, extra) => { try { if (typeof log === 'function') log(event, { tag, ...(extra || {}) }); } catch { /* logging is best-effort */ } };
  if (client.__phomHeaderBridge) return { ok: true, already: true };
  client.__phomHeaderBridge = true;

  // Re-run the idempotent boot in the CURRENT document. Errors are logged (not swallowed) so a lost race
  // is visible; the NEXT lifecycle signal re-injects, so one failure never leaves the header missing.
  const inject = async (reason) => {
    try { await client.Runtime.evaluate({ expression: boot }); dbg('header-inject', { reason }); return true; }
    catch (e) { dbg('header-inject-error', { reason, error: String(e && e.message || e) }); return false; }
  };

  try {
    await client.Runtime.enable().catch((e) => dbg('runtime-enable-error', { error: String(e && e.message || e) }));
    await client.Page.enable().catch((e) => dbg('page-enable-error', { error: String(e && e.message || e) }));
    // The page→main bridge. addBinding applies to the current + all FUTURE execution contexts, so it
    // survives navigation/reload. A failure here means clicks can never arrive — log it loudly.
    try { await client.Runtime.addBinding({ name: bindingName }); dbg('binding-install'); }
    catch (e) { dbg('binding-install-error', { error: String(e && e.message || e) }); }
    // Persistent injection on every FUTURE document (survives reload / cross-doc navigation).
    try { await client.Page.addScriptToEvaluateOnNewDocument({ source: boot }); } catch (e) { dbg('add-script-error', { error: String(e && e.message || e) }); }

    // Route clicks. Registered once; persists for the client's lifetime.
    client.Runtime.bindingCalled((p) => {
      if (!p || p.name !== bindingName) return;
      let payload = {}; try { payload = JSON.parse(p.payload || '{}'); } catch { payload = {}; }
      dbg('action-received', { action: payload.action, actionId: payload.actionId, stake: payload.stake });
      try { if (typeof onAction === 'function') Promise.resolve(onAction(runId, payload)).catch((e) => dbg('action-route-error', { error: String(e && e.message || e) })); }
      catch (e) { dbg('action-route-error', { error: String(e && e.message || e) }); }
    });

    // Drive the (idempotent) boot from every reliable lifecycle signal so the bar is ALWAYS present,
    // regardless of whether attach landed before or after the page finished loading.
    if (client.Page.frameNavigated) client.Page.frameNavigated((f) => { if (f && f.frame && !f.frame.parentId) inject('frameNavigated'); });
    if (client.Page.loadEventFired) client.Page.loadEventFired(() => inject('load'));
    if (client.Page.domContentEventFired) client.Page.domContentEventFired(() => inject('domcontent'));

    // Current document (covers the already-loaded / fast-load case that fires no future event).
    await inject('attach');
    // Bounded presence re-check: if the immediate inject lost a race with a navigation, retry shortly.
    setTimeout(() => { verifyPresent(client, bindingName).then((ok) => { if (!ok) inject('recheck'); }).catch(() => {}); }, 400);
    dbg('header-ready');
    return { ok: true };
  } catch (e) { dbg('install-error', { error: String(e && e.message || e) }); return { ok: false, error: String(e && e.message || e) }; }
}

// Is the header bar (and its binding) present in the current document? Best-effort boolean.
async function verifyPresent(client, bindingName = '__phomAction') {
  if (!client || !client.Runtime) return false;
  try {
    const r = await client.Runtime.evaluate({ expression: `!!(document.getElementById('__phom_header') && typeof window.${bindingName} === 'function')`, returnByValue: true });
    return !!(r && r.result && r.result.value === true);
  } catch { return false; }
}

// Push a derived header state object into the page (window.__phomHeaderRender). Best-effort.
function pushHeaderState(client, state) {
  if (!client || !client.Runtime) return;
  const json = JSON.stringify(state || {});
  client.Runtime.evaluate({ expression: `window.__phomHeaderRender && window.__phomHeaderRender(${json})` }).catch(() => {});
}

module.exports = { installHeader, pushHeaderState, verifyPresent };
