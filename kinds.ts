// Celsus OS, kinds. What kind of thing a note is, and where a new note of that kind belongs.
//
// This used to be a chain of startsWith calls hardcoded to one vault's folder names, which meant a
// teammate whose folders are called something else had every note typed "note": no kind filters in
// the graph, no owner questions, no typed drafts, and new notes written into folders that do not
// exist in their vault. The defaults below still read that layout, so an existing install changes
// nothing, but the names are now a table that setup can override and that falls back to matching
// folder names loosely.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';

export type Kind = 'company' | 'person' | 'product' | 'client' | 'effort' | 'project' | 'meeting' | 'doc' | 'note';

export const KINDS: Kind[] = ['person', 'company', 'client', 'product', 'effort', 'project', 'meeting', 'doc', 'note'];

/** The layout this app was built against. Config `kindFolders` replaces it wholesale when present. */
export const DEFAULT_KIND_FOLDERS: Record<string, Kind> = {
  'Atlas/Companies': 'company',
  'Atlas/People': 'person',
  'Atlas/Products': 'product',
  'Atlas/Clients': 'client',
  'Projects': 'project',
  'Efforts': 'effort',
  'Calendar/Meetings': 'meeting',
  'Calendar/Daily Notes': 'meeting',
};

/** Loose folder-name matching, used when no explicit mapping matches. Ordered, first hit wins. */
const NAME_HINTS: [RegExp, Kind][] = [
  [/^(people|persons|contacts|team|stakeholders)$/i, 'person'],
  [/^(companies|company|orgs|organisations|organizations|internal)$/i, 'company'],
  [/^(clients|customers|accounts|partners|prospects)$/i, 'client'],
  [/^(products|product|offerings|lines?)$/i, 'product'],
  [/^(efforts?|work|projects?|engagements|initiatives)$/i, 'effort'],
  [/^(meetings?|calls?|calendar)$/i, 'meeting'],
];

export function kindFolders(): Record<string, Kind> {
  const cfg = loadConfig();
  const override = (cfg as any)?.kindFolders as Record<string, Kind> | undefined;
  if (override && Object.keys(override).length) return { ...DEFAULT_KIND_FOLDERS, ...override };
  return DEFAULT_KIND_FOLDERS;
}

/**
 * The kind of a note, from its path. An explicit table wins, then frontmatter `type`, then a loose
 * match on any folder segment. An effort is also recognised by the hub shape the app creates: a
 * folder whose name matches the note inside it.
 */
export function kindOfPath(rel: string, opts: { basename?: string; frontmatterType?: string } = {}): Kind {
  const table = kindFolders();
  const p = rel.replace(/^\.\//, '');
  // Longest prefix first, so Atlas/Clients/ZebPay beats Atlas/Clients.
  for (const prefix of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (p === prefix || p.startsWith(prefix.replace(/\/$/, '') + '/')) return table[prefix];
  }
  const t = (opts.frontmatterType || '').toLowerCase();
  if ((KINDS as string[]).includes(t)) return t as Kind;
  const segments = p.split('/');
  for (const seg of segments.slice(0, -1)) for (const [re, k] of NAME_HINTS) if (re.test(seg)) return k;
  if (opts.basename) {
    const parent = segments[segments.length - 2];
    if (parent && parent === opts.basename) return 'effort';
  }
  return 'note';
}

/** Where a new note of this kind is written. Config `noteFolders` overrides any entry. */
export const DEFAULT_NOTE_FOLDERS: Record<string, string> = {
  person: 'Atlas/People', company: 'Atlas/Companies', client: 'Atlas/Clients',
  product: 'Atlas/Products', effort: 'Efforts/Active', note: 'Inbox',
};

/**
 * Folders that actually exist, by kind, taken from the folder being mapped. A hardcoded table is the
 * wrong answer for anyone whose vault is not laid out like the one this was built on: it would write
 * a new person note into Atlas/People in a vault that has People/ and no Atlas at all. Scanned once
 * per process, two levels deep, because entity folders live one or two levels down.
 */
let inferred: Record<string, string> | null = null;
export function inferFolders(root: string, maxDepth = 2): Record<string, string> {
  const seen: Record<string, string[]> = {};
  const walk = (dir: string, rel: string, depth: number) => {
    let ents: import('node:fs').Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      // Probe the folder by asking what kind a note inside it would be.
      const k = kindOfPath(childRel + '/probe.md');
      if (k !== 'note') (seen[k] ||= []).push(childRel);
      if (depth < maxDepth) walk(path.join(dir, e.name), childRel, depth + 1);
    }
  };
  walk(root, '', 1);
  // Deepest match is NOT the right tiebreak. Efforts and Efforts/Active both look like effort, but so
  // does every individual project hub, and the longest path wins by being the most specific folder in
  // the vault, which is the one new work must never be filed into. Prefer the shallowest candidate
  // instead: the container that holds the things of that kind.
  const out: Record<string, string> = {};
  for (const [k, paths] of Object.entries(seen)) out[k] = paths.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  return out;
}
export function foldersForRoot(root: string): Record<string, string> {
  if (!inferred) inferred = inferFolders(root);
  return inferred;
}

export function folderForKind(kind: string, name: string, root = ''): string {
  const cfg = loadConfig() as any;
  const override = cfg?.noteFolders as Record<string, string> | undefined;
  const join = (base: string) => (kind === 'effort' ? `${base}/${name}` : base);
  if (override && override[kind]) return join(override[kind]);
  // The built-in table is only a guess about someone else's vault, so use it when the folder is
  // actually there. An existing layout is never second-guessed; only a missing one is inferred.
  if (root) {
    const builtIn = DEFAULT_NOTE_FOLDERS[kind];
    if (builtIn && fs.existsSync(path.join(root, builtIn))) return join(builtIn);
    const found = foldersForRoot(root)[kind];
    if (found) return join(found);
  }
  return join(DEFAULT_NOTE_FOLDERS[kind] || DEFAULT_NOTE_FOLDERS.note);
}

/** The folder a kind lives in, for a table caption. Never creates anything. */
export function folderForKindLabel(kind: string): string {
  const cfg = loadConfig() as any;
  const override = cfg?.noteFolders as Record<string, string> | undefined;
  return (override && override[kind]) || DEFAULT_NOTE_FOLDERS[kind] || '';
}
