'use strict';

// ---------------------------------------------------------------------------
// Device profile for the Phỏm QA browsers. A profile has TWO independent axes:
//   • OS WINDOW              — the native Chromium (desktop) window size on Windows.
//   • VIEWPORT / EMULATION   — the CSS px viewport + screen + DSF + mobile/touch/UA
//                              applied via CDP Emulation.*. NEVER a native window resize.
// The two axes are independent (§8): a Desktop OS Window of 960×540 may host a
// mobile-landscape viewport of 851×393 (touch on) — the OS window is not shrunk to
// match the emulated viewport, and the emulated viewport is not stretched to match
// the OS window.
//
// Chromium Browser 1/2/3 are ALWAYS desktop Chromium OS windows on Windows (§1).
// A "mobile" profile only means the CDP emulation applies a mobile-landscape
// viewport + touch + mobile UA inside a desktop OS window.
//
// SCOPE: rendering emulation only. This module does NOT port anti-detection /
// fingerprint / attestation / client-hint spoofing (those stay OUT_OF_SCOPE). No
// credentials/proxy/cookies are ever part of a device profile.
// ---------------------------------------------------------------------------

const ORIENTATIONS = Object.freeze(['landscapePrimary', 'landscapeSecondary', 'portraitPrimary', 'portraitSecondary']);

// Profile TYPE classifies the profile shape (§3). It is a display/categorization
// label; the numeric OS Window + Viewport fields are what actually drive geometry
// and CDP. CUSTOM is the free-form combination (any OS window + any viewport).
const PROFILE_TYPES = Object.freeze(['DESKTOP', 'LAPTOP', 'LAPTOP_SMALL', 'MOBILE_LANDSCAPE', 'DESKTOP_16_9', 'CUSTOM']);

// Mobile-landscape presets. These predate the OS-Window/Viewport split (§11 —
// existing profiles must keep working); they carry ONLY viewport dimensions, so
// the OS window is derived at consumption time (viewport + chrome allowance).
// The value of `screenWidth`/`screenHeight` equals the viewport (fullscreen mobile
// web view). Every mobile preset is tagged `profileType: 'MOBILE_LANDSCAPE'`.
const MOBILE_PRESETS = Object.freeze([
  Object.freeze({ id: 'android-pixel5-landscape', name: 'Pixel 5 (Ngang)', profileType: 'MOBILE_LANDSCAPE', deviceFamily: 'Pixel 5', platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    osWindowWidth: null, osWindowHeight: null,
    viewportWidth: 851, viewportHeight: 393, screenWidth: 851, screenHeight: 393, deviceScaleFactor: 2.75, mobile: true, touch: true, maxTouchPoints: 5,
    orientationType: 'landscapePrimary', orientationAngle: 90 }),
  Object.freeze({ id: 'android-galaxy-s20-landscape', name: 'Galaxy S20 (Ngang)', profileType: 'MOBILE_LANDSCAPE', deviceFamily: 'Galaxy S20', platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    osWindowWidth: null, osWindowHeight: null,
    viewportWidth: 800, viewportHeight: 360, screenWidth: 800, screenHeight: 360, deviceScaleFactor: 3, mobile: true, touch: true, maxTouchPoints: 5,
    orientationType: 'landscapePrimary', orientationAngle: 90 }),
  Object.freeze({ id: 'android-generic-412-landscape', name: 'Android 12 (Ngang)', profileType: 'MOBILE_LANDSCAPE', deviceFamily: 'Android Generic', platform: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 12; moto g power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    osWindowWidth: null, osWindowHeight: null,
    viewportWidth: 915, viewportHeight: 412, screenWidth: 915, screenHeight: 412, deviceScaleFactor: 2.625, mobile: true, touch: true, maxTouchPoints: 5,
    orientationType: 'landscapePrimary', orientationAngle: 90 }),
]);

