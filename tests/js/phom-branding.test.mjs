// Branding (user 2026-10-06): ONE logo for the tool and the bundled Chromium; the Chromium profile name = the game
// account that plays in it; the account in the tab / taskbar title. Checked on real files (temp dirs) and by running
// the in-page script against a minimal page; the icon itself was checked on the taskbar by hand (see brand-chromium.cjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pn = require('../../desktop/browser/chromium-profile-name.cjs');
const gh = require('../../desktop/protocol/phom/game-header.cjs');
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

test('profile name: a fresh profile gets Local State + Preferences with the name (Chromium creates the rest)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pn-'));
  const r = pn.applyProfileName(dir, 'vietanhcoo5365');
  assert.deepEqual([r.ok, r.changed, r.name], [true, true, 'vietanhcoo5365']);
  const ls = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'));
  assert.equal(ls.profile.info_cache.Default.name, 'vietanhcoo5365');
  assert.equal(ls.profile.info_cache.Default.is_using_default_name, false);
  const pr = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(pr.profile.name, 'vietanhcoo5365');
  assert.equal(pn.applyProfileName(dir, 'vietanhcoo5365').changed, false, 'same name: nothing rewritten');
});

test('profile name: an existing profile keeps every other setting (cookies untouched); a broken file is left alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pn-'));
  mkdirSync(join(dir, 'Default'), { recursive: true });
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ browser: { x: 1 }, profile: { info_cache: { Default: { name: 'Your Chromium', is_using_default_name: true, avatar_icon: 'a26' } }, last_used: 'Default' } }));
  writeFileSync(join(dir, 'Default', 'Preferences'), '{not json');
  writeFileSync(join(dir, 'Default', 'Cookies'), 'COOKIE-DB');
  const r = pn.applyProfileName(dir, 'P1');
  assert.equal(r.ok, true);
  const ls = JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8'));
  assert.deepEqual(ls.browser, { x: 1 });
  assert.equal(ls.profile.last_used, 'Default');
  assert.deepEqual(ls.profile.info_cache.Default, { name: 'P1', is_using_default_name: false, avatar_icon: 'a26' });
  assert.equal(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8'), '{not json', 'a file that does not parse is never rewritten');
  assert.equal(readFileSync(join(dir, 'Default', 'Cookies'), 'utf8'), 'COOKIE-DB');
  assert.equal(existsSync(join(dir, 'Local State.phom-tmp')), false);
});

test('account names: remembered per profile key, saved to one file, junk ignored', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'an-')), 'account-names.json');
  const s = pn.createAccountNameStore(file);
  assert.equal(s.get('prof-1'), null);
  assert.equal(s.set('prof-1', 'vietanhcoo5365'), true);
  assert.equal(s.set('prof-1', 'vietanhcoo5365'), false, 'unchanged → not saved again');
  assert.equal(s.set('prof-2', '   '), false);
  assert.equal(pn.createAccountNameStore(file).get('prof-1'), 'vietanhcoo5365', 'read back from the file');
});

test('wiring: the name is written right before each launch; the account is learned from the header state', () => {
  const main = read('desktop/phom-main.cjs');
  const i = main.indexOf("const profileDir = path.join(phomRoot(), 'browser-profiles'");
  const j = main.indexOf('runManager.createRun(', i);
  assert.ok(i > 0 && j > i);
  assert.match(main.slice(i, j), /chromiumProfileName\.applyProfileName\(profileDir, accountNames\(\)\.get\(udKey\) \|\| label \|\| saved\.name/);
  assert.match(main, /rememberAccountName\(run, browsers\.find/);
  assert.match(main, /b\.username === 'USER_UNKNOWN'\) return;/);
});

// Minimal page: anything the bar draws is accepted; document.title and the <head> observer are real.
function fakePage() {
  const U = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : U),
    apply: () => U, construct: () => U, set: () => true,
  });
  let observer = null;
  const head = new Proxy({}, { get: (t, k) => (k in t ? t[k] : U), set: (t, k, v) => { t[k] = v; return true; } });
  const titleEl = {};
  const document = new Proxy({ title: 'Hit Club', head, querySelector: (q) => (q === 'title' ? titleEl : null) }, {
    get: (t, k) => (k in t ? t[k] : U),
    set: (t, k, v) => { t[k] = v; if (k === 'title' && observer) observer(); return true; },
  });
  class MO { constructor(cb) { this.cb = cb; } observe(target, opts) { assert.equal(opts.subtree, false, 'observers stay narrow'); if (target === titleEl) observer = () => this.cb([]); } }
  const window = new Proxy({ document, MutationObserver: MO, performance: { now: () => 0 } }, { get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; return true; } });
  return { window, document };
}

test('tab / taskbar title: "[account] <page title>", kept when the game changes its title, unknown account = untouched', () => {
  const page = fakePage();
  const ctx = vm.createContext({ window: page.window, document: page.document, MutationObserver: page.window.MutationObserver, performance: { now: () => 0 }, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, navigator: {}, location: { href: 'https://v.hitclub.guitars/' } });
  vm.runInContext(gh.bootScript({ slotId: 'B1' }), ctx);
  const render = page.window.__phomHeaderRender;
  assert.equal(typeof render, 'function');
  render(gh.deriveHeaderState({ opened: true, inGame: false }));      // not logged in yet: the browser's place P1
  assert.equal(page.document.title, '[P1] Hit Club');
  render(gh.deriveHeaderState({ opened: true, inGame: true, account: 'vietanhcoo5365' }));
  assert.equal(page.document.title, '[vietanhcoo5365] Hit Club', 'the account replaces P1 once known');
  render(gh.deriveHeaderState({ opened: true, inGame: true, account: 'vietanhcoo5365' }));
  assert.equal(page.document.title, '[vietanhcoo5365] Hit Club', 'never prefixed twice');
  page.document.title = 'Phỏm';                                      // the game sets its own title
  assert.equal(page.document.title, '[vietanhcoo5365] Phỏm');
});

