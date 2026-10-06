'use strict';

// ---------------------------------------------------------------------------
// The Chromium PROFILE NAME of a persistent user-data-dir = the game account that plays in it (user 2026-10-06:
// "lấy tên account login làm tên cookie"). Chromium shows it on its profile button (tooltip + menu) — tested on 149:
// it reads the name from "Local State" (profile.info_cache.Default.name) at start and writes it back at exit, so the
// name is written while the browser is CLOSED, right before the tool launches it.
//
// Only the display name changes: cookies, logins and every other setting are untouched. A file that does not parse
// is left alone (never rewritten from scratch) — Chromium creates it on first start.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const MAX_NAME = 60;

function cleanName(name) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f]/g, '').trim();
  return s ? s.slice(0, MAX_NAME) : null;
}

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { missing: true }; }
  try { return { json: JSON.parse(text) }; } catch { return { broken: true }; }
}

function writeJson(file, json) {
  const tmp = file + '.phom-tmp';
  fs.writeFileSync(tmp, JSON.stringify(json));
  fs.renameSync(tmp, file);
}

// Set the display name of the "Default" profile in `userDataDir`. Returns { ok, changed, name } — never throws.
function applyProfileName(userDataDir, name) {
  const n = cleanName(name);
  if (!userDataDir || !n) return { ok: false, changed: false, name: n, reason: 'NO_NAME' };
  let changed = false;
  try {
    fs.mkdirSync(path.join(userDataDir, 'Default'), { recursive: true });
    // Local State — what the profile button shows
    const lsFile = path.join(userDataDir, 'Local State');
    const ls = readJson(lsFile);
    if (!ls.broken) {
      const j = ls.json && typeof ls.json === 'object' ? ls.json : {};
      j.profile = j.profile && typeof j.profile === 'object' ? j.profile : {};
      j.profile.info_cache = j.profile.info_cache && typeof j.profile.info_cache === 'object' ? j.profile.info_cache : {};
      const cur = j.profile.info_cache.Default && typeof j.profile.info_cache.Default === 'object' ? j.profile.info_cache.Default : {};
      if (cur.name !== n || cur.is_using_default_name !== false) {
        j.profile.info_cache.Default = { ...cur, name: n, is_using_default_name: false };
        writeJson(lsFile, j); changed = true;
      }
    }
    // Default/Preferences — the profile's own copy of its name
    const prFile = path.join(userDataDir, 'Default', 'Preferences');
    const pr = readJson(prFile);
    if (!pr.broken) {
      const j = pr.json && typeof pr.json === 'object' ? pr.json : {};
      j.profile = j.profile && typeof j.profile === 'object' ? j.profile : {};
      if (j.profile.name !== n || j.profile.using_default_name !== false) {
        j.profile.name = n; j.profile.using_default_name = false;
        writeJson(prFile, j); changed = true;
      }
    }
    return { ok: true, changed, name: n };
  } catch (e) {
    return { ok: false, changed, name: n, reason: String(e && e.message || e) };
  }
}

// The game account last seen playing in each profile (profile key → account name), kept in one small JSON file.
function createAccountNameStore(file) {
  let cache = null;
  const load = () => { if (cache) return cache; const r = readJson(file); cache = r.json && typeof r.json === 'object' ? r.json : {}; return cache; };
  return {
    get(key) { const v = load()[String(key)]; return cleanName(v); },
    // returns true when it changed (and was saved)
    set(key, account) {
      const k = String(key == null ? '' : key); const a = cleanName(account);
      if (!k || !a) return false;
      const all = load();
      if (all[k] === a) return false;
      all[k] = a;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeJson(file, all); } catch { /* best effort */ }
      return true;
    },
  };
}

module.exports = { applyProfileName, createAccountNameStore, cleanName, MAX_NAME };
