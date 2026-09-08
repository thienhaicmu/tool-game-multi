import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AnalyticsLiveState } = require('../../desktop/analytics/live-state.cjs');
const { STATE } = require('../../desktop/protocol/aviator-context.cjs');

// Deterministic small windows via an injected clock: ACTIVE within 1000ms, VERIFYING +500ms, then LOST.
const CFG = { freshMs: 1000, verifyWindowMs: 500 };
function makeState() {
  const clock = { t: 10000 };
  const ls = new AnalyticsLiveState({ browserId: 'B-CTX', now: () => clock.t, contextConfig: CFG });
  return { ls, clock };
}
const recv = (raw) => ({ direction: 'recv', raw });
const ROUND_OPEN = (sid) => `{"cmd":100005,"sid":${sid}}`;
const ODD = (sid, odd) => `{"cmd":100009,"sid":${sid},"odd":${odd}}`;
const JACKPOT = (sid, jp) => `{"cmd":100009,"sid":${sid},"odd":1.5,"eI":{"jp":${jp}}}`;
const LOBBY = () => `{"cmd":42,"foo":"lobby-heartbeat"}`; // non-Aviator recv chatter

test('A1: browser open but no Aviator evidence => aviatorContext UNKNOWN (not falsely ACTIVE)', () => {
  const { ls } = makeState();
  const s = ls.snapshot({ events: false });
  assert.equal(s.aviatorContext, STATE.UNKNOWN);
});

test('A2: fresh Aviator evidence => AVIATOR_ACTIVE (drives ĐANG THU THẬP)', () => {
  const { ls } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(1)));
  const s = ls.snapshot({ events: false });
  assert.equal(s.aviatorContext, STATE.ACTIVE);
  assert.equal(s.currentSid, 1);
});

test('A3: non-Aviator WS traffic does NOT refresh Aviator freshness', () => {
  const { ls, clock } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(7)));                 // Aviator active at t=10000
  clock.t = 10800;
  ls.observeFrame(recv(LOBBY()));                       // lobby chatter — must NOT count as Aviator
  clock.t = 11200;
  ls.observeFrame(recv(LOBBY()));                       // more lobby chatter
  // Aviator has been silent since 10000; only lobby traffic since. => VERIFYING (page healthy).
  const s = ls.snapshot({ events: false });
  assert.equal(s.aviatorContext, STATE.VERIFYING);
});

test('A4: Aviator stale + healthy lobby traffic => VERIFYING', () => {
  const { ls, clock } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(1)));
  clock.t = 11200;                                      // 1200ms since Aviator, still open socket
  ls.observeFrame(recv(LOBBY()));                       // lobby alive
  assert.equal(ls.snapshot({ events: false }).aviatorContext, STATE.VERIFYING);
});

test('A5: a fresh Aviator frame during VERIFYING => back to ACTIVE', () => {
  const { ls, clock } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(1)));
  clock.t = 11200; ls.observeFrame(recv(LOBBY()));
  assert.equal(ls.snapshot({ events: false }).aviatorContext, STATE.VERIFYING);
  clock.t = 11300; ls.observeFrame(recv(ROUND_OPEN(2))); // user is back in game / game resumed
  assert.equal(ls.snapshot({ events: false }).aviatorContext, STATE.ACTIVE);
});

test('A6: confirmed loss => AVIATOR_CONTEXT_LOST (drives CẦN VÀO LẠI GAME)', () => {
  const { ls, clock } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(1)));
  clock.t = 11700; ls.observeFrame(recv(LOBBY()));      // > freshMs + verifyWindowMs
  assert.equal(ls.snapshot({ events: false }).aviatorContext, STATE.CONTEXT_LOST);
});

