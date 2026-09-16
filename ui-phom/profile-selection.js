/* PHASE 6.3.1 — PROFILE SELECTION (pure, no DOM/IPC). The SETUP table's checkbox selection logic:
 * an ORDERED list of up to 3 profile ids (selection order → B1/B2/B3, §13), plus bulk-proxy mapping
 * by the same order (§21/§22). Dual-mode: attaches to window.ProfileSelection in the renderer and
 * exports via CommonJS for node tests. It never talks to the store — the renderer applies its results. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ProfileSelection = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MAX = 3;
  const sid = (v) => (v == null ? null : String(v));
  const arrOf = (s) => (Array.isArray(s) ? s.map(sid) : []);

  // Toggle a profile: remove if present (order recomputed), else append if there is room (max 3, §12).
  function toggle(selected, id) {
    id = sid(id); const arr = arrOf(selected);
    const i = arr.indexOf(id);
    if (i >= 0) return arr.filter((x) => x !== id);
    if (arr.length >= MAX) return arr; // full — 4th tick ignored
    return [...arr, id];               // append preserves SELECTION ORDER (§13)
  }
  function isSelected(selected, id) { return arrOf(selected).includes(sid(id)); }
  function canSelect(selected, id) { return isSelected(selected, id) || arrOf(selected).length < MAX; }
  function canSelectMore(selected) { return arrOf(selected).length < MAX; }
  function complete(selected) { return arrOf(selected).length === MAX; }
  function count(selected) { return arrOf(selected).length; }
  // The runtime browser label (B1/B2/B3) for a profile, by selection order — or null if unselected.
  function browserOf(selected, id) { const i = arrOf(selected).indexOf(sid(id)); return i >= 0 ? 'B' + (i + 1) : null; }
  // Drop any selected id no longer present in the store (e.g. after delete), preserving order (§11/§13).
  function prune(selected, validIds) { const set = new Set(arrOf(validIds)); return arrOf(selected).filter((x) => set.has(x)); }

  // Bulk proxy: one line per proxy; trim, drop blank lines (§22).
  function parseProxyLines(text) { return String(text == null ? '' : text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); }
  // Map proxy lines to the selected profiles BY ORDER (§21). All-or-nothing: line count must equal the
  // selection count (§22) — never a partial mapping, never silently drop extra lines.
  function mapProxies(selected, text) {
    const sel = arrOf(selected); const lines = parseProxyLines(text);
    if (!sel.length) return { ok: false, error: 'NO_SELECTION' };
    if (lines.length !== sel.length) return { ok: false, error: 'PROXY_COUNT_MISMATCH', expected: sel.length, got: lines.length };
    return { ok: true, mapping: sel.map((id, i) => ({ profileId: id, proxy: lines[i], browser: 'B' + (i + 1) })) };
  }

  return { MAX, toggle, isSelected, canSelect, canSelectMore, complete, count, browserOf, prune, parseProxyLines, mapProxies };
});
