'use strict';

// ---------------------------------------------------------------------------
// The IN-PAGE BAR — the reference tool's control strip, injected into every managed Chromium (screenshots + captures
// 2026-10-02/03):
//
//   1 nhatvuong452535 · ID 642487221   SS [7919569] Copy  Vào  ReJoin  Tạo  Dò Key  Thoát          Hide
//                 👑gdufuud-453384,nhatvuong452535-328627,thekiet2k4-431503✓          (yellow, centred)
// Lọc Bài (each account's safe cards) is in the Phỏm QA tool window, one column per account — not on the bars.
//
// No background: it sits over the game. The running button ends with '.' (Dò Key. / Tạo. / ReJoin. / Vào.) and a
// second click stops it. Before the browser is in the game the row shows only VÀO GAME (or TẢI LẠI when its frames
// stopped). What each button does: docs/phom-kich-ban.md §0b.
//
// The bar is a DUMB view: main derives the state (deriveHeaderState) from the coordinator + group and pushes it via
// window.__phomHeaderRender(state); clicks call the CDP binding window.__phomAction. It never touches the game's own
// DOM/canvas (only #__phom_header). This module is pure (a string generator + derivers), unit-testable.
// ---------------------------------------------------------------------------

const HEADER_ACTIONS = Object.freeze({
  ENTER_GAME:  { short: 'Vào Game', tip: 'Đưa acc vào game Phỏm' },
  JOIN_CODE:   { short: 'Vào', tip: 'Vào đúng số bàn trong ô SS' },
  REJOIN:      { short: 'ReJoin', tip: 'Tự vào lại sau mỗi lần bị đá' },
  LEAVE:       { short: 'Thoát', tip: 'Rời bàn (không tắt trình duyệt)' },
  FIND_TABLE:  { short: 'Dò Key', tip: 'MỘT acc: ngồi một mình ở bàn trống, thành KEY' },
  SCAN_TABLE:  { short: 'Tạo', tip: 'Các acc khác: dò ra bàn của KEY rồi vào' },
  CANCEL_FIND: { short: 'Dừng', tip: 'Dừng dò bàn' },
  RELOAD:      { short: 'Tải lại', tip: 'Tải lại web trong trình duyệt này' },
});

