// Celsus OS, note creation. Laya (the writing model, local or via OpenRouter) drafts a typed note from the owner's
// short context and the vault template; Jev checks completeness from field names only (no prose leaves for Jev);
// the owner answers the missing questions, then the note is saved into the right folder. Nothing is written until save.
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT } from './vault.ts';
import { chat, extractJson } from './llm.ts';
import { decide } from './jev.ts';
import { standingRules, bestPractices } from './policy.ts';

export type NoteKind = 'person' | 'company' | 'client' | 'product' | 'effort' | 'note';

const TEMPLATE: Record<NoteKind, string> = { person: 'Template - Person', company: 'Template - Company', client: 'Template - Client', product: 'Template - Product', effort: 'Template - Effort', note: '' };
const FOLDER: Record<NoteKind, string> = { person: 'Atlas/People', company: 'Atlas/Companies', client: 'Atlas/Clients', product: 'Atlas/Products', effort: 'Efforts/Active', note: 'Inbox' };
/** Fields that make a note useful for its kind; same list infoLevel scores on. */
export const REQUIRED: Record<NoteKind, string[]> = { person: ['role', 'company', 'relationship'], company: ['industry', 'aliases', 'stage'], client: ['status', 'company-served-by', 'key-contacts'], product: ['stage', 'tech-stack', 'company'], effort: ['status', 'company', 'target-date'], note: ['type', 'tags'] };

export interface DraftInput { name: string; kind: NoteKind; context: string; answers?: Record<string, string>; related?: { title: string; kind: string }[] }
export interface Draft { name: string; kind: NoteKind; folder: string; file: string; markdown: string; frontmatter: Record<string, any>; filled: string[]; empty: string[]; missing: { field: string; question: string }[]; support: Record<string, number>; verdict: 'save' | 'ask_more' | 'unchecked'; model: string; latencyMs: number; exists: boolean; fallback?: boolean; raw?: string; jevError?: string }

const safeName = (s: string) => s.replace(/[\/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim().slice(0, 120);
export function targetFile(name: string, kind: NoteKind): { folder: string; file: string } {
  const n = safeName(name); const folder = kind === 'effort' ? path.join(FOLDER.effort, n) : FOLDER[kind] || FOLDER.note;
  return { folder, file: path.join(folder, n + '.md') };
}
function template(kind: NoteKind): string {
  const p = TEMPLATE[kind] ? path.join(VAULT_ROOT, 'Other', 'Templates', TEMPLATE[kind] + '.md') : '';
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  return '---\ntype: ' + (kind === 'note' ? 'note' : kind) + '\nname: "{{title}}"\ntags: [' + kind + ']\naliases: []\ncreated: "{{date}}"\nupdated: "{{date}}"\n---\n\n# {{title}}\n\n> [!info] Quick Summary\n> *One line.*\n\n## Notes\n';
}
/** Minimal frontmatter reader for the draft check: key: value lines between the first two --- fences. */
export function readFrontmatter(md: string): Record<string, any> {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/); const out: Record<string, any> = {}; if (!m) return out;
  for (const line of m[1].split('\n')) { const mm = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/); if (!mm) continue; let v: any = mm[2].trim(); if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean); else v = v.replace(/^"|"$/g, ''); out[mm[1]] = v; }
  return out;
}
/** Salvage a draft when the model broke the JSON (raw newlines inside the string is the usual way): take the markdown
 *  field by regex and unescape it, or, if the reply is just a note, take the note. */
