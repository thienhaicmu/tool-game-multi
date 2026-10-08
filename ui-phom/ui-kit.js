'use strict';

// Phỏm QA tool window — the DOM kit: el / icons / notes / the generic dialog / the bell. Pure: no app state.
(function () {
  const UI = window.PhomUI = window.PhomUI || {};
  // ---------- DOM helpers ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') n.className = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) { if (kid == null || kid === false) continue; n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid); }
    return n;
  }
  const $ = (id) => document.getElementById(id);
  const ICON_PATHS = {
    refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    play: '<path d="m7 4 13 8-13 8Z"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
    rec: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3" fill="currentColor"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/><path d="M3 12h18"/>',
    folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  };
  function icon(name) {
    const span = document.createElement('span');
    span.innerHTML = `<svg class="lucide" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
    return span.firstChild;
  }
  // icon-only button — always with a tooltip + aria-label
  function iconButton(name, title, onClick, variant) {
    return el('button', { class: 'icon-btn' + (variant ? ' ' + variant : ''), title, 'aria-label': title, onclick: onClick }, icon(name));
  }
  const playerLabel = (b) => { const m = /^(?:B|P|Player\s+)(\d+)$/i.exec(String(b == null ? '' : b)); return m ? 'P' + m[1] : String(b == null ? '' : b); };
  const money = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : Number(n).toLocaleString('vi-VN'));
  function errText(res) { const e = res && res.error; return e ? `${e.code}: ${e.message}` : 'Thao tác thất bại.'; }
  function note(msg, warn) { const n = $('phq-note'); if (n) { n.textContent = msg || ''; n.className = 'note ' + (warn ? 'warn' : 'ok'); } }
  function noteText() { const n = $('phq-note'); return n ? n.textContent : ''; }

  function openDialog(title, sub) {
    document.querySelectorAll('.overlay').forEach((n) => n.remove());
    const overlay = el('div', { class: 'overlay' });
    const close = () => overlay.remove();
    const body = el('div', { class: 'dialog-body' });
    overlay.appendChild(el('div', { class: 'dialog', role: 'dialog', 'aria-label': title },
      el('div', { class: 'dialog-h' }, el('div', null, el('b', null, title), sub ? el('div', { class: 'muted' }, sub) : null), el('button', { class: 'btn ghost', onclick: close, 'aria-label': 'Đóng' }, '✕')),
      body));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    document.body.appendChild(overlay);
    return { overlay, body, close };
  }

  // 🔔 the 4th player is ready: three bell strikes in the tool window (WebAudio, nothing to ship)
  function ringBell(times = 4) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ctx = ringBell.ctx || (ringBell.ctx = new AC());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      // A ringing bell (user 2026-10-05: "vang vang"): the inharmonic partials of a real bell, each decaying on its
      // own (the low hum lasts longest), a short echo for the ring, and a compressor so it is loud but never clips.
      const out = ctx.createDynamicsCompressor(); out.threshold.value = -14; out.ratio.value = 4; out.connect(ctx.destination);
      const echo = ctx.createDelay(1); echo.delayTime.value = 0.22;
      const fb = ctx.createGain(); fb.gain.value = 0.32;
      echo.connect(fb); fb.connect(echo); echo.connect(out);
      const BASE = 660;
      const PARTIALS = [[0.5, 0.30, 2.8], [1, 0.42, 2.4], [1.19, 0.20, 1.8], [1.56, 0.16, 1.4], [2, 0.22, 1.2], [2.74, 0.10, 0.9], [3.76, 0.06, 0.7]];
      for (let i = 0; i < times; i++) {
        const t = ctx.currentTime + i * 0.85;
        for (const [ratio, g, dur] of PARTIALS) {
          const o = ctx.createOscillator(); const v = ctx.createGain();
          o.type = 'sine'; o.frequency.value = BASE * ratio;
          v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(g, t + 0.008); v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(v); v.connect(out); v.connect(echo); o.start(t); o.stop(t + dur + 0.05);
        }
      }
    } catch { /* no sound device — the notice still shows */ }
  }
  Object.assign(UI, { el, $, icon, iconButton, playerLabel, money, errText, note, noteText, openDialog, ringBell });
})();
