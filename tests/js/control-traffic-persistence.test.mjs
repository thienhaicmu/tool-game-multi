import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { TrafficStore } = require('../../desktop/browser-run/traffic-store.cjs');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ctrl-traffic-')); }
function walkFiles(dir) {
  const out = [];
  const rec = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) rec(f); else out.push(f); } };
  rec(dir); return out;
}
function diskDump(dir) { return walkFiles(dir).map((f) => fs.readFileSync(f, 'utf8')).join('\n'); }

// ---------------------------------------------------------------------------
// §20 — HTTP persistence: request/response/body correlate and survive a reopen.
// ---------------------------------------------------------------------------
test('HTTP request/response/body persist and correlate by requestId after reopen', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => now });
  const owner = { browserId: 'B-1', runId: 'run-1', autoExecutionId: 'ax-1', recoveryGeneration: 0 };
  const req = { cdpRequestId: '42', method: 'GET', url: 'https://api.x/v1/r', host: 'api.x', path: '/v1/r', resourceType: 'xhr', headers: { accept: 'application/json' }, body: { hasBody: false }, targetId: 'T-1' };
  store.recordHttpRequest(owner, req);
  now += 20;
  req.response = { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'content-type': 'application/json' } };
  req.state = 'BODY_AVAILABLE'; req.durationMs = 18;
  store.recordHttpResponse(owner, req);
  store.recordHttpBody(owner, req, { available: true, body: '{"ok":true}', base64Encoded: false, length: 11 });

  // Reopen fresh (no in-memory state) — must read from disk.
  const reopened = new TrafficStore({ dir, now: () => now });
  const rows = reopened.readRun('run-1');
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, ['http-request', 'http-response', 'http-body']);
  assert.ok(rows.every((r) => r.requestId === '42'), 'all three correlate on requestId 42');
  assert.equal(rows[1].status, 200);
  assert.equal(rows[2].body, '{"ok":true}');
  assert.equal(rows[0].autoExecutionId, 'ax-1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redirect hops are distinct records, not merged', () => {
  const dir = tmp();
  const store = new TrafficStore({ dir, now: () => 1 });
  const owner = { browserId: 'B-1', runId: 'run-1' };
  store.recordHttpRequest(owner, { cdpRequestId: '7', hop: 0, method: 'GET', url: 'https://a/x', path: '/x', targetId: 'T' });
  store.recordHttpRequest(owner, { cdpRequestId: '7', hop: 1, method: 'GET', url: 'https://b/y', path: '/y', redirectFromId: 'T:0:7#0', targetId: 'T' });
  const rows = store.readRun('run-1');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].hop, 0); assert.equal(rows[1].hop, 1);
  assert.equal(rows[1].redirectFromId, 'T:0:7#0');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §21 — WS persistence: created/send/recv(unknown+known)/closed, direction + order.
