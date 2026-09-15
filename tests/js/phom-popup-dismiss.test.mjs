// BUG #3 — VÀO GAME PHỎM couldn't enter because the anti-phishing warning popup (Cocos node
// PopupWarningPhishing) sat on top of the NewLobby and blocked the scene transition. The entry now
// dismisses that popup (fires its close button + force-hides the node) BEFORE firing the vgcg_8 tile,
// without changing the tile-entry firing itself. Evidence: the live scene graph exposed
// PopupWarningPhishing/popup/full/btnClose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const entry = require('../../desktop/protocol/cocos-lobby-entry.cjs');

test('BLOCKING_POPUPS targets the phishing warning popup + its close button', () => {
  assert.deepEqual(entry.BLOCKING_POPUPS, [['PopupWarningPhishing', 'btnClose']]);
});

// Build a minimal mock Cocos scene and run the sealed dismiss hook against it.
function mkNode(name, opts = {}) {
  return {
    name, _name: name, children: opts.children || [], _active: opts.active !== false, _emitted: [],
    get activeInHierarchy() { return this._active; },
    set active(v) { this._active = v; }, get active() { return this._active; },
    _button: opts.button || null,
    getComponent(t) { return t === MOCK.Button ? this._button : null; },
    emit(...a) { this._emitted.push(a); },
  };
}
let MOCK;
function runHookAgainst(scene) {
  const fired = [];
  MOCK = {
    Button: function Button() {},
    Component: { EventHandler: { emitEvents: (evts, node) => fired.push({ evts, node: node && node.name }) } },
    director: { getScene: () => scene },
  };
  const prevCc = globalThis.cc; globalThis.cc = MOCK;
  // eslint-disable-next-line no-eval
  (0, eval)(entry.buildDismissPopupsHook()); // installs globalThis.__phomDismissPopups
  const res = globalThis.__phomDismissPopups();
  const out = { res, fired };
  globalThis.cc = prevCc; delete globalThis.__phomDismissPopups;
  return out;
}

test('dismiss fires the popup close button AND force-hides the popup node', () => {
  const btnClose = mkNode('btnClose', { button: { clickEvents: [{}] } });
  const full = mkNode('full', { children: [btnClose] });
  const popup = mkNode('popup', { children: [full] });
  const pop = mkNode('PopupWarningPhishing', { children: [popup], active: true });
  const scene = mkNode('Scene', { children: [mkNode('Canvas', { children: [pop] })] });
  assert.equal(pop.active, true);
  const { res, fired } = runHookAgainst(scene);
  assert.deepEqual(res.dismissed, ['PopupWarningPhishing']);
  assert.equal(fired.length, 1, 'the close button clickEvents were emitted');
  assert.equal(fired[0].node, 'btnClose');
  assert.equal(pop.active, false, 'the blocking popup is force-hidden so entry can proceed');
});

test('dismiss is resolve-before-invoke: no popup => nothing fired, nothing changed', () => {
  const scene = mkNode('Scene', { children: [mkNode('Canvas', { children: [mkNode('NewLobby')] })] });
  const { res, fired } = runHookAgainst(scene);
  assert.deepEqual(res.dismissed, []);
  assert.equal(fired.length, 0);
});

test('an already-inactive popup is not treated as blocking', () => {
  const pop = mkNode('PopupWarningPhishing', { active: false });
  const scene = mkNode('Scene', { children: [pop] });
  const { res } = runHookAgainst(scene);
  assert.deepEqual(res.dismissed, []);
});

// runEnterGameViaSite must dismiss popups BEFORE firing the tile (order matters).
test('runEnterGameViaSite dismisses blocking popups before firing the vgcg_8 tile', async () => {
  const calls = [];
  const client = {
    Runtime: {
      evaluate: async ({ expression }) => {
        calls.push(expression);
        if (/__phomDismissPopups/.test(expression)) return { result: { value: { dismissed: ['PopupWarningPhishing'] } } };
        if (/__avEnterAviator/.test(expression)) return { result: { value: { ok: true, resolve: { nodeResolved: true, buttonResolved: true } } } };
        return { result: { value: undefined } };
      },
    },
  };
  const r = await entry.runEnterGameViaSite(client, undefined, 'vgcg_8', () => {});
  assert.equal(r.ok, true);
  const dismissIdx = calls.findIndex((e) => /__phomDismissPopups/.test(e));
  const tileIdx = calls.findIndex((e) => /__avEnterAviator\(\)/.test(e));
  assert.ok(dismissIdx >= 0, 'dismiss was invoked');
  assert.ok(tileIdx >= 0, 'tile entry was invoked');
  assert.ok(dismissIdx < tileIdx, 'popups dismissed BEFORE the tile is fired');
});
