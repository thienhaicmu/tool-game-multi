const view = document.querySelector('#view'); const address = document.querySelector('#address');
function navigate(value) { let url = value.trim(); if (!url) return; if (!/^https?:\/\//i.test(url)) url = 'https://' + url; view.src = url; address.value = url; }
address.addEventListener('keydown', event => { if (event.key === 'Enter') navigate(address.value); });
document.querySelector('#back').onclick = () => view.goBack(); document.querySelector('#forward').onclick = () => view.goForward(); document.querySelector('#reload').onclick = () => view.reload();
view.addEventListener('did-navigate', event => { address.value = event.url; }); view.addEventListener('did-navigate-in-page', event => { address.value = event.url; });
window.desktopCapture?.onBrowserTarget(navigate);