test('logo: one icon for the tool (exe + installer) and the bundled Chromium (branded copy staged BEFORE packaging → signed after)', () => {
  const cfg = JSON.parse(read('electron-builder.phom.json'));
  assert.equal(cfg.win.icon, 'build/phom-icon.ico');
  assert.equal(cfg.nsis.installerIcon, 'build/phom-icon.ico');
  assert.equal(cfg.beforePack, 'scripts/phom-brand/before-pack.cjs');
  assert.equal(cfg.afterPack, undefined, 'never after: chrome.exe is signed while the resources are copied');
  assert.equal(cfg.extraResources[0].from, '.phom-brand/phom-chromium');
  assert.ok(read('.gitignore').split(/\r?\n/).includes('.phom-brand/'), 'the staged copy is never committed');
  const ico = readFileSync(new URL('build/phom-icon.ico', root));
  assert.equal(ico.readUInt16LE(2), 1, 'an icon file');
  const sizes = []; for (let k = 0; k < ico.readUInt16LE(4); k++) sizes.push(ico[6 + 16 * k] || 256);
  for (const s of [16, 32, 48, 256]) assert.ok(sizes.includes(s), 'size ' + s);
  const brand = require('../../scripts/phom-brand/brand-chromium.cjs');
  assert.deepEqual(brand.BRANDED_GROUPS, ['IDR_MAINFRAME', 'IDR_X001_APP_LIST']);
  assert.equal(brand.DLL_WINDOW_ICON_GROUP, 101, 'the window/taskbar icon lives in chrome.dll');
  assert.match(read('scripts/phom-brand/before-pack.cjs'), /fs\.cpSync\(src, dst, \{ recursive: true \}\);\s*const r = brandChromiumDir\(dst,/);
});

// 3.1.25 shipped a branded chrome.exe with the OLD manifest → the launch check refused it (PHOM_CHROMIUM_CHECKSUM_MISMATCH):
// the staging writes a new manifest and runs the same check, and dev only takes the branded copy when it passes.
function fakeRuntime(dir, exeBody = 'EXE') {
  const rt = require('../../desktop/browser/phom-chromium-runtime.cjs');
  mkdirSync(join(dir, 'locales'), { recursive: true });
  for (const f of rt.REQUIRED_FILES) writeFileSync(join(dir, f), f === 'chrome.exe' ? exeBody : 'x');
  writeFileSync(join(dir, 'runtime-manifest.json'), JSON.stringify(rt.generateManifest(dir).manifest));
  return rt;
}
test('runtime: dev takes the branded copy only when it passes the launch check; else (or STOCK=1) the stock runtime', () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'));
  const stock = join(proj, 'runtime', 'phom-chromium'); const branded = join(proj, '.phom-brand', 'phom-chromium');
  mkdirSync(stock, { recursive: true }); mkdirSync(branded, { recursive: true });
  const rt = fakeRuntime(stock); fakeRuntime(branded, 'BRANDED-EXE');
  assert.equal(rt.resolveRuntimeRoot({ env: {}, projectRoot: proj }), branded);
  assert.equal(rt.resolveRuntimeRoot({ env: { PHOM_CHROMIUM_STOCK: '1' }, projectRoot: proj }), stock);
  writeFileSync(join(branded, 'chrome.exe'), 'CHANGED-AFTER-MANIFEST');      // the 3.1.25 situation
  assert.equal(rt.validateRuntime(branded).error.code, 'PHOM_CHROMIUM_CHECKSUM_MISMATCH');
  assert.equal(rt.resolveRuntimeRoot({ env: {}, projectRoot: proj }), stock, 'a copy that would not launch is never used');
  assert.equal(rt.resolveRuntimeRoot({ env: {}, isPackaged: true, resourcesPath: 'R' }).endsWith('phom-chromium'), true);
});
test('staging: new manifest for the branded files + the launch check, before anything is packaged; brand:phom for dev', () => {
  const src = read('scripts/phom-brand/before-pack.cjs');
  const brand = src.indexOf('brandChromiumDir(dst,'); const man = src.indexOf("'runtime-manifest.json'"); const chk = src.indexOf('rt.validateRuntime(dst, { deep: true })');
  assert.ok(brand > 0 && man > brand && chk > man, 'brand → manifest → check, in that order');
  assert.match(src, /if \(!after\.ok\) throw new Error/);
  assert.equal(JSON.parse(read('package.json')).scripts['brand:phom'], 'node scripts/phom-brand/before-pack.cjs');
  assert.match(read('desktop/phom-main.cjs'), /const devIcon = app\.isPackaged \? null : path\.join\(__dirname, '\.\.', 'build', 'phom-icon\.png'\);/);
});

test('tab title before the login: A/B/C → [P1]/[P2]/[P3], reserves D/E → [P4]/[P5]; no slot → untouched', () => {
  for (const [slot, want] of [['A', '[P1] Hit Club'], ['C', '[P3] Hit Club'], ['E', '[P5] Hit Club'], [null, 'Hit Club']]) {
    const page = fakePage();
    const ctx = vm.createContext({ window: page.window, document: page.document, MutationObserver: page.window.MutationObserver, performance: { now: () => 0 }, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, navigator: {}, location: { href: 'https://v.hitclub.guitars/' } });
    vm.runInContext(gh.bootScript({ slotId: slot }), ctx);
    page.window.__phomHeaderRender(gh.deriveHeaderState({ opened: true }));
    assert.equal(page.document.title, want, String(slot));
  }
});
