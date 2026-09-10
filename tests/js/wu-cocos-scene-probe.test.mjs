// WU-COCOS-SCENE-PROBE — the READ-ONLY scene probe reads the game's OWN authoritative Cocos UI
// state (in Aviator vs back at NewLobby / "Đang kết nối lại" reconnect banner) instead of inferring
// from WS/ODD traffic. It must click nothing, send nothing, and correctly discriminate the states.
//
// Root cause it exists to catch (live-confirmed by screenshots): a game-server WS drop makes the
// game show its own reconnect banner and land back at the lobby, while ODD keeps broadcasting — so
// the ODD-freshness heuristic wrongly reports "in Aviator". The probe answers from the game itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildProbeSceneHook, runProbeAviatorSceneViaSite, RECONNECT_BANNER_KEYWORDS, KNOWN_AVIATOR_GAME_ID,
} = require('../../desktop/protocol/aviator-entry-descriptor.cjs');

// ---------------------------------------------------------------------------
// Mock Cocos Creator 2.x surface — a scene tree with named nodes + optional Label text.
// ---------------------------------------------------------------------------
function makeCocos(scene, findResult = null) {
  function Label() {}
  function Button() {}
  const cc = { Label, Button, find: () => findResult, director: { getScene: () => scene } };
  return { cc };
}
function node(name, { active = true, label = null, children = [] } = {}) {
  return {
    name, children, activeInHierarchy: active,
    getComponent(t) { return (t && t.name === 'Label' && label != null) ? { string: label } : null; },
  };
}
// Install the hook into a fresh global and invoke the probe, returning its facts.
function runHookInPage(globalObj, descriptor) {
  const hook = buildProbeSceneHook(descriptor);
  const fn = new Function('globalThis', hook + '; return globalThis.__avProbeScene ? globalThis.__avProbeScene() : null;');
  return fn(globalObj);
}

