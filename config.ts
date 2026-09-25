// Celsus OS, configuration. One JSON file outside the vault: ~/.celsus-os/config.json (override with CELSUS_CONFIG).
// Holds the OpenRouter key, the classifier model and the LLM. Never committed, never inside the vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CelsusConfig {
  openrouterKey: string;
  classifier: string;          // decisions model, default typesafe/jev-1.13
  llm: string;                 // chat model for narration and authored views
  llmBaseUrl?: string;         // empty for OpenRouter; an OpenAI compatible local endpoint (Ollama, LM Studio) otherwise
  llmMaxTokens: number;        // reasoning models spend completion tokens on thinking, keep this generous
  vaultPath?: string;
  createdAt: string;
}

export const CONFIG_PATH = process.env.CELSUS_CONFIG || path.join(os.homedir(), '.celsus-os', 'config.json');
export const DEFAULT_CLASSIFIER = 'typesafe/jev-1.13';
// Testing default while the stealth tag is live. When OpenRouter retires it, setup asks the user to choose.
export const TESTING_LLM = 'stealth/space-bunny-alpha';
export const FREE_LLM_FALLBACKS = ['deepseek/deepseek-v4-flash', 'openrouter/omni'];

export function loadConfig(): CelsusConfig | null {
  if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  // Migration path for the Phase 1 key file.
  const legacy = path.join(os.homedir(), '.jev_key');
  const key = process.env.OPENROUTER_API_KEY || process.env.JEV_KEY || (fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf8').trim() : '');
  if (!key) return null;
  return { openrouterKey: key, classifier: DEFAULT_CLASSIFIER, llm: process.env.CELSUS_LLM || TESTING_LLM, llmMaxTokens: 6000, createdAt: new Date().toISOString() };
}

export function saveConfig(c: CelsusConfig) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

export function requireConfig(): CelsusConfig {
  const c = loadConfig();
  if (!c) throw new Error(`No configuration. Run: node setup.ts (writes ${CONFIG_PATH})`);
  return c;
}
