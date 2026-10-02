// Celsus OS, owner edges. Every effort hub note without a company in its frontmatter gets one Choice call:
// which company or client owns it, judged from the title, tags and the names of the notes it links to. No body text.
// Output: suggested-edges.json in the run folder. Edge kind `owner_suggested`, never mistaken for a human wikilink.
//
//   node suggest-owners.ts --live [--concurrency 6] [--out DIR]
import fs from 'node:fs';
import path from 'node:path';
import { readVault, normalizeKey, ensureDir, todayRunDir } from './vault.ts';
import { buildGlossary } from './glossary.ts';
import { decide, decideAll, JEV_MODEL } from './jev.ts';
import type { Question } from './jev.ts';
import { labelIndex } from './policy.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIVE = flag('--live');
const CONCURRENCY = parseInt(opt('--concurrency', '6'), 10);
const OUT = opt('--out', todayRunDir());
const BANDS = { auto: 0.9, review: 0.6 };

async function main() {
  const notes = readVault();
  const g = buildGlossary(notes);
  const byPath = new Map(notes.map(n => [n.path, n]));
  const owners = g.entities.filter(e => (e.kind === 'company' || e.kind === 'client')).sort((a, b) => a.title.localeCompare(b.title)).slice(0, 254);
  const criteria: Record<string, string> = {};
  const keyToId: Record<string, string> = {};
  owners.forEach((e, i) => { const k = `o${i + 1}`; keyToId[k] = e.id; criteria[k] = `${e.title} (${e.kind}${e.aliases.length ? '; also ' + e.aliases.slice(0, 4).join(', ') : ''})`; });
  criteria.none = 'No single company or client owns this, or it belongs to one not listed';
  const q: Record<string, Question> = { owner: { type: 'choice', instructions: 'Which company or client does this effort belong to? Judge from the title, tags and the notes it links to.', criteria } };
  const labels = labelIndex();
  // Every effort without a company gets an owner question, except finished or archived work: naming an
  // owner on something that is already done is noise. The exclusion is by segment name, not by path,
  // so it holds in a vault that does not use an Efforts folder.
  const finished = /(completed|done|archive|archived)/i;
  const targets = g.entities.filter(e => e.kind === 'effort' && !finished.test(e.id) && !byPath.get(e.id)?.company && !labels.has('owner:' + e.id));
  const items = targets.map(e => {
    const n = byPath.get(e.id)!;
    const linked = Array.from(new Set(n.links.map(l => l.target.split('/').pop()!).filter(t => g.byKey.has(normalizeKey(t))))).slice(0, 20);
    return { id: e.id, state: { title: e.title, tags: n.tags.slice(0, 10), links_to: linked } };
  });
  console.log(`${items.length} active efforts have no company set${LIVE ? ', asking Jev' : ' (dry run, no calls)'}`);
  ensureDir(OUT);
  if (!LIVE) { fs.writeFileSync(path.join(OUT, 'suggested-edges.json'), JSON.stringify({ generated: new Date().toISOString(), dryRun: true, targets: items }, null, 1)); return; }
  const results = await decideAll(items, it => decide(it.state, q), CONCURRENCY);
  const edges: any[] = []; const bands: Record<string, number> = {}; let cost = 0; let model = JEV_MODEL;
  results.forEach((r, i) => {
    const it = items[i];
    if ('error' in r) { bands.unavailable = (bands.unavailable || 0) + 1; return; }
    const a = r.answers.owner; if (a.type !== 'choice') return;
    cost += r.usage?.cost || 0; model = r.model || model;
    const p = a.probabilities[a.choice] ?? 0;
    const band = a.choice === 'none' ? 'none' : p >= BANDS.auto ? 'auto' : p >= BANDS.review ? 'review' : 'ignore';
    bands[band] = (bands[band] || 0) + 1;
    if (a.choice === 'none' || band === 'ignore') return;
    edges.push({ source: it.id, target: keyToId[a.choice], kind: 'owner_suggested', p: +p.toFixed(3), confidence: a.confidence, band, model: r.model, decision_id: r.id, latencyMs: r.latencyMs });
  });
  fs.writeFileSync(path.join(OUT, 'suggested-edges.json'), JSON.stringify({ generated: new Date().toISOString(), model, bands: BANDS, counts: bands, cost, edges }, null, 1));
  console.log(JSON.stringify({ asked: items.length, counts: bands, edges: edges.length, cost: +cost.toFixed(4) }));
  for (const e of edges.filter(e => e.band === 'auto').slice(0, 12)) console.log(`  ${e.source.split('/').slice(-1)[0]}  ->  ${g.byId.get(e.target)?.title}  (${e.p})`);
}
main().catch(e => { console.error(e); process.exit(1); });