test('A7: context lost clears LIVE SID/ODD/Jackpot presentation (no frozen values)', () => {
  const { ls, clock } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(55)));
  ls.observeFrame(recv(ODD(55, 3.2)));
  ls.observeFrame(recv(JACKPOT(55, 999)));
  assert.equal(ls.snapshot({ events: false }).currentJackpot, 999); // fresh -> present
  clock.t = 11800; ls.observeFrame(recv(LOBBY()));                  // confirmed loss
  const s = ls.snapshot({ events: false });
  assert.equal(s.aviatorContext, STATE.CONTEXT_LOST);
  assert.equal(s.currentSid, null);
  assert.equal(s.currentOdd, null);
  assert.equal(s.currentJackpot, null);
});

test('A8: context loss does not wipe captured evidence (events retained; historical data untouched)', () => {
  const { ls, clock } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(1)));
  ls.observeFrame(recv(ODD(1, 2.0)));
  clock.t = 11800; ls.observeFrame(recv(LOBBY()));
  const s = ls.snapshot({ events: true });
  assert.equal(s.aviatorContext, STATE.CONTEXT_LOST);
  // Raw observed frames remain as evidence — only the derived LIVE presentation is cleared.
  assert.ok(s.events.length >= 3);
  assert.ok(s.events.some((e) => e.cmd === 100005));
});

test('A9: manual website re-entry (fresh Aviator frames) auto-resumes ACTIVE + restores values', () => {
  const { ls, clock } = makeState();
  ls.observeFrame(recv(ROUND_OPEN(1)));
  clock.t = 11800; ls.observeFrame(recv(LOBBY()));
  assert.equal(ls.snapshot({ events: false }).aviatorContext, STATE.CONTEXT_LOST);
  // User re-enters Aviator on the website; the collector (still attached) sees fresh server frames.
  clock.t = 11900; ls.observeFrame(recv(ROUND_OPEN(2)));
  ls.observeFrame(recv(JACKPOT(2, 1234)));
  const s = ls.snapshot({ events: false });
  assert.equal(s.aviatorContext, STATE.ACTIVE);
  assert.equal(s.currentSid, 2);
  assert.equal(s.currentJackpot, 1234);
});

test('A10: Analytics may originate ENTRY cmd100000 ONLY — no wager/generic send path', () => {
  // NEW POLICY (this WU): Analytics is passive for game observation + wagering, with ONE
  // permitted protocol action — the fixed Aviator ENTER cmd100000 for bounded context recovery.
  // BET/CASHOUT/arbitrary-send/replay/AutoRunner remain architecturally impossible.
  const dir = path.resolve(process.cwd(), 'desktop', 'analytics');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.cjs') ? [path.join(d, e.name)] : []));
  const files = walk(dir);
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')       // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1');    // line comments (keep :// in URLs)
  // Hard-forbidden anywhere in the Analytics graph: wager cmds, generic senders, action stacks.
  const banned = /\b100002\b|\b100003\b|\.sendRaw\(|\.sendProtocol\(|\bwsReplay\b|new\s+AutoRunner|AutoSequenceController|\bJackpotGate\b|\.ensureThreshold\(/;
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    assert.equal(banned.test(code), false, `${path.basename(f)} must not contain wager/generic-send/action origination`);
  }
  // The entry cmd literal (cmd:100000) is permitted ONLY inside the sealed entry seam. Note a bare
  // 100000 also appears as a numeric clamp bound in query code — so match it ONLY next to `cmd`.
  const entryCmdLiteral = /cmd["'\s:]{0,4}100000|100000[\s,}\]]{0,4}["']?\s*\)?\s*;?\s*\/\/|aviatorPlugin[\s\S]{0,40}100000/;
  const allowEntryLiteral = new Set(['entry-only-transport.cjs', 'analytics-aviator-entry.cjs', 'analytics-runtime.cjs']);
  for (const f of files) {
    if (allowEntryLiteral.has(path.basename(f))) continue;
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    assert.equal(entryCmdLiteral.test(code), false, `${path.basename(f)} must not embed the entry cmd literal (belongs in the sealed seam)`);
  }
});
