'use strict';

// ---------------------------------------------------------------------------
// Mobile device profile (QA rendering emulation). Concept ported minimally from
// the reference project D:\m-profile (pm/runtime device_profile + config.py mobile
// branch: viewport + screen + device_scale_factor + is_mobile + has_touch, plus the
// --touch-events chrome flag). The reference APPLIES devices through a custom-built
// Chromium loader; tool-game-multi uses STOCK Chrome + chrome-remote-interface, so
// here the same fields map to CDP Emulation.* calls instead.
//
// SCOPE (§6): this is viewport/screen/orientation/touch/UA emulation for rendering a
// mobile UI only. It deliberately does NOT port any anti-detection / fingerprint /
// attestation / client-hint spoofing from the reference (those stay OUT_OF_SCOPE).
// No credentials/proxy/cookies are ever part of a device profile.
// ---------------------------------------------------------------------------

const ORIENTATIONS = Object.freeze(['landscapePrimary', 'landscapeSecondary', 'portraitPrimary', 'portraitSecondary']);

// A small catalog of Android-Chrome mobile presets (the browser IS Chrome, so an
// Android-Chrome UA is internally consistent). Values are LANDSCAPE (width>height)
// for this task. Screen == viewport (a fullscreen mobile web view).
const MOBILE_PRESETS = Object.freeze([
  Object.freeze({ id: 'android-pixel5-landscape', name: 'Pixel 5 (Ngang)', deviceFamily: 'Pixel 5', platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewportWidth: 851, viewportHeight: 393, screenWidth: 851, screenHeight: 393, deviceScaleFactor: 2.75, mobile: true, touch: true, maxTouchPoints: 5 }),
  Object.freeze({ id: 'android-galaxy-s20-landscape', name: 'Galaxy S20 (Ngang)', deviceFamily: 'Galaxy S20', platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewportWidth: 800, viewportHeight: 360, screenWidth: 800, screenHeight: 360, deviceScaleFactor: 3, mobile: true, touch: true, maxTouchPoints: 5 }),
  Object.freeze({ id: 'android-generic-412-landscape', name: 'Android 412 (Ngang)', deviceFamily: 'Android Generic', platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 12; moto g power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    viewportWidth: 915, viewportHeight: 412, screenWidth: 915, screenHeight: 412, deviceScaleFactor: 2.625, mobile: true, touch: true, maxTouchPoints: 5 }),
]);

function typedError(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }
function isPosInt(n) { return Number.isInteger(n) && n > 0; }

function listPresets() { return MOBILE_PRESETS.map((p) => ({ ...p })); }
function getPreset(id) { const p = MOBILE_PRESETS.find((x) => x.id === String(id)); return p ? { ...p } : null; }

// normalizeDeviceProfile(input) -> { ok, device } | typed error. `input` may be a
// preset id (+ overrides) or an explicit device object. Enforces the landscape
// invariant for this task; never silently coerces.
function normalizeDeviceProfile(input = {}) {
  let base = {};
  if (input.presetId) { const p = getPreset(input.presetId); if (!p) return typedError('PHOM_DEVICE_PRESET_NOT_FOUND', `unknown preset ${input.presetId}`); base = p; }
  const d = { ...base, ...stripUndefined(input) };
  const orientationType = d.orientationType || 'landscapePrimary';
  if (!ORIENTATIONS.includes(orientationType)) return typedError('PHOM_DEVICE_INVALID', `invalid orientation ${orientationType}`);
  const vw = Number(d.viewportWidth), vh = Number(d.viewportHeight);
  const sw = Number(d.screenWidth != null ? d.screenWidth : vw), sh = Number(d.screenHeight != null ? d.screenHeight : vh);
  const dsf = Number(d.deviceScaleFactor);
  if (!isPosInt(vw) || !isPosInt(vh)) return typedError('PHOM_DEVICE_INVALID', 'viewport width/height must be positive integers');
  if (!isPosInt(sw) || !isPosInt(sh)) return typedError('PHOM_DEVICE_INVALID', 'screen width/height must be positive integers');
  if (!(dsf > 0)) return typedError('PHOM_DEVICE_INVALID', 'deviceScaleFactor must be > 0');
  // Landscape invariant (§3): this task builds mobile LANDSCAPE profiles.
  if (orientationType.startsWith('landscape')) {
    if (!(vw > vh)) return typedError('PHOM_DEVICE_NOT_LANDSCAPE', 'landscape requires viewportWidth > viewportHeight');
    if (!(sw > sh)) return typedError('PHOM_DEVICE_NOT_LANDSCAPE', 'landscape requires screenWidth > screenHeight');
  }
  const angle = d.orientationAngle != null ? Number(d.orientationAngle) : (orientationType.startsWith('landscape') ? 90 : 0);
  const device = {
    id: d.id != null ? String(d.id) : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: d.name != null ? String(d.name) : (base.name || 'Mobile'),
    presetId: input.presetId || d.presetId || null,
    deviceFamily: d.deviceFamily || base.deviceFamily || 'Mobile',
    platform: d.platform || base.platform || 'Android',
    userAgent: d.userAgent || base.userAgent || '',
    viewportWidth: vw, viewportHeight: vh, screenWidth: sw, screenHeight: sh,
    deviceScaleFactor: dsf, mobile: d.mobile !== false, touch: d.touch !== false,
    maxTouchPoints: isPosInt(Number(d.maxTouchPoints)) ? Number(d.maxTouchPoints) : 5,
    orientationType, orientationAngle: angle,
  };
  return { ok: true, device };
}

