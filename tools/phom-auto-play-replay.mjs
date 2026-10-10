import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { nextStep, stepKey } = require('../desktop/protocol/phom/phom-auto-play.cjs');

// Read-only replay of decision records; never connects to a game or executes a move.
export function replay(lines) {
  return lines.filter((line) => line.trim() && !line.startsWith('#')).flatMap((line, index) => {
    let entry; try { entry = JSON.parse(line); } catch { throw new Error(`Invalid JSON at line ${index + 1}`); }
    if (entry.event !== 'auto-play-decision') return [];
    const step = nextStep(entry.snapshot, entry.uid, entry.offered, new Set(entry.avoid || []), entry.toolUids || [], entry.options || {});
    return [{ runId: entry.runId, recorded: entry.step, replayed: step, same: stepKey(step) === stepKey(entry.step) }];
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.argv[2]) { console.error('Usage: node tools/phom-auto-play-replay.mjs <coseat.jsonl>'); process.exitCode = 1; }
  else {
    const results = replay(fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/));
    console.log(JSON.stringify({ decisions: results.length, changed: results.filter((r) => !r.same).length, results }, null, 2));
  }
}
