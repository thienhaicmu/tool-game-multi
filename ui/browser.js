const view = document.querySelector('#view'); const address = document.querySelector('#address');
function navigate(value) { let url = value.trim(); if (!url) return; if (!/^https?:\/\//i.test(url)) url = 'https://' + url; view.src = url; address.value = url; }
address.addEventListener('keydown', event => { if (event.key === 'Enter') navigate(address.value); });
document.querySelector('#back').onclick = () => view.goBack(); document.querySelector('#forward').onclick = () => view.goForward(); document.querySelector('#reload').onclick = () => view.reload();
view.addEventListener('did-navigate', event => { address.value = event.url; }); view.addEventListener('did-navigate-in-page', event => { address.value = event.url; });
window.desktopCapture?.onBrowserTarget(navigate);
window.desktopCapture?.onBrowserReplay(async (token, payload) => {
  try {
    const code = `(async()=>{const r=await fetch(${JSON.stringify(payload.url)},${JSON.stringify({ method: payload.method || 'GET', headers: payload.headers || {}, body: ['GET','HEAD'].includes(payload.method || 'GET') ? undefined : payload.body, credentials:'include' })});return {ok:true,status:r.status,statusText:r.statusText,bodyPreview:(await r.text()).slice(0,4000)}})()`;
    const result = await view.executeJavaScript(code, true); await window.desktopCapture.browserReplayResult(token, result);
  } catch (error) { await window.desktopCapture.browserReplayResult(token, { ok: false, error: String(error.message || error) }); }
});
