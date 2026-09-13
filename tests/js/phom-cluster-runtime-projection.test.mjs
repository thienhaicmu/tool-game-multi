import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PhomClusterProfileStore } = require('../../desktop/browser-run/phom-cluster-profile-store.cjs');
const { projectRuntimeToManagerConfig } = require('../../desktop/protocol/phom/cluster-runtime-projection.cjs');

// ---------------------------------------------------------------------------
// §3 / §16.A — the SAVED cluster profile is the authoritative source for opening
// the cluster. These tests exercise the owner path shape:
//   store.toRuntimeConfig(id) -> projectRuntimeToManagerConfig(rt, resolvers)
// which is exactly what phom-main's phom:cluster-create handler runs. They prove:
//   - selected profile drives create; A/B/C resolve to their OWN device/proxy (1:1)
//   - the shared gameUrl is carried to all three slots
//   - renderer-injected loose fields cannot override the persisted refs
//   - a missing/stale reference / non-ready profile fails TYPED (opens nothing)
// ---------------------------------------------------------------------------

// Raw devices (emulation-ready) keyed by browser profile id, distinct per slot.
const RAW_DEVICES = {
  A: { id: 'dev-A', name: 'Dev A', viewportWidth: 851, viewportHeight: 393, mobile: true, touch: true },
  B: { id: 'dev-B', name: 'Dev B', viewportWidth: 780, viewportHeight: 360, mobile: true, touch: true },
  C: { id: 'dev-C', name: 'Dev C', viewportWidth: 800, viewportHeight: 360, mobile: true, touch: true },
};

function resolvers(opts = {}) {
  const knownProxies = new Set(opts.proxies || ['PX-a', 'PX-b', 'PX-c']);
  const knownBrowsers = new Set(opts.browsers || ['A', 'B', 'C']);
  return {
    resolveBrowserProfile: (id) => (knownBrowsers.has(id) ? { slot: id, name: `Profile ${id}`, proxyRef: null } : null),
    resolveDevice: (bpid, deviceId) => (knownBrowsers.has(bpid) && deviceId === `dev-${bpid}` ? { id: deviceId, name: `Dev ${bpid}`, viewportWidth: RAW_DEVICES[bpid].viewportWidth, viewportHeight: RAW_DEVICES[bpid].viewportHeight } : null),
    resolveProxy: (ref) => (knownProxies.has(ref) ? { id: ref, endpoint: '1.2.3.4:8080' } : null),
  };
}

function validInput(over = {}) {
  return {
    name: 'Bàn 1',
    gameUrl: 'https://game.example.com/phom?room=7',
    defaultHostSlot: 'B',
    defaultStake: 1000,
    slots: {
      A: { browserProfileId: 'A', deviceProfileId: 'dev-A', proxyRef: 'PX-a' },
      B: { browserProfileId: 'B', deviceProfileId: 'dev-B', proxyRef: 'PX-b' },
      C: { browserProfileId: 'C', deviceProfileId: 'dev-C', proxyRef: 'PX-c' },
    },
    ...over,
  };
}

function newStore(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phom-cluster-proj-'));
  const store = new PhomClusterProfileStore({ filePath: join(dir, 'p.json'), ...resolvers(extra.resolverOpts || {}), ...extra });
  store.load();
  return store;
}

// The main-process resolveRawDevice: authoritative raw device keyed by browserProfileId.
const rawDeviceResolver = (bpid, did) => { const dev = RAW_DEVICES[bpid]; return dev && (did == null || String(dev.id) === String(did)) ? dev : null; };

// ---- pure projection -------------------------------------------------------

test('projection maps a READY runtime config 1:1 into manager profiles (device/proxy per slot)', () => {
  const store = newStore();
  const created = store.create(validInput());
  assert.equal(created.ok, true);
  const rt = store.toRuntimeConfig(created.profile.id);
  assert.equal(rt.ok, true);

  const proj = projectRuntimeToManagerConfig(rt.config, { resolveRawDevice: rawDeviceResolver });
  assert.equal(proj.ok, true);
  assert.equal(proj.config.hostSlot, 'B');
  assert.equal(proj.config.selectedStake, 1000);
  assert.match(proj.config.gameUrl, /^https:\/\/game\.example\.com/);
  assert.equal(proj.config.clusterProfileId, created.profile.id);

  const bySlot = Object.fromEntries(proj.config.profiles.map((p) => [p.slot, p]));
  assert.deepEqual(Object.keys(bySlot).sort(), ['A', 'B', 'C']);
  // 1:1 — each slot resolves to ITS OWN browser/device/proxy, never crossed.
  assert.equal(bySlot.A.browserProfileId, 'A');
  assert.equal(bySlot.A.device.id, 'dev-A');
  assert.equal(bySlot.A.proxyRef, 'PX-a');
  assert.equal(bySlot.B.device.id, 'dev-B');
  assert.equal(bySlot.B.proxyRef, 'PX-b');
  assert.equal(bySlot.C.device.id, 'dev-C');
  assert.equal(bySlot.C.proxyRef, 'PX-c');
  // distinct device objects (no cross-contamination)
  assert.equal(new Set(proj.config.profiles.map((p) => p.device.id)).size, 3);
});

