// The game's own "Tự sẵn sàng" (363 aRd:"true") never readies an account (ported from meta-game 2026-10-10).
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rewriteAutoReady, autoReadyGuardScript, applyAutoReadyGuard } = require('../../desktop/protocol/phom/auto-ready-guard.cjs');
const { armExpression } = require('../../desktop/protocol/phom/phom-probe-guard.cjs');

const ready = (v) => JSON.stringify([6, 'Simms', 'channelPlugin', { cmd: 363, aRd: v }]);

test('the page\'s 363 aRd "true" goes out as "false"; everything else is untouched', () => {
  assert.equal(rewriteAutoReady(ready('true'), 'Simms'), ready('false'));
  assert.equal(rewriteAutoReady(ready(true), 'Simms'), ready('false'));
  for (const same of [ready('false'), JSON.stringify([6, 'Simms', 'channelPlugin', { cmd: 5 }]), JSON.stringify([6, 'Other', 'channelPlugin', { cmd: 363, aRd: 'true' }]), '[3,"Simms",12,""]', 'not json [', 42]) {
    assert.equal(rewriteAutoReady(same, 'Simms'), same);
  }
});

test('in the page: installed once, chained with the TẠO probe guard in either order', () => {
  for (const order of [['guard', 'probe'], ['probe', 'guard']]) {
    const g = {};
    const ctx = vm.createContext({ globalThis: g, Date, JSON, Object, Array });
    for (const s of order) vm.runInContext(s === 'guard' ? autoReadyGuardScript() : armExpression(), ctx);
    vm.runInContext(autoReadyGuardScript(), ctx); // a second install changes nothing
    assert.equal(g.__wsoOutFilter(ready('true')), ready('false'), order.join(' → '));
    assert.equal(g.__wsoOutFilter('[3,"Simms",77,""]'), JSON.stringify([3, 'Simms', 77, '​']), 'the probe guard still works');
    assert.equal(g.__phomNoAutoReady.rewritten, 1);
  }
});

test('apply: every later document of a page + the current one; a worker gets the current one', async () => {
  const calls = [];
  const page = { Page: { addScriptToEvaluateOnNewDocument: async () => { calls.push('newDoc'); return { identifier: '1' }; } }, Runtime: { evaluate: async () => { calls.push('eval'); return {}; } } };
  assert.equal((await applyAutoReadyGuard(page)).ok, true);
  await applyAutoReadyGuard(page);
  assert.deepEqual(calls, ['newDoc', 'eval', 'eval'], 'the new-document script is registered once per client');
  const worker = { Runtime: { evaluate: async () => ({}) } };
  assert.equal((await applyAutoReadyGuard(worker)).ok, true);
  const main = require('node:fs').readFileSync(new URL('../../desktop/phom-main.cjs', import.meta.url), 'utf8');
  assert.match(main, /createWsHookFeature\([^\n]*\n\s*createNoAutoReadyFeature\(\{ apply: applyAutoReadyGuard \}\)/);
});
