// Celsus OS, missed connections. Pairs of entity notes that never link to each other but share neighbours
// (or title tokens) are shown to Jev, names only, and come back as part_of, related (worth a link) or unrelated.
//   node suggest-links.ts --live [--limit 150] [--min-shared 3]
import fs from 'node:fs';
import path from 'node:path';
import { readVault, normalizeKey, VAULT_ROOT, ensureDir, todayStamp, latestRunWith } from './vault.ts';
import { buildGlossary } from './glossary.ts';
import { tokens } from './match.ts';
import { decide, decideAll } from './jev.ts';
import type { Question } from './jev.ts';
import { labelIndex } from './policy.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIVE = flag('--live');
const LIMIT = parseInt(opt('--limit', '150'), 10);
const MIN_SHARED = parseInt(opt('--min-shared', '3'), 10);
const OUT = opt('--out', path.join(VAULT_ROOT, 'Efforts', 'Active', 'Celsus OS', 'runs', todayStamp()));
const ENTITY_KINDS = new Set(['company', 'person', 'product', 'client', 'effort', 'project']);

async function main() {
  const notes = readVault();
  const g = buildGlossary(notes);
  const res = (() => { try { return JSON.parse(fs.readFileSync(path.join(latestRunWith('resolutions.json') || OUT, 'resolutions.json'), 'utf8')).entries; } catch { return {}; } })();
  const resolve = (t: string) => { const k = normalizeKey(t.split('/').pop()!); return res[k] || (g.byKey.get(k) || [])[0]; };
  // neighbourhoods over resolved links, both directions
  const nb = new Map<string, Set<string>>();
  const add = (a: string, b: string) => { if (!a || !b || a === b) return; (nb.get(a) || nb.set(a, new Set()).get(a)!).add(b); (nb.get(b) || nb.set(b, new Set()).get(b)!).add(a); };
  // Only entity notes count as neighbours. Daily notes, MOCs, reports and structural files connect everything to everything.
  const isEntity = (id: string | undefined) => { if (!id) return false; const e = g.byId.get(id); if (!e || !ENTITY_KINDS.has(e.kind)) return false; return !/MOC|Vault-Report|Findability|^Calendar\//.test(e.title + ' ' + id); };
  for (const n of notes) for (const l of n.links) { const t = resolve(l.target); if (isEntity(n.path) && isEntity(t)) add(n.path, t); }
  const ents = g.entities.filter(e => ENTITY_KINDS.has(e.kind) && (nb.get(e.id)?.size || 0) >= 2);
  const inbound = new Map<string, number>(); for (const n of notes) for (const l of n.links) { const t = resolve(l.target); if (t) inbound.set(t, (inbound.get(t) || 0) + 1); }
  // candidate pairs: share >= MIN_SHARED neighbours and no direct link, or share a rare title token
  const pairs: { a: string; b: string; shared: string[]; score: number; via: string }[] = [];
  const index = new Map<string, string[]>(); // neighbour -> entities that touch it
  for (const e of ents) for (const x of nb.get(e.id)!) (index.get(x) || index.set(x, []).get(x)!).push(e.id);
  const seen = new Set<string>();
  for (const [, members] of index) {
    if (members.length > 25) continue; // hubs like Lake B2B connect everyone; sharing them means nothing
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j]; const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key)) continue; seen.add(key);
      if (nb.get(a)!.has(b)) continue;
      const shared = [...nb.get(a)!].filter(x => nb.get(b)!.has(x) && (index.get(x)?.length || 0) <= 25);
      if (shared.length < MIN_SHARED) continue;
      const jac = shared.length / new Set([...nb.get(a)!, ...nb.get(b)!]).size;
      pairs.push({ a, b, shared, score: +(shared.length * Math.sqrt(jac)).toFixed(3), via: 'neighbours' });
    }
  }
  // title token overlap for pairs without shared neighbours (rare tokens only)
  const tokIndex = new Map<string, string[]>();
  for (const e of ents) for (const t of new Set(tokens(normalizeKey(e.title)))) if (t.length > 3) (tokIndex.get(t) || tokIndex.set(t, []).get(t)!).push(e.id);
  for (const [t, members] of tokIndex) {
    if (members.length < 2 || members.length > 6) continue;
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
      const a = members[i], b = members[j]; const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key) || nb.get(a)!.has(b)) continue; seen.add(key);
      pairs.push({ a, b, shared: [], score: 1, via: 'title:' + t });
    }
  }
  const labels = labelIndex();
  pairs.sort((x, y) => y.score - x.score);
  const chosen = pairs.filter(p => !labels.has('link:' + p.a + '|' + p.b)).slice(0, LIMIT);
  console.log(`${pairs.length} candidate pairs, judging ${chosen.length}${LIVE ? '' : ' (dry run)'}`);
  ensureDir(OUT);
  if (!LIVE) { fs.writeFileSync(path.join(OUT, 'suggested-links.json'), JSON.stringify({ generated: new Date().toISOString(), dryRun: true, candidates: chosen.map(p => ({ a: g.byId.get(p.a)!.title, b: g.byId.get(p.b)!.title, shared: p.shared.map(s => g.byId.get(s)?.title || s).slice(0, 8), score: p.score, via: p.via })) }, null, 1)); return; }
  const q: Record<string, Question> = { relation: { type: 'choice', instructions: 'Two notes in a personal knowledge vault never link to each other. Given their titles, kinds, and the notes they both link to, what is the relationship?', criteria: { a_part_of_b: 'A is a part, document, sub project, meeting or member of B', b_part_of_a: 'B is a part, document, sub project, meeting or member of A', related: 'Distinct things that work together directly (a person and the effort they run, a client and the product they bought); a link between them would tell the reader something', siblings: 'Both belong to the same parent or portfolio and only share it; a link adds nothing', unrelated: 'They only share generic neighbours; no link needed', unclear: 'Cannot tell from names alone' } } };
  const items = chosen.map(p => ({ p, state: { A: { title: g.byId.get(p.a)!.title, kind: g.byId.get(p.a)!.kind }, B: { title: g.byId.get(p.b)!.title, kind: g.byId.get(p.b)!.kind }, both_link_to: p.shared.map(s => g.byId.get(s)?.title || s.split('/').pop()).slice(0, 8), shared_count: p.shared.length, found_via: p.via } }));
  const results = await decideAll(items, it => decide(it.state, q), 8);
  const edges: any[] = []; const counts: Record<string, number> = {}; let cost = 0;
  results.forEach((r, i) => {
    const it = items[i];
    if ('error' in r) { counts.error = (counts.error || 0) + 1; return; }
    const a = r.answers.relation; if (a.type !== 'choice') return; cost += r.usage?.cost || 0;
    const p = a.probabilities[a.choice] ?? 0; counts[a.choice] = (counts[a.choice] || 0) + 1;
    const band = p >= 0.85 ? 'auto' : p >= 0.6 ? 'review' : 'ignore';
    edges.push({ a: it.p.a, b: it.p.b, a_title: it.state.A.title, b_title: it.state.B.title, relation: a.choice, p: +p.toFixed(3), confidence: a.confidence, band, shared: it.state.both_link_to, via: it.p.via, decision_id: r.id, human_label: '' });
  });
  fs.writeFileSync(path.join(OUT, 'suggested-links.json'), JSON.stringify({ generated: new Date().toISOString(), counts, cost, edges }, null, 1));
  console.log(JSON.stringify({ judged: edges.length, counts, cost: +cost.toFixed(4) }));
  for (const e of edges.filter(e => e.band === 'auto' && e.relation !== 'unrelated').slice(0, 14)) console.log(`  ${e.a_title}  ${e.relation}  ${e.b_title}  (${e.p}) via ${e.shared.slice(0, 3).join(', ')}`);
}
main().catch(e => { console.error(e); process.exit(1); });
