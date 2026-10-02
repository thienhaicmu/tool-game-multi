'use strict';

// ---------------------------------------------------------------------------
// BROWSER AGENT — the ONLY per-browser rendering choice a Phỏm profile still has:
//
//   WEB    — the browser's own desktop identity (nothing is overridden)
//   MOBILE — a mobile user-agent string, so the site serves its mobile build
//
// That is the whole model. There is no device picker, no viewport/screen/scale
// override, and no touch emulation any more, because all of that was what made the
// game lag: the old profiles ran the Cocos canvas through
// Emulation.setDeviceMetricsOverride with a deviceScaleFactor of 2–3, so a 600×338
// game was rendered at 1200×676 (or 2340×1080) backing pixels and then scaled back
// down — three times over, one per browser — while setTouchEmulationEnabled +
// setEmitTouchEventsForMouse synthesised a touch event for every mouse move and
// --touch-events=enabled pushed the page onto the touch code path.
//
// Now every browser renders at its NATIVE window size and scale (the window itself
// is the viewport), which is also the web's maximum size: DEFAULT_VIEWPORT, the size
// the old default profile used (600×338, 16:9), inside a window of
// defaultWindowSize() so three of them tile on one 1920×1080 monitor.
//
// SCOPE: rendering/identity only. No anti-detection, fingerprint or client-hint
// spoofing, and never any credential/proxy/cookie material.
// ---------------------------------------------------------------------------

const AGENTS = Object.freeze(['WEB', 'MOBILE']);
// A new profile is a web profile unless the user picks mobile (user's choice 2026-10-03). Profiles already saved keep
// the agent stored with them.
const DEFAULT_AGENT = 'WEB';

// The mobile identity. One string, not a device catalog: nothing else about the
// browser changes, so there is nothing for a second "device" to mean.
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const MOBILE_PLATFORM = 'Android';

// The one game viewport = the one window size. The web is never rendered larger than
// this, and never scaled: the page gets exactly these CSS pixels because the window's
// content area is exactly this big.
const DEFAULT_VIEWPORT = Object.freeze({ width: 600, height: 338 });
// Allowance for the Chromium window frame + tab strip/address bar around the content.
const WINDOW_CHROME = Object.freeze({ frameWidth: 16, chromeHeight: 120 });

const LABELS = Object.freeze({ WEB: 'Agent Web', MOBILE: 'Agent Mobile' });

function typedError(code, message) { return { ok: false, error: { code, message } }; }

// The OUTER size of a Phỏm browser window: the default viewport plus the chrome
// allowance, so the page itself gets DEFAULT_VIEWPORT.
function defaultWindowSize(opts = {}) {
  const frameW = Number.isFinite(opts.frameWidth) ? opts.frameWidth : WINDOW_CHROME.frameWidth;
  const chromeH = Number.isFinite(opts.chromeHeight) ? opts.chromeHeight : WINDOW_CHROME.chromeHeight;
  return { width: DEFAULT_VIEWPORT.width + frameW, height: DEFAULT_VIEWPORT.height + chromeH };
}

// normalizeAgent(input) -> { ok, agent } | typed error. Accepts the agent string, an
// object carrying one ({ agent }), nothing (→ the default), or a legacy device object
// from a profile saved before this change (its `mobile`/`userAgent` decide).
function normalizeAgent(input) {
  if (input == null || input === '') return { ok: true, agent: DEFAULT_AGENT };
  if (typeof input === 'string') {
    const a = input.trim().toUpperCase();
    if (!AGENTS.includes(a)) return typedError('PHOM_AGENT_INVALID', `unknown agent ${input}`);
    return { ok: true, agent: a };
  }
  if (typeof input === 'object') {
    if (input.agent != null) return normalizeAgent(input.agent);
    // Legacy device profile: a mobile UA / mobile metrics meant the mobile build.
    if (input.mobile === true || (typeof input.userAgent === 'string' && /Mobile|Android|iPhone/i.test(input.userAgent))) return { ok: true, agent: 'MOBILE' };
    if (input.mobile === false || input.userAgent === '') return { ok: true, agent: 'WEB' };
    return { ok: true, agent: DEFAULT_AGENT };
  }
  return typedError('PHOM_AGENT_INVALID', `unknown agent ${String(input)}`);
}

// The ordered CDP commands that apply an agent. MOBILE overrides the user agent and
// nothing else; WEB sends nothing at all, so the browser keeps its own identity.
// There is deliberately no setDeviceMetricsOverride / setTouchEmulationEnabled here:
// those are what the game lagged on, and the window is the viewport now.
function emulationCommands(agent) {
  const norm = normalizeAgent(agent);
  if (!norm.ok || norm.agent !== 'MOBILE') return [];
  return [{ method: 'Emulation.setUserAgentOverride', params: { userAgent: MOBILE_USER_AGENT, platform: MOBILE_PLATFORM } }];
}

// Public snapshot for the UI / persistence.
function publicSnapshot(agent) {
  const norm = normalizeAgent(agent);
  const a = norm.ok ? norm.agent : DEFAULT_AGENT;
  return {
    agent: a,
    label: LABELS[a],
    userAgent: a === 'MOBILE' ? MOBILE_USER_AGENT : null,
    viewportWidth: DEFAULT_VIEWPORT.width, viewportHeight: DEFAULT_VIEWPORT.height,
    resolution: `${DEFAULT_VIEWPORT.width} × ${DEFAULT_VIEWPORT.height}`,
  };
}

module.exports = {
  AGENTS, DEFAULT_AGENT, LABELS, MOBILE_USER_AGENT, MOBILE_PLATFORM,
  DEFAULT_VIEWPORT, WINDOW_CHROME, defaultWindowSize,
  normalizeAgent, emulationCommands, publicSnapshot,
};
