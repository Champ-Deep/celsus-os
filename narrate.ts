// Celsus OS, narration. The LLM writes the authored view for one entity from the resolved graph.
// Input to the model is names only: titles, kinds, counts, aliases. No note bodies. Jev already judged; the LLM explains.
//   node narrate.ts "SPAN Global Services"
import fs from 'node:fs';
import path from 'node:path';
import { readVault, normalizeKey, VAULT_ROOT, ensureDir, todayRunDir, RUNS, latestRunWith } from './vault.ts';
import { buildGlossary } from './glossary.ts';
import { chat, extractJson } from './llm.ts';
import { requireConfig } from './config.ts';

const name = process.argv[2];
if (!name) { console.error('usage: node narrate.ts "<entity title>"'); process.exit(1); }
const RUN = todayRunDir();

function loadJson(p: string, fallback: any) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }

async function main() {
  const cfg = requireConfig();
  const notes = readVault();
  const g = buildGlossary(notes);
  const ids = g.byKey.get(normalizeKey(name)) || [];
  if (!ids.length) { console.error('no entity named ' + name); process.exit(1); }
  const id = ids[0]; const e = g.byId.get(id)!;
  const res = loadJson(path.join(latestRunWith('resolutions.json') || RUN, 'resolutions.json'), { entries: {} });
  const owners = loadJson(path.join(latestRunWith('suggested-edges.json') || RUN, 'suggested-edges.json'), { edges: [] });
  const resolve = (t: string) => { const k = normalizeKey(t.split('/').pop()!); return res.entries[k] || (g.byKey.get(k) || [])[0]; };
  const inbound = new Map<string, number>(); const byKind: Record<string, Map<string, number>> = {};
  for (const n of notes) for (const l of n.links) { const t = resolve(l.target); if (t === id && n.path !== id) { inbound.set(n.path, (inbound.get(n.path) || 0) + 1); const k = g.byId.get(n.path)?.kind || 'note'; (byKind[k] ||= new Map()).set(n.path, (byKind[k].get(n.path) || 0) + 1); } }
  const self = notes.find(n => n.path === id)!;
  const outbound = Array.from(new Set(self.links.map(l => resolve(l.target)).filter(Boolean))).map(p => g.byId.get(p!)).filter(Boolean).slice(0, 25);
  const top = (k: string, n = 6) => Array.from((byKind[k] || new Map()).entries()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([p, c]) => ({ title: g.byId.get(p)?.title, links: c }));
  const aliases = Object.entries(res.entries).filter(([, v]) => v === id).map(([k]) => k).filter(k => k !== normalizeKey(e.title));
  const suggested = owners.edges.filter((x: any) => x.target === id).map((x: any) => ({ effort: g.byId.get(x.source)?.title, p: x.p, band: x.band }));
  const words = fs.readFileSync(path.join(VAULT_ROOT, id), 'utf8').split(/\s+/).length;
  const dossier = { entity: e.title, kind: e.kind, path: id, aliases, inbound_links: [...inbound.values()].reduce((a, b) => a + b, 0), linked_from_people: top('person'), linked_from_efforts: top('effort'), linked_from_clients: top('client'), links_out_to: outbound.map(o => ({ title: o!.title, kind: o!.kind })), suggested_owner_edges: suggested, note_words: words, frontmatter_fields: Object.keys(self.frontmatter) };
  const system = 'You write the authored view for one entity in a personal knowledge graph called Celsus. You receive a dossier of names, kinds and counts (no note bodies). Write for the vault owner, plainly, no hype, no em dashes. Never invent facts beyond the dossier. Return JSON only: {"prose": "2 to 4 sentences with [[wikilinks]] to entities in the dossier", "stats": [{"label": "...", "value": "..."}] (max 4), "cards": [{"title": "...", "why": "..."}] (max 3, the most useful neighbours), "next_action": "one sentence: the single most useful thing to do about this entity now, e.g. fill a stub, confirm a suggested edge, create a missing note"}';
  const r = await chat([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(dossier) }], { json: true });
  const view = extractJson(r.content);
  const NARR = path.join(RUNS, 'narrations'); ensureDir(NARR);
  fs.writeFileSync(path.join(NARR, e.title.replace(/[\/\\]/g, '-') + '.json'), JSON.stringify({ model: r.model, latencyMs: r.latencyMs, at: new Date().toISOString(), usage: r.usage, dossier, view, raw: view ? undefined : r.content }, null, 1));
  console.log(JSON.stringify({ model: r.model, latencyMs: r.latencyMs, usage: r.usage && { prompt: r.usage.prompt_tokens, completion: r.usage.completion_tokens, cost: r.usage.cost }, reasoningChars: r.reasoningChars }));
  console.log(view ? JSON.stringify(view, null, 1) : 'NO JSON, raw:\n' + r.content);
}
main().catch(e => { console.error(e); process.exit(1); });
