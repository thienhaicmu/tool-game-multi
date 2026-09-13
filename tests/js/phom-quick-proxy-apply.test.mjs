import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyQuickProxies } = require('../../desktop/protocol/phom/quick-proxy-apply.cjs');
const { parseQuickProxies } = require('../../desktop/browser-run/phom-quick-proxy.cjs');
const { ProxyConfigStore } = require('../../desktop/browser-run/proxy-config-store.cjs');
const { ProxySecretStore } = require('../../desktop/browser-run/proxy-secret-store.cjs');
const { PhomProfileStore } = require('../../desktop/browser-run/phom-profile-store.cjs');
const { PhomClusterProfileStore } = require('../../desktop/browser-run/phom-cluster-profile-store.cjs');

const SLOTS = ['A', 'B', 'C'];
const threeSlots = () => parseQuickProxies('h1|8080|u1|p1\nh2|8081|u2|p2\nh3|8082|u3|p3', { protocol: 'http' }).slots;

// =========================== B. PURE ATOMIC APPLY ==========================

function mockOps(over = {}) {
  const created = new Map();     // id -> descriptor
  const removed = [];
  const boundRefs = {};          // browserProfileId -> proxyRef
  let seq = 0;
  return {
    created, removed, boundRefs,
    ops: {
      isClusterActive: over.isClusterActive || (() => false),
      createProxy: over.createProxy || ((d) => { const id = `PX-${++seq}`; created.set(id, d); return { ok: true, id }; }),
      removeProxy: over.removeProxy || ((id) => { removed.push(id); created.delete(id); return { ok: true }; }),
      setProfileProxyRef: over.setProfileProxyRef || ((bpid, ref) => { boundRefs[bpid] = ref; return { ok: true }; }),
      getClusterProfile: over.getClusterProfile || (() => null),
      updateClusterProfile: over.updateClusterProfile || (() => ({ ok: true })),
      validateCluster: over.validateCluster || (() => ({ ok: true, state: 'READY_TO_RUN' })),
    },
  };
}

test('3/3 success binds A/B/C to their own new proxyRefs (no cross-use)', () => {
  const m = mockOps();
  const res = applyQuickProxies({ slots: threeSlots() }, m.ops);
  assert.equal(res.ok, true);
  assert.equal(new Set(Object.values(res.refs)).size, 3);
  assert.equal(m.boundRefs.A, res.refs.A);
  assert.equal(m.boundRefs.B, res.refs.B);
  assert.equal(m.boundRefs.C, res.refs.C);
  assert.equal(m.removed.length, 0);
});

test('secret-save failure on slot B rolls back A and never leaves a 1/3 state', () => {
  let n = 0;
  const m = mockOps({ createProxy: (d) => { n++; if (n === 2) return { ok: false, error: { code: 'PHOM_PROXY_SECRET_SAVE_FAILED' } }; return { ok: true, id: `PX-${n}` }; } });
  const res = applyQuickProxies({ slots: threeSlots() }, m.ops);
  assert.equal(res.ok, false);
  assert.equal(res.error.slot, 'B');
  // A (the only one created before B failed) is rolled back; nothing is bound.
  assert.deepEqual(m.removed, ['PX-1']);
  assert.equal(Object.keys(m.boundRefs).length, 0);
});

test('profile-bind failure rolls back ALL created proxies', () => {
  let bind = 0;
  const m = mockOps({ setProfileProxyRef: (bpid, ref) => { bind++; if (bind === 3) return { ok: false, error: { code: 'X' } }; return { ok: true }; } });
  const res = applyQuickProxies({ slots: threeSlots() }, m.ops);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_PROXY_QUICK_APPLY_PARTIAL');
  assert.equal(m.removed.length, 3); // all three created proxies removed
});

test('cluster-update failure rolls back created proxies', () => {
  const m = mockOps({ getClusterProfile: () => ({ id: 'CL1', slots: { A: { browserProfileId: 'A', deviceProfileId: 'dA' }, B: { browserProfileId: 'B', deviceProfileId: 'dB' }, C: { browserProfileId: 'C', deviceProfileId: 'dC' } } }), updateClusterProfile: () => ({ ok: false, error: { code: 'BOOM' } }) });
  const res = applyQuickProxies({ slots: threeSlots(), clusterProfileId: 'CL1' }, m.ops);
  assert.equal(res.ok, false);
  assert.equal(m.removed.length, 3);
});

test('an active cluster refuses the apply (IN_USE) and mutates nothing', () => {
  const m = mockOps({ isClusterActive: () => true, getClusterProfile: () => ({ id: 'CL1', slots: {} }) });
  const res = applyQuickProxies({ slots: threeSlots(), clusterProfileId: 'CL1' }, m.ops);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_CLUSTER_PROFILE_IN_USE');
  assert.equal(m.created.size, 0);
  assert.equal(m.removed.length, 0);
});

test('missing cluster profile is typed and mutates nothing', () => {
  const m = mockOps({ getClusterProfile: () => null });
  const res = applyQuickProxies({ slots: threeSlots(), clusterProfileId: 'nope' }, m.ops);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'PHOM_CLUSTER_PROFILE_NOT_FOUND');
  assert.equal(m.created.size, 0);
});

// =========================== C. SECRET SAFETY (real stores) ================

