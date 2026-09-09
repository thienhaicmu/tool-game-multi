import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { BrowserWindowHost } = require('../../desktop/browser/browser-window-host.cjs');

// ---------------------------------------------------------------------------
// CONTROL-V3 — each BrowserRun is hosted in its OWN top-level browser window. These prove spec
// §29 (multi-window) + §30 (isolation) against a lightweight fake Electron: one window per run,
// the run's EXISTING view is re-parented (no duplicate webContents), focusing/closing one window
// never touches another, "Mở web" on a running profile focuses the existing window (no 2nd run),
// and per-profile geometry is saved on move/resize.
// ---------------------------------------------------------------------------

// Fake WebContentsView + its webContents (records re-parenting + fill bounds).
function fakeView(id) {
  const wc = Object.assign(new EventEmitter(), {
    _id: id, _focuses: 0, _destroyed: false,
    getURL: () => 'https://game/' + id, canGoBack: () => false, canGoForward: () => false,
    isDestroyed() { return this._destroyed; }, focus() { this._focuses++; },
  });
  return { _id: id, webContents: wc, _visible: null, _bounds: null, setVisible(v) { this._visible = v; }, setBounds(b) { this._bounds = b; } };
}

// Fake top-level BrowserWindow. Records child views, bounds, title, destroy/focus, and lets the
// test emit 'close' to simulate the user clicking X.
class FakeWin extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; this._title = opts.title; this._destroyed = false; this._focused = false; this._minimized = false;
    this._bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width, height: opts.height };
    this._children = [];
    this.webContents = Object.assign(new EventEmitter(), { send() {}, focus() {} });
    this.contentView = {
      addChildView: (v) => { this._children.push(v); },
      removeChildView: (v) => { this._children = this._children.filter((x) => x !== v); },
    };
  }
  loadURL() {} setMenuBarVisibility() {} setTitle(t) { this._title = t; }
  getContentBounds() { return { x: 0, y: 0, width: this._bounds.width, height: this._bounds.height }; }
  getBounds() { return { ...this._bounds }; }
  isDestroyed() { return this._destroyed; }
  isMinimized() { return this._minimized; }
  restore() { this._minimized = false; }
  show() {} focus() { this._focused = true; }
  destroy() { this._destroyed = true; this.emit('closed'); }  // destroy() does NOT emit 'close'
}

function makeHost(onClose) {
  const created = [];
  const electron = { BrowserWindow: function (opts) { const w = new FakeWin(opts); created.push(w); return w; } };
  const screen = { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) };
  const saved = new Map();
  const boundsStore = { get: (id) => saved.get(id) || null, set: (id, r) => { saved.set(id, r); return { bounds: r }; } };
  const host = new BrowserWindowHost({
    electron, screen, boundsStore, saveDelayMs: 0,
    normalizeWindowBounds: ({ saved, defaults }) => ({ ...defaults, ...(saved || {}) }),
    onClose: onClose || (() => {}),
  });
  return { host, created, saved };
}

const RUN = (id, browserId) => ({ id, browserId });

test('CASE A/B: opening B1 then B2 yields two independent top-level windows', () => {
  const { host, created } = makeHost();
  const v1 = fakeView('run-1'), v2 = fakeView('run-2');
  host.ensureWindow(RUN('run-1', 'B-0001'), v1, { title: 'B-0001 — kt2' });
  assert.equal(host.has('run-1'), true, 'B1 window exists');
  assert.equal(created.length, 1);

  host.ensureWindow(RUN('run-2', 'B-0002'), v2, { title: 'B-0002 — kt3' });
  assert.equal(host.has('run-2'), true, 'B2 window exists');
  assert.equal(host.has('run-1'), true, 'B1 still exists after B2 opens');
  assert.equal(created.length, 2, 'two distinct windows');
  assert.notEqual(host.window('run-1'), host.window('run-2'), 'distinct BrowserWindow instances');
});

test('re-parents the run\'s EXISTING view (no duplicate webContents) and fills below the toolbar', () => {
  const { host, created } = makeHost();
  const v1 = fakeView('run-1');
  host.ensureWindow(RUN('run-1', 'B-0001'), v1);
  const win = created[0];
  assert.deepEqual(win._children, [v1], 'the exact same view instance is added — no new webContents');
  assert.ok(v1._bounds && v1._bounds.y > 0, 'view is offset below the toolbar');
  assert.equal(v1._bounds.width, win._bounds.width, 'view fills window width');
});

