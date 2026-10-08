// 3.2 phase 4 — the ONE diagnostic log (desktop/phom/core/logger.cjs): coseat.jsonl, batched, redacted, the previous
// session archived on the first write, the steps that explain a stuck browser always in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLogger, ALWAYS_RUN_EVENTS } = require('../../desktop/phom/core/logger.cjs');
const { redactDiagnostic } = require('../../desktop/protocol/phom/diagnostic-redaction.cjs');

const lines = (f) => readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => JSON.parse(l));

test('logger: lines are batched into one write; the previous session is archived, never overwritten', () => {
  const d = mkdtempSync(join(tmpdir(), 'phq-log-'));
  writeFileSync(join(d, 'coseat.jsonl'), '{"old":1}\n');
  const log = createLogger({ dir: () => d, flushMs: 10000 });
  log.file({ tag: 'PHOM-COSEAT', event: 'A' });
  log.file({ tag: 'PHOM-COSEAT', event: 'B' });
  assert.equal(readFileSync(join(d, 'coseat.jsonl'), 'utf8'), '{"old":1}\n', 'nothing written before the flush');
  log.flush();
  assert.deepEqual(lines(join(d, 'coseat.jsonl')).map((l) => l.event), ['A', 'B']);
  const archived = readdirSync(d).filter((f) => /^coseat-.*\.jsonl$/.test(f));
  assert.equal(archived.length, 1);
  assert.equal(readFileSync(join(d, archived[0]), 'utf8'), '{"old":1}\n');
  log.file({ event: 'C' }); log.flush();
  assert.deepEqual(lines(join(d, 'coseat.jsonl')).map((l) => l.event), ['A', 'B', 'C'], 'archived once per app run');
});

test('logger: a burst flushes at once; a big log is rotated', () => {
  const d = mkdtempSync(join(tmpdir(), 'phq-log-'));
  const log = createLogger({ dir: () => d, flushMs: 10000, maxQueue: 3, rotateBytes: 50 });
  for (let i = 0; i < 3; i++) log.file({ i });
  assert.equal(lines(join(d, 'coseat.jsonl')).length, 3, 'the 3rd line flushed the queue');
  for (let i = 0; i < 3; i++) log.file({ i, pad: 'x'.repeat(40) });
  assert.ok(readdirSync(d).some((f) => /^coseat-.*\.jsonl$/.test(f)), 'rotated past rotateBytes');
});

test('logger: every line is redacted', () => {
  const d = mkdtempSync(join(tmpdir(), 'phq-log-'));
  const log = createLogger({ dir: () => d, redact: redactDiagnostic });
  log.file({ event: 'X', password: 'hunter2', token: 'abc.def' });
  log.flush();
  const text = readFileSync(join(d, 'coseat.jsonl'), 'utf8');
  assert.equal(/hunter2|abc\.def/.test(text), false);
});

test('logger.run: the stuck-browser steps always reach the file; every step goes to stderr only when verbose', () => {
  const d = mkdtempSync(join(tmpdir(), 'phq-log-'));
  const err = [];
  let verbose = false;
  const log = createLogger({ dir: () => d, verbose: () => verbose, stderr: (l) => err.push(JSON.parse(l)) });
  log.run('AUTO_ENTER_DONE', { runId: 'BR-1' });
  log.run('action-route', { runId: 'BR-1' });
  log.flush();
  assert.deepEqual(lines(join(d, 'coseat.jsonl')).map((l) => [l.tag, l.event, l.runId]), [['PHOM-RUN', 'AUTO_ENTER_DONE', 'BR-1']]);
  assert.equal(err.length, 0);
  verbose = true;
  log.run('action-route', { runId: 'BR-1' });
  assert.deepEqual(err.map((l) => [l.tag, l.event]), [['PHOMLC', 'action-route']]);
  for (const e of ['DOCUMENT_REPLACED', 'PROXY_AUTH_FAILED', 'feature-error', 'BROWSER_MEMORY_RUNAWAY']) assert.ok(ALWAYS_RUN_EVENTS.includes(e), e);
});
