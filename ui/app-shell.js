// WU11 — Focused Protocol Tester shell: pure presentation logic (mode + nav map).
// UI-only, no engine/IPC. Browser global (window.AppShell) + Node module for tests.
// It only decides which view/mode is active; it never owns protocol state (that
// stays in RoundObserver / AutoRunner / AmountValidator snapshots).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AppShell = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const VIEWS = ['overview', 'manual', 'auto', 'btest'];
  // Which existing WU7-10.2 panel powers each test view (reused, not duplicated).
  const PANEL_FOR_VIEW = { manual: 'proto-panel', auto: 'at-panel', btest: 'bv-panel' };
  const STORAGE_KEY = 'wvd-advanced';

  // Default on a fresh install is Protocol Test mode (advanced OFF) (§19).
  function loadMode(getItem) {
    try { return getItem(STORAGE_KEY) === '1' ? 'advanced' : 'product'; } catch { return 'product'; }
  }
  function saveMode(setItem, mode) {
    try { setItem(STORAGE_KEY, mode === 'advanced' ? '1' : '0'); } catch { /* ignore */ }
  }
  const isAdvanced = (mode) => mode === 'advanced';

  // WU11.1 — the one Auto-Run CTA changes label/action by runner state.
  function autoCta(state, running) {
    if (running) return { action: 'stop', label: '■ STOP AUTO RUN', note: 'AUTO RUNNING', cls: 'danger' };
    if (state === 'COMPLETED') return { action: 'start', label: '↻ RUN AGAIN', note: '✓ RUN COMPLETE', cls: 'primary' };
    if (state === 'STOPPED') return { action: 'start', label: '▶ START NEW RUN', note: 'STOPPED', cls: 'primary' };
    return { action: 'start', label: '▶ START AUTO RUN', note: '', cls: 'primary' };
  }

  return { VIEWS, PANEL_FOR_VIEW, STORAGE_KEY, loadMode, saveMode, isAdvanced, autoCta };
});
