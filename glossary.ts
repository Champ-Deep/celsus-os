// Celsus OS, glossary: the canonical entity registry the normalizer resolves against.
// One entity per note. Names = title, basename, frontmatter aliases, link-policy alias registry.
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT, normalizeKey } from './vault.ts';
import type { Note } from './vault.ts';

export type EntityKind = 'company' | 'person' | 'product' | 'client' | 'effort' | 'project' | 'note';
export interface Entity { id: string; title: string; kind: EntityKind; folder: string; names: string[]; aliases: string[] }
export interface Glossary { entities: Entity[]; byId: Map<string, Entity>; byKey: Map<string, string[]>; registry: Map<string, string[]> }

export function kindOf(n: Note): EntityKind {
  if (n.path.startsWith('Atlas/Companies/')) return 'company';
  if (n.path.startsWith('Atlas/People/')) return 'person';
  if (n.path.startsWith('Atlas/Products/')) return 'product';
  if (n.path.startsWith('Atlas/Clients/')) return 'client';
  if (n.path.startsWith('Projects/')) return 'project';
  if (n.path.startsWith('Efforts/')) {
    const parts = n.path.split('/');
    const parent = parts[parts.length - 2];
    if (parent === n.basename || n.type === 'effort') return 'effort';
  }
  if (n.type === 'person') return 'person';
  if (n.type === 'company') return 'company';
  if (n.type === 'product') return 'product';
  if (n.type === 'client') return 'client';
  return 'note';
}

/** Parse the alias registry table in _config/link-policy.md: "| Written as | Link as |". */
export function linkPolicyAliases(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const p = path.join(VAULT_ROOT, '_config', 'link-policy.md');
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`\[\[([^\]|\\]+)(?:\\\|[^\]]*)?\]\]`\s*\|$/);
    if (!m) continue;
    const written = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const target = m[2].trim();
    out.set(target, [...(out.get(target) || []), ...written]);
  }
  return out;
}

/** Structural files are not entities: skill and design files, readmes, section stubs, generated update notes. */
const STRUCTURAL_BASENAMES = /^(skill|design|readme|context|changelog|agents|claude|_index|00-summary|00_notebooklm_prompt|meeting-history|pain-points|solution-mapping|brief|overview|license|index)$/i;
const STRUCTURAL_PATH = /(^|\/)(skills|\.claude-skills|node_modules|BearDrive|Vault-Reports|_config|Other\/Templates)(\/|$)|-client-update\.md$|-vendor-update\.md$|-apac-update\.md$/i;
export function isStructural(n: Note): boolean {
  return STRUCTURAL_BASENAMES.test(n.basename) || STRUCTURAL_PATH.test(n.path);
}

/** Lower rank wins an exact name collision. Atlas entity folders beat context docs, efforts hubs beat working notes. */
export function rank(e: Entity): number {
  const p = e.id;
  if (p.startsWith('Atlas/Me/')) return 0;
  if (p.startsWith('Atlas/Companies/')) return 1;
  if (p.startsWith('Atlas/People/')) return 2;
  if (p.startsWith('Atlas/Products/')) return 3;
  if (p.startsWith('Atlas/Clients/')) return 4;
  if (e.kind === 'effort') return 5;
  if (p.startsWith('Projects/')) return 6;
  if (p.startsWith('Calendar/')) return 7;
  if (p.startsWith('Atlas/Context Docs/')) return 8;
  if (p.startsWith('Atlas/')) return 9;
  return 10;
}
const isHub = (e: Entity) => { const parts = e.id.split('/'); return parts.length >= 2 && parts[parts.length - 2] === e.title; };

/**
 * Settle an exact collision by rule. Returns the winner, or null when the tie is real (same rank, different titles),
 * which is the only exact case Jev is asked about. Same rank and same title is vault hygiene, the tie-break picks one
 * and the collision is reported.
 */
export function resolveExact(ids: string[], g: Glossary, mentionKey: string): { id: string; rule: string } | null {
  if (ids.length === 1) return { id: ids[0], rule: 'exact' };
  const es = ids.map(id => g.byId.get(id)!);
  const reg = es.filter(e => (g.registry.get(e.title) || g.registry.get(e.id.split('/').pop()!.replace(/\.md$/, '')) || []).some(w => normalizeKey(w) === mentionKey));
  if (reg.length === 1) return { id: reg[0].id, rule: 'registry' };
  const best = Math.min(...es.map(rank));
  const top = es.filter(e => rank(e) === best);
  if (top.length === 1) return { id: top[0].id, rule: 'precedence' };
  const titles = new Set(top.map(e => normalizeKey(e.title)));
  if (titles.size > 1) return null;
  const sorted = [...top].sort((a, b) => Number(isHub(b)) - Number(isHub(a)) || a.id.split('/').length - b.id.split('/').length || a.id.localeCompare(b.id));
  return { id: sorted[0].id, rule: 'tie-break' };
}

export function buildGlossary(notes: Note[]): Glossary {
  const registry = linkPolicyAliases();
  const entities: Entity[] = [];
  const byId = new Map<string, Entity>();
  const byKey = new Map<string, string[]>();
  for (const n of notes) {
    if (isStructural(n)) continue;
    const extra = registry.get(n.basename) || registry.get(n.title) || [];
    const aliases = Array.from(new Set([...n.aliases, ...extra])).filter(a => normalizeKey(a) !== normalizeKey(n.title));
    const names = Array.from(new Set([n.title, n.basename, ...aliases].filter(Boolean)));
    const e: Entity = { id: n.path, title: n.title, kind: kindOf(n), folder: n.folder, names, aliases };
    entities.push(e);
    byId.set(e.id, e);
    for (const name of names) {
      const k = normalizeKey(name);
      if (!k) continue;
      const arr = byKey.get(k) || [];
      if (!arr.includes(e.id)) arr.push(e.id);
      byKey.set(k, arr);
    }
  }
  return { entities, byId, byKey, registry };
}

/** Same key claimed by more than one note: the vault's own ambiguity, listed for the report. */
export function keyCollisions(g: Glossary): { key: string; ids: string[] }[] {
  return Array.from(g.byKey.entries()).filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }));
}
