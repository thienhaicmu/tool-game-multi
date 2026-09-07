import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InAppRuntime } = require('../../desktop/browser/inapp-runtime.cjs');

// §5 / §15-16 — partition namespaces keep Control and Analytics (and B1/B2) apart.
test('Analytics uses persist:analytics-<browserId>', () => {
  const rt = new InAppRuntime({ getHostWindow: () => null, partitionPrefix: 'persist:analytics-' });
  assert.equal(rt.partitionFor('B-0001'), 'persist:analytics-B-0001');
  assert.equal(rt.partitionFor('B-0002'), 'persist:analytics-B-0002');
});

test('Control default partition remains persist:aviator-<browserId>', () => {
  const control = new InAppRuntime({ getHostWindow: () => null }); // no prefix override
  assert.equal(control.partitionFor('B-0001'), 'persist:aviator-B-0001');
});

test('Control B-0001 partition != Analytics B-0001 partition', () => {
  const control = new InAppRuntime({ getHostWindow: () => null });
  const analytics = new InAppRuntime({ getHostWindow: () => null, partitionPrefix: 'persist:analytics-' });
  assert.notEqual(control.partitionFor('B-0001'), analytics.partitionFor('B-0001'));
});

test('Analytics B-0001 != Analytics B-0002 (deterministic across instances)', () => {
  const a = new InAppRuntime({ getHostWindow: () => null, partitionPrefix: 'persist:analytics-' });
  const b = new InAppRuntime({ getHostWindow: () => null, partitionPrefix: 'persist:analytics-' });
  assert.notEqual(a.partitionFor('B-0001'), a.partitionFor('B-0002'));
  assert.equal(a.partitionFor('B-0001'), b.partitionFor('B-0001')); // deterministic
});
