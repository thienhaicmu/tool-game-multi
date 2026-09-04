// Focused Aviator control shell: pure presentation logic (mode + nav map).
// UI-only, no engine/IPC. Browser global (window.AppShell) + Node module for tests.
// It only decides which view/mode is active; it never owns protocol state (that
// stays in RoundObserver / AutoRunner / AmountValidator snapshots).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AppShell = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // WU-D.1 — final product IA (browser-centric, Vietnamese). The rail = Trình duyệt;
  // the workspace tabs are the per-selected-browser tasks. Manual/Amount Check/Observer
  // are secondary tools reached from the "advanced" (Nâng cao) view, not primary tabs.
  const VIEWS = ['overview', 'auto', 'history', 'advanced'];
  // Only the Auto workspace is powered by a reused slide-in panel; overview/history/
  // advanced are sections in #shell-main.
  const PANEL_FOR_VIEW = { auto: 'at-panel' };
  const STORAGE_KEY = 'wvd-advanced';

  // Default on a fresh install is product control mode (advanced OFF).
  function loadMode(getItem) {
    try { return getItem(STORAGE_KEY) === '1' ? 'advanced' : 'product'; } catch { return 'product'; }
  }
  function saveMode(setItem, mode) {
    try { setItem(STORAGE_KEY, mode === 'advanced' ? '1' : '0'); } catch { /* ignore */ }
  }
  const isAdvanced = (mode) => mode === 'advanced';

  // WU11.1 — the one Auto-Run CTA changes label/action by runner state.
  function autoCta(state, running) {
    if (running) return { action: 'stop', label: '■ DỪNG TỰ ĐỘNG', note: 'Đang chạy tự động', cls: 'danger' };
    if (state === 'COMPLETED') return { action: 'start', label: '↻ CHẠY LẠI', note: 'Tự dừng — đã chạy hết lượt', cls: 'primary' };
    if (state === 'STOPPED') return { action: 'start', label: '▶ BẮT ĐẦU LẠI', note: 'Bạn đã nhấn Dừng', cls: 'primary' };
    return { action: 'start', label: '▶ BẮT ĐẦU TỰ ĐỘNG', note: '', cls: 'primary' };
  }

  return { VIEWS, PANEL_FOR_VIEW, STORAGE_KEY, loadMode, saveMode, isAdvanced, autoCta };
});
