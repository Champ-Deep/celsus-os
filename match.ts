// Celsus OS, candidate generator. Deterministic, local, cheap. Jev only ever sees the shortlist this produces.
import type { Entity, Glossary } from './glossary.ts';
import { normalizeKey } from './vault.ts';

export interface Candidate { id: string; title: string; kind: string; score: number; via: string; matchedName: string }

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
export const editRatio = (a: string, b: string) => 1 - editDistance(a, b) / Math.max(a.length, b.length, 1);

const STOP = new Set(['and', 'of', 'the', 'for', 'a', 'an', 'to', 'in', 'on', 'with', 'md']);
export const tokens = (k: string) => k.split(' ').filter(t => t && !STOP.has(t));
export const initials = (k: string) => tokens(k).map(t => t[0]).join('');
export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
}
/** Token-level fuzzy overlap: a token counts as shared if it is within one edit of a token on the other side. */
export function fuzzyTokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  let hit = 0;
  for (const x of a) if (b.some(y => x === y || (x.length > 3 && editDistance(x, y) <= 1))) hit++;
  return hit / Math.max(a.length, b.length);
}

/** Similarity of a mention key to one entity name key, in [0,1], with the rule that fired. */
export function similarity(mk: string, nk: string): { score: number; via: string } {
  if (mk === nk) return { score: 1, via: 'exact' };
  const mt = tokens(mk), nt = tokens(nk);
  const mc = mk.replace(/ /g, ''), nc = nk.replace(/ /g, '');
  if (mc === nc) return { score: 0.98, via: 'spacing' };
  if (mt.length === 1 && nt.length > 1 && mk.length >= 2 && mk.length <= 6 && initials(nk) === mk) return { score: 0.9, via: 'initials' };
  const er = editRatio(mc, nc);
  if (er >= 0.85) return { score: 0.8 + (er - 0.85) * 1.2, via: 'spelling' };
  const fto = fuzzyTokenOverlap(mt, nt);
  const jac = jaccard(mt, nt);
  if (fto >= 0.99 && mt.length === nt.length) return { score: 0.9, via: 'token-spelling' };
  const shorter = mk.length < nk.length ? mk : nk, longer = mk.length < nk.length ? nk : mk;
  if (shorter.length >= 5 && (longer.startsWith(shorter + ' ') || longer.endsWith(' ' + shorter) || longer.includes(' ' + shorter + ' '))) {
    return { score: 0.6 + 0.3 * (shorter.length / longer.length), via: 'contains' };
  }
  if (jac > 0) return { score: 0.4 + 0.45 * Math.max(jac, fto), via: 'tokens' };
  if (er >= 0.7) return { score: 0.4 + (er - 0.7) * 2, via: 'spelling-weak' };
  return { score: 0, via: 'none' };
}

export interface MatchResult { key: string; exact: string[]; candidates: Candidate[] }

export function match(mention: string, g: Glossary, opts = { top: 5, floor: 0.55 }): MatchResult {
  const key = normalizeKey(mention);
  const exact = g.byKey.get(key) || [];
  if (exact.length) return { key, exact, candidates: exact.map(id => ({ id, title: g.byId.get(id)!.title, kind: g.byId.get(id)!.kind, score: 1, via: 'exact', matchedName: mention })) };
  const scored: Candidate[] = [];
  for (const e of g.entities) {
    let best: Candidate | null = null;
    for (const name of e.names) {
      const nk = normalizeKey(name);
      if (!nk) continue;
      if (Math.abs(nk.length - key.length) > Math.max(12, key.length)) continue;
      const { score, via } = similarity(key, nk);
      if (score >= opts.floor && (!best || score > best.score)) best = { id: e.id, title: e.title, kind: e.kind, score: +score.toFixed(3), via, matchedName: name };
    }
    if (best) scored.push(best);
  }
  scored.sort((a, b) => b.score - a.score || a.title.length - b.title.length);
  return { key, exact, candidates: scored.slice(0, opts.top) };
}

export function shouldAutoResolve(r: MatchResult): boolean {
  return r.exact.length === 1;
}
export type { Entity };
