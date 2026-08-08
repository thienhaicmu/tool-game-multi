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
// §19 — default is Protocol Test mode (advanced OFF); toggle persists.
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

test('view set and panel mapping reuse the existing WU7-10.2 panels', () => {
  assert.deepEqual(Shell.VIEWS, ['overview', 'manual', 'auto', 'btest']);
  assert.deepEqual(Shell.PANEL_FOR_VIEW, { manual: 'proto-panel', auto: 'at-panel', btest: 'bv-panel' });
});

// ---------------------------------------------------------------------------
// §2/§6/§30 — default view exposes the focused workflow.
// ---------------------------------------------------------------------------
test('default body opens in product mode', () => {
  assert.ok(/<body[^>]*data-mode="product"/.test(html));
});

test('appbar exposes URL + Open Browser + Advanced Debug toggle', () => {
  assert.ok(idx('id="shell-url"') >= 0, 'URL input');
  assert.ok(idx('id="shell-open"') >= 0, 'Open Browser button');
  assert.ok(/id="shell-open"[^>]*>\s*Open Browser/.test(html));
  assert.ok(idx('id="shell-advanced"') >= 0, 'Advanced Debug toggle');
});

test('left nav contains Overview / Manual Test / Auto Test / b-Test', () => {
  for (const label of ['Overview', 'Manual Test', 'Auto Test', 'b-Test']) assert.ok(idx('>' + label + '<') >= 0, `nav has ${label}`);
  for (const v of ['data-view="overview"', 'data-view="manual"', 'data-view="auto"', 'data-view="btest"']) assert.ok(idx(v) >= 0, v);
});

// ---------------------------------------------------------------------------
// §5/§18/§27 — generic debugger is present but wrapped behind #legacy (hidden by
// default), NOT deleted.
// ---------------------------------------------------------------------------
test('generic debugger is wrapped in #legacy and kept (not deleted)', () => {
  const legacy = idx('id="legacy"');
  assert.ok(legacy >= 0, '#legacy wrapper exists');
  // The generic panes live INSIDE #legacy (their markup comes after the wrapper open).
  for (const marker of ['class="topbar"', 'intercept-bar', 'class="grid"', 'id="editor"', 'id="host"', 'id="list"', 'id="detail-tabs"']) {
    assert.ok(idx(marker) > legacy, `${marker} is inside #legacy`);
  }
  // Engine-facing controls still exist (kept for Advanced Debug).
  for (const marker of ['id="connect"', 'id="adb"', 'id="intc-toggle"']) assert.ok(idx(marker) >= 0, `${marker} retained`);
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
  for (const id of ['id="ov-odd"', 'id="ov-sid"', 'id="ov-phase"', 'id="ov-recent"', 'id="ov-browser"', 'id="ov-proto"']) assert.ok(idx(id) >= 0, id);
  assert.ok(idx('CURRENT ODD') >= 0);
});

// ---------------------------------------------------------------------------
// scripts wired.
// ---------------------------------------------------------------------------
test('app-shell.js is loaded before product.js', () => {
  assert.ok(idx('app-shell.js') >= 0 && idx('app-shell.js') < idx('product.js'));
});