// Desktop / laptop / mixed presets. Each carries an explicit OS Window size that
// is INDEPENDENT of its viewport (§2/§7). The Laptop-Small + Mobile-Landscape
// preset is the important case: a 960×540 desktop OS window with a 851×393 mobile
// landscape viewport (touch on) inside — exactly the "small laptop but game
// renders landscape like a phone" scenario in the spec.
const DESKTOP_PRESETS = Object.freeze([
  // §6.3.13 — STANDARD DISPLAY PRESET for 22"/24" monitors. This is the DEFAULT for
  // NEW profiles (§3). Game viewport = 600×338 (16:9). OS window is DERIVED (null
  // osWindow → viewport + chrome allowance = 616×458), so three B1/B2/B3 windows tile
  // side-by-side on a single 1920×1080 monitor (3×616 + gaps = 1864 ≤ 1920). Mobile +
  // touch emulation stays ON (§8) — the Cocos game needs it; the "Desktop 22/24"" tag
  // describes the DISPLAY, not the emulation.
  Object.freeze({ id: 'desktop-22-24-16x9', name: 'Desktop 22/24" — 16:9', profileType: 'DESKTOP_16_9', deviceFamily: 'Desktop 22/24"', platform: 'Windows',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    osWindowWidth: null, osWindowHeight: null,
    viewportWidth: 600, viewportHeight: 338, screenWidth: 600, screenHeight: 338, deviceScaleFactor: 2, mobile: true, touch: true, maxTouchPoints: 5,
    orientationType: 'landscapePrimary', orientationAngle: 90 }),
  Object.freeze({ id: 'desktop-1920x1080', name: 'Desktop 1920×1080', profileType: 'DESKTOP', deviceFamily: 'Desktop', platform: 'Windows',
    userAgent: '',
    osWindowWidth: 1920, osWindowHeight: 1080,
    viewportWidth: 1920, viewportHeight: 1080, screenWidth: 1920, screenHeight: 1080, deviceScaleFactor: 1, mobile: false, touch: false, maxTouchPoints: 0,
    orientationType: 'landscapePrimary', orientationAngle: 0 }),
  Object.freeze({ id: 'laptop-1366x768', name: 'Laptop 1366×768', profileType: 'LAPTOP', deviceFamily: 'Laptop', platform: 'Windows',
    userAgent: '',
    osWindowWidth: 1366, osWindowHeight: 768,
    viewportWidth: 1366, viewportHeight: 768, screenWidth: 1366, screenHeight: 768, deviceScaleFactor: 1, mobile: false, touch: false, maxTouchPoints: 0,
    orientationType: 'landscapePrimary', orientationAngle: 0 }),
  Object.freeze({ id: 'laptop-small-960x540', name: 'Laptop Small 960×540', profileType: 'LAPTOP_SMALL', deviceFamily: 'Laptop', platform: 'Windows',
    userAgent: '',
    osWindowWidth: 960, osWindowHeight: 540,
    viewportWidth: 960, viewportHeight: 540, screenWidth: 960, screenHeight: 540, deviceScaleFactor: 1, mobile: false, touch: false, maxTouchPoints: 0,
    orientationType: 'landscapePrimary', orientationAngle: 0 }),
  Object.freeze({ id: 'laptop-small-mobile-landscape', name: 'Laptop Small · Mobile Ngang', profileType: 'CUSTOM', deviceFamily: 'Laptop + Mobile', platform: 'Windows',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    osWindowWidth: 960, osWindowHeight: 540,
    viewportWidth: 851, viewportHeight: 393, screenWidth: 851, screenHeight: 393, deviceScaleFactor: 2.75, mobile: true, touch: true, maxTouchPoints: 5,
    orientationType: 'landscapePrimary', orientationAngle: 90 }),
]);

// The full catalog (mobile + desktop). getPreset() looks up across both; the UI
// uses listProfilePresets() to render every option. listPresets() keeps the
// legacy mobile-only surface so no existing caller/test regresses.
const PROFILE_PRESETS = Object.freeze([...MOBILE_PRESETS, ...DESKTOP_PRESETS]);

function typedError(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }
function isPosInt(n) { return Number.isInteger(n) && n > 0; }

// Legacy: only the mobile-landscape presets. Existing callers/tests continue to
// see the same three entries (§11 — no compatibility break).
function listPresets() { return MOBILE_PRESETS.map((p) => ({ ...p })); }
// Full preset catalog (mobile + desktop + laptop + mixed). Used by the new SETUP
// device dialog and by the IPC surface.
function listProfilePresets() { return PROFILE_PRESETS.map((p) => ({ ...p })); }
function getPreset(id) { const p = PROFILE_PRESETS.find((x) => x.id === String(id)); return p ? { ...p } : null; }

