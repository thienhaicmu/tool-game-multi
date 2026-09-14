import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../desktop/browser-run/phom-cluster-profile.cjs');
const { PhomClusterProfileStore } = require('../../desktop/browser-run/phom-cluster-profile-store.cjs');

const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

// ---- shared fixtures -------------------------------------------------------
function validInput(over = {}) {
  return {
    name: 'Bàn 1',
    gameUrl: 'https://game.example.com/phom?room=7',
    defaultHostSlot: 'A',
    defaultStake: 1000,
    slots: {
      A: { browserProfileId: 'A', deviceProfileId: 'dev-A', proxyRef: 'PX-a' },
      B: { browserProfileId: 'B', deviceProfileId: 'dev-B', proxyRef: 'PX-b' },
      C: { browserProfileId: 'C', deviceProfileId: 'dev-C', proxyRef: 'PX-c' },
    },
    ...over,
  };
}

// resolvers that mimic the composition root (metadata only — NEVER a password)
function resolvers(opts = {}) {
  const knownProxies = new Set(opts.proxies || ['PX-a', 'PX-b', 'PX-c']);
  const knownBrowsers = new Set(opts.browsers || ['A', 'B', 'C']);
  return {
    resolveBrowserProfile: (id) => (knownBrowsers.has(id) ? { slot: id, name: `Profile ${id}`, proxyRef: null } : null),
    resolveDevice: (bpid, deviceId) => (knownBrowsers.has(bpid) && deviceId === `dev-${bpid}` ? { id: deviceId, name: `Dev ${bpid}`, viewportWidth: 851, viewportHeight: 393 } : null),
    resolveProxy: (ref) => (knownProxies.has(ref) ? { id: ref, endpoint: '1.2.3.4:8080', hasAuth: true } : null), // no password field by design
  };
}

function newStore(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phom-cluster-'));
  const filePath = join(dir, 'phom-cluster-profiles.json');
  const store = new PhomClusterProfileStore({ filePath, ...resolvers(), ...extra });
  store.load();
  return { store, filePath, dir };
}

// =========================== A. MODEL ======================================
test('valid three-slot profile normalizes with whitelisted fields only', () => {
  const r = model.normalizeClusterProfile(validInput());
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.profile.slots).sort(), ['A', 'B', 'C']);
  assert.equal(r.profile.defaultHostSlot, 'A');
  assert.equal(r.profile.defaultStake, 1000);
  assert.match(r.profile.gameUrl, /^https:\/\/game\.example\.com/);
});

test('DRAFT when gameUrl/proxy missing; READY when all present (via store state)', () => {
  const { store } = newStore();
  const draft = store.create(validInput({ gameUrl: null, slots: { A: { browserProfileId: 'A', deviceProfileId: 'dev-A' }, B: { browserProfileId: 'B', deviceProfileId: 'dev-B' }, C: { browserProfileId: 'C', deviceProfileId: 'dev-C' } } }));
  assert.equal(draft.ok, true);
  assert.equal(draft.profile.state, 'DRAFT');
  const ready = store.create(validInput());
  assert.equal(ready.ok, true);
  assert.equal(ready.profile.state, 'READY_TO_RUN');
});

test('missing slot / invalid host slot / duplicate browser profile are typed', () => {
  const miss = model.normalizeClusterProfile(validInput({ slots: { A: { browserProfileId: 'A', deviceProfileId: 'dev-A' }, B: { browserProfileId: 'B', deviceProfileId: 'dev-B' } } }));
  assert.equal(miss.error.code, 'PHOM_CLUSTER_SLOT_MISSING');
  const host = model.normalizeClusterProfile(validInput({ defaultHostSlot: 'Z' }));
  assert.equal(host.error.code, 'PHOM_CLUSTER_HOST_SLOT_INVALID');
  const dup = model.normalizeClusterProfile(validInput({ slots: { A: { browserProfileId: 'A', deviceProfileId: 'dev-A' }, B: { browserProfileId: 'A', deviceProfileId: 'dev-B' }, C: { browserProfileId: 'C', deviceProfileId: 'dev-C' } } }));
  assert.equal(dup.error.code, 'PHOM_CLUSTER_DUPLICATE_BROWSER_PROFILE');
});