test('CASE C/D: focusing one window never touches the other run\'s runtime', () => {
  const { host, created } = makeHost();
  const v1 = fakeView('run-1'), v2 = fakeView('run-2');
  host.ensureWindow(RUN('run-1', 'B-0001'), v1);
  host.ensureWindow(RUN('run-2', 'B-0002'), v2);

  host.focusWindow('run-1');
  assert.equal(created[0]._focused, true, 'B1 focused');
  assert.equal(created[1]._destroyed, false, 'B2 window not destroyed');
  assert.equal(v2.webContents._destroyed, false, 'B2 webContents untouched');
  assert.equal(host.has('run-2'), true);
});

test('CASE E: destroying B1 leaves B2 alive', () => {
  const { host, created } = makeHost();
  host.ensureWindow(RUN('run-1', 'B-0001'), fakeView('run-1'));
  host.ensureWindow(RUN('run-2', 'B-0002'), fakeView('run-2'));
  host.destroyWindow('run-1');
  assert.equal(host.has('run-1'), false, 'B1 window gone');
  assert.equal(created[0]._destroyed, true);
  assert.equal(host.has('run-2'), true, 'B2 still alive');
  assert.equal(created[1]._destroyed, false);
});

test('CASE F: ensureWindow on an already-open run focuses the existing window (no 2nd window)', () => {
  const { host, created } = makeHost();
  const v2 = fakeView('run-2');
  host.ensureWindow(RUN('run-2', 'B-0002'), v2);
  assert.equal(created.length, 1);
  const first = host.window('run-2');
  host.ensureWindow(RUN('run-2', 'B-0002'), fakeView('run-2-dup'));
  assert.equal(created.length, 1, 'no second window created for the same run');
  assert.equal(host.window('run-2'), first, 'same window returned');
  assert.equal(first._focused, true, 'existing window focused instead');
});

test('user close (X) surfaces onClose exactly once and drops the window; other run unaffected', () => {
  const closed = [];
  const { host, created } = makeHost((id) => closed.push(id));
  host.ensureWindow(RUN('run-1', 'B-0001'), fakeView('run-1'));
  host.ensureWindow(RUN('run-2', 'B-0002'), fakeView('run-2'));

  created[0].emit('close');   // user clicks X on B1
  assert.deepEqual(closed, ['run-1'], 'onClose fired for B1 only');
  assert.equal(host.has('run-1'), false, 'B1 dropped from the host map');
  assert.equal(host.has('run-2'), true, 'B2 untouched');

  // Programmatic teardown uses destroy() (no 'close'), so it never re-enters onClose.
  host.destroyWindow('run-2');
  assert.deepEqual(closed, ['run-1'], 'destroyWindow did not re-fire onClose');
});

test('per-profile geometry is saved on move/resize, keyed by browserId', async () => {
  const { host, created, saved } = makeHost();
  host.ensureWindow(RUN('run-1', 'B-0001'), fakeView('run-1'));
  const win = created[0];
  win._bounds = { x: 120, y: 80, width: 1200, height: 700 };
  win.emit('resize');
  await new Promise((r) => setTimeout(r, 5)); // debounced save (saveDelayMs=0) fires on next tick
  assert.deepEqual(saved.get('B-0001'), { x: 120, y: 80, width: 1200, height: 700 }, 'B-0001 geometry saved');
  assert.equal(saved.has('B-0002'), false, 'no cross-profile write');
});

test('saved per-profile geometry is restored on next open (bounds never mixed)', () => {
  const { host, saved } = makeHost();
  saved.set('B-0001', { x: 10, y: 20, width: 1024, height: 576 });
  const win = host.ensureWindow(RUN('run-1', 'B-0001'), fakeView('run-1'));
  assert.equal(win._bounds.width, 1024);
  assert.equal(win._bounds.x, 10, 'restored B-0001 position');
});

test('destroyAll tears down every window', () => {
  const { host, created } = makeHost();
  host.ensureWindow(RUN('run-1', 'B-0001'), fakeView('run-1'));
  host.ensureWindow(RUN('run-2', 'B-0002'), fakeView('run-2'));
  host.destroyAll();
  assert.equal(host.has('run-1'), false);
  assert.equal(host.has('run-2'), false);
  assert.ok(created.every((w) => w._destroyed), 'all windows destroyed');
});