// normalizeDeviceProfile(input) -> { ok, device } | typed error. `input` may be a
// preset id (+ overrides) or an explicit device object. OS window and viewport are
// validated INDEPENDENTLY (§8/§12). Landscape invariant applies to the VIEWPORT
// only (a mobile-landscape viewport in a smaller desktop OS window is legal).
function normalizeDeviceProfile(input = {}) {
  let base = {};
  if (input.presetId) { const p = getPreset(input.presetId); if (!p) return typedError('PHOM_DEVICE_PRESET_NOT_FOUND', `unknown preset ${input.presetId}`); base = p; }
  const d = { ...base, ...stripUndefined(input) };
  const orientationType = d.orientationType || 'landscapePrimary';
  if (!ORIENTATIONS.includes(orientationType)) return typedError('PHOM_DEVICE_INVALID', `invalid orientation ${orientationType}`);
  const vw = Number(d.viewportWidth), vh = Number(d.viewportHeight);
  const sw = Number(d.screenWidth != null ? d.screenWidth : vw), sh = Number(d.screenHeight != null ? d.screenHeight : vh);
  const dsf = Number(d.deviceScaleFactor);
  // OS window (independent of viewport, §8). Optional — legacy mobile profiles
  // carry null and let the geometry layer derive a size from the viewport + chrome
  // allowance. When present, MUST be positive integers (§12).
  const oswRaw = d.osWindowWidth;
  const oshRaw = d.osWindowHeight;
  const osw = (oswRaw != null && oswRaw !== '') ? Number(oswRaw) : null;
  const osh = (oshRaw != null && oshRaw !== '') ? Number(oshRaw) : null;
  if (!isPosInt(vw) || !isPosInt(vh)) return typedError('PHOM_DEVICE_INVALID', 'viewport width/height must be positive integers');
  if (!isPosInt(sw) || !isPosInt(sh)) return typedError('PHOM_DEVICE_INVALID', 'screen width/height must be positive integers');
  if (osw !== null && !isPosInt(osw)) return typedError('PHOM_DEVICE_INVALID', 'osWindowWidth must be a positive integer');
  if (osh !== null && !isPosInt(osh)) return typedError('PHOM_DEVICE_INVALID', 'osWindowHeight must be a positive integer');
  // OS window and viewport can differ in either direction (§8); no cross-axis
  // invariant. A desktop 960×540 OS window with a 851×393 mobile viewport is legal.
  if (!(dsf > 0)) return typedError('PHOM_DEVICE_INVALID', 'deviceScaleFactor must be > 0');
  // Landscape invariant applies to the VIEWPORT only. The OS window is never
  // required to be landscape (a portrait/square desktop window with a landscape
  // mobile viewport is legal).
  if (orientationType.startsWith('landscape')) {
    if (!(vw > vh)) return typedError('PHOM_DEVICE_NOT_LANDSCAPE', 'landscape requires viewportWidth > viewportHeight');
    if (!(sw > sh)) return typedError('PHOM_DEVICE_NOT_LANDSCAPE', 'landscape requires screenWidth > screenHeight');
  }
  const angle = d.orientationAngle != null ? Number(d.orientationAngle) : (orientationType.startsWith('landscape') ? 90 : 0);
  const profileType = PROFILE_TYPES.includes(d.profileType) ? d.profileType : (base.profileType || 'MOBILE_LANDSCAPE');
  const device = {
    id: d.id != null ? String(d.id) : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: d.name != null ? String(d.name) : (base.name || 'Device'),
    presetId: input.presetId || d.presetId || null,
    profileType,
    deviceFamily: d.deviceFamily || base.deviceFamily || 'Device',
    platform: d.platform || base.platform || 'Windows',
    userAgent: d.userAgent || base.userAgent || '',
    // OS window — the Chromium native window size on Windows. Null = derived from viewport at consumption.
    osWindowWidth: osw, osWindowHeight: osh,
    // Viewport / device emulation (CDP).
    viewportWidth: vw, viewportHeight: vh, screenWidth: sw, screenHeight: sh,
    deviceScaleFactor: dsf,
    mobile: d.mobile === true, touch: d.touch === true,
    maxTouchPoints: isPosInt(Number(d.maxTouchPoints)) ? Number(d.maxTouchPoints) : 5,
    orientationType, orientationAngle: angle,
  };
  return { ok: true, device };
}

// Map a normalized device to the CDP Emulation.* command params (stock Chrome).
// Callers apply these AFTER a target/session is bound, and reapply on navigation.
// The OS window is NOT part of this projection (it is a Chromium native window
// concern, applied by the launcher — §8).
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
    emitTouchForMouse: { enabled: !!device.touch, configuration: device.mobile ? 'mobile' : 'desktop' },
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
// Includes BOTH OS window and viewport info so the UI can render them separately.
function publicSnapshot(device) {
  if (!device) return null;
  const osw = device.osWindowWidth, osh = device.osWindowHeight;
  return {
    id: device.id, name: device.name, presetId: device.presetId, profileType: device.profileType || 'MOBILE_LANDSCAPE',
    deviceFamily: device.deviceFamily, platform: device.platform,
    osWindowWidth: osw, osWindowHeight: osh,
    osWindow: (osw && osh) ? `${osw} × ${osh}` : 'Desktop Window',
    viewportWidth: device.viewportWidth, viewportHeight: device.viewportHeight,
    screenWidth: device.screenWidth, screenHeight: device.screenHeight,
    deviceScaleFactor: device.deviceScaleFactor, mobile: !!device.mobile, touch: !!device.touch, maxTouchPoints: device.maxTouchPoints,
    orientationType: device.orientationType, orientationAngle: device.orientationAngle,
    resolution: `${device.viewportWidth} × ${device.viewportHeight}`,
  };
}

function stripUndefined(o) { const out = {}; for (const k of Object.keys(o)) if (o[k] !== undefined) out[k] = o[k]; return out; }

module.exports = {
  ORIENTATIONS, PROFILE_TYPES, MOBILE_PRESETS, DESKTOP_PRESETS, PROFILE_PRESETS,
  listPresets, listProfilePresets, getPreset,
  normalizeDeviceProfile, toCdpEmulation, emulationCommands, publicSnapshot,
};
