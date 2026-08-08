'use strict';

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
