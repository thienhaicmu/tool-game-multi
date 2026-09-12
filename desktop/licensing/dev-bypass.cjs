'use strict';

// ---------------------------------------------------------------------------
// Development-only license bypass (§3). PURE decision — never touches the verifier,
// never returns "valid" from a signature check. It only decides whether an app may
// run WITHOUT a license in a proven development context, and hard-forbids that in a
// packaged/production build.
//
// A bypass is allowed ONLY when ALL hold:
//   - not packaged (app.isPackaged === false)
//   - a development environment (NODE_ENV !== 'production')
//   - no production release marker (PHOM_RELEASE_CHANNEL !== 'production')
//   - the explicit opt-in flag PHOM_DEV_LICENSE_BYPASS === '1'
//
// If the flag is set in a packaged build, resolveDevBypass reports `forbidden` with
// LICENSE_DEV_BYPASS_FORBIDDEN_IN_PRODUCTION so startup can be blocked.
// ---------------------------------------------------------------------------

const FORBIDDEN_CODE = 'LICENSE_DEV_BYPASS_FORBIDDEN_IN_PRODUCTION';

function resolveDevBypass({ isPackaged = true, env = {}, releaseMarker = false } = {}) {
  const requested = env.PHOM_DEV_LICENSE_BYPASS === '1';
  const isDevelopment = env.NODE_ENV !== 'production';
  const productionChannel = env.PHOM_RELEASE_CHANNEL === 'production';
  if (!requested) return { requested: false, allowed: false, forbidden: false };
  // The flag is set. In a packaged / production / release context it is FORBIDDEN.
  if (isPackaged || productionChannel || releaseMarker) {
    return { requested: true, allowed: false, forbidden: true, code: FORBIDDEN_CODE };
  }
  if (!isDevelopment) return { requested: true, allowed: false, forbidden: false };
  return { requested: true, allowed: true, forbidden: false };
}

// The synthetic "license" context used ONLY while a dev bypass is active. It is
// clearly NOT an activated key: mode DEVELOPMENT_BYPASS, no licenseId/expiry, and
// productionAllowed:false so nothing downstream can treat it as shippable.
function developmentBypassContext(gameProduct = 'PHOM', machineId = null) {
  return {
    active: true,
    checking: false,
    mode: 'DEVELOPMENT_BYPASS',
    gameProduct,
    licenseId: null,
    expiresAt: null,
    productionAllowed: false,
    machineId,
  };
}

module.exports = { FORBIDDEN_CODE, resolveDevBypass, developmentBypassContext };