test('missing browser/device ref in a slot is typed', () => {
  const nb = model.normalizeClusterProfile(validInput({ slots: { A: { deviceProfileId: 'dev-A' }, B: { browserProfileId: 'B', deviceProfileId: 'dev-B' }, C: { browserProfileId: 'C', deviceProfileId: 'dev-C' } } }));
  assert.equal(nb.error.code, 'PHOM_CLUSTER_BROWSER_PROFILE_MISSING');
  const nd = model.normalizeClusterProfile(validInput({ slots: { A: { browserProfileId: 'A' }, B: { browserProfileId: 'B', deviceProfileId: 'dev-B' }, C: { browserProfileId: 'C', deviceProfileId: 'dev-C' } } }));
  assert.equal(nd.error.code, 'PHOM_CLUSTER_DEVICE_PROFILE_MISSING');
});

test('name is required + length-capped', () => {
  assert.equal(model.normalizeClusterProfile(validInput({ name: '   ' })).error.code, 'PHOM_CLUSTER_PROFILE_NAME_REQUIRED');
  const long = model.normalizeClusterProfile(validInput({ name: 'x'.repeat(500) }));
  assert.equal(long.profile.name.length, model.NAME_MAX);
});

test('invalid / credential-bearing / dangerous-scheme URLs are rejected', () => {
  assert.equal(model.normalizeClusterProfile(validInput({ gameUrl: 'not a url' })).error.code, 'PHOM_CLUSTER_GAME_URL_INVALID');
  assert.equal(model.normalizeClusterProfile(validInput({ gameUrl: 'javascript:alert(1)' })).error.code, 'PHOM_CLUSTER_GAME_URL_INVALID');
  assert.equal(model.normalizeClusterProfile(validInput({ gameUrl: 'data:text/html,x' })).error.code, 'PHOM_CLUSTER_GAME_URL_INVALID');
  assert.equal(model.normalizeClusterProfile(validInput({ gameUrl: 'https://user:pass@game.example.com/' })).error.code, 'PHOM_CLUSTER_GAME_URL_CREDENTIAL_FORBIDDEN');
});

test('unknown fields and RUNTIME fields are never persisted', () => {
  const r = model.normalizeClusterProfile(validInput({
    bogus: 'x', runId: 'B-123', cdpPort: 9222, pid: 4444, targetId: 'T1', cdpSessionId: 'S1',
    handState: { foo: 1 }, joinState: 'READY', activationKey: 'KEY',
    slots: {
      A: { browserProfileId: 'A', deviceProfileId: 'dev-A', proxyRef: 'PX-a', password: 'secret', runId: 'B-1', cdpPort: 1 },
      B: { browserProfileId: 'B', deviceProfileId: 'dev-B', proxyRef: 'PX-b' },
      C: { browserProfileId: 'C', deviceProfileId: 'dev-C', proxyRef: 'PX-c' },
    },
  }));
  assert.equal(r.ok, true);
  const flat = JSON.stringify(r.profile);
  for (const banned of ['bogus', 'runId', 'cdpPort', 'pid', 'targetId', 'cdpSessionId', 'handState', 'joinState', 'activationKey', 'password', 'secret']) {
    assert.equal(flat.includes(banned), false, `persisted profile must not contain "${banned}"`);
  }
  assert.deepEqual(Object.keys(r.profile.slots.A).sort(), ['browserProfileId', 'deviceProfileId', 'proxyRef']);
});

// =========================== B. STORE ======================================
test('CRUD + duplicate + select round-trips', () => {
  const { store } = newStore();
  const c = store.create(validInput());
  assert.equal(c.ok, true);
  const id = c.profile.id;
  assert.equal(store.getPublic(id).name, 'Bàn 1');
  const u = store.update(id, { name: 'Bàn 1b', defaultStake: 2000 });
  assert.equal(u.ok, true);
  assert.equal(u.profile.name, 'Bàn 1b');
  assert.equal(u.profile.defaultStake, 2000);
  assert.equal(u.profile.id, id, 'id is immutable across update');
  const d = store.duplicate(id, 'Bàn 2');
  assert.equal(d.ok, true);
  assert.notEqual(d.profile.id, id);
  assert.equal(d.profile.name, 'Bàn 2');
  assert.equal(store.duplicate(id, '').error.code, 'PHOM_CLUSTER_PROFILE_NAME_REQUIRED');
  const sel = store.select(id);
  assert.equal(sel.ok, true);
  assert.equal(store.selectedId(), id);
  assert.equal(store.list().length, 2);
});

