// Celsus OS, configuration. One JSON file outside the vault: ~/.celsus-os/config.json (override with CELSUS_CONFIG).
// Holds the provider keys, the classifier model and the writing model. Never committed, never inside the vault.
//
// The design goal is one key for the whole company. An OpenRouter key is enough: it serves both the
// classifier (Jev, through OpenRouter's Decisions API) and the writing model. A TypeSafe key is
// optional and only changes where Jev is called from. A local model is optional and takes over the
// writing role when one is detected, so narration can run with no metered calls at all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CelsusConfig {
  openrouterKey: string;       // the one key that is enough for everything
  typesafeKey?: string;        // optional: call Jev direct from TypeSafe instead of via OpenRouter
  typesafeBaseUrl?: string;    // optional override, defaults to the TypeSafe endpoint
  classifier: string;          // decisions model, default typesafe/jev-1.13
  llm: string;                 // writing model id (OpenRouter id, or a local model name)
  llmBaseUrl?: string;         // empty for OpenRouter; an OpenAI compatible local endpoint (Ollama, LM Studio) otherwise
  llmMaxTokens: number;        // reasoning models spend completion tokens on thinking, keep this generous
  vaultPath?: string;
  runsPath?: string;           // override where runs are written; default is derived from the vault shape
  kindFolders?: Record<string, string>;  // folder prefix -> kind, replaces the built-in table
  noteFolders?: Record<string, string>;  // kind -> folder new notes are written into
  createdAt: string;
  layaBase?: string;
}

export const CONFIG_PATH = process.env.CELSUS_CONFIG || path.join(os.homedir(), '.celsus-os', 'config.json');
export const DEFAULT_CLASSIFIER = 'typesafe/jev-1.13';
export const OPENROUTER_DECISIONS = 'https://openrouter.ai/api/alpha/decisions';
export const TYPESAFE_DECISIONS = 'https://api.typesafe.ai/v1/decisions';

// Writing-model defaults, best first. A free or near-free model is always available, so setup never
// has to ask the owner to spend money to get started. Space Bunny Alpha is the current favourite
// while its tag is live; the fallbacks are cheap and fast rather than clever.
export const TESTING_LLM = 'stealth/space-bunny-alpha';
export const FREE_LLM_FALLBACKS = ['deepseek/deepseek-v4-flash', 'openrouter/omni', 'google/gemini-2.0-flash-exp:free'];
/** Models worth suggesting once the owner already has a key and wants better prose. */
export const PAID_LLM_SUGGESTIONS = ['anthropic/claude-sonnet-4.5', 'openai/gpt-4.1-mini', 'google/gemini-2.5-flash'];

export function loadConfig(): CelsusConfig | null {
  if (fs.existsSync(CONFIG_PATH)) {
    try { return { ...emptyConfig(), ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch { /* fall through to env */ }
  }
  // Environment only, for CI and for people who would rather not keep a key on disk.
  const key = process.env.OPENROUTER_API_KEY || process.env.JEV_KEY || '';
  if (!key) return null;
  return { ...emptyConfig(), openrouterKey: key, llm: process.env.CELSUS_LLM || TESTING_LLM, createdAt: new Date().toISOString() };
}

export function emptyConfig(): CelsusConfig {
  return { openrouterKey: '', classifier: DEFAULT_CLASSIFIER, llm: TESTING_LLM, llmMaxTokens: 6000, createdAt: new Date().toISOString() };
}

export function saveConfig(c: CelsusConfig) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function requireConfig(): CelsusConfig {
  const c = loadConfig();
  if (!c) throw new Error(`No configuration. Run: celsus setup (writes ${CONFIG_PATH})`);
  return c;
}

/** Which service answers Jev. A TypeSafe key wins when present, otherwise OpenRouter. */
export function classifierProvider(c: CelsusConfig = requireConfig()): { name: 'typesafe' | 'openrouter'; endpoint: string; key: string; model: string } {
  if (c.typesafeKey) return { name: 'typesafe', endpoint: c.typesafeBaseUrl || TYPESAFE_DECISIONS, key: c.typesafeKey, model: c.classifier || DEFAULT_CLASSIFIER };
  return { name: 'openrouter', endpoint: process.env.JEV_ENDPOINT || OPENROUTER_DECISIONS, key: c.openrouterKey, model: c.classifier || DEFAULT_CLASSIFIER };
}

export interface LocalModel { baseUrl: string; name: string; server: 'ollama' | 'lmstudio' | 'openai-compatible' }

/**
 * Probe the two local servers people actually run, without pulling in an SDK: Ollama and LM Studio
 * both answer a plain GET on localhost. A hit is what lets setup offer a zero-cost writing model, so
 * this is best-effort with a short timeout and never throws.
 */
export async function detectLocalModels(timeoutMs = 900): Promise<LocalModel[]> {
  const targets: { url: string; server: LocalModel['server']; kind: 'tags' | 'models' }[] = [
    { url: 'http://127.0.0.1:11434/api/tags', server: 'ollama', kind: 'tags' },
    { url: 'http://127.0.0.1:1234/v1/models', server: 'lmstudio', kind: 'models' },
    { url: 'http://127.0.0.1:8080/v1/models', server: 'openai-compatible', kind: 'models' },
  ];
  const found: LocalModel[] = [];
  await Promise.all(targets.map(async t => {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(t.url, { signal: ctrl.signal });
      if (!r.ok) return;
      const j: any = await r.json();
      const names: string[] = (j.models || j.data || []).map((m: any) => m.name || m.id).filter(Boolean);
      const base = t.server === 'ollama' ? 'http://127.0.0.1:11434/v1' : t.url.replace(/\/v1\/models$/, '/v1').replace(/\/api\/tags$/, '/v1');
      for (const n of names) found.push({ baseUrl: base, name: n, server: t.server });
    } catch { /* nothing listening, which is the normal case */ } finally { clearTimeout(timer); }
  }));
  return found;
}