//   view = { account, accountId, money, opened, inGame, entering, dataStale, staleSec, manualState, searchKind,
//            searchElapsedSec, searchAttempt, rid, lastRid, joinedViaChannel, sharedRid, stake, groupRole, keySeated,
//            rejoinOn, playerCount, players, error }
function deriveHeaderState(view = {}) {
  const s = view.manualState;
  const joined = !!view.inGame && s === 'JOINED' && view.rid != null;
  let statusLabel, primary = null;
  if (!view.opened) { statusLabel = 'CHƯA MỞ'; primary = { action: 'ENTER_GAME', label: 'VÀO GAME', disabled: true }; }
  // Frames stopped arriving: the tool cannot know the real state, so it says so and offers the only fix.
  else if (view.dataStale) { statusLabel = 'MẤT DỮ LIỆU' + (view.staleSec ? ' ' + view.staleSec + 's' : '') + ' · TẢI LẠI'; primary = { action: 'RELOAD', label: 'TẢI LẠI WEB' }; }
  else if (view.entering) { statusLabel = 'ĐANG VÀO GAME'; primary = { action: 'ENTER_GAME', label: 'ĐANG VÀO GAME…', busy: true, disabled: true }; }
  else if (!view.inGame) { statusLabel = 'CHƯA VÀO GAME'; primary = { action: 'ENTER_GAME', label: 'VÀO GAME' }; }
  else if (s === 'KICKED') statusLabel = 'BỊ ĐÁ' + (view.rejoinOn ? ' · đang vào lại' : ' · bấm ReJoin');
  else if (s === 'SEARCHING') statusLabel = (view.searchKind === 'SCAN' ? 'ĐANG DÒ BÀN KEY' : 'ĐANG DÒ KEY') + (view.searchElapsedSec ? ' ' + view.searchElapsedSec + 's' : '') + (view.searchAttempt ? ' · lần ' + view.searchAttempt : '');
  else if (s === 'LEAVE_UNCONFIRMED') statusLabel = 'CHƯA XÁC NHẬN RỜI BÀN — bấm Thoát lại';
  else if (s === 'JOINING' || s === 'RECONNECTING') statusLabel = 'ĐANG VÀO BÀN';
  else if (joined) statusLabel = (view.joinedViaChannel ? 'KÊNH ' : 'SS ') + view.rid;
  else if (view.groupRole && view.sharedRid != null) statusLabel = 'NGOÀI BÀN · SS ' + view.sharedRid + ' · bấm ReJoin';
  else if (view.sharedRid != null) statusLabel = 'Ở SẢNH · SS ' + view.sharedRid + ' · bấm Vào';
  else if (view.keySeated) statusLabel = 'Ở SẢNH · KEY đã ngồi · bấm Tạo';
  else statusLabel = 'Ở SẢNH · bấm Dò Key (một acc)';
  return {
    account: view.account && String(view.account).trim() ? String(view.account) : '—',
    accountId: view.accountId != null ? String(view.accountId) : null,
    money: view.money != null ? Number(view.money) : null,
    rid: view.rid != null ? String(view.rid) : (view.lastRid != null ? String(view.lastRid) : '—'),
    statusLabel, primary, error: view.error || null,
    // the whole button row is there once the browser is in the game; the running one ends with '.'
    canAct: !!view.inGame && !view.dataStale,
    searchKind: s === 'SEARCHING' ? (view.searchKind || 'KEY') : null,
    joining: s === 'JOINING' || s === 'RECONNECTING',
    inTable: joined, joinedViaChannel: !!view.joinedViaChannel,
    playerCount: Number(view.playerCount) || 0,
    players: Array.isArray(view.players) ? view.players.map((p) => ({ name: String(p.name || '?'), money: p.money != null ? Number(p.money) : null, host: !!p.host, ready: !!p.ready, self: !!p.self, ours: !!p.ours })) : [],
    stake: Number(view.stake) > 0 ? Number(view.stake) : null,
    groupRole: view.groupRole || null, isKey: view.groupRole === 'KEY', keySeated: !!view.keySeated,
    rejoinOn: !!view.rejoinOn, canRejoin: joined || view.lastRid != null || view.sharedRid != null,
    // SS = the group's số bàn, else the table this browser sits at — never a stake CHANNEL (live run 2026-10-03: the
    // KEY's channel 139 landed in the SS box and every Vào with it was refused, code 166).
    ssDefault: view.sharedRid != null ? Number(view.sharedRid) : (joined && !view.joinedViaChannel ? Number(view.rid) : null),
  };
}