test('update cannot change id and cannot inject runtime fields', () => {
  const { store } = newStore();
  const id = store.create(validInput()).profile.id;
  const u = store.update(id, { id: 'HACKED', runId: 'B-9', cdpPort: 1234, name: 'ok' });
  assert.equal(u.ok, true);
  assert.equal(u.profile.id, id);
  assert.equal(JSON.stringify(store.get(id)).includes('B-9'), false);
  assert.equal(JSON.stringify(store.get(id)).includes('1234'), false);
});

test('persists across restart (new store instance reads same file)', () => {
  const { store, filePath } = newStore();
  const id = store.create(validInput()).profile.id;
  store.select(id);
  const store2 = new PhomClusterProfileStore({ filePath, ...resolvers() });
  store2.load();
  assert.equal(store2.getPublic(id).name, 'Bàn 1');
  assert.equal(store2.selectedId(), id);
});

test('atomic write leaves a valid JSON file (no .tmp lingering)', () => {
  const { store, filePath, dir } = newStore();
  store.create(validInput());
  assert.equal(existsSync(filePath), true);
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(parsed.schemaVersion, model.SCHEMA_VERSION);
  assert.ok(Array.isArray(parsed.profiles));
  assert.equal(readdirSync(dir).some((f) => f.endsWith('.tmp')), false);
});

test('corrupt JSON is recovered: backed up aside, store continues empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phom-cluster-'));
  const filePath = join(dir, 'phom-cluster-profiles.json');
  writeFileSync(filePath, '{ this is not json', 'utf8');
  const store = new PhomClusterProfileStore({ filePath, ...resolvers() });
  const res = store.load();
  assert.equal(res.ok, true);
  assert.equal(res.recovered, true);
  assert.equal(store.list().length, 0);
  assert.equal(readdirSync(dir).some((f) => f.includes('.corrupt-')), true, 'a backup of the corrupt file is kept');
  // store stays usable after recovery
  assert.equal(store.create(validInput()).ok, true);
});

// =========================== MIGRATION =====================================
test('migration is additive + idempotent; never fabricates a URL', () => {
  const source = { name: 'Cụm mặc định', slots: { A: { browserProfileId: 'A', deviceProfileId: 'dev-A', proxyRef: 'PX-a' }, B: { browserProfileId: 'B', deviceProfileId: 'dev-B', proxyRef: null }, C: { browserProfileId: 'C', deviceProfileId: 'dev-C', proxyRef: null } } };
  const { store, filePath } = newStore({ migrationSource: () => source });
  const m1 = store.migrate();
  assert.equal(m1.ok, true);
  assert.equal(m1.migrated, true);
  assert.equal(m1.profile.gameUrl, null); // DRAFT — no fake URL
  assert.equal(m1.profile.state, 'DRAFT');
  assert.equal(store.list().length, 1);
  // idempotent in the same store
  assert.equal(store.migrate().migrated, false);
  // idempotent across restart AND after the user deletes the default (marker persists)
  const id = store.list()[0].id;
  store.delete(id);
  const store2 = new PhomClusterProfileStore({ filePath, ...resolvers(), migrationSource: () => source });
  store2.load();
  assert.equal(store2.migrate().migrated, false, 'must not recreate after deletion');
  assert.equal(store2.list().length, 0);
});

test('migration skips cleanly when the source is incomplete (no fake data)', () => {
  const { store } = newStore({ migrationSource: () => ({ slots: { A: { deviceProfileId: 'dev-A' }, B: {}, C: {} } }) });
  const m = store.migrate();
  assert.equal(m.ok, true);
  assert.equal(m.migrated, false);
  assert.equal(store.list().length, 0);
});

// =================== C. REFERENCE INTEGRITY ================================
test('validateReady flags missing browser / device / proxy references', () => {
  const { store } = newStore({ ...resolvers({ browsers: ['A', 'B'], proxies: ['PX-a', 'PX-b'] }) });
  const id = store.create(validInput()).profile.id;
  const v = store.validateReady(id);
  assert.equal(v.ok, false);
  assert.equal(v.state, 'DRAFT');
  assert.deepEqual(v.missing.browser, ['C']);
  assert.deepEqual(v.missing.device, ['C']);
  assert.deepEqual(v.missing.proxy, ['C']);
  const codes = v.errors.map((e) => e.code);
  assert.ok(codes.includes('PHOM_CLUSTER_BROWSER_PROFILE_MISSING'));
  assert.ok(codes.includes('PHOM_CLUSTER_DEVICE_PROFILE_MISSING'));
  assert.ok(codes.includes('PHOM_CLUSTER_PROXY_MISSING'));
});

