import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { AutoExecutionHistoryStore } = require('../../desktop/browser-run/auto-execution-history-store.cjs');
const { AutoExecutionCollector, deriveExecutionRecord, stopReasonLabelVi } = require('../../desktop/browser-run/auto-execution-collector.cjs');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'autoexec-')); }

const REC = {
  autoExecutionId: 'AX-1', startedAt: '2026-09-07T00:00:00.000Z', endedAt: '2026-09-07T00:01:00.000Z',
  stopReason: 'AUTO_ERROR', roundsRequested: 3, roundsCompleted: 1, betAmount: 5000,
  configuredStopOdd: 2, lastSid: 107, stopOdd: 7.42, stopOddObservedAt: '2026-09-07T00:00:59.000Z',
  stopOddSource: 'ROUND_OBSERVER', recoveryCount: 0, lastRecoveryReason: null, errorCode: 'BOOM',
};

// ---------------------------------------------------------------------------
// Store: persistence, isolation, idempotent upsert, corruption safety
// ---------------------------------------------------------------------------
test('persists a terminal execution and survives reload; browsers are isolated', () => {
  const dir = tmpDir();
  const s1 = new AutoExecutionHistoryStore({ dir });
  s1.upsert({ browserId: 'B1', runId: 'BR-1', ...REC });
  s1.upsert({ browserId: 'B2', runId: 'BR-9', ...REC, autoExecutionId: 'AX-2' });
  // Fresh instance reads from disk.
  const s2 = new AutoExecutionHistoryStore({ dir });
  const b1 = s2.list('B1');
  assert.equal(b1.length, 1);
  assert.equal(b1[0].stopReason, 'AUTO_ERROR');
  assert.equal(b1[0].stopOdd, 7.42);
  assert.equal(s2.count('B1'), 1);
  assert.equal(s2.count('B2'), 1, 'B2 history is separate from B1');
});

test('upsert is idempotent by autoExecutionId (recovery-continued run updates ONE row)', () => {
  const dir = tmpDir();
  const s = new AutoExecutionHistoryStore({ dir });
  s.upsert({ browserId: 'B1', runId: 'BR-1', ...REC, recoveryCount: 0 });
  s.upsert({ browserId: 'B1', runId: 'BR-1', ...REC, recoveryCount: 2, stopReason: 'ROUND_TARGET_COMPLETED' });
  const rows = s.list('B1');
  assert.equal(rows.length, 1, 'still one logical execution');
  assert.equal(rows[0].recoveryCount, 2);
  assert.equal(rows[0].stopReason, 'ROUND_TARGET_COMPLETED');
});

test('invalid records are rejected; missing file is an empty first-run', () => {
  const s = new AutoExecutionHistoryStore({ dir: tmpDir() });
  assert.equal(s.upsert({ browserId: 'B1' }).error.code, 'AUTO_EXECUTION_HISTORY_INVALID_RECORD');
  assert.deepEqual(s.list('never-seen'), []);
});

test('corrupt file is reported and never overwritten', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'B1.json'), '{ not json', 'utf8');
  const s = new AutoExecutionHistoryStore({ dir });
  const res = s.upsert({ browserId: 'B1', runId: 'BR-1', ...REC });
  assert.equal(res.error.code, 'AUTO_EXECUTION_HISTORY_CORRUPT');
  assert.equal(fs.readFileSync(path.join(dir, 'B1.json'), 'utf8'), '{ not json', 'evidence preserved');
});

// ---------------------------------------------------------------------------
// Collector: structural attribution + Vietnamese label + evidence-safe status
// ---------------------------------------------------------------------------
test('collector attributes browserId/runId structurally and derives a Vietnamese label', () => {
  const dir = tmpDir();
  const store = new AutoExecutionHistoryStore({ dir });
  const runner = new EventEmitter();
  let persisted = null;
  new AutoExecutionCollector({ store, browserId: 'B7', runId: 'BR-3', autoRunner: runner, onPersisted: (_b, r) => { persisted = r; } });
  runner.emit('executionFinalized', REC);
  assert.ok(persisted);
  assert.equal(persisted.browserId, 'B7');
  assert.equal(persisted.runId, 'BR-3');
  assert.equal(persisted.stopReason, 'AUTO_ERROR');
  assert.equal(persisted.stopReasonLabel, 'Lỗi Auto Run');
  assert.equal(persisted.stopOdd, 7.42);
  assert.equal(persisted.resultStatus, 'UNKNOWN', 'AUTO_ERROR is not a definitive result');
});

