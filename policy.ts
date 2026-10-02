// Celsus OS, the decision policy. Every answer updates rules.json; this renders that store, plus the answer log,
// into a readable skill file the next run reads and Jev is briefed with. Same idea as an agent that rewrites its own
// skill after each task: the policy is the thing that improves, and it is text you can read and edit.
// The same store also feeds Laya, the local writing model: runs/laya/ holds a system prompt, a training set and an
// Ollama Modelfile, all regenerated after every answer, so Laya is continuously trained on the rules and best practices.
import fs from 'node:fs';
import path from 'node:path';
import { CELSUS_HOME, RUNS as VAULT_RUNS } from './vault.ts';
import { loadConfig } from './config.ts';

export const RUNS = VAULT_RUNS;
export const LABELS = path.join(RUNS, 'labels.jsonl');
export const RULES = path.join(RUNS, 'rules.json');
export const POLICY = path.join(CELSUS_HOME, 'Decision Policy.md');
export const BEST_PRACTICES = path.join(CELSUS_HOME, 'Laya Best Practices.md');
export const LAYA = path.join(RUNS, 'laya');

export interface Label { id: string; choice: string; pattern: string; source: 'human' | 'rule'; at: string; q?: string }
export interface Rule { answers: Record<string, number>; support: number; best?: string; confidence?: number; auto?: boolean; notes?: { text: string; at: string }[] }

