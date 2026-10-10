'use strict';

// ---------------------------------------------------------------------------
// FEATURE no-auto-ready — the game's own "Tự sẵn sàng" never readies an account: its 363 aRd:"true" goes out as
// "false" (protocol/phom/auto-ready-guard.cjs). Installed on every attached target (page: also every later document;
// worker), after the send hook (ws-hook) whose filter it chains into.
//
// deps: { apply(client) }
// ---------------------------------------------------------------------------

function createNoAutoReadyFeature({ apply }) {
  return {
    id: 'no-auto-ready',
    attach({ client }) { return Promise.resolve(apply(client)).catch(() => {}); },
  };
}

module.exports = { createNoAutoReadyFeature };
