// Celsus OS, first run setup. Asks three things and writes ~/.celsus-os/config.json.
//   node setup.ts
// 1. OpenRouter API key.  2. Classifier (Jev by default).  3. LLM: your own choice, or a free default.
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { saveConfig, loadConfig, CONFIG_PATH, DEFAULT_CLASSIFIER, TESTING_LLM, FREE_LLM_FALLBACKS } from './config.ts';

async function listModels(key: string): Promise<Set<string>> {
  try { const r = await fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${key}` } }); const j: any = await r.json(); return new Set((j.data || []).map((m: any) => m.id)); } catch { return new Set(); }
}

async function main() {
  const rl = readline.createInterface({ input, output });
  const existing = loadConfig();
  console.log('Celsus OS setup. Answers are written to ' + CONFIG_PATH + ' (outside the vault, never committed).\n');
  const key = (await rl.question(`1. OpenRouter API key${existing ? ' [keep current]' : ''}: `)).trim() || existing?.openrouterKey || '';
  if (!key) { console.error('A key is required.'); process.exit(1); }
  const models = await listModels(key);
  if (models.size) console.log(`   Key accepted, ${models.size} models visible.`);
  const classifier = (await rl.question(`2. Classifier model [${DEFAULT_CLASSIFIER}]: `)).trim() || DEFAULT_CLASSIFIER;
  let llm = (await rl.question('3. Preferred LLM for narration (blank for a free default): ')).trim();
  if (!llm) {
    const candidates = [TESTING_LLM, ...FREE_LLM_FALLBACKS];
    llm = candidates.find(m => models.size === 0 || models.has(m)) || FREE_LLM_FALLBACKS[0];
    if (llm === TESTING_LLM) console.log(`   Using the testing default ${TESTING_LLM} (free while the stealth tag is live). When it disappears, run setup again and pick a model.`);
    else console.log(`   ${TESTING_LLM} is no longer listed. Using ${llm}.`);
  } else if (models.size && !models.has(llm)) console.log(`   Warning: ${llm} is not in the model list right now.`);
  const os = await import('node:os'); const fsm = await import('node:fs'); const pathm = await import('node:path');
  const guess = existing?.vaultPath || process.env.VAULT_PATH || [pathm.join(os.homedir(), 'Celsus'), process.cwd()].find(p => fsm.existsSync(pathm.join(p, '.obsidian'))) || '';
  const vaultPath = (await rl.question(`4. Obsidian vault folder [${guess || 'required'}]: `)).trim() || guess;
  if (!vaultPath || !fsm.existsSync(vaultPath)) { console.error('Vault folder not found: ' + vaultPath); process.exit(1); }
  rl.close();
  saveConfig({ openrouterKey: key, classifier, llm, llmMaxTokens: 6000, vaultPath, createdAt: new Date().toISOString() });
  console.log('Saved. Next: node normalize-entities.ts --live');
}
main().catch(e => { console.error(e); process.exit(1); });
