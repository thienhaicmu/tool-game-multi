'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.2 / 6.3.8 — the in-Chromium GAME HEADER (BROWSER CONTROL). Every managed Chromium (B1/B2/B3)
// gets a compact, tool-OWNED control injected into its page. PHASE 6.3.8 reshapes it into a single
// COMPACT, DRAGGABLE, FLOATING header row (mobile-landscape friendly, ~851×393) that never obstructs the
// game: a player badge (B1/B2/B3 accent) + status + a STATE-DEPENDENT icon row of the ONLY existing
// actions (VÀO GAME → TÌM BÀN/VÀO BÀN → REJOIN + THOÁT PHÒNG, plus RELOAD/STOP/FOCUS), a ⋮ quick menu,
// and a ─ collapse toggle. It never mutates the game's own DOM/canvas/data (its own #__phom_header only).
//
// The bar is a DUMB view: the MAIN process derives the state (deriveHeaderState) from the authoritative
// coordinator snapshot and pushes it in via window.__phomHeaderRender(state); button clicks call the CDP
// binding window.__phomAction(JSON.stringify({action,stake})). No business logic lives in the page.
// This module is PURE (a string generator + pure derivers) so it is unit-testable without a browser.
// ---------------------------------------------------------------------------

// PHASE 6.3.8 — icon + short label + tooltip for every header action. The action SET is state-dependent
// (deriveHeaderState) but the presentation (icon/label/tip) is a single source of truth. NO new actions are
// invented here: every id maps to an existing tool action (ENTER_GAME/FIND/JOIN_SHARED/JOIN/REJOIN/LEAVE and
// the lifecycle RELOAD/STOP/FOCUS). HOST/READY/KICK/DevTools/screenshot are intentionally absent (no action).
const HEADER_ACTIONS = Object.freeze({
  ENTER_GAME:  { icon: '▶', short: 'Vào Game', tip: 'Đưa Player vào game' },
  FIND:        { icon: '🔍', short: 'Tìm Bàn', tip: 'Tìm bàn phù hợp theo mức cược' },
  CANCEL_FIND: { icon: '⛔', short: 'Hủy Tìm', tip: 'Dừng tìm bàn ngay' },
  JOIN_SHARED: { icon: '🚪', short: 'Vào Bàn', tip: 'Vào bàn đã tìm được (RID chia sẻ)' },
  JOIN:        { icon: '🚪', short: 'Vào Bàn', tip: 'Vào bàn' },
  REJOIN:      { icon: '↻', short: 'Rejoin', tip: 'Vào lại bàn hiện tại' },
  LEAVE:       { icon: '✕', short: 'Leave', tip: 'Rời bàn hiện tại (không tắt Chromium)' },
  WAIT_ANCHOR: { icon: '⏳', short: 'Chờ', tip: 'Chờ Player được chọn tìm bàn' },
  RELOAD:      { icon: '⟳', short: 'Reload', tip: 'Tải lại web trong Chromium (giữ profile)' },
  STOP:        { icon: '⏻', short: 'Tắt', tip: 'Tắt Chromium này (không xóa profile)' },
  FOCUS:       { icon: '↑', short: 'Lên trước', tip: 'Đưa cửa sổ Chromium lên trên cùng' },
});
function actionMeta(action) { return HEADER_ACTIONS[action] || { icon: '•', short: action || '', tip: action || '' }; }
// Attach icon/short/tip to a primary/secondary descriptor for the icon-row renderer (presentation only).
function toActionIcon(a) {
  if (!a || !a.action) return null;
  const m = actionMeta(a.action);
  return {
    action: a.action, icon: m.icon, short: m.short, tip: m.tip,
    label: a.label != null ? a.label : m.short,
    disabled: !!a.disabled, busy: !!a.busy, danger: !!a.danger,
    rid: a.rid != null ? a.rid : undefined,
    needsBet: !!a.needsBet, betOptions: Array.isArray(a.betOptions) ? a.betOptions.slice() : undefined,
  };
}

