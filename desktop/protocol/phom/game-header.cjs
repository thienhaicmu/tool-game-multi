'use strict';

// ---------------------------------------------------------------------------
// PHASE 6.3.2 — the in-Chromium GAME HEADER. Every managed Chromium (B1/B2/B3) gets a compact, tool-
// OWNED control bar injected at the TOP of its page (a fixed overlay in its own #__phom_header element —
// it never mutates the game's own DOM/canvas/data). The bar shows ACCOUNT · RID · a single business
// action (VÀO GAME → TÌM BÀN/VÀO BÀN → REJOIN + THOÁT PHÒNG) and a bet picker for FIND.
//
// The bar is a DUMB view: the MAIN process derives the state (deriveHeaderState) from the authoritative
// coordinator snapshot and pushes it in via window.__phomHeaderRender(state); button clicks call the CDP
// binding window.__phomAction(JSON.stringify({action,stake})). No business logic lives in the page.
// This module is PURE (a string generator + a pure deriver) so it is unit-testable without a browser.
// ---------------------------------------------------------------------------

// Derive the header view-model for ONE browser from its authoritative fields (§4/§15). Mirrors the
// manual browserAction decision but adds account + RID + the REJOIN/THOÁT PHÒNG pair when joined.
//   view = { account, opened, inGame, entering, joining, manualState, rid, lastRid, sharedRid,
//            betOptions, error }
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
  else if (s === 'SEARCHING') { statusLabel = 'ĐANG TÌM BÀN'; statusClass = 'warn'; primary = { action: 'FIND', label: 'ĐANG TÌM BÀN…', busy: true, disabled: true }; }
  else if (view.joining || s === 'JOINING' || s === 'RECONNECTING') { statusLabel = 'ĐANG VÀO BÀN'; statusClass = 'warn'; primary = { action: 'JOIN', label: 'ĐANG VÀO BÀN…', busy: true, disabled: true }; }
  else if (joined) { statusLabel = 'ĐÃ VÀO BÀN'; statusClass = 'ok'; primary = { action: 'REJOIN', label: 'REJOIN' }; secondary = [{ action: 'LEAVE', label: 'THOÁT PHÒNG', danger: true }]; }
  else if (view.sharedRid != null) { statusLabel = 'ĐÃ VÀO GAME'; statusClass = 'ok'; primary = { action: 'JOIN_SHARED', label: 'VÀO BÀN', rid: Number(view.sharedRid) }; }
  // PHASE 6.3.6 — the finder is the USER's explicit choice (view.finderIndex), NEVER defaulted to Player 1.
  // A non-finder (isFinder === false, i.e. a finder WAS chosen and it isn't this browser) with no shared RID
  // yet must NOT discover: it shows a waiting state (disabled) so it can never send CMD 300 / JOIN a self-found
  // table. isFinder defaults to allowed (undefined ⇒ every browser may FIND until a finder is chosen).
  else if (view.isFinder === false) { const fno = view.finderIndex != null ? view.finderIndex : '?'; statusLabel = 'ĐÃ VÀO GAME'; statusClass = 'ok'; primary = { action: 'WAIT_ANCHOR', label: 'CHỜ PLAYER ' + fno + ' TÌM BÀN', disabled: true }; }
  else { statusLabel = 'ĐÃ VÀO GAME'; statusClass = 'ok'; primary = { action: 'FIND', label: 'TÌM BÀN', needsBet: true, betOptions }; }
  return { account, rid, statusLabel, statusClass, primary, secondary, error: view.error || null, joinedShared };
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
  // This is the user-perceived click→visual round-trip (page → CDP binding → main → CDP evaluate → page).
  const CLK = (window.performance && performance.now) ? function(){ return performance.now(); } : function(){ return Date.now(); };
  // 6.3.2.2 idempotent + SELF-HEALING: if the boot already ran but the game wiped the bar out of the DOM
  // (SPA body swap), re-mount it instead of returning early — so the header can never silently vanish.
  if (window.__phomHeaderInstalled) { if (!document.getElementById('__phom_header') && window.__phomHeaderMount) window.__phomHeaderMount(); return; }
  window.__phomHeaderInstalled = true;
  // Every action carries the browser IDENTITY (slot/profile/run) + a correlation actionId so a single
  // click can be traced end-to-end and can NEVER be attributed to the wrong browser.
  function emit(action, extra){ try { var aid=(Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)); if(CLICKLOG){ window.__phClickT=CLK(); window.__phClickA=action; try{ console.log('[PHOM-CLK] CLICK_START', action, aid, ID.slotId||ID.runId); }catch(e){} } applyOptimistic(action); window[BID] && window[BID](JSON.stringify(Object.assign({ action, actionId: aid, slotId: ID.slotId, profileId: ID.profileId, runId: ID.runId }, extra||{}))); } catch(e){} }
  // 6.3.2.11 OPTIMISTIC visual state (page-local only). __authState = the last AUTHORITATIVE state pushed by
  // main; __optAction = a transient action the user just clicked. The click paints an immediate busy state
  // (ĐANG …) with NO CDP/main round-trip; the next authoritative __phomHeaderRender CLEARS it and wins. Only
  // the status/action LABEL is optimistic — never RID/ACCOUNT/membership (those stay authoritative, §15).
  var __authState = null, __optAction = null;
  // Report the header's REAL DOM presence to main (once per mount/remount — NOT per frame) so the Tool can
  // show HEADER = Sẵn sàng only when #__phom_header actually exists; main force-repushes state on receipt.
  function emitStatus(){ try { window[BID] && window[BID](JSON.stringify({ action:'__HEADER_STATUS', present:true, slotId: ID.slotId, profileId: ID.profileId, runId: ID.runId })); } catch(e){} }
  const bar = document.createElement('div'); bar.id = '__phom_header';
  // §13 — stable 3-column layout: LEFT (ACCOUNT · STATE) | CENTER (ACTION) | RIGHT (RID). The action is
  // centered INSIDE the header bar via the grid center column (never centered over the game / pushed to a
  // corner) regardless of how wide the left/right text is.
  bar.setAttribute('style','position:fixed;top:0;left:0;right:0;height:34px;z-index:2147483647;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;padding:0 10px;background:#111827;color:#e5e7eb;font:600 12px/1 Inter,Segoe UI,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3);');
  const mk = (t,s)=>{const e=document.createElement(t);if(s)e.setAttribute('style',s);return e;};
  const left = mk('div','justify-self:start;display:flex;align-items:center;gap:10px;min-width:0;overflow:hidden;white-space:nowrap');
  const acc = mk('span'); acc.id='__ph_acc';
  const st  = mk('span'); st.id='__ph_st';
  left.appendChild(acc); left.appendChild(st);
  const act = mk('div','justify-self:center;display:flex;gap:6px;align-items:center'); act.id='__ph_act';
  const right = mk('div','justify-self:end;display:flex;align-items:center;gap:6px;white-space:nowrap');
  const rid = mk('span'); rid.id='__ph_rid'; right.appendChild(rid);
  bar.appendChild(left); bar.appendChild(act); bar.appendChild(right);
  // Mount idempotently. On a real (re)mount, tell main so it re-pushes the current state into the fresh bar.
  function ready(){ if(document.body){ if(!document.getElementById('__phom_header')){ document.body.appendChild(bar); emitStatus(); } document.body.style.marginTop='34px'; } else { requestAnimationFrame(ready); } }
  window.__phomHeaderMount = ready; // allow the bridge / render to re-mount after an SPA body swap
  ready();
  // REAL self-heal (§5) — a Cocos/SPA bootstrap that rebuilds <body> AFTER load removes the bar, and (post
  // 6.3.2.6 dedupe) nothing re-renders it in a steady lobby. NARROW in-PAGE observers re-mount the bar the
  // instant it is removed — NEVER observing the whole game DOM (§2/§3):
  //   L1 = <html> childList (subtree:false) — catches document.body being replaced/created.
  //   L2 = <body> childList (subtree:false) — catches the header removed directly from body.
  // The header is always a DIRECT child of body, so childList (no subtree) is sufficient; our own render
  // (buttons appended INSIDE #__ph_act) is deeper than body, so it never even reaches these observers.
  // rAF-coalesced, fast no-op while present, no CDP round-trips, no polling. pagehide disconnects both.
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
  function btn(label, dis, danger, onClick){ const b=mk('button', 'padding:4px 12px;border-radius:6px;border:1px solid '+(danger?'#7f1d1d':'#374151')+';background:'+(danger?'#7f1d1d':'#2563eb')+';color:#fff;font:600 12px Inter,Segoe UI,sans-serif;cursor:'+(dis?'not-allowed':'pointer')+';opacity:'+(dis?'.5':'1')); b.textContent=label; if(dis) b.disabled=true; else b.onclick=onClick; return b; }
  // Paint ONE state object into the bar (authoritative OR optimistic — identical rendering, no duplicate
  // renderer). Buttons still call emit(); a busy/disabled primary renders as a disabled button (no onclick),
  // which is what naturally blocks a second click during an in-flight action.
  function paint(state){
    if(!document.getElementById('__phom_header')) ready();
    acc.textContent = 'ACCOUNT: ' + (state.account||'—');
    rid.textContent = 'RID: ' + (state.rid||'—');
    st.textContent = state.statusLabel||''; st.style.color = state.statusClass==='ok'?'#34d399':state.statusClass==='warn'?'#fbbf24':state.statusClass==='danger'?'#f87171':'#9ca3af';
    act.textContent='';
    const p = state.primary||{};
    if (p.needsBet && Array.isArray(p.betOptions) && p.betOptions.length){
      const sel=mk('select','padding:3px 6px;border-radius:6px'); const o0=mk('option'); o0.value=''; o0.textContent='CƯỢC…'; sel.appendChild(o0);
      p.betOptions.forEach(v=>{const o=mk('option');o.value=String(v);o.textContent=String(v);sel.appendChild(o);}); act.appendChild(sel);
      act.appendChild(btn('TÌM BÀN', !sel.value, false, ()=>{ if(sel.value) emit('FIND',{ stake:Number(sel.value) }); }));
      sel.onchange=()=>{ act.replaceChildren(sel); act.appendChild(btn('TÌM BÀN', !sel.value, false, ()=>{ if(sel.value) emit('FIND',{ stake:Number(sel.value) }); })); };
    } else if (p.action){ act.appendChild(btn(p.label||p.action, !!p.disabled, false, ()=> emit(p.action, p.rid!=null?{ rid:p.rid }:null))); }
    (state.secondary||[]).forEach(sa=> act.appendChild(btn(sa.label||sa.action, false, !!sa.danger, ()=> emit(sa.action))));
    if(state.error){ const e=mk('span','color:#f87171'); e.textContent=state.error; act.appendChild(e); }
    // 6.3.2.10 PROFILING (gated) — report click→visual in ONE (page) clock on the FIRST paint after a click.
    // With 6.3.2.11 that first paint is the OPTIMISTIC one, so this now measures the immediate local response.
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
      : 'ĐANG XỬ LÝ…';
    return { account: base.account, rid: base.rid, statusLabel: label, statusClass:'warn', primary:{ action: action, label: label, disabled: true, busy: true }, secondary: [], error: null };
  }
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

module.exports = { deriveHeaderState, bootScript, optimisticLabel, optimisticState, deriveEffectiveHeaderState, enteringActive, ENTER_GAME_TIMEOUT_MS };
