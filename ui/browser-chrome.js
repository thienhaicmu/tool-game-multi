'use strict';

// CONTROL-V3 — minimal browser chrome for a profile's external window. It binds Back / Forward /
// Reload / Home / address to THIS window's run only (runId comes from the query string set by
// BrowserWindowHost). All navigation goes through the run's own webContents in main; this page
// never touches page content or any protocol/CDP surface.
(function () {
  var api = window.browserChrome;
  var runId = new URLSearchParams(location.search).get('runId') || '';

  var back = document.getElementById('back');
  var fwd = document.getElementById('fwd');
  var reload = document.getElementById('reload');
  var home = document.getElementById('home');
  var addr = document.getElementById('addr');

  if (!api) return; // opened without preload — inert

  function nav(action, url) { api.nav(runId, action, url).catch(function () {}); }

  back.onclick = function () { nav('back'); };
  fwd.onclick = function () { nav('forward'); };
  reload.onclick = function () { nav('reload'); };
  home.onclick = function () { nav('home'); };
  addr.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { nav('go', addr.value); addr.blur(); }
  });

  // Reflect the site's real navigation state (URL + can-go flags) pushed by main on every
  // did-navigate, so the address bar and Back/Forward always match reality.
  function apply(state) {
    if (!state || state.runId !== runId) return;
    if (document.activeElement !== addr) addr.value = state.url || '';
    back.disabled = !state.canGoBack;
    fwd.disabled = !state.canGoForward;
  }
  api.onUrl(apply);

  // On (re)load, ask main for the current state so the bar is correct immediately.
  if (api.navState) api.navState(runId).then(function (s) { if (s && s.ok) apply({ runId: runId, url: s.url, canGoBack: s.canGoBack, canGoForward: s.canGoForward }); }).catch(function () {});
})();
