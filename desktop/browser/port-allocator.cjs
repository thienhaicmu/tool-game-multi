'use strict';

// ---------------------------------------------------------------------------
// Per-run CDP port ownership. Each BrowserRun asks the OS for a fresh free port
// (bind :0 → read the assigned port → release), so two runs launched back-to-back
// never collide on a remote-debugging port. The port is handed to exactly one
// chrome.exe via --remote-debugging-port and released implicitly when that Chrome
// exits; there is NO global/shared debugging port.
// ---------------------------------------------------------------------------

const net = require('node:net');

function allocateFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error('No free port allocated')));
    });
  });
}

module.exports = { allocateFreePort };
