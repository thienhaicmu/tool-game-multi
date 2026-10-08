// 3.2 phase 2 — ONE profile store + ONE settings store. The pre-3.2 files are taken over ONCE: copied into a backup
// folder and merged in (a value already in the new file wins). They are left in place — an older build on the same
// machine (same userData) still finds each profile's renamed cookie folder through them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PhomProfileStore, VERSION } = require('../../desktop/phom/stores/profile-store.cjs');
const { createSettingsStore } = require('../../desktop/phom/stores/settings-store.cjs');

const dir = () => mkdtempSync(join(tmpdir(), 'phq-store-'));
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));

function legacyProfileDir() {
  const d = dir();
  writeFileSync(join(d, 'phom-device-profiles.json'), JSON.stringify({ version: 1, profiles: [
    { id: 'prof-a', name: 'P1', agent: 'WEB', gameUrl: 'https://g/', proxyRef: 'PX-1' },
    { id: 'prof-b', name: 'P2', agent: 'MOBILE' },
  ] }));
  writeFileSync(join(d, 'account-names.json'), JSON.stringify({ 'prof-b': 'baycao1003', 'slot-A': 'stray01' }));
  writeFileSync(join(d, 'profile-folders.json'), JSON.stringify({ 'prof-a': 'P1', 'prof-b': 'baycao1003', 'slot-A': 'A' }));
  return d;
}
const openStore = (d) => new PhomProfileStore({
  filePath: join(d, 'phom-device-profiles.json'),
  legacy: { accountNames: join(d, 'account-names.json'), folders: join(d, 'profile-folders.json') },
  backupDir: join(d, 'backup'),
});

test('profile store: the pre-3.2 account + folder files are merged into the profiles once and backed up; the originals stay', () => {
  const d = legacyProfileDir();
  const before = readFileSync(join(d, 'phom-device-profiles.json'), 'utf8');
  const s = openStore(d);
  assert.equal(s.accountOf('prof-b'), 'baycao1003');
  assert.equal(s.folders().get('prof-a'), 'P1');
  assert.equal(s.folders().get('prof-b'), 'baycao1003');
  assert.equal(s.accountOf('slot-A'), 'stray01', 'a key without a saved profile is kept, not dropped');
  assert.deepEqual(s.folders().all(), { 'prof-a': 'P1', 'prof-b': 'baycao1003', 'slot-A': 'A' });
  // everything else about the profiles is unchanged
  assert.deepEqual(s.list().map((p) => [p.id, p.name, p.agent, p.gameUrl, p.proxyRef]), [['prof-a', 'P1', 'WEB', 'https://g/', 'PX-1'], ['prof-b', 'P2', 'MOBILE', null, null]]);
  // on disk: version 2, merged once; the old files are untouched (an older build still reads them) and backed up
  const disk = json(join(d, 'phom-device-profiles.json'));
  assert.equal(disk.version, VERSION);
  assert.equal(disk.legacyMerged, true);
  assert.equal(disk.profiles.find((p) => p.id === 'prof-b').account, 'baycao1003');
  assert.deepEqual(json(join(d, 'profile-folders.json')), { 'prof-a': 'P1', 'prof-b': 'baycao1003', 'slot-A': 'A' });
  assert.deepEqual(readdirSync(join(d, 'backup')).sort(), ['account-names.json', 'phom-device-profiles.json', 'profile-folders.json']);
  assert.equal(readFileSync(join(d, 'backup', 'phom-device-profiles.json'), 'utf8'), before);
  // a second start reads the new file only, and finds the same
  const again = openStore(d);
  assert.equal(again.accountOf('prof-b'), 'baycao1003');
  assert.equal(again.folders().get('slot-A'), 'A');
});

test('profile store: merged ONCE — a legacy file changed afterwards does not override the store', () => {
  const d = legacyProfileDir();
  openStore(d).setAccount('prof-b', 'newname');
  writeFileSync(join(d, 'account-names.json'), JSON.stringify({ 'prof-b': 'OLD', 'prof-a': 'x' })); // e.g. an old build wrote it
  const s = openStore(d);
  assert.equal(s.accountOf('prof-b'), 'newname');
  assert.equal(s.accountOf('prof-a'), null);
});

test('profile store: an older build rewrote the profiles file (v1, no account/folder) → its legacy files are merged again', () => {
  const d = legacyProfileDir();
  openStore(d);
  writeFileSync(join(d, 'phom-device-profiles.json'), JSON.stringify({ version: 1, profiles: [{ id: 'prof-a', name: 'P1', agent: 'WEB' }, { id: 'prof-b', name: 'P2', agent: 'MOBILE' }] }));
  const s = openStore(d);
  assert.equal(s.folders().get('prof-b'), 'baycao1003', 'the renamed cookie folder is still found');
  assert.equal(s.accountOf('prof-b'), 'baycao1003');
});