// The one-time page bootstrap (Page.addScriptToEvaluateOnNewDocument + evaluated at once). Idempotent: builds
// #__phom_header once and exposes window.__phomHeaderRender(state).
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
  // PROFILING (gated) — a single-clock page timer: stamp at click, report at the next render.
  const CLK = (window.performance && performance.now) ? function(){ return performance.now(); } : function(){ return Date.now(); };
  // Idempotent + SELF-HEALING: the boot already ran but the game wiped the bar (SPA body swap) → re-mount it.
  if (window.__phomHeaderInstalled) { if (!document.getElementById('__phom_header') && window.__phomHeaderMount) window.__phomHeaderMount(); return; }
  window.__phomHeaderInstalled = true;
  // Every action carries the browser IDENTITY + a correlation actionId, so a click can never be attributed to the
  // wrong browser.
  function emit(action, extra){ try { var aid=(Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)); if(CLICKLOG){ window.__phClickT=CLK(); window.__phClickA=action; try{ console.log('[PHOM-CLK] CLICK_START', action, aid, ID.slotId||ID.runId); }catch(e){} } if(OPTIMISTIC_ACTIONS[action]) applyOptimistic(action); window[BID] && window[BID](JSON.stringify(Object.assign({ action, actionId: aid, slotId: ID.slotId, profileId: ID.profileId, runId: ID.runId }, extra||{}))); } catch(e){} }
  // Only VÀO GAME paints an optimistic busy state; every table button shows its own state ('.') from main.
  var OPTIMISTIC_ACTIONS = { ENTER_GAME:1 };
  // __authState = last AUTHORITATIVE state from main; the next __phomHeaderRender always wins over an optimistic one.
  var __authState = null, __optAction = null;
  var __collapsed = false, __lastError = null;
  // The SS box is created ONCE and re-attached on every paint, so a repaint never wipes what the user is typing.
  var __ssValue = '';
  var __ssAuto = null; // the last số bàn the bar filled in by itself (a user edit is never overwritten)
  var ssInput = document.createElement('input');
  ssInput.setAttribute('style','width:58px;height:18px;padding:0 3px;box-sizing:border-box;border-radius:2px;border:1px solid #9ca3af;background:#fff;color:#111827;font:600 11px Inter,Segoe UI,sans-serif;');
  ssInput.placeholder = 'Số bàn'; ssInput.inputMode = 'numeric'; ssInput.setAttribute('aria-label', 'Số bàn muốn vào');
  ssInput.addEventListener('input', function(){ __ssValue = ssInput.value; });
  ssInput.addEventListener('mousedown', function(ev){ ev.stopPropagation(); });
  // The bar's REAL DOM presence goes to main once per mount/remount (Tool shows HEADER = Sẵn sàng).
  function emitStatus(){ try { window[BID] && window[BID](JSON.stringify({ action:'__HEADER_STATUS', present:true, slotId: ID.slotId, profileId: ID.profileId, runId: ID.runId })); } catch(e){} }
  // Player number from the slot id ('B1'/'B2'/'B3' or the tool's 'A'/'B'/'C').
  var SLOTN = (function(){ var sid=String(ID.slotId||''); var m=/^B(\\d)$/i.exec(sid); if(m) return Number(m[1]); var abc={A:1,B:2,C:3}[sid.toUpperCase()]; return abc||null; })();
  var ACCENT = SLOTN===1?'#2563eb':SLOTN===2?'#16a34a':SLOTN===3?'#ea580c':'#6b7280';
  const mk = (t,s)=>{const e=document.createElement(t);if(s)e.setAttribute('style',s);return e;};
  var SHADOW = 'text-shadow:0 1px 2px #000,0 0 3px #000;';
  // The strip: fixed across the top, NO background (it sits over the game), clicks pass through between controls.
  const bar = document.createElement('div'); bar.id = '__phom_header';
  bar.setAttribute('style','position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;align-items:center;gap:3px;flex-wrap:nowrap;box-sizing:border-box;height:22px;width:100%;padding:0 4px;background:transparent;color:#fff;font:600 11px/1 Inter,Segoe UI,system-ui,sans-serif;user-select:none;pointer-events:none;');
  bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Điều khiển Phỏm');
  const handle = mk('div','display:flex;align-items:center;gap:4px;min-width:0;flex-shrink:0;pointer-events:auto;');
  const badge = mk('span','display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;border-radius:4px;background:'+ACCENT+';color:#fff;font-weight:800;font-size:10px;'); badge.textContent = SLOTN ? String(SLOTN) : '?';
  const nameEl = mk('span','font-weight:700;color:#fff;white-space:nowrap;'+SHADOW); nameEl.style.display='none';
  handle.appendChild(badge); handle.appendChild(nameEl);
  const act = mk('div','display:flex;align-items:center;gap:3px;flex-wrap:nowrap;min-width:0;pointer-events:auto;'); act.id='__ph_act';
  const hideBtn = mk('button','margin-left:auto;flex-shrink:0;height:18px;padding:0 5px;border-radius:3px;border:0;background:rgba(17,24,39,.7);color:#fff;font:700 11px Inter,Segoe UI,sans-serif;cursor:pointer;pointer-events:auto;');
  hideBtn.onclick = function(){ __collapsed=!__collapsed; paint(__authState||{ statusLabel:'' }); };
  bar.appendChild(handle); bar.appendChild(act); bar.appendChild(hideBtn);
  // Under the strip, centred in yellow: everyone at the table as name-money (👑 host, ✓ ready), or what is happening.
  const infoLine = mk('div','position:fixed;top:23px;left:0;right:0;z-index:2147483647;text-align:center;padding:0 8px;color:#fde047;font:700 11px/15px Inter,Segoe UI,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'+SHADOW+'pointer-events:auto;display:none;');
  bar.appendChild(infoLine);
  const feedback = mk('div','position:fixed;left:4px;top:40px;max-width:300px;padding:6px 9px;border:1px solid #f59e0b;border-radius:6px;background:#422006;color:#fff;font:600 12px/1.4 Segoe UI,sans-serif;display:none;pointer-events:auto;');
  feedback.setAttribute('role','alert');
  bar.appendChild(feedback);
  var feedbackTimer = null;
  function showFeedback(message){ clearTimeout(feedbackTimer); feedback.textContent=message; feedback.style.display='block'; feedbackTimer=setTimeout(function(){ feedback.style.display='none'; },6000); }
  const uiStyle = document.createElement('style');
  uiStyle.textContent = '#__phom_header button:focus-visible,#__phom_header input:focus-visible{outline:2px solid #93c5fd;outline-offset:1px}#__phom_header button:hover:not(:disabled){filter:brightness(1.15)}#__phom_header button:disabled{opacity:.55}#__phom_header #__ph_act{overflow-x:auto;scrollbar-width:none}#__phom_header #__ph_act>*{flex-shrink:0}';
  bar.appendChild(uiStyle);
  // Mount idempotently (an overlay — never pushes the game view). On a real (re)mount, tell main.
  function ready(){ if(document.body){ if(!document.getElementById('__phom_header')){ document.body.appendChild(bar); emitStatus(); } } else { requestAnimationFrame(ready); } }
  window.__phomHeaderMount = ready;
  ready();
  // Self-heal — a Cocos/SPA bootstrap that rebuilds <body> after load removes the bar. NARROW observers (html + body
  // children only, never the whole game DOM) re-mount it the instant it is gone.
  var __c = { observerCallbacks:0, mutationRecords:0, remountRequests:0, actualRemounts:0 };
  window.__phomHeaderCounters = __c;
  var __remountScheduled = false;
  function scheduleRemount(){
    if (document.getElementById('__phom_header')) return;
    __c.remountRequests++;
    if (__remountScheduled) return; __remountScheduled = true;
    requestAnimationFrame(function(){ __remountScheduled = false; if(!document.getElementById('__phom_header')){ __c.actualRemounts++; if(OBSLOG){ try{ console.log('[PHOM-HDR] remount', ID.slotId||ID.runId, JSON.stringify(__c)); }catch(e){} } ready(); } });
  }
  try {
    if (!window.__phomHeaderObserver && typeof MutationObserver !== 'undefined') {
      var __bodyObs = null, __bodyTarget = null;
      var observeBody = function(){
        if (!document.body || __bodyTarget === document.body) return;
        if (__bodyObs) { try{ __bodyObs.disconnect(); }catch(e){} }
        __bodyTarget = document.body;
        __bodyObs = new MutationObserver(function(m){ __c.observerCallbacks++; __c.mutationRecords += m.length; scheduleRemount(); });
        __bodyObs.observe(document.body, { childList: true, subtree: false });
      };
      var __htmlObs = new MutationObserver(function(m){ __c.observerCallbacks++; __c.mutationRecords += m.length; observeBody(); scheduleRemount(); });
      __htmlObs.observe(document.documentElement, { childList: true, subtree: false });
      observeBody();
      window.__phomHeaderObserver = { disconnect: function(){ try{ __htmlObs.disconnect(); }catch(e){} try{ if(__bodyObs) __bodyObs.disconnect(); }catch(e){} } };
      window.addEventListener('pagehide', function(){ try { window.__phomHeaderObserver.disconnect(); } catch(e){} window.__phomHeaderObserver = null; }, { once:true });
    }
  } catch(e){}
  function txtBtn(label, bg, onClick, tip, dis){
    var b = mk('button','height:18px;padding:0 4px;border-radius:3px;border:0;background:'+bg+';color:#fff;font:700 11px Inter,Segoe UI,sans-serif;white-space:nowrap;cursor:'+(dis?'not-allowed':'pointer')+';');
    b.textContent = label; b.title = tip || label;
    if(dis) b.disabled = true; else b.onclick = onClick;
    return b;
  }
  function chip(label, bg){ var c = mk('span','height:18px;padding:0 5px;border-radius:3px;background:'+bg+';color:#fff;font:800 10px/18px Inter,Segoe UI,sans-serif;white-space:nowrap;'); c.textContent = label; return c; }
  function ssRid(){ var v = String(ssInput.value||'').trim(); var n = Number(v); return v !== '' && isFinite(n) && n > 0 ? n : null; }
  // The yellow line: name-money of everyone at the table (ours bright, strangers dimmer) — else what is happening.
  function paintInfo(state){
    infoLine.textContent = '';
    if(__collapsed || !state.canAct){ infoLine.style.display='none'; return; }
    var ROLE = { KEY:'KEY', READY:'SẴN SÀNG', NOT_READY:'CHƯA SS' };
    var detail = (state.inTable ? 'ID Bàn: ' + (state.joinedViaChannel ? 'chưa có (kênh ' + state.rid + ')' : state.rid) + ' · Số người: ' + (state.playerCount || state.players.length) : (state.statusLabel || ''))
      + (state.groupRole ? ' · ' + ROLE[state.groupRole] : '') + ' · ' + (state.stake != null ? 'Cược ' + state.stake : 'CHƯA CHỌN CƯỢC');
    if(state.inTable && state.players.length){
      state.players.forEach(function(pl, i){
        if(i) infoLine.appendChild(document.createTextNode(','));
        var sp = mk('span', pl.ours ? '' : 'color:#e5e7eb;font-weight:500;');
        sp.textContent = (pl.host ? '👑' : '') + pl.name + (pl.money != null ? '-' + pl.money : '') + (pl.ready ? '✓' : '');
        sp.title = (pl.ours ? 'Acc của tool' : 'Người chơi khác') + (pl.host ? ' · chủ bàn' : '') + (pl.ready ? ' · đã sẵn sàng' : '');
        infoLine.appendChild(sp);
      });
    } else infoLine.appendChild(document.createTextNode(detail));
    infoLine.title = detail;
    infoLine.style.display = '';
  }
  function paint(state){
    if(!document.getElementById('__phom_header')) ready();
    var hasAcc = state.account && state.account !== '—';
    var acc = hasAcc ? state.account + (state.money != null ? '-' + state.money : '') : '';
    nameEl.textContent = hasAcc ? state.account + (state.accountId ? ' · ID ' + state.accountId : '') : '';
    nameEl.title = hasAcc ? acc + (state.accountId ? ' — ID ' + state.accountId : '') : '';
    nameEl.style.display = hasAcc ? '' : 'none';
    badge.title = (SLOTN ? 'Player ' + SLOTN : 'Player') + ' · ' + (state.statusLabel||'');
    hideBtn.textContent = __collapsed ? 'Show' : 'Hide';
    act.textContent = '';
    act.style.display = __collapsed ? 'none' : 'flex';
    if(!__collapsed){
      if(state.canAct){
        if(state.ssDefault != null && document.activeElement !== ssInput && (__ssValue === '' || __ssValue === __ssAuto)){ __ssAuto = String(state.ssDefault); __ssValue = __ssAuto; }
        ssInput.value = __ssValue;
        act.appendChild(chip('SS', '#dc2626'));
        act.appendChild(ssInput);
        act.appendChild(txtBtn('Copy','#d97706',function(){ var v=String(ssInput.value||'').trim(); if(!v) return; try{ navigator.clipboard.writeText(v); }catch(e){} },'Copy số bàn'));
        function needStake(){ if(state.stake == null){ showFeedback('Chưa chọn mức cược. Mở Phỏm QA → tab PHỎM → Mức cược, chọn tiền rồi bấm lại.'); return true; } feedback.style.display='none'; return false; }
        // VÀO — sit at the số bàn in the SS box (op 8).
        act.appendChild(txtBtn(state.joining ? 'Vào.' : 'Vào','#16a34a',function(){ var r=ssRid(); if(r==null){ showFeedback('Ô SS chưa có số bàn — bấm Tạo ở acc này để dò ra bàn của KEY.'); return; } emit('JOIN_CODE',{ rid:r }); },'VÀO: vào đúng số bàn trong ô SS', state.joining));
        // REJOIN — a toggle: on = come back by itself after every kick.
        act.appendChild(txtBtn(state.rejoinOn ? 'ReJoin.' : 'ReJoin', state.rejoinOn ? '#0f766e' : '#334155',function(){ emit('REJOIN'); }, state.rejoinOn ? 'REJOIN đang BẬT — bị đá sẽ tự vào lại ngay. Bấm để tắt' : 'REJOIN: vào bàn chung và tự vào lại mỗi lần bị đá', !state.canRejoin));
        // TẠO — the OTHER accounts: find the KEY's table and sit there (fills every SS box). Second click stops it.
        var scanning = state.searchKind === 'SCAN';
        act.appendChild(txtBtn(scanning ? 'Tạo.' : 'Tạo', scanning ? '#075985' : '#0369a1', function(){ if(scanning){ emit('CANCEL_FIND'); return; } if(needStake()) return; emit('SCAN_TABLE'); },
          scanning ? 'Đang dò bàn của acc KEY — bấm để dừng' : state.isKey ? 'Đây là acc KEY — bấm Tạo ở acc khác' : 'TẠO: dò ra bàn của acc KEY rồi ngồi vào — số bàn tự điền vào ô SS của mọi trình duyệt',
          !scanning && (state.isKey || !(state.keySeated || state.ssDefault != null))));
        // DÒ KEY — ONE account only: sit ALONE at an empty table and become the KEY (chủ bàn). Second click stops it.
        var keying = state.searchKind === 'KEY';
        act.appendChild(txtBtn(keying ? 'Dò Key.' : 'Dò Key', keying ? '#5b21b6' : '#7c3aed', function(){ if(keying){ emit('CANCEL_FIND'); return; } if(needStake()) return; emit('FIND_TABLE'); },
          keying ? 'Đang tìm bàn trống — bấm để dừng' : state.stake == null ? 'Chọn Mức cược ở tab PHỎM trước' : 'DÒ KEY: chỉ bấm ở MỘT acc — ngồi một mình ở bàn trống cược ' + state.stake + ', acc này thành KEY (chủ bàn)'));
        act.appendChild(txtBtn('Thoát','#991b1b',function(){ emit('LEAVE'); },'THOÁT: rời bàn (không tắt trình duyệt)', !state.inTable));
      } else if(state.primary){
        var p = state.primary;
        act.appendChild(txtBtn(p.label || p.action, '#2563eb', function(){ emit(p.action); }, p.label, !!p.disabled));
        var st = mk('span','color:#fde047;font-weight:700;white-space:nowrap;'+SHADOW); st.textContent = state.statusLabel || ''; act.appendChild(st);
      }
    }
    paintInfo(state);
    // a failed action is said in words, once (e.g. "Đã có acc KEY (P1) đang ngồi — ở acc này bấm Tạo")
    if(state.error && state.error !== __lastError) showFeedback(String(state.error));
    __lastError = state.error || null;
    if(CLICKLOG && window.__phClickT!=null){ try{ console.log('[PHOM-CLK] CLICK_TO_RENDER', Math.round(CLK()-window.__phClickT)+'ms', 'action='+window.__phClickA, '->', state.statusLabel||''); }catch(e){} window.__phClickT=null; }
  }
  // The OPTIMISTIC state for a just-clicked action: only the label + a disabled busy primary are new; ACCOUNT/RID come
  // from the last authoritative state, never fabricated.
  function optState(action){
    var base = __authState || {};
    var label = 'ĐANG VÀO GAME…';
    return { account: base.account, accountId: base.accountId, rid: base.rid, statusLabel: label, primary:{ action: action, label: label, disabled: true, busy: true }, error: null };
  }
  function applyOptimistic(action){ try { __optAction = action; paint(optState(action)); } catch(e){} }
  // AUTHORITATIVE render from main ALWAYS wins: store it, clear any optimistic overlay, paint it.
  window.__phomHeaderRender = function(state){ try { __authState = state; __optAction = null; paint(state); } catch(e){} };
})();`;
}

// PURE mirror of the in-page optimistic logic (single source of truth for the busy labels, unit-tested).
function optimisticLabel(action) {
  switch (action) {
    case 'ENTER_GAME': return 'ĐANG VÀO GAME…';
    case 'FIND_TABLE': return 'ĐANG DÒ KEY…';
    case 'SCAN_TABLE': return 'ĐANG DÒ BÀN KEY…';
    case 'JOIN_CODE': case 'REJOIN': return 'ĐANG VÀO BÀN…';
    case 'LEAVE': return 'ĐANG THOÁT PHÒNG…';
    default: return 'ĐANG XỬ LÝ…';
  }
}
function optimisticState(action, authState) {
  const base = authState || {};
  const label = optimisticLabel(action);
  return { account: base.account, rid: base.rid, statusLabel: label, primary: { action, label, disabled: true, busy: true }, error: null };
}
function deriveEffectiveHeaderState({ authState = null, optAction = null } = {}) {
  return optAction ? optimisticState(optAction, authState) : authState;
}

// BOUNDED "ĐANG VÀO GAME": the tile click is INVOKED != ENTERED, so the entering state lasts only while the enter is
// in flight — pending, not yet in the game, within the window since the click — and then reverts to VÀO GAME.
const ENTER_GAME_TIMEOUT_MS = 15000;
function enteringActive({ pending = false, inGame = false, startedAt = null, now = 0, timeoutMs = ENTER_GAME_TIMEOUT_MS } = {}) {
  if (!pending || inGame) return false;
  if (startedAt == null) return true;
  return (Number(now) - Number(startedAt)) < Number(timeoutMs);
}

module.exports = { deriveHeaderState, bootScript, optimisticLabel, optimisticState, deriveEffectiveHeaderState, enteringActive, ENTER_GAME_TIMEOUT_MS, HEADER_ACTIONS };
