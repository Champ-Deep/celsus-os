// Celsus OS, Jev client. One key is enough: the classifier is reached through OpenRouter's Decisions
// API. A TypeSafe key is optional and only changes where the call goes. The key never lives in the
// vault, the repo, or a scheduled task prompt; it comes from the config file or the environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifierProvider, loadConfig, CONFIG_PATH, DEFAULT_CLASSIFIER } from './config.ts';

export const JEV_ENDPOINT = process.env.JEV_ENDPOINT || '';   // empty means: derive it from the provider
export const JEV_MODEL = process.env.JEV_MODEL || DEFAULT_CLASSIFIER;

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };
export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreAnswer { type: 'score'; score: number; probabilities?: Record<string, number>; confidence?: number; legend?: Record<string, string> }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface DecideResult { model: string; answers: Record<string, Answer>; usage?: { input_tokens: number; output_tokens: number; cost: number }; id?: string; latencyMs: number }

/**
 * Where the classifier will actually be called, and with whose key. A function, not a constant, so a
 * provider chosen in setup takes effect on the next call. As a module constant it did not: the
 * classifier recorded in config never reached the classifier, so setup appeared to save a setting it
 * silently ignored, and doctor printed a model that was not the one in use.
 */
export function jevTarget(): { name: 'typesafe' | 'openrouter'; endpoint: string; key: string; model: string } {
  if (JEV_ENDPOINT) return { name: 'openrouter', endpoint: JEV_ENDPOINT, key: process.env.JEV_KEY || loadConfig()?.openrouterKey || '', model: JEV_MODEL };
  return classifierProvider();
}

export function loadKey(): string {
  const t = jevTarget();
  if (t.key) return t.key;
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); if (c.openrouterKey) return c.openrouterKey; } catch { /* fall through */ }
  if (process.env.JEV_KEY) return process.env.JEV_KEY.trim();
  const f = process.env.JEV_KEY_FILE || path.join(os.homedir(), '.jev_key');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  throw new Error('No classifier key. Run: celsus setup, or set OPENROUTER_API_KEY in the environment.');
}

export async function decide(state: Record<string, unknown>, questions: Record<string, Question>, opts: { timeoutMs?: number; retries?: number } = {}): Promise<DecideResult> {
  const target = jevTarget();
  const key = loadKey();
  const model = target.model || JEV_MODEL;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(target.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model, state, questions }),
        signal: ctrl.signal,
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) throw new Error(`Jev HTTP ${res.status} at ${target.endpoint}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      return { model: json.model || model, answers: json.answers, usage: json.usage, id: json.id, latencyMs };
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
