import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const frameClassify = require('../../desktop/protocol/frame-classify.cjs');
const aviator = require('../../desktop/protocol/aviator.cjs');

// §19.2 — aviator.cjs stays API-compatible after the extraction.
test('aviator.cjs still exports the classifier + constants (re-exported)', () => {
  assert.equal(typeof aviator.classifyFrame, 'function');
  assert.equal(typeof aviator.RoundTracker, 'function');
  assert.ok(aviator.CMD && aviator.CMD_TYPE && aviator.ROUND_STATE);
  // Re-exports must be the SAME objects/functions as the pure module.
  assert.equal(aviator.classifyFrame, frameClassify.classifyFrame);
  assert.equal(aviator.CMD, frameClassify.CMD);
  assert.equal(aviator.CMD_TYPE, frameClassify.CMD_TYPE);
  assert.equal(aviator.ROUND_STATE, frameClassify.ROUND_STATE);
});

// §19.1 — classifier OUTPUT is byte-for-byte unchanged after extraction.
test('classifier output is unchanged for the confirmed command set', () => {
  const c = frameClassify.classifyFrame;
  assert.equal(c('{"cmd":100005,"iOE":true,"sid":2986908}').type, 'ROUND_OPEN');
  assert.equal(c('{"cmd":100006,"sid":1}').type, 'ROUND_LOCK');
  assert.equal(c('{"cmd":100007,"sid":1,"odd":1.87}').type, 'ROUND_END');
  assert.equal(c('[5,{"cmd":100008,"sid":1}]').type, 'ROUND_OPEN');
  assert.equal(c('{"cmd":100009,"odd":1.55,"sid":1}').type, 'ODD_UPDATE');
  assert.equal(c('{"cmd":100002,"b":5000,"sid":1,"aid":1,"eid":1}').type, 'BET');
  assert.equal(c('{"cmd":100003,"sid":1,"aid":1,"eid":1}').type, 'CASHOUT');
  assert.equal(c('{"cmd":100000}').type, 'ENTER');
  // unknown preserved, not dropped
  const u = c('{"cmd":999999,"x":1}');
  assert.equal(u.type, 'UNKNOWN'); assert.equal(u.known, false); assert.equal(u.cmd, 999999);
  // jackpot extracted verbatim
  assert.equal(c('{"cmd":100009,"odd":2,"eI":{"jp":1234.5}}').jp, 1234.5);
  // malformed is safe
  assert.equal(c('not json').type, 'UNKNOWN');
});

// §2 — the extracted module is PURE: no require of any action/send-bearing module.
test('frame-classify.cjs imports NOTHING (pure, no action dependency)', () => {
  const src = readFileSync(path.join(ROOT, 'desktop/protocol/frame-classify.cjs'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, [], 'frame-classify.cjs must have no requires');
  // and no send/action behaviour (scan CODE only — strip // line comments so our own
  // "no sendRaw/sendProtocol" documentation is not a false positive).
  const code = src.replace(/\/\/[^\n]*/g, '');
  for (const bad of ['sendRaw(', 'sendProtocol(', '.send(', 'new AutoRunner', 'new Harness', 'wsReplay']) {
    assert.ok(!code.includes(bad), `frame-classify.cjs code must not use ${bad}`);
  }
});
