// PHASE 6.3.2.1 — SETUP scroll/layout + per-profile Game URL UX. Source-level assertions (no GUI runtime):
// the SETUP surface is a scrollable page + sticky footer (nothing clipped), the profile table gains a
// GAME URL column, the URL is edited in Edit Profile, and the runtime resolves each browser's URL from its
// OWN profile (profileId → gameUrl) both on first open and on reopen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const js = read('ui-phom/phom-qa.js');
const css = read('ui-phom/phom-qa.css');
const main = read('desktop/phom-main.cjs');

function fn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  const rest = src.slice(start + 1);
  const nextIdx = rest.indexOf('\n  function ');
  return rest.slice(0, nextIdx > 0 ? nextIdx : 4000);
}

test('SETUP renders the table panel + the footer (nothing clipped)', () => {
  const s = fn(js, 'renderSetup');
  assert.match(s, /profileTablePanel\(\)/);
  assert.equal(/bulkProxyPanel\(\)/.test(s), false);
  assert.match(js, /id: 'pf-proxy'/);
  assert.match(s, /runGameFooter\(\)/);
  assert.equal(/gamePanel\(\)/.test(js), false, 'no global Game URL panel');
});

test('CSS: the table scrolls inside its panel; the content area is a bounded column', () => {
  assert.match(css, /\.tab-content \{[^}]*flex: 1 1 auto[^}]*min-height: 0/);
  assert.match(css, /\.table-scroll \{[^}]*overflow: auto/);
  assert.equal(/\.table-scroll\s*\{[^}]*max-height/.test(css), false, 'no fixed max-height cap on the table');
});

test('the footer is disabled + warns until every selected profile has its own Game URL', () => {
  const f = fn(js, 'runGameFooter');
  assert.match(f, /el\('footer', \{ class: 'bar' \}/);
  assert.match(f, /missingUrl/);
  assert.match(f, /n === 3 && !missingUrl/);
  assert.match(f, /'Có profile thiếu Game URL'/);
});

test('openCluster validates per-profile Game URL and never prompts at RUN', () => {
  const o = fn(js, 'openCluster');
  assert.match(o, /p\.gameUrl/);                  // checks each selected profile's own URL
  assert.equal(/window\.prompt/.test(o), false, 'no URL prompt at RUN');
});

test('runtime resolves each browser URL from ITS profile (openProfile uses cfg.gameUrl; reopen reuses it)', () => {
  // the cluster openProfile closure navigates to the per-profile gameUrl (never a shared/global URL)
  assert.match(main, /url: localTestActive\(\) \? 'about:blank' : \(\(cfg && cfg\.gameUrl\) \|\| 'about:blank'\)/);
  // reopen goes through clusterOpen (reuses the stored per-profile config incl. gameUrl + user-data-dir)
  const re = fn(js, 'onReopenBrowser');
  assert.match(re, /api\.clusterOpen\(\)/);
  assert.equal(/window\.prompt|gameUrl:/.test(re), false, 'reopen never re-asks the URL');
});

test('per-profile user-data-dir is keyed by the stable profile id (login persists across restarts)', () => {
  assert.match(main, /const udKey = \(profileId != null[^\n]*\) \? String\(profileId\)/);
  assert.match(main, /path\.join\(phomRoot\(\), 'browser-profiles', udKey/);
});
