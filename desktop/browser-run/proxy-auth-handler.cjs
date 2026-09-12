'use strict';

// ---------------------------------------------------------------------------
// Proxy authentication seam (§5). The DECISION — what to answer a CDP
// Fetch.authRequired challenge — is a PURE, unit-testable function so credential
// routing is provable without a live proxy:
//   - a PROXY challenge for a run whose proxy requires auth -> ProvideCredentials
//     (the run's OWN proxy username + resolved password; never another run's)
//   - a PROXY challenge with no credentials -> CancelAuth (fail; NEVER a direct
//     fallback and NEVER the origin server's own auth)
//   - a SERVER (website) challenge -> Default (we never send proxy creds to origin)
//
// The live binder (bindProxyAuth) enables Fetch.handleAuthRequests on a run's OWN
// client and answers challenges via this decision. Because there is no authorized
// authenticated proxy to prove it against in this phase, the binder is marked
// runtime-unverified; the decision below is what the isolation tests cover.
// ---------------------------------------------------------------------------

// decideAuth(challenge, ctx) -> { response, username?, password? }
//   challenge: CDP AuthChallenge { source: 'Server'|'Proxy', origin, scheme, realm }
//   ctx: { runProxy, username, resolvePassword: () => string|null }
function decideAuth(challenge, ctx = {}) {
  const source = challenge && challenge.source;
  // Website/origin auth is NOT our business — answer Default so the page's own login
  // flow proceeds and proxy credentials are never leaked to the origin server.
  if (source !== 'Proxy') return { response: 'Default' };
  const runProxy = ctx.runProxy;
  if (!runProxy || !runProxy.requiresAuth) {
    // Unexpected proxy challenge without configured auth -> cancel (no direct fallback).
    return { response: 'CancelAuth', code: 'PROXY_AUTH_REQUIRED' };
  }
  const username = ctx.username != null ? String(ctx.username) : '';
  const password = typeof ctx.resolvePassword === 'function' ? ctx.resolvePassword() : null;
  if (password == null || password === '') {
    return { response: 'CancelAuth', code: 'PROXY_AUTH_FAILED' };
  }
  return { response: 'ProvideCredentials', username, password };
}

// bindProxyAuth(client, ctx) — wire a run's OWN CDP client to answer proxy auth.
// RUNTIME-UNVERIFIED in this phase (no authorized authenticated proxy available).
// Returns a detach function. Never logs credentials. Bound per-run (never global).
async function bindProxyAuth(client, ctx = {}) {
  if (!client || !client.Fetch) return () => {};
  const onAuth = async (params) => {
    try {
      const decision = decideAuth(params.authChallenge, ctx);
      const authChallengeResponse = decision.response === 'ProvideCredentials'
        ? { response: 'ProvideCredentials', username: decision.username, password: decision.password }
        : { response: decision.response };
      await client.Fetch.continueWithAuth({ requestId: params.requestId, authChallengeResponse });
      if (decision.response !== 'ProvideCredentials' && typeof ctx.onAuthFailure === 'function') {
        ctx.onAuthFailure(decision.code || 'PROXY_AUTH_FAILED');
      }
    } catch { /* target gone — ignore */ }
  };
  // A paused request that follows an auth handshake must be continued so the page
  // never hangs. With empty patterns only auth-related pauses occur.
  const onPaused = async (params) => {
    try { await client.Fetch.continueRequest({ requestId: params.requestId }); } catch { /* ignore */ }
  };
  try {
    client.Fetch.authRequired(onAuth);
    client.Fetch.requestPaused(onPaused);
    await client.Fetch.enable({ handleAuthRequests: true, patterns: [] });
  } catch { /* enable failed — caller treats as auth-unavailable */ }
  return async () => { try { await client.Fetch.disable(); } catch { /* ignore */ } };
}

module.exports = { decideAuth, bindProxyAuth };