// Derive the header view-model for ONE browser from its authoritative fields (§4/§15). Mirrors the manual
// browserAction decision + REJOIN/THOÁT PHÒNG. PHASE 6.3.8 ALSO exposes `actions` (the ordered GAME/TABLE
// icon set for the row); the lifecycle (RELOAD/STOP/FOCUS) + chrome (⋮/─) are static page UI, not state.
//   view = { account, opened, inGame, entering, joining, manualState, rid, lastRid, sharedRid,
//            betOptions, isFinder, finderIndex, error }
function deriveHeaderState(view = {}) {
  const account = view.account && String(view.account).trim() ? String(view.account) : '—';
  const rid = view.rid != null ? String(view.rid) : (view.lastRid != null ? String(view.lastRid) : '—');
  const betOptions = Array.isArray(view.betOptions) ? view.betOptions.slice() : [];
  const s = view.manualState;
  const joinedShared = !!view.inGame && s === 'JOINED' && view.rid != null && view.sharedRid != null && Number(view.rid) === Number(view.sharedRid);
  const joined = !!view.inGame && s === 'JOINED' && view.rid != null;
  let statusLabel, statusClass, primary, secondary = [];
  if (!view.opened) { statusLabel = 'CHƯA MỞ'; statusClass = 'off'; primary = { action: 'ENTER_GAME', label: 'VÀO GAME', disabled: true }; }
  else if (view.entering) { statusLabel = 'ĐANG VÀO GAME'; statusClass = 'warn'; primary = { action: 'ENTER_GAME', label: 'ĐANG VÀO GAME…', busy: true, disabled: true }; }
  else if (!view.inGame) { statusLabel = 'CHƯA VÀO GAME'; statusClass = 'off'; primary = { action: 'ENTER_GAME', label: 'VÀO GAME' }; }
  // §32/§34 — a persistent search can run for up to a minute, so it reports PROGRESS (elapsed + how many times
  // the server was asked) and its primary button becomes HỦY. A disabled "ĐANG TÌM BÀN…" for 60s is
  // indistinguishable from a hang, and left the user no way out.
  else if (s === 'SEARCHING') {
    const el = Number(view.searchElapsedSec) > 0 ? ` ${Number(view.searchElapsedSec)}s` : '';
    const at = Number(view.searchAttempt) > 0 ? ` · lần ${Number(view.searchAttempt)}` : '';
    statusLabel = `ĐANG TÌM BÀN…${el}${at}`; statusClass = 'warn';
    primary = { action: 'CANCEL_FIND', label: 'HỦY TÌM', danger: true };
  }
  else if (view.joining || s === 'JOINING' || s === 'RECONNECTING') { statusLabel = 'ĐANG VÀO BÀN'; statusClass = 'warn'; primary = { action: 'JOIN', label: 'ĐANG VÀO BÀN…', busy: true, disabled: true }; }
  else if (joined) { statusLabel = 'ĐÃ VÀO BÀN'; statusClass = 'ok'; primary = { action: 'REJOIN', label: 'REJOIN' }; secondary = [{ action: 'LEAVE', label: 'THOÁT PHÒNG', danger: true }]; }
  else if (view.sharedRid != null) { statusLabel = 'ĐÃ VÀO GAME'; statusClass = 'ok'; primary = { action: 'JOIN_SHARED', label: 'VÀO BÀN', rid: Number(view.sharedRid) }; }
  // PHASE 6.3.6 — the finder is the USER's explicit choice (view.finderIndex), NEVER defaulted to Player 1.
  // A non-finder (isFinder === false, i.e. a finder WAS chosen and it isn't this browser) with no shared RID
  // yet must NOT discover: it shows a waiting state (disabled) so it can never send CMD 300 / JOIN a self-found
  // table. isFinder defaults to allowed (undefined ⇒ every browser may FIND until a finder is chosen).
  else if (view.isFinder === false) { const fno = view.finderIndex != null ? view.finderIndex : '?'; statusLabel = 'ĐÃ VÀO GAME'; statusClass = 'ok'; primary = { action: 'WAIT_ANCHOR', label: 'CHỜ PLAYER ' + fno + ' TÌM BÀN', disabled: true }; }
  else { statusLabel = 'ĐÃ VÀO GAME'; statusClass = 'ok'; primary = { action: 'FIND', label: 'TÌM BÀN', needsBet: true, betOptions }; }
  // PHASE 6.3.8 — the ordered GAME/TABLE icon set (primary first, then secondary). Lifecycle is added by the page.
  const actions = [toActionIcon(primary), ...secondary.map(toActionIcon)].filter(Boolean);
  return { account, rid, statusLabel, statusClass, primary, secondary, actions, error: view.error || null, joinedShared,
    // TEST D — whether THIS browser is being recorded, and the last capture file name (for the ⋯ menu)
    capturing: !!view.capturing, lastCapture: view.lastCapture || null };
}