export const loadLabels = (): Label[] => { try { return fs.readFileSync(LABELS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
export const loadRules = (): Record<string, Rule> => { try { return JSON.parse(fs.readFileSync(RULES, 'utf8')); } catch { return {}; } };

const KIND = { entity: 'Entity match', link: 'Missed link', owner: 'Effort owner', dup: 'Duplicate' } as Record<string, string>;
const CHOICE = (c: string) => { const [a, b] = c.split(':'); const w = ({ same: 'same entity', part: 'part of it', different: 'different', new: 'new entity', ignore: 'not an entity', link: 'link them', related: 'related only', no: 'no', yes: 'yes', skip: 'skip' } as any)[a] || a; return b ? `${w} (${b.split('/').pop()!.replace(/\.md$/, '')})` : w; };

/** Plain words for one pattern, readable by a person and usable as Jev state. */
export function describePattern(pattern: string): string {
  const [k, ...r] = pattern.split('|');
  if (k === 'entity') { const [via, candKind, mentionKind, jev] = r; return `a ${mentionKind.replace('_', ' ')} mention that the ${via} matcher tied to a ${candKind} note, where Jev said ${jev.replace('jev:', '')}`; }
  if (k === 'link') { const [rel, ka, kb] = r; return `two notes (${ka} and ${kb}) that never link, where Jev said ${rel.replace(/_/g, ' ')}`; }
  if (k === 'owner') { const [band, kind] = r; return `an active effort with no company, Jev suggested a ${kind} in the ${band} band`; }
  if (k === 'dup') return `a duplicate the finder marked ${r[0].replace(/_/g, ' ')}`;
  return pattern;
}

/** The standing rules as short sentences, for the Jev state object. Only auto rules; the rest are still forming. */
export function standingRules(rules = loadRules()): string[] {
  const out = Object.entries(rules).filter(([, r]) => r.auto && r.best).map(([p, r]) => `When ${describePattern(p)}: answer ${CHOICE(r.best!)} (confidence ${r.confidence}, ${r.support} cases).${r.notes?.length ? ' Owner says: ' + r.notes.map(n => n.text).join(' ') : ''}`);
  // Notes on forming rules are briefed too: they are the owner's words, which is exactly what Jev should weigh.
  for (const [p, r] of Object.entries(rules)) if (!r.auto && r.notes?.length) out.push(`On ${describePattern(p)}, the owner notes: ${r.notes.map(n => n.text).join(' ')}`);
  return out;
}

export function renderPolicy(rules = loadRules(), labels = loadLabels()): string {
  const auto = Object.entries(rules).filter(([, r]) => r.auto).sort((a, b) => b[1].support - a[1].support);
  const forming = Object.entries(rules).filter(([, r]) => !r.auto && r.support > 0).sort((a, b) => b[1].support - a[1].support);
  const human = labels.filter(l => l.source === 'human'); const byRule = labels.filter(l => l.source === 'rule');
  const recent = human.slice(-15).reverse();
  const L: string[] = [];
  L.push('---', 'type: context', 'status: active', `updated: ${new Date().toISOString().slice(0, 10)}`, 'tags: [context, celsus-os, decision-policy, skill]', '---', '', '# Celsus OS Decision Policy', '',
    `> How this vault's owner decides, learned from ${human.length} answers. ${auto.length} standing rules decide without asking; ${forming.length} are still forming. The normalizer reads this file on every run and briefs Jev with the standing rules. Laya is retrained from the same store (runs/laya). Rewritten automatically after every answer; edit the store in the app, not this text.`, '',
    '## Standing rules (decide without asking)', '');
  if (!auto.length) L.push('None yet. A rule stands at confidence 0.90 with 5 or more consistent answers.', '');
  for (const [p, r] of auto) L.push(`- When ${describePattern(p)}, the answer is **${CHOICE(r.best!)}**. Confidence ${r.confidence}, ${r.support} cases.${r.notes?.length ? ' Owner: ' + r.notes.map(n => '"' + n.text + '"').join(' ') : ''}`);
  L.push('', '## Forming rules (still asking)', '');
  for (const [p, r] of forming.slice(0, 40)) L.push(`- ${describePattern(p)}: leaning ${CHOICE(r.best!)} at ${r.confidence} (${r.support} ${r.support === 1 ? 'case' : 'cases'}; answers so far ${Object.entries(r.answers).map(([c, n]) => `${CHOICE(c)} ${n}`).join(', ')}).${r.notes?.length ? ' Owner: ' + r.notes.map(n => '"' + n.text + '"').join(' ') : ''}`);
  L.push('', '## Recent answers', '', '| When | Question | Answer |', '|---|---|---|');
  for (const l of recent) L.push(`| ${l.at.slice(0, 16).replace('T', ' ')} | ${(l.q || l.id).replace(/\|/g, '/')} | ${CHOICE(l.choice)} |`);
  L.push('', `## Decided by rule so far: ${byRule.length}`, '', 'Each one is listed in the app under "Decided for you" with undo. An undo lowers the rule that made it.', '');
  return L.join('\n').replace(/[\u2014\u2013]/g, '-');
}

/** The owner's best practices note, body only, for Laya's system prompt. Editable in Obsidian. */
export function bestPractices(): string { try { return fs.readFileSync(BEST_PRACTICES, 'utf8').replace(/^---[\s\S]*?---\s*/, '').replace(/[\u2014\u2013]/g, '-').trim(); } catch { return ''; } }

/** Laya's system prompt: who she is, the vault's conventions, the standing and forming rules, the owner's best practices. */
export function renderLayaSystem(rules = loadRules()): string {
  const auto = Object.entries(rules).filter(([, r]) => r.auto && r.best).sort((a, b) => b[1].support - a[1].support);
  const forming = Object.entries(rules).filter(([, r]) => !r.auto && r.support > 0 && r.best).sort((a, b) => b[1].support - a[1].support).slice(0, 20);
  const L: string[] = [];
  L.push('You are Laya, the writing model of Celsus OS, a second brain over an Obsidian vault. You draft and complete notes, answer questions about the vault from the dossiers you are given, and follow the owner\'s decision rules below. You never invent facts: when something is unknown you ask one short question or leave the field empty. You write plainly, with no em dashes or en dashes (use a comma or a plain hyphen), short paragraphs, and [[wikilinks]] to known entities exactly as titled.', '');
  L.push('Vault layout: Atlas/People, Atlas/Companies, Atlas/Clients, Atlas/Products hold one note per entity with typed frontmatter; Efforts/Active/<Name>/<Name>.md is an effort hub (never deleted, renamed instead); Projects, Calendar and Inbox hold working notes. Frontmatter keys come from Other/Templates and keep their order.', '');
  if (bestPractices()) L.push('Owner best practices:', bestPractices(), '');
  L.push('Standing rules (decided, apply without asking):'); if (!auto.length) L.push('- none yet');
  for (const [p, r] of auto) L.push(`- When ${describePattern(p)}: ${CHOICE(r.best!)}${r.notes?.length ? '. Owner: ' + r.notes.map(n => n.text).join(' ') : ''}`);
  L.push('', 'Forming rules (lean this way, but ask if unsure):'); if (!forming.length) L.push('- none yet');
  for (const [p, r] of forming) L.push(`- ${describePattern(p)}: leaning ${CHOICE(r.best!)} (${r.confidence})${r.notes?.length ? '. Owner: ' + r.notes.map(n => n.text).join(' ') : ''}`);
  return L.join('\n').replace(/[\u2014\u2013]/g, '-');
}

/** Writes runs/laya/system.md, train.jsonl and Modelfile. Run `ollama create celsus-laya -f runs/laya/Modelfile` to refresh the local model. */
export function writeLaya(rules = loadRules(), labels = loadLabels()): string {
  fs.mkdirSync(LAYA, { recursive: true });
  const system = renderLayaSystem(rules);
  fs.writeFileSync(path.join(LAYA, 'system.md'), system + '\n');
  const rows: string[] = [];
  for (const l of labels.filter(x => x.source === 'human' && x.q)) {
    const r = rules[l.pattern]; const why = r?.notes?.length ? ' Owner note: ' + r.notes.map(n => n.text).join(' ') : '';
    rows.push(JSON.stringify({ messages: [{ role: 'system', content: 'You decide vault hygiene questions the way the owner does. Answer with the choice and one line of reason.' }, { role: 'user', content: `${l.q}\nSituation: ${describePattern(l.pattern)}.` }, { role: 'assistant', content: `${CHOICE(l.choice)}.${why}` }] }));
  }
  for (const [p, r] of Object.entries(rules)) for (const n of r.notes || []) rows.push(JSON.stringify({ messages: [{ role: 'system', content: 'You explain the owner\'s reasoning for vault hygiene decisions.' }, { role: 'user', content: `Why does the owner decide this way for ${describePattern(p)}?` }, { role: 'assistant', content: n.text }] }));
  fs.writeFileSync(path.join(LAYA, 'train.jsonl'), rows.join('\n') + (rows.length ? '\n' : ''));
  const base = (loadConfig() as any)?.layaBase || 'llama3.1';
  const tq = '"'.repeat(3);
  const modelfile = ['# Celsus OS, Laya. Regenerated after every answer; create or refresh the local model with:', '#   ollama create celsus-laya -f "' + path.join(LAYA, 'Modelfile') + '"', `FROM ${base}`, 'PARAMETER temperature 0.2', 'PARAMETER num_ctx 8192', 'SYSTEM ' + tq, system, tq, ''].join('\n');
  fs.writeFileSync(path.join(LAYA, 'Modelfile'), modelfile);
  return LAYA;
}

export function writePolicy() { fs.mkdirSync(path.dirname(POLICY), { recursive: true }); fs.writeFileSync(POLICY, renderPolicy()); try { writeLaya(); } catch {} return POLICY; }

/** Labels indexed by card id, for scripts that must respect earlier answers. */
export function labelIndex(): Map<string, Label> { const m = new Map<string, Label>(); for (const l of loadLabels()) m.set(l.id, l); return m; }