// Map a normalized device to the CDP Emulation.* command params (stock Chrome).
// Callers apply these AFTER a target/session is bound, and reapply on navigation.
function toCdpEmulation(device) {
  if (!device) return null;
  const params = {
    deviceMetrics: {
      width: device.viewportWidth, height: device.viewportHeight,
      deviceScaleFactor: device.deviceScaleFactor, mobile: !!device.mobile,
      screenWidth: device.screenWidth, screenHeight: device.screenHeight,
      screenOrientation: { type: device.orientationType, angle: device.orientationAngle },
    },
    touch: { enabled: !!device.touch, maxTouchPoints: device.maxTouchPoints },
    emitTouchForMouse: { enabled: !!device.touch, configuration: 'mobile' },
  };
  if (device.userAgent) params.userAgent = { userAgent: device.userAgent, platform: device.platform || undefined };
  return params;
}

// The ordered CDP Emulation.* commands to apply a device (stock Chrome). Optional
// commands (userAgent) are only included when present. This is the single source of
// the apply sequence — phom-main iterates it, and tests assert it, so "mobile
// landscape" provably means device-metrics emulation, not a native window resize.
function emulationCommands(device) {
  const cdp = toCdpEmulation(device);
  if (!cdp) return [];
  const cmds = [
    { method: 'Emulation.setDeviceMetricsOverride', params: cdp.deviceMetrics },
    { method: 'Emulation.setTouchEmulationEnabled', params: cdp.touch },
    { method: 'Emulation.setEmitTouchEventsForMouse', params: cdp.emitTouchForMouse },
  ];
  if (cdp.userAgent) cmds.push({ method: 'Emulation.setUserAgentOverride', params: cdp.userAgent });
  return cmds;
}

// Public snapshot for UI/persistence (no secrets in a device profile by design).
function publicSnapshot(device) {
  if (!device) return null;
  return {
    id: device.id, name: device.name, presetId: device.presetId, deviceFamily: device.deviceFamily, platform: device.platform,
    viewportWidth: device.viewportWidth, viewportHeight: device.viewportHeight,
    screenWidth: device.screenWidth, screenHeight: device.screenHeight,
    deviceScaleFactor: device.deviceScaleFactor, mobile: device.mobile, touch: device.touch, maxTouchPoints: device.maxTouchPoints,
    orientationType: device.orientationType, orientationAngle: device.orientationAngle,
    resolution: `${device.viewportWidth} × ${device.viewportHeight}`,
  };
}

function stripUndefined(o) { const out = {}; for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k]; return out; }

module.exports = { ORIENTATIONS, MOBILE_PRESETS, listPresets, getPreset, normalizeDeviceProfile, toCdpEmulation, emulationCommands, publicSnapshot };
