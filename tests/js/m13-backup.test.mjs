import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { AnalyticsStore } = require('../../desktop/analytics/db/analytics-store.cjs');
const { AnalyticsPersistence } = require('../../desktop/analytics/persistence.cjs');

function tmp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-bak-')); return { dir, file: path.join(dir, 'a.db') }; }
const OPEN = 100005, END = 100007;
function round(p, b, sid, t) {
  p.onFrame(b, { direction: 'recv', raw: `{"cmd":${OPEN},"sid":${sid}}`, at: t });
  p.onFrame(b, { direction: 'recv', raw: `{"cmd":${END},"sid":${sid},"odd":2}`, at: t + 100 });
}

test('backup produces a self-consistent snapshot; original stays writable; integrity ok', async () => {
  const { dir, file } = tmp();
  const store = new AnalyticsStore({ file }); const p = new AnalyticsPersistence({ store });
  for (let i = 0; i < 5; i++) round(p, 'B-1', i, i * 1000);
  const before = store.counts();
  const bak = path.join(dir, 'backup.db');

  const res = await store.backup(bak);
  assert.equal(res.ok, true);
  assert.equal(AnalyticsStore.integrityCheck(bak), 'ok');

  // backup counts match the source at snapshot time
  const bstore = new AnalyticsStore({ file: bak });
  assert.equal(bstore.rounds.count(), before.rounds);
  assert.equal(bstore.raw.count(), before.rawEvents);
  bstore.close();

  // original remains writable AFTER backup, and this does NOT mutate the snapshot
  for (let i = 5; i < 10; i++) round(p, 'B-1', i, i * 1000);
  assert.ok(store.counts().rounds > before.rounds, 'original writable after backup');

  const bstore2 = new AnalyticsStore({ file: bak });
  assert.equal(bstore2.rounds.count(), before.rounds, 'backup is a stable snapshot, unaffected by later writes');
  bstore2.close();

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup with no destination returns an error (no throw)', async () => {
  const { dir, file } = tmp();
  const store = new AnalyticsStore({ file });
  const res = await store.backup('');
  assert.ok(res.error); assert.equal(res.error.code, 'BACKUP_NO_DEST');
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});