test('stopReasonLabelVi maps the canonical reasons; unknown falls back safely', () => {
  assert.equal(stopReasonLabelVi('USER_STOP'), 'Người dùng dừng');
  assert.equal(stopReasonLabelVi('ROUND_TARGET_COMPLETED'), 'Hoàn thành số vòng');
  assert.equal(stopReasonLabelVi('LOGIN_REQUIRED'), 'Cần đăng nhập');
  assert.equal(stopReasonLabelVi('RECOVERY_FAILED'), 'Khôi phục thất bại');
  assert.equal(stopReasonLabelVi('SEQUENCE_WIN_RESET'), 'Thắng — quay lại Level 1');
  assert.equal(stopReasonLabelVi('WAT'), 'Không xác định');
});

// ---------------------------------------------------------------------------
// Cross-feature acceptance (§56): AUTO_ERROR at ODD 7.42 flows end-to-end
// AutoRunner -> executionFinalized -> collector -> persisted store row.
// ---------------------------------------------------------------------------
test('end-to-end: unexpected AUTO_ERROR persists stopReason + ODD lúc dừng', async () => {
  const { RoundTracker } = require('../../desktop/protocol/aviator.cjs');
  const { RoundObserver } = require('../../desktop/protocol/round-observer.cjs');
  const { AutoRunner } = require('../../desktop/protocol/auto-runner.cjs');
  const tracker = new RoundTracker({ ackWindowMs: 60000 });
  const observer = new RoundObserver({ roundTracker: tracker });
  const harness = { execute: async (o) => (o.command === 'cashout' ? { result: 'ACK', responsePayload: { odd: 2 } } : { result: 'ACK' }) };
  const runner = new AutoRunner({ roundTracker: tracker, observer, harness, getTargetUrl: () => 'http://localhost/game' });
  const store = new AutoExecutionHistoryStore({ dir: tmpDir() });
  new AutoExecutionCollector({ store, browserId: 'B1', runId: 'BR-1', autoRunner: runner });
  runner.start('T', { roundCount: 1, amount: 5000, stopOdd: 100 });
  tracker.observe({ raw: '{"cmd":100005,"sid":100}', direction: 'recv', targetId: 'T', url: 'wss://g/ws' });
  await new Promise((r) => setImmediate(r));
  tracker.observe({ raw: '{"cmd":100009,"sid":100,"odd":7.42}', direction: 'recv', targetId: 'T', url: 'wss://g/ws' });
  await new Promise((r) => setImmediate(r));
  runner.stop({ reason: 'AUTO_ERROR', errorCode: 'BOOM' });
  const rows = store.list('B1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stopReason, 'AUTO_ERROR');
  assert.equal(rows[0].stopReasonLabel, 'Lỗi Auto Run');
  assert.equal(rows[0].stopOdd, 7.42);
  assert.equal(rows[0].stopOddSource, 'ROUND_OBSERVER');
});

test('result status is evidence-safe: only completed/stopped are definitive', () => {
  assert.equal(deriveExecutionRecord({ browserId: 'B', runId: 'R', rec: { ...REC, stopReason: 'ROUND_TARGET_COMPLETED' } }).resultStatus, 'COMPLETED');
  assert.equal(deriveExecutionRecord({ browserId: 'B', runId: 'R', rec: { ...REC, stopReason: 'USER_STOP' } }).resultStatus, 'STOPPED');
  assert.equal(deriveExecutionRecord({ browserId: 'B', runId: 'R', rec: { ...REC, stopReason: 'RECOVERY_FAILED' } }).resultStatus, 'UNKNOWN');
  assert.equal(deriveExecutionRecord({ browserId: 'B', runId: 'R', rec: { ...REC, stopOdd: null } }).stopOdd, null);
});
