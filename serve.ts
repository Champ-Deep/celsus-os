// Celsus OS, local test server. Zero dependencies. Serves the test UI and a small API over the latest run.
//   node serve.ts [--port 3043]        then open http://localhost:3043
// Reads: latest run folder (resolutions, decisions, suggested links, owner edges, duplicates, narrations).
// Writes: runs/labels.jsonl (every answer) and runs/rules.json (the rule store). Never edits a note.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { readVault, normalizeKey, VAULT_ROOT, latestRunWith, HERE } from './vault.ts';
import type { Note } from './vault.ts';
import { buildGlossary } from './glossary.ts';
import type { Glossary, Entity } from './glossary.ts';
// State location comes from vault.ts, which resolves it from config and then from the shape of the
// folder, and is re-exported here. It used to be redefined in this file as the literal old path, which
// split the brain: policy.ts read and wrote rules under the resolved path while this file wrote every
// answer under the literal, so on a folder with a different shape the first swipe would create a second
// state tree that the learner never reads.
import { writePolicy, POLICY, RUNS, LABELS, RULES } from './policy.ts';
import { chat, extractJson } from './llm.ts';
import { loadConfig, saveConfig } from './config.ts';
import { draftNote, saveNote } from './notes.ts';
import type { NoteKind } from './notes.ts';
import { archiveDuplicate, restoreArchived, listArchived } from './archive.ts';

const args = process.argv.slice(2);
const PORT = parseInt((args[args.indexOf('--port') + 1] || '3043'), 10) || 3043;
const AUTO = { confidence: 0.9, support: 5 };

const loadJson = (p: string | null, fb: any) => { try { return p ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb; } catch { return fb; } };
const loadJsonl = (p: string | null) => { try { return p ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []; } catch { return []; } };
const inRun = (file: string) => { const d = latestRunWith(file); return d ? path.join(d, file) : null; };

// ---------- state ----------
let notes: Note[] = []; let g: Glossary; let byPath = new Map<string, Note>();
let resolutions: Record<string, string> = {}; let ghosts: any[] = [];
let decisions: any[] = []; let links: any[] = []; let owners: any[] = []; let dups: any[] = [];
let inbound = new Map<string, number>(); let nb = new Map<string, Set<string>>();
let labels: any[] = []; let rules: Record<string, any> = {};

function resolve(target: string): string | undefined { const k = normalizeKey(target.split('/').pop()!.replace(/\.md$/i, '')); return resolutions[k] || (g.byKey.get(k) || [])[0]; }

function load() {
  notes = readVault(); g = buildGlossary(notes); byPath = new Map(notes.map(n => [n.path, n]));
  const res = loadJson(inRun('resolutions.json'), { entries: {}, ghosts: [] }); resolutions = res.entries || {}; ghosts = res.ghosts || [];
  decisions = loadJsonl(inRun('decisions.jsonl'));
  links = loadJson(inRun('suggested-links.json'), { edges: [] }).edges || [];
  owners = loadJson(inRun('suggested-edges.json'), { edges: [] }).edges || [];
  dups = loadJson(inRun('duplicates.json'), { rows: [] }).rows || [];
  inbound = new Map(); nb = new Map();
  const add = (a: string, b: string) => { if (!a || !b || a === b) return; (nb.get(a) || nb.set(a, new Set()).get(a)!).add(b); (nb.get(b) || nb.set(b, new Set()).get(b)!).add(a); };
  for (const n of notes) for (const l of n.links) { const t = resolve(l.target); if (t) { inbound.set(t, (inbound.get(t) || 0) + 1); add(n.path, t); } }
  labels = loadJsonl(fs.existsSync(LABELS) ? LABELS : null); rules = loadJson(fs.existsSync(RULES) ? RULES : null, {});
}

