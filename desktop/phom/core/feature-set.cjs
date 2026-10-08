'use strict';

// ---------------------------------------------------------------------------
// FEATURES (3.2 core). Each thing the tool does to a browser is ONE module with the same shape:
//
//   { id,
//     attach({ run, target, client, session }),   // a target of this browser got a CDP client (page, re-attach)
//     documentReplaced({ run, session, url }),       // the page loaded a new top-level document
//     push({ run, session, view, browser }),          // a state push (throttled) — the header / auto-enter tick
//     closed({ run, session }),                       // the browser closed
//     registerIpc(handle) }                           // its own IPC channels
//
// Every hook is optional. The set calls them in a fixed order, isolates failures (one feature that throws never
// stops the others) and lets any feature be switched off by id — PHOM_FEATURES_OFF=an-danh,header — the one switch
// that replaced the ad-hoc PHOM_DIAG_NO_* env flags. Turning a feature off is how a misbehaving one is found.
// ---------------------------------------------------------------------------

const HOOKS = Object.freeze(['attach', 'documentReplaced', 'push', 'closed']);

function parseOff(value) {
  return new Set(String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function createFeatureSet({ features = [], off = parseOff(process.env.PHOM_FEATURES_OFF), log = () => {} } = {}) {
  const list = [];
  const ids = new Set();
  for (const f of features) {
    if (!f || typeof f.id !== 'string') throw new Error('a feature needs an id');
    if (ids.has(f.id)) throw new Error('duplicate feature id ' + f.id);
    ids.add(f.id); list.push(f);
  }
  const enabled = (id) => !off.has(String(id).toLowerCase());
  for (const id of off) if (!ids.has(id)) log('feature-off-unknown', { id });
  function run(hook, arg) {
    for (const f of list) {
      if (typeof f[hook] !== 'function' || !enabled(f.id)) continue;
      try {
        const r = f[hook](arg);
        if (r && typeof r.catch === 'function') r.catch((e) => log('feature-error', { feature: f.id, hook, error: String((e && e.message) || e).slice(0, 200) }));
      } catch (e) { log('feature-error', { feature: f.id, hook, error: String((e && e.message) || e).slice(0, 200) }); }
    }
  }
  return {
    ids: () => list.map((f) => f.id),
    enabled,
    get: (id) => list.find((f) => f.id === id) || null,
    attach: (arg) => run('attach', arg),
    documentReplaced: (arg) => run('documentReplaced', arg),
    push: (arg) => run('push', arg),
    closed: (arg) => run('closed', arg),
    registerIpc(handle) { for (const f of list) if (typeof f.registerIpc === 'function') f.registerIpc(handle, { enabled: enabled(f.id) }); },
  };
}

module.exports = { createFeatureSet, parseOff, HOOKS };
