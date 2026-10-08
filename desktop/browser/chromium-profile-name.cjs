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

// ---------------------------------------------------------------------------
// The profile FOLDER (where Chromium keeps the cookies) carries the same name (user 2026-10-06 "làm cho đồng bộ"):
// browser-profiles/<account or the tool's profile name>. The tool's profile id stays the key — the profile store's
// folders() map (id → folder, desktop/phom/stores/profile-store.cjs) remembers which folder is whose. The folder is
// renamed right before a launch, while that profile's browser is closed; everything inside (cookies, logins) moves
// with it. When the rename is not possible (a file still in use) the current folder is used — a launch is never
// blocked by a name.
// ---------------------------------------------------------------------------
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
function folderNameOf(name) {
  let s = String(name == null ? '' : name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/, '').trim().slice(0, MAX_NAME);
  if (!s || WIN_RESERVED.test(s)) return null;
  return s;
}

// → { dir, folder, renamedFrom } — never throws. root = .../browser-profiles; key = the tool's profile id.
function resolveProfileDir({ root, key, name, map, fsx = fs }) {
  const k = String(key == null ? '' : key) || 'X';
  const exists = (d) => { try { return fsx.statSync(d).isDirectory(); } catch { return false; } };
  const mapped = map.get(k);
  let current = mapped && exists(path.join(root, mapped)) ? mapped : (exists(path.join(root, k)) ? k : null); // k = the old id-named folder
  const wanted = folderNameOf(name) || folderNameOf(k) || 'X';
  const others = new Set(Object.entries(map.all()).filter(([kk]) => kk !== k).map(([, f]) => String(f).toLowerCase()));
  // a free name: not another profile's folder, not an existing folder that is not ours
  let target = wanted;
  for (let i = 2; (others.has(target.toLowerCase()) || (exists(path.join(root, target)) && (!current || target.toLowerCase() !== current.toLowerCase()))) && i < 100; i++) target = `${wanted} (${i})`;
  if (!current) {
    try { fsx.mkdirSync(path.join(root, target), { recursive: true }); } catch { /* best effort */ }
    map.set(k, target);
    return { dir: path.join(root, target), folder: target, renamedFrom: null };
  }
  if (current === target) { if (mapped !== current) map.set(k, current); return { dir: path.join(root, current), folder: current, renamedFrom: null }; }
  try {
    fsx.renameSync(path.join(root, current), path.join(root, target));
    map.set(k, target);
    return { dir: path.join(root, target), folder: target, renamedFrom: current };
  } catch (e) {
    if (mapped !== current) map.set(k, current);
    return { dir: path.join(root, current), folder: current, renamedFrom: null, renameError: String(e && e.code || e) };
  }
}

module.exports = { applyProfileName, cleanName, MAX_NAME, folderNameOf, resolveProfileDir };
