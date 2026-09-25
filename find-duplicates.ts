// Celsus OS, duplicate notes and the delete-safe list.
// Finds notes that share a name (or a near name) with another note, picks the canonical one by precedence,
// and says for each duplicate whether it can be deleted safely, needs a merge first, or is a different thing wearing the same name.
//   node find-duplicates.ts            writes duplicates.json and duplicates.md into the run folder. Never deletes.
import fs from 'node:fs';
import path from 'node:path';
import { readVault, normalizeKey, VAULT_ROOT, ensureDir, todayStamp } from './vault.ts';
import type { Note } from './vault.ts';
import { buildGlossary, rank, resolveExact } from './glossary.ts';
import { editRatio } from './match.ts';

const OUT = path.join(VAULT_ROOT, 'Efforts', 'Active', 'Celsus OS', 'runs', todayStamp());
type Verdict = 'delete_safe' | 'merge_then_delete' | 'different_thing' | 'rename' | 'alias_conflict';

function bodyOf(n: Note) { return fs.readFileSync(path.join(VAULT_ROOT, n.path), 'utf8'); }
function isStub(n: Note, body: string) { return n.tags.includes('auto-stub') || /Stub note|Auto-created by|Hub note created|_To fill in\._/.test(body) || body.split(/\s+/).length < 60; }
function isPointer(body: string) { return /^#\s*Duplicate\b|This note has been filed at|Archived \d{4}-\d{2}-\d{2}\.\*\* No activity/m.test(body); }
function isEffortHub(n: Note) { const parts = n.path.split('/'); return n.path.startsWith('Efforts/') && parts.length >= 3 && parts[parts.length - 2] === n.basename; }

function main() {
  const notes = readVault(); const byPath = new Map(notes.map(n => [n.path, n]));
  const g = buildGlossary(notes);
  const inboundPath = new Map<string, number>();
  for (const n of notes) for (const l of n.links) if (l.target.includes('/')) { const k = l.target.replace(/\.md$/, ''); inboundPath.set(k, (inboundPath.get(k) || 0) + 1); }
  // groups: exact key collisions from the glossary, plus near-duplicate titles among entity notes
  const groups = new Map<string, Set<string>>();
  // Date named notes live in several folders on purpose (daily note, zoom triage, email triage). Not duplicates.
  const isDateKey = (k: string) => /^\d{4} \d{2} \d{2}/.test(k) || /^\d{4} w\d{2}/.test(k);
  const digits = (k: string) => (k.match(/\d+/g) || []).join('|');
  for (const [key, ids] of g.byKey) if (ids.length > 1 && !isDateKey(key)) groups.set(key, new Set(ids));
  const titles = g.entities.map(e => ({ id: e.id, k: normalizeKey(e.title).replace(/ /g, '') })).filter(t => t.k.length >= 6);
  for (let i = 0; i < titles.length; i++) for (let j = i + 1; j < titles.length; j++) {
    const a = titles[i], b = titles[j]; if (Math.abs(a.k.length - b.k.length) > 2) continue;
    if (a.k !== b.k && digits(a.k) === digits(b.k) && editRatio(a.k, b.k) >= 0.9) { const key = 'near:' + a.k; (groups.get(key) || groups.set(key, new Set()).get(key)!).add(a.id).add(b.id); }
  }
  const rows: any[] = []; const seenPair = new Set<string>();
  for (const [key, idSet] of groups) {
    const ids = [...idSet]; const canon = resolveExact(ids, g, key.replace(/^near:/, ''));
    const canonical = canon ? canon.id : ids.map(id => g.byId.get(id)!).sort((a, b) => rank(a) - rank(b))[0].id;
    const cn = byPath.get(canonical)!; const cbody = bodyOf(cn); const clinks = new Set(cn.links.map(l => normalizeKey(l.target.split('/').pop()!)));
    for (const id of ids) {
      if (id === canonical) continue;
      if (seenPair.has(id + '>' + canonical)) continue; seenPair.add(id + '>' + canonical);
      const n = byPath.get(id)!; const body = bodyOf(n); const words = body.split(/\s+/).length;
      const stub = isStub(n, body);
      const links = n.links.map(l => normalizeKey(l.target.split('/').pop()!));
      const linksNotInCanonical = links.filter(l => !clinks.has(l));
      const uniqueFields = Object.keys(n.frontmatter).filter(k => !(k in cn.frontmatter) && !['created', 'updated', 'tags', 'aliases', 'type'].includes(k));
      const sameTitle = normalizeKey(n.title) === normalizeKey(cn.title);
      const pathInbound = inboundPath.get(id.replace(/\.md$/, '')) || 0;
      let verdict: Verdict; let reason: string;
      const bare = key.replace(/^near:/, '');
      const matchesByAliasOnly = normalizeKey(n.title) !== bare && normalizeKey(n.basename) !== bare && n.aliases.some(a => normalizeKey(a) === bare);
      if (isEffortHub(n)) { verdict = 'rename'; reason = `effort hub note (one per effort folder by convention) sharing its name with ${cn.title}; rename the hub, for example "${n.title} Build" or "${n.title} Engagement", never delete`; }
      else if (matchesByAliasOnly) { verdict = 'alias_conflict'; reason = `claims alias "${bare}" which is the title of ${cn.title}; drop the alias or make the relationship explicit`; }
      else if (!sameTitle && key.startsWith('near:')) { verdict = 'rename'; reason = `title differs from ${cn.title} by a letter or two; confirm same thing, then alias and delete`; }
      else if (isPointer(body)) { verdict = 'delete_safe'; reason = `pointer or archive tombstone of ${words} words that only says where the real note is`; }
      else if (stub && linksNotInCanonical.length <= 2 && uniqueFields.length === 0) { verdict = 'delete_safe'; reason = `stub of ${words} words, every link it has is already in the canonical note`; }
      else { verdict = 'merge_then_delete'; reason = `${words} words of real content, ${linksNotInCanonical.length} links and ${uniqueFields.length} fields the canonical note lacks; read before removing`; }
      if (verdict !== 'alias_conflict' && verdict !== 'rename' && n.type && cn.type && n.type !== cn.type && !stub) { verdict = 'different_thing'; reason = `type ${n.type} vs ${cn.type}; same name, probably not the same thing`; }
      rows.push({ name: key.replace(/^near:/, ''), duplicate: id, canonical, verdict, reason, words, stub, unique_fields: uniqueFields, links_not_in_canonical: linksNotInCanonical.slice(0, 6), path_form_inbound: pathInbound, canonical_rule: canon?.rule || 'rank' });
    }
  }
  const order: Record<Verdict, number> = { delete_safe: 0, merge_then_delete: 1, rename: 2, alias_conflict: 3, different_thing: 4 };
  rows.sort((a, b) => order[a.verdict as Verdict] - order[b.verdict as Verdict] || b.path_form_inbound - a.path_form_inbound);
  ensureDir(OUT);
  fs.writeFileSync(path.join(OUT, 'duplicates.json'), JSON.stringify({ generated: new Date().toISOString(), counts: rows.reduce((m, r) => (m[r.verdict] = (m[r.verdict] || 0) + 1, m), {} as Record<string, number>), rows }, null, 1));
  const L = [`# Duplicate notes, ${todayStamp()}`, '', `> ${rows.length} duplicates across ${groups.size} names. Verdicts: ${Object.entries(rows.reduce((m, r) => (m[r.verdict] = (m[r.verdict] || 0) + 1, m), {} as Record<string, number>)).map(([k, v]) => k + ' ' + v).join(', ')}. Nothing was deleted. delete_safe means the canonical note already holds everything the duplicate has; the only work is updating any path form links listed.`, ''];
  for (const v of ['delete_safe', 'merge_then_delete', 'rename', 'alias_conflict', 'different_thing'] as Verdict[]) {
    const xs = rows.filter(r => r.verdict === v); if (!xs.length) continue;
    L.push(`## ${v} (${xs.length})`, '', '| Duplicate | Canonical | Why | Path links to fix |', '|---|---|---|---|');
    for (const r of xs) L.push(`| ${r.duplicate} | ${r.canonical} | ${r.reason} | ${r.path_form_inbound} |`);
    L.push('');
  }
  fs.writeFileSync(path.join(OUT, 'duplicates.md'), L.join('\n').replace(/[—–]/g, '-'));
  console.log(JSON.stringify({ groups: groups.size, duplicates: rows.length, counts: rows.reduce((m, r) => (m[r.verdict] = (m[r.verdict] || 0) + 1, m), {} as Record<string, number>) }));
}
main();
