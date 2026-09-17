import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalJson, base64url, fromBase64url } = require('../../desktop/licensing/canonical-json.cjs');
const { verifyLicense } = require('../../desktop/licensing/license-verifier.cjs');
const { LicenseGuard } = require('../../desktop/licensing/license-guard.cjs');
const REAL = require('../../desktop/licensing/public-key.cjs');
const { GAME_CONFIGS, gameConfig, signedFeaturesFor, publicGameConfigs } = require('../../tools/license-generator/game-configs.cjs');
const { buildGamePayload, assertKeyForGame, issueLicense, signPayload } = require('../../tools/license-generator/license-signer.cjs');
const { diagnoseLicense } = require('../../tools/license-generator/license-diagnostics.cjs');
const { licenseToSheetRow, SHEET_HEADERS, GoogleSheetClient } = require('../../tools/license-generator/google-sheet.cjs');

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

// Throwaway per-game keypairs in a registry shaped exactly like public-key.cjs.
const kp = { AVIATOR: crypto.generateKeyPairSync('ed25519'), PHOM: crypto.generateKeyPairSync('ed25519') };
const pem = (k) => k.export({ type: k.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' });
const signingKeys = { AVIATOR_V1: pem(kp.AVIATOR.publicKey), PHOM_V1: pem(kp.PHOM.publicKey) };
const productKeyIds = { AVIATOR: ['AVIATOR_V1'], PHOM: ['PHOM_V1'] };
const privateKeyForGame = (g) => pem(kp[g].privateKey);

const MACHINE = 'WVPT-PC-AB12-CD34-EF56-7890';
const OTHER_MACHINE = 'WVPT-PC-0000-1111-2222-3333';
const ISSUED = 1_780_000_000;
const NOW_MS = (ISSUED + 3600) * 1000;

function issue(game, extra = {}) {
  return issueLicense({ game, plan: 'STANDARD', duration: { unit: 'months', value: 1 }, machineId: MACHINE, ...extra }, { issuedAt: ISSUED, privateKeyForGame, signingKeys }).license;
}
// Exactly what each app's LicenseGuard passes: its own game as expectedGameProduct.
const verifyIn = (app, license, opts = {}) => verifyLicense(license, { machineId: MACHINE, nowMs: NOW_MS, expectedGameProduct: app, signingKeys, productKeyIds, ...opts });
const payloadOf = (license) => JSON.parse(fromBase64url(license.split('.')[1]).toString('utf8'));
const signRaw = (payload, game) => `WVPT1.${base64url(canonicalJson(payload))}.${base64url(crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKeyForGame(game)))}`;

// ---------------- game configuration ----------------
test('game configs: canonical ids, per-game signing key ids, PHOM has no features, AVIATOR has its 4', () => {
  assert.deepEqual(Object.keys(GAME_CONFIGS).sort(), ['AVIATOR', 'PHOM']);
  assert.equal(GAME_CONFIGS.PHOM.signingKeyId, 'PHOM_V1');
  assert.equal(GAME_CONFIGS.AVIATOR.signingKeyId, 'AVIATOR_V1');
  assert.deepEqual(GAME_CONFIGS.PHOM.features, []);
  assert.deepEqual(GAME_CONFIGS.AVIATOR.features.map((f) => f.key), ['autoRun', 'jackpotLive', 'jackpotGate', 'roundHistory']);
  for (const g of ['PHOM', 'AVIATOR']) {
    const trial = GAME_CONFIGS[g].plans.find((p) => p.id === 'TRIAL');
    assert.equal(trial.defaultDuration, 'd7');
    assert.deepEqual(trial.capacities, { maxBrowsers: 5, maxConcurrentBrowsers: 5 });
    assert.equal(GAME_CONFIGS[g].plans.find((p) => p.id === 'STANDARD').defaultDuration, 'm1');
    assert.equal(GAME_CONFIGS[g].plans.find((p) => p.id === 'PRO').defaultDuration, 'm1');
    for (const p of GAME_CONFIGS.PHOM.plans) assert.deepEqual(p.features, {});
  }
  assert.equal(gameConfig('ALL'), null);
  assert.equal(gameConfig(''), null);
  assert.doesNotMatch(JSON.stringify(publicGameConfigs()), /PRIVATE|\.pem/i);
});

test('stale features from another game never reach the signature', () => {
  const stale = { autoRun: true, jackpotLive: true, jackpotGate: true, roundHistory: true };
  assert.deepEqual(signedFeaturesFor('PHOM', stale), { autoRun: false, jackpotLive: false, jackpotGate: false, roundHistory: false });
  const p = buildGamePayload({ game: 'PHOM', plan: 'PRO', machineId: MACHINE, features: stale }, { issuedAt: ISSUED, licenseId: 'LIC-AAAABBBB' });
  assert.deepEqual(p.features, { autoRun: false, jackpotLive: false, jackpotGate: false, roundHistory: false });
});

test('game + signing key id are INSIDE the signed canonical payload', () => {
  for (const g of ['PHOM', 'AVIATOR']) {
    const license = issue(g);
    const p = payloadOf(license);
    assert.equal(p.gameProduct, g);
    assert.equal(p.signingKeyId, `${g}_V1`);
    // Flipping the game after signing breaks the signature.
    const forged = `WVPT1.${base64url(canonicalJson({ ...p, gameProduct: g === 'PHOM' ? 'AVIATOR' : 'PHOM' }))}.${license.split('.')[2]}`;
    assert.equal(verifyIn(g === 'PHOM' ? 'AVIATOR' : 'PHOM', forged).ok, false);
  }
});

test('generator refuses missing / unknown game, wrong plan, disallowed duration', () => {
  const base = { plan: 'STANDARD', machineId: MACHINE };
  const code = (input) => { try { buildGamePayload(input, { issuedAt: ISSUED }); return null; } catch (e) { return e.code; } };
  assert.equal(code({ ...base }), 'LICENSE_GAME_PRODUCT_REQUIRED');
  assert.equal(code({ ...base, game: 'BLACKJACK' }), 'LICENSE_GAME_PRODUCT_INVALID');
  assert.equal(code({ ...base, game: 'ALL' }), 'LICENSE_GAME_PRODUCT_INVALID');
  assert.equal(code({ ...base, game: 'PHOM', plan: 'GOLD' }), 'INVALID_PLAN');
  assert.equal(code({ ...base, game: 'PHOM', duration: { unit: 'days', value: 2 } }), 'INVALID_DURATION');
  assert.equal(code({ ...base, game: 'PHOM', machineId: 'nope' }), 'LICENSE_MACHINE_ID_INVALID');
  assert.equal(code({ ...base, game: 'AVIATOR', maxBrowsers: 2, maxConcurrentBrowsers: 3 }), 'CONCURRENT_EXCEEDS_TOTAL');
});

// ---------------- REQUIRED cross-game matrix ----------------
test('PHOM license: PHOM accepts, AVIATOR rejects', () => {
  const lic = issue('PHOM');
  assert.equal(verifyIn('PHOM', lic).ok, true);
  const r = verifyIn('AVIATOR', lic);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'LICENSE_GAME_PRODUCT_MISMATCH');
});

test('AVIATOR license: AVIATOR accepts, PHOM rejects', () => {
  const lic = issue('AVIATOR');
  assert.equal(verifyIn('AVIATOR', lic).ok, true);
  const r = verifyIn('PHOM', lic);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'LICENSE_GAME_PRODUCT_MISMATCH');
});

