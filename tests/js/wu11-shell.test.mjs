import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Pure shell logic (browser global loaded into a fake window).
const src = readFileSync(new URL('../../ui/app-shell.js', import.meta.url), 'utf8');
const win = {}; new Function('window', src)(win);
const Shell = win.AppShell;

const html = readFileSync(new URL('../../ui/product.html', import.meta.url), 'utf8');
const idx = (s) => html.indexOf(s);

// ---------------------------------------------------------------------------
// §19 — default is product control mode (advanced OFF); toggle persists.
// ---------------------------------------------------------------------------
test('mode defaults to product; loads/saves advanced flag', () => {
  const store = {};
  const get = (k) => (k in store ? store[k] : null);
  const set = (k, v) => { store[k] = v; };
  assert.equal(Shell.loadMode(get), 'product', 'fresh install -> product');
  Shell.saveMode(set, 'advanced');
  assert.equal(store[Shell.STORAGE_KEY], '1');
  assert.equal(Shell.loadMode(get), 'advanced');
  Shell.saveMode(set, 'product');
  assert.equal(Shell.loadMode(get), 'product');
  assert.equal(Shell.isAdvanced('advanced'), true);
  assert.equal(Shell.isAdvanced('product'), false);
});

// WU-D.1 — final product IA (browser-centric). Manual/Amount Check are no longer
// primary tabs; only the Auto workspace is powered by a reused slide-in panel.
test('view set and panel mapping expose the final product IA', () => {
  assert.deepEqual(Shell.VIEWS, ['overview', 'auto', 'history', 'advanced']);
  assert.deepEqual(Shell.PANEL_FOR_VIEW, { auto: 'at-panel' });
});

// ---------------------------------------------------------------------------
// §2/§6/§30 — default view exposes the focused workflow.
// ---------------------------------------------------------------------------
test('default body opens in product mode', () => {
  assert.ok(/<body[^>]*data-mode="product"/.test(html));
});

// WU-D.1 — the appbar carries app-level truth only (rights + signed capacity + the
// Nâng cao escape hatch). The raw URL launcher moved OUT of the normal appbar into the
// secondary Advanced (Nâng cao) view; browsers are created per-B via the rail.
test('appbar exposes license/capacity + Nâng cao toggle; URL launcher moved to Advanced', () => {
  assert.ok(idx('id="shell-license"') >= 0, 'License badge');
  assert.ok(idx('id="cap-badge"') >= 0, 'Signed capacity badge');
  assert.ok(idx('id="shell-advanced"') >= 0, 'Nâng cao toggle');
  assert.ok(idx('> ⚙ Nâng cao') >= 0, 'Nâng cao label (Vietnamese)');
  // URL launcher still exists but now lives inside the Advanced view, after the tabs.
  assert.ok(idx('id="shell-url"') >= 0 && idx('id="shell-open"') >= 0, 'URL launcher retained');
  assert.ok(idx('id="view-advanced"') >= 0 && idx('id="shell-url"') > idx('id="view-advanced"'), 'URL launcher is inside the Advanced view');
  assert.ok(/id="shell-open"[^>]*>\s*Mở trình duyệt/.test(html), 'launcher button is Vietnamese');
});

test('appbar license badge includes expiry date text', () => {
  // WU-C.4 — customer license UI is Vietnamese ("Hết hạn" = Expires).
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  assert.ok(/Hết hạn \$\{dateFromSecondsTrusted\(licenseState\.payload\.expiresAt\)\}/.test(js));
});

// WU-D.1 — final Vietnamese, browser-task nav: Tổng quan / Tự động / Lịch sử / Nâng cao.
test('workspace nav is the final Vietnamese IA (Tổng quan / Tự động / Lịch sử / Nâng cao)', () => {
  for (const label of ['Tổng quan', 'Tự động', 'Lịch sử', 'Nâng cao']) assert.ok(idx('>' + label + '<') >= 0, `nav has ${label}`);
  for (const v of ['data-view="overview"', 'data-view="auto"', 'data-view="history"', 'data-view="advanced"']) assert.ok(idx(v) >= 0, v);
  // Manual Control / Amount Check are no longer primary tabs.
  assert.ok(idx('>Manual Control<') < 0 && idx('>Amount Check<') < 0, 'test tools are not primary tabs');
});

// ---------------------------------------------------------------------------
// §5/§18/§27 — generic debugger is present but wrapped behind #legacy (hidden by
// default), NOT deleted.
// ---------------------------------------------------------------------------
test('generic debugger is wrapped in #legacy and kept (not deleted)', () => {
  const legacy = idx('id="legacy"');
  assert.ok(legacy >= 0, '#legacy wrapper exists');
  // The generic panes live INSIDE #legacy (their markup comes after the wrapper open).
  for (const marker of ['class="topbar"', 'intercept-bar', 'class="grid"', 'id="editor"', 'id="list"', 'id="detail-tabs"']) {
    assert.ok(idx(marker) > legacy, `${marker} is inside #legacy`);
  }
  // Engine-facing controls still exist (kept for Diagnostics).
  for (const marker of ['id="launch"', 'id="targets"', 'id="intc-toggle"']) assert.ok(idx(marker) >= 0, `${marker} retained`);
  // External-attach (connect to arbitrary CDP / adb WebView) is removed with the single-runtime cleanup.
  for (const marker of ['id="connect"', 'id="host"', 'id="adb"']) assert.ok(idx(marker) < 0, `${marker} removed`);
});