test('the shared gameUrl is carried to ALL THREE slots', () => {
  const store = newStore();
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveRawDevice: rawDeviceResolver });
  for (const p of proj.config.profiles) assert.equal(p.gameUrl, proj.config.gameUrl);
});

test('projection never emits a secret (proxyRef is an id only)', () => {
  const store = newStore();
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveRawDevice: rawDeviceResolver });
  assert.equal(/password|token|cookie|secret|authorization/i.test(JSON.stringify(proj.config)), false);
});

// ---- typed failures BEFORE any browser opens ------------------------------

test('a non-ready profile (no gameUrl) never projects — typed, opens nothing', () => {
  const store = newStore();
  const created = store.create(validInput({ gameUrl: null })); // DRAFT
  assert.equal(created.ok, true);
  const rt = store.toRuntimeConfig(created.profile.id);
  assert.equal(rt.ok, false);
  assert.equal(rt.error.code, 'PHOM_CLUSTER_PROFILE_NOT_READY');
});

test('a stale proxy reference fails typed (PROXY_MISSING) — not silently dropped', () => {
  const store = newStore({ resolverOpts: { proxies: ['PX-a', 'PX-b'] } }); // PX-c missing
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  assert.equal(rt.ok, false);
  assert.equal(rt.error.code, 'PHOM_CLUSTER_PROFILE_NOT_READY');
  assert.deepEqual(rt.error.proxyMissing, ['C']);
});

test('projection fails typed when the raw device cannot be resolved', () => {
  const store = newStore();
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  // resolver returns null for slot C's device -> DEVICE_PROFILE_MISSING, no partial config
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveRawDevice: (bpid, did) => (bpid === 'C' ? null : rawDeviceResolver(bpid, did)) });
  assert.equal(proj.ok, false);
  assert.equal(proj.error.code, 'PHOM_CLUSTER_DEVICE_PROFILE_MISSING');
  assert.equal(proj.error.slot, 'C');
});

test('projection requires the shared gameUrl (typed)', () => {
  const proj = projectRuntimeToManagerConfig({ clusterProfileId: 'X', hostSlot: 'A', slots: {} }, { resolveRawDevice: rawDeviceResolver });
  assert.equal(proj.ok, false);
  assert.equal(proj.error.code, 'PHOM_CLUSTER_GAME_URL_REQUIRED');
});

// ---- renderer injection cannot override persisted refs --------------------

test('projection ignores loose renderer fields; only the persisted refs drive slots', () => {
  const store = newStore();
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  // Simulate a hostile renderer that tries to smuggle overrides onto the runtime config.
  const tampered = {
    ...rt.config,
    hostSlot: 'C',                    // legitimate-looking, but taken from the PROFILE below
    slots: {
      ...rt.config.slots,
      // attacker tries to smuggle runtime identifiers onto slot A
      A: { ...rt.config.slots.A, executablePath: 'C:/evil.exe', cdpPort: 9999, pid: 1, token: 'x' },
    },
  };
  // The projection reads ONLY browserProfile.slot + resolveRawDevice(browserProfileId) +
  // the slot's proxyRef; injected executablePath/cdpPort/pid are never read into config.
  const proj = projectRuntimeToManagerConfig(tampered, { resolveRawDevice: rawDeviceResolver });
  assert.equal(proj.ok, true);
  const a = proj.config.profiles.find((p) => p.slot === 'A');
  // device comes from the AUTHORITATIVE resolver keyed by browserProfileId 'A', not 'evil'
  assert.equal(a.device.id, 'dev-A');
  assert.equal(a.browserProfileId, 'A');
  // no runtime identifier / secret leaks through
  assert.equal(/executablePath|cdpPort|"pid"|token/i.test(JSON.stringify(proj.config)), false);
});

// ---- selection-driven default (id omitted) --------------------------------

test('store.selectedId + toRuntimeConfig gives the selected profile (drives create when id omitted)', () => {
  const store = newStore();
  const a = store.create(validInput({ name: 'A' }));
  const b = store.create(validInput({ name: 'B' }));
  store.select(b.profile.id);
  assert.equal(store.selectedId(), b.profile.id);
  const rt = store.toRuntimeConfig(store.selectedId());
  assert.equal(rt.ok, true);
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveRawDevice: rawDeviceResolver });
  assert.equal(proj.config.clusterProfileId, b.profile.id);
  void a;
});