test('invalid signature: both reject', () => {
  for (const g of ['PHOM', 'AVIATOR']) {
    const [pre, body, sig] = issue(g).split('.');
    const bad = Buffer.from(fromBase64url(sig)); bad[0] ^= 0xff;
    const lic = `${pre}.${body}.${base64url(bad)}`;
    for (const app of ['PHOM', 'AVIATOR']) assert.equal(verifyIn(app, lic).ok, false, `${g} tampered sig in ${app}`);
    assert.equal(verifyIn(g, lic).error.code, 'LICENSE_BAD_SIGNATURE');
  }
});

test('expired PHOM rejected by PHOM; expired AVIATOR rejected by AVIATOR', () => {
  for (const g of ['PHOM', 'AVIATOR']) {
    const p = payloadOf(issue(g));
    const lic = signRaw({ ...p, expiresAt: ISSUED + 60 }, g);
    const r = verifyIn(g, lic);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'LICENSE_EXPIRED');
  }
});

test('wrong machine: reject in its own game', () => {
  for (const g of ['PHOM', 'AVIATOR']) assert.equal(verifyIn(g, issue(g), { machineId: OTHER_MACHINE }).error.code, 'LICENSE_MACHINE_MISMATCH');
});

test('malformed token: both reject', () => {
  for (const bad of ['', 'WVPT1', 'WVPT1.abc.def', 'XXXX.' + issue('PHOM').split('.').slice(1).join('.'), 'not a key at all']) {
    for (const app of ['PHOM', 'AVIATOR']) assert.equal(verifyIn(app, bad).error.code, 'LICENSE_INVALID_FORMAT');
  }
});

