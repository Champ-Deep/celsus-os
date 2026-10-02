// Celsus OS, first run setup. Writes ~/.celsus-os/config.json (override with CELSUS_CONFIG).
//   node setup.ts                          interactive
//   node setup.ts --vault PATH --key KEY    non-interactive, for CI and for scripted installs
//   node setup.ts --yes                    take every default, probe for local models, never prompt
//
// The promise to a teammate is one key. An OpenRouter key serves both the classifier and the writer.
// A TypeSafe key is optional and only changes where the classifier is called from. A local model is
// detected, not asked for: if Ollama or LM Studio happens to be running, it is offered as the writer
// so narration can run at no cost.
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  saveConfig, loadConfig, emptyConfig, CONFIG_PATH, DEFAULT_CLASSIFIER,
  TESTING_LLM, FREE_LLM_FALLBACKS, PAID_LLM_SUGGESTIONS, detectLocalModels,
} from './config.ts';
import { countMarkdown } from './vault.ts';
import type { CelsusConfig, LocalModel } from './config.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const has = (name: string) => argv.includes(name);
const nonInteractive = has('--yes') || !!flag('--vault') || !!flag('--key');

async function openRouterModels(key: string): Promise<Set<string>> {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return new Set();
    const j: any = await r.json();
    return new Set((j.data || []).map((m: any) => m.id));
  } catch { return new Set(); }
}

async function main() {
  const existing = loadConfig();
  const base: CelsusConfig = { ...emptyConfig(), ...(existing || {}) };
  console.log('Celsus OS setup. Answers go to ' + CONFIG_PATH + ', outside the vault, never committed.\n');

  // 1. The one key that is enough.
  let key = flag('--key') || process.env.OPENROUTER_API_KEY || '';
  if (!key) {
    if (nonInteractive) { console.error('An OpenRouter key is required. Pass --key or set OPENROUTER_API_KEY.'); process.exit(1); }
    const rl = readline.createInterface({ input, output });
    key = (await rl.question(`1. OpenRouter API key${existing?.openrouterKey ? ' [keep current]' : ''}: `)).trim() || existing?.openrouterKey || '';
    rl.close();
  }
  if (!key) { console.error('A key is required. Get one at https://openrouter.ai/keys'); process.exit(1); }
  const models = await openRouterModels(key);
  console.log(models.size
    ? `   Key accepted, ${models.size} models visible.`
    : '   Could not read the model list. Fine: the key is still saved and doctor verifies it.');

  // 2. Classifier provider. OpenRouter by default, because that is the one-key path.
  let typesafeKey = flag('--typesafe-key') || base.typesafeKey || '';
  if (!typesafeKey && !nonInteractive) {
    const rl = readline.createInterface({ input, output });
    const a = (await rl.question('2. Call the classifier direct from TypeSafe with your own key? [y/N]: ')).trim().toLowerCase();
    if (a === 'y' || a === 'yes') typesafeKey = (await rl.question('   TypeSafe API key: ')).trim();
    rl.close();
  }
  const classifier = flag('--classifier') || base.classifier || DEFAULT_CLASSIFIER;

  // 3. Writer. Local first if something is already running, then a free hosted default.
  const local = await detectLocalModels();
  const localGroups = new Map<string, LocalModel[]>();
  for (const m of local) localGroups.set(m.baseUrl, [...(localGroups.get(m.baseUrl) || []), m]);
  let llm = flag('--llm') || base.llm || '';
  let llmBaseUrl = flag('--llm-base-url') ?? base.llmBaseUrl ?? '';
  if (!llm && localGroups.size) { const first = [...localGroups.entries()][0]; llm = first[1][0].name; llmBaseUrl = first[0]; }
  if (!llm) llm = [TESTING_LLM, ...FREE_LLM_FALLBACKS].find(m => !models.size || models.has(m)) || FREE_LLM_FALLBACKS[0];
  if (localGroups.size) {
    console.log('   Local models detected. Use one as the writer for zero-cost narration:\n'
      + [...localGroups.entries()].map(([url, ms]) => `   ${url}: ${ms.slice(0, 6).map(m => m.name).join(', ')}${ms.length > 6 ? ' ...' : ''}`).join('\n'));
  } else {
    console.log('   No local model server on 11434, 1234 or 8080. A free hosted model will be used.');
  }
  if (!nonInteractive) {
    const rl = readline.createInterface({ input, output });
    const typed = (await rl.question(`3. Writing model [${llm}]: `)).trim();
    if (typed) llm = typed;
    const endpoint = (await rl.question(`   Local endpoint, blank for hosted [${llmBaseUrl || 'hosted'}]: `)).trim();
    if (endpoint) llmBaseUrl = endpoint;
    rl.close();
  }
  if (models.size && !llmBaseUrl && !models.has(llm)) {
    console.log(`   Warning: ${llm} is not in the model list right now. Free: ${FREE_LLM_FALLBACKS.join(', ')}. Paid but better prose: ${PAID_LLM_SUGGESTIONS.slice(0, 2).join(', ')}.`);
  }

  // 4. The folder to map.
  const guess = base.vaultPath || process.env.VAULT_PATH || [path.join(os.homedir(), 'Celsus'), process.cwd()].find(p => fs.existsSync(path.join(p, '.obsidian'))) || '';
  let vaultPath = flag('--vault') || guess;
  if (!nonInteractive) {
    const rl = readline.createInterface({ input, output });
    vaultPath = (await rl.question(`4. Folder to map: an Obsidian vault, or any folder of markdown [${vaultPath || 'required'}]: `)).trim() || vaultPath;
    rl.close();
  }
  vaultPath = path.resolve(vaultPath || '');
  if (!vaultPath || !fs.existsSync(vaultPath)) { console.error('Folder not found: ' + vaultPath); process.exit(1); }
  console.log('   Found ' + countMarkdown(vaultPath) + ' markdown files there.');

  saveConfig({
    ...base,
    openrouterKey: key,
    ...(typesafeKey ? { typesafeKey } : {}),
    classifier,
    llm,
    llmBaseUrl,
    llmMaxTokens: base.llmMaxTokens || 6000,
    vaultPath,
    createdAt: base.createdAt || new Date().toISOString(),
  });
  console.log('\nSaved.');
  console.log('  folder      ' + vaultPath);
  console.log('  classifier  ' + classifier + ' via ' + (typesafeKey ? 'TypeSafe direct' : 'OpenRouter'));
  console.log('  writer      ' + llm + (llmBaseUrl ? ' (local)' : ' (hosted)'));
  console.log('\nNext: celsus run    first pass over the folder, about 4 minutes for 3,000 notes');
  console.log('      celsus serve  open http://localhost:3043');
}

main().catch(e => { console.error(e); process.exit(1); });
