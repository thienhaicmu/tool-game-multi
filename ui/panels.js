'use strict';
// UI-only: resizable panels. No engine/IPC/data involvement.
(function () {
  const root = document.documentElement;
  const KEY = 'wvd-panels';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } })();
  const set = (name, px) => { root.style.setProperty(name, px + 'px'); saved[name] = px; try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* ignore */ } };
  for (const [k, v] of Object.entries(saved)) if (typeof v === 'number') root.style.setProperty(k, v + 'px');

  function drag(handle, onMove) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); handle.classList.add('drag');
      const move = (ev) => onMove(ev);
      const up = () => { handle.classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }
  const grid = document.querySelector('.grid');
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const g1 = document.querySelector('[data-gutter="1"]');
  if (g1 && grid) drag(g1, (e) => set('--col1', clamp(e.clientX - grid.getBoundingClientRect().left, 220, 640)));

  const g2 = document.querySelector('[data-gutter="2"]');
  const listCol = document.querySelector('.list-col');
  if (g2 && grid && listCol) drag(g2, (e) => {
    const start = grid.getBoundingClientRect().left + listCol.getBoundingClientRect().width + 5;
    set('--col2', clamp(e.clientX - start, 200, 560));
  });

  const vg = document.querySelector('[data-vgutter="1"]');
  if (vg) drag(vg, (e) => set('--editor-h', clamp(window.innerHeight - e.clientY, 120, Math.round(window.innerHeight * 0.6))));
})();
