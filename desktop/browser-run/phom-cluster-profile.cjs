'use strict';

const { parseStrict } = require('../protocol/numeric.cjs');

// ---------------------------------------------------------------------------
// PhomClusterProfile — PURE model (no disk, no network, no runtime). A cluster
// profile is ONE saved configuration that drives the whole three-browser cluster:
// a single shared game URL, a default HOST slot, a default stake, and three slots
// (A/B/C) each binding an existing browser profile + its device + a proxy reference.
//
// In this repo the "browser profile" is the PhomProfileStore slot (A/B/C), which
// itself owns a normalized device; a proxy is a ProxyConfigStore id (PX-*). So a
// cluster slot references: browserProfileId (a PhomProfileStore slot key),
// deviceProfileId (the device.id inside that browser profile) and proxyRef (a proxy
// config id). This module NEVER stores a secret (proxy/account password, token,
// cookie, authorization) and NEVER stores live runtime state (BrowserRun id, CDP
// port, PID, target/session, hand/join/ready state) — those are reconstructed at
// runtime and must stay out of the persisted profile by construction.
//
// Two states are distinguished WITHOUT a persisted flag (state is derived):
//   DRAFT        — structurally valid, but missing a gameUrl and/or a proxyRef, or
//                  a reference does not resolve yet. Legal to save while setting up.
//   READY_TO_RUN — gameUrl present+valid, every proxyRef/browserProfile/device
//                  reference resolves. Only a READY profile can be projected to a
//                  runtime config for the cluster manager.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const SLOTS = Object.freeze(['A', 'B', 'C']);
const NAME_MAX = 120;
// URL scheme policy (§5): saved game URLs may only be http/https. javascript:/data:
// and credential-bearing URLs are refused. This is NOT an environment allowlist and
// is never widened from env — active navigation later still passes the authorized
// environment gate separately.
const ALLOWED_URL_SCHEMES = Object.freeze(['http:', 'https:']);

function typedError(code, message, extra = {}) { return { ok: false, error: { code, message, ...extra } }; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// Validate + normalize a saved game URL. `null`/'' is allowed (DRAFT). A present URL
// must be http/https, must NOT carry credentials, and is host-lowercased. Returns
// { ok, url } with url === null when absent.
function normalizeGameUrl(raw) {
  if (raw == null || String(raw).trim() === '') return { ok: true, url: null };
  const text = String(raw).trim();
  let u;
  try { u = new URL(text); } catch { return typedError('PHOM_CLUSTER_GAME_URL_INVALID', 'Game URL is not a valid absolute URL'); }
  if (!ALLOWED_URL_SCHEMES.includes(u.protocol)) {
    return typedError('PHOM_CLUSTER_GAME_URL_INVALID', `Game URL scheme not allowed: ${u.protocol}`, { allowed: ALLOWED_URL_SCHEMES });
  }
  if (u.username || u.password) {
    return typedError('PHOM_CLUSTER_GAME_URL_CREDENTIAL_FORBIDDEN', 'Game URL must not contain a username/password');
  }
  // Normalize host casing; keep path/query/hash verbatim (the game may need them).
  u.hostname = u.hostname.toLowerCase();
  return { ok: true, url: u.toString() };
}

// defaultStake: typed-optional positive number (mirrors browser-config amount). null
// keeps the "unset" state legal in both DRAFT and READY.
function normalizeStake(raw) {
  if (raw == null || raw === '') return { ok: true, stake: null };
  const { value, error } = parseStrict(raw, { gt: 0, allowNull: false });
  if (error) return typedError('PHOM_CLUSTER_STAKE_INVALID', 'defaultStake must be a positive number', { reason: error });
  return { ok: true, stake: value };
}

function normalizeSlot(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    browserProfileId: isNonEmptyString(s.browserProfileId) ? String(s.browserProfileId).trim() : null,
    deviceProfileId: isNonEmptyString(s.deviceProfileId) ? String(s.deviceProfileId).trim() : null,
    proxyRef: isNonEmptyString(s.proxyRef) ? String(s.proxyRef).trim() : null,
  };
}