test('focused shell markup precedes the legacy debugger', () => {
  const legacy = idx('id="legacy"');
  for (const marker of ['id="shell-url"', 'id="shell-nav"', 'id="view-overview"', 'id="ov-odd"']) {
    assert.ok(idx(marker) >= 0 && idx(marker) < legacy, `${marker} is in the focused shell`);
  }
});

// ---------------------------------------------------------------------------
// CSS proves product mode hides the legacy debugger.
// ---------------------------------------------------------------------------
test('product mode hides #legacy via CSS', () => {
  const css = readFileSync(new URL('../../ui/product.css', import.meta.url), 'utf8');
  assert.ok(/body\[data-mode=product\]\s*#legacy\s*\{\s*display:\s*none/.test(css.replace(/\s+/g, ' ').replace(/ ?\{ ?/g, '{')), 'legacy hidden in product mode');
});

// ---------------------------------------------------------------------------
// §7/§8 — overview shows a prominent current ODD + protocol status.
// ---------------------------------------------------------------------------
test('overview has a prominent current-odd element and protocol status fields', () => {
  for (const id of ['id="ov-odd"', 'id="ov-sid"', 'id="ov-phase"', 'id="ov-recent"', 'id="ov-browser"', 'id="ov-proto"', 'id="ov-jackpot"']) assert.ok(idx(id) >= 0, id);
  assert.ok(idx('ODD HIỆN TẠI') >= 0, 'current-odd label is Vietnamese');
});

// ---------------------------------------------------------------------------
// WU-D.1 — final product completion criteria (§3/§4/§10/§13/§34).
// ---------------------------------------------------------------------------
test('selected-browser identity band is present (center of gravity)', () => {
  for (const id of ['id="ws-ident"', 'id="wsi-bid"', 'id="wsi-name"', 'id="wsi-state"', 'id="wsi-sid"', 'id="wsi-odd"', 'id="wsi-jp"']) assert.ok(idx(id) >= 0, id);
});

test('no global broadcast execution controls exist', () => {
  const hay = html.toUpperCase();
  for (const bad of ['START ALL', 'STOP ALL', 'OPEN ALL', 'CLOSE ALL', 'AUTO ALL', 'BET ALL', 'CASHOUT ALL']) {
    assert.ok(!hay.includes(bad), `must not contain "${bad}"`);
  }
});

test('Stop-odd (per-round) and Stop-1000x (session) stay distinct controls', () => {
  // Per-round cashout threshold lives in each Auto sequence row (rendered by product.js).
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  assert.ok(/Dừng tại ODD/.test(js), 'per-round stop-odd label present in the sequence row');
  // Session kill switch is a SEPARATE boolean control with its own id + label.
  assert.ok(idx('id="at-stop1000"') >= 0, 'stop-1000x checkbox present');
  assert.ok(idx('Dừng khi đạt 1000x') >= 0, 'stop-1000x label present');
  // They are not the same field.
  assert.ok(idx('id="at-stop1000"') !== idx('class="mono at-stopodd"'), 'distinct controls');
});

test('aid/eid are never editable inputs in the normal UI (session-owned)', () => {
  assert.ok(idx('id="pf-b"') !== -2, 'sanity'); // pf-b is amount, allowed
  // No text/number inputs bound to aid/eid ids.
  assert.ok(!/<input[^>]*id="(at-aid|at-eid|pf-aid|pf-eid|bv-aid|bv-eid)"/.test(html), 'no editable aid/eid inputs');
});

test('History view is evidence-safe: no misleading win-rate / inferred loss/payout/net', () => {
  const js = readFileSync(new URL('../../ui/product.js', import.meta.url), 'utf8');
  // Payout / Net render as "Không có" (unavailable), never a fabricated number.
  assert.ok(/kv\('Tiền thắng', 'Không có', true\)/.test(js), 'payout unavailable');
  assert.ok(/kv\('Lãi\/Lỗ', 'Không có', true\)/.test(js), 'net unavailable');
  // The misleading wins/(wins+losses) win-rate row was removed from persistent history.
  assert.ok(!/kv\('Win rate'/.test(js), 'no misleading win-rate row');
});

// ---------------------------------------------------------------------------
// scripts wired.
// ---------------------------------------------------------------------------
test('app-shell.js is loaded before product.js', () => {
  assert.ok(idx('app-shell.js') >= 0 && idx('app-shell.js') < idx('product.js'));
});
