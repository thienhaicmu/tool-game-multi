// WU-AUTH-AVIATOR-ENTRY-RECOVERY — login-signal unit + Auto-start login-gate wiring guards.
//
// The audit found two defects vs the required flow:
//   (1) VERIFYING → LOGIN_REQUIRED skipped pausing/invalidating a running session
//       (covered by wu-session-recovery.test.mjs).
//   (2) Auto-start had no login-wall gate, so clicking Auto on a login page sent cmd 100000
//       into the wall and returned a generic AVIATOR_ENTRY_TIMEOUT instead of "Cần đăng nhập".
//
// These tests lock the ONE shared login-URL heuristic (used by both recovery evidence and the
// Auto-start gate) and assert the source ordering: the login gate runs BEFORE entry, and no
// cmd 100000 can be sent while the page is a login wall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { looksLikeLoginUrl, LOGIN_URL_RE } = require('../../desktop/browser-run/login-signal.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(path.join(ROOT, p), 'utf8');

test('login-signal: recognises real login/auth walls', () => {
  const yes = [
    'https://site.cc/login',
    'https://site.cc/#/login',
    'https://site.cc/signin',
    'https://site.cc/sign-in',
    'https://site.cc/log-in',
    'https://site.cc/auth/token',
    'https://api.wsmt8g.cc/v2/auth/token/login?v=4',
    'https://site.cc/dangnhap',
    'https://site.cc/dang-nhap',
    'https://site.cc/?redirect=/login',
    'https://site.cc/#login',
  ];
  for (const u of yes) assert.equal(looksLikeLoginUrl(u), true, `should flag: ${u}`);
});

test('login-signal: does NOT false-positive on a logged-in game / opaque tokens', () => {
  const no = [
    'https://site.cc/#/aviator',
    'https://site.cc/game/aviator',
    'https://site.cc/?t=authtokenblob',   // "auth" embedded in an opaque token (not a segment)
    'https://site.cc/logout',              // logout is not a login wall
    'https://site.cc/dashboard',
    'https://site.cc/',
    '',
    null,
    undefined,
  ];
  for (const u of no) assert.equal(looksLikeLoginUrl(u), false, `should NOT flag: ${String(u)}`);
});

test('login-signal: exported regex is present (single source of truth)', () => {
  assert.ok(LOGIN_URL_RE instanceof RegExp);
});

// --- source ordering guards: the login gate must run BEFORE entry, and recovery evidence must
//     reuse the SAME detector (no divergent copies of the regex). ---

test('wiring: recovery evidence and the Auto-start gate share the ONE login detector', () => {
  const main = rd('desktop/main.cjs');
  assert.match(main, /require\('\.\/browser-run\/login-signal\.cjs'\)/, 'main imports the shared detector');
  // gatherEvidence uses it for loginDetected
  assert.match(main, /loginDetected:\s*looksLikeLoginUrl\(url\)/, 'recovery evidence uses the shared detector');
  // the inline regex must be gone (no divergent copy left behind)
  assert.doesNotMatch(main, /loginDetected:\s*\/\(\?:\^/, 'no inline login regex remains in gatherEvidence');
});

test('wiring: autotest-start gates on login BEFORE Aviator entry (no cmd100000 into a login wall)', () => {
  const main = rd('desktop/main.cjs');
  // WU-AUTO-SEQUENCE — the Auto start orchestration (shared by the first row and every
  // sequence row) lives in startAutoExecution(); assert the gate ordering there.
  const startIdx = main.indexOf('async function startAutoExecution');
  assert.ok(startIdx > 0, 'startAutoExecution orchestration exists');
  const body = main.slice(startIdx, startIdx + 3200);
  const loginIdx = body.indexOf('LOGIN_REQUIRED');
  const gateCallIdx = body.indexOf('looksLikeLoginUrl(currentRunUrl(run))');
  const entryIdx = body.indexOf('entryGate.ensureEntered()');
  assert.ok(gateCallIdx > 0, 'the login gate is present in the Auto start orchestration');
  assert.ok(loginIdx > 0 && loginIdx < entryIdx, 'LOGIN_REQUIRED returned before entry');
  assert.ok(gateCallIdx < entryIdx, 'login check runs BEFORE entryGate.ensureEntered()');
  // guarded by not-already-entered so an in-game run is never blocked by a stale URL
  assert.match(body, /!\(run\.entryGate\.isEntered && run\.entryGate\.isEntered\(\)\) && looksLikeLoginUrl/, 'gate only applies when not already entered');
});

test('wiring: the UI surfaces LOGIN_REQUIRED as a clear "Cần đăng nhập" message', () => {
  const ui = rd('ui/product.js');
  assert.match(ui, /const login = code === 'LOGIN_REQUIRED'/, 'LOGIN_REQUIRED handled distinctly');
  assert.match(ui, /Cần đăng nhập/, 'clear Vietnamese login instruction present');
});
