import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { wsKeyOf, isAviatorEvidence, isOwningClose } = require('../../desktop/browser-run/aviator-socket-owner.cjs');
const { classifyFrame } = require('../../desktop/protocol/frame-classify.cjs');

// Socket.io-wrapped real frames observed live on this game platform.
const AVIATOR_ODD = '[5,{"ps":[],"cmd":100009,"odd":1.69,"sid":3102105}]';
const AVIATOR_JACKPOT = '[5,{"eI":{"jp":123456},"cmd":100008}]';
const LOBBY_ROOMINFO = '[5,{"ri":{"gid":8,"rn":"Phom#4","zn":"Simms"},"cmd":100}]';
const LOBBY_TICK = '[5,{"errC":10005,"gid":10889,"cmd":10004}]';
const SIDE_PING = '[5,{"foo":1}]';

test('classified Aviator server evidence is recognised; lobby/side chatter is not', () => {
  assert.equal(isAviatorEvidence(classifyFrame(AVIATOR_ODD)), true);      // cmd 100009
  assert.equal(isAviatorEvidence(classifyFrame(AVIATOR_JACKPOT)), true);  // eI.jp
  assert.equal(isAviatorEvidence(classifyFrame(LOBBY_ROOMINFO)), false);  // portal room info
  assert.equal(isAviatorEvidence(classifyFrame(LOBBY_TICK)), false);      // lobby odds tick (cmd 10004)
  assert.equal(isAviatorEvidence(classifyFrame(SIDE_PING)), false);       // unclassified side frame
  assert.equal(isAviatorEvidence(classifyFrame('not json')), false);
  assert.equal(isAviatorEvidence(null), false);
});

test('wsKeyOf is target:session:request and distinguishes reload generations', () => {
  assert.equal(wsKeyOf({ targetId: 'T1', cdpSessionId: 'S1', cdpRequestId: '9' }), 'T1:S1:9');
  // Same cdp requestId reused after a reload on a NEW target ⇒ different key.
  assert.notEqual(
    wsKeyOf({ targetId: 'T-old', cdpRequestId: '9' }),
    wsKeyOf({ targetId: 'T-new', cdpRequestId: '9' }),
  );
});

// The exact production sequence that used to cause a false recovery.
test('only the OWNING Aviator socket close signals context loss; lobby/side closes do not', () => {
  // Simulate the run's binding: an Aviator-evidence recv on the game socket binds the owner.
  const gameSock = { targetId: 'T', cdpSessionId: 'Sg', cdpRequestId: 'game' };
  const lobbySock = { targetId: 'T', cdpSessionId: 'Sl', cdpRequestId: 'lobby' };
  const sideSock = { targetId: 'T', cdpSessionId: 'Sx', cdpRequestId: 'side' };

  let ownerKey = null;
  // game socket delivers classified Aviator odds ⇒ binds owner
  if (isAviatorEvidence(classifyFrame(AVIATOR_ODD))) ownerKey = wsKeyOf(gameSock);
  // lobby socket delivers portal room info ⇒ does NOT bind
  if (isAviatorEvidence(classifyFrame(LOBBY_ROOMINFO))) ownerKey = wsKeyOf(lobbySock);
  assert.equal(ownerKey, 'T:Sg:game', 'owner is the Aviator game socket, not the lobby');

  // The observed false-positive: portal LOBBY socket closes while Aviator still healthy.
  assert.equal(isOwningClose(ownerKey, lobbySock), false, 'lobby close must NOT be treated as Aviator loss');
  // Side channel (gemsdatapi/millicast) closes.
  assert.equal(isOwningClose(ownerKey, sideSock), false, 'side-channel close must NOT be treated as Aviator loss');
  // The real signal: the owning Aviator socket closes.
  assert.equal(isOwningClose(ownerKey, gameSock), true, 'owning Aviator socket close IS context loss');
});

test('no owning socket bound yet ⇒ no close is treated as Aviator loss', () => {
  assert.equal(isOwningClose(null, { targetId: 'T', cdpRequestId: '1' }), false);
});

test('jackpot-only evidence also binds the owning socket', () => {
  const s = { targetId: 'T', cdpSessionId: 'S', cdpRequestId: 'jp' };
  let ownerKey = null;
  if (isAviatorEvidence(classifyFrame(AVIATOR_JACKPOT))) ownerKey = wsKeyOf(s);
  assert.equal(ownerKey, 'T:S:jp');
  assert.equal(isOwningClose(ownerKey, s), true);
});
