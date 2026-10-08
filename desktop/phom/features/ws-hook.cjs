'use strict';

// ---------------------------------------------------------------------------
// FEATURE ws-hook — the in-page WebSocket send hook (cdp/ws-replay.cjs) must be in place BEFORE the game opens its
// socket: it is how every table command reaches the game's own socket. Installed on every attached target (page,
// worker); ws-replay itself guards against registering the same script twice on one session.
//
// deps: { injectSendHook(client) }
// ---------------------------------------------------------------------------

function createWsHookFeature({ injectSendHook }) {
  return {
    id: 'ws-hook',
    attach({ client }) { return Promise.resolve(injectSendHook(client)).catch(() => {}); },
  };
}

module.exports = { createWsHookFeature };
