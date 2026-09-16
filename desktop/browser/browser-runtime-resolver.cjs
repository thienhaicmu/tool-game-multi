'use strict';

const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// PHASE 6.3.2.2 — BROWSER RUNTIME RESOLVER.
// The Phỏm tool launches each browser from either the pinned CUSTOM CHROMIUM runtime (the packaged build)
// or GOOGLE CHROME STABLE as a fallback/alternative. This pure resolver decides which executable to use
// for a given preference, WITHOUT ever hard-coding a single Chrome path: it probes the well-known Windows
// install locations (Program Files / Program Files (x86) / LOCALAPPDATA) plus an explicit override env.
//
// The custom Chromium's own file is also named chrome.exe, so kind is decided by SOURCE (which resolver
// produced it), never by filename. Returns { ok, kind:'chromium'|'chrome', executable, version, source,
// preference, fellBack } or a typed error. fileExists is injectable so the decision is unit-testable.
// ---------------------------------------------------------------------------

const CHROME_REL = path.join('Google', 'Chrome', 'Application', 'chrome.exe');

// Well-known Google Chrome Stable locations on Windows (order = preference).
function chromeCandidates(env = process.env) {
  const e = env || {};
  const out = [];
  const pf = e['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  out.push(path.join(pf, CHROME_REL));
  out.push(path.join(pf86, CHROME_REL));
  const local = e['LOCALAPPDATA'] || (e['USERPROFILE'] ? path.join(e['USERPROFILE'], 'AppData', 'Local') : null);
  if (local) out.push(path.join(local, CHROME_REL));
  return out;
}

// Resolve Google Chrome Stable: an explicit PHOM_CHROME_PATH override wins, else the first well-known
// candidate that exists on disk. Never hard-codes a single path.
function resolveGoogleChrome({ env = process.env, fileExists = fs.existsSync } = {}) {
  const override = env && env.PHOM_CHROME_PATH ? String(env.PHOM_CHROME_PATH).trim() : '';
  if (override) {
    if (fileExists(override)) return { ok: true, kind: 'chrome', executable: override, source: 'PHOM_CHROME_PATH' };
    return { ok: false, error: { code: 'PHOM_CHROME_PATH_NOT_FOUND', message: `PHOM_CHROME_PATH does not exist: ${override}` } };
  }
  for (const cand of chromeCandidates(env)) { try { if (fileExists(cand)) return { ok: true, kind: 'chrome', executable: cand, source: 'well-known' }; } catch { /* keep probing */ } }
  return { ok: false, error: { code: 'PHOM_CHROME_NOT_FOUND', message: 'Không tìm thấy Google Chrome. Hãy cài Chrome hoặc dùng Custom Chromium.' } };
}

// Decide the browser runtime for a launch.
//   preference: 'AUTO' | 'CUSTOM_CHROMIUM' | 'GOOGLE_CHROME'
//   customChromium: the resolveAndValidate() result of the pinned Chromium runtime ({ ok, executable, version })
// AUTO prefers the custom Chromium and falls back to Chrome (fellBack:true, so the caller can log it).
function resolveBrowserRuntime({ preference = 'AUTO', customChromium = null, env = process.env, fileExists = fs.existsSync } = {}) {
  const pref = String(preference || 'AUTO').toUpperCase();
  const custom = customChromium && customChromium.ok && customChromium.executable
    ? { ok: true, kind: 'chromium', executable: customChromium.executable, version: customChromium.version || null, source: 'custom-runtime' }
    : null;

  if (pref === 'GOOGLE_CHROME') {
    const c = resolveGoogleChrome({ env, fileExists });
    return c.ok ? { ...c, version: c.version || null, preference: pref, fellBack: false } : { ...c, preference: pref };
  }
  if (pref === 'CUSTOM_CHROMIUM') {
    if (custom) return { ...custom, preference: pref, fellBack: false };
    return { ok: false, error: { code: 'PHOM_CUSTOM_CHROMIUM_UNAVAILABLE', message: 'Custom Chromium runtime không khả dụng.' }, preference: pref };
  }
  // AUTO — custom Chromium first (the packaged runtime), else fall back to Chrome (logged by the caller).
  if (custom) return { ...custom, preference: 'AUTO', fellBack: false };
  const c = resolveGoogleChrome({ env, fileExists });
  if (c.ok) return { ...c, version: c.version || null, preference: 'AUTO', fellBack: true };
  return { ok: false, error: { code: 'PHOM_NO_BROWSER_RUNTIME', message: 'Không có Custom Chromium và cũng không tìm thấy Google Chrome.' }, preference: 'AUTO' };
}

const PREFERENCES = Object.freeze(['AUTO', 'CUSTOM_CHROMIUM', 'GOOGLE_CHROME']);
function normalizePreference(p) { const v = String(p == null ? 'AUTO' : p).toUpperCase(); return PREFERENCES.includes(v) ? v : 'AUTO'; }

module.exports = { resolveBrowserRuntime, resolveGoogleChrome, chromeCandidates, normalizePreference, PREFERENCES };
