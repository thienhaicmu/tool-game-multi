'use strict';

// ---------------------------------------------------------------------------
// cluster-runtime-projection (§3) — the PURE bridge between the SAVED cluster
// profile's authoritative runtime config (produced by
// PhomClusterProfileStore.toRuntimeConfig) and the shape PhomClusterCdpManager
// .createCluster consumes. It exists so the owner path NEVER re-assembles a
// cluster from loose renderer/per-slot state: the ONLY inputs are (1) the store's
// resolved runtime config and (2) an injected raw-device resolver (a main-process
// concern kept out of this pure module). It carries NO secret (proxyRef is a
// reference id, never a password) and NO live runtime identifier.
//
// A slot maps 1:1 (a slot's browser/device/proxy never moves to another slot). Any
// unresolved reference is a TYPED failure BEFORE the manager is asked to open a
// single browser — so a non-ready profile opens nothing.
// ---------------------------------------------------------------------------

const SLOTS = Object.freeze(['A', 'B', 'C']);

function err(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }

/**
 * projectRuntimeToManagerConfig(runtimeConfig, { resolveRawDevice }) ->
 *   { ok, config } | typed error.
 *
 * `runtimeConfig` is the object returned by store.toRuntimeConfig(id).config:
 *   { clusterProfileId, gameUrl, hostSlot, selectedStake, slots: { A:{ browserProfile,
 *     deviceProfile, proxyRef }, ... } }
 * `resolveRawDevice(browserProfileId, deviceProfileId)` returns the RAW device object
 * (the one CDP emulationCommands understands), or null. It is injected so this module
 * never imports the profile store.
 *
 * Output `config` is exactly what PhomClusterCdpManager.createCluster expects, plus a
 * per-slot `browserProfileId`/`gameUrl`/`label` used by the owner's openProfile seam so
 * each browser is launched from its AUTHORITATIVE profile (user-data-dir/device/proxy),
 * never re-derived from the cluster slot letter.
 */
function projectRuntimeToManagerConfig(runtimeConfig, { resolveRawDevice = null } = {}) {
  if (!runtimeConfig || !runtimeConfig.slots || typeof runtimeConfig.slots !== 'object') {
    return err('PHOM_CLUSTER_PROFILE_NOT_READY', 'Runtime config has no slots');
  }
  if (!runtimeConfig.gameUrl) return err('PHOM_CLUSTER_GAME_URL_REQUIRED', 'Shared game URL is required to open the cluster');

  const profiles = [];
  for (const s of SLOTS) {
    const rc = runtimeConfig.slots[s];
    if (!rc || !rc.browserProfile) return err('PHOM_CLUSTER_BROWSER_PROFILE_MISSING', `slot ${s} browser profile missing`, { slot: s });
    const browserProfileId = rc.browserProfile.slot || rc.browserProfile.id || null;
    if (!browserProfileId) return err('PHOM_CLUSTER_BROWSER_PROFILE_MISSING', `slot ${s} browser profile id missing`, { slot: s });
    const deviceProfileId = rc.deviceProfile ? (rc.deviceProfile.id != null ? String(rc.deviceProfile.id) : null) : null;
    // Prefer the injected RAW device (emulation-ready); fall back to the resolved
    // snapshot only when no resolver is supplied (tests). A missing device is typed.
    const rawDevice = resolveRawDevice ? resolveRawDevice(browserProfileId, deviceProfileId) : rc.deviceProfile;
    if (!rawDevice) return err('PHOM_CLUSTER_DEVICE_PROFILE_MISSING', `slot ${s} device missing`, { slot: s });
    // Proxy is OPTIONAL: a null proxyRef is a valid DIRECT-mode slot (no error). A slot
    // with a proxyRef runs in PROXY mode; the launch gate enforces the ref with no
    // silent fallback.
    const proxyRef = rc.proxyRef || null;
    profiles.push({
      slot: s,
      browserProfileId,
      deviceProfileId,
      proxyRef,                     // reference id only — never a password; null = DIRECT
      executionMode: proxyRef ? 'PROXY' : 'DIRECT',
      device: rawDevice,
      gameUrl: runtimeConfig.gameUrl,
      label: (rc.browserProfile.name || `Profile ${s}`),
    });
  }

  const hostSlot = SLOTS.includes(runtimeConfig.hostSlot) ? runtimeConfig.hostSlot : 'A';
  return {
    ok: true,
    config: {
      clusterProfileId: runtimeConfig.clusterProfileId || null,
      hostSlot,
      selectedStake: runtimeConfig.selectedStake != null ? runtimeConfig.selectedStake : null,
      gameUrl: runtimeConfig.gameUrl,
      profiles,
    },
  };
}

module.exports = { projectRuntimeToManagerConfig, SLOTS };
