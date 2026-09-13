'use strict';

// ---------------------------------------------------------------------------
// PURE atomic apply for the quick-3-proxy flow (§7). Given three parsed slot
// descriptors (from phom-quick-proxy) it: creates three proxy configs (metadata +
// secret via the injected store), binds each slot's browser profile proxyRef, and —
// when a Cluster Profile is selected — updates that profile's slot proxyRefs and
// revalidates. It is transactional: on ANY failure it rolls back ONLY the proxies it
// created in THIS call and returns a TYPED error with the failing slot. It never
// deletes a pre-existing proxy/secret and never reports success on a partial apply.
//
// All side effects are injected so this module has no disk/Electron dependency:
//   ops.isClusterActive(clusterProfileId) -> bool
//   ops.createProxy({ slot, protocol, host, port, username, password }) -> { ok, id } | { ok:false, error }
//   ops.removeProxy(id) -> { ok } | { ok:false }         (rollback of a just-created proxy)
//   ops.setProfileProxyRef(browserProfileId, proxyRef) -> { ok } | { ok:false, error }
//   ops.getClusterProfile(id) -> profile | null          (has .slots.{A,B,C}.browserProfileId)
//   ops.updateClusterProfile(id, patch) -> { ok, profile } | { ok:false, error }
//   ops.validateCluster(id) -> { ok, state, ready, ... }
//
// A password is NEVER echoed into a result/error and NEVER logged here.
// ---------------------------------------------------------------------------

const SLOTS = Object.freeze(['A', 'B', 'C']);

function err(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }

// Resolve slot -> browserProfileId. With a Cluster Profile, use ITS slot bindings; the
// legacy per-slot store keys browser profiles by the slot letter, so that is the fallback.
function browserProfileIdFor(slot, clusterProfile) {
  if (clusterProfile && clusterProfile.slots && clusterProfile.slots[slot] && clusterProfile.slots[slot].browserProfileId) {
    return String(clusterProfile.slots[slot].browserProfileId);
  }
  return slot;
}

/**
 * applyQuickProxies({ slots, clusterProfileId }, ops) -> { ok, refs, clusterState? } | typed error.
 * `slots` is the { A, B, C } map from parseQuickProxies. Success returns the three
 * created proxyRefs (ids only, never a secret). Failure rolls back and returns typed.
 */
function applyQuickProxies({ slots, clusterProfileId = null } = {}, ops = {}) {
  const noop = () => ({ ok: true });
  const isClusterActive = ops.isClusterActive || (() => false);
  const createProxy = ops.createProxy || (() => err('PHOM_PROXY_SECRET_SAVE_FAILED', 'no createProxy'));
  const removeProxy = ops.removeProxy || noop;
  const setProfileProxyRef = ops.setProfileProxyRef || (() => err('PHOM_PROXY_QUICK_APPLY_PARTIAL', 'no setProfileProxyRef'));
  const getClusterProfile = ops.getClusterProfile || (() => null);
  const updateClusterProfile = ops.updateClusterProfile || (() => ({ ok: true }));
  const validateCluster = ops.validateCluster || (() => ({ ok: false }));

  if (!slots || SLOTS.some((s) => !slots[s])) return err('PHOM_PROXY_SLOT_MISSING', 'Thiếu cấu hình proxy cho một slot');

  // §7 — a running cluster's mapping is frozen; stop it first.
  if (clusterProfileId && isClusterActive(clusterProfileId)) {
    return err('PHOM_CLUSTER_PROFILE_IN_USE', 'Cụm đang chạy — hãy dừng cụm trước khi đổi proxy', { id: clusterProfileId });
  }

  const clusterProfile = clusterProfileId ? getClusterProfile(clusterProfileId) : null;
  if (clusterProfileId && !clusterProfile) return err('PHOM_CLUSTER_PROFILE_NOT_FOUND', `Không tìm thấy cấu hình cụm: ${clusterProfileId}`, { id: clusterProfileId });

  // ---- phase 1: create three proxy configs (metadata + secret) ----
  const created = []; // { slot, id }
  const rollback = () => { for (const c of created) { try { removeProxy(c.id); } catch { /* best effort */ } } };
  for (const s of SLOTS) {
    const d = slots[s];
    let res;
    try { res = createProxy({ slot: s, protocol: d.protocol, host: d.host, port: d.port, username: d.username, password: d.password }); }
    catch (e) { res = err('PHOM_PROXY_SECRET_SAVE_FAILED', safe(e)); }
    if (!res || !res.ok || !res.id) {
      rollback();
      const code = (res && res.error && res.error.code) || 'PHOM_PROXY_QUICK_APPLY_PARTIAL';
      return err(code, `Không lưu được proxy cho slot ${s}`, { slot: s, cause: res && res.error ? res.error.code : null });
    }
    created.push({ slot: s, id: res.id });
  }

  // ---- phase 2: bind each slot's browser profile proxyRef ----
  for (const c of created) {
    const bpid = browserProfileIdFor(c.slot, clusterProfile);
    let res;
    try { res = setProfileProxyRef(bpid, c.id); } catch (e) { res = err('PHOM_PROXY_QUICK_APPLY_PARTIAL', safe(e)); }
    if (!res || res.ok === false) {
      rollback();
      return err('PHOM_PROXY_QUICK_APPLY_PARTIAL', `Không gắn được proxy vào hồ sơ slot ${c.slot}`, { slot: c.slot, cause: res && res.error ? res.error.code : null });
    }
  }

  const refs = { A: null, B: null, C: null };
  for (const c of created) refs[c.slot] = c.id;

  // ---- phase 3: update + revalidate the selected Cluster Profile ----
  let clusterState = null;
  if (clusterProfileId) {
    const slotsPatch = {};
    for (const s of SLOTS) {
      const prev = (clusterProfile.slots && clusterProfile.slots[s]) || {};
      slotsPatch[s] = { browserProfileId: prev.browserProfileId || s, deviceProfileId: prev.deviceProfileId || null, proxyRef: refs[s] };
    }
    let upd;
    try { upd = updateClusterProfile(clusterProfileId, { slots: slotsPatch }); } catch (e) { upd = err('PHOM_PROXY_QUICK_APPLY_PARTIAL', safe(e)); }
    if (!upd || upd.ok === false) {
      rollback();
      return err('PHOM_PROXY_QUICK_APPLY_PARTIAL', 'Không cập nhật được cấu hình cụm với proxy mới', { cause: upd && upd.error ? upd.error.code : null });
    }
    try { const v = validateCluster(clusterProfileId); clusterState = v && v.state ? v.state : null; } catch { clusterState = null; }
  }

  return { ok: true, refs, clusterProfileId: clusterProfileId || null, clusterState };
}

function safe(e) { return String((e && e.message) || e || '').slice(0, 160); }

module.exports = { SLOTS, applyQuickProxies, browserProfileIdFor };
