'use strict';

// ---------------------------------------------------------------------------
// FEATURE doc-nav — §54: a new top-level document on a run's PAGE (F5 in Chromium, the bar's ⟳, a redirect back to
// the web lobby) resets that browser's Phỏm state. Subscribed once per page client; every other feature hears it as
// the documentReplaced hook (the feature set fans it out).
//
// deps: { onDocument(runId, url) } — main forwards it to features.documentReplaced + the session reset.
// ---------------------------------------------------------------------------

const isPage = (target) => !target || !target.type || target.type === 'PAGE';

function createDocNavFeature({ onDocument }) {
  return {
    id: 'doc-nav',
    attach({ run, client, target }) {
      if (!isPage(target) || !client || !client.Page || client.__phomDocNav) return;
      client.__phomDocNav = true;
      client.Page.enable().catch(() => {});
      client.Page.frameNavigated((p) => { if (p && p.frame && !p.frame.parentId) onDocument(run.id, p.frame.url); });
    },
  };
}

module.exports = { createDocNavFeature };
