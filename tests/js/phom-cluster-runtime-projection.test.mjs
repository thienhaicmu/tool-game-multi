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
//   - selected profile drives create; A/B/C resolve to their OWN agent/proxy (1:1)
//   - the shared gameUrl is carried to all three slots
//   - renderer-injected loose fields cannot override the persisted refs
//   - a missing/stale reference / non-ready profile fails TYPED (opens nothing)
// ---------------------------------------------------------------------------

// The browser AGENT of each browser profile, distinct per slot.
const AGENTS = { A: 'MOBILE', B: 'WEB', C: 'MOBILE' };

function resolvers(opts = {}) {
  const knownProxies = new Set(opts.proxies || ['PX-a', 'PX-b', 'PX-c']);
  const knownBrowsers = new Set(opts.browsers || ['A', 'B', 'C']);
  return {
    resolveBrowserProfile: (id) => (knownBrowsers.has(id) ? { slot: id, name: `Profile ${id}`, proxyRef: null } : null),
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
      A: { browserProfileId: 'A', proxyRef: 'PX-a' },
      B: { browserProfileId: 'B', proxyRef: 'PX-b' },
      C: { browserProfileId: 'C', proxyRef: 'PX-c' },
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

// The main-process resolveAgent: the authoritative agent keyed by browserProfileId.
const agentResolver = (bpid) => AGENTS[bpid] || null;

// ---- pure projection -------------------------------------------------------

test('projection maps a READY runtime config 1:1 into manager profiles (agent/proxy per slot)', () => {
  const store = newStore();
  const created = store.create(validInput());
  assert.equal(created.ok, true);
  const rt = store.toRuntimeConfig(created.profile.id);
  assert.equal(rt.ok, true);

  const proj = projectRuntimeToManagerConfig(rt.config, { resolveAgent: agentResolver });
  assert.equal(proj.ok, true);
  assert.equal(proj.config.hostSlot, 'B');
  assert.equal(proj.config.selectedStake, 1000);
  assert.match(proj.config.gameUrl, /^https:\/\/game\.example\.com/);
  assert.equal(proj.config.clusterProfileId, created.profile.id);

  const bySlot = Object.fromEntries(proj.config.profiles.map((p) => [p.slot, p]));
  assert.deepEqual(Object.keys(bySlot).sort(), ['A', 'B', 'C']);
  // 1:1 — each slot resolves to ITS OWN browser profile/agent/proxy, never crossed.
  assert.equal(bySlot.A.browserProfileId, 'A');
  assert.equal(bySlot.A.agent, 'MOBILE');
  assert.equal(bySlot.A.proxyRef, 'PX-a');
  assert.equal(bySlot.B.agent, 'WEB');
  assert.equal(bySlot.B.proxyRef, 'PX-b');
  assert.equal(bySlot.C.agent, 'MOBILE');
  assert.equal(bySlot.C.proxyRef, 'PX-c');
});

test('the shared gameUrl is carried to ALL THREE slots', () => {
  const store = newStore();
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveAgent: agentResolver });
  for (const p of proj.config.profiles) assert.equal(p.gameUrl, proj.config.gameUrl);
});

test('projection never emits a secret (proxyRef is an id only)', () => {
  const store = newStore();
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveAgent: agentResolver });
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

test('proxy OPTIONAL: all-Direct profile projects with executionMode DIRECT (no PROXY_MISSING)', () => {
  const store = newStore({ resolverOpts: { proxies: [] } });
  const created = store.create(validInput({ slots: {
    A: { browserProfileId: 'A', proxyRef: null },
    B: { browserProfileId: 'B', proxyRef: null },
    C: { browserProfileId: 'C', proxyRef: null },
  } }));
  const rt = store.toRuntimeConfig(created.profile.id);
  assert.equal(rt.ok, true, 'all-Direct is READY (proxy optional)');
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveAgent: agentResolver });
  assert.equal(proj.ok, true);
  for (const p of proj.config.profiles) { assert.equal(p.proxyRef, null); assert.equal(p.executionMode, 'DIRECT'); }
});

test('proxy OPTIONAL: mixed PROXY/DIRECT/PROXY projects with per-slot executionMode + proxyRef 1:1', () => {
  const store = newStore({ resolverOpts: { proxies: ['PX-a', 'PX-c'] } });
  const created = store.create(validInput({ slots: {
    A: { browserProfileId: 'A', proxyRef: 'PX-a' },
    B: { browserProfileId: 'B', proxyRef: null },
    C: { browserProfileId: 'C', proxyRef: 'PX-c' },
  } }));
  const rt = store.toRuntimeConfig(created.profile.id);
  assert.equal(rt.ok, true);
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveAgent: agentResolver });
  assert.equal(proj.ok, true);
  const bySlot = Object.fromEntries(proj.config.profiles.map((p) => [p.slot, p]));
  assert.equal(bySlot.A.executionMode, 'PROXY'); assert.equal(bySlot.A.proxyRef, 'PX-a');
  assert.equal(bySlot.B.executionMode, 'DIRECT'); assert.equal(bySlot.B.proxyRef, null);
  assert.equal(bySlot.C.executionMode, 'PROXY'); assert.equal(bySlot.C.proxyRef, 'PX-c');
});

test('a profile with no agent set projects with a null agent (the default is applied at launch)', () => {
  const store = newStore();
  const created = store.create(validInput());
  const rt = store.toRuntimeConfig(created.profile.id);
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveAgent: (bpid) => (bpid === 'C' ? null : agentResolver(bpid)) });
  assert.equal(proj.ok, true);
  assert.equal(proj.config.profiles.find((p) => p.slot === 'C').agent, null, 'null means "use the default agent", not a failure');
  assert.equal(proj.config.profiles.find((p) => p.slot === 'A').agent, 'MOBILE');
});

test('projection requires the shared gameUrl (typed)', () => {
  const proj = projectRuntimeToManagerConfig({ clusterProfileId: 'X', hostSlot: 'A', slots: {} }, { resolveAgent: agentResolver });
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
  // The projection reads ONLY browserProfile.slot + resolveAgent(browserProfileId) +
  // the slot's proxyRef; injected executablePath/cdpPort/pid are never read into config.
  const proj = projectRuntimeToManagerConfig(tampered, { resolveAgent: agentResolver });
  assert.equal(proj.ok, true);
  const a = proj.config.profiles.find((p) => p.slot === 'A');
  // the agent comes from the AUTHORITATIVE resolver keyed by browserProfileId 'A', not from the payload
  assert.equal(a.agent, 'MOBILE');
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
  const proj = projectRuntimeToManagerConfig(rt.config, { resolveAgent: agentResolver });
  assert.equal(proj.config.clusterProfileId, b.profile.id);
  void a;
});
