// Celsus OS, shared vault reader. Zero dependencies. Runs with plain `node` (22.18+ type stripping).
// Reads markdown, frontmatter and wikilinks. Never reads or emits note bodies beyond link targets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
function configuredVault(): string | undefined { try { const c = JSON.parse(fs.readFileSync(path.join(process.env.HOME || process.env.USERPROFILE || '', '.celsus-os', 'config.json'), 'utf8')); return c.vaultPath || undefined; } catch { return undefined; } }
export const VAULT_ROOT = process.env.VAULT_PATH || configuredVault() || path.resolve(HERE, '..', '..', '..');

const SKIP_DIRS = new Set(['studio', 'node_modules', 'runs', 'Excalidraw', '_to_delete', 'Scheduled', 'Artifacts', 'Claude outputs']);
const SKIP_PREFIX = ['.', '_ARCHIVE'];
const SKIP_PATHS = ['Other/Archive'];

export interface WikiLink { target: string; alias?: string; heading?: string; raw: string; line: number; embed: boolean }
export interface Note {
  path: string;          // relative, forward slashes
  basename: string;      // file name without .md
  title: string;         // frontmatter title or basename
  folder: string;        // top level folder
  type?: string;
  aliases: string[];
  company?: string;
  tags: string[];
  frontmatter: Record<string, any>;
  links: WikiLink[];
  taskContexts: string[]; // [c:...] values from task lines
  taskEfforts: string[];  // [e:...] values from task lines
  mtimeMs: number;
  words: number;
}

export function walk(dir = VAULT_ROOT, rel = ''): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || SKIP_PREFIX.some(p => ent.name.startsWith(p)) || SKIP_PATHS.includes(relPath)) continue;
      out.push(...walk(path.join(dir, ent.name), relPath));
    } else if (ent.isFile() && ent.name.endsWith('.md')) {
      out.push(relPath);
    }
  }
  return out;
}

function unquote(v: string): string {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v.trim();
}
export function stripWiki(v: string): string {
  const m = v.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]$/);
  return m ? m[1].trim() : v;
}

/** Minimal YAML: scalars, inline lists, block lists. Enough for this vault's frontmatter. */
export function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: text };
  const block = text.slice(3, end).split(/\r?\n/);
  const body = text.slice(end + 4);
  const fm: Record<string, any> = {};
  let key: string | null = null;
  for (const line of block) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const raw = kv[2].trim();
      if (raw === '' ) { fm[key] = []; continue; }
      if (raw.startsWith('[') && raw.endsWith(']')) {
        fm[key] = raw.slice(1, -1).split(',').map(unquote).filter(Boolean);
      } else fm[key] = unquote(raw);
      continue;
    }
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && key) {
      if (!Array.isArray(fm[key])) fm[key] = fm[key] === '' || fm[key] == null ? [] : [fm[key]];
      fm[key].push(unquote(item[1]));
    }
  }
  return { fm, body };
}

/** Wikilinks outside code fences and inline code. */
export function extractWikilinks(body: string): WikiLink[] {
  const links: WikiLink[] = [];
  let inFence = false;
  const lines = body.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const noCode = line.replace(/`[^`]*`/g, '');
    const re = /(!?)\[\[([^\]\|\n#]+)(?:#([^\]\|\n]*))?(?:\|([^\]\n]*))?\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(noCode)) !== null) {
      const target = m[2].trim();
      if (!target) continue;
      links.push({ target, heading: m[3]?.trim() || undefined, alias: m[4]?.trim() || undefined, raw: m[0], line: i + 1, embed: m[1] === '!' });
    }
  });
  return links;
}

function taskValues(body: string, key: 'c' | 'e'): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\[${key}:(?:\\[\\[)?([^\\]]+?)(?:\\]\\])?\\]`, 'g');
  for (const line of body.split(/\r?\n/)) {
    if (!/^\s*-\s*\[[ xX]\]/.test(line)) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) out.push(m[1].split('|')[0].trim());
  }
  return out;
}

export function readNote(rel: string): Note {
  const abs = path.join(VAULT_ROOT, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const mtimeMs = fs.statSync(abs).mtimeMs;
  const { fm, body } = parseFrontmatter(text);
  const basename = path.basename(rel, '.md');
  const asList = (v: any): string[] => v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];
  return {
    path: rel,
    basename,
    title: typeof fm.title === 'string' && fm.title ? fm.title : basename,
    folder: rel.split('/')[0],
    type: typeof fm.type === 'string' ? fm.type : undefined,
    aliases: asList(fm.aliases).map(stripWiki).filter(Boolean),
    company: typeof fm.company === 'string' ? stripWiki(fm.company) : undefined,
    tags: asList(fm.tags).map(t => t.replace(/^#/, '')),
    frontmatter: fm,
    links: extractWikilinks(body),
    taskContexts: taskValues(body, 'c'),
    taskEfforts: taskValues(body, 'e'),
    mtimeMs,
    words: body.split(/\s+/).filter(Boolean).length,
  };
}

export function readVault(): Note[] {
  return walk().map(readNote);
}

/** Canonical comparison key: lowercase, ascii folded, punctuation dropped, single spaces, leading "the" dropped. */
export function normalizeKey(s: string): string {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

export function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }

/** The most recent run folder that holds the given file, so readers do not depend on the clock. */
export function latestRunWith(file: string): string | null {
  const root = path.join(VAULT_ROOT, 'Efforts', 'Active', 'Celsus OS', 'runs');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, file))).sort();
  return dirs.length ? path.join(root, dirs[dirs.length - 1]) : null;
}
