// Generator on ANOTHER machine: "Sheet" not connecting (user 2026-10-09). Verified against the real Google token
// endpoint the same day: a JWT whose iat is off by +10 min / ±7 h is refused with 400 invalid_grant "Check your iat
// and exp values" — a machine with a wrong clock / time zone could create keys (trusted time) but not save them.
// Now the login is signed with the clock the generator passes (its trusted internet time), a clock refusal says so,
// and a transport failure is a typed GOOGLE_NETWORK error; the packaged app talks through electron net (Windows proxy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { GoogleSheetClient } = require('../../tools/license-generator/google-sheet.cjs');
const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
const iatOf = (body) => JSON.parse(Buffer.from(decodeURIComponent(body.split('assertion=')[1]).split('.')[1], 'base64url').toString()).iat;

// a fake Google that, like the real one, refuses a login signed more than 5 minutes away from ITS time
function google(realNowMs) {
  const seen = [];
  async function request(url, opts = {}) {
    if (url.endsWith('/token')) {
      const iat = iatOf(opts.body); seen.push(iat);
      if (Math.abs(iat - realNowMs / 1000) > 300) return { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe. Check your iat and exp values in the JWT claim.' } };
      return { status: 200, json: { access_token: 't', expires_in: 3600 } };
    }
    return { status: 200, json: { properties: { title: 'Ledger' }, sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }] } };
  }
  return { request, seen };
}

test('the Google login is signed with the clock the generator passes, not the machine clock', async () => {
  const real = Date.now() + 7 * 3600 * 1000; // this machine is 7 h behind (wrong time zone)
  const g = google(real);
  const ok = new GoogleSheetClient({ serviceAccount: SA, request: g.request, clock: async () => real });
  assert.equal((await ok.ping()).ok, true);
  assert.equal(g.seen[0], Math.floor(real / 1000));
});

test('a login refused for the clock says so (GOOGLE_CLOCK_SKEW), instead of a generic auth failure', async () => {
  const g = google(Date.now() + 7 * 3600 * 1000);
  const local = new GoogleSheetClient({ serviceAccount: SA, request: g.request }); // the machine clock
  await assert.rejects(local.ping(), (e) => e.code === 'GOOGLE_CLOCK_SKEW' && /lệch/.test(e.message) && /múi giờ/.test(e.message));
  const other = new GoogleSheetClient({ serviceAccount: SA, request: async () => ({ status: 401, json: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } }) });
  await assert.rejects(other.ping(), (e) => e.code === 'GOOGLE_AUTH_FAILED' && /invalid_client|not found/.test(e.message), 'other refusals keep Google\'s reason');
});

test('a clock that fails falls back to the machine clock; a transport failure is GOOGLE_NETWORK', async () => {
  const g = google(Date.now());
  const c = new GoogleSheetClient({ serviceAccount: SA, request: g.request, clock: async () => { throw new Error('offline'); } });
  assert.equal((await c.ping()).ok, true);
  const down = new GoogleSheetClient({ serviceAccount: SA, request: async () => { const e = new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'); e.code = 'ENOTFOUND'; throw e; } });
  await assert.rejects(down.ping(), (e) => e.code === 'GOOGLE_NETWORK' && /ENOTFOUND/.test(e.message) && /proxy/.test(e.message));
});

test('wiring: the packaged generator uses electron net + trusted time for the Sheet; the chip names the cause', () => {
  const main = read('tools/license-generator/ui-main.cjs');
  assert.match(main, /const \{ app, BrowserWindow, ipcMain, clipboard, net \} = require\('electron'\);/);
  assert.match(main, /new GoogleSheetClient\(\{ serviceAccount: sa, spreadsheetId, sheetId, request: netRequest, clock: sheetClock \}\)/);
  assert.match(main, /new TrustedTimeProvider\(\{ fetchDateHeader: netDateHeader \}\)/);
  assert.match(main, /delete h\['Content-Length'\]/);
  const ui = read('tools/license-generator/ui.js');
  assert.match(ui, /GOOGLE_CLOCK_SKEW: 'Sheet: lệch giờ máy'/);
  assert.match(ui, /GOOGLE_NETWORK: 'Sheet: không kết nối mạng'/);
});
