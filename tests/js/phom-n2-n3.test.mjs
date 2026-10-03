// N2 — performance: a game frame never makes the cluster rebuild + send its snapshot (it was ~15/s per browser).
// N3 — security: only the tool's own bar can act — a per-run secret, the binding kept private, trusted clicks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PhomClusterCdpManager } = require('../../desktop/protocol/phom/phom-cluster-cdp-manager.cjs');
const gh = require('../../desktop/protocol/phom/game-header.cjs');
const root = new URL('../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

async function openCluster() {
  let n = 0;
  const routed = [];
  const mgr = new PhomClusterCdpManager({
    now: () => 1,
    openProfile: async () => ({ ok: true, runId: 'BR-' + (++n) }),
    getRunClient: () => ({}),
    hostSession: { routeFrame: (run) => routed.push(run.id), active: () => true },
  });
  mgr.createCluster({ profiles: [{ slot: 'A' }, { slot: 'B' }, { slot: 'C' }] });
  await mgr.openCluster();
  return { mgr, routed };
}

test('N2: 1000 game frames route to the session but never emit a cluster update', async () => {
  const { mgr, routed } = await openCluster();
  let updates = 0; mgr.on('update', () => updates++);
  for (let i = 0; i < 1000; i++) mgr.ingestEvent('BR-' + ((i % 3) + 1), { raw: '[5,{}]', seq: i });
  assert.equal(routed.length, 1000, 'every frame still reaches the Phỏm session');
  assert.equal(updates, 0, 'no snapshot + IPC per frame');
});

test('N2: a real change is announced once; an unchanged snapshot is not re-sent', async () => {
  const { mgr } = await openCluster();
  let updates = 0; mgr.on('update', () => updates++);
  mgr.markRunClosed('BR-2', 'USER_CLOSED_WINDOW');
  assert.equal(updates, 1);
  mgr.markRunClosed('BR-2', 'USER_CLOSED_WINDOW'); // same state again
  assert.equal(updates, 1, 'identical snapshot not re-emitted');
});

test('N3: the bar carries a per-run secret only its closure knows, takes the binding private, acts on trusted clicks only', () => {
  const boot = gh.bootScript({ nonce: 'k-123', runId: 'r1' });
  assert.match(boot, /const KEY = "k-123";/);
  assert.match(boot, /__send = window\[BID\]; try \{ delete window\[BID\]; \} catch\(e\)\{\}/, 'binding removed from window');
  assert.match(boot, /key: KEY \}, extra\|\|\{\}\)\)\)/, 'every action carries the key');
  assert.match(boot, /action:'__HEADER_STATUS'[^)]*key: KEY/, 'the DOM-presence signal too');
  assert.match(boot, /if\(ev && ev\.isTrusted === false\) return;/, 'a script-dispatched click is ignored');
  assert.equal(/window\.__phomKey|window\.KEY/.test(boot), false, 'the key is never put on window');
  assert.doesNotThrow(() => new Function(boot));
});

test('N3: main gives each attach a fresh random key, keeps every issued key for the run, refuses any other caller first', () => {
  const main = read('desktop/phom-main.cjs');
  assert.match(main, /const headerKey = crypto\.randomBytes\(16\)\.toString\('hex'\);/);
  assert.match(main, /\(headerKeys\[String\(run\.id\)\] \|\| \(headerKeys\[String\(run\.id\)\] = new Set\(\)\)\)\.add\(headerKey\)/);
  const r = main.slice(main.indexOf('async function phomHeaderAction('), main.indexOf("if (action === '__HEADER_STATUS')"));
  assert.match(r, /!keys\.has\(payload\.key\)/, 'checked before anything else, the DOM-status signal included');
  assert.match(r, /code: 'PHOM_HEADER_FORGED'/);
  assert.match(read('desktop/protocol/phom/phom-header-bridge.cjs'), /window\.__phomHeaderInstalled === true/, 'presence no longer needs the (now private) binding');
});
