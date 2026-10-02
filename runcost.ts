// Celsus OS, run cost. The one number a person is actually asked for after a pass, so it is measured
// from what the passes wrote rather than estimated in a README that goes stale.
//
// The shape of the problem is the reason this is a module and not a line in one pass. Each pass
// records its own spend in its own file, in its own shape: normalize-entities writes one row per
// classifier call with the cost nested under usage, while suggest-owners and suggest-links each write
// a single total on the object. Reading one row, or an average, or only the file that happened to be
// open, understates the run by an order of magnitude. The report was written by the first pass, so it
// could only ever quote the first pass.
import fs from 'node:fs';
import path from 'node:path';

export interface RunCost {
  total: number;
  byPass: { pass: string; cost: number; detail: string }[];
  notes: number;
  perNote: number;
}

const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readJsonl = (p: string): any[] => {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
};

/**
 * Total spend for one run folder, read back from that folder's own output.
 * Missing files count as zero rather than throwing, so this is safe to call mid-run.
 */
export function runCost(runDir: string, notes: number): RunCost {
  const byPass: RunCost['byPass'] = [];

  // normalize-entities: one JSON object per line, cost under usage. Summed, never sampled.
  const decisions = readJsonl(path.join(runDir, 'decisions.jsonl'));
  byPass.push({
    pass: 'normalize-entities',
    cost: decisions.reduce((a, r) => a + (Number((r.usage || {}).cost) || 0), 0),
    detail: `${decisions.length} classifier calls, cost summed per call`,
  });

  // The other two model passes report one total for the whole pass.
  for (const [file, pass] of [['suggested-edges.json', 'suggest-owners'], ['suggested-links.json', 'suggest-links']] as const) {
    const o = readJson(path.join(runDir, file));
    byPass.push({ pass, cost: Number(o?.cost) || 0, detail: o ? 'one pass total' : 'no output yet' });
  }

  // find-duplicates is local, so it is listed rather than omitted, to keep the row count honest.
  byPass.push({ pass: 'find-duplicates', cost: 0, detail: 'local, no model call' });

  const total = byPass.reduce((a, r) => a + r.cost, 0);
  return { total, byPass, notes, perNote: notes ? total / notes : 0 };
}

/** One markdown block, appended to the run report by whichever pass runs last. */
export function costBlock(c: RunCost, stamp: string): string {
  const rows = c.byPass.map(r => `| ${r.pass} | ${r.cost.toFixed(4)} | ${r.detail} |`);
  const top = [...c.byPass].sort((a, b) => b.cost - a.cost)[0];
  const L: string[] = [
    '', '## What this run cost', '',
    `Measured from this run's own output, not estimated. **Total $${c.total.toFixed(4)}** for ${c.notes.toLocaleString()} notes, which is $${c.perNote.toFixed(6)} a note.`, '',
    '| Pass | USD | Detail |', '|---|---|---|', ...rows, '',
  ];
  // One optional line, appended only when there is a pass worth naming. Appended rather than filtered
  // out of the array above, because stripping every empty string also strips the blank lines that
  // markdown needs before a table.
  if (top.cost > 0) L.push(`${top.pass} is ${Math.round((top.cost / c.total) * 100)}% of the spend, so it is the pass to make optional if you want a cheaper run.`);
  L.push(`Run ${stamp}. Prices move; re-read this after changing the classifier model.`);
  return L.join('\n');
}
