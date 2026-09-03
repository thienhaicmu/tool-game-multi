'use strict';

// Local/test endpoint gating has been removed for this product build. Keep the
// helper only for older callers that still import it.
function environmentGuardEnabled() { return false; }

module.exports = { environmentGuardEnabled };
