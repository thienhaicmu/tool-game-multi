// Offline Phỏm simulator (plan GĐ3 · S4). Never connects to a game.
//   node tools/phom-sim/run.mjs --rounds 2000 --seed 1 --seats TTTL [--low-money] [--ca-u] [--outsider-ref 0a0fa30] [--out file.json]
// --outsider-ref: the L seats play the chooser of that commit (read with git show), so a change is measured on the tool side only.
// seats: T = tool account (Tự đánh, shares cards with the other T), L = outsider (normal scenario, own cards only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { simulate, report } = require('./sim.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const cfg = {
  rounds: Number(opt('rounds', 200)), seed: Number(opt('seed', 1)), seats: opt('seats', 'TTTL'),
  strategy: { lowMoney: flag('low-money'), twoPhomCaU: flag('ca-u') },
};
// the outsiders' chooser as released at a commit: its self-contained protocol/phom modules, extracted to a temp folder
function chooserAt(ref) {
  const files = ['phom-auto-play', 'phom-play-help', 'phom-safe-card-analyzer', 'card-codec', 'phom-rules'];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phom-sim-' + ref.replace(/[^\w]/g, '') + '-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f + '.cjs'), execFileSync('git', ['show', ref + ':desktop/protocol/phom/' + f + '.cjs']));
  return require(path.join(dir, 'phom-auto-play.cjs'));
}
const ref = opt('outsider-ref');
if (ref) cfg.outsider = chooserAt(ref);
const out = report(simulate(cfg));
out.outsiderRef = ref || null;
const text = JSON.stringify(out, null, 2);
if (opt('out')) fs.writeFileSync(opt('out'), text + '\n');
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(3);
console.log(`${out.seats} · ${out.rounds} ván · seed ${out.seed}${ref ? ' · acc lạ = ' + ref : ''} · ${out.msPerRound.toFixed(0)} ms/ván`);
console.log(`Nhóm tool: ${f(out.toolNet.mean)} ± ${out.toolNet.ci95.toFixed(3)} cược/ván`);
for (const p of out.players) console.log(`  ${p.uid}: ${f(p.net.mean)} ± ${p.net.ci95.toFixed(3)} · nhất ${(p.win * 100).toFixed(1)}% · móm ${(p.mom * 100).toFixed(1)}% · ù ${(p.u * 100).toFixed(1)}% · đền ${(p.den * 100).toFixed(2)}% · cho ăn ${p.eatsGiven.toFixed(2)} (chốt ${p.chotGiven.toFixed(3)}) · ăn ${p.eatsTaken.toFixed(2)}`);
console.log(`Bất thường (live = Tự đánh dừng): ${out.anomalyPerRound.toFixed(3)}/ván`);
for (const a of out.anomalies.slice(0, 10)) console.log(`  ${a.count} × ${a.why}`);
