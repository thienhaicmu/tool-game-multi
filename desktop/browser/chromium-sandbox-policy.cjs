'use strict';

// ---------------------------------------------------------------------------
// CHROMIUM SANDBOX POLICY (PHOM custom runtime).
//
// The Windows Chromium sandbox is a SECURITY boundary and must stay ON in every
// production / packaged launch. `--no-sandbox` is NEVER a default: the real cause
// of the "Sandbox cannot access executable … Access is denied (0x5)" on a copied
// runtime is a filesystem-ACL gap (the copy lost the AppContainer read+execute
// grant), fixed by ensureSandboxAccess() — NOT by disabling the sandbox.
//
// A DEVELOPMENT-ONLY diagnostic bypass exists purely to keep UI testing moving if
// the sandbox somehow cannot be made to work on a dev box. It is gated behind an
// explicit env flag AND every one of: not packaged, not production, dev license
// bypass active, local runtime test, no game endpoint, no live proxy. In a packaged
// build the flag is REFUSED (PHOM_CHROMIUM_SANDBOX_BYPASS_FORBIDDEN).
//
// Pure + side-effect free: returns a decision, never launches or edits ACLs.
// ---------------------------------------------------------------------------

const DIAGNOSTIC_ENV = 'PHOM_DEV_DISABLE_CHROMIUM_SANDBOX';

// Decide whether a given launch may run with the sandbox disabled.
//   -> { sandboxDisabled, mode, banner?, blocked?, rejected?, reason? }
// sandboxDisabled === true ONLY for the fully-gated dev diagnostic path.
function resolveSandboxPolicy({
  isPackaged = true,
  nodeEnv = 'production',
  devBypassAllowed = false,
  localTest = false,
  diagnosticFlag = false,   // env PHOM_DEV_DISABLE_CHROMIUM_SANDBOX === '1'
  hasGameEndpoint = true,   // true if the run points at a real game URL (not about:blank)
  hasLiveProxy = true,      // true if the run carries a live proxy / account
} = {}) {
  // Production / packaged: the sandbox is mandatory. A bypass flag is actively refused.
  if (isPackaged || nodeEnv === 'production') {
    if (diagnosticFlag) {
      return { sandboxDisabled: false, mode: 'PRODUCTION_SANDBOX', rejected: 'PHOM_CHROMIUM_SANDBOX_BYPASS_FORBIDDEN',
        reason: 'The Chromium sandbox bypass is forbidden in packaged/production builds.' };
    }
    return { sandboxDisabled: false, mode: 'PRODUCTION_SANDBOX' };
  }

  // Development. Sandbox stays ON unless the explicit flag AND every guard hold.
  if (!diagnosticFlag) return { sandboxDisabled: false, mode: 'SANDBOX_ENABLED' };

  const guardsOk = devBypassAllowed === true && localTest === true && hasGameEndpoint === false && hasLiveProxy === false;
  if (!guardsOk) {
    return { sandboxDisabled: false, mode: 'SANDBOX_ENABLED', blocked: 'PHOM_CHROMIUM_SANDBOX_REQUIRED',
      reason: 'The dev sandbox bypass requires: dev license bypass + local runtime test + no game endpoint + no live proxy.' };
  }
  return { sandboxDisabled: true, mode: 'DEV_DIAGNOSTIC_SANDBOX_DISABLED', banner: 'DEV ONLY — CHROMIUM SANDBOX DISABLED' };
}

module.exports = { resolveSandboxPolicy, DIAGNOSTIC_ENV };
