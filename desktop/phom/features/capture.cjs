'use strict';

// ---------------------------------------------------------------------------
// FEATURE capture — the game's WebSocket frames reach the tool through CDP Network events on each target's client.
//  attach: enable Network (small buffers: the tool never reads a body) and subscribe the four WebSocket events ONCE
//          per client (a re-hook only re-enables Network — re-subscribing made each frame be handled N times).
//  push:   a browser whose frames stopped arriving for STALE_MS lost its hook (page reload / target swap): re-enable
//          capture and re-inject the send hook on its CURRENT targets — at most once per REHOOK_EVERY_MS per browser.
//
// deps: { capture (CaptureCorrelator), targetsOf(runId) → [{ targetId, client }], injectSendHook(client), log, now }
// ---------------------------------------------------------------------------

const STALE_MS = 20000;
const REHOOK_EVERY_MS = 30000;
const NETWORK_BUFFERS = Object.freeze({ maxTotalBufferSize: 1048576, maxResourceBufferSize: 262144, maxPostDataSize: 0 });

function hook(capture, client, targetId) {
  const { Network } = client;
  client.__phomCaptureTid = targetId; // the listeners read the CURRENT target of this client
  Network.enable({ ...NETWORK_BUFFERS }).catch(() => { Network.enable().catch(() => {}); });
  if (client.__phomCaptureAttached) return;
  client.__phomCaptureAttached = true;
  Network.webSocketCreated((p, sid) => capture.onWebSocketCreated(client.__phomCaptureTid, p, sid));
  Network.webSocketFrameSent((p, sid) => capture.onWebSocketFrameSent(client.__phomCaptureTid, p, sid));
  Network.webSocketFrameReceived((p, sid) => capture.onWebSocketFrameReceived(client.__phomCaptureTid, p, sid));
  Network.webSocketClosed((p, sid) => capture.onWebSocketClosed(client.__phomCaptureTid, p, sid));
}

function createCaptureFeature({ capture, targetsOf, injectSendHook, log = () => {}, now = () => Date.now() }) {
  return {
    id: 'capture',
    attach({ client, target }) { hook(capture, client, target.cdpTargetId); },
    // browser = this run's manual snapshot row ({ lastFrameAt }); session.capture.lastRehookAt throttles
    push({ run, session, browser }) {
      if (!run || run.closed || run.status === 'CLOSED' || !browser || browser.lastFrameAt == null) return;
      const t = now();
      if (t - Number(browser.lastFrameAt) <= STALE_MS) return;
      if (session.capture.lastRehookAt && t - session.capture.lastRehookAt < REHOOK_EVERY_MS) return;
      for (const { targetId, client } of targetsOf(run.id)) {
        if (!client) continue;
        session.capture.lastRehookAt = t;
        log('capture-rehook', { runId: String(run.id), targetId, staleSec: Math.round((t - Number(browser.lastFrameAt)) / 1000) });
        try { hook(capture, client, targetId); } catch { /* best effort */ }
        try { Promise.resolve(injectSendHook(client)).catch(() => {}); } catch { /* best effort */ }
      }
    },
  };
}

module.exports = { createCaptureFeature, STALE_MS, REHOOK_EVERY_MS, NETWORK_BUFFERS };