function genId() { return `PHCL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }

/**
 * normalizeClusterProfile(input, { existing }) -> { ok, profile } | typed error.
 * Produces a persistable profile with ONLY whitelisted fields (unknown/runtime fields
 * are dropped by construction — never copied through). Enforces the STRUCTURAL
 * invariants (always, for both DRAFT and READY): a trimmed name within the length
 * cap, exactly slots A/B/C, each slot with a browserProfileId + deviceProfileId, a
 * valid-if-present game URL with no credentials, a defaultHostSlot of A/B/C, and no
 * duplicate browser profile across slots. It deliberately does NOT resolve references
 * (that is reference/readiness validation, done by the store with live resolvers).
 */
function normalizeClusterProfile(input = {}, { existing = null } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const ex = existing || {};

  // schemaVersion: only the current version is accepted for a live object.
  const incomingVersion = src.schemaVersion != null ? Number(src.schemaVersion) : (ex.schemaVersion != null ? Number(ex.schemaVersion) : SCHEMA_VERSION);
  if (!Number.isInteger(incomingVersion) || incomingVersion > SCHEMA_VERSION) {
    return typedError('PHOM_CLUSTER_PROFILE_SCHEMA_UNSUPPORTED', `Unsupported cluster profile schema: ${src.schemaVersion}`, { supported: SCHEMA_VERSION });
  }

  // id: immutable once set. On update the existing id wins; a client cannot change it.
  const id = isNonEmptyString(ex.id) ? String(ex.id) : (isNonEmptyString(src.id) ? String(src.id).trim() : genId());

  // name: required, trimmed, length-capped.
  const nameRaw = src.name !== undefined ? src.name : ex.name;
  if (!isNonEmptyString(nameRaw)) return typedError('PHOM_CLUSTER_PROFILE_NAME_REQUIRED', 'A cluster profile name is required');
  const name = String(nameRaw).trim().slice(0, NAME_MAX);

  // gameUrl (saved config only; DRAFT may be null).
  const urlRes = normalizeGameUrl(src.gameUrl !== undefined ? src.gameUrl : ex.gameUrl);
  if (!urlRes.ok) return urlRes;

  // defaultHostSlot ∈ A/B/C.
  const hostSlot = src.defaultHostSlot !== undefined ? src.defaultHostSlot : ex.defaultHostSlot;
  const defaultHostSlot = hostSlot != null ? String(hostSlot).trim().toUpperCase() : 'A';
  if (!SLOTS.includes(defaultHostSlot)) return typedError('PHOM_CLUSTER_HOST_SLOT_INVALID', `defaultHostSlot must be A/B/C, got ${hostSlot}`);

  // defaultStake: typed-optional.
  const stakeRes = normalizeStake(src.defaultStake !== undefined ? src.defaultStake : ex.defaultStake);
  if (!stakeRes.ok) return stakeRes;

  // slots: exactly A/B/C, each with a browserProfileId + deviceProfileId. A missing
  // slot key is PHOM_CLUSTER_SLOT_MISSING; a present slot lacking a browser/device ref
  // is a structural error too (DRAFT only ever relaxes proxyRef + gameUrl).
  const srcSlots = (src.slots && typeof src.slots === 'object') ? src.slots : (ex.slots || {});
  const slots = {};
  for (const s of SLOTS) {
    if (!srcSlots || srcSlots[s] == null) return typedError('PHOM_CLUSTER_SLOT_MISSING', `slot ${s} is required`, { slot: s });
    const slot = normalizeSlot(srcSlots[s]);
    if (!slot.browserProfileId) return typedError('PHOM_CLUSTER_BROWSER_PROFILE_MISSING', `slot ${s} requires a browserProfileId`, { slot: s });
    if (!slot.deviceProfileId) return typedError('PHOM_CLUSTER_DEVICE_PROFILE_MISSING', `slot ${s} requires a deviceProfileId`, { slot: s });
    slots[s] = slot;
  }
  // Reject any extra slot keys beyond A/B/C (structural isolation).
  for (const k of Object.keys(srcSlots || {})) if (!SLOTS.includes(k)) return typedError('PHOM_CLUSTER_SLOT_MISSING', `unknown slot key ${k}`, { slot: k });

  // §4 — the three browser profiles must be independent (policy: no shared profile).
  const browserIds = SLOTS.map((s) => slots[s].browserProfileId);
  const dupBrowser = firstDuplicate(browserIds);
  if (dupBrowser) return typedError('PHOM_CLUSTER_DUPLICATE_BROWSER_PROFILE', `browserProfileId ${dupBrowser} is used by more than one slot`, { browserProfileId: dupBrowser });

  const profile = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    gameUrl: urlRes.url,
    defaultHostSlot,
    defaultStake: stakeRes.stake,
    slots,
    createdAt: isNonEmptyString(ex.createdAt) ? ex.createdAt : null, // stamped by the store
    updatedAt: isNonEmptyString(ex.updatedAt) ? ex.updatedAt : null, // stamped by the store
  };
  return { ok: true, profile };
}

function firstDuplicate(arr) {
  const seen = new Set();
  for (const v of arr) { if (v == null) continue; if (seen.has(v)) return v; seen.add(v); }
  return null;
}

// The minimal structural readiness (no live refs): a gameUrl is present and every
// slot carries a proxyRef. This is the subset of READY that can be decided from the
// profile alone; the store layers reference existence on top (validateReady).
function missingReadyFields(profile) {
  const missing = [];
  if (!profile.gameUrl) missing.push('gameUrl');
  for (const s of SLOTS) { if (!profile.slots[s] || !profile.slots[s].proxyRef) missing.push(`slots.${s}.proxyRef`); }
  return missing;
}

// Derive DRAFT vs READY_TO_RUN given a set of already-resolved reference checks. The
// store calls this after confirming references; the model only decides from inputs.
// `resolved` (optional) may carry { proxyMissing:[], browserMissing:[], deviceMissing:[] }.
function deriveState(profile, resolved = null) {
  if (missingReadyFields(profile).length) return 'DRAFT';
  if (resolved) {
    if ((resolved.proxyMissing || []).length) return 'DRAFT';
    if ((resolved.browserMissing || []).length) return 'DRAFT';
    if ((resolved.deviceMissing || []).length) return 'DRAFT';
  }
  return 'READY_TO_RUN';
}

// A public snapshot for UI/IPC. There are no secrets in a cluster profile by design;
// this is the canonical, field-ordered view (also used for deterministic persistence).
function publicSnapshot(profile, { state = null } = {}) {
  if (!profile) return null;
  return {
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    name: profile.name,
    gameUrl: profile.gameUrl,
    defaultHostSlot: profile.defaultHostSlot,
    defaultStake: profile.defaultStake,
    slots: {
      A: { ...profile.slots.A },
      B: { ...profile.slots.B },
      C: { ...profile.slots.C },
    },
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    state: state || deriveState(profile),
  };
}

/**
 * toClusterRuntimeConfig(profile, resolved) -> { ok, config } | typed error.
 * PURE projection consumed LATER by PhomClusterCdpManager (which must never read the
 * JSON store directly). `resolved` is supplied by the caller after resolving refs:
 *   resolved = { slots: { A: { browserProfile, device, proxyRef }, ... } }
 * where browserProfile/device are the caller-resolved objects (metadata only) and
 * proxyRef is the proxy id (NEVER a password). The projection:
 *   - rejects unless the profile is READY_TO_RUN (refs resolve + url + proxies),
 *   - maps each slot 1:1 (a slot's device/proxy never moves to another slot),
 *   - keeps the HOST assignment from defaultHostSlot,
 *   - carries the shared gameUrl + selected stake,
 *   - contains NO secret and NO persisted runtime identifier,
 *   - never mutates `profile`.
 */
function toClusterRuntimeConfig(profile, resolved = {}) {
  if (!profile) return typedError('PHOM_CLUSTER_PROFILE_NOT_FOUND', 'No cluster profile');
  const resSlots = (resolved && resolved.slots) || {};
  // Reference-level readiness check from the resolved inputs.
  const proxyMissing = [], browserMissing = [], deviceMissing = [];
  for (const s of SLOTS) {
    const slot = profile.slots[s];
    const r = resSlots[s] || {};
    if (!slot.proxyRef) proxyMissing.push(s);
    else if (!r.proxyRef) proxyMissing.push(s);
    if (!r.browserProfile) browserMissing.push(s);
    if (!r.device) deviceMissing.push(s);
  }
  const state = deriveState(profile, { proxyMissing, browserMissing, deviceMissing });
  if (state !== 'READY_TO_RUN') {
    return typedError('PHOM_CLUSTER_PROFILE_NOT_READY', 'Cluster profile is not READY_TO_RUN', { proxyMissing, browserMissing, deviceMissing, gameUrl: !!profile.gameUrl });
  }
  const slots = {};
  for (const s of SLOTS) {
    const r = resSlots[s];
    slots[s] = {
      browserProfile: r.browserProfile,   // caller-resolved metadata (no secret)
      deviceProfile: r.device,            // caller-resolved device (no secret)
      proxyRef: profile.slots[s].proxyRef, // reference id only — never a password
    };
  }
  const config = {
    clusterProfileId: profile.id,
    gameUrl: profile.gameUrl,
    hostProfileId: profile.defaultHostSlot, // HOST slot (A/B/C); the runtime maps it to a run id
    hostSlot: profile.defaultHostSlot,
    selectedStake: profile.defaultStake,
    slots,
  };
  return { ok: true, config, state };
}

module.exports = {
  SCHEMA_VERSION, SLOTS, NAME_MAX, ALLOWED_URL_SCHEMES,
  normalizeGameUrl, normalizeStake, normalizeClusterProfile,
  missingReadyFields, deriveState, publicSnapshot, toClusterRuntimeConfig,
};
