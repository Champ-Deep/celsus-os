// Celsus OS, Jev client. OpenRouter Decisions API (alpha). Key comes from JEV_KEY or a file at JEV_KEY_FILE
// (default ~/.jev_key). The key never lives in the vault, the repo, or a scheduled task prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const JEV_ENDPOINT = process.env.JEV_ENDPOINT || 'https://openrouter.ai/api/alpha/decisions';
export const JEV_MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };
export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreAnswer { type: 'score'; score: number; probabilities?: Record<string, number>; confidence?: number; legend?: Record<string, string> }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface DecideResult { model: string; answers: Record<string, Answer>; usage?: { input_tokens: number; output_tokens: number; cost: number }; id?: string; latencyMs: number }

export function loadKey(): string {
  try { const c = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.celsus-os', 'config.json'), 'utf8')); if (c.openrouterKey) return c.openrouterKey; } catch {}
  if (process.env.JEV_KEY) return process.env.JEV_KEY.trim();
  const f = process.env.JEV_KEY_FILE || path.join(os.homedir(), '.jev_key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('No Jev key. Set JEV_KEY or write it to ~/.jev_key (outside the vault).');
}

export async function decide(state: Record<string, unknown>, questions: Record<string, Question>, opts: { timeoutMs?: number; retries?: number } = {}): Promise<DecideResult> {
  const key = loadKey();
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: ctrl.signal,
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return { model: json.model, answers: json.answers, usage: json.usage, id: json.id, latencyMs };
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

/** Run decisions with bounded concurrency. Failures are returned, not thrown, so a run never dies on one call. */
export async function decideAll<T>(items: T[], fn: (item: T) => Promise<DecideResult>, concurrency = 8): Promise<(DecideResult | { error: string; latencyMs: number })[]> {
  const out: (DecideResult | { error: string; latencyMs: number })[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const t0 = Date.now();
      try { out[idx] = await fn(items[idx]); }
      catch (e) { out[idx] = { error: String((e as Error).message || e), latencyMs: Date.now() - t0 }; }
    }
  }));
  return out;
}
