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
  const i = main.indexOf('const profileName = accountNames().get(udKey) || label || saved.name');
  const j = main.indexOf('runManager.createRun(', i);
  assert.ok(i > 0 && j > i);
  assert.match(main.slice(i, j), /chromiumProfileName\.applyProfileName\(profileDir, profileName\)/);
  // the login-origin feature learns it on every push (behaviour: phom-login-origin.test.mjs)
  assert.match(main, /accountNames: \(\) => accountNames\(\)/);
  assert.match(read('desktop/phom/features/login-origin.cjs'), /b\.username === 'USER_UNKNOWN'\) return;/);
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

// 3.1.32 (user 2026-10-08 "Đổi tiêu đề tab bỏ"): right after VÀO GAME a browser's main process grew ~200 MB/s with the
// tool idle; re-writing the title whenever the game wrote its own was the prime suspect. The tool never touches it.
test('tab title: the tool NEVER writes it — not on render, not when the game changes it, no title setter, no push', () => {
  const page = fakePage();
  const ctx = vm.createContext({ window: page.window, document: page.document, MutationObserver: page.window.MutationObserver, performance: { now: () => 0 }, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, navigator: {}, location: { href: 'https://v.hitclub.guitars/' } });
  vm.runInContext(gh.bootScript({ slotId: 'A' }), ctx);
  page.window.__phomHeaderRender(gh.deriveHeaderState({ opened: true, inGame: false }));
  page.window.__phomHeaderRender(gh.deriveHeaderState({ opened: true, inGame: true, account: 'vietanhcoo5365' }));
  assert.equal(page.document.title, 'Hit Club');
  page.document.title = 'Phỏm';                                      // the game sets its own title
  assert.equal(page.document.title, 'Phỏm', 'left as the game set it');
  assert.equal(page.window.__phomSetTitle, undefined);
  const src = gh.bootScript();
  assert.equal(/document\.title\s*=/.test(src), false);
  assert.equal(/__phomSetTitle|setTitleAccount|applyTitle/.test(src), false);
  assert.equal(/__phomSetTitle/.test(read('desktop/phom-main.cjs')), false, 'main pushes no title');
});

// 3.1.32 (user 2026-10-08 "dùng bản chromium custom … có logo game phỏm"): the owned Chromium again, branded.
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

// ---- the cookie FOLDER carries the same name (user 2026-10-06 "làm cho đồng bộ") ----
function profilesRootWith(entries = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-'));
  for (const [folder, files] of Object.entries(entries)) { mkdirSync(join(root, folder, 'Default'), { recursive: true }); for (const f of files) writeFileSync(join(root, folder, 'Default', f), f + '-DATA'); }
  return root;
}
test('profile folder: the old id-named folder becomes "P1", then the account — cookies move with it', () => {
  const root = profilesRootWith({ 'prof-1': ['Cookies'] });
  const map = pn.createFolderMapStore(join(root, '..', 'pf-' + Date.now() + '.json'));
  const a = pn.resolveProfileDir({ root, key: 'prof-1', name: 'P1', map });
  assert.deepEqual([a.folder, a.renamedFrom], ['P1', 'prof-1']);
  assert.equal(readFileSync(join(root, 'P1', 'Default', 'Cookies'), 'utf8'), 'Cookies-DATA', 'the login is still there');
  assert.equal(existsSync(join(root, 'prof-1')), false);
  const b = pn.resolveProfileDir({ root, key: 'prof-1', name: 'vietanhcoo5365', map });
  assert.deepEqual([b.folder, b.renamedFrom], ['vietanhcoo5365', 'P1']);
  assert.equal(readFileSync(join(b.dir, 'Default', 'Cookies'), 'utf8'), 'Cookies-DATA');
  const c = pn.resolveProfileDir({ root, key: 'prof-1', name: 'vietanhcoo5365', map });
  assert.deepEqual([c.folder, c.renamedFrom], ['vietanhcoo5365', null], 'same name: nothing moves');
});
test('profile folder: a rename that is refused (files in use) keeps the folder — a launch is never blocked', () => {
  const root = profilesRootWith({ 'prof-1': ['Cookies'] });
  const map = pn.createFolderMapStore(join(root, '..', 'pf-busy-' + Date.now() + '.json'));
  const fsx = { ...require('node:fs'), renameSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } };
  const r = pn.resolveProfileDir({ root, key: 'prof-1', name: 'P1', map, fsx });
  assert.deepEqual([r.folder, r.renameError], ['prof-1', 'EBUSY']);
  assert.equal(map.get('prof-1'), 'prof-1');
});
test('profile folder: never two profiles in one folder; a folder that is not ours is never taken; unsafe characters dropped', () => {
  const root = profilesRootWith({ P3: ['Cookies'] });                // somebody else's folder named P3 (not in the map)
  const map = pn.createFolderMapStore(join(root, '..', 'pf-c-' + Date.now() + '.json'));
  const a = pn.resolveProfileDir({ root, key: 'prof-a', name: 'P3', map });
  assert.equal(a.folder, 'P3 (2)', 'the existing P3 folder is not ours');
  const b = pn.resolveProfileDir({ root, key: 'prof-b', name: 'P3', map });
  assert.equal(b.folder, 'P3 (3)');
  assert.equal(pn.folderNameOf('a:b/c*?'), 'abc');
  assert.equal(pn.folderNameOf('CON'), null);
  assert.equal(pn.folderNameOf('name. '), 'name');
  const c = pn.resolveProfileDir({ root, key: 'prof-c', name: 'CON', map });
  assert.equal(c.folder, 'prof-c', 'no usable name → the id');
});
test('wiring: ONE name for the folder and the Chromium profile, resolved before each launch', () => {
  const main = read('desktop/phom-main.cjs');
  const i = main.indexOf("const profileName = accountNames().get(udKey) || label || saved.name");
  const j = main.indexOf('runManager.createRun(', i);
  assert.ok(i > 0 && j > i);
  const seg = main.slice(i, j);
  assert.match(seg, /chromiumProfileName\.resolveProfileDir\(\{ root: profilesRoot, key: udKey \|\| slot \|\| 'X', name: profileName, map: profileFolders\(\) \}\)/);
  assert.match(seg, /chromiumProfileName\.applyProfileName\(profileDir, profileName\)/);
  assert.match(main, /path\.join\(phomRoot\(\), 'profile-folders\.json'\)/);
});

