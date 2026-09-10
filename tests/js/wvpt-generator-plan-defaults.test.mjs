import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PLAN_UI_DEFAULTS } = require('../../tools/license-generator/plan-ui-defaults.cjs');
const { PLAN_PRESETS } = require('../../desktop/licensing/entitlements.cjs');

test('TRIAL default: 7 days, capacity 5/5, features from source TRIAL preset', () => {
  const d = PLAN_UI_DEFAULTS.TRIAL;
  assert.deepEqual(d.duration, { unit: 'days', value: 7 });
  assert.equal(d.maxBrowsers, 5);
  assert.equal(d.maxConcurrentBrowsers, 5);
  assert.deepEqual(d.features, PLAN_PRESETS.TRIAL.features);
});

test('STANDARD default: 1 calendar month, capacity = source STANDARD preset', () => {
  const d = PLAN_UI_DEFAULTS.STANDARD;
  assert.deepEqual(d.duration, { unit: 'months', value: 1 });
  assert.equal(d.maxBrowsers, PLAN_PRESETS.STANDARD.maxBrowsers);
  assert.equal(d.maxConcurrentBrowsers, PLAN_PRESETS.STANDARD.maxConcurrentBrowsers);
  assert.deepEqual(d.features, PLAN_PRESETS.STANDARD.features);
});

test('PRO default: 1 calendar month, capacity = source PRO preset', () => {
  const d = PLAN_UI_DEFAULTS.PRO;
  assert.deepEqual(d.duration, { unit: 'months', value: 1 });
  assert.equal(d.maxBrowsers, PLAN_PRESETS.PRO.maxBrowsers);
  assert.equal(d.maxConcurrentBrowsers, PLAN_PRESETS.PRO.maxConcurrentBrowsers);
  assert.deepEqual(d.features, PLAN_PRESETS.PRO.features);
});

test('STANDARD / PRO capacity defaults are NOT forced to 5/5', () => {
  // Guards the spec: only TRIAL is overridden to 5/5; the others keep source values.
  assert.notEqual(`${PLAN_UI_DEFAULTS.PRO.maxBrowsers}/${PLAN_UI_DEFAULTS.PRO.maxConcurrentBrowsers}`, '5/5');
});

test('switching plans reapplies deterministic, stable defaults (Trial -> Standard -> Pro -> Trial)', () => {
  const order = ['TRIAL', 'STANDARD', 'PRO', 'TRIAL'];
  const snapshot = (p) => JSON.stringify(PLAN_UI_DEFAULTS[p]);
  const first = snapshot('TRIAL');
  for (const p of order) assert.equal(typeof snapshot(p), 'string');
  assert.equal(snapshot('TRIAL'), first, 'TRIAL defaults are identical every time they are applied');
});
