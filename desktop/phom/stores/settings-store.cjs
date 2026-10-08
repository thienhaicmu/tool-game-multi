'use strict';

// ---------------------------------------------------------------------------
// SETTINGS STORE (3.2) — the tool's own choices in ONE small JSON file (phom-settings.json), one owner, atomic write.
// Before 3.2 each choice had its own file written by its own code in phom-main (stake.json, window-layout.json,
// browser-runtime.json, window-state.json).
//
//   get(key)          the saved value (the declared default when none, normalized)
//   set(key, value)   normalize → save → the value kept
//
// Every key is DECLARED ({ default, normalize }) — an unknown key is a programming error, not a new file entry.
// MIGRATION: a declared key may name the legacy file it used to live in (+ how to read its value). On the first load
// the legacy files are copied into backupDir and their values taken over ONCE (a value already in the new file wins;
// the file records legacyMerged). They are left in place, so an older build on the same machine keeps its settings.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try { return { json: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return e && e.code === 'ENOENT' ? { missing: true } : { broken: true }; }
}
function writeJsonAtomic(file, json) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// keys: { name: { default, normalize?(v) → v, legacy?: { file, pick(json) → value } } }
function createSettingsStore({ file, keys, backupDir = null, log = () => {} }) {
  const decl = keys || {};
  const norm = (k, v) => { const d = decl[k]; if (!d) throw new Error('unknown setting ' + k); try { return d.normalize ? d.normalize(v) : v; } catch { return d.default; } };
  let values = null;
  let merged = false;

  function migrate(base) {
    const legacy = Object.entries(decl).filter(([, d]) => d.legacy && d.legacy.file && fs.existsSync(d.legacy.file));
    if (!legacy.length) return { changed: false, files: [] };
    const files = [...new Set(legacy.map(([, d]) => d.legacy.file))];
    if (backupDir) {
      fs.mkdirSync(backupDir, { recursive: true });
      for (const f of files) { try { fs.copyFileSync(f, path.join(backupDir, path.basename(f))); } catch { /* the original stays */ } }
    }
    for (const [k, d] of legacy) {
      if (base[k] !== undefined) continue; // the new file wins
      const r = readJson(d.legacy.file);
      if (!r.json) continue;
      try { const v = d.legacy.pick ? d.legacy.pick(r.json) : r.json; if (v !== undefined && v !== null) base[k] = norm(k, v); } catch { /* unreadable → default */ }
    }
    return { changed: true, files };
  }

  function save() { writeJsonAtomic(file, { version: 1, legacyMerged: merged, values }); }

  function load() {
    if (values) return values;
    const r = readJson(file);
    const base = r.json && typeof r.json === 'object' && r.json.values && typeof r.json.values === 'object' ? { ...r.json.values } : {};
    if (r.broken) log('settings-broken', { file: path.basename(file) });
    merged = !!(r.json && r.json.legacyMerged === true);
    // a broken file is never overwritten by a migration (the user may want it back)
    const m = merged || r.broken ? { changed: false, files: [] } : migrate(base);
    values = base;
    if (m.changed) {
      merged = true;
      try { save(); log('settings-migrated', { files: m.files.map((f) => path.basename(f)) }); } catch { merged = false; /* merged again next start */ }
    }
    return values;
  }

  return {
    get(key) {
      const v = load()[key];
      if (!decl[key]) throw new Error('unknown setting ' + key);
      return v === undefined ? decl[key].default : norm(key, v);
    },
    set(key, value) {
      const v = norm(key, value);
      load()[key] = v;
      try { save(); } catch { /* best effort: kept in memory */ }
      return v;
    },
    file: () => file,
  };
}

module.exports = { createSettingsStore };