test('profile store: a deleted profile takes its account + folder name with it; an edit keeps them', () => {
  const d = legacyProfileDir();
  const s = openStore(d);
  s.update('prof-b', { name: 'renamed' });
  assert.equal(s.accountOf('prof-b'), 'baycao1003');
  s.remove('prof-b');
  assert.equal(s.accountOf('prof-b'), null);
  assert.equal(s.folders().get('prof-b'), null);
  assert.equal(JSON.stringify(json(join(d, 'phom-device-profiles.json'))).includes('baycao1003'), false);
});

test('profile store: a broken file is never overwritten (and nothing is migrated into it)', () => {
  const d = legacyProfileDir();
  writeFileSync(join(d, 'phom-device-profiles.json'), '{broken');
  const s = openStore(d);
  assert.equal(s.count(), 0);
  assert.equal(readFileSync(join(d, 'phom-device-profiles.json'), 'utf8'), '{broken');
  assert.equal(existsSync(join(d, 'account-names.json')), true, 'the legacy files stay too');
});

test('profile store: the game\'s placeholder for an account without a name ("_undefined") is never kept as the account', () => {
  const d = legacyProfileDir();
  const s = openStore(d);
  for (const junk of ['_undefined', 'undefined', 'null', 'USER_UNKNOWN', '  ']) assert.equal(s.setAccount('prof-b', junk), false, junk);
  assert.equal(s.accountOf('prof-b'), 'baycao1003', 'the real name stays');
  // one saved by an older build reads as no name
  const raw = json(join(d, 'phom-device-profiles.json'));
  raw.profiles.find((p) => p.id === 'prof-a').account = '_undefined';
  writeFileSync(join(d, 'phom-device-profiles.json'), JSON.stringify(raw));
  assert.equal(openStore(d).accountOf('prof-a'), null);
});

test('profile store: a fresh install writes nothing until something is saved', () => {
  const d = dir();
  const s = openStore(d);
  assert.equal(s.count(), 0);
  assert.equal(existsSync(join(d, 'phom-device-profiles.json')), false);
});

// ---- settings ----
const KEYS = (d) => ({
  stake: { default: null, normalize: (v) => (Number(v) > 0 ? Number(v) : null), legacy: { file: join(d, 'stake.json'), pick: (j) => j.stake } },
  layout: { default: { A: 'TL' }, normalize: (v) => (v && v.A ? { A: v.A } : { A: 'TL' }), legacy: { file: join(d, 'window-layout.json') } },
  runtime: { default: 'CUSTOM_CHROMIUM', normalize: (v) => (['AUTO', 'CUSTOM_CHROMIUM'].includes(v) ? v : 'AUTO'), legacy: { file: join(d, 'browser-runtime.json'), pick: (j) => j.preference } },
  win: { default: null },
});
const openSettings = (d) => createSettingsStore({ file: join(d, 'phom-settings.json'), keys: KEYS(d), backupDir: join(d, 'backup') });

test('settings: the pre-3.2 files become one phom-settings.json (merged once, backed up, originals left)', () => {
  const d = dir();
  writeFileSync(join(d, 'stake.json'), JSON.stringify({ stake: 100 }));
  writeFileSync(join(d, 'window-layout.json'), JSON.stringify({ A: 'BL' }));
  writeFileSync(join(d, 'browser-runtime.json'), JSON.stringify({ preference: 'AUTO' }));
  const s = openSettings(d);
  assert.equal(s.get('stake'), 100);
  assert.deepEqual(s.get('layout'), { A: 'BL' });
  assert.equal(s.get('runtime'), 'AUTO');
  assert.equal(s.get('win'), null, 'nothing saved → the default');
  assert.deepEqual(json(join(d, 'phom-settings.json')), { version: 1, legacyMerged: true, values: { stake: 100, layout: { A: 'BL' }, runtime: 'AUTO' } });
  for (const f of ['stake.json', 'window-layout.json', 'browser-runtime.json']) {
    assert.equal(existsSync(join(d, f)), true, f + ' left for an older build');
    assert.equal(existsSync(join(d, 'backup', f)), true, f + ' backed up');
  }
  writeFileSync(join(d, 'stake.json'), JSON.stringify({ stake: 7 }));
  assert.equal(openSettings(d).get('stake'), 100, 'read back after a restart; a legacy file changed later is ignored');
});

test('settings: set normalizes + saves; the new file wins over a legacy one; an unknown key is a programming error', () => {
  const d = dir();
  const s = openSettings(d);
  assert.equal(s.set('stake', '200'), 200);
  assert.equal(s.set('stake', -5), null);
  s.set('stake', 500);
  writeFileSync(join(d, 'stake.json'), JSON.stringify({ stake: 1 }));
  assert.equal(openSettings(d).get('stake'), 500, 'the new file wins');
  assert.equal(s.set('runtime', 'junk'), 'AUTO');
  assert.throws(() => s.get('nope'), /unknown setting/);
  assert.throws(() => s.set('nope', 1), /unknown setting/);
});

test('settings: no file at all → every default, and nothing is written', () => {
  const d = dir();
  const s = openSettings(d);
  assert.equal(s.get('runtime'), 'CUSTOM_CHROMIUM');
  assert.deepEqual(s.get('layout'), { A: 'TL' });
  assert.equal(existsSync(join(d, 'phom-settings.json')), false);
});
