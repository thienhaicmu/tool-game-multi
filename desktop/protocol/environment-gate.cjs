'use strict';

// The safety guard stays enabled by default. Set OBSERVATORY_DISABLE_ENV_GUARD
// to true/1/on only for an explicitly authorized debugging session.
function environmentGuardEnabled(value = process.env.OBSERVATORY_DISABLE_ENV_GUARD) {
  if (typeof value === 'boolean') return !value;
  return !['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

module.exports = { environmentGuardEnabled };