test('validateReady passes when all references resolve + URL present', () => {
  const { store } = newStore();
  const id = store.create(validInput()).profile.id;
  const v = store.validateReady(id);
  assert.equal(v.ok, true);
  assert.equal(v.state, 'READY_TO_RUN');
});

// ---- PROXY OPTIONAL (proxy is not required for READY) -----------------------
const directSlots = () => ({
  A: { browserProfileId: 'A', deviceProfileId: 'dev-A', proxyRef: null },
  B: { browserProfileId: 'B', deviceProfileId: 'dev-B', proxyRef: null },
  C: { browserProfileId: 'C', deviceProfileId: 'dev-C', proxyRef: null },
});

test('A/B/C ALL Direct (no proxyRef) => READY_TO_RUN (proxy optional, §12)', () => {
  const { store } = newStore({ ...resolvers({ proxies: [] }) }); // no proxies exist at all
  const id = store.create(validInput({ slots: directSlots() })).profile.id;
  const v = store.validateReady(id);
  assert.equal(v.ready, true);
  assert.equal(v.state, 'READY_TO_RUN');
  assert.deepEqual(v.missing.proxy, [], 'a null proxyRef is DIRECT, never "missing"');
});

test('mixed A=PROXY, B=DIRECT, C=PROXY => READY + per-slot executionMode mapping (§6/§13)', () => {
  const { store } = newStore({ ...resolvers({ proxies: ['PX-a', 'PX-c'] }) });
  const id = store.create(validInput({ slots: {
    A: { browserProfileId: 'A', deviceProfileId: 'dev-A', proxyRef: 'PX-a' },
    B: { browserProfileId: 'B', deviceProfileId: 'dev-B', proxyRef: null },
    C: { browserProfileId: 'C', deviceProfileId: 'dev-C', proxyRef: 'PX-c' },
  } })).profile.id;
  const v = store.validateReady(id);
  assert.equal(v.ready, true, 'a Direct middle slot does not block readiness');
  const rc = store.toRuntimeConfig(id);
  assert.equal(rc.ok, true);
  assert.equal(rc.config.slots.A.proxyRef, 'PX-a');
  assert.equal(rc.config.slots.B.proxyRef, null);
  assert.equal(rc.config.slots.C.proxyRef, 'PX-c');
  assert.equal(rc.config.slots.A.executionMode, 'PROXY');
  assert.equal(rc.config.slots.B.executionMode, 'DIRECT');
  assert.equal(rc.config.slots.C.executionMode, 'PROXY');
});

test('explicitly UNBINDING a proxyRef switches that slot back to DIRECT and stays READY (§8/§13)', () => {
  const { store } = newStore();
  const id = store.create(validInput()).profile.id;
  assert.equal(store.validateReady(id).state, 'READY_TO_RUN');
  // user clears slot B's proxy binding
  const upd = store.update(id, { slots: {
    A: { browserProfileId: 'A', deviceProfileId: 'dev-A', proxyRef: 'PX-a' },
    B: { browserProfileId: 'B', deviceProfileId: 'dev-B', proxyRef: null },
    C: { browserProfileId: 'C', deviceProfileId: 'dev-C', proxyRef: 'PX-c' },
  } });
  assert.equal(upd.ok, true);
  const v = store.validateReady(id);
  assert.equal(v.ready, true, 'still READY after unbinding B (B is now DIRECT)');
  const rc = store.toRuntimeConfig(id);
  assert.equal(rc.config.slots.B.proxyRef, null);
  assert.equal(rc.config.slots.B.executionMode, 'DIRECT');
});

test('a DANGLING proxyRef (set but unresolvable) still blocks readiness — not a silent Direct (§7)', () => {
  const { store } = newStore({ ...resolvers({ proxies: ['PX-a', 'PX-c'] }) }); // PX-b does not exist
  const id = store.create(validInput()).profile.id; // slot B binds PX-b (missing)
  const v = store.validateReady(id);
  assert.equal(v.ready, false);
  assert.deepEqual(v.missing.proxy, ['B']);
  assert.ok(v.errors.some((e) => e.code === 'PHOM_CLUSTER_PROXY_MISSING'));
});

test('deleting a cluster profile never deletes referenced proxy/browser/device', () => {
  const res = resolvers();
  let proxyResolveCalls = 0;
  const wrapped = { ...res, resolveProxy: (ref) => { proxyResolveCalls++; return res.resolveProxy(ref); } };
  const { store } = newStore(wrapped);
  const id = store.create(validInput()).profile.id;
  assert.equal(store.delete(id).ok, true);
  // resolver still resolves the same proxy afterwards (store never owns/deletes it)
  assert.ok(res.resolveProxy('PX-a'));
  assert.ok(proxyResolveCalls >= 0);
});

