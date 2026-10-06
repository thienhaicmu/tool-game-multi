'use strict';
// Put the Phỏm QA logo (build/phom-icon.ico) into the bundled chrome.exe: its window / taskbar / Alt+Tab icon
// (IDR_MAINFRAME) and app icon (IDR_X001_APP_LIST), and name the file "Phom QA Browser" (what Windows shows for the
// program). Nothing else changes — the browser, profiles, cookies and CDP are the same Chromium.
// Used by the packaging (scripts/phom-brand/after-pack.cjs) on the COPY inside the app, before it is signed.
const fs = require('node:fs');
const ResEdit = require('resedit');

const BRANDED_GROUPS = ['IDR_MAINFRAME', 'IDR_X001_APP_LIST'];
const NAME = 'Phom QA Browser';

function brandChromiumExe(exePath, icoPath) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  let replaced = 0;
  for (const g of groups) {
    if (!BRANDED_GROUPS.includes(String(g.id))) continue;
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icon.icons.map((i) => i.data));
    replaced += 1;
  }
  if (replaced !== BRANDED_GROUPS.length) throw new Error(`chrome.exe icon groups not found (${replaced}/${BRANDED_GROUPS.length})`);
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    for (const lang of vi.getAllLanguagesForStringValues()) vi.setStringValues(lang, { FileDescription: NAME, ProductName: NAME, ProductShortName: NAME });
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return { replaced, name: NAME };
}

// chrome.dll carries the icon Chromium actually puts on its WINDOWS (taskbar / Alt+Tab): group 101 (IDR_MAINFRAME of
// chrome_dll.rc). Verified 2026-10-06: with only chrome.exe changed the taskbar still showed the Chromium logo; with
// group 101 of chrome.dll changed too it showed ours. 102..125 are the profile-avatar badges — untouched.
const DLL_WINDOW_ICON_GROUP = 101;
function brandChromiumDll(dllPath, icoPath) {
  const dll = ResEdit.NtExecutable.from(fs.readFileSync(dllPath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(dll);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const g = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).find((x) => x.id === DLL_WINDOW_ICON_GROUP);
  if (!g) throw new Error('chrome.dll window icon group 101 not found');
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icon.icons.map((i) => i.data));
  res.outputResource(dll);
  fs.writeFileSync(dllPath, Buffer.from(dll.generate()));
  return { group: DLL_WINDOW_ICON_GROUP };
}

// Both files of one Chromium folder (the packaged copy). Writing over the existing files keeps their ACLs — the
// sandbox needs ALL APPLICATION PACKAGES read access (a copied folder without it fails "Sandbox cannot access").
function brandChromiumDir(dir, icoPath) {
  const path = require('node:path');
  return { exe: brandChromiumExe(path.join(dir, 'chrome.exe'), icoPath), dll: brandChromiumDll(path.join(dir, 'chrome.dll'), icoPath) };
}

module.exports = { brandChromiumExe, brandChromiumDll, brandChromiumDir, BRANDED_GROUPS, DLL_WINDOW_ICON_GROUP, NAME };
