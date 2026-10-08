'use strict';

// ---------------------------------------------------------------------------
// FEATURE an-danh — the tool's ẨN DANH switch (default OFF; the game's own default is ON). The page script
// (protocol/phom/an-danh.cjs) is registered for the current document and every later one (reload / VÀO GAME) on the
// PAGE target, and re-applied to every open browser when the switch changes.
//
// deps: { anDanh (protocol/phom/an-danh.cjs), pageClients() → [{ runId, client }], log }
// IPC:  phom:an-danh-get → { ok, on } · phom:an-danh-set { on } → { ok, on, results }
// ---------------------------------------------------------------------------

const isPage = (target) => !target || !target.type || target.type === 'PAGE';

function createAnDanhFeature({ anDanh, pageClients, log = () => {}, initial = false }) {
  let on = !!initial;
  async function set(value) {
    on = !!value;
    const results = {};
    for (const { runId, client } of pageClients()) if (client) results[runId] = await anDanh.applyAnDanh(client, on);
    log('AN_DANH_SET', { on, results });
    return { ok: true, on, results };
  }
  return {
    id: 'an-danh',
    isOn: () => on,
    set,
    attach({ client, target }) { if (isPage(target)) return anDanh.applyAnDanh(client, on).catch(() => {}); return undefined; },
    registerIpc(handle) {
      handle('phom:an-danh-get', () => ({ ok: true, on }));
      handle('phom:an-danh-set', (_e, cfg) => set(!!(cfg && cfg.on)), { guarded: true });
    },
  };
}

module.exports = { createAnDanhFeature };