test('missing game: PHOM rejects; a no-game payload signed with the PHOM key is rejected by BOTH', () => {
  const p = payloadOf(issue('PHOM'));
  delete p.gameProduct; delete p.signingKeyId;
  const byPhomKey = signRaw(p, 'PHOM');
  assert.equal(verifyIn('PHOM', byPhomKey).ok, false);
  assert.equal(verifyIn('AVIATOR', byPhomKey).ok, false); // resolves to legacy AVIATOR_V1 key -> bad signature
  const byAviatorKey = signRaw(p, 'AVIATOR');
  assert.equal(verifyIn('PHOM', byAviatorKey).error.code, 'LICENSE_PHOM_ENTITLEMENT_REQUIRED');
  // Documented legacy policy (already-sold keys): no game + Aviator key = AVIATOR only.
  assert.equal(verifyIn('AVIATOR', byAviatorKey).ok, true);
});

test('unknown game: both reject', () => {
  for (const unknown of ['BLACKJACK', 'ALL', 'phom']) {
    const p = { ...payloadOf(issue('PHOM')), gameProduct: unknown };
    for (const g of ['PHOM', 'AVIATOR']) {
      const lic = signRaw(p, g);
      for (const app of ['PHOM', 'AVIATOR']) assert.equal(verifyIn(app, lic).error.code, 'LICENSE_GAME_PRODUCT_INVALID');
    }
  }
});

test('crafted cross-key: PHOM payload signed by the AVIATOR key cannot pass as either game', () => {
  const p = { ...payloadOf(issue('PHOM')), signingKeyId: 'AVIATOR_V1' };
  const lic = signRaw(p, 'AVIATOR');
  assert.equal(verifyIn('PHOM', lic).error.code, 'LICENSE_SIGNING_KEY_PRODUCT_MISMATCH');
  assert.equal(verifyIn('AVIATOR', lic).ok, false);
});

// ---------------- key material ----------------
test('generator refuses to sign a game with another game\'s private key', () => {
  assert.equal(assertKeyForGame('PHOM', privateKeyForGame('PHOM'), { signingKeys }), 'PHOM_V1');
  assert.equal(assertKeyForGame('AVIATOR', privateKeyForGame('AVIATOR'), { signingKeys }), 'AVIATOR_V1');
  assert.throws(() => assertKeyForGame('AVIATOR', privateKeyForGame('PHOM'), { signingKeys }), (e) => e.code === 'LICENSE_SIGNING_KEY_MISMATCH' && !/PRIVATE KEY/.test(e.message));
  assert.throws(() => issueLicense({ game: 'AVIATOR', plan: 'STANDARD', machineId: MACHINE }, { issuedAt: ISSUED, privateKeyForGame: () => privateKeyForGame('PHOM'), signingKeys }), (e) => e.code === 'LICENSE_SIGNING_KEY_MISMATCH');
});

