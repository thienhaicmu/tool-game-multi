// "game lag + không click được" (2026-10-03): a quiet table (no seat/card push for 20s) read as MẤT DỮ LIỆU — the bar
// locked its buttons — and every 30s the capture was re-hooked by registering its WS listeners AGAIN, so each frame
// was handled N times and the lag kept growing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HostTableCoordinator } = require('../../desktop/protocol/phom/host-table-coordinator.cjs');
const gh = require('../../desktop/protocol/phom/game-header.cjs');

test('the heartbeat acks of the bound game socket keep the browser live — a quiet table never reads MẤT DỮ LIỆU', () => {
  const coord = new HostTableCoordinator({ now: Date.now, environmentAuthorized: () => true, sessionId: 't', profiles: [{ id: 'B1', uid: '1_1', send: async () => ({ ok: true }) }] });
  const feed = (raw, now, targetId = 'T1') => coord.ingest('B1', { raw, direction: 'recv', targetId, url: 'wss://sim', now });
  feed('[5,{"uid":"1_1","As":{"gold":1},"cmd":100,"id":0}]', 1000);     // binds the socket
  feed('[6,1,1169]', 60000);                                              // only heartbeats for a minute
  assert.equal(coord.manualBrowserSnapshot()[0].lastFrameAt, 60000);
  feed('[6,1,1170]', 90000, 'OTHER');                                     // another socket proves nothing
  assert.equal(coord.manualBrowserSnapshot()[0].lastFrameAt, 60000);
  coord.stop();
});

test('stale really locks the bar — which is why liveness must not depend on table pushes', () => {
  const s = gh.deriveHeaderState({ opened: true, inGame: false, dataStale: true, staleSec: 45 });
  assert.equal(s.canAct, false);
});

test('a re-hook re-enables Network but never registers the WS listeners twice on one client', () => {
  // the capture feature (behaviour incl. "subscribed once per client": phom-features.test.mjs)
  const fn = readFileSync(new URL('../../desktop/phom/features/capture.cjs', import.meta.url), 'utf8');
  const guard = fn.indexOf('if (client.__phomCaptureAttached) return;');
  assert.ok(guard > fn.indexOf('Network.enable(') && guard < fn.indexOf('Network.webSocketFrameReceived('));
  assert.match(fn, /Network\.webSocketFrameReceived\(\(p, sid\) => capture\.onWebSocketFrameReceived\(client\.__phomCaptureTid, p, sid\)\)/);
});