// The one-time page bootstrap script (injected via Page.addScriptToEvaluateOnNewDocument + evaluated
// immediately). Idempotent: builds #__phom_header once; exposes window.__phomHeaderRender(state). Button
// clicks call the CDP binding window.__phomAction. Namespaced; no game-DOM mutation beyond its own bar.
function bootScript(opts = {}) {
  const bindingName = opts.bindingName || '__phomAction';
  const identity = { slotId: opts.slotId != null ? String(opts.slotId) : null, profileId: opts.profileId != null ? String(opts.profileId) : null, runId: opts.runId != null ? String(opts.runId) : null };
  const obsLog = opts.observerLog ? 'true' : 'false';
  const clickLog = opts.clickLog ? 'true' : 'false';
  return `(() => {
  const BID = ${JSON.stringify(bindingName)};
  const ID = ${JSON.stringify(identity)};
  const OBSLOG = ${obsLog};
  const CLICKLOG = ${clickLog};
  // 6.3.2.10 PROFILING (gated) — a single-clock page timer: stamp at click, report at the next header render.
  const CLK = (window.performance && performance.now) ? function(){ return performance.now(); } : function(){ return Date.now(); };
  // 6.3.2.2 idempotent + SELF-HEALING: if the boot already ran but the game wiped the bar out of the DOM
  // (SPA body swap), re-mount it instead of returning early — so the header can never silently vanish.
  if (window.__phomHeaderInstalled) { if (!document.getElementById('__phom_header') && window.__phomHeaderMount) window.__phomHeaderMount(); return; }
  window.__phomHeaderInstalled = true;
  // Every action carries the browser IDENTITY (slot/profile/run) + a correlation actionId so a single
  // click can be traced end-to-end and can NEVER be attributed to the wrong browser.
  function emit(action, extra){ try { var aid=(Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)); if(CLICKLOG){ window.__phClickT=CLK(); window.__phClickA=action; try{ console.log('[PHOM-CLK] CLICK_START', action, aid, ID.slotId||ID.runId); }catch(e){} } if(OPTIMISTIC_ACTIONS[action]) applyOptimistic(action); window[BID] && window[BID](JSON.stringify(Object.assign({ action, actionId: aid, slotId: ID.slotId, profileId: ID.profileId, runId: ID.runId }, extra||{}))); } catch(e){} }
  // Only the GAME/TABLE flow actions paint an optimistic busy overlay; lifecycle (RELOAD/STOP/FOCUS) do not.
  var OPTIMISTIC_ACTIONS = { ENTER_GAME:1, FIND:1, JOIN_SHARED:1, JOIN:1, REJOIN:1, LEAVE:1, CANCEL_FIND:1 };
  // 6.3.2.11 OPTIMISTIC visual state (page-local only). __authState = last AUTHORITATIVE state pushed by main;
  // __optAction = a transient action the user just clicked. The click paints an immediate busy state with NO
  // CDP/main round-trip; the next authoritative __phomHeaderRender CLEARS it and wins. Only the status/action
  // LABEL is optimistic — never RID/ACCOUNT/membership (those stay authoritative, §15).
  var __authState = null, __optAction = null;
  // Page-local UI state only (no persistent web storage — a new document resets it, F5-safe like optimistic).
  var __collapsed = false;
  // Report the header's REAL DOM presence to main (once per mount/remount) so the Tool shows HEADER = Sẵn sàng.
  function emitStatus(){ try { window[BID] && window[BID](JSON.stringify({ action:'__HEADER_STATUS', present:true, slotId: ID.slotId, profileId: ID.profileId, runId: ID.runId })); } catch(e){} }
  // PHASE 6.3.8 — per-player accent (B1 blue / B2 green / B3 orange) + "Player N" derived from the slot id.
  // Player number from the slot id. Two schemes exist: 'B1'/'B2'/'B3' and the Tool's 'A'/'B'/'C' — the header only
  // understood the first, so a browser on slot 'B' showed a bare "Player" with no number and no accent colour.
  var SLOTN = (function(){ var sid=String(ID.slotId||''); var m=/^B(\\d)$/i.exec(sid); if(m) return Number(m[1]); var abc={A:1,B:2,C:3}[sid.toUpperCase()]; return abc||null; })();
  var ACCENT = SLOTN===1?'#2563eb':SLOTN===2?'#16a34a':SLOTN===3?'#ea580c':'#6b7280';
  const mk = (t,s)=>{const e=document.createElement(t);if(s)e.setAttribute('style',s);return e;};
  // ---- the floating, compact, single-row header (mobile-landscape; never a full-width toolbar) ----
  const bar = document.createElement('div'); bar.id = '__phom_header';
  bar.setAttribute('style','position:fixed;top:8px;right:8px;z-index:2147483647;display:flex;align-items:center;gap:6px;height:36px;max-width:calc(100vw - 16px);padding:0 6px 0 8px;background:rgba(17,24,39,.96);color:#e5e7eb;border:1px solid #374151;border-left:3px solid '+ACCENT+';border-radius:10px;font:600 12px/1 Inter,Segoe UI,system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.35);user-select:none;');
  // drag handle = badge + name + status (dragging the identity area moves the whole control).
  const handle = mk('div','display:flex;align-items:center;gap:7px;cursor:move;min-width:0;');
  const badge = mk('span','display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:20px;padding:0 6px;border-radius:6px;background:'+ACCENT+';color:#fff;font-weight:800;font-size:11px;'); badge.textContent = ID.slotId||'B?';
  const nameEl = mk('span','font-weight:700;color:#e5e7eb;white-space:nowrap;'); nameEl.textContent = SLOTN?('Player '+SLOTN):'Player';
  const statusDot = mk('span','width:8px;height:8px;border-radius:50%;background:#9ca3af;flex:0 0 auto;');
  const stLabel = mk('span','color:#cbd5e1;font-weight:500;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
  handle.appendChild(badge); handle.appendChild(nameEl); handle.appendChild(statusDot); handle.appendChild(stLabel);
  const act = mk('div','display:flex;align-items:center;gap:5px;'); act.id='__ph_act';
  const menuWrap = mk('div','position:relative;display:flex;align-items:center;gap:4px;');
  const menuBtn = mk('button','width:26px;height:26px;border-radius:7px;border:1px solid #374151;background:#1f2937;color:#e5e7eb;cursor:pointer;font-size:14px;line-height:1;'); menuBtn.textContent='⋮'; menuBtn.title='Tùy chọn';
  const collapseBtn = mk('button','width:26px;height:26px;border-radius:7px;border:1px solid #374151;background:#1f2937;color:#e5e7eb;cursor:pointer;font-size:13px;line-height:1;'); collapseBtn.title='Thu gọn / mở rộng';
  const menu = mk('div','position:absolute;top:30px;right:0;min-width:200px;background:#111827;border:1px solid #374151;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.4);padding:4px;display:none;z-index:2147483647;');
  menuWrap.appendChild(menuBtn); menuWrap.appendChild(collapseBtn); menuWrap.appendChild(menu);
  bar.appendChild(handle); bar.appendChild(act); bar.appendChild(menuWrap);
  // Mount idempotently (floating overlay — does NOT push the game view). On a real (re)mount, tell main.
  function ready(){ if(document.body){ if(!document.getElementById('__phom_header')){ document.body.appendChild(bar); emitStatus(); } } else { requestAnimationFrame(ready); } }
  window.__phomHeaderMount = ready; // allow the bridge / render to re-mount after an SPA body swap
  ready();
  // REAL self-heal (§5) — a Cocos/SPA bootstrap that rebuilds <body> AFTER load removes the bar. NARROW
  // in-PAGE observers re-mount the bar the instant it is removed — NEVER observing the whole game DOM.
  var __c = { observerCallbacks:0, mutationRecords:0, remountRequests:0, actualRemounts:0 };
  window.__phomHeaderCounters = __c;
  var __remountScheduled = false;
  function scheduleRemount(){
    if (document.getElementById('__phom_header')) return;                 // present → no-op (loop-safe §5)
    __c.remountRequests++;
    if (__remountScheduled) return; __remountScheduled = true;
    requestAnimationFrame(function(){ __remountScheduled = false; if(!document.getElementById('__phom_header')){ __c.actualRemounts++; if(OBSLOG){ try{ console.log('[PHOM-HDR] remount', ID.slotId||ID.runId, JSON.stringify(__c)); }catch(e){} } ready(); } });
  }
  try {
    if (!window.__phomHeaderObserver && typeof MutationObserver !== 'undefined') {
      var __bodyObs = null, __bodyTarget = null;
      var observeBody = function(){
        if (!document.body || __bodyTarget === document.body) return;      // already watching this body
        if (__bodyObs) { try{ __bodyObs.disconnect(); }catch(e){} }
        __bodyTarget = document.body;
        __bodyObs = new MutationObserver(function(m){ __c.observerCallbacks++; __c.mutationRecords += m.length; scheduleRemount(); });
        __bodyObs.observe(document.body, { childList: true, subtree: false });
        if (OBSLOG){ try{ console.log('[PHOM-HDR] observe body', ID.slotId||ID.runId); }catch(e){} }
      };
      var __htmlObs = new MutationObserver(function(m){ __c.observerCallbacks++; __c.mutationRecords += m.length; observeBody(); scheduleRemount(); });
      __htmlObs.observe(document.documentElement, { childList: true, subtree: false }); // body replace/create
      observeBody();
      window.__phomHeaderObserver = { disconnect: function(){ try{ __htmlObs.disconnect(); }catch(e){} try{ if(__bodyObs) __bodyObs.disconnect(); }catch(e){} } };
      window.addEventListener('pagehide', function(){ try { window.__phomHeaderObserver.disconnect(); } catch(e){} window.__phomHeaderObserver = null; }, { once:true });
    }
  } catch(e){}
  // ---- draggable (clamped inside the viewport; position persisted per profile) ----
  var __drag=null;
  handle.addEventListener('mousedown', function(ev){ if(ev.button!==0) return; var r=bar.getBoundingClientRect(); __drag={dx:ev.clientX-r.left, dy:ev.clientY-r.top}; ev.preventDefault(); });
  window.addEventListener('mousemove', function(ev){ if(!__drag) return; var x=ev.clientX-__drag.dx, y=ev.clientY-__drag.dy; x=Math.max(0,Math.min(window.innerWidth-bar.offsetWidth,x)); y=Math.max(0,Math.min(window.innerHeight-bar.offsetHeight,y)); bar.style.left=x+'px'; bar.style.top=y+'px'; bar.style.right='auto'; });
  window.addEventListener('mouseup', function(){ __drag=null; });
  // ---- one compact icon button (icon + optional short label + tooltip; disabled/busy aware) ----
  function iconBtn(icon, label, showLabel, dis, danger, onClick, tip){
    var bg = danger ? '#7f1d1d' : '#2563eb'; var bd = danger ? '#991b1b' : '#1d4ed8';
    var b = mk('button', 'display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 '+(showLabel?'10px':'8px')+';border-radius:7px;border:1px solid '+bd+';background:'+bg+';color:#fff;font:600 12px Inter,Segoe UI,sans-serif;cursor:'+(dis?'not-allowed':'pointer')+';opacity:'+(dis?'.5':'1')+';white-space:nowrap;');
    b.textContent = showLabel ? (icon+' '+label) : icon; b.title = tip || label || '';
    if(dis) b.disabled = true; else if(onClick) b.onclick = onClick;
    return b;
  }
  function lifeBtn(icon, danger, onClick, tip){
    var b = mk('button','width:26px;height:26px;border-radius:7px;border:1px solid '+(danger?'#991b1b':'#374151')+';background:'+(danger?'#7f1d1d':'#1f2937')+';color:#e5e7eb;cursor:pointer;font-size:13px;line-height:1;');
    b.textContent = icon; b.title = tip || ''; b.onclick = onClick; return b;
  }
  function menuItem(label, onClick){ var it=mk('div','padding:8px 10px;border-radius:6px;cursor:pointer;color:#e5e7eb;font-weight:500;white-space:nowrap;'); it.textContent=label; it.onmouseenter=function(){it.style.background='#1f2937';}; it.onmouseleave=function(){it.style.background='transparent';}; it.onclick=function(){ try{onClick();}catch(e){} menu.style.display='none'; }; return it; }
  menuBtn.onclick = function(){ menu.style.display = menu.style.display==='none'?'block':'none'; };
  collapseBtn.onclick = function(){ __collapsed=!__collapsed; paint(__authState||{ statusLabel:'', statusClass:'off' }); };
  // Clicking outside closes the quick menu.
  window.addEventListener('mousedown', function(ev){ if(menu.style.display!=='none' && !menuWrap.contains(ev.target)) menu.style.display='none'; }, true);
  // Paint ONE state object (authoritative OR optimistic). The GAME/TABLE actions come from state.actions
  // (fallback: state.primary); the lifecycle (RELOAD/STOP) is ALWAYS available; the ⋮ menu holds FOCUS.
  function paint(state){
    if(!document.getElementById('__phom_header')) ready();
    var sc = state.statusClass;
    statusDot.style.background = sc==='ok'?'#34d399':sc==='warn'?'#fbbf24':sc==='danger'?'#f87171':'#9ca3af';
    stLabel.textContent = state.statusLabel||'';
    collapseBtn.textContent = __collapsed ? '▸' : '─';
    act.textContent='';
    act.style.display = __collapsed ? 'none' : 'flex';
    if(!__collapsed){
      var acts = (Array.isArray(state.actions) && state.actions.length) ? state.actions : (state.primary ? [Object.assign({ icon:'•' }, state.primary)] : []);
      acts.forEach(function(a, i){
        var showLabel = i===0; // primary shows a label; the rest are icon-only (compact)
        if (a.needsBet && Array.isArray(a.betOptions) && a.betOptions.length){
          var sel = mk('select','height:26px;padding:0 6px;border-radius:7px;border:1px solid #374151;background:#111827;color:#e5e7eb;font:600 12px Inter,Segoe UI,sans-serif;');
          var o0=mk('option'); o0.value=''; o0.textContent='CƯỢC…'; sel.appendChild(o0);
          a.betOptions.forEach(function(v){ var o=mk('option'); o.value=String(v); o.textContent=String(v); sel.appendChild(o); });
          act.appendChild(sel);
          // BUGFIX (6.3.9) — the FIND button must ALWAYS carry its onclick (the click guards on a chosen stake).
          // Creating it "disabled" dropped the handler, so picking a stake left FIND dead. Now it is always
          // clickable; the empty-stake state is shown by style only, and the click is a no-op until a stake is set.
          var fb=iconBtn(a.icon||'🔍','Tìm Bàn', true, false, false, function(){ if(sel.value) emit('FIND',{ stake:Number(sel.value) }); }, a.tip);
          var syncFb=function(){ var ok=!!sel.value; fb.style.opacity=ok?'1':'.5'; fb.style.cursor=ok?'pointer':'not-allowed'; };
          syncFb(); sel.onchange=syncFb;
          act.appendChild(fb);
        } else {
          act.appendChild(iconBtn(a.icon||'•', a.short||a.label||a.action, showLabel, !!a.disabled, !!a.danger, (function(ac){ return function(){ emit(ac.action, ac.rid!=null?{ rid:ac.rid }:null); }; })(a), a.tip));
        }
      });
      // Lifecycle (always available): RELOAD + STOP.
      act.appendChild(lifeBtn('⟳', false, function(){ emit('RELOAD'); }, 'Tải lại web trong Chromium'));
      act.appendChild(lifeBtn('⏻', true, function(){ emit('STOP'); }, 'Tắt Chromium này'));
      if(state.error){ var e=mk('span','color:#f87171;font-size:13px;cursor:help;'); e.textContent='⚠'; e.title=String(state.error); act.appendChild(e); }
    }
    // Quick menu (⋮): FOCUS + a read-only account line. Only actions that actually exist.
    menu.textContent='';
    menu.appendChild(menuItem('↑ Đưa cửa sổ lên trên cùng', function(){ emit('FOCUS'); }));
    menu.appendChild(menuItem('⟳ Tải lại web', function(){ emit('RELOAD'); }));
    menu.appendChild(menuItem('⏻ Tắt Chromium', function(){ emit('STOP'); }));
    // TEST D — record THIS browser's own game frames while the player acts by hand (e.g. clicks a table).
    menu.appendChild(menuItem(state.capturing ? '⏹ Dừng & lưu ghi gói (Test D)' : '⏺ Bắt đầu ghi gói (Test D)', function(){ emit(state.capturing ? 'CAPTURE_STOP' : 'CAPTURE_START'); }));
    if(state.lastCapture){ var cap=mk('div','padding:6px 10px;color:#86efac;font-weight:500;white-space:nowrap;'); cap.textContent='📄 Đã lưu: '+state.lastCapture; menu.appendChild(cap); }
    var info = mk('div','padding:8px 10px;color:#9ca3af;font-weight:500;border-top:1px solid #1f2937;margin-top:2px;white-space:nowrap;');
    info.textContent = (SLOTN?('Player '+SLOTN):'Player') + ' · ' + (state.account||'—') + (state.rid && state.rid!=='—' ? ' · RID '+state.rid : '');
    menu.appendChild(info);
    // 6.3.2.10 PROFILING (gated) — click→visual in ONE (page) clock on the FIRST paint after a click.
    if(CLICKLOG && window.__phClickT!=null){ try{ console.log('[PHOM-CLK] CLICK_TO_RENDER', Math.round(CLK()-window.__phClickT)+'ms', 'action='+window.__phClickA, '->', state.statusLabel||''); }catch(e){} window.__phClickT=null; }
  }
  // Build the minimal OPTIMISTIC busy state for a just-clicked action. Reuses ACCOUNT/RID from the last
  // authoritative state (never fabricates them); only the status label + a disabled busy primary are new.
  function optState(action){
    var base = __authState || {};
    var label = action==='ENTER_GAME' ? 'ĐANG VÀO GAME…'
      : action==='FIND' ? 'ĐANG TÌM BÀN…'
      : (action==='JOIN_SHARED'||action==='JOIN') ? 'ĐANG VÀO BÀN…'
      : action==='REJOIN' ? 'ĐANG VÀO BÀN…'
      : action==='LEAVE' ? 'ĐANG THOÁT PHÒNG…'
      : action==='CANCEL_FIND' ? 'ĐANG HỦY TÌM…'
      : 'ĐANG XỬ LÝ…';
    return { account: base.account, rid: base.rid, statusLabel: label, statusClass:'warn', primary:{ action: action, label: label, disabled: true, busy: true }, actions: [{ action: action, icon:(OPT_ICON[action]||'•'), short:label, label:label, disabled:true, busy:true }], secondary: [], error: null };
  }
  var OPT_ICON = { ENTER_GAME:'▶', FIND:'🔍', JOIN_SHARED:'🚪', JOIN:'🚪', REJOIN:'↻', LEAVE:'✕', CANCEL_FIND:'⛔' };
  // Synchronous, page-local: show the busy state the instant the user clicks — no CDP, no main round-trip.
  function applyOptimistic(action){ try { __optAction = action; paint(optState(action)); } catch(e){} }
  // AUTHORITATIVE render from main ALWAYS wins: store it, clear any optimistic overlay, paint it.
  window.__phomHeaderRender = function(state){ try { __authState = state; __optAction = null; paint(state); } catch(e){} };
})();`;
}

