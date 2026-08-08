'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { instancePaths, sanitizeInstanceId } = require('./paths.cjs');
const { RuntimeLock } = require('./runtime-lock.cjs');

function argvValue(argv, name) {
  const prefix = `--${name}=`;
  const hit = (argv || []).find((arg) => String(arg || '').startsWith(prefix));
  return hit ? String(hit).slice(prefix.length).trim() : '';
}

class InstanceManager {
  constructor({ baseUserDataPath, argv = process.argv, env = process.env } = {}) {
    if (!baseUserDataPath) throw new Error('baseUserDataPath is required');
    this.baseUserDataPath = String(baseUserDataPath);
    this.argv = argv;
    this.env = env;
    this.registryPath = path.join(this.baseUserDataPath, 'instances.json');
  }

  resolveInstanceId() {
    return sanitizeInstanceId(argvValue(this.argv, 'instance-id') || this.env.OBSERVATORY_INSTANCE_ID || randomUUID());
  }

  start() {
    const instanceId = this.resolveInstanceId();
    const paths = instancePaths(this.baseUserDataPath, instanceId);
    fs.mkdirSync(paths.root, { recursive: true });
    fs.mkdirSync(paths.sessions, { recursive: true });
    fs.mkdirSync(paths.appData, { recursive: true });
    const lock = new RuntimeLock(paths.runtimeLock, { instanceId, root: paths.root });
    const acquired = lock.acquire();
    if (!acquired.ok) return { ok: false, error: acquired.error, instanceId, paths };
    const rec = this.upsertRegistry(instanceId, paths);
    return { ok: true, instanceId, paths, registry: rec, lock };
  }

  readRegistry() {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf8'));
      return Array.isArray(data.instances) ? data : { instances: [] };
    } catch {
      return { instances: [] };
    }
  }

  writeRegistry(registry) {
    fs.mkdirSync(path.dirname(this.registryPath), { recursive: true });
    fs.writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), 'utf8');
  }

  upsertRegistry(instanceId, paths) {
    const registry = this.readRegistry();
    const now = new Date().toISOString();
    let rec = registry.instances.find((item) => item.instanceId === instanceId);
    if (!rec) {
      rec = { instanceId, name: `Session ${registry.instances.length + 1}`, createdAt: now };
      registry.instances.push(rec);
    }
    Object.assign(rec, { lastUsedAt: now, root: paths.root, appPid: process.pid });
    this.writeRegistry(registry);
    return rec;
  }
}

module.exports = { InstanceManager, argvValue };
