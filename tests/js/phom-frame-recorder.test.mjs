// TEST D — the frame recorder captures what the GAME CLIENT itself sends/receives when a player clicks a table
// by hand, so the tool's table entry can follow the real protocol instead of a guess. Passive, bounded, redacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createFrameRecorder, redactFrame } = require('../../desktop/protocol/phom/frame-recorder.cjs');

test('records only between START and STOP, and only the chosen browser', () => {
  let t = 1000; const rec = createFrameRecorder({ now: () => t });
  assert.equal(rec.record('B2', { raw: '[5,{"cmd":300,"rs":[]}]', direction: 'recv' }), false, 'idle → nothing stored');
  rec.start({ runIds: ['B2'], label: 'hhhau1003 click bàn 100' });
  t = 1100; rec.record('B2', { raw: '[3,"Simms",141,""]', direction: 'send' });
  rec.record('B1', { raw: '[3,"Simms",999,""]', direction: 'send' }); // another browser: ignored
  t = 1250; rec.record('B2', { raw: JSON.stringify([5, { b: 100, ps: [{ uid: '1_3', sit: 0 }], cmd: 202 }]), direction: 'recv' });
  const out = rec.stop();
  assert.equal(rec.isRecording(), false);
  assert.equal(out.frameCount, 2);
  assert.equal(out.label, 'hhhau1003 click bàn 100');
  assert.deepEqual(out.frames.map((f) => f.t), [100, 250]);
  assert.match(out.frames[0].summary, /→ GỬI JOIN_REQUEST .*room=141/);
  assert.match(out.frames[1].summary, /← NHẬN TABLE_STATE .*ps=1 b=100/);
});

test('records every browser when none is chosen', () => {
  const rec = createFrameRecorder();
  rec.start({});
  rec.record('B1', { raw: '[4,"Simms",-1]', direction: 'send' });
  rec.record('B3', { raw: '[4,"Simms",-1]', direction: 'send' });
  assert.equal(rec.stop().frameCount, 2);
});

test('the channel list is summarised with every row the server sent', () => {
  const rec = createFrameRecorder(); rec.start({});
  rec.record('B1', { raw: JSON.stringify([5, { rs: [{ rid: 141, b: 100, uC: 87, Mu: 4 }, { rid: 320872, b: 100, uC: 1, Mu: 4 }], cmd: 300 }]), direction: 'recv' });
  const s = rec.stop().frames[0].summary;
  assert.match(s, /CHANNEL_LIST .*rs=2/);
  assert.match(s, /\[rid 141 b 100 87\/4\]/);
  assert.match(s, /\[rid 320872 b 100 1\/4\]/);
});

test('secrets are removed before a frame is stored', () => {
  const join = JSON.parse(redactFrame('[3,"Simms",141,"hunter2"]').raw);
  assert.equal(join[2], 141, 'the room id is kept');
  assert.equal(join[3], '[redacted]', 'the positional join password is not');
  const obj = JSON.parse(redactFrame(JSON.stringify([5, { uid: '1_3', dn: 'hhhau1003', token: 'abc', sessionId: 'x', As: { gold: 5 }, nested: { password: 'p' } }])).raw);
  assert.equal(obj[1].uid, '1_3');
  assert.equal(obj[1].dn, 'hhhau1003', 'names are kept on purpose — they show who sat where');
  assert.equal(obj[1].token, '[redacted]');
  assert.equal(obj[1].sessionId, '[redacted]');
  assert.equal(obj[1].nested.password, '[redacted]');
  assert.equal(redactFrame('not json at all').raw, null, 'a non-protocol frame is kept only as a length marker');
});

test('bounded: a forgotten recording cannot grow without limit', () => {
  const rec = createFrameRecorder({ maxFrames: 3 }); rec.start({});
  for (let i = 0; i < 10; i++) rec.record('B1', { raw: '[4,"Simms",-1]', direction: 'send' });
  const out = rec.stop();
  assert.equal(out.frameCount, 3);
  assert.equal(out.dropped, 7);
});

// Wiring: the recorder sees frames BEFORE routing (so a hand click is captured without a session), is reachable
// from the Tool's ⋯ menu, and writes both a machine file and a readable one.
import { readFileSync } from 'node:fs';
const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
test('Test D is wired: capture hook → recorder → IPC → Tool menu', () => {
  const main = read('desktop/phom-main.cjs'); const preload = read('desktop/phom-preload.cjs'); const ui = read('ui-phom/phom-qa.js');
  const hook = main.slice(main.indexOf("capture.on('request'"), main.indexOf("capture.on('request'") + 1500);
  assert.ok(hook.indexOf('frameRecorder.record(') < hook.indexOf('phomSessions.routeFrame('), 'recorded before routing');
  for (const ch of ['phom:frames-record-start', 'phom:frames-record-stop', 'phom:frames-record-status', 'phom:frames-open-folder']) {
    assert.ok(main.includes("ipcMain.handle('" + ch + "'"), ch + ' handled in main'); assert.ok(preload.includes(ch), ch + ' exposed in preload');
  }
  assert.match(main, /'phom-captures'/);
  assert.match(main, /fs\.writeFileSync\(base \+ '\.json'/);
  assert.match(main, /fs\.writeFileSync\(base \+ '\.txt'/);
  assert.match(ui, /'Ghi gói \(Test D\)'/);
  assert.match(ui, /api\.framesRecordStart\(/);
  assert.match(ui, /api\.framesRecordStop\(\)/);
});
