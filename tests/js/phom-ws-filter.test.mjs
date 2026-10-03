// "chọn lọc data, request WS — loại bỏ dư thừa tránh làm ngẵn tool, lag game" (2026-10-03). Measured on the three
// reference captures: 3356 of 4456 frames (≈1.6 of 1.8 MB) are other games' broadcasts, socket.io, heartbeats —
// now dropped at the capture. And no captured frame is retained any more (the store had no eviction).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isPhomRelevant } = require('../../desktop/protocol/phom/phom-ws-filter.cjs');
const { CaptureCorrelator } = require('../../desktop/cdp/capture.cjs');

test('every Phỏm frame the tool uses passes', () => {
  for (const [raw, dir] of [
    ['[6,"Simms","channelPlugin",{"cmd":313,"gid":8,"aid":1,"b":20000}]', 'send'],
    ['[5,{"ri":{"b":20000,"gid":8,"rid":7907065,"uC":3,"zn":"Simms","rn":"Phom"},"cmd":313}]', 'recv'],
    ['[5,{"rs":[{"b":1000,"gid":8,"rid":141,"zn":"Simms","rn":"Phom#2"}]}]', 'recv'],
    ['[5,{"b":20000,"ps":[{"uid":"1_1","sit":0,"C":true}],"cmd":202}]', 'recv'],
    ['[5,{"p":{"uid":"1_3","dn":"x"},"t":1,"cmd":200}]', 'recv'],
    ['[5,{"As":{"gold":1,"guaranteed_gold":0},"cmd":317}]', 'recv'],
    ['[5,{"uid":"1_1","As":{"gold":1},"dn":"a","cmd":100,"id":0}]', 'recv'],
    ['[3,false,103,7907065,"Sai mật khẩu phòng"]', 'recv'],
    ['[4,true,2,-1,2,"Bạn bị kick vì không sẵn sàng"]', 'recv'],
    ['[8,"Simms",7907180,"",8]', 'send'],
    ['[5,"Simms",-1,{"cmd":5}]', 'send'],
    ['[5,{"cs":[1,2,3],"lpi":["1_1"],"cmd":850}]', 'recv'],
    ['[5,{"fP":{"uid":"1_1","dCs":49},"tP":{"uid":"1_2"},"cmd":851}]', 'recv'],
    ['[6,1,1169]', 'recv'], // heartbeat ACK = liveness
  ]) assert.equal(isPhomRelevant(raw, dir), true, raw);
});

test('the noise is dropped', () => {
  for (const [raw, dir] of [
    ['[5,{"cmd":10004,"x":1}]', 'recv'], ['[5,{"cmd":10003}]', 'recv'], ['[5,{"cmd":10000}]', 'recv'], ['[5,{"cmd":10,"a":1}]', 'recv'], ['[5,{"cmd":1015}]', 'recv'],
    ['[5,{"gid":3,"cmd":2007}]', 'recv'],          // another game
    ['["7","Simms","1",1169]', 'send'], ['["7","MiniGame","1",1650]', 'send'],
    ['2', 'send'], ['3', 'recv'], ['451-["2","b0"]', 'recv'], ['BEtEXFISXBdVBQVQAAgCAhtSAwRV', 'recv'], [null, 'recv'],
  ]) assert.equal(isPhomRelevant(raw, dir), false, String(raw));
});

test('the capture drops a filtered frame before building it, and keeps none when asked not to', () => {
  const seen = [];
  const cap = new CaptureCorrelator({ keepWsFrames: false, wsFilter: isPhomRelevant });
  cap.on('request', (r) => { if (r.wsDirection) seen.push(r.body.raw); }); // frames only (not the socket-created event)
  cap.onWebSocketCreated('T', { requestId: 'w', url: 'wss://g/websocket' }, null);
  const frame = (payloadData, opcode = 1) => ({ requestId: 'w', response: { opcode, payloadData } });
  cap.onWebSocketFrameReceived('T', frame('[5,{"cmd":10004}]'), null);
  cap.onWebSocketFrameReceived('T', frame('[6,1,5]'), null);
  cap.onWebSocketFrameReceived('T', frame('AAEC', 2), null);
  cap.onWebSocketFrameSent('T', frame('["7","Simms","1",3]'), null);
  assert.deepEqual(seen, ['[6,1,5]']);
  assert.equal(cap._store.size, 1, 'no frame retained — only the open socket itself');
  cap.onWebSocketClosed('T', { requestId: 'w' }, null);
  assert.equal(cap._store.size, 0, 'and that goes with the socket');
  const plain = new CaptureCorrelator({});
  plain.onWebSocketCreated('T', { requestId: 'w', url: 'wss://g' }, null);
  plain.onWebSocketFrameReceived('T', frame('[5,{"cmd":10004}]'), null);
  assert.equal(plain._store.size, 2, 'other products keep their behaviour (the socket + its frame)');
});

test('main wires the filter into the capture', () => {
  const main = readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /new CaptureCorrelator\(\{ resolveClient: \(tid\) => resolveTargetClient\(tid\), keepWsFrames: false, wsFilter: isPhomRelevant \}\)/);
});