test('runtime registry: PHOM and AVIATOR use DIFFERENT public keys and disjoint key ids', () => {
  const spki = (k) => crypto.createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('hex');
  assert.notEqual(spki(REAL.SIGNING_KEYS.PHOM_V1), spki(REAL.SIGNING_KEYS.AVIATOR_V1));
  assert.deepEqual(REAL.PRODUCT_KEY_IDS.PHOM, ['PHOM_V1']);
  assert.deepEqual(REAL.PRODUCT_KEY_IDS.AVIATOR, ['AVIATOR_V1']);
});

test('apps pin their own game: Aviator main passes AVIATOR, Phom main passes PHOM', () => {
  assert.match(read('desktop/main.cjs'), /new LicenseGuard\(\{[^}]*expectedGameProduct: 'AVIATOR'/);
  const phom = read('desktop/phom-main.cjs');
  assert.match(phom, /const GAME_PRODUCT = 'PHOM';/);
  assert.match(phom, /new LicenseGuard\(\{[^}]*expectedGameProduct: GAME_PRODUCT/);
  // Shared verification code never hard-codes a single game as the expected one.
  assert.doesNotMatch(read('desktop/licensing/license-verifier.cjs'), /expectedGameProduct\s*[:=]\s*'(PHOM|AVIATOR)'/);
});

// Real generator key material vs real runtime registry (seller machine only; the keys are
// gitignored so CI without them skips).
const KEY_FILES = { PHOM: 'tools/license-generator/private/phom-ed25519-private.pem', AVIATOR: 'tools/license-generator/private/wvpt-ed25519-private.pem' };
for (const g of ['PHOM', 'AVIATOR']) {
  const path = new URL(`../../${KEY_FILES[g]}`, import.meta.url);
  test(`REAL ${g} generator key matches ${g} verification key; real ${g} license activates only in ${g}`, { skip: existsSync(path) ? false : `${KEY_FILES[g]} not present` }, () => {
    const priv = readFileSync(path, 'utf8');
    assert.equal(assertKeyForGame(g, priv), `${g}_V1`); // real registry
    const other = g === 'PHOM' ? 'AVIATOR' : 'PHOM';
    assert.throws(() => assertKeyForGame(other, priv), (e) => e.code === 'LICENSE_SIGNING_KEY_MISMATCH');
    const { license } = issueLicense({ game: g, plan: 'TRIAL', duration: { unit: 'days', value: 7 }, machineId: MACHINE }, { issuedAt: ISSUED, privateKeyForGame: () => priv });
    const guard = (app) => new LicenseGuard({
      machineIdProvider: () => ({ ok: true, machineId: MACHINE }), nowMs: () => NOW_MS, expectedGameProduct: app,
      store: { loadState: () => ({}), saveState() {}, loadLicense: () => null, saveLicense() {} },
    });
    const own = guard(g); own.initialize();
    assert.equal(own.activate(license).active, true, `${g} app activates ${g} license`);
    const cross = guard(other); cross.initialize();
    const s = cross.activate(license);
    assert.equal(s.active, false);
    assert.equal(s.error.code, 'LICENSE_GAME_PRODUCT_MISMATCH');
  });
}

// ---------------- diagnostics ----------------
test('diagnostics: valid in own game, clear game mismatch in the other, no key material', () => {
  const lic = issue('AVIATOR');
  const ok = diagnoseLicense(lic, { expectedGame: 'AVIATOR', machineId: MACHINE, nowMs: NOW_MS, signingKeys, productKeyIds });
  assert.equal(ok.result, 'VALID');
  assert.ok(ok.steps.every((s) => s.ok !== false));
  const bad = diagnoseLicense(issue('PHOM'), { expectedGame: 'AVIATOR', machineId: MACHINE, nowMs: NOW_MS, signingKeys, productKeyIds });
  assert.equal(bad.result, 'INVALID');
  assert.equal(bad.code, 'LICENSE_GAME_PRODUCT_MISMATCH');
  const gameStep = bad.steps.find((s) => s.id === 'game');
  assert.equal(gameStep.ok, false);
  assert.match(gameStep.detail, /cần AVIATOR, license là PHOM/);
  assert.equal(bad.steps.find((s) => s.id === 'signature').ok, true);
  const text = JSON.stringify([ok, bad]);
  assert.doesNotMatch(text, /PRIVATE KEY|BEGIN/);
  assert.ok(!text.includes(MACHINE), 'machine id shown only as a masked reference');
  assert.equal(diagnoseLicense('garbage', { expectedGame: 'PHOM', nowMs: NOW_MS }).code, 'LICENSE_INVALID_FORMAT');
  const wrongMachine = diagnoseLicense(lic, { expectedGame: 'AVIATOR', machineId: OTHER_MACHINE, nowMs: NOW_MS, signingKeys, productKeyIds });
  assert.equal(wrongMachine.code, 'LICENSE_MACHINE_MISMATCH');
});

// ---------------- Google Sheet ----------------
test('sheet row carries the game in an APPENDED column (existing column positions unchanged)', () => {
  const lic = issue('PHOM');
  const row = licenseToSheetRow({ payload: payloadOf(lic), license: lic });
  assert.equal(row.gameProduct, 'PHOM');
  assert.equal(row.licenseKey, lic);
  assert.equal(SHEET_HEADERS[SHEET_HEADERS.length - 1], 'gameProduct');
  assert.equal(SHEET_HEADERS.indexOf('rawPayloadJson'), 18);
  assert.equal(SHEET_HEADERS.indexOf('licenseId'), 0);
});

test('ensureHeaders extends an older prefix header row with only the missing cells', async () => {
  const puts = [];
  const old = SHEET_HEADERS.slice(0, -1);
  const request = async (url, opts = {}) => {
    if (url.includes('oauth2')) return { status: 200, json: { access_token: 't', expires_in: 3600 } };
    if (url.includes('fields=')) return { status: 200, json: { properties: { title: 'W' }, sheets: [{ properties: { sheetId: 0, title: 'PHOM' } }] } };
    if ((opts.method || 'GET') === 'GET') return { status: 200, json: { values: [old] } };
    puts.push({ url: decodeURIComponent(url), body: JSON.parse(opts.body) });
    return { status: 200, json: {} };
  };
  const sa = { client_email: 'x@y', private_key: crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const client = new GoogleSheetClient({ serviceAccount: sa, request });
  const r = await client.ensureHeaders('PHOM');
  assert.deepEqual(r.extended, ['gameProduct']);
  assert.equal(puts.length, 1);
  assert.match(puts[0].url, /PHOM!T1/);
  assert.deepEqual(puts[0].body.values, [['gameProduct']]);
});

// ---------------- UI is config-driven ----------------
test('generator UI renders options from game config (no hard-coded per-game fields)', () => {
  const html = read('tools/license-generator/ui.html');
  const js = read('tools/license-generator/ui.js');
  for (const k of ['autoRun', 'jackpotLive', 'jackpotGate', 'roundHistory', 'f-auto-run', 'data-plan']) {
    assert.ok(!html.includes(k), `ui.html has no static ${k}`);
    assert.ok(!js.includes(k), `ui.js has no hard-coded ${k}`);
  }
  assert.match(js, /api\.gameConfigs\(\)/);
  assert.match(js, /game: game\.game/);
  assert.doesNotMatch(html + js, /PRIVATE KEY|privateKey/);
});
