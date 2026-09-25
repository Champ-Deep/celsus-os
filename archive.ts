// Celsus OS, the Delete folder. Nothing is ever unlinked from disk by the app: a confirmed duplicate is moved to
// Other/Archive/Deleted/<date>/ with a manifest line, the walker skips Other/Archive, so it leaves the graph but stays
// restorable. delete_safe rows move on one click; anything else needs force, and effort hubs (verdict rename) never move.
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT } from './vault.ts';

export const DELETED = path.join(VAULT_ROOT, 'Other', 'Archive', 'Deleted');
const MANIFEST = path.join(DELETED, 'manifest.jsonl');

export interface ArchiveEntry { at: string; from: string; to: string; verdict: string; canonical?: string; reason?: string; force: boolean; by: string; restored?: string }

const rel = (p: string) => p.replace(/\\/g, '/').replace(/^\/+/, '');
function safeRel(p: string): string { const r = rel(p); if (!r || r.includes('..') || path.isAbsolute(r) || !/\.md$/i.test(r)) throw Object.assign(new Error('bad path ' + p), { code: 400 }); return r; }

export function listArchived(): ArchiveEntry[] { try { return fs.readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }

export function archiveDuplicate(row: { duplicate: string; canonical?: string; verdict: string; reason?: string }, opts: { force?: boolean; by?: string } = {}): ArchiveEntry {
  const from = safeRel(row.duplicate); const abs = path.join(VAULT_ROOT, from);
  if (row.verdict === 'rename') throw Object.assign(new Error('effort hub notes are renamed, never archived'), { code: 400 });
  if (row.verdict !== 'delete_safe' && !opts.force) throw Object.assign(new Error(`verdict ${row.verdict} needs confirmation (force)`), { code: 409 });
  if (!fs.existsSync(abs)) throw Object.assign(new Error('file not found: ' + from), { code: 404 });
  const day = new Date().toISOString().slice(0, 10); const dir = path.join(DELETED, day); fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, path.basename(from)); let i = 2;
  while (fs.existsSync(dest)) { dest = path.join(dir, path.basename(from, '.md') + ' (' + i++ + ').md'); }
  fs.renameSync(abs, dest);
  const e: ArchiveEntry = { at: new Date().toISOString(), from, to: rel(path.relative(VAULT_ROOT, dest)), verdict: row.verdict, canonical: row.canonical, reason: row.reason, force: !!opts.force, by: opts.by || 'app' };
  fs.appendFileSync(MANIFEST, JSON.stringify(e) + '\n');
  return e;
}

export function restoreArchived(from: string): ArchiveEntry {
  const want = safeRel(from); const entries = listArchived(); const e = [...entries].reverse().find(x => x.from === want && !x.restored);
  if (!e) throw Object.assign(new Error('nothing archived from ' + want), { code: 404 });
  const src = path.join(VAULT_ROOT, e.to); const dst = path.join(VAULT_ROOT, e.from);
  if (!fs.existsSync(src)) throw Object.assign(new Error('archived copy is gone: ' + e.to), { code: 404 });
  if (fs.existsSync(dst)) throw Object.assign(new Error('a note already exists at ' + e.from), { code: 409 });
  fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(src, dst);
  e.restored = new Date().toISOString();
  fs.writeFileSync(MANIFEST, entries.map(x => JSON.stringify(x)).join('\n') + '\n');
  return e;
}