// ---------- rule store ----------
function ruleUpdate(pattern: string, choice: string, delta: number) {
  const r = rules[pattern] || (rules[pattern] = { answers: {}, support: 0 });
  r.answers[choice] = Math.max(0, (r.answers[choice] || 0) + delta); r.support = Math.max(0, r.support + delta);
  // An undone answer has to leave no trace. Clamping the counter to 0 is not enough: the key
  // survives, so a choice nobody ever made stays in the answers map, can win the best sort, gets
  // written into the Decision Policy note as "(something) 0", and is briefed to Jev and into
  // Laya's training set. Drop empty answers, and drop the whole rule once nothing is left.
  for (const k of Object.keys(r.answers)) if (!r.answers[k]) delete r.answers[k];
  if (!r.support || !Object.keys(r.answers).length) { delete rules[pattern]; fs.mkdirSync(RUNS, { recursive: true }); return fs.writeFileSync(RULES, JSON.stringify(rules, null, 1)); }
  const best = Object.entries(r.answers).sort((a: any, b: any) => b[1] - a[1])[0] as [string, number] | undefined;
  r.best = best?.[0]; r.confidence = best ? +(((best[1] as number) + 1) / (r.support + 2)).toFixed(3) : 0;
  r.auto = r.confidence >= AUTO.confidence && r.support >= AUTO.support;
  fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(RULES, JSON.stringify(rules, null, 1));
}
const labelled = () => new Map(labels.map(l => [l.id, l]));
function layaInfo() { const f = path.join(RUNS, 'laya', 'train.jsonl'); let n = 0; try { n = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch {} return { examples: n, modelfile: path.join(RUNS, 'laya', 'Modelfile'), base: (loadConfig() as any)?.layaBase || 'llama3.1' }; }

// ---------- cards ----------
function infoLevel(n: Note | undefined, kind: string): number {
  if (!n) return 0;
  const req: Record<string, string[]> = { person: ['role', 'company', 'relationship'], company: ['industry', 'aliases', 'stage'], client: ['status', 'company', 'owner'], product: ['stage', 'tech-stack', 'aliases'], effort: ['status', 'company', 'created'] };
  const fields = req[kind] || ['type', 'tags', 'created']; const filled = fields.filter(f => n.frontmatter[f] != null && String(n.frontmatter[f]).length > 0).length / fields.length;
  const words = Math.min(1, n.words / 400); const out = Math.min(1, new Set(n.links.map(l => resolve(l.target)).filter(Boolean)).size / 5);
  const age = (Date.now() - n.mtimeMs) / 86400000; const fresh = age < 30 ? 1 : age > 365 ? 0.25 : 1 - 0.75 * (age - 30) / 335;
  return +((filled + words + out + fresh) / 4).toFixed(2);
}
const title = (id?: string) => (id && g.byId.get(id)?.title) || id?.split('/').pop()?.replace(/\.md$/, '') || '';
const kind = (id?: string) => (id && g.byId.get(id)?.kind) || 'note';
const kind_ = kind;

// Deck order. 'unsure' surfaces the questions Celsus is least sure about first, which is the
// queue worth a human: those are the ones only Deep can settle. 'impact' is the old blast-radius
// order (shared neighbours, links moved) and is kept because the graph halo is computed from it.
function needScore(c: any) { return (1 - Math.min(Math.max(c.p ?? 1, 0), 1)) * 1000 + (c.impact || 0); }

function buildCards(sort: 'unsure' | 'impact' = 'unsure') {
  const done = labelled(); const cards: any[] = [];
  for (const d of decisions) {
    if (!(d.verdict === 'merge' || (d.verdict === 'review' && d.count >= 2) || (d.verdict === 'new_entity' && d.count >= 5))) continue;
    const top = d.chosenId || d.candidates?.[0]?.id; if (!top && d.verdict !== 'new_entity') continue;
    const c0 = d.candidates?.[0] || {}; const id = 'ent:' + d.key;
    const pattern = `entity|${c0.via || 'none'}|${kind(top)}|${d.mention_kind}|jev:${d.verdict}`;
    const folderOf = (id: string) => id.split('/').slice(0, -1).join('/');
    let q: string; let options: any[];
    if (d.bucket === 'ambiguous_exact') {
      const cands = (d.candidates || []).slice(0, 3);
      q = `"${d.mention}" is claimed by ${cands.length} notes. Which one is it?`;
      options = [...cands.map((c: any) => ({ key: 'same:' + c.id, label: `${title(c.id)} (${folderOf(c.id)})`, hint: kind(c.id) })), { key: 'different', label: 'None, a different thing', hint: 'keep apart' }];
    } else if (d.verdict === 'new_entity') {
      q = `Is "${d.mention}" a new entity with no note yet?`;
      options = [{ key: 'new', label: 'Yes, new entity', hint: 'becomes a ghost node until a note exists' }, { key: 'same:' + top, label: 'No, it is ' + title(top), hint: 'merge into that note' }, { key: 'ignore', label: 'Not an entity', hint: 'folder, template, or structural name; hidden from now on' }, { key: 'skip', label: 'Not sure', hint: 'ask again later' }];
    } else {
      q = `Is "${d.mention}" the same as ${title(top)}?`;
      options = [{ key: 'same:' + top, label: 'Same', hint: 'merge, spelling becomes an alias' }, { key: 'part:' + top, label: 'Part of it', hint: 'keep the node, draw a part of edge' }, { key: 'different', label: 'Different', hint: 'keep apart' }, { key: 'ignore', label: 'Not an entity', hint: 'structural name, hidden from now on' }];
    }
    cards.push({ id, kind: 'entity', impact: d.count, pattern, q, options, why: d.verdict === 'merge' ? `Jev is confident (p ${d.p?.toFixed(2)}); one click confirms the merge of ${d.count} links` : `Jev at p ${d.p?.toFixed(2)}, below the merge line; ${d.count} links move on this`, ctx: [`${d.count} links`, `matcher ${c0.via || 'none'}`, `Jev ${d.answers?.canonical?.choice === 'none' ? 'none' : title(d.chosenId)} ${d.p?.toFixed(2)}`], nodes: [top].filter(Boolean), p: d.p, jevSays: d.verdict });
  }
  for (const e of links) {
    if (!(e.relation === 'related' || e.relation.includes('part_of')) || e.band === 'ignore') continue;
    const id = 'link:' + e.a + '|' + e.b; const pattern = `link|${e.relation}|${kind(e.a)}|${kind(e.b)}`;
    const partDir = e.relation === 'a_part_of_b' ? `${e.a_title} is part of ${e.b_title}` : e.relation === 'b_part_of_a' ? `${e.b_title} is part of ${e.a_title}` : null;
    cards.push({ id, kind: 'link', impact: 10 + e.shared.length, pattern, q: partDir ? `${partDir}?` : `Should ${e.a_title} link to ${e.b_title}?`, options: [{ key: 'link', label: partDir ? 'Yes, part of' : 'Yes, link them', hint: 'suggested edge becomes confirmed' }, { key: 'related', label: partDir ? 'Related, not part' : 'Related, no link', hint: 'keep as context only' }, { key: 'no', label: 'No', hint: 'unrelated' }], why: `They never link but both point at ${e.shared.slice(0, 3).join(', ')}. Jev ${e.relation} at ${e.p}`, ctx: [`${e.shared.length} shared neighbours`, `Jev ${e.p}`], nodes: [e.a, e.b], p: e.p, jevSays: e.relation });
  }
  for (const e of owners) {
    if (e.band === 'ignore') continue; const id = 'owner:' + e.source; const pattern = `owner|${e.band}|${kind(e.target)}`;
    cards.push({ id, kind: 'owner', impact: 8, pattern, q: `Does the effort ${title(e.source)} belong to ${title(e.target)}?`, options: [{ key: 'yes:' + e.target, label: 'Yes', hint: 'owner edge confirmed, company field suggested' }, { key: 'no', label: 'No', hint: 'drop the suggestion' }, { key: 'skip', label: 'Not sure', hint: '' }], why: `The effort note has no company set. Jev picked ${title(e.target)} at ${e.p} from the title, tags and linked notes`, ctx: [`Jev ${e.p}`, e.band], nodes: [e.source, e.target], p: e.p, jevSays: 'owner' });
  }
  for (const r of dups) {
    if (!(r.verdict === 'delete_safe' || r.verdict === 'rename' || r.verdict === 'alias_conflict')) continue;
    const id = 'dup:' + r.duplicate; const pattern = `dup|${r.verdict}`;
    const q = r.verdict === 'delete_safe' ? `Remove the copy ${title(r.duplicate)} (${r.duplicate})?` : r.verdict === 'rename' ? `Rename the effort hub ${r.duplicate} so it stops colliding with ${title(r.canonical)}?` : `Drop the alias on ${title(r.duplicate)} that collides with ${title(r.canonical)}?`;
    cards.push({ id, kind: 'dup', impact: 5 + (r.path_form_inbound || 0), pattern, q, options: [{ key: 'yes', label: 'Yes', hint: 'queued for the hygiene pass, nothing deleted yet' }, { key: 'no', label: 'No, keep', hint: '' }, { key: 'skip', label: 'Look later', hint: '' }], why: r.reason, ctx: [r.verdict, `${r.words} words`], nodes: [r.duplicate, r.canonical], p: 1, jevSays: r.verdict });
  }
  // rules decide for you; the rest is the deck
  const decided: any[] = []; const deck: any[] = [];
  for (const c of cards) {
    if (done.has(c.id)) continue;
    const r = rules[c.pattern];
    if (r?.auto && c.options.some((o: any) => o.key === r.best)) { const l = { id: c.id, choice: r.best, pattern: c.pattern, source: 'rule', at: new Date().toISOString(), q: c.q }; labels.push(l); fs.appendFileSync(LABELS, JSON.stringify(l) + '\n'); decided.push(l); continue; }
    deck.push(c);
  }
  if (sort === 'impact') deck.sort((a, b) => b.impact - a.impact);
  else deck.sort((a, b) => needScore(b) - needScore(a));
  if (decided.length) writePolicy();
  return { deck, decided, total: cards.length, sort };
}

// ---------- graph ----------
function egoGraph(entity: string, hops = 1, cap = 70, kindsAllowed?: Set<string>) {
  const ids = g.byKey.get(normalizeKey(entity)) || []; const center = ids[0];
  if (!center) return { error: 'no entity ' + entity };
  const pending = new Map<string, number>(); const done = labelled();
  for (const c of buildCards().deck) { if (c.p < 0.85 || done.has(c.id)) continue; const subj = (c.kind === 'owner' ? [c.nodes[0]] : c.kind === 'dup' ? [c.nodes[0]] : c.nodes).filter((n: string) => (inbound.get(n) || 0) < 200); /* hubs never glow; the halo marks things you can act on in one click */ for (const nid of subj) pending.set(nid, Math.max(pending.get(nid) || 0, c.p)); }
  let frontier = new Set([center]); const seen = new Set([center]);
  for (let h = 0; h < hops; h++) { const next = new Set<string>(); for (const f of frontier) for (const x of nb.get(f) || []) if (!seen.has(x)) { seen.add(x); next.add(x); } frontier = next; }
  const kindOfNode = (id: string) => g.byId.get(id)?.kind || (id.startsWith('Calendar/') ? 'meeting' : 'doc');
  const ranked = [...seen].filter(x => x !== center && (!kindsAllowed || kindsAllowed.has(kindOfNode(x)))).sort((a, b) => (inbound.get(b) || 0) - (inbound.get(a) || 0)).slice(0, cap - 1);
  const keep = new Set([center, ...ranked]);
  const nodes = [...keep].map(id => { const e = g.byId.get(id); const n = byPath.get(id); const k = e?.kind || (id.startsWith('Calendar/') ? 'meeting' : 'doc'); return { id, title: title(id), kind: k, inbound: inbound.get(id) || 0, info: infoLevel(n, k), halo: pending.get(id) || 0, ghost: !n, aliases: e?.aliases || [] }; });
  const edges: any[] = []; const es = new Set<string>();
  for (const a of keep) for (const b of nb.get(a) || []) if (keep.has(b)) { const key = a < b ? a + '|' + b : b + '|' + a; if (!es.has(key)) { es.add(key); edges.push({ a, b, type: 'wikilink' }); } }
  for (const e of links) if (keep.has(e.a) && keep.has(e.b) && e.band !== 'ignore' && e.relation !== 'unrelated' && e.relation !== 'siblings') edges.push({ a: e.a, b: e.b, type: e.relation.includes('part_of') ? 'part_of' : 'suggested', p: e.p });
  for (const e of owners) if (keep.has(e.source) && keep.has(e.target) && e.band !== 'ignore') edges.push({ a: e.source, b: e.target, type: 'suggested', p: e.p });
  const ghostHits = ghosts.filter(gh => (nb.get(center) || new Set()).has(gh.key)).slice(0, 5);
  return { center, nodes, edges, ghosts: ghostHits };
}

// ---------- ask: question in, authored view out ----------
function dossier(id: string, limit = 8) {
  const e = g.byId.get(id); const n = byPath.get(id); if (!e || !n) return null;
  const byKind: Record<string, [string, number][]> = {};
  for (const m of notes) for (const l of m.links) { const t = resolve(l.target); if (t === id && m.path !== id) { const k = g.byId.get(m.path)?.kind || 'note'; (byKind[k] ||= []).push([m.path, 1]); } }
  const top = (k: string) => { const c = new Map<string, number>(); for (const [p] of byKind[k] || []) c.set(p, (c.get(p) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p, c]) => ({ title: title(p), links: c })); };
  const out = Array.from(new Set(n.links.map(l => resolve(l.target)).filter(Boolean))).slice(0, 20).map(p => ({ title: title(p!), kind: kind(p!) }));
  const pend = buildCards().deck.filter(c => c.nodes.includes(id)).slice(0, 4).map(c => ({ card_id: c.id, question: c.q, options: c.options.map((o: any) => ({ key: o.key, label: o.label })) }));
  return { entity: e.title, kind: e.kind, aliases: e.aliases, inbound_links: inbound.get(id) || 0, info_level: infoLevel(n, e.kind), linked_from_people: top('person'), linked_from_efforts: top('effort'), linked_from_clients: top('client'), linked_from_companies: top('company'), links_out_to: out, suggested_owner_edges: owners.filter(o => o.target === id || o.source === id).slice(0, 5).map(o => ({ effort: title(o.source), owner: title(o.target), p: o.p })), missed_links: links.filter(l => (l.a === id || l.b === id) && l.relation !== 'unrelated' && l.relation !== 'siblings').slice(0, 6).map(l => ({ with: l.a === id ? l.b_title : l.a_title, relation: l.relation, p: l.p })), pending_decisions: pend, note_words: n.words };
}
function entitiesInQuestion(q: string, max = 3, fuzzy = true): string[] {
  const qk = ' ' + normalizeKey(q) + ' '; const hits: { id: string; len: number }[] = [];
  for (const [key, ids] of g.byKey) { if (key.length < 3) continue; if (qk.includes(' ' + key + ' ')) hits.push({ id: ids[0], len: key.length }); }
  hits.sort((a, b) => b.len - a.len || (inbound.get(b.id) || 0) - (inbound.get(a.id) || 0));
  const seen = new Set<string>(); const out: string[] = [];
  for (const h of hits) { if (seen.has(h.id)) continue; seen.add(h.id); out.push(h.id); if (out.length >= max) break; }
  if (!out.length && fuzzy) { const toks = normalizeKey(q).split(' ').filter(t => t.length >= 5); const word = (t: string, title: string) => (' ' + normalizeKey(title) + ' ').includes(' ' + t + ' '); const cand = g.entities.filter(e => !/MOC$/i.test(e.title) && toks.some(t => word(t, e.title))).sort((a, b) => (inbound.get(b.id) || 0) - (inbound.get(a.id) || 0)).slice(0, max); out.push(...cand.map(e => e.id)); }
  return out;
}
/** The allowlist is the trust boundary: unknown block types are dropped, decision blocks must name a real card and real option keys. */
function sanitizeView(v: any) {
  const deck = buildCards().deck; const byId = new Map(deck.map((c: any) => [c.id, c]));
  const str = (x: any, n = 600) => typeof x === 'string' ? x.slice(0, n) : '';
  const blocks: any[] = [];
  for (const b of Array.isArray(v.blocks) ? v.blocks.slice(0, 8) : []) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'heading': if (str(b.text)) blocks.push({ type: 'heading', text: str(b.text, 120) }); break;
      case 'prose': if (str(b.text)) blocks.push({ type: 'prose', text: str(b.text, 1200) }); break;
      case 'stats': if (Array.isArray(b.items)) blocks.push({ type: 'stats', items: b.items.slice(0, 4).map((i: any) => ({ label: str(i?.label, 40), value: str(String(i?.value ?? ''), 40) })).filter((i: any) => i.label) }); break;
      case 'entities': if (Array.isArray(b.items)) blocks.push({ type: 'entities', items: b.items.slice(0, 4).map((i: any) => ({ title: str(i?.title, 120), why: str(i?.why, 160), known: !!g.byKey.get(normalizeKey(str(i?.title, 120))) })).filter((i: any) => i.title) }); break;
      case 'table': if (Array.isArray(b.columns) && Array.isArray(b.rows)) blocks.push({ type: 'table', columns: b.columns.slice(0, 5).map((c: any) => str(String(c), 40)), rows: b.rows.slice(0, 6).map((r: any) => (Array.isArray(r) ? r : []).slice(0, 5).map((c: any) => str(String(c ?? ''), 80))) }); break;
      case 'list': if (Array.isArray(b.items)) blocks.push({ type: 'list', items: b.items.slice(0, 6).map((i: any) => str(String(i), 200)).filter(Boolean) }); break;
      case 'decided': if (str(b.card_id)) blocks.push({ type: 'decided', card_id: str(b.card_id, 200), question: str(b.question, 200), choice: str(b.choice, 80), label: str(b.label, 80), source: str(b.source, 20), at: str(b.at, 40) }); break;
      case 'decision': { const card = byId.get(str(b.card_id, 200)); if (!card) break; const keys = new Set(card.options.map((o: any) => o.key)); const opts = (Array.isArray(b.options) ? b.options : card.options).filter((o: any) => keys.has(o?.key)).map((o: any) => ({ key: o.key, label: str(o.label, 60) || card.options.find((x: any) => x.key === o.key).label })); blocks.push({ type: 'decision', card_id: card.id, question: str(b.question, 200) || card.q, options: opts.length ? opts : card.options.map((o: any) => ({ key: o.key, label: o.label })) }); break; }
    }
  }
  // Backward compatibility: old style views become blocks.
  if (!blocks.length && (v.prose || v.stats || v.cards)) { if (v.prose) blocks.push({ type: 'prose', text: str(v.prose, 1200) }); if (Array.isArray(v.stats)) blocks.push({ type: 'stats', items: v.stats.slice(0, 4) }); if (Array.isArray(v.cards)) blocks.push({ type: 'entities', items: v.cards.slice(0, 4).map((c: any) => ({ title: str(c.title, 120), why: str(c.why, 160), known: !!g.byKey.get(normalizeKey(str(c.title, 120))) })) }); }
  return { blocks, focus_entity: str(v.focus_entity, 120), next_action: str(v.next_action, 300), prose: v.prose, stats: v.stats, cards: v.cards };
}
/** Decision blocks whose card has since been answered become decided blocks, so a cached view never asks twice. */
function markDecided(view: any) {
  if (!view || !Array.isArray(view.blocks)) return view; const done = labelled();
  const labelOf = (choice: string) => { const [a, b] = String(choice).split(':'); const w = ({ same: 'Same', part: 'Part of it', different: 'Different', new: 'New entity', ignore: 'Not an entity', link: 'Linked', related: 'Related only', no: 'No', yes: 'Yes', skip: 'Skipped' } as any)[a] || a; return b ? `${w} (${title(b)})` : w; };
  view.blocks = view.blocks.map((b: any) => { if (b?.type !== 'decision') return b; const l = done.get(b.card_id); if (!l) return b; return { type: 'decided', card_id: b.card_id, question: b.question, choice: l.choice, label: labelOf(l.choice), source: l.source, at: l.at }; });
  return view;
}
let lastFocusId: string | undefined;
async function ask(question: string, focus?: string, history: any[] = []) {
  const vaultScope = !!focus && normalizeKey(focus) === VAULT_KEY && /overview of this vault/i.test(question);
  const focusId = focus && normalizeKey(focus) !== VAULT_KEY ? ((g.byKey.get(normalizeKey(focus)) || [])[0] || (g.byId.has(focus) ? focus : undefined)) : undefined;
  let ids = vaultScope ? [] : entitiesInQuestion(question, 3, !focusId);
  if (focusId) ids = [focusId, ...ids.filter(i => i !== focusId)].slice(0, 3);
  if (!ids.length && !vaultScope && history.length && lastFocusId) ids = [lastFocusId];
  const prior = history.slice(-6).filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 1500) }));
  const ds: any[] = ids.map(id => dossier(id)).filter(Boolean);
  if (!ds.length) ds.push(vaultDossier());
  const system = 'You are the narrator of Celsus, a personal knowledge graph over an Obsidian vault. You receive a question and dossiers (names, kinds, counts, pending decisions with card ids; never note bodies). Answer from the dossiers only, plainly, no hype, no em dashes; if they cannot answer, say what is missing. You compose the answer as a small interface from an allowlist of blocks. Return JSON only: {"focus_entity": "one entity title from the dossiers", "next_action": "one sentence", "blocks": [ ...2 to 6 blocks... ]}. Block types: {"type":"heading","text":"..."}; {"type":"prose","text":"2 to 4 sentences with [[wikilinks]] to dossier entities"}; {"type":"stats","items":[{"label":"...","value":"..."}]} (max 4); {"type":"entities","items":[{"title":"exact dossier title","why":"one line"}]} (max 4); {"type":"table","columns":["..."],"rows":[["..."]]} (max 6 rows); {"type":"list","items":["..."]} (max 6); {"type":"decision","card_id":"exact card_id from a dossier","question":"...","options":[{"key":"exact key","label":"..."}]} (only when a pending decision is relevant; copy card_id and keys exactly). Prefer a decision block over describing a decision in prose.';
  const t0 = Date.now();
  const r = await chat([{ role: 'system', content: system }, ...prior, { role: 'user', content: JSON.stringify({ question, dossiers: ds, note: prior.length ? 'This is a follow up; the earlier turns are above. Answer the new question.' : undefined }) }], { json: true, timeoutMs: 120000 });
  let view: any = extractJson(r.content);
  if (view) view = sanitizeView(view);
  if (ids[0]) lastFocusId = ids[0];
  const rec = { at: new Date().toISOString(), question, entities: ids, focus: ids[0] ? title(ids[0]) : (vaultScope ? 'Whole vault' : undefined), model: r.model, latencyMs: Date.now() - t0, usage: r.usage, view, raw: view ? undefined : r.content.slice(0, 500) };
  fs.mkdirSync(RUNS, { recursive: true }); fs.appendFileSync(path.join(RUNS, 'asks.jsonl'), JSON.stringify(rec) + '\n');
  return rec;
}

