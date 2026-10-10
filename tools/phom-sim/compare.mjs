// Paired comparison of two simulator outputs (same --seed/--seats, fixed rotation):
//   node tools/phom-sim/compare.mjs before.json after.json
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { paired } = require('./sim.cjs');
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
if (!a || !b) { console.error('Usage: node tools/phom-sim/compare.mjs before.json after.json'); process.exit(1); }
if (a.seed !== b.seed || a.seats !== b.seats) console.warn('cảnh báo: khác seed/bàn — so sánh không theo cặp được');
const d = paired(a, b);
const f = (x) => (x >= 0 ? '+' : '') + x.toFixed(3);
const verdict = d.mean - d.ci95 > 0 ? 'TỐT HƠN (có ý nghĩa)' : d.mean + d.ci95 < 0 ? 'KÉM HƠN (có ý nghĩa)' : 'chưa phân biệt được';
console.log(`${b.seats} · ${d.rounds} ván cặp · nhóm tool ${f(d.mean)} ± ${d.ci95.toFixed(3)} cược/ván → ${verdict}`);
const sumBy = (r, k) => r.players.filter((p) => p.uid[0] === 'T').reduce((s, p) => s + p[k], 0);
for (const k of ['mom', 'u', 'den', 'eatsGiven', 'chotGiven', 'eatsTaken']) console.log(`  ${k}: ${sumBy(a, k).toFixed(4)} → ${sumBy(b, k).toFixed(4)} /ván (tổng các acc tool)`);
console.log(`  bất thường: ${a.anomalyPerRound.toFixed(3)} → ${b.anomalyPerRound.toFixed(3)} /ván`);
