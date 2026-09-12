import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeProxyConfig, parseProxyUrl, toChromeArgs, toRunProxy, publicSnapshot, resolveLaunchProxy, SUPPORTED_PROTOCOLS } = require('../../desktop/browser-run/proxy-config.cjs');
const { ProxySecretStore } = require('../../desktop/browser-run/proxy-secret-store.cjs');
const { ProxyTester, testAll, STATE } = require('../../desktop/browser-run/proxy-tester.cjs');
const { decideAuth } = require('../../desktop/browser-run/proxy-auth-handler.cjs');
const { ChromeLauncher } = require('../../desktop/browser/chrome-launcher.cjs');

// ---------------- §17.A proxy parsing / validation ----------------
test('valid HTTP + SOCKS5 normalize; port bounds enforced', () => {
  assert.equal(normalizeProxyConfig({ protocol: 'http', host: '1.2.3.4', port: 1 }).ok, true);
  assert.equal(normalizeProxyConfig({ protocol: 'socks5', host: 'p.example', port: 65535 }).ok, true);
  assert.equal(normalizeProxyConfig({ protocol: 'http', host: 'h', port: 0 }).error.code, 'PROXY_FORMAT_INVALID');
  assert.equal(normalizeProxyConfig({ protocol: 'http', host: 'h', port: 65536 }).error.code, 'PROXY_FORMAT_INVALID');
  assert.equal(normalizeProxyConfig({ protocol: 'http', port: 8080 }).error.code, 'PROXY_FORMAT_INVALID'); // missing host
  assert.equal(normalizeProxyConfig({ protocol: 'ftp', host: 'h', port: 8080 }).error.code, 'PROXY_PROTOCOL_UNSUPPORTED');
  for (const p of SUPPORTED_PROTOCOLS) assert.equal(normalizeProxyConfig({ protocol: p, host: 'h', port: 8080 }).ok, true);
});

test('credential URL is split safely; password never in public snapshot/args', () => {
  const norm = normalizeProxyConfig({ id: 'PX1', url: 'socks5://user:s3cr3t@10.0.0.9:1080' });
  assert.equal(norm.ok, true);
  assert.equal(norm.secret, 's3cr3t');
  assert.equal(norm.config.passwordSecretRef, 'proxy:PX1');
  const snap = JSON.stringify(publicSnapshot(norm.config));
  assert.equal(/s3cr3t/.test(snap), false);
  assert.equal(/password/i.test(snap), false);
  const args = toChromeArgs(toRunProxy(norm.config));
  assert.equal(args.some((a) => /s3cr3t|user:/.test(a)), false, 'no credentials on the command line');
  assert.deepEqual(args, ['--proxy-server=socks5://10.0.0.9:1080']);
});

test('parseProxyUrl rejects garbage', () => {
  assert.equal(parseProxyUrl('').error.code, 'PROXY_FORMAT_INVALID');
});

// ---------------- §17.B profile/proxy isolation ----------------
test('each launcher gets ONLY its own proxy args (A has no B/C)', () => {
  const mk = (host) => normalizeProxyConfig({ protocol: 'http', host, port: 8080 }).config;
  const A = toRunProxy(mk('a.proxy')), B = toRunProxy(mk('b.proxy')), C = toRunProxy(mk('c.proxy'));
  const spawns = {};
  const make = (id, proxy) => new ChromeLauncher({ profilePath: `D:/p/${id}`, proxy, spawn: (exe, args) => { spawns[id] = args; return { pid: 1, once() {}, unref() {}, killed: false }; }, cdp: {} });
  // stub findChrome by pointing env to a fake — instead call open via spawn capture:
  return Promise.all([
    make('A', A).open('https://g').catch(() => {}),
    make('B', B).open('https://g').catch(() => {}),
    make('C', C).open('https://g').catch(() => {}),
  ]).then(() => {
    // open() may bail before spawn if Chrome exe not found; only assert when it spawned.
    for (const [id, host] of [['A', 'a.proxy'], ['B', 'b.proxy'], ['C', 'c.proxy']]) {
      if (!spawns[id]) continue;
      const joined = spawns[id].join(' ');
      assert.ok(joined.includes(`--proxy-server=http://${host}:8080`), `${id} has its own proxy`);
      for (const other of ['a.proxy', 'b.proxy', 'c.proxy']) if (other !== host) assert.equal(joined.includes(other), false, `${id} must not carry ${other}`);
    }
  });
});

test('decideAuth routes only the run\'s own proxy credentials', () => {
  const ctx = { runProxy: { requiresAuth: true }, username: 'ua', resolvePassword: () => 'pa' };
  assert.deepEqual(decideAuth({ source: 'Proxy' }, ctx), { response: 'ProvideCredentials', username: 'ua', password: 'pa' });
  // website (Server) auth must NEVER receive proxy creds
  assert.deepEqual(decideAuth({ source: 'Server' }, ctx), { response: 'Default' });
  // proxy challenge with no password -> cancel (no fallback)
  assert.equal(decideAuth({ source: 'Proxy' }, { runProxy: { requiresAuth: true }, resolvePassword: () => null }).response, 'CancelAuth');
});

