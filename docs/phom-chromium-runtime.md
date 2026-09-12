# PHỎM QA — Custom Chromium runtime + Cluster CDP

## Pinned Chromium runtime
The Phỏm QA app launches a **project-owned custom Chromium** (never system Chrome):

- Version: **149.0.7827.55** · arch **x64**
- Bundle: 260 files, ~537 MB (chrome.exe + chrome.dll + icudtl.dat + *.pak + snapshot bins + locales/ + GPU/MSVC DLLs)
- Lives at `runtime/phom-chromium/` — **gitignored** (binaries are never committed). Tracked instead: the validator (`desktop/browser/phom-chromium-runtime.cjs`), the prepare script, this doc, and the generated `runtime-manifest.json` metadata (checksums).

### Prepare on a new machine
```
# copies + validates + writes runtime-manifest.json (version + sha256 checksums)
node tools/prepare-phom-chromium.mjs --source <path-to-chromium-runtime>
# or: PHOM_CHROMIUM_SOURCE=<dir> npm run prepare:phom-chromium
```
Default source is the reference bundle `D:\m-profile\dist\chromium-runtime` (read-only reference; adjust per machine). The app does **not** depend on `D:\m-profile` at runtime.

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