function realStores() {
  const dir = mkdtempSync(join(tmpdir(), 'phom-qp-'));
  const proxyFile = join(dir, 'proxies.json');
  const secretFile = join(dir, 'proxy-secrets.dat');
  const profileFile = join(dir, 'phom-profiles.json');
  const clusterFile = join(dir, 'cluster.json');
  const secretStore = new ProxySecretStore({ filePath: secretFile, safeStorage: null }); // session-only (never plaintext on disk)
  const proxyStore = new ProxyConfigStore({ filePath: proxyFile, secretStore });
  const profileStore = new PhomProfileStore({ filePath: profileFile });
  // seed three device-bearing browser profiles so a cluster profile can be READY
  for (const s of SLOTS) profileStore.upsert(s, { name: `P${s}`, device: { presetId: 'android-pixel5-landscape' } });
  const clusterStore = new PhomClusterProfileStore({
    filePath: clusterFile,
    resolveBrowserProfile: (id) => profileStore.getPublic(id),
    resolveDevice: (bpid, deviceId) => { const dev = profileStore.deviceFor(bpid); return dev && String(dev.id) === String(deviceId) ? { id: dev.id } : null; },
    resolveProxy: (ref) => proxyStore.getPublic(ref),
    isActive: () => false,
  });
  clusterStore.load();
  return { dir, proxyFile, secretFile, profileFile, clusterFile, secretStore, proxyStore, profileStore, clusterStore };
}

function realOps(st, activeId = null) {
  return {
    isClusterActive: (id) => activeId && String(activeId) === String(id),
    createProxy: ({ protocol, host, port, username, password }) => { const r = st.proxyStore.upsert({ protocol, host, port, username: username || null, password: password != null ? password : null, label: `${protocol}://${host}:${port}` }); return r && r.ok ? { ok: true, id: r.id } : r; },
    removeProxy: (id) => st.proxyStore.remove(id),
    setProfileProxyRef: (bpid, ref) => st.profileStore.upsert(String(bpid), { proxyRef: ref }),
    getClusterProfile: (id) => st.clusterStore.get(id),
    updateClusterProfile: (id, patch) => st.clusterStore.update(id, patch),
    validateCluster: (id) => st.clusterStore.validateReady(id),
  };
}

test('apply via real stores: password lives ONLY in the secret store (never metadata/cluster JSON/public)', () => {
  const st = realStores();
  const slots = parseQuickProxies('h1|8080|u1|SUPERSECRET1\nh2|8081|u2|SUPERSECRET2\nh3|8082|u3|SUPERSECRET3', { protocol: 'socks5' }).slots;
  const res = applyQuickProxies({ slots }, realOps(st));
  assert.equal(res.ok, true);

  // proxy metadata JSON on disk contains NO password
  const proxyJson = readFileSync(st.proxyFile, 'utf8');
  assert.equal(/SUPERSECRET/.test(proxyJson), false);
  // public list (what the renderer sees) contains NO password
  assert.equal(/SUPERSECRET/.test(JSON.stringify(st.proxyStore.list())), false);
  // secret file is session-only backend => not written as plaintext
  assert.equal(/SUPERSECRET/.test(String(safeRead(st.secretFile))), false);
  // the IPC-style result carries only refs, never a secret
  assert.equal(/SUPERSECRET/.test(JSON.stringify(res)), false);
  // but the transport CAN still resolve the password from the secret store
  assert.equal(st.proxyStore.resolvePassword(res.refs.A), 'SUPERSECRET1');
});

test('apply updates the selected cluster profile refs and its JSON holds NO password', () => {
  const st = realStores();
  // create a READY-ish cluster profile referencing A/B/C browser+device (proxy added by apply)
  const created = st.clusterStore.create({ name: 'Bàn', gameUrl: 'https://g.example.com/p', defaultHostSlot: 'A',
    slots: { A: { browserProfileId: 'A', deviceProfileId: deviceId(st, 'A') }, B: { browserProfileId: 'B', deviceProfileId: deviceId(st, 'B') }, C: { browserProfileId: 'C', deviceProfileId: deviceId(st, 'C') } } });
  assert.equal(created.ok, true);
  const slots = parseQuickProxies('h1|8080|u1|PWA\nh2|8081|u2|PWB\nh3|8082|u3|PWC', { protocol: 'http' }).slots;
  const res = applyQuickProxies({ slots, clusterProfileId: created.profile.id }, realOps(st));
  assert.equal(res.ok, true);
  const prof = st.clusterStore.getPublic(created.profile.id);
  for (const s of SLOTS) assert.equal(prof.slots[s].proxyRef, res.refs[s]);
  assert.equal(prof.state, 'READY_TO_RUN'); // now fully resolvable
  const clusterJson = readFileSync(st.clusterFile, 'utf8');
  assert.equal(/PWA|PWB|PWC/.test(clusterJson), false);
});

test('a stale password IS preserved when the config store keeps it; apply creates fresh configs', () => {
  const st = realStores();
  const slots = parseQuickProxies('h1|1|u|KEEPME\nh2|2\nh3|3', { protocol: 'http' }).slots;
  const res = applyQuickProxies({ slots }, realOps(st));
  assert.equal(res.ok, true);
  assert.equal(st.proxyStore.resolvePassword(res.refs.A), 'KEEPME');
});

function deviceId(st, slot) { const d = st.profileStore.deviceFor(slot); return d ? String(d.id) : null; }
function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }
