import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

const mainSrc = read('desktop/phom-main.cjs');
const preloadSrc = read('desktop/phom-preload.cjs');
const rendererSrc = read('ui-phom/phom-qa.js');
const cssSrc = read('ui-phom/phom-qa.css');
const htmlSrc = read('ui-phom/index.html');
const launcherSrc = read('desktop/browser/chrome-launcher.cjs');
const builder = JSON.parse(read('electron-builder.phom.json'));
const pkg = JSON.parse(read('package.json'));
const analyticsBuilder = JSON.parse(read('electron-builder.analytics.json'));

// §12 — distinct application identity (appId / productName / output / userData).
test('Phom app identity is distinct from Control and Analytics', () => {
  assert.equal(builder.appId, 'com.phomqa.desktop');
  assert.equal(builder.productName, 'Phom QA');
  assert.equal(builder.directories.output, 'release-phom');
  assert.notEqual(builder.appId, pkg.build.appId);            // != Control
  assert.notEqual(builder.appId, analyticsBuilder.appId);      // != Analytics
  assert.notEqual(builder.directories.output, pkg.build.directories.output);
  assert.notEqual(builder.directories.output, analyticsBuilder.directories.output);
  assert.equal(builder.extraMetadata.main, 'desktop/phom-main.cjs');
  assert.match(builder.artifactName, /Phom-QA/);
  // main sets its own userData namespace + name
  assert.match(mainSrc, /app\.setName\(PRODUCT_NAME\)/);
  assert.match(mainSrc, /PRODUCT_NAME = 'Phom QA'/);
  assert.match(mainSrc, /requestSingleInstanceLock/);
});

// §3/§7 — license gate expects the PHOM game product.
test('Phom main gates on PHOM license entitlement', () => {
  assert.match(mainSrc, /GAME_PRODUCT = 'PHOM'/);
  assert.match(mainSrc, /expectedGameProduct: GAME_PRODUCT/);
});

// §10/§18 — no import (require) of Control or Analytics renderers/roots/singletons.
// Checks actual require() targets, not documentation prose that names the peers.
test('Phom app does not import Control/Analytics renderer or roots', () => {
  for (const src of [mainSrc, preloadSrc, rendererSrc]) {
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const dep of requires) {
      assert.equal(/product\.js|app-shell|ui\/panels|\bmain\.cjs$/.test(dep), false, `no Control renderer import: ${dep}`);
      assert.equal(/analytics-main|analytics-preload|ui-analytics|analytics\//.test(dep), false, `no Analytics import: ${dep}`);
      assert.equal(/protocol\/(aviator|auto-runner|round-observer|harness)/.test(dep), false, `no Aviator action modules: ${dep}`);
    }
  }
});

// §18 — renderer talks ONLY to the typed preload; no direct network/live sender import.
test('Phom renderer has no direct network / live sender / node imports', () => {
  assert.equal(/require\(/.test(rendererSrc), false, 'renderer must not require() node modules');
  assert.equal(/ws-replay|sendProtocol|chrome-remote-interface|node:net|import\s+net/.test(rendererSrc), false);
  // It uses the exposed API surface.
  assert.match(rendererSrc, /window\.phomQA/);
});

// §18 — every preload IPC channel is namespaced 'phom:'.
test('all Phom preload IPC channels use the phom: namespace', () => {
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|on)\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(channels.length >= 15, 'expected the full preload surface');
  for (const c of channels) assert.match(c, /^phom:/, `channel ${c} must be phom:-namespaced`);
});