function extractMarkdown(text: string): { markdown: string; missing: any[] } | null {
  const m = text.match(/"markdown"\s*:\s*"([\s\S]*?)"\s*,\s*"missing"/);
  if (m) { const md = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '  '); const q: any[] = []; const mm = text.match(/"missing"\s*:\s*(\[[\s\S]*?\])\s*}?\s*$/); if (mm) { try { q.push(...JSON.parse(mm[1])); } catch {} } return { markdown: md, missing: q }; }
  const fence = text.match(/```(?:markdown|md)?\s*(---[\s\S]*?)```/); if (fence) return { markdown: fence[1], missing: [] };
  const i = text.indexOf('---'); if (i >= 0 && text.indexOf('---', i + 3) > 0 && /^#\s/m.test(text)) return { markdown: text.slice(i), missing: [] };
  return null;
}
const filledValue = (v: any) => v != null && (Array.isArray(v) ? v.length > 0 : String(v).trim().length > 0 && !/^\{\{/.test(String(v)));

export async function draftNote(input: DraftInput): Promise<Draft> {
  const name = safeName(input.name); const kind = (input.kind in FOLDER ? input.kind : 'note') as NoteKind;
  const { folder, file } = targetFile(name, kind); const exists = fs.existsSync(path.join(VAULT_ROOT, file));
  const today = new Date().toISOString().slice(0, 10);
  const tpl = template(kind).replace(/\{\{title\}\}/g, name).replace(/\{\{date\}\}/g, today);
  const req = REQUIRED[kind];
  const system = ['You are Laya, the note writer for Celsus, an Obsidian vault. You write one complete note from the owner\'s short context, in the owner\'s house style. Rules: keep the template frontmatter keys and order; fill every key you can from the context or the answers; leave a key empty rather than inventing a fact; wikilink known entities with [[Title]] exactly as given in related; replace italic placeholder prompts with real sentences or delete the section if nothing is known; no em dashes or en dashes anywhere, use commas or a plain hyphen; British or Indian English is fine; short paragraphs.',
    'Return JSON only: {"markdown": "the full note including frontmatter", "missing": [{"field": "frontmatter key or section", "question": "one short question to the owner that would fill it"}] }. List at most 4 missing items, most important first, and only for things the context does not answer.',
    bestPractices() ? 'Owner best practices:\n' + bestPractices() : '',
    standingRules().length ? 'Standing decision rules of this vault (for naming and linking):\n' + standingRules().slice(0, 12).join('\n') : ''].filter(Boolean).join('\n\n');
  const user = JSON.stringify({ name, kind, target_file: file, required_fields: req, context: (input.context || '').slice(0, 4000), answers: input.answers || {}, related: (input.related || []).slice(0, 20), template: tpl });
  const t0 = Date.now();
  const r = await chat([{ role: 'system', content: system }, { role: 'user', content: user }], { json: true, timeoutMs: 120000 });
  const j: any = extractJson(r.content) || extractMarkdown(r.content) || {};
  const fallback = !(typeof j.markdown === 'string' && j.markdown.includes('---'));
  let markdown = fallback ? tpl : j.markdown;
  markdown = markdown.replace(/[\u2014\u2013]/g, '-').replace(/\r\n/g, '\n');
  if (!/^---/.test(markdown)) markdown = tpl.split('\n---')[0] + '\n---\n\n' + markdown;
  const fm = readFrontmatter(markdown);
  const filled = req.filter(f => filledValue(fm[f])); const empty = req.filter(f => !filledValue(fm[f]));
  const llmMissing: { field: string; question: string }[] = Array.isArray(j.missing) ? j.missing.slice(0, 4).map((m: any) => ({ field: String(m?.field || '').slice(0, 60), question: String(m?.question || '').slice(0, 200) })).filter((m: any) => m.field && m.question) : [];
  const missing = [...llmMissing]; for (const f of empty) if (!missing.some(m => m.field === f)) missing.push({ field: f, question: `What is the ${f.replace(/-/g, ' ')} for ${name}?` });
  // Jev sees names only: which fields are filled, which are empty, how many words. It decides whether this is enough to save.
  let verdict: Draft['verdict'] = 'unchecked'; const support: Record<string, number> = {}; let jevError: string | undefined;
  try {
    const words = markdown.replace(/^---[\s\S]*?---/, '').split(/\s+/).filter(Boolean).length;
    const res = await decide({ note_kind: kind, required_fields: req, filled_fields: filled, empty_fields: empty, body_words: words, owner_answers_given: Object.keys(input.answers || {}).length, questions_still_open: missing.length },
      { complete: { type: 'choice', instructions: 'A typed note in a personal knowledge vault was just drafted from the owner\'s short context. Given which required fields are filled and which are empty, is it complete enough to save now, or should the owner answer the open questions first?', criteria: { save: 'The note has enough of its required fields and body to be useful now; save it and fill the rest later.', ask_more: 'Too much is still empty; ask the owner the open questions first.' } } }, { timeoutMs: 6000, retries: 1 });
    const a: any = res.answers?.complete; verdict = a?.choice === 'save' ? 'save' : 'ask_more'; support.save = +(a?.probabilities?.save ?? 0).toFixed(2); support.ask_more = +(a?.probabilities?.ask_more ?? 0).toFixed(2);
  } catch (e) { jevError = String((e as Error).message).slice(0, 200); verdict = missing.length ? 'ask_more' : 'save'; }
  return { name, kind, folder, file, markdown, frontmatter: fm, filled, empty, missing: missing.slice(0, 5), support, verdict, model: r.model, latencyMs: Date.now() - t0, exists, fallback: fallback || undefined, raw: fallback ? r.content.slice(0, 400) : undefined, jevError };
}

export function saveNote(name: string, kind: NoteKind, markdown: string, opts: { overwrite?: boolean } = {}): { file: string; abs: string } {
  const { folder, file } = targetFile(name, kind); const abs = path.join(VAULT_ROOT, file);
  if (!abs.startsWith(VAULT_ROOT)) throw new Error('refusing to write outside the vault');
  if (fs.existsSync(abs) && !opts.overwrite) throw Object.assign(new Error('a note with that name already exists at ' + file), { code: 409 });
  fs.mkdirSync(path.join(VAULT_ROOT, folder), { recursive: true });
  fs.writeFileSync(abs, markdown.replace(/[\u2014\u2013]/g, '-').replace(/\s+$/, '') + '\n');
  return { file, abs };
}