// 6.3.2.11 — PURE mirror of the in-page optimistic logic (for unit tests + a single source of truth for the
// busy labels). optimisticState(action, authState) is what the page paints synchronously on click: only the
// status label + a disabled busy primary are new; ACCOUNT/RID are reused from the authoritative state and
// never fabricated (§15). deriveEffectiveHeaderState picks the optimistic overlay when set, else authState.
function optimisticLabel(action) {
  switch (action) {
    case 'ENTER_GAME': return 'ĐANG VÀO GAME…';
    case 'FIND': return 'ĐANG TÌM BÀN…';
    case 'JOIN_SHARED': case 'JOIN': return 'ĐANG VÀO BÀN…';
    case 'REJOIN': return 'ĐANG VÀO BÀN…';
    case 'LEAVE': return 'ĐANG THOÁT PHÒNG…';
    case 'CANCEL_FIND': return 'ĐANG HỦY TÌM…';
    default: return 'ĐANG XỬ LÝ…';
  }
}
function optimisticState(action, authState) {
  const base = authState || {};
  const label = optimisticLabel(action);
  return { account: base.account, rid: base.rid, statusLabel: label, statusClass: 'warn', primary: { action, label, disabled: true, busy: true }, secondary: [], error: null };
}
function deriveEffectiveHeaderState({ authState = null, optAction = null } = {}) {
  return optAction ? optimisticState(optAction, authState) : authState;
}