// BROWSER LIFETIME INDEPENDENCE — DỪNG stops orchestration only; the ONLY app path that
// closes browsers is the explicit close (ĐÓNG 3 TRÌNH DUYỆT) / app shutdown.
test('main separates orchestration-stop (DỪNG) from browser close (explicit)', () => {
  // DỪNG IPC delegates to stopOrchestration (no closeRun). (Diagnostic lifecycleLog may
  // precede the call; the handler must still route to stopOrchestration and never a close.)
  const orchHandler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('phom:orchestration-stop'"), mainSrc.indexOf("ipcMain.handle('phom:cluster-stop'"));
  assert.match(orchHandler, /stopOrchestration\(\)/);
  assert.equal(/stopCluster|closeRun/.test(orchHandler), false, 'DỪNG must never close browsers');
  // The explicit close IPC is the only one that calls the manager stopCluster (closeRun).
  assert.match(mainSrc, /ipcMain\.handle\('phom:cluster-stop'[^]*?stopCluster\(\)/);
  // A run exiting on its own marks ONLY that slot closed — never cascades a close — and
  // forwards the launcher's CLASSIFIED reason (never a blanket close).
  assert.match(mainSrc, /onRunExit:[^\n]*markRunClosed\(runId,\s*record\s*&&\s*record\.reason\)/);
  // preload exposes both the orchestration stop and the explicit browser close.
  assert.match(preloadSrc, /orchestrationStop:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('phom:orchestration-stop'\)/);
  assert.match(preloadSrc, /closeBrowsers:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('phom:cluster-stop'\)/);
});

// The manager's stopOrchestration must NOT close runs; only stopCluster closes them.
test('cluster manager: stopOrchestration has no closeRun; only stopCluster does', () => {
  const mgrSrc = read('desktop/protocol/phom/phom-cluster-cdp-manager.cjs');
  const stopOrch = mgrSrc.slice(mgrSrc.indexOf('stopOrchestration()'), mgrSrc.indexOf('orchestrationStopped()'));
  assert.equal(/_closeRun/.test(stopOrch), false, 'stopOrchestration must never call _closeRun');
  const stopClu = mgrSrc.slice(mgrSrc.indexOf('async stopCluster()'), mgrSrc.indexOf('getClusterSnapshot()'));
  assert.match(stopClu, /_closeRun/, 'stopCluster is the explicit close path');
});

// §12 — build file list ships the Phom renderer + reused low-level owners, NOT the
// Control/Analytics renderers.
test('Phom build files include ui-phom + shared owners, exclude other renderers', () => {
  const files = builder.files.join('\n');
  assert.match(files, /ui-phom/);
  assert.match(files, /protocol\/phom/);
  assert.match(files, /licensing/);
  assert.equal(/ui\/\*\*|ui-analytics/.test(files), false, 'must not ship Control/Analytics renderer');
});

// The private signing key must NEVER be part of the Phom package (§11).
test('Phom package does not include generator/private-key material', () => {
  const files = builder.files.join('\n');
  assert.equal(/license-generator|private|generate-license|generate-keypair/.test(files), false);
});

// --- Phase 8 interactive-acceptance regression guards -------------------------

// Defect 1: the `hidden` attribute must beat element display rules (.activation
// {display:flex}, .grid2x2{display:grid}); otherwise a hidden screen still paints
// over the visible one. The `!important` override is what makes hidden win.
test('CSS: [hidden] overrides element display so a hidden screen cannot paint over', () => {
  assert.match(cssSrc, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/,
    'phom-qa.css must keep [hidden]{display:none!important} (Defect 1 fix)');
});

// Defect 2: each cluster slot opens with its OWN per-slot user-data-dir under
// browser-profiles/<slot> — never a null profile (which fails CHROME_PROFILE_MISSING).
test('cluster openProfile gives each slot its own browser-profiles/<slot> user-data-dir', () => {
  assert.match(mainSrc, /browser-profiles/, 'per-slot profile dir root');
  assert.match(mainSrc, /mkdirSync\([^)]*profileDir|profileDir[^\n]*mkdirSync/, 'the per-slot dir is created before launch');
});

// Defect 4: the Chromium CDP endpoint is not ready the instant the process spawns;
// connect must retry rather than report connected:0 on the first miss.
test('phom-main retries the per-run CDP connect (no single-shot connect)', () => {
  assert.match(mainSrc, /connectRunEndpointWithRetry/, 'a bounded retry wrapper exists');
});

// LOCAL RUNTIME TEST is dev-only: its gate stays bound to the dev bypass (it opens
// about:blank for verification). Proxy is OPTIONAL for every launch, so the cluster
// open path no longer forces proxyRequired — a slot with no proxy runs DIRECT.
test('LOCAL RUNTIME TEST gate stays dev-bypass-bound; cluster open path treats proxy as optional', () => {
  assert.match(mainSrc, /clusterLocalTest\s*&&\s*devBypass\.allowed\s*===\s*true/,
    'localTestActive() is gated on devBypass.allowed');
  assert.match(mainSrc, /proxyRequired:\s*false/,
    'the cluster open path passes proxyRequired:false (proxy optional; proxyRef governs PROXY vs DIRECT)');
  // the launch gate is opt-IN required, so an unbound slot is DIRECT (never forced).
  assert.match(mainSrc, /resolveLaunchProxy\(\{\s*proxyRef:[^}]*proxyRequired:\s*proxyRequired\s*===\s*true/);
});

// --- Setup-First UX (state machine) ------------------------------------------

// The HTML shell must NOT hardcode the three embedded browser cells anymore — the
// browsers are separate native windows. The tool surface is a single #phq-root.
test('HTML shell has a single tool surface, no embedded browser placeholder cells', () => {
  assert.match(htmlSrc, /id="phq-root"/);
  assert.equal(/grid2x2|cell-A|cell-B|cell-C|body-A|body-B/.test(htmlSrc), false,
    'no 2×2 grid / per-slot browser cells baked into the DOM');
});

// The renderer is a state machine with the required states.
test('renderer defines the SETUP/OPENING_CLUSTER/CONTROL/STOPPING/ERROR states', () => {
  for (const s of ['SETUP', 'OPENING_CLUSTER', 'CONTROL', 'STOPPING', 'ERROR']) {
    assert.match(rendererSrc, new RegExp(s + ':'), `UI state ${s} is defined`);
  }
  assert.match(rendererSrc, /function renderSetup\b/);
  assert.match(rendererSrc, /function renderControl\b/);
});

// SETUP shows ONE open-all CTA and no per-slot "Mở game" buttons.
test('SETUP has a single Open-Cluster CTA and no per-slot open-game buttons', () => {
  assert.match(rendererSrc, /cta-open/);
  assert.match(rendererSrc, /MỞ 3 TRÌNH DUYỆT/);
  assert.equal(/Mở game/.test(rendererSrc), false, 'no per-slot "Mở game" buttons remain');
  assert.equal(/function renderBrowserCell\b|function openOne\b/.test(rendererSrc), false,
    'the old per-slot browser cell / single-open helpers are gone');
});

// The dev-only red sandbox banner is wired to caps.chromiumSandbox.disabled.
test('renderer shows the red DEV sandbox banner from capabilities', () => {
  assert.match(rendererSrc, /danger-banner/);
  assert.match(rendererSrc, /chromiumSandbox/);
  assert.match(cssSrc, /\.danger-banner\s*\{/);
});

// --- Chromium sandbox policy (SECURITY) --------------------------------------

// The launcher must NOT default to --no-sandbox for the custom executable anymore.
test('launcher never hard-codes --no-sandbox for the custom executable', () => {
  assert.equal(/chromeExecutable\s*\?\s*\[\s*'--no-sandbox'/.test(launcherSrc), false,
    'the old chromeExecutable ⇒ --no-sandbox default is removed');
  assert.match(launcherSrc, /this\.sandboxDisabled\s*\?\s*\['--no-sandbox'\]/,
    '--no-sandbox is gated on the explicit sandboxDisabled flag');
});

// phom-main computes the sandbox policy and self-heals the runtime ACL instead of
// silently disabling the sandbox.
test('phom-main uses resolveSandboxPolicy + ensureSandboxAccess (no silent --no-sandbox)', () => {
  assert.match(mainSrc, /resolveSandboxPolicy/);
  assert.match(mainSrc, /ensureSandboxAccess/);
  assert.match(mainSrc, /PHOM_CHROMIUM_SANDBOX_REQUIRED/);
  assert.match(mainSrc, /chromiumSandbox:/, 'capabilities expose the sandbox mode to the renderer');
});
