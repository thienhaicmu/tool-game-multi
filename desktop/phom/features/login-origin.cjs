'use strict';

// ---------------------------------------------------------------------------
// FEATURE login-origin — once an account is LOGGED IN in a browser:
//  · the origin it is on becomes the profile's Game URL (the game keeps its login in localStorage, which belongs to ONE
//    origin, and the site moves between mirror domains — a profile saved on another mirror asked for a login on every
//    reopen, 2026-10-05). Only the origin is stored, once per change.
//  · the account name is remembered for the profile (it becomes the Chromium profile name on the next launch).
//
// state: session.origin = { lastTopUrl, asked, saved }
// deps:  { profiles: { get(id), update(id, patch) }, accountNames: { set(id, name) → changed }, clientFor(rid), log }
// ---------------------------------------------------------------------------

function originOf(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin + '/' : null; } catch { return null; }
}

function createLoginOriginFeature({ profiles, accountNames, clientFor, log = () => {} }) {
  function rememberAccount(run, b) {
    if (!run || !b || !run.profileId || !b.username || b.username === 'USER_UNKNOWN') return;
    try { if (accountNames().set(run.profileId, b.username)) log('account-name', { runId: run.id, profileId: run.profileId }); } catch { /* best effort */ }
  }
  function rememberOrigin(run, session, b) {
    const o = session.origin;
    if (!run || !b || !b.loggedIn || !profiles()) return;
    if (!o.lastTopUrl) {
      // the page loaded before the tool attached (no navigation seen): ask it once where it is
      const client = clientFor(run.id);
      if (client && !o.asked) {
        o.asked = true;
        client.Runtime.evaluate({ expression: 'location.href', returnByValue: true })
          .then((r) => { const v = r && r.result && r.result.value; if (typeof v === 'string') o.lastTopUrl = v; else o.asked = false; })
          .catch(() => { o.asked = false; });
      }
      return;
    }
    const origin = originOf(o.lastTopUrl);
    if (!origin || o.saved === origin) return;
    o.saved = origin;
    const pid = run.profileId != null ? String(run.profileId) : null;
    const p = pid ? profiles().get(pid) : null;
    if (!p) return;
    const savedOrigin = p.gameUrl ? originOf(p.gameUrl) : null;
    if (savedOrigin === origin) return;
    try { profiles().update(pid, { gameUrl: origin }); log('GAME_URL_FOLLOWS_LOGIN', { runId: run.id, from: savedOrigin, to: origin }); } catch { /* best effort */ }
  }
  return {
    id: 'login-origin',
    push({ run, session, browser }) { rememberOrigin(run, session, browser); rememberAccount(run, browser); },
    // where the game really is: the top document's URL (about:blank = the proxy-auth launch page, not the game)
    documentReplaced({ session, url }) { if (url && !/^about:/i.test(url)) session.origin.lastTopUrl = String(url); },
  };
}

module.exports = { createLoginOriginFeature, originOf };