// ---------- whole vault overview ----------
const VAULT_KEY = 'whole vault';
function overviewGraph(cap = 60, kindsAllowed?: Set<string>) {
  const kindOfNode = (id: string) => g.byId.get(id)?.kind || (id.startsWith('Calendar/') ? 'meeting' : 'doc');
  const pending = new Map<string, number>(); const done = labelled();
  for (const c of buildCards().deck) { if (c.p < 0.85 || done.has(c.id)) continue; const subj = (c.kind === 'owner' || c.kind === 'dup' ? [c.nodes[0]] : c.nodes).filter((n: string) => (inbound.get(n) || 0) < 200); for (const nid of subj) pending.set(nid, Math.max(pending.get(nid) || 0, c.p)); }
  const ranked = g.entities.filter(e => (!kindsAllowed || kindsAllowed.has(e.kind)) && !/MOC$/.test(e.title)).map(e => e.id).sort((a, b) => (inbound.get(b) || 0) - (inbound.get(a) || 0)).slice(0, cap);
  const keep = new Set(ranked);
  const nodes = ranked.map(id => { const e = g.byId.get(id)!; const n = byPath.get(id); return { id, title: e.title, kind: e.kind, inbound: inbound.get(id) || 0, info: infoLevel(n, e.kind), halo: pending.get(id) || 0, ghost: !n, aliases: e.aliases }; });
  const edges: any[] = []; const es = new Set<string>();
  for (const a of keep) for (const b of nb.get(a) || []) if (keep.has(b)) { const key = a < b ? a + '|' + b : b + '|' + a; if (!es.has(key)) { es.add(key); edges.push({ a, b, type: 'wikilink' }); } }
  for (const e of links) if (keep.has(e.a) && keep.has(e.b) && e.band !== 'ignore' && e.relation !== 'unrelated' && e.relation !== 'siblings') edges.push({ a: e.a, b: e.b, type: e.relation.includes('part_of') ? 'part_of' : 'suggested', p: e.p });
  return { center: null, overview: true, nodes, edges, ghosts: ghosts.slice(0, 5) };
}
function vaultDossier() {
  const top = (k: string) => g.entities.filter(e => e.kind === k).sort((a, b) => (inbound.get(b.id) || 0) - (inbound.get(a.id) || 0)).slice(0, 8).map(e => ({ title: e.title, links: inbound.get(e.id) || 0 }));
  const deck = buildCards().deck;
  return { scope: 'whole vault', notes: notes.length, entities: g.entities.length, resolved_mentions: Object.keys(resolutions).length, top_companies: top('company'), top_people: top('person'), top_clients: top('client'), top_efforts: top('effort'), top_products: top('product'), pending_decisions: deck.length, top_pending: deck.slice(0, 6).map(c => ({ card_id: c.id, question: c.q, options: c.options.map((o: any) => ({ key: o.key, label: o.label })) })), missing_notes: ghosts.length, top_missing: ghosts.slice(0, 8).map(x => ({ name: x.name, links: x.count, type: x.type })), duplicates: dups.length };
}