// PHASE 6.3.6 — BOUNDED ENTER ("VÀO GAME") state. The in-engine tile click is INVOKED != ENTERED (the click
// firing is NOT proof the game was entered — readiness is only the authoritative Simms session evidence
// socketReady+connected+channelList → inGame). So the ENTERING flag MUST be temporary: it is shown only while
// the enter is genuinely in flight — pending AND not yet authoritatively inGame AND within a bounded window
// since the click. A click that fired but never entered (page stayed/returned to lobby) therefore reverts to
// NOT_IN_GAME ("VÀO GAME") instead of a permanent "ĐANG VÀO GAME…" (§10/§11). Transport/CDP/header health is
// NEVER treated as IN_GAME. Pure + deterministic (clock injected) so it is unit-testable without a browser.
const ENTER_GAME_TIMEOUT_MS = 15000;
function enteringActive({ pending = false, inGame = false, startedAt = null, now = 0, timeoutMs = ENTER_GAME_TIMEOUT_MS } = {}) {
  if (!pending || inGame) return false;          // authoritative IN_GAME (or nothing pending) always wins
  if (startedAt == null) return true;            // pending but no clock yet → just-clicked, still active
  return (Number(now) - Number(startedAt)) < Number(timeoutMs); // bounded: stale ENTER reverts to NOT_IN_GAME
}

module.exports = { deriveHeaderState, bootScript, optimisticLabel, optimisticState, deriveEffectiveHeaderState, enteringActive, ENTER_GAME_TIMEOUT_MS, HEADER_ACTIONS };