// ---------------------------------------------------------------------------
// READ-ONLY guarantee — the probe hook must never invoke or send anything.
// ---------------------------------------------------------------------------
test('probe hook is strictly read-only (no click/emit/send)', () => {
  const hook = buildProbeSceneHook({ gameId: 'vgmn_221' });
  assert.ok(!/emitEvents/.test(hook), 'must not fire cc.Component.EventHandler.emitEvents');
  assert.ok(!/\.emit\(/.test(hook), "must not emit a node event (no node.emit('click'))");
  assert.ok(!/__wsoSendFrame|\.send\(/.test(hook), 'must not send any WebSocket frame');
  assert.match(hook, /__avProbeScene/);
});

test('probe hook falls back to the baked Aviator gameId when no descriptor is given', () => {
  const hook = buildProbeSceneHook({});
  assert.ok(hook.includes(JSON.stringify(KNOWN_AVIATOR_GAME_ID)), 'bakes the known Aviator tile name');
});

// ---------------------------------------------------------------------------
// Discrimination — lobby (kicked out) vs in-game, plus the reconnect banner.
// ---------------------------------------------------------------------------
test('IN-LOBBY: NewLobby scene with an ACTIVE Aviator tile → lobbyTileActive true', () => {
  const tile = node('vgmn_221', { active: true });
  const scene = node('NewLobby', { children: [node('Canvas', { children: [tile] })] });
  const g = makeCocos(scene);
  const r = runHookInPage(g, { gameId: 'vgmn_221' });
  assert.equal(r.ok, true);
  assert.equal(r.sceneName, 'NewLobby');
  assert.equal(r.lobbyTilePresent, true);
  assert.equal(r.lobbyTileActive, true, 'the lobby tile is on screen → we were kicked out');
  assert.equal(r.reconnectBanner, false);
});

test('RECONNECTING: an ACTIVE "Đang kết nối lại" cc.Label is detected as the reconnect banner', () => {
  const banner = node('Msg', { active: true, label: 'Đang kết nối lại' });
  const scene = node('NewLobby', { children: [node('Popup', { children: [banner] })] });
  const g = makeCocos(scene);
  const r = runHookInPage(g, { gameId: 'vgmn_221' });
  assert.equal(r.reconnectBanner, true, 'the game\'s own disconnect banner is the authoritative signal');
});

test('RECONNECTING: the exact screenshot text "Bị mất kết nối tới máy chủ" is detected', () => {
  const banner = node('Msg', { active: true, label: 'Bị mất kết nối tới máy chủ' });
  const scene = node('NewLobby', { children: [banner] });
  const r = runHookInPage(makeCocos(scene), { gameId: 'vgmn_221' });
  assert.equal(r.reconnectBanner, true);
});

test('an INACTIVE banner label is ignored (only on-screen banners count)', () => {
  const banner = node('Msg', { active: false, label: 'Đang kết nối lại' });
  const scene = node('Game', { children: [banner] });
  const r = runHookInPage(makeCocos(scene), { gameId: 'vgmn_221' });
  assert.equal(r.reconnectBanner, false, 'a hidden banner is not a live disconnect');
});

test('IN-GAME: Aviator scene with no lobby tile and no banner → all-clear', () => {
  const scene = node('Game', { children: [node('AviatorRoot', { children: [node('Odd', { label: '2.50x' })] })] });
  const r = runHookInPage(makeCocos(scene), { gameId: 'vgmn_221' });
  assert.equal(r.ok, true);
  assert.equal(r.sceneName, 'Game');
  assert.equal(r.lobbyTilePresent, false);
  assert.equal(r.lobbyTileActive, false);
  assert.equal(r.reconnectBanner, false);
});

test('tile present but INACTIVE (lobby in tree yet hidden behind the game) → not kicked out', () => {
  const tile = node('vgmn_221', { active: false });
  const scene = node('Main', { children: [node('NewLobby', { active: false, children: [tile] })] });
  const r = runHookInPage(makeCocos(scene), { gameId: 'vgmn_221' });
  assert.equal(r.lobbyTilePresent, true, 'the node still exists in the tree');
  assert.equal(r.lobbyTileActive, false, 'but it is not on screen → still in game');
});

test('no cc / no director → reports unavailable, never throws', () => {
  assert.equal(runHookInPage({}, { gameId: 'vgmn_221' }).ccAvailable, false);
  assert.equal(runHookInPage({ cc: { find: () => null } }, { gameId: 'vgmn_221' }).directorAvailable, false);
});

// ---------------------------------------------------------------------------
// runner — normalizes page facts, surfaces diag, and fails safe with no client.
// ---------------------------------------------------------------------------
test('runProbeAviatorSceneViaSite normalizes facts and emits a diag event', async () => {
  const fakeClient = { Runtime: { evaluate: async (opts) => (
    String(opts.expression).includes('__avProbeScene ?')
      ? { result: { value: { ok: true, ccAvailable: true, directorAvailable: true, sceneName: 'NewLobby', lobbyTilePresent: true, lobbyTileActive: true, reconnectBanner: true, nodesScanned: 42, resolvedBy: 'path' } } }
      : { result: {} }
  ) } };
  let diagEvent = null;
  const res = await runProbeAviatorSceneViaSite(fakeClient, undefined, { gameId: 'vgmn_221' }, (f) => { diagEvent = f; });
  assert.equal(res.ok, true);
  assert.deepEqual(res.facts, { ok: true, ccAvailable: true, directorAvailable: true, sceneName: 'NewLobby', lobbyTilePresent: true, lobbyTileActive: true, reconnectBanner: true, nodesScanned: 42, resolvedBy: 'path' });
  assert.equal(diagEvent.event, 'COCOS_SCENE_PROBE');
});

test('runProbeAviatorSceneViaSite fails safe when the client is gone', async () => {
  const res = await runProbeAviatorSceneViaSite(null, undefined, { gameId: 'vgmn_221' });
  assert.ok(res.error, 'no client → structured error, no throw');
});

test('reconnect banner keyword set covers the game\'s Vietnamese + generic strings', () => {
  for (const kw of ['kết nối lại', 'mất kết nối']) assert.ok(RECONNECT_BANNER_KEYWORDS.includes(kw));
});