// ---------------------------------------------------------------------------
test('WS lifecycle persists with direction/order; unknown frames preserved; close stored', () => {
  const dir = tmp();
  let now = 1;
  const store = new TrafficStore({ dir, now: () => now++ });
  const owner = { browserId: 'B-1', runId: 'run-1' };
  const url = 'wss://mynisketgw.hytsocesk.com/ws';
  store.recordWsCreated(owner, { cdpRequestId: '9', url, host: 'mynisketgw.hytsocesk.com', targetId: 'T' });
  store.recordWsFrame(owner, { cdpRequestId: '9', wsDirection: 'send', url, body: { raw: '[55555,"CUSTOM_UNKNOWN_SEND"]' }, targetId: 'T' });
  store.recordWsFrame(owner, { cdpRequestId: '9', wsDirection: 'recv', url, body: { raw: '[100002,{"odd":1.5}]' }, targetId: 'T' });
  store.recordWsFrame(owner, { cdpRequestId: '9', wsDirection: 'recv', url, body: { raw: '[99999,"CUSTOM_UNKNOWN_RECV"]' }, targetId: 'T' });
  store.recordWsClosed(owner, { cdpRequestId: '9', url, targetId: 'T' });

  const rows = new TrafficStore({ dir, now: () => now }).readRun('run-1');
  assert.deepEqual(rows.map((r) => r.kind), ['ws-created', 'ws-frame', 'ws-frame', 'ws-frame', 'ws-closed']);
  assert.deepEqual(rows.filter((r) => r.kind === 'ws-frame').map((r) => r.direction), ['send', 'recv', 'recv']);
  // Unknown frames preserved verbatim (payload + cmd), not filtered.
  assert.ok(rows.some((r) => r.cmd === 55555 && r.payload.includes('CUSTOM_UNKNOWN_SEND')));
  assert.ok(rows.some((r) => r.cmd === 99999 && r.payload.includes('CUSTOM_UNKNOWN_RECV')));
  // Known Aviator cmd classified additively.
  assert.ok(rows.find((r) => r.cmd === 100002).tags.includes('AVIATOR_PROTOCOL'));
  // Close carries UNKNOWN code/reason (CDP limitation), never invented.
  const closed = rows.find((r) => r.kind === 'ws-closed');
  assert.equal(closed.closeCode, null); assert.equal(closed.closeReason, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §22 — Redaction: secret VALUES never reach disk; header names kept.
// ---------------------------------------------------------------------------
test('secret header/body/url values are never persisted to disk', () => {
  const dir = tmp();
  const store = new TrafficStore({ dir, now: () => 1 });
  const owner = { browserId: 'B-1', runId: 'run-1' };
  store.recordHttpRequest(owner, {
    cdpRequestId: '1', method: 'POST', url: 'https://h/gwms/v1/game-act?token=SECRET_QS&game_id=vgmn_221',
    host: 'h', path: '/gwms/v1/game-act',
    headers: { 'Authorization': 'Bearer SECRET_A', 'Cookie': 'sid=SECRET_C', 'X-TOKEN': 'SECRET_T', 'Set-Cookie': 'x=SECRET_SC', 'X-FG-ID': 'SECRET_FG', 'content-type': 'application/json' },
    body: { raw: 'Authorization: Bearer SECRET_BODY', hasBody: true }, targetId: 'T',
  });
  const dump = diskDump(dir);
  for (const s of ['SECRET_A', 'SECRET_C', 'SECRET_T', 'SECRET_SC', 'SECRET_FG', 'SECRET_QS', 'SECRET_BODY']) {
    assert.ok(!dump.includes(s), `leaked ${s} to disk`);
  }
  const rec = store.readRun('run-1')[0];
  assert.equal(rec.headers['Authorization'], '[REDACTED]');
  assert.equal(rec.headers['X-TOKEN'], '[REDACTED]');
  assert.equal(rec.headers['content-type'], 'application/json'); // name+safe value preserved
  assert.ok(rec.url.includes('game_id=vgmn_221'), 'safe query param preserved');
  assert.ok(rec.tags.includes('GAME_ACT'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('case-insensitive sensitive header names are redacted', () => {
  const dir = tmp();
  const store = new TrafficStore({ dir, now: () => 1 });
  store.recordHttpRequest({ browserId: 'B-1', runId: 'run-1' }, { cdpRequestId: '1', method: 'GET', url: 'https://h/x', path: '/x', headers: { 'authorization': 'Bearer low', 'x-token': 'lowtok', 'COOKIE': 'sid=up' }, targetId: 'T' });
  const dump = diskDump(dir);
  for (const s of ['Bearer low', 'lowtok', 'sid=up']) assert.ok(!dump.includes(s), `leaked ${s}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §23 — Multi-browser isolation: CROSS_RUN_EVIDENCE_COUNT == 0.
// ---------------------------------------------------------------------------
test('interleaved B1/B2 traffic stays isolated per run (cross-run count = 0)', () => {
  const dir = tmp();
  let now = 1;
  const store = new TrafficStore({ dir, now: () => now++ });
  const b1 = { browserId: 'B-1', runId: 'run-1' };
  const b2 = { browserId: 'B-2', runId: 'run-2' };
  store.recordHttpRequest(b1, { cdpRequestId: '1', method: 'GET', url: 'https://a/1', path: '/1', targetId: 'T1' });
  store.recordWsFrame(b2, { cdpRequestId: '2', wsDirection: 'recv', url: 'wss://b/2', body: { raw: '[1]' }, targetId: 'T2' });
  store.recordWsFrame(b1, { cdpRequestId: '3', wsDirection: 'send', url: 'wss://a/3', body: { raw: '[2]' }, targetId: 'T1' });
  store.recordHttpRequest(b2, { cdpRequestId: '4', method: 'GET', url: 'https://b/4', path: '/4', targetId: 'T2' });

  const r1 = new TrafficStore({ dir }).readRun('run-1');
  const r2 = new TrafficStore({ dir }).readRun('run-2');
  assert.equal(r1.length, 2); assert.equal(r2.length, 2);
  const crossInR1 = r1.filter((r) => r.runId !== 'run-1' || r.browserId !== 'B-1').length;
  const crossInR2 = r2.filter((r) => r.runId !== 'run-2' || r.browserId !== 'B-2').length;
  assert.equal(crossInR1 + crossInR2, 0, 'CROSS_RUN_EVIDENCE_COUNT must be 0');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §24 — Recovery episode: success timeline + failure timeline both exportable.
// ---------------------------------------------------------------------------
test('recovery episode export contains ordered markers + traffic (success and failure)', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => now });
  const owner = { browserId: 'B-1', runId: 'run-1', autoExecutionId: 'ax-1' };
  const tick = (fn) => { now += 100; fn(); };
  const url = 'wss://mynisketgw.hytsocesk.com/ws';

  // SUCCESS episode: active -> context lost -> reenter -> game-act -> cocos -> fresh active -> resume
  const startMs = now;
  store.recordMarker(owner, { category: 'AUTO_RUNNER', event: 'AUTO_STARTED' });
  tick(() => store.recordWsFrame(owner, { cdpRequestId: '9', wsDirection: 'recv', url, body: { raw: '[100002,{"odd":2.1}]' }, targetId: 'T' }));
  tick(() => store.recordMarker(owner, { category: 'RECOVERY', event: 'AVIATOR_CONTEXT_LOST_REENTER' }));
  tick(() => store.recordWsClosed(owner, { cdpRequestId: '9', url, targetId: 'T' }));
  tick(() => store.recordMarker(owner, { category: 'RECOVERY', event: 'REENTRY_STARTED' }));
  tick(() => store.recordHttpRequest(owner, { cdpRequestId: '10', method: 'POST', url: 'https://h/gwms/v1/game-act', path: '/gwms/v1/game-act', targetId: 'T' }));
  tick(() => store.recordMarker(owner, { category: 'RECOVERY', event: 'COCOS_ENTRY_ATTEMPT' }));
  tick(() => store.recordWsCreated(owner, { cdpRequestId: '11', url, targetId: 'T' }));
  tick(() => store.recordMarker(owner, { category: 'RECOVERY', event: 'ENTRY_ACTIVE_CONFIRMED' }));
  tick(() => store.recordMarker(owner, { category: 'RECOVERY', event: 'AUTO_RESUMED' }));
  const endMs = now;

  const out = path.join(dir, 'episode.jsonl');
  const res = store.exportEpisode({ runId: 'run-1', fromMs: startMs, toMs: endMs }, out);
  assert.ok(res.ok);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // ordered by ts
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].ts >= lines[i - 1].ts, 'episode is time-ordered');
  const events = lines.filter((l) => l.kind === 'marker').map((l) => l.event);
  for (const e of ['AUTO_STARTED', 'AVIATOR_CONTEXT_LOST_REENTER', 'REENTRY_STARTED', 'COCOS_ENTRY_ATTEMPT', 'ENTRY_ACTIVE_CONFIRMED', 'AUTO_RESUMED']) {
    assert.ok(events.includes(e), `episode missing marker ${e}`);
  }
  assert.ok(lines.some((l) => l.kind === 'http-request' && l.tags.includes('GAME_ACT')), 'game-act present');
  assert.ok(lines.some((l) => l.kind === 'ws-closed'), 'ws close present');
  assert.ok(lines.some((l) => l.kind === 'ws-created'), 'new socket present');

  // Read-only summary reconstructs the lifecycle.
  const s = store.summarizeEpisode({ runId: 'run-1', fromMs: startMs, toMs: endMs });
  assert.ok(s.contextLostAt && s.gameActAt && s.freshActiveAt && s.resumeAt);
  assert.ok(s.contextLostAt < s.gameActAt && s.gameActAt < s.resumeAt);

  // FAILURE markers of the SAME incident coalesce into the already-open episode (dedup):
  // context-loss above pinned g1; these later markers must NOT spawn extra episode files.
  store.recordMarker(owner, { category: 'RECOVERY', event: 'RELOAD_STARTED' });
  store.recordMarker(owner, { category: 'RECOVERY', event: 'REENTRY_FAILED' });
  store.recordMarker(owner, { category: 'RECOVERY', event: 'RECOVERY_FAILED' });
  const epDir = path.join(dir, 'B-1', 'run-1', 'episodes');
  const eps = fs.readdirSync(epDir).filter((n) => n.endsWith('.jsonl'));
  assert.equal(eps.length, 1, 'one physical incident → one pinned episode');
  const failSummary = store.summarizeEpisode({ runId: 'run-1' });
  assert.ok(failSummary.failedAt != null, 'failure detectable in summary');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §25 — Long-run retention: rotation is bounded, active stays valid, pinned
// failure episode survives, and no cross-run deletion occurs.
// ---------------------------------------------------------------------------
test('size rotation stays bounded, active file valid, pinned episode survives, no cross-run deletion', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => now, maxFileSizeBytes: 800, maxFilesPerRun: 3, ringWindowMs: 1e9, postWindowMs: 0 });
  const b1 = { browserId: 'B-1', runId: 'run-1' };
  const b2 = { browserId: 'B-2', runId: 'run-2' };
  // Pin a failure episode early, then generate lots of traffic to force many rotations.
  store.recordWsFrame(b1, { cdpRequestId: '9', wsDirection: 'recv', url: 'wss://g/ws', body: { raw: '[100002,{"odd":1.01}]' }, targetId: 'T1' });
  store.recordMarker(b1, { category: 'RECOVERY', event: 'RECOVERY_FAILED' }); // pins episode
  for (let i = 0; i < 400; i++) { now += 1; store.recordWsFrame(b1, { cdpRequestId: '9', wsDirection: 'recv', url: 'wss://g/ws', body: { raw: `[100002,{"odd":${i}}]` }, targetId: 'T1' }); }
  // A little B2 traffic — must be untouched by B1 rotation.
  store.recordHttpRequest(b2, { cdpRequestId: '1', method: 'GET', url: 'https://b/x', path: '/x', targetId: 'T2' });

  const runDir = path.join(dir, 'B-1', 'run-1');
  const archives = fs.readdirSync(runDir).filter((n) => n.startsWith('traffic-') && n.endsWith('.jsonl'));
  assert.ok(archives.length <= 2, `bounded to maxFiles-1 archives, got ${archives.length}`); // maxFilesPerRun=3 => active + 2
  // active file is valid JSONL
  const active = fs.readFileSync(path.join(runDir, 'traffic.jsonl'), 'utf8').trim().split('\n');
  for (const l of active) JSON.parse(l); // throws if corrupt
  // pinned failure episode preserved despite heavy rotation
  const eps = fs.readdirSync(path.join(runDir, 'episodes'));
  assert.ok(eps.some((n) => n.includes('RECOVERY_FAILED')), 'pinned failure episode survived rotation');
  // no cross-run deletion
  assert.equal(new TrafficStore({ dir }).readRun('run-2').length, 1, 'B2 evidence intact');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Age retention + per-browser purge.
// ---------------------------------------------------------------------------
test('purgeExpired drops old archives/episodes but keeps active; purgeBrowser is scoped', () => {
  const dir = tmp();
  let now = 1_000_000;
  const store = new TrafficStore({ dir, now: () => now, maxFileSizeBytes: 400, maxFilesPerRun: 9 });
  const b1 = { browserId: 'B-1', runId: 'run-1' };
  const b2 = { browserId: 'B-2', runId: 'run-2' };
  for (let i = 0; i < 60; i++) { now += 1; store.recordWsFrame(b1, { cdpRequestId: '9', wsDirection: 'recv', url: 'wss://g/ws', body: { raw: `[100002,{"odd":${i}}]` }, targetId: 'T1' }); }
  store.recordHttpRequest(b2, { cdpRequestId: '1', method: 'GET', url: 'https://b/x', path: '/x', targetId: 'T2' });
  // Age everything far into the future and purge >1ms old.
  now += 10_000_000;
  const { dropped } = store.purgeExpired({ now, maxAgeMs: 1 });
  assert.ok(dropped >= 1, 'expired archives dropped');
  // active file for run-1 remains readable
  assert.ok(fs.existsSync(path.join(dir, 'B-1', 'run-1', 'traffic.jsonl')));

  // purgeBrowser removes only B-1's subtree.
  store.purgeBrowser('B-1');
  assert.ok(!fs.existsSync(path.join(dir, 'B-1')));
  assert.ok(fs.existsSync(path.join(dir, 'B-2')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §6 — side-channel WS churn must NOT pin episodes; a genuine Aviator context
// loss pins exactly one.
// ---------------------------------------------------------------------------
test('unrelated side-channel WS closes persist raw but pin ZERO episodes; Aviator context loss pins one', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => (now += 1) });
  const owner = { browserId: 'B-1', runId: 'run-1' };
  const epDir = path.join(dir, 'B-1', 'run-1', 'episodes');
  // Aviator socket + two unrelated side channels (chat/telemetry) that open and close.
  store.recordWsCreated(owner, { cdpRequestId: '1', url: 'wss://mynisketgw.hytsocesk.com/ws', targetId: 'T' });
  store.recordWsCreated(owner, { cdpRequestId: '2', url: 'wss://gemsdatapi.genesockezlyfeapy.com/x', targetId: 'T' });
  store.recordWsCreated(owner, { cdpRequestId: '3', url: 'wss://live-sgp-1.millicast.com/y', targetId: 'T' });
  store.recordWsClosed(owner, { cdpRequestId: '2', url: 'wss://gemsdatapi.genesockezlyfeapy.com/x', targetId: 'T' });
  store.recordMarker(owner, { category: 'WEBSOCKET', event: 'WS_CLOSE', url: 'wss://gemsdatapi.genesockezlyfeapy.com/x' });
  store.recordWsClosed(owner, { cdpRequestId: '3', url: 'wss://live-sgp-1.millicast.com/y', targetId: 'T' });
  store.recordMarker(owner, { category: 'WEBSOCKET', event: 'WS_CLOSE', url: 'wss://live-sgp-1.millicast.com/y' });
  // No episodes pinned by side-channel churn.
  const epsAfterSideChannels = fs.existsSync(epDir) ? fs.readdirSync(epDir).filter((n) => n.endsWith('.jsonl')) : [];
  assert.equal(epsAfterSideChannels.length, 0, 'side-channel WS close must NOT pin a failure episode');
  // But the raw closes + markers ARE persisted.
  const rows = store.readRun('run-1');
  assert.equal(rows.filter((r) => r.kind === 'ws-closed').length, 2, 'raw WS close events persisted');
  assert.equal(rows.filter((r) => r.kind === 'marker' && r.event === 'WS_CLOSE').length, 2, 'WS_CLOSE markers persisted (raw)');

  // Now a genuine Aviator context loss → exactly one pinned episode.
  store.recordMarker(owner, { category: 'RECOVERY', event: 'AVIATOR_CONTEXT_LOST_REENTER' });
  const eps = fs.readdirSync(epDir).filter((n) => n.endsWith('.jsonl'));
  assert.equal(eps.length, 1, 'Aviator context loss pins exactly one episode');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §7 — one physical incident emitting several failure markers → one episode.
// ---------------------------------------------------------------------------
test('one incident with multiple failure markers yields exactly one pinned episode (with recoveryEpisodeId)', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => now });
  const owner = { browserId: 'B-1', runId: 'run-1' };
  const epDir = path.join(dir, 'B-1', 'run-1', 'episodes');
  // Four markers of ONE incident, all within the post-window.
  store.recordMarker(owner, { category: 'RECOVERY', event: 'AVIATOR_CONTEXT_LOST_REENTER' });
  now += 500; store.recordMarker(owner, { category: 'RECOVERY', event: 'REENTRY_FAILED' });
  now += 500; store.recordMarker(owner, { category: 'RECOVERY', event: 'RECOVERY_FAILED' });
  now += 500; store.recordMarker(owner, { category: 'RECOVERY', event: 'AUTO_RESUME_FAILED' });
  const eps = fs.readdirSync(epDir).filter((n) => n.endsWith('.jsonl'));
  assert.equal(eps.length, 1, 'PHYSICAL_INCIDENT_COUNT=1 → LOGICAL_PINNED_EPISODE_COUNT=1');
  // All four lifecycle markers are still preserved inside the single episode file.
  const epLines = fs.readFileSync(path.join(epDir, eps[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const events = epLines.filter((l) => l.kind === 'marker').map((l) => l.event);
  for (const e of ['AVIATOR_CONTEXT_LOST_REENTER', 'REENTRY_FAILED', 'RECOVERY_FAILED', 'AUTO_RESUME_FAILED']) {
    assert.ok(events.includes(e), `episode preserves marker ${e}`);
  }
  // recoveryEpisodeId minted once for the incident.
  assert.equal(epLines[0].kind, 'episode-pin');
  assert.equal(epLines[0].recoveryEpisodeId, 1);

  // A genuinely NEW incident (after the window closes) mints a second episode.
  now += store.retentionPolicy().failureWindowMs + 10;
  store.recordMarker(owner, { category: 'RECOVERY', event: 'AVIATOR_CONTEXT_LOST_REENTER' });
  assert.equal(fs.readdirSync(epDir).filter((n) => n.endsWith('.jsonl')).length, 2, 'a distinct later incident pins a new episode');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §5 — reload survival: two socket generations reusing the same cdp requestId
// across different targets stay distinguishable (not merged).
// ---------------------------------------------------------------------------
test('socket generations across a reload are distinguishable even when requestId repeats', () => {
  const dir = tmp();
  let now = 1000;
  const store = new TrafficStore({ dir, now: () => (now += 1) });
  const owner1 = { browserId: 'B-1', runId: 'run-1', targetId: 'T-old' };
  // First generation (target T-old), cdp requestId '9'.
  store.recordWsCreated(owner1, { cdpRequestId: '9', url: 'wss://mynisketgw.hytsocesk.com/ws', targetId: 'T-old' });
  store.recordWsFrame(owner1, { cdpRequestId: '9', wsDirection: 'recv', url: 'wss://mynisketgw.hytsocesk.com/ws', body: { raw: '[100002,1]' }, targetId: 'T-old' });
  store.recordWsClosed(owner1, { cdpRequestId: '9', url: 'wss://mynisketgw.hytsocesk.com/ws', targetId: 'T-old' });
  // Reload → new target T-new, but CDP reuses requestId '9'.
  const owner2 = { browserId: 'B-1', runId: 'run-1', targetId: 'T-new' };
  store.recordWsCreated(owner2, { cdpRequestId: '9', url: 'wss://mynisketgw.hytsocesk.com/ws', targetId: 'T-new' });
  store.recordWsFrame(owner2, { cdpRequestId: '9', wsDirection: 'recv', url: 'wss://mynisketgw.hytsocesk.com/ws', body: { raw: '[100002,2]' }, targetId: 'T-new' });

  // Same BrowserRun evidence (append-only; old events retained).
  const rows = store.readRun('run-1');
  assert.equal(rows.filter((r) => r.kind === 'ws-created').length, 2, 'both generations retained (no overwrite on reload)');
  // Summary keeps them as TWO distinct socket generations, not one merged row.
  const gens = store.summarizeEpisode({ runId: 'run-1' }).socketGenerations;
  assert.equal(gens.length, 2, 'two distinct socket generations across the reload');
  assert.deepEqual(gens.map((g) => g.targetId).sort(), ['T-new', 'T-old']);
  fs.rmSync(dir, { recursive: true, force: true });
});
