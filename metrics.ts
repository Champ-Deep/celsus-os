// Celsus OS, graph metrics. The before and after numbers for Phase 3. Same definitions every run.
import { normalizeKey } from './vault.ts';
import type { Note } from './vault.ts';
import type { Glossary } from './glossary.ts';

export interface Metrics {
  notes: number; links: number; resolvedLinks: number; phantomTargets: number; phantomOccurrences: number;
  orphans: number; isolated: number; fragmentedEntities: number; topHubs: { id: string; inDegree: number; spellings: number }[];
}

/**
 * resolution: raw link target (normalized key) -> entity id. Rule and accepted Jev resolutions both land here.
 * Links that resolve through the glossary exactly count as resolved even without an entry.
 */
export function computeMetrics(notes: Note[], g: Glossary, resolution: Map<string, string> = new Map()): Metrics {
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const spellings = new Map<string, Set<string>>();
  const phantom = new Map<string, number>();
  let links = 0, resolvedLinks = 0;
  for (const n of notes) {
    for (const l of n.links) {
      links++;
      const key = normalizeKey(l.target);
      let id = resolution.get(key);
      if (!id) { const ids = g.byKey.get(key); if (ids && ids.length === 1) id = ids[0]; else if (ids && ids.length > 1) id = ids[0]; }
      if (!id) { phantom.set(key, (phantom.get(key) || 0) + 1); continue; }
      resolvedLinks++;
      if (id !== n.path) { inDeg.set(id, (inDeg.get(id) || 0) + 1); outDeg.set(n.path, (outDeg.get(n.path) || 0) + 1); }
      const s = spellings.get(id) || new Set(); s.add(l.target); spellings.set(id, s);
    }
  }
  const orphans = notes.filter(n => !(inDeg.get(n.path))).length;
  const isolated = notes.filter(n => !(inDeg.get(n.path)) && !(outDeg.get(n.path))).length;
  const fragmentedEntities = [...spellings.values()].filter(s => s.size > 2).length;
  const topHubs = [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, d]) => ({ id, inDegree: d, spellings: spellings.get(id)?.size || 0 }));
  return { notes: notes.length, links, resolvedLinks, phantomTargets: phantom.size, phantomOccurrences: [...phantom.values()].reduce((a, b) => a + b, 0), orphans, isolated, fragmentedEntities, topHubs };
}
