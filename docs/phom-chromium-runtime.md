# PHỎM QA — Custom Chromium runtime + Cluster CDP

## Pinned Chromium runtime
The Phỏm QA app launches a **project-owned custom Chromium** (never system Chrome):

- Version: **149.0.7827.55** · arch **x64**
- Bundle: ~260 files, ~537 MB (chrome.exe + chrome.dll + icudtl.dat + *.pak + snapshot bins + locales/ + GPU/MSVC DLLs)
- Distributed as a **versioned archive**, NOT committed to Git. The local runtime `runtime/phom-chromium/` and built archives `runtime-archives/` are **gitignored**. Git tracks only: the artifact manifest `runtime-manifests/phom-chromium-<ver>-win-x64.json` (version + archive SHA-256 + file checksums + provider), the validator (`desktop/browser/phom-chromium-runtime.cjs`), the artifact module (`desktop/browser/phom-runtime-artifact.cjs`), the prepare/archive scripts, and this doc.

### Build the archive (maintainer, once per Chromium version)
```
# validate local runtime -> forbidden-file scan -> Compress-Archive -> SHA-256 ->
# update runtime-manifests/*.json (provider stays NOT_CONFIGURED until you host it)
npm run archive:phom-chromium
```
Output: `runtime-archives/phom-chromium-149.0.7827.55-win-x64.zip` (~221 MB). Upload it to a host (GitHub Release asset / HTTPS / object storage) and set `download.provider` + `download.url` in the tracked manifest.

### Prepare on a new dev/package machine
```
# A. local archive (works today, provider NOT_CONFIGURED):
node tools/prepare-phom-chromium.mjs --archive <path>\phom-chromium-149.0.7827.55-win-x64.zip
# B. configured remote (once download.url is set + host allowlisted via PHOM_RUNTIME_DOWNLOAD_HOSTS):
npm run prepare:phom-chromium
```
Prepare verifies the archive SHA-256, rejects unsafe zip entries, extracts to a temp dir, validates the extracted runtime + file checksums, then **atomically** replaces `runtime/phom-chromium/` (the previous runtime is preserved on any failure). It **never** defaults to `D:\m-profile`; the app has no `D:\m-profile` dependency at dev or runtime.

### Two machine flows (§13)
- **End user**: installs `Phom-QA Setup <ver>.exe` — Chromium is already inside the installer (`resources/phom-chromium/`). No Node.js, no system Chrome, no prepare step, no `D:\m-profile`.
- **Dev/package machine**: clone source → `npm ci` → `npm run prepare:phom-chromium -- --archive <zip>` (or configured remote) → `npm run dist:phom`.

### Resolution + validation
- Dev: `PHOM_CHROMIUM_PATH` → else `runtime/phom-chromium/`.
- Packaged: `<resources>/phom-chromium/chrome.exe` (shipped via electron-builder `extraResources`, **outside** the ASAR).
- No system-Chrome fallback. Every launch validates: root/executable/required files+dirs, pinned version, arch, and the `chrome.exe` checksum. Typed errors: `PHOM_CHROMIUM_NOT_CONFIGURED / _RUNTIME_NOT_FOUND / _RUNTIME_INCOMPLETE / _CHECKSUM_MISMATCH / _VERSION_MISMATCH / _ARCH_MISMATCH / _LAUNCH_FAILED / _CDP_TIMEOUT`.

## PhomClusterCdpManager
Control-plane over the three profiles that keeps **three independent CDP connections** (one per BrowserRun) — never a shared session. It fans out open/connect/apply-devices/test-proxies per profile, normalizes each per-profile event into a cluster envelope (rejecting stale-cluster / wrong-profile / duplicate / out-of-order), aggregates a secret-free snapshot, and delegates game orchestration to the existing `HostSessionManager`. `stopCluster()` tears down only owned runs and is idempotent.

## Non-live runtime proof
`node tools/phom-runtime-proof.mjs` (or `npm run proof:phom-runtime`) launches **three real custom-Chromium processes** (own PID / user-data-dir / loopback CDP port), applies each profile's mobile-landscape device via CDP `Emulation.*`, and verifies from inside each page — with **no game server, no proxy, no Google calls**:

- three processes with distinct PIDs / CDP ports / user-data-dirs
- `window.innerWidth > innerHeight` (landscape) for all three
- `navigator.maxTouchPoints > 0` (touch) for all three
- `navigator.userAgent` == the profile's mobile UA (distinct per profile)
- killing profile A's process leaves B and C independently responsive

Note: launching the runtime from a copied location requires `--no-sandbox` (the Chromium sandbox helper cannot access the copied executable's ACLs — `Access denied 0x5`); this is standard for a QA/dev runtime.
