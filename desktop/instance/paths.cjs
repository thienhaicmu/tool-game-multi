'use strict';

const path = require('node:path');

function sanitizeInstanceId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
}

function instancePaths(baseUserDataPath, instanceId) {
  const safeId = sanitizeInstanceId(instanceId);
  if (!safeId) throw new Error('instanceId is required');
  const root = path.join(String(baseUserDataPath), 'instances', safeId);
  return {
    instanceId: safeId,
    root,
    appData: path.join(root, 'app'),
    sessions: path.join(root, 'sessions'),
    cookieVault: path.join(root, 'cookie-vault.json'),
    windowState: path.join(root, 'window-state.json'),
    chromeProfile: path.join(root, 'chrome-profile'),
    runtimeLock: path.join(root, 'runtime.lock.json'),
  };
}

module.exports = { instancePaths, sanitizeInstanceId };