// Switching the runtime must never hand one browser a profile another version wrote (an older Chrome refuses a profile
// from a newer version). Each runtime gets its own root.
test('Google Chrome and the bundled Chromium never share a profile folder', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /function profilesRootFor\(kind\) \{ return path\.join\(phomRoot\(\), kind === 'chrome' \? 'browser-profiles-chrome' : 'browser-profiles'\); \}/);
  const open = main.slice(main.indexOf('async function openProfile('), main.indexOf('// ---- license gate ----'));
  assert.match(open, /const profilesRoot = profilesRootFor\(rtChoice\.kind\);/, 'the launch uses the root of the runtime it launches');
  assert.doesNotMatch(main, /path\.join\(phomRoot\(\), 'browser-profiles'\)/, 'no path into the Chromium root that ignores the runtime');
});

test('a profile created / renamed in the tool gets its Chromium profile at once (folder + name), not while its browser is open', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /ipcMain\.handle\('phom:profile-create', guarded\(\(_e, input\) => \{ ensureStores\(\); return syncBrowserProfile\(deviceProfilesStore\.create\(/);
  assert.match(main, /ipcMain\.handle\('phom:profile-update-x', guarded\(\(_e, id, patch\) => \{ ensureStores\(\); return syncBrowserProfile\(deviceProfilesStore\.update\(/);
  const fn = main.slice(main.indexOf('const syncBrowserProfile = (res) => {'), main.indexOf("ipcMain.handle('phom:profile-create'"));
  assert.match(fn, /profileInUse\(String\(p\.id\)\)\) return res;/);
  assert.match(fn, /const name = accountNames\(\)\.get\(p\.id\) \|\| p\.name \|\| p\.id;/, 'the account wins over the tool name, as at launch');
  assert.match(fn, /resolveProfileDir\(\{ root: profilesRootFor\(rtNow\.ok \? rtNow\.kind : 'chromium'\), key: String\(p\.id\), name, map: profileFolders\(\) \}\)/);
  assert.match(fn, /applyProfileName\(pd\.dir, name\)/);
  // a close is graceful first (cookies flushed — an abrupt kill loses the newest ones, measured 2026-10-06)
  assert.match(read('desktop/browser-run/browser-run-manager.cjs'), /await run\.launcher\.closeGraceful\(\);/);
});
