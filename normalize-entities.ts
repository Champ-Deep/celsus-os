// Celsus OS, Phase 1 runner: the entity and title normalizer.
// Collects every entity mention in the vault (wikilink targets, company fields, task context and effort tags),
// resolves the exact ones by rule, shortlists the rest locally, and asks Jev only to pick among the shortlist.
// Shadow mode: nothing in the vault is edited. Outputs land in today's run folder under the Celsus home (todayRunDir in vault.ts).
//
//   node normalize-entities.ts                 dry run, rules and shortlists only, no network
//   node normalize-entities.ts --live          also ask Jev (names and titles only leave the machine)
//   node normalize-entities.ts --live --limit 200 --min-count 2 --concurrency 8
import fs from 'node:fs';
import path from 'node:path';
import { readVault, normalizeKey, ensureDir, todayStamp, todayRunDir } from './vault.ts';
import type { Note } from './vault.ts';
import { buildGlossary, keyCollisions, resolveExact } from './glossary.ts';
import type { Glossary } from './glossary.ts';
import { match } from './match.ts';
import type { MatchResult } from './match.ts';
import { decide, decideAll, JEV_MODEL } from './jev.ts';
import type { DecideResult, Question } from './jev.ts';
import { computeMetrics } from './metrics.ts';
import type { Metrics } from './metrics.ts';
import { labelIndex, standingRules } from './policy.ts';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: string) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const LIVE = flag('--live');
const LIMIT = parseInt(opt('--limit', '400'), 10);
const MIN_COUNT = parseInt(opt('--min-count', '1'), 10);
const CONCURRENCY = parseInt(opt('--concurrency', '8'), 10);
const OUT = opt('--out', todayRunDir());
const THRESHOLDS = { merge: { p: 0.85, confidence: 0.6 }, newEntity: { p: 0.7 } }; // initial, replaced by the calibration curve

type MentionKind = 'wikilink' | 'company_field' | 'task_context' | 'task_effort';
interface Mention { key: string; mention: string; count: number; kinds: Record<MentionKind, number>; spellings: Record<string, number>; folders: Record<string, number>; sources: string[] }
interface Judged extends Mention { bucket: 'resolved_exact' | 'ambiguous_exact' | 'shortlist' | 'unmatched'; match: MatchResult; resolvedId?: string; rule?: string }

const NEVER = new Set(['tools','user','setup','security','history','review','architecture','pipeline','identity','readme','changelog','install','memory','tasks','claude','vision','celsus','marketing','brief','output','script','scripts','form','forms','template','route','refresh','proxy','layout','analytics','videos','date','name','note','error','fetch','link','links','image','loading','logging','runtime','redirect','connection','contributing','accessibility','authentication','unauthorized','sitemap','debugging','after','default','wikilink']);
const STRUCTURAL = new Set(['skill','design','readme','context','changelog','agents','claude','index','overview','license','brief','meeting history','pain points','solution mapping','00 summary']);
const isJunk = (key: string) => !key || key.length < 2 || NEVER.has(key) || STRUCTURAL.has(key) || /^\d{4} \d{2} \d{2}/.test(key) || /^\d+$/.test(key) || /\.(png|jpg|jpeg|gif|svg|pdf|webp|mp4|mov|excalidraw)$/i.test(key);