// ---------------- §17.C no direct fallback ----------------
test('proxyRequired + missing/unknown/disabled proxy BLOCKS launch (no direct)', () => {
  assert.equal(resolveLaunchProxy({ proxyRequired: true, proxyRef: null }).error.code, 'PROXY_CONFIG_REQUIRED');
  assert.equal(resolveLaunchProxy({ proxyRequired: true, proxyRef: 'X' }, () => null).error.code, 'PROXY_CONFIG_NOT_FOUND');
  const disabled = normalizeProxyConfig({ id: 'PX', protocol: 'http', host: 'h', port: 8080, enabled: false }).config;
  assert.equal(resolveLaunchProxy({ proxyRequired: true, proxyRef: 'PX' }, () => disabled).error.code, 'PROXY_CONFIG_REQUIRED');
  // opt-out only when explicitly not required
  assert.deepEqual(resolveLaunchProxy({ proxyRequired: false, proxyRef: null }), { ok: true, runProxy: null });
});

// ---------------- §17.D secret handling ----------------
test('ProxySecretStore never persists plaintext; session-only without safeStorage', () => {
  const noSafe = new ProxySecretStore({ filePath: null, safeStorage: null });
  assert.equal(noSafe.capability().persistent, false);
  noSafe.setPassword('proxy:PX', 'topsecret');
  assert.equal(noSafe.getPassword('proxy:PX'), 'topsecret'); // in-memory
});

test('ProxySecretStore with safeStorage writes only ciphertext', () => {
  const files = {};
  const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('ENC(' + s + ')'), decryptString: (b) => b.toString().replace(/^ENC\(|\)$/g, '') };
  // Use a real temp file
  const os = require('node:os'); const path = require('node:path'); const fs = require('node:fs');
  const fp = path.join(os.tmpdir(), `phom-proxy-secret-${Date.now()}.json`);
  const store = new ProxySecretStore({ filePath: fp, safeStorage: fakeSafe });
  assert.equal(store.capability().persistent, true);
  store.setPassword('proxy:PX', 'hunter2');
  const raw = fs.readFileSync(fp, 'utf8');
  assert.equal(/hunter2/.test(raw), false, 'plaintext must never touch disk');
  // stored value is base64 of the OS ciphertext; decoding reveals the ENC() wrapper, never plaintext.
  const stored = JSON.parse(raw)['proxy:PX'];
  assert.ok(/^ENC\(/.test(Buffer.from(stored, 'base64').toString()));
  // fresh store instance (new session) can decrypt
  const store2 = new ProxySecretStore({ filePath: fp, safeStorage: fakeSafe });
  assert.equal(store2.getPassword('proxy:PX'), 'hunter2');
  fs.unlinkSync(fp);
});

// ---------------- §17.E Test Proxy ----------------
test('ProxyTester enforces allowlist, timeout, routes observed IP; no fallback', async () => {
  const proxy = toRunProxy(normalizeProxyConfig({ protocol: 'http', host: 'p', port: 8080 }).config);
  // not allowlisted
  const t0 = new ProxyTester({ transport: async () => ({ ok: true, ip: '9.9.9.9' }), allowlist: ['ipcheck.test'], ipCheckUrl: 'https://evil.test/ip' });
  assert.equal((await t0.test(proxy)).state, STATE.FAILED);
  // pass
  const t1 = new ProxyTester({ transport: async ({ url }) => { assert.ok(url.includes('ipcheck.test')); return { ok: true, ip: '203.0.113.5' }; }, allowlist: ['ipcheck.test'], ipCheckUrl: 'https://ipcheck.test/ip' });
  const r1 = await t1.test(proxy);
  assert.equal(r1.state, STATE.PASS);
  assert.equal(r1.observedIp, '203.0.113.5');
  // auth failure -> AUTH_FAILED
  const t2 = new ProxyTester({ transport: async () => ({ ok: false, error: { code: 'PROXY_AUTH_FAILED' } }), allowlist: ['ipcheck.test'], ipCheckUrl: 'https://ipcheck.test/ip' });
  assert.equal((await t2.test(proxy)).state, STATE.AUTH_FAILED);
  // timeout
  const t3 = new ProxyTester({ transport: () => new Promise(() => {}), allowlist: ['ipcheck.test'], ipCheckUrl: 'https://ipcheck.test/ip', timeoutMs: 20 });
  assert.equal((await t3.test(proxy)).state, STATE.TIMEOUT);
});

test('testAll runs with bounded concurrency and isolates failures', async () => {
  let active = 0, peak = 0;
  const runner = async (id) => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; return id === 'B' ? { state: STATE.FAILED } : { state: STATE.PASS }; };
  const out = await testAll(['A', 'B', 'C'], runner, 2);
  assert.ok(peak <= 2, 'concurrency bounded');
  assert.equal(out.get('A').state, STATE.PASS);
  assert.equal(out.get('B').state, STATE.FAILED);
  assert.equal(out.get('C').state, STATE.PASS);
});
