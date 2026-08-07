'use strict';

const EventEmitter = require('node:events');

// Injected into every document (the page AND child OOPIF iframes) to report the
// user's clicks back through a CDP binding. Deliberately tiny and fully wrapped
// in try/catch so it can never break the app under test.
const HOOK_SOURCE = `(() => {
  try {
    if (window.__wsoHook) return; window.__wsoHook = 1;
    const send = window.__wso_action__; if (typeof send !== 'function') return;
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    function actionable(el){ let n=el,d=0; while(n && n.nodeType===1 && d<5){ if(n.matches && n.matches('button,a,[role=button],input[type=submit],input[type=button],[onclick],label')) return n; n=n.parentElement; d++; } return el; }
    function selector(el){ try{ const p=[]; let n=el,d=0; while(n && n.nodeType===1 && d<4){ let s=n.tagName.toLowerCase(); if(n.id){ p.unshift(s+'#'+n.id); break; } const c=(n.className&&String(n.className).trim().split(/\\s+/)[0]); if(c) s+='.'+c; p.unshift(s); n=n.parentElement; d++; } return p.join('>'); }catch(e){ return ''; } }
    addEventListener('click', (e) => {
      try {
        const t = e.target && e.target.nodeType===1 ? e.target : null; if(!t) return;
        const a = actionable(t);
        const text = clean(a.innerText || a.textContent || a.value || (a.getAttribute && (a.getAttribute('aria-label')||a.getAttribute('title'))) || '');
        send(JSON.stringify({ text, tag:(a.tagName||'').toLowerCase(), selector: selector(a), url: (location&&location.href)||'', t: Date.now() }));
      } catch(e) {}
    }, true);
  } catch(e) {}
})();`;

const BINDING = '__wso_action__';

/**
 * InteractionTracker records the user's clicks in the target (page + iframes)
 * and links each click to the network requests it triggers, purely by time on
 * the same target. It never mutates capture evidence — it only annotates.
 *
 * Injection uses Runtime.addBinding (so page JS can call back) plus
 * Page.addScriptToEvaluateOnNewDocument (survives navigation) and one immediate
 * Runtime.evaluate (works on the already-loaded document, no reload needed).
 *
 * Events: 'interaction' (a recorded click).
 */
class InteractionTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this._windowMs = Number(options.windowMs || 2500); // click -> request correlation window
    this._items = [];             // chronological interaction records
    this._byId = new Map();
    this._boundClients = new WeakSet();
    this._seq = 0;
  }

  list() { return this._items.map((x) => ({ ...x, requestIds: [...x.requestIds] })); }
  get(id) { return this._byId.get(id); }
  clear() { this._items = []; this._byId.clear(); }

  // Attach to a page client: subscribe to binding calls once, inject the hook
  // into the root session.
  async attach(client, targetId) {
    if (!this._boundClients.has(client)) {
      this._boundClients.add(client);
      client.Runtime.bindingCalled((p, sid) => this._onBinding(targetId, p, sid));
    }
    await this.injectSession(client, targetId, undefined);
  }

  // Inject the hook into one session — the root (sessionId undefined) or a
  // flattened child OOPIF iframe session. Runs on the current document too.
  async injectSession(client, targetId, sessionId) {
    try {
      await client.Runtime.enable({}, sessionId);
      await client.Runtime.addBinding({ name: BINDING }, sessionId);
      try { await client.Page.addScriptToEvaluateOnNewDocument({ source: HOOK_SOURCE }, sessionId); } catch { /* survives-nav is best-effort */ }
      await client.Runtime.evaluate({ expression: HOOK_SOURCE, includeCommandLineAPI: false }, sessionId);
    } catch { /* worker/detached session with no DOM — ignore */ }
  }

  _onBinding(targetId, p, _sessionId) {
    if (!p || p.name !== BINDING) return;
    let data; try { data = JSON.parse(p.payload); } catch { return; }
    const id = `act_${targetId}_${this._seq++}`;
    const rec = {
      id, targetId, kind: 'click',
      text: data.text || '', tag: data.tag || '', selector: data.selector || '',
      url: data.url || '', at: Date.now(), timestamp: new Date().toISOString(),
      requestIds: new Set(),
    };
    this._items.push(rec);
    this._byId.set(id, rec);
    if (this._items.length > 500) { const old = this._items.shift(); this._byId.delete(old.id); }
    this.emit('interaction', { id, targetId, kind: 'click', text: rec.text, tag: rec.tag, selector: rec.selector, url: rec.url, timestamp: rec.timestamp });
  }

  // Best-effort: attribute a just-started request to the most recent click on the
  // SAME target within the correlation window. Returns the interaction id or null.
  linkRequest(req) {
    if (!req) return null;
    const now = Date.now();
    for (let i = this._items.length - 1; i >= 0; i--) {
      const it = this._items[i];
      if (now - it.at > this._windowMs) break; // chronological: everything earlier is older too
      if (it.targetId !== req.targetId) continue;
      it.requestIds.add(req.id);
      return it.id;
    }
    return null;
  }
}

module.exports = { InteractionTracker, HOOK_SOURCE, BINDING };
