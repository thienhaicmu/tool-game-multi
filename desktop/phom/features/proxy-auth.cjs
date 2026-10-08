'use strict';

// ---------------------------------------------------------------------------
// FEATURE proxy-auth — §52: a browser behind an AUTHENTICATED proxy starts on about:blank; the proxy's 407 challenge is
// answered on the run's OWN client (browser-run/proxy-auth-handler.cjs), and only then does the PAGE navigate to the
// game — once (a re-attach must never reload the game). A launch-side watchdog (main) navigates anyway if this never
// ran, so a browser is never left on about:blank.
//
// deps: { bindProxyAuth, resolvePassword(proxyId), log, onAuthFailure(run, code) }
// ---------------------------------------------------------------------------

const isPage = (target) => !target || !target.type || target.type === 'PAGE';

function createProxyAuthFeature({ bindProxyAuth, resolvePassword, log = () => {}, onAuthFailure = () => {} }) {
  return {
    id: 'proxy-auth',
    async attach({ run, client, target }) {
      if (!run || !run.proxy || !run.proxy.requiresAuth) return;
      const detach = await bindProxyAuth(client, {
        runProxy: run.proxy,
        username: run.proxyUsername || null,
        resolvePassword: () => (run.proxy ? resolvePassword(run.proxy.id) : null),
        onAuthFailure: (code) => { log('PROXY_AUTH_FAILED', { runId: run.id, slotId: run.slot, code }); onAuthFailure(run, code); },
      });
      run._detachProxyAuth = detach;
      const pending = run._pendingNavigateUrl;
      if (pending && isPage(target)) {
        run._pendingNavigateUrl = null;
        log('PROXY_NAVIGATE', { runId: run.id, slotId: run.slot, watchdog: false });
        client.Page.navigate({ url: pending }).catch(() => {});
      }
    },
  };
}

module.exports = { createProxyAuthFeature };