function narration(entity: string) { const name = (!entity || normalizeKey(entity) === VAULT_KEY) ? 'Whole vault' : entity; const file = name.replace(/[\/\\]/g, '-') + '.json'; const shared = path.join(RUNS, 'narrations', file); const perRun = latestRunWith('narrations'); const p = fs.existsSync(shared) ? shared : (perRun && fs.existsSync(path.join(perRun, 'narrations', file)) ? path.join(perRun, 'narrations', file) : null); if (!p) return null; const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.at = j.at || fs.statSync(p).mtime.toISOString(); j.configuredModel = loadConfig()?.llm; if (j.view && !Array.isArray(j.view.blocks)) j.view = sanitizeView(j.view); j.view = markDecided(j.view); return j; }

// ---------- http ----------
const send = (res: http.ServerResponse, code: number, body: any, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(type === 'application/json' ? JSON.stringify(body) : body); };
const readBody = (req: http.IncomingMessage) => new Promise<any>(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x'); const p = url.pathname;
  try {
    if (p === '/' || p === '/index.html') return send(res, 200, fs.readFileSync(path.join(HERE, 'ui', 'index.html'), 'utf8'), 'text/html');
    if (p === '/ui/mascot.json' && !fs.existsSync(path.join(HERE, 'ui', 'mascot.json'))) return send(res, 200, {});
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p.startsWith('/ui/')) { const f = path.join(HERE, 'ui', path.normalize(p.slice(4)).replace(/^(\.\.[\/\\])+/, '')); const ext = path.extname(f).toLowerCase(); const types: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.css': 'text/css' }; if (!types[ext] || !fs.existsSync(f)) return send(res, 404, { error: 'not found' }); res.writeHead(200, { 'Content-Type': types[ext], 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(f)); }
    if (p === '/api/state') {
      const sort = (url.searchParams.get('sort') === 'impact') ? 'impact' : 'unsure';
      const { deck, decided, total } = buildCards(sort); const human = labels.filter(l => l.source === 'human');
      const topRules = Object.entries(rules).map(([pattern, r]: any) => ({ pattern, ...r })).sort((a, b) => b.support - a.support).slice(0, 12);
      return send(res, 200, { llm: loadConfig()?.llm, llmBaseUrl: loadConfig()?.llmBaseUrl || '', configured: !!loadConfig()?.openrouterKey, run: path.basename(latestRunWith('resolutions.json') || ''), notes: notes.length, resolved: Object.keys(resolutions).length, ghosts: ghosts.length, sort, deck: deck.slice(0, 60), deckSize: deck.length, totalCards: total, decidedForYou: labels.filter(l => l.source === 'rule').slice(-10).reverse(), answered: human.length, rules: topRules, unsure: deck.slice(0, 60).filter((c: any) => (c.p ?? 1) < 0.7).length, cardsPer100: (decisions.length + links.length + owners.length + dups.length) ? +((deck.length / (decisions.length + links.length + owners.length + dups.length)) * 100).toFixed(1) : 0, dupCounts: dups.reduce((m: any, r: any) => { m[r.verdict] = (m[r.verdict] || 0) + 1; return m; }, {}), laya: layaInfo() });
    }
    if (p === '/api/answer' && req.method === 'POST') {
      const b = await readBody(req);
      const prior = labelled().get(b.id);
      if (prior) return send(res, 409, { error: 'already answered', label: prior });
      const card = buildCards().deck.find((c: any) => c.id === b.id);
      if (!card) return send(res, 404, { error: 'card not in deck' });
      // The answer is a pattern to learn from, and a pattern is only meaningful if it names a meaning:
      // "same:Atlas/People/X.md" or "ignore". An unchecked write here poisons the store permanently,
      // because the policy note renders every stored answer and throws on the next start, taking the
      // app down with a bad value that was accepted once. Checked at the door instead.
      if (typeof b.choice !== 'string' || !(card.options || []).some((o: any) => o.key === b.choice)) {
        return send(res, 400, { error: 'choice must be one of the card options', options: (card.options || []).map((o: any) => o.key) });
      } const l = { id: b.id, choice: b.choice, pattern: card.pattern, source: 'human', at: new Date().toISOString(), q: card.q }; labels.push(l); fs.mkdirSync(RUNS, { recursive: true }); fs.appendFileSync(LABELS, JSON.stringify(l) + '\n'); if (b.choice !== 'skip') ruleUpdate(card.pattern, b.choice, 1); writePolicy(); return send(res, 200, { ok: true, rule: rules[card.pattern] }); }
    if (p === '/api/undo' && req.method === 'POST') { const b = await readBody(req); const i = labels.map(l => l.id).lastIndexOf(b.id); if (i < 0) return send(res, 404, { error: 'no label' }); const [l] = labels.splice(i, 1); fs.writeFileSync(LABELS, labels.map(x => JSON.stringify(x)).join('\n') + (labels.length ? '\n' : '')); if (l.choice !== 'skip') ruleUpdate(l.pattern, l.choice, -1); if (l.source === 'rule') ruleUpdate(l.pattern, l.choice, -1); writePolicy(); return send(res, 200, { ok: true }); }
    if (p === '/api/graph') { const ks = url.searchParams.get('kinds'); const ent = url.searchParams.get('entity') || ''; if (!ent || normalizeKey(ent) === VAULT_KEY) return send(res, 200, overviewGraph(parseInt(url.searchParams.get('cap') || '60', 10), ks ? new Set(ks.split(',').filter(Boolean)) : undefined)); return send(res, 200, egoGraph(ent, parseInt(url.searchParams.get('hops') || '1', 10), parseInt(url.searchParams.get('cap') || '70', 10), ks ? new Set(ks.split(',').filter(Boolean)) : undefined)); }
    if (p === '/api/ask' && req.method === 'POST') { const b = await readBody(req); if (!b.question) return send(res, 400, { error: 'question required' }); return send(res, 200, await ask(String(b.question).slice(0, 500), typeof b.focus === 'string' ? b.focus : undefined, Array.isArray(b.history) ? b.history : [])); }
    if (p === '/api/keycheck') { const c = loadConfig(); if (!c?.openrouterKey) return send(res, 200, { ok: false, why: 'no key saved' }); try { const r = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${c.openrouterKey}` } }); const j: any = r.ok ? await r.json() : null; return send(res, 200, { ok: r.ok, status: r.status, label: j?.data?.label, usage: j?.data?.usage, limit: j?.data?.limit, free: j?.data?.is_free_tier }); } catch (e) { return send(res, 200, { ok: false, why: String((e as Error).message) }); } }
    if (p === '/api/config' && req.method === 'GET') { const c = loadConfig(); return send(res, 200, c ? { vaultPath: c.vaultPath || VAULT_ROOT, classifier: c.classifier, llm: c.llm, llmBaseUrl: c.llmBaseUrl || '', hasKey: !!c.openrouterKey, keyTail: (c.openrouterKey || '').slice(-4) } : { vaultPath: VAULT_ROOT, hasKey: false }); }
    if (p === '/api/config' && req.method === 'POST') {
      const b = await readBody(req); let c = loadConfig();
      const key = typeof b.openrouterKey === 'string' ? b.openrouterKey.trim() : '';
      if (key) { try { const r = await fetch('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${key}` } }); if (!r.ok) return send(res, 400, { error: `OpenRouter rejected that key (HTTP ${r.status}). Paste the full key, it starts with sk-or-v1- and is about 73 characters.` }); } catch (e) { return send(res, 400, { error: 'Could not reach OpenRouter to check the key: ' + (e as Error).message }); } }
      if (!c) { if (!key) return send(res, 400, { error: 'An OpenRouter key is required the first time.' }); c = { openrouterKey: key, classifier: 'typesafe/jev-1.13', llm: 'stealth/space-bunny-alpha', llmMaxTokens: 6000, vaultPath: VAULT_ROOT, createdAt: new Date().toISOString() }; }
      if (key) c.openrouterKey = key;
      if (typeof b.llm === 'string' && b.llm.trim()) c.llm = b.llm.trim();
      if (typeof b.llmBaseUrl === 'string') c.llmBaseUrl = b.llmBaseUrl.trim();
      if (!c.vaultPath) c.vaultPath = VAULT_ROOT;
      saveConfig(c); return send(res, 200, { ok: true, llm: c.llm, llmBaseUrl: c.llmBaseUrl || '', hasKey: !!c.openrouterKey });
    }
    if (p === '/api/rule-note' && req.method === 'POST') { const b = await readBody(req); if (!b.pattern || !b.text) return send(res, 400, { error: 'pattern and text required' }); const r = rules[b.pattern] || (rules[b.pattern] = { answers: {}, support: 0 }); (r.notes ||= []).push({ text: String(b.text).slice(0, 500), at: new Date().toISOString() }); fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(RULES, JSON.stringify(rules, null, 1)); writePolicy(); return send(res, 200, { ok: true, notes: r.notes.length }); }
    if (p === '/api/narrate' && req.method === 'POST') { const b = await readBody(req); const entity = String(b.entity || ''); const isVault = !entity || normalizeKey(entity) === VAULT_KEY; const rec = await ask(isVault ? 'Give an overview of this vault: the biggest companies, people and efforts, what is pending, what is missing, and the single most useful thing to do next.' : `Describe ${entity}: who and what it is connected to, what is pending on it, and the single most useful thing to do next.`, isVault ? VAULT_KEY : entity); if (rec.view) { fs.mkdirSync(path.join(RUNS, 'narrations'), { recursive: true }); fs.writeFileSync(path.join(RUNS, 'narrations', (isVault ? 'Whole vault' : entity).replace(/[\/\\]/g, '-') + '.json'), JSON.stringify({ model: rec.model, latencyMs: rec.latencyMs, at: rec.at, view: rec.view }, null, 1)); } return send(res, 200, rec); }
    if (p === '/api/policy') return send(res, 200, fs.existsSync(POLICY) ? fs.readFileSync(POLICY, 'utf8') : '# No policy yet\n\nAnswer a card.', 'text/markdown');
    if (p === '/api/health') {
      // The dashboard answer to "what is strong and what is missing", measured rather than guessed.
      // Everything here is derived from the vault and the latest run, so the numbers move when the
      // vault moves and there is nothing to keep in sync by hand.
      const inboundByFolder = new Map<string, { notes: number; inbound: number; outbound: number; words: number; nested: boolean }>();
      const bump = (m: Map<string, { notes: number; inbound: number; outbound: number; words: number; nested: boolean }>, k: string) => { const v = m.get(k) || { notes: 0, inbound: 0, outbound: 0, words: 0, nested: false }; m.set(k, v); return v; };
      let totalLinks = 0, resolvableLinks = 0, unlinkedNotes = 0, fresh = 0, words = 0;
      const now = Date.now();
      for (const n of notes) {
        const f = bump(inboundByFolder, n.folder); f.notes++; f.words += n.words; words += n.words;
        // n.folder is only the first path segment, so a file at the root and a file inside a folder
        // share a key shape. A path with a slash is what tells them apart.
        if (n.path.includes('/')) f.nested = true;
        let outbound = 0;
        for (const l of n.links) { totalLinks++; if (resolve(l.target)) { outbound++; resolvableLinks++; } }
        if (outbound) f.outbound += outbound; else unlinkedNotes++;
        if (inbound.get(n.path)) f.inbound += inbound.get(n.path)!;
        if (now - n.mtimeMs < 30 * 864e5) fresh++;
      }
      const folders = [...inboundByFolder.entries()].map(([folder, v]) => ({
        folder, notes: v.notes, words: v.words, inbound: v.inbound,
        // A file at the root of the mapped folder has no parent folder, so its own name becomes the
        // key. Flag it, or the dashboard ranks "Home.md" as the strongest folder in the vault.
        root: !v.nested,
        // Reachability: share of the folder's notes that something else in the vault points at. The
        // number that changes behaviour, because an orphaned folder can average out to a healthy vault.
        reach: v.notes ? +((v.inbound / v.notes)).toFixed(2) : 0,
        density: v.notes ? +((v.outbound / v.notes)).toFixed(1) : 0,
      })).sort((a, b) => b.notes - a.notes);
      // A root file is not a folder. Rank the two lists over real folders only, and list the root
      // files separately, because reachability per note is meaningless for a single file.
      const realFolders = folders.filter(f => !f.root && f.notes >= 3);
      const best = [...realFolders].sort((a, b) => b.reach - a.reach || b.density - a.density).slice(0, 5);
      const worst = [...realFolders].sort((a, b) => a.reach - b.reach || a.density - b.density).slice(0, 5);
      const rootFiles = folders.filter(f => f.root).sort((a, b) => b.inbound - a.inbound);
      const kinds = new Map<string, number>();
      for (const e of g.entities) kinds.set(e.kind, (kinds.get(e.kind) || 0) + 1);
      const topHubs = [...inbound.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, d]) => ({ id, title: title(id), inbound: d, kind: kind(id) }));
      // buildCards decides rule-backed cards for you and writes those labels, so it is called once.
      const deckAll = buildCards('unsure').deck;
      const byPattern = new Map<string, number>();
      for (const c of deckAll) byPattern.set(c.pattern, (byPattern.get(c.pattern) || 0) + 1);
      return send(res, 200, {
        run: path.basename(latestRunWith('resolutions.json') || ''),
        notes: notes.length, words, unlinkedNotes, fresh30d: fresh,
        links: totalLinks, resolvableLinks, linkRate: totalLinks ? +((resolvableLinks / totalLinks) * 100).toFixed(1) : 0,
        entities: g.entities.length,
        byKind: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count })),
        ghosts: ghosts.length,
        topUnresolved: ghosts.slice(0, 12).map((x: any) => ({ name: x.name || x.key, count: x.count, type: x.type })),
        folders, best, worst, rootFiles, topHubs,
        deck: {
          pending: deckAll.length,
          unsure: deckAll.filter((c: any) => (c.p ?? 1) < 0.7).length,
          byPattern: [...byPattern.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pattern, n]) => ({ pattern, n })),
        },
        answered: labels.filter(l => l.source === 'human').length,
        rules: Object.keys(rules).length,
        autoDecided: labels.filter(l => l.source === 'rule').length,
        coverage: notes.length ? +(((notes.length - unlinkedNotes) / notes.length) * 100).toFixed(1) : 0,
      });
    }
    if (p === '/api/search') { const q = normalizeKey(url.searchParams.get('q') || ''); const hits = q ? g.entities.filter(e => normalizeKey(e.title).includes(q)).sort((a, b) => (inbound.get(b.id) || 0) - (inbound.get(a.id) || 0)).slice(0, 8).map(e => ({ id: e.id, title: e.title, kind: e.kind, inbound: inbound.get(e.id) || 0 })) : []; return send(res, 200, hits); }
    if (p === '/api/ghosts') return send(res, 200, ghosts.slice(0, 200));
    if (p === '/api/duplicates') return send(res, 200, dups);
    if (p === '/api/narration') return send(res, 200, narration(url.searchParams.get('entity') || '') || { missing: true });
    if (p === '/api/note/draft' && req.method === 'POST') {
      const b = await readBody(req); const name = String(b.name || '').trim(); if (!name) return send(res, 400, { error: 'name required' });
      const kind = (['person', 'company', 'client', 'product', 'effort', 'note'].includes(b.kind) ? b.kind : 'note') as NoteKind;
      const related = entitiesInQuestion(String(b.context || '') + ' ' + name, 8).map(id => ({ title: title(id), kind: kind_(id) }));
      try { const d = await draftNote({ name, kind, context: String(b.context || ''), answers: typeof b.answers === 'object' && b.answers ? b.answers : {}, related }); return send(res, 200, d); } catch (e) { return send(res, 502, { error: String((e as Error).message) }); }
    }
    if (p === '/api/note/save' && req.method === 'POST') {
      const b = await readBody(req); const name = String(b.name || '').trim(); if (!name || typeof b.markdown !== 'string') return send(res, 400, { error: 'name and markdown required' });
      const kind = (['person', 'company', 'client', 'product', 'effort', 'note'].includes(b.kind) ? b.kind : 'note') as NoteKind;
      try { const r = saveNote(name, kind, b.markdown, { overwrite: !!b.overwrite }); load(); return send(res, 200, { ok: true, file: r.file, obsidian: 'obsidian://open?path=' + encodeURIComponent(r.abs) }); } catch (e: any) { return send(res, e.code || 500, { error: String(e.message) }); }
    }
    if (p === '/api/dup/archive' && req.method === 'POST') {
      const b = await readBody(req); const row = dups.find((r: any) => r.duplicate === b.duplicate); if (!row) return send(res, 404, { error: 'not a known duplicate' });
      try { const e = archiveDuplicate(row, { force: !!b.force, by: 'app' }); const l = { id: 'dup:' + row.duplicate, choice: 'yes', pattern: `dup|${row.verdict}`, source: 'human' as const, at: new Date().toISOString(), q: `Archived ${row.duplicate}` }; if (!labelled().has(l.id)) { labels.push(l); fs.appendFileSync(LABELS, JSON.stringify(l) + '\n'); ruleUpdate(l.pattern, 'yes', 1); } load(); writePolicy(); return send(res, 200, { ok: true, entry: e }); } catch (e: any) { return send(res, e.code || 500, { error: String(e.message) }); }
    }
    if (p === '/api/dup/restore' && req.method === 'POST') { const b = await readBody(req); try { const e = restoreArchived(String(b.from || '')); load(); return send(res, 200, { ok: true, entry: e }); } catch (e: any) { return send(res, e.code || 500, { error: String(e.message) }); } }
    if (p === '/api/archive') return send(res, 200, listArchived().slice(-200).reverse());
    if (p === '/api/reload') { load(); return send(res, 200, { ok: true, notes: notes.length }); }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String((e as Error).message || e) }); }
});

const t0 = Date.now(); load(); writePolicy();
server.listen(PORT, '127.0.0.1', () => console.log(`Celsus OS test server: http://localhost:${PORT}  (${notes.length} notes, ${Object.keys(resolutions).length} resolutions, run ${path.basename(latestRunWith('resolutions.json') || 'none')}, loaded in ${Date.now() - t0} ms)`));
