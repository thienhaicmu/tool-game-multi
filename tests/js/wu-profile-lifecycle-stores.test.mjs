import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { RoundHistoryStore } = require('../../desktop/browser-run/round-history-store.cjs');
const { AutoExecutionHistoryStore } = require('../../desktop/browser-run/auto-execution-history-store.cjs');
const { DiagnosticLog, CATEGORY } = require('../../desktop/diagnostics/diagnostic-log.cjs');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-')); }
const H48 = 48 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const ageIso = (ms) => new Date(NOW - ms).toISOString();

function roundRec(browserId, sid, endedAt) {
  return { browserId, runId: 'BR-1', sid, startedAt: endedAt, endedAt, result: 'WIN', participated: true };
}

// ===========================================================================
// DELETE PROFILE — per-browser removal (§4/§7/§10)
// ===========================================================================
test('round history: removeBrowser deletes B1 file only, B2 untouched', () => {
  const dir = tmpDir();
  const s = new RoundHistoryStore({ dir });
  s.upsert(roundRec('B1', 1, ageIso(0)));
  s.upsert(roundRec('B2', 2, ageIso(0)));
  const res = s.removeBrowser('B1');
  assert.equal(res.removed, true);
  assert.equal(s.count('B1'), 0);
  assert.equal(s.count('B2'), 1, 'B2 history intact');
  assert.equal(fs.existsSync(path.join(dir, 'B1.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'B2.json')), true);
});

test('auto-execution history: removeBrowser deletes B1 only', () => {
  const dir = tmpDir();
  const s = new AutoExecutionHistoryStore({ dir });
  s.upsert({ browserId: 'B1', autoExecutionId: 'AX-1', endedAt: ageIso(0) });
  s.upsert({ browserId: 'B2', autoExecutionId: 'AX-2', endedAt: ageIso(0) });
  s.removeBrowser('B1');
  assert.equal(s.count('B1'), 0);
  assert.equal(s.count('B2'), 1);
});

test('diagnostics: purgeBrowser drops only B1 records from the shared store', () => {
  const dir = tmpDir();
  const log = new DiagnosticLog({ dir });
  log.log({ category: CATEGORY.BET, event: 'X', browserId: 'B1', n: 1 });
  log.log({ category: CATEGORY.BET, event: 'Y', browserId: 'B2', n: 2 });
  log.log({ category: CATEGORY.BET, event: 'Z', browserId: 'B1', n: 3 });
  const res = log.purgeBrowser('B1');
  assert.equal(res.dropped, 2);
  const all = log.files().flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  assert.ok(all.every((r) => r.browserId !== 'B1'), 'no B1 records remain');
  assert.equal(all.filter((r) => r.browserId === 'B2').length, 1, 'B2 records kept');
});

test('diagnostics: purge removes operational browser records but keeps delete-audit trail (§8/§23)', () => {
  const dir = tmpDir();
  const log = new DiagnosticLog({ dir });
  // Operational records are tagged with the indexed browserId ...
  log.log({ category: CATEGORY.BET, event: 'BET_INTENT', browserId: 'B1' });
  log.log({ category: CATEGORY.WEBSOCKET, event: 'WS_CLOSE', browserId: 'B1' });
  log.purgeBrowser('B1');
  // ... the post-delete AUDIT event references the id via a NON-indexed meta field, so it
  // survives the purge and never re-introduces a record keyed to the deleted browserId.
  log.log({ category: CATEGORY.BROWSER_RUN, event: 'PROFILE_DATA_DELETE_COMPLETED', deletedBrowserId: 'B1' });
  const recs = log.files().flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  assert.equal(recs.filter((r) => r.browserId === 'B1').length, 0, 'no operational B1 records remain');
  assert.equal(recs.filter((r) => r.event === 'PROFILE_DATA_DELETE_COMPLETED').length, 1, 'audit event retained');
  assert.equal(recs.find((r) => r.event === 'PROFILE_DATA_DELETE_COMPLETED').meta.deletedBrowserId, 'B1');
});

// ===========================================================================
// 48-HOUR RETENTION — boundaries (§12/§21/§28)
// ===========================================================================
test('round history retention: 47h keep, 48h delete, 48h01s delete', () => {
  const dir = tmpDir();
  const s = new RoundHistoryStore({ dir });
  s.upsert(roundRec('B1', 1, ageIso(47 * 3600 * 1000)));          // 47h -> keep
  s.upsert(roundRec('B1', 2, ageIso(H48)));                        // exactly 48h -> delete
  s.upsert(roundRec('B1', 3, ageIso(H48 + 1000)));                 // 48h + 1s -> delete
  s.upsert(roundRec('B1', 4, ageIso(72 * 3600 * 1000)));           // 72h -> delete
  const out = s.purgeExpired({ now: NOW, maxAgeMs: H48 });
  assert.equal(out.deleted, 3);
  const sids = s.list('B1').map((r) => r.sid);
  assert.deepEqual(sids, [1], 'only the 47h record survives');
});

test('round history retention: boundary 47h59m59s keeps', () => {
  const dir = tmpDir();
  const s = new RoundHistoryStore({ dir });
  s.upsert(roundRec('B1', 1, ageIso(H48 - 1000))); // 47h59m59s
  const out = s.purgeExpired({ now: NOW, maxAgeMs: H48 });
  assert.equal(out.deleted, 0);
  assert.equal(s.count('B1'), 1);
});

test('retention keeps malformed / missing / future timestamps (§20)', () => {
  const dir = tmpDir();
  const s = new RoundHistoryStore({ dir });
  s.upsert({ browserId: 'B1', runId: 'R', sid: 1, endedAt: 'not-a-date', startedAt: null });
  s.upsert({ browserId: 'B1', runId: 'R', sid: 2, endedAt: null, startedAt: null });
  s.upsert({ browserId: 'B1', runId: 'R', sid: 3, endedAt: new Date(NOW + 5 * H48).toISOString() }); // future
  const out = s.purgeExpired({ now: NOW, maxAgeMs: H48 });
  assert.equal(out.deleted, 0);
  assert.equal(out.malformed, 2);
  assert.equal(s.count('B1'), 3, 'nothing mass-deleted');
});

test('retention is global + per-browser independent (§31)', () => {
  const dir = tmpDir();
  const s = new RoundHistoryStore({ dir });
  s.upsert(roundRec('B1', 1, ageIso(0)));         // fresh
  s.upsert(roundRec('B1', 2, ageIso(72 * 3600 * 1000))); // old
  s.upsert(roundRec('B2', 3, ageIso(0)));         // fresh
  s.upsert(roundRec('B2', 4, ageIso(72 * 3600 * 1000))); // old
  s.purgeExpired({ now: NOW, maxAgeMs: H48 });
  assert.deepEqual(s.list('B1').map((r) => r.sid).sort(), [1]);
  assert.deepEqual(s.list('B2').map((r) => r.sid).sort(), [3]);
});

test('auto-execution retention: 48h boundary', () => {
  const dir = tmpDir();
  const s = new AutoExecutionHistoryStore({ dir });
  s.upsert({ browserId: 'B1', autoExecutionId: 'A', endedAt: ageIso(47 * 3600 * 1000) });
  s.upsert({ browserId: 'B1', autoExecutionId: 'B', endedAt: ageIso(H48) });
  const out = s.purgeExpired({ now: NOW, maxAgeMs: H48 });
  assert.equal(out.deleted, 1);
  assert.deepEqual(s.list('B1').map((r) => r.autoExecutionId), ['A']);
});

test('diagnostic retention: drops old records, keeps young + malformed', () => {
  const dir = tmpDir();
  const log = new DiagnosticLog({ dir, now: () => NOW });
  log.log({ category: CATEGORY.APP, event: 'young', browserId: 'B1' });              // ts=NOW
  // Inject an old record directly (predates cutoff).
  fs.appendFileSync(path.join(dir, 'diagnostic.jsonl'),
    JSON.stringify({ ts: ageIso(H48 + 5000), level: 'INFO', category: 'APP', event: 'old', browserId: 'B1' }) + '\n' +
    'THIS-IS-NOT-JSON\n', 'utf8');
  const out = log.purgeExpired({ now: NOW, maxAgeMs: H48 });
  assert.equal(out.dropped, 1);
  const remaining = fs.readFileSync(path.join(dir, 'diagnostic.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.ok(remaining.some((l) => l.includes('"young"')));
  assert.ok(remaining.some((l) => l === 'THIS-IS-NOT-JSON'), 'malformed line preserved');
  assert.ok(!remaining.some((l) => l.includes('"old"')));
});

// ===========================================================================
// DELETE PROFILE end-to-end across owned stores (§26): B1 gone, B2 intact.
// Mirrors the main-process orchestration at the module layer (Electron session
// storage is exercised separately in the app; not unit-testable here).
// ===========================================================================
test('delete B1 removes all B1-owned data across stores; B2 fully intact', () => {
  const { BrowserRegistry } = require('../../desktop/browser-run/browser-registry.cjs');
  const { BrowserConfigStore } = require('../../desktop/browser-run/browser-config-store.cjs');
  const root = tmpDir();
  const reg = new BrowserRegistry({ filePath: path.join(root, 'registry.json'), profilesRoot: path.join(root, 'profiles') });
  reg.load();
  const B1 = reg.create({ name: 'One', launchUrl: 'https://a.example/g' }).browser.id;
  const B2 = reg.create({ name: 'Two', launchUrl: 'https://b.example/g' }).browser.id;
  const cfg = new BrowserConfigStore({ filePath: path.join(root, 'configs.json') }); cfg.load();
  cfg.set(B1, { amount: 1000 }); cfg.set(B2, { amount: 2000 });
  const hist = new RoundHistoryStore({ dir: path.join(root, 'history') });
  hist.upsert(roundRec(B1, 1, ageIso(0))); hist.upsert(roundRec(B2, 2, ageIso(0)));
  const exec = new AutoExecutionHistoryStore({ dir: path.join(root, 'auto') });
  exec.upsert({ browserId: B1, autoExecutionId: 'AX1', endedAt: ageIso(0) });
  exec.upsert({ browserId: B2, autoExecutionId: 'AX2', endedAt: ageIso(0) });
  const diag = new DiagnosticLog({ dir: path.join(root, 'diag') });
  diag.log({ category: CATEGORY.BET, event: 'e', browserId: B1 });
  diag.log({ category: CATEGORY.BET, event: 'e', browserId: B2 });

  // --- delete B1 (order mirrors deletePersistentBrowser) ---
  hist.removeBrowser(B1); exec.removeBrowser(B1); diag.purgeBrowser(B1); cfg.remove(B1); reg.remove(B1);

  // B1 fully gone
  assert.equal(reg.get(B1), null);
  assert.equal(cfg.has(B1), false);
  assert.equal(hist.count(B1), 0);
  assert.equal(exec.count(B1), 0);
  const diagRecs = diag.files().flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  assert.equal(diagRecs.filter((r) => r.browserId === B1).length, 0);

  // B2 fully intact
  assert.ok(reg.get(B2));
  assert.equal(cfg.get(B2).amount, 2000);
  assert.equal(hist.count(B2), 1);
  assert.equal(exec.count(B2), 1);
  assert.equal(diagRecs.filter((r) => r.browserId === B2).length, 1);
});

test('removeBrowser on empty/missing store is a safe no-op', () => {
  const s = new RoundHistoryStore({ dir: tmpDir() });
  assert.deepEqual(s.removeBrowser('never'), { ok: true, removed: false });
  const a = new AutoExecutionHistoryStore({ dir: tmpDir() });
  assert.deepEqual(a.removeBrowser('never'), { ok: true, removed: false });
});