test('proxy secret is never read into a public snapshot or runtime config', () => {
  const { store } = newStore();
  const id = store.create(validInput()).profile.id;
  const pub = JSON.stringify(store.getPublic(id));
  assert.equal(/password|secret|passwordSecretRef/i.test(pub), false);
  const rc = store.toRuntimeConfig(id);
  assert.equal(rc.ok, true);
  assert.equal(/password|secret|passwordSecretRef/i.test(JSON.stringify(rc.config)), false);
});

// =================== D. ACTIVE-USE GUARD ==================================
test('an active cluster profile cannot be deleted; inactive can', () => {
  let active = true;
  const { store } = newStore({ isActive: (qid) => active && qid === activeId });
  var activeId = store.create(validInput()).profile.id;
  const blocked = store.delete(activeId);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'PHOM_CLUSTER_PROFILE_IN_USE');
  // stop the session -> delete succeeds
  active = false;
  assert.equal(store.delete(activeId).ok, true);
});

// =========================== E. PROJECTION =================================
test('projection maps A/B/C 1:1, keeps HOST + stake + shared URL, no cross-slot bleed', () => {
  const { store } = newStore();
  const id = store.create(validInput({ defaultHostSlot: 'B', defaultStake: 500 })).profile.id;
  const before = JSON.stringify(store.get(id));
  const rc = store.toRuntimeConfig(id);
  assert.equal(rc.ok, true);
  assert.equal(rc.config.clusterProfileId, id);
  assert.equal(rc.config.gameUrl, store.getPublic(id).gameUrl);
  assert.equal(rc.config.hostProfileId, 'B');
  assert.equal(rc.config.selectedStake, 500);
  assert.equal(rc.config.slots.A.proxyRef, 'PX-a');
  assert.equal(rc.config.slots.B.proxyRef, 'PX-b');
  assert.equal(rc.config.slots.C.proxyRef, 'PX-c');
  assert.equal(rc.config.slots.A.deviceProfile.id, 'dev-A');
  assert.equal(rc.config.slots.C.deviceProfile.id, 'dev-C');
  assert.equal(rc.config.slots.A.browserProfile.slot, 'A');
  // stored object not mutated by projection
  assert.equal(JSON.stringify(store.get(id)), before);
});

test('a DRAFT projection is rejected (not READY_TO_RUN)', () => {
  const { store } = newStore();
  const id = store.create(validInput({ gameUrl: null })).profile.id;
  const rc = store.toRuntimeConfig(id);
  assert.equal(rc.ok, false);
  assert.equal(rc.error.code, 'PHOM_CLUSTER_PROFILE_NOT_READY');
});

// =========================== F. IPC / ISOLATION ============================
test('main registers all 8 cluster-profile IPC channels, guarded + phom:-namespaced', () => {
  const mainSrc = read('desktop/phom-main.cjs');
  const channels = ['list', 'get', 'create', 'update', 'delete', 'duplicate', 'select', 'validate'];
  for (const c of channels) {
    const re = new RegExp(`ipcMain\\.handle\\('phom:cluster-profile-${c}',\\s*guarded`);
    assert.match(mainSrc, re, `phom:cluster-profile-${c} must be registered and guarded`);
  }
});

test('preload exposes the cluster-profile API over phom: channels only', () => {
  const preloadSrc = read('desktop/phom-preload.cjs');
  for (const c of ['clusterProfileList', 'clusterProfileGet', 'clusterProfileCreate', 'clusterProfileUpdate', 'clusterProfileDelete', 'clusterProfileDuplicate', 'clusterProfileSelect', 'clusterProfileValidate']) {
    assert.match(preloadSrc, new RegExp(`${c}:`), `preload must expose ${c}`);
  }
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]).filter((c) => c.includes('cluster-profile'));
  for (const c of channels) assert.match(c, /^phom:cluster-profile-/);
});

test('Control and Analytics products do not import the Phom cluster profile store', () => {
  for (const rel of ['desktop/main.cjs', 'desktop/analytics-main.cjs']) {
    const src = read(rel);
    assert.equal(/phom-cluster-profile-store|phom-cluster-profile\.cjs/.test(src), false, `${rel} must not access the Phom cluster profile store`);
  }
});
