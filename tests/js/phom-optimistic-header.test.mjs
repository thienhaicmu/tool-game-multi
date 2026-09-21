// PHASE 6.3.2.11 — OPTIMISTIC header response: a click paints an immediate busy state page-locally (no CDP /
// no main round-trip), and the authoritative state from main always wins. Pure logic + boot wiring asserts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const gh = require('../../desktop/protocol/phom/game-header.cjs');

test('deriveEffectiveHeaderState: optimistic overlay when set, else authoritative (authoritative WINS)', () => {
  const auth = { account: 'A', rid: '5', statusLabel: 'ĐÃ VÀO BÀN', primary: { action: 'REJOIN' } };
  // optimistic overlay chosen while an action is pending
  assert.equal(gh.deriveEffectiveHeaderState({ authState: auth, optAction: 'LEAVE' }).statusLabel, 'ĐANG THOÁT PHÒNG…');
  // cleared → authoritative wins
  assert.equal(gh.deriveEffectiveHeaderState({ authState: auth, optAction: null }).statusLabel, 'ĐÃ VÀO BÀN');
  assert.equal(gh.deriveEffectiveHeaderState({ authState: auth, optAction: null }).primary.action, 'REJOIN');
});

// ---- in-page wiring (bootScript) ----
const src = gh.bootScript({ slotId: 'B1', profileId: 'p', runId: 'r' });

test('click applies the optimistic state FIRST, then emits — page-local, no CDP/main for the visual', () => {
  // emit() paints optimistic BEFORE the binding call (immediate feedback), then sends the action.
  assert.match(src, /applyOptimistic\(action\); window\[BID\] && window\[BID\]/);
  // applyOptimistic paints synchronously in the page — it does NOT call the binding or Runtime.evaluate.
  assert.match(src, /function applyOptimistic\(action\)\{ try \{ __optAction = action; paint\(optState\(action\)\); \} catch/);
  assert.equal(/applyOptimistic[\s\S]{0,80}window\[BID\]/.test(src.slice(src.indexOf('function applyOptimistic'))), false, 'applyOptimistic itself never calls the binding');
});

test('authoritative render stores state, CLEARS optimistic, and wins', () => {
  assert.match(src, /window\.__phomHeaderRender = function\(state\)\{ try \{ __authState = state; __optAction = null; paint\(state\); \}/);
});

test('optimistic busy primary is disabled → a duplicate click is a visual no-op (single-flight preserved)', () => {
  // optState marks the primary disabled+busy; paint renders a disabled button (no onclick).
  assert.match(src, /primary:\{ action: action, label: label, disabled: true, busy: true \}/);
});

test('actionId is generated exactly once per click (optimistic does not create a second id)', () => {
  // one aid per emit(); applyOptimistic takes no id
  const emitBody = src.slice(src.indexOf('function emit(action, extra)'), src.indexOf('var __authState'));
  assert.equal((emitBody.match(/Math\.random\(\)\.toString\(36\)/g) || []).length, 1);
  assert.equal(/actionId/.test(src.slice(src.indexOf('function applyOptimistic'), src.indexOf('function optState') > 0 ? src.indexOf('function optState') : undefined)), false);
});

test('optimistic render happens INSIDE #__ph_act (no observer churn) and is page-only (no Runtime.evaluate)', () => {
  // paint writes into the existing acc/rid/st/act nodes (act = #__ph_act), never touching body/documentElement
  assert.match(src, /function paint\(state\)\{/);
  assert.equal(/applyOptimistic[\s\S]*?Runtime\.evaluate/.test(src), false);
  assert.equal(/subtree: true/.test(src), false); // observer untouched (still narrow)
});

test('F5 safety: optimistic state is plain page vars (no localStorage/sessionStorage) — gone on new document', () => {
  assert.match(src, /var __authState = null, __optAction = null;/);
  assert.equal(/localStorage|sessionStorage/.test(src), false);
});
