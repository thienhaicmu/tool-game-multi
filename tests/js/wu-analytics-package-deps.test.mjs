// WU-ANALYTICS-PACKAGE-DEPS — guard against the "works from source, crashes when packaged" class
// of bug: the Analytics installer enumerates individual desktop/protocol/*.cjs files (it does NOT
// ship the whole protocol dir), so EVERY protocol module transitively required by packaged Analytics
// code must be listed in electron-builder.analytics.json "files". (Caught aviator-context.cjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron-builder.analytics.json'), 'utf8'));
const files = cfg.files || [];

// Protocol files explicitly whitelisted in the installer (basenames).
const listedProtocol = new Set(
  files.filter((f) => /^desktop\/protocol\/[^/]+\.cjs$/.test(f)).map((f) => path.basename(f)),
);
// desktop/analytics/**/* is a glob, so all analytics modules are packaged.
const analyticsGlobbed = files.includes('desktop/analytics/**/*');

// Which protocol modules does one file require?
//  - fromProtocol=false (analytics module): only `../protocol/NAME.cjs` counts (a sibling `./NAME`
//    is another ANALYTICS module, packaged via the analytics glob — not a protocol dep).
//  - fromProtocol=true (protocol module): a sibling `./NAME.cjs` is a protocol->protocol dep.
function protocolRequiresOf(absFile, fromProtocol) {
  const src = fs.readFileSync(absFile, 'utf8');
  const out = new Set();
  for (const m of src.matchAll(/require\((['"])\.\.\/protocol\/([\w-]+\.cjs)\1\)/g)) out.add(m[2]);
  if (fromProtocol) for (const m of src.matchAll(/require\((['"])\.\/([\w-]+\.cjs)\1\)/g)) out.add(m[2]);
  return out;
}

test('Analytics installer ships every protocol module its packaged code requires (transitively)', () => {
  assert.ok(analyticsGlobbed, 'desktop/analytics/**/* must be packaged');
  const analyticsDir = path.join(ROOT, 'desktop', 'analytics');
  const protocolDir = path.join(ROOT, 'desktop', 'protocol');

  // 1) Collect protocol deps directly required by packaged analytics modules.
  const needed = new Set();
  for (const f of fs.readdirSync(analyticsDir).filter((f) => f.endsWith('.cjs'))) {
    for (const dep of protocolRequiresOf(path.join(analyticsDir, f), false)) needed.add(dep);
  }
  // 2) Close over transitive protocol->protocol requires.
  const queue = [...needed];
  while (queue.length) {
    const name = queue.shift();
    const p = path.join(protocolDir, name);
    if (!fs.existsSync(p)) continue;
    for (const dep of protocolRequiresOf(p, true)) if (!needed.has(dep)) { needed.add(dep); queue.push(dep); }
  }

  // 3) Every needed protocol module must be listed in the installer files.
  const missing = [...needed].filter((n) => !listedProtocol.has(n));
  assert.deepEqual(missing, [], `Analytics installer "files" is missing protocol deps: ${missing.join(', ')}`);
});

test('aviator-context.cjs specifically is present (regression for the context-loss WU)', () => {
  assert.ok(listedProtocol.has('aviator-context.cjs'),
    'aviator-context.cjs must be in electron-builder.analytics.json files (live-state.cjs requires it)');
});