function collectMentions(notes: Note[]): Mention[] {
  const map = new Map<string, Mention>();
  const add = (raw: string, kind: MentionKind, n: Note) => {
    let t = raw.trim();
    if (t.includes('/')) t = t.split('/').pop()!.trim();          // path form link: resolve by basename
    t = t.replace(/\.md$/i, '');
    const key = normalizeKey(t);
    if (isJunk(key)) return;
    let m = map.get(key);
    if (!m) { m = { key, mention: t, count: 0, kinds: { wikilink: 0, company_field: 0, task_context: 0, task_effort: 0 }, spellings: {}, folders: {}, sources: [] }; map.set(key, m); }
    m.count++; m.kinds[kind]++;
    m.spellings[t] = (m.spellings[t] || 0) + 1;
    m.folders[n.folder] = (m.folders[n.folder] || 0) + 1;
    if (m.sources.length < 3 && !m.sources.includes(n.path)) m.sources.push(n.path);
  };
  for (const n of notes) {
    for (const l of n.links) if (!l.embed) add(l.target, 'wikilink', n);
    if (n.company) add(n.company, 'company_field', n);
    for (const c of n.taskContexts) add(c, 'task_context', n);
    for (const e of n.taskEfforts) add(e, 'task_effort', n);
  }
  for (const m of map.values()) m.mention = Object.entries(m.spellings).sort((a, b) => b[1] - a[1])[0][0];
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function judge(mentions: Mention[], g: Glossary): Judged[] {
  return mentions.map(m => {
    const r = match(m.mention, g);
    if (r.exact.length) {
      const settled = resolveExact(r.exact, g, m.key);
      if (settled) return { ...m, bucket: 'resolved_exact', match: r, resolvedId: settled.id, rule: settled.rule };
      return { ...m, bucket: 'ambiguous_exact', match: r };
    }
    return { ...m, bucket: r.candidates.length ? 'shortlist' : 'unmatched', match: r };
  });
}

const dominantKind = (m: Mention) => (Object.entries(m.kinds).sort((a, b) => b[1] - a[1])[0][0]) as MentionKind;

function buildQuestions(j: Judged, g: Glossary): { state: Record<string, unknown>; questions: Record<string, Question>; keyToId: Record<string, string> } {
  const criteria: Record<string, string> = {};
  const keyToId: Record<string, string> = {};
  j.match.candidates.forEach((c, i) => {
    const e = g.byId.get(c.id)!;
    const k = `c${i + 1}`;
    keyToId[k] = c.id;
    const aka = e.aliases.length ? `; also written as ${e.aliases.slice(0, 6).join(', ')}` : '';
    criteria[k] = `${e.title} (${e.kind}${aka})`;
  });
  criteria.none = 'None of these. The mention is a different entity, a generic word, or too unclear to tell.';
  const state = {
    task: 'Vault entity resolution. Decide whether a written mention refers to one of the candidate canonical entities. Mentions are often misspelled, abbreviated, use an old name, a nickname, or a different word order.',
    mention: j.mention,
    other_spellings_seen: Object.keys(j.spellings).filter(s => s !== j.mention).slice(0, 5),
    mention_kind: dominantKind(j),
    occurrences: j.count,
    seen_in_folders: Object.keys(j.folders).slice(0, 5),
    owners_standing_rules: standingRules().slice(0, 12),
  };
  const questions: Record<string, Question> = {
    canonical: { type: 'choice', instructions: 'Which candidate is the same real world entity as the mention? Choose none unless one candidate clearly is the same person, company, product, client, effort or note.', criteria },
    mention_type: { type: 'choice', instructions: 'What kind of thing is the mention?', criteria: { person: 'A person', company: 'A company or organisation', product: 'A product, tool, app or service', client: 'A client account', effort: 'A project, effort, campaign or initiative', topic: 'A concept, topic, or generic term', other: 'Something else or unclear' } },
  };
  return { state, questions, keyToId };
}

type Verdict = 'merge' | 'new_entity' | 'review' | 'error';
function verdictOf(res: DecideResult | { error: string }): { verdict: Verdict; choice?: string; p?: number; confidence?: number } {
  if ('error' in res) return { verdict: 'error' };
  const a = res.answers.canonical;
  if (a.type !== 'choice') return { verdict: 'error' };
  const p = a.probabilities[a.choice] ?? 0;
  if (a.choice === 'none') return { verdict: p >= THRESHOLDS.newEntity.p ? 'new_entity' : 'review', choice: a.choice, p, confidence: a.confidence };
  if (p >= THRESHOLDS.merge.p && a.confidence >= THRESHOLDS.merge.confidence) return { verdict: 'merge', choice: a.choice, p, confidence: a.confidence };
  return { verdict: 'review', choice: a.choice, p, confidence: a.confidence };
}

const pct = (a: number, b: number) => b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a';
const quantile = (xs: number[], q: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

async function main() {
  const t0 = Date.now();
  const notes = readVault();
  const g = buildGlossary(notes);
  const mentions = collectMentions(notes);
  const judged = judge(mentions, g);
  ensureDir(OUT);
  const buckets = { resolved_exact: 0, ambiguous_exact: 0, shortlist: 0, unmatched: 0 } as Record<string, number>;
  const rules: Record<string, number> = {};
  for (const j of judged) { buckets[j.bucket]++; if (j.rule) rules[j.rule] = (rules[j.rule] || 0) + 1; }
  const before = computeMetrics(notes, g);
  const resolution = new Map<string, string>();
  for (const j of judged) if (j.bucket === 'resolved_exact' && j.resolvedId) resolution.set(j.key, j.resolvedId);

  // Jev shadow pass
  // Earlier answers win: a labelled mention is applied, never asked again. Standing rules are sent to Jev as state.
  const labels = labelIndex(); const rulesText = standingRules(); let applied = 0;
  for (const j of judged) { const l = labels.get('ent:' + j.key); if (!l) continue; const [act, id] = l.choice.split(':'); if (act === 'same' && id) { resolution.set(j.key, id); j.bucket = 'resolved_exact'; j.rule = 'label'; applied++; } else if (act === 'different' || act === 'new' || act === 'ignore' || act === 'part') { j.bucket = act === 'ignore' ? 'unmatched' : j.bucket; j.rule = 'label:' + act; applied++; } }
  if (applied) console.log(`${applied} mentions settled by earlier answers, ${rulesText.length} standing rules briefed to Jev`);
  const toJudge = judged.filter(j => (j.bucket === 'shortlist' || j.bucket === 'ambiguous_exact') && j.count >= MIN_COUNT && !labels.has('ent:' + j.key)).slice(0, LIMIT);
  const decisions: any[] = [];
  let usageIn = 0, cost = 0, model = JEV_MODEL;
  if (LIVE && toJudge.length) {
    const prepared = toJudge.map(j => {
      if (j.bucket === 'ambiguous_exact') j.match.candidates = j.match.exact.map(id => ({ id, title: g.byId.get(id)!.title, kind: g.byId.get(id)!.kind, score: 1, via: 'exact', matchedName: j.mention }));
      return { j, ...buildQuestions(j, g) };
    });
    const results = await decideAll(prepared, p => decide(p.state, p.questions), CONCURRENCY);
    results.forEach((res, i) => {
      const { j, keyToId, state } = prepared[i];
      const v = verdictOf(res);
      const chosenId = v.choice && v.choice !== 'none' ? keyToId[v.choice] : undefined;
      if (!('error' in res)) { usageIn += res.usage?.input_tokens || 0; cost += res.usage?.cost || 0; model = res.model || model; }
      if (v.verdict === 'merge' && chosenId) resolution.set(j.key, chosenId);
      decisions.push({ key: j.key, mention: j.mention, count: j.count, bucket: j.bucket, mention_kind: state.mention_kind, candidates: j.match.candidates.map(c => ({ id: c.id, score: c.score, via: c.via })), keyToId, answers: 'error' in res ? undefined : res.answers, error: 'error' in res ? res.error : undefined, model: 'error' in res ? undefined : res.model, latencyMs: res.latencyMs, usage: 'error' in res ? undefined : res.usage, verdict: v.verdict, chosenId, p: v.p, confidence: v.confidence, human_label: '' });
    });
    fs.writeFileSync(path.join(OUT, 'decisions.jsonl'), decisions.map(d => JSON.stringify(d)).join('\n') + '\n');
  }
  const after = computeMetrics(notes, g, resolution);

  // Files
  fs.writeFileSync(path.join(OUT, 'glossary.json'), JSON.stringify({ generated: new Date().toISOString(), count: g.entities.length, entities: g.entities }, null, 1));
  fs.writeFileSync(path.join(OUT, 'mentions.json'), JSON.stringify(judged.map(j => ({ key: j.key, mention: j.mention, count: j.count, bucket: j.bucket, kinds: j.kinds, spellings: j.spellings, exact: j.match.exact, candidates: j.match.candidates, sources: j.sources })), null, 1));
  // Ghost nodes: entities that are linked but have no note. The indexer renders them distinctly instead of dropping them.
  const typeOf = new Map(decisions.filter(d => d.answers?.mention_type?.choice).map(d => [d.key, d.answers.mention_type.choice]));
  const ghosts = judged.filter(j => (j.bucket === 'unmatched' || (decisions.length && decisions.find(d => d.key === j.key)?.verdict === 'new_entity')) && j.count >= 2)
    .map(j => ({ key: j.key, name: j.mention, count: j.count, type: typeOf.get(j.key) || 'unknown', spellings: Object.keys(j.spellings) })).sort((a, b) => b.count - a.count);
  fs.writeFileSync(path.join(OUT, 'resolutions.json'), JSON.stringify({ generated: new Date().toISOString(), thresholds: THRESHOLDS, entries: Object.fromEntries(resolution), ghosts }, null, 1));
  fs.writeFileSync(path.join(OUT, 'baseline.json'), JSON.stringify({ generated: new Date().toISOString(), before, after }, null, 1));
  const gold = ['key,mention,count,bucket,top_candidate,top_candidate_score,jev_choice_id,jev_p,jev_confidence,verdict,human_label_id,human_note'];
  const goldRows = decisions.length ? decisions : toJudge.map(j => ({ key: j.key, mention: j.mention, count: j.count, bucket: j.bucket, candidates: j.match.candidates, chosenId: '', p: '', confidence: '', verdict: '' }));
  for (const d of goldRows) { const c0 = d.candidates[0] || {}; gold.push([d.key, d.mention, d.count, d.bucket, c0.id || '', c0.score ?? '', d.chosenId || '', d.p ?? '', d.confidence ?? '', d.verdict || '', '', ''].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')); }
  fs.writeFileSync(path.join(OUT, 'gold-template.csv'), gold.join('\n') + '\n');

  // Report
  const lat = decisions.filter(d => !d.error).map(d => d.latencyMs);
  const vc: Record<string, number> = {}; for (const d of decisions) vc[d.verdict] = (vc[d.verdict] || 0) + 1;
  const collisions = keyCollisions(g);
  const phantoms = judged.filter(j => j.bucket === 'unmatched').slice(0, 25);
  const L: string[] = [];
  L.push(`# Celsus OS normalizer run, ${todayStamp()}`, '', `> ${LIVE ? 'Live shadow run: Jev judged ' + decisions.length + ' shortlisted mentions. ' : 'Dry run: rules and shortlists only, no network. '}Nothing in the vault was edited. Notes ${notes.length}, wikilinks ${before.links}, glossary entities ${g.entities.length}, distinct mentions ${judged.length}. Wall time ${((Date.now() - t0) / 1000).toFixed(1)}s.`, '');
  L.push('## Graph metrics, before and after applying the resolution map', '', '| Metric | Before (raw vault) | After (rules' + (LIVE ? ' plus Jev merges' : '') + ') |', '|---|---|---|');
  const row = (k: keyof Metrics, label: string) => L.push(`| ${label} | ${(before as any)[k]} | ${(after as any)[k]} |`);
  row('resolvedLinks', 'Links resolved to a note'); row('phantomTargets', 'Phantom targets (distinct link targets with no note)'); row('phantomOccurrences', 'Phantom occurrences'); row('orphans', 'Orphans (no inbound links)'); row('isolated', 'Isolated (no links either way)'); row('fragmentedEntities', 'Fragmented entities (3 or more spellings pointing at one note)');
  L.push('', '## Mention buckets', '', '| Bucket | Distinct mentions | Meaning |', '|---|---|---|', `| resolved_exact | ${buckets.resolved_exact} | Title, basename or alias matched. Rule resolved, no Jev call (${Object.entries(rules).map(([k, v]) => k + ' ' + v).join(', ')}) |`, `| ambiguous_exact | ${buckets.ambiguous_exact} | The same name belongs to differently titled notes at equal precedence. Jev picks |`, `| shortlist | ${buckets.shortlist} | No exact match, one to five fuzzy candidates. Jev picks |`, `| unmatched | ${buckets.unmatched} | No candidate at all. New entity, generic word, or a dead link |`, '');
  if (LIVE) {
    L.push('## Jev shadow results', '', `Model returned: ${model}. Decisions ${decisions.length}, errors ${vc.error || 0}. Verdicts: merge ${vc.merge || 0}, review ${vc.review || 0}, new_entity ${vc.new_entity || 0}. Latency p50 ${quantile(lat, 0.5)} ms, p95 ${quantile(lat, 0.95)} ms. Input tokens ${usageIn}, cost USD ${cost.toFixed(4)}.`, '', `Thresholds in force: merge when p >= ${THRESHOLDS.merge.p} and confidence >= ${THRESHOLDS.merge.confidence}; new_entity when none >= ${THRESHOLDS.newEntity.p}; everything else review. These are starting values, the gold template replaces them.`, '');
    const show = (v: Verdict, n: number, title: string) => { const xs = decisions.filter(d => d.verdict === v).sort((a, b) => b.count - a.count).slice(0, n); if (!xs.length) return; L.push(`### ${title}`, '', '| Mention | Count | Jev picked | p | conf | Top local candidate (score, rule) |', '|---|---|---|---|---|---|'); for (const d of xs) { const c0 = d.candidates[0] || {}; L.push(`| ${d.mention} | ${d.count} | ${d.chosenId ? g.byId.get(d.chosenId)?.title : 'none'} | ${d.p?.toFixed(2)} | ${d.confidence?.toFixed(2) ?? ''} | ${c0.id ? g.byId.get(c0.id)?.title : ''} (${c0.score ?? ''}, ${c0.via ?? ''}) |`); } L.push(''); };
    show('merge', 25, 'Merges Jev is confident about (verify a sample before trusting)'); show('review', 25, 'Review band, ten seconds each'); show('new_entity', 15, 'Jev says none of the candidates');
  } else if (toJudge.length) {
    L.push('## Shortlist sample (what Jev would be asked)', '', '| Mention | Count | Candidates (score, rule) |', '|---|---|---|');
    for (const j of toJudge.slice(0, 30)) L.push(`| ${j.mention} | ${j.count} | ${j.match.candidates.map(c => `${c.title} (${c.score}, ${c.via})`).join('; ')} |`);
    L.push('');
  }
  L.push('## Top phantom targets with no candidate at all', '', '| Target | Count | Kinds |', '|---|---|---|');
  for (const p of phantoms) L.push(`| ${p.mention} | ${p.count} | ${Object.entries(p.kinds).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  L.push('', `## Name collisions inside the glossary (${collisions.length})`, '', 'The same title, basename or alias is claimed by more than one note. Jev cannot fix these, the vault can.', '');
  for (const c of collisions.slice(0, 30)) L.push(`- ${c.key}: ${c.ids.join(' | ')}`);
  L.push('', '## Top hubs after resolution', '', '| Note | Inbound links | Distinct spellings pointing at it |', '|---|---|---|');
  for (const h of after.topHubs) L.push(`| ${h.id} | ${h.inDegree} | ${h.spellings} |`);
  L.push('', '## Files in this run', '', '`glossary.json` the canonical registry. `mentions.json` every distinct mention with its bucket and shortlist. `resolutions.json` the alias to canonical id map an indexer can apply. `baseline.json` the metrics above. `gold-template.csv` fill `human_label_id` to build the calibration set.' + (LIVE ? ' `decisions.jsonl` one row per Jev call with the full distribution, latency and usage.' : ''), '');
  // Vault rule: no em or en dashes in any output. Raw data keeps the original strings, the report does not.
  fs.writeFileSync(path.join(OUT, 'report.md'), L.join('\n').replace(/[\u2014\u2013]/g, '-'));
  console.log(`run written to ${OUT}`);
  console.log(JSON.stringify({ notes: notes.length, entities: g.entities.length, mentions: judged.length, buckets, before, after: { resolvedLinks: after.resolvedLinks, phantomTargets: after.phantomTargets, orphans: after.orphans, fragmentedEntities: after.fragmentedEntities }, jev: LIVE ? { decisions: decisions.length, verdicts: vc, p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), cost } : 'dry-run' }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
