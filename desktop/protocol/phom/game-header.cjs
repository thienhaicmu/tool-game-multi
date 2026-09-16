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
  else { statusLabel = 'ĐÃ VÀO GAME'; statusClass = 'ok'; primary = { action: 'FIND', label: 'TÌM BÀN', needsBet: true, betOptions }; }
  return { account, rid, statusLabel, statusClass, primary, secondary, error: view.error || null, joinedShared };
}

// The one-time page bootstrap script (injected via Page.addScriptToEvaluateOnNewDocument + evaluated
// immediately). Idempotent: builds #__phom_header once; exposes window.__phomHeaderRender(state). Button
// clicks call the CDP binding window.__phomAction. Namespaced; no game-DOM mutation beyond its own bar.
function bootScript(opts = {}) {
  const bindingName = opts.bindingName || '__phomAction';
  const identity = { slotId: opts.slotId != null ? String(opts.slotId) : null, profileId: opts.profileId != null ? String(opts.profileId) : null, runId: opts.runId != null ? String(opts.runId) : null };
  return `(() => {
  const BID = ${JSON.stringify(bindingName)};
  const ID = ${JSON.stringify(identity)};
  // 6.3.2.2 idempotent + SELF-HEALING: if the boot already ran but the game wiped the bar out of the DOM
  // (SPA body swap), re-mount it instead of returning early — so the header can never silently vanish.
  if (window.__phomHeaderInstalled) { if (!document.getElementById('__phom_header') && window.__phomHeaderMount) window.__phomHeaderMount(); return; }
  window.__phomHeaderInstalled = true;
  // Every action carries the browser IDENTITY (slot/profile/run) + a correlation actionId so a single
  // click can be traced end-to-end and can NEVER be attributed to the wrong browser.
  function emit(action, extra){ try { window[BID] && window[BID](JSON.stringify(Object.assign({ action, actionId: (Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8)), slotId: ID.slotId, profileId: ID.profileId, runId: ID.runId }, extra||{}))); } catch(e){} }
  const bar = document.createElement('div'); bar.id = '__phom_header';
  bar.setAttribute('style','position:fixed;top:0;left:0;right:0;height:34px;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:0 10px;background:#111827;color:#e5e7eb;font:600 12px/1 Inter,Segoe UI,system-ui,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.3);');
  const mk = (t,s)=>{const e=document.createElement(t);if(s)e.setAttribute('style',s);return e;};
  const acc = mk('span'); acc.id='__ph_acc';
  const rid = mk('span'); rid.id='__ph_rid';
  const st  = mk('span'); st.id='__ph_st';
  const act = mk('div','margin-left:auto;display:flex;gap:6px;align-items:center'); act.id='__ph_act';
  bar.appendChild(acc); bar.appendChild(rid); bar.appendChild(st); bar.appendChild(act);
  function ready(){ if(document.body){ if(!document.getElementById('__phom_header')) document.body.appendChild(bar); document.body.style.marginTop='34px'; } else { requestAnimationFrame(ready); } }
  window.__phomHeaderMount = ready; // allow the bridge / render to re-mount after an SPA body swap
  ready();
  function btn(label, dis, danger, onClick){ const b=mk('button', 'padding:4px 12px;border-radius:6px;border:1px solid '+(danger?'#7f1d1d':'#374151')+';background:'+(danger?'#7f1d1d':'#2563eb')+';color:#fff;font:600 12px Inter,Segoe UI,sans-serif;cursor:'+(dis?'not-allowed':'pointer')+';opacity:'+(dis?'.5':'1')); b.textContent=label; if(dis) b.disabled=true; else b.onclick=onClick; return b; }
  window.__phomHeaderRender = function(state){ try {
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
  } catch(e){} };
})();`;
}

module.exports = { deriveHeaderState, bootScript };
