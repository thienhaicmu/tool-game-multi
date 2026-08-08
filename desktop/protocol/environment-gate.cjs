'use strict';

// The environment guard is disabled by default for this local project build.
// Set OBSERVATORY_ENABLE_ENV_GUARD to true/1/on to enforce the local/test host
// allowlists again.
function environmentGuardEnabled(value = process.env.OBSERVATORY_ENABLE_ENV_GUARD) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

module.exports = { environmentGuardEnabled };
