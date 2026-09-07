import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { DiagnosticLog, LEVEL, CATEGORY, redact, sanitizeUrl } = require('../../desktop/diagnostics/diagnostic-log.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'diaglog-'));
}
function readAll(dir, prefix = 'diagnostic') {
  const files = fs.readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith('.jsonl'));
  let text = '';
  for (const f of files) text += fs.readFileSync(path.join(dir, f), 'utf8');
  return text;
}
function readLines(dir) {
  return readAll(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Structured format + correlation identifiers (§28/§34)
// ---------------------------------------------------------------------------
test('writes structured JSONL with correlation ids and normalized fields', () => {
  const dir = tmpDir();
  const log = new DiagnosticLog({ dir, now: () => Date.parse('2026-09-07T00:00:00Z') });
  log.log({ level: LEVEL.INFO, category: CATEGORY.BET, event: 'BET_INTENT', browserId: 'B1', runId: 'BR-0001', autoExecutionId: 'AX-1', sid: 100, delayMs: 318 });
  const lines = readLines(dir);
  assert.equal(lines.length, 1);
  const r = lines[0];
  assert.equal(r.category, 'BET');
  assert.equal(r.event, 'BET_INTENT');
  assert.equal(r.browserId, 'B1');
  assert.equal(r.runId, 'BR-0001');
  assert.equal(r.autoExecutionId, 'AX-1');
  assert.equal(r.sid, 100);
  assert.equal(r.meta.delayMs, 318);
  assert.equal(r.ts, '2026-09-07T00:00:00.000Z');
  assert.equal(typeof r.mono, 'number');
});

// ---------------------------------------------------------------------------
// SECRET REDACTION (§30/§31/§38) — SECRET_LEAK_TEST
// ---------------------------------------------------------------------------
test('SECRET_LEAK_TEST: never persists password / bearer / cookie / tokens', () => {
  const dir = tmpDir();
  const log = new DiagnosticLog({ dir });
  log.log({
    category: CATEGORY.LOGIN, event: 'LOGIN_ATTEMPT',
    password: 'hunter2', refreshToken: 'rt_abcdef123456', authorization: 'Bearer abc.def.ghijkl',
    headers: { cookie: 'SESSION=deadbeefcafebabe', 'set-cookie': 'x=y', authorization: 'Bearer zzz.yyy.xxxxxx' },
    note: 'Authorization: Bearer eyJhbGciOi.JIUzI1NiIsInR.5cCI6IkpXVCJ9',
    url: 'https://casino.example.com/login?token=SECRET123&user=bob#frag',
  });
  const raw = readAll(dir);
  for (const secret of ['hunter2', 'rt_abcdef123456', 'deadbeefcafebabe', 'SECRET123', 'eyJhbGciOi.JIUzI1NiIsInR.5cCI6IkpXVCJ9', 'abc.def.ghijkl']) {
    assert.ok(!raw.includes(secret), `leaked secret: ${secret}`);
  }
  const r = readLines(dir)[0];
  assert.equal(r.meta.password, '[REDACTED]');
  assert.equal(r.meta.refreshToken, '[REDACTED]');
  assert.equal(r.meta.headers.cookie, '[REDACTED]');
  // URL persisted as safe host+path only, query dropped.
  assert.equal(r.meta.url, 'https://casino.example.com/login');
});

test('sanitizeUrl drops query, hash and inline credentials; redact strips Bearer', () => {
  assert.equal(sanitizeUrl('https://u:p@host.io/a/b?token=x#h'), 'https://host.io/a/b');
  assert.equal(sanitizeUrl('wss://game.local/ws?sid=99'), 'wss://game.local/ws');
  const red = redact({ h: 'Authorization: Bearer secretsecret' });
  assert.ok(!JSON.stringify(red).includes('secretsecret'));
});

// ---------------------------------------------------------------------------
// LOG ROTATION + bounded disk usage (§36)
// ---------------------------------------------------------------------------
test('rotates the active file at the size cap and prunes to maxFiles', () => {
  const dir = tmpDir();
  const log = new DiagnosticLog({ dir, maxFileSizeBytes: 400, maxFiles: 3, now: (() => { let t = Date.parse('2026-09-07T00:00:00Z'); return () => (t += 1000); })() });
  for (let i = 0; i < 200; i++) log.log({ category: CATEGORY.WEBSOCKET, event: 'WS_FRAME', i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  assert.ok(files.length <= 3, `expected <=3 files, got ${files.length}`);
  assert.ok(files.includes('diagnostic.jsonl'), 'active file exists');
  assert.ok(log.totalBytes() <= 3 * 400 + 500, 'total bytes bounded');
  // Records remain valid JSON after rotation.
  const lines = readLines(dir);
  assert.ok(lines.length > 0 && lines.every((l) => l.event === 'WS_FRAME'));
});

test('memory-only mode (no dir) never throws and returns the record', () => {
  const log = new DiagnosticLog({ dir: null });
  const r = log.log({ category: CATEGORY.APP, event: 'X', password: 'p' });
  assert.equal(r.event, 'X');
  assert.equal(r.meta.password, '[REDACTED]'); // key retained, value redacted
});

test('retentionPolicy reports bounded storage', () => {
  const dir = tmpDir();
  const log = new DiagnosticLog({ dir, maxFileSizeBytes: 1000, maxFiles: 4 });
  const p = log.retentionPolicy();
  assert.equal(p.format, 'JSONL');
  assert.equal(p.maxFileSizeBytes, 1000);
  assert.equal(p.maxFiles, 4);
  assert.equal(p.maxTotalBytes, 4000);
});
