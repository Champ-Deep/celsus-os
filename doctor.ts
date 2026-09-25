// Celsus OS, doctor. Checks a machine end to end and prints one line per check.
//   node doctor.ts [--no-network]
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT, walk, latestRunWith } from './vault.ts';
import { loadConfig, CONFIG_PATH } from './config.ts';
import { decide } from './jev.ts';
import { chat } from './llm.ts';

const noNet = process.argv.includes('--no-network');
let fails = 0;
const ok = (m: string) => console.log('  pass  ' + m);
const bad = (m: string) => { fails++; console.log('  FAIL  ' + m); };

async function main() {
  console.log('Celsus OS doctor\n');
  const [maj, min] = process.versions.node.split('.').map(Number);
  (maj > 22 || (maj === 22 && min >= 18)) ? ok(`node ${process.versions.node} (type stripping available)`) : bad(`node ${process.versions.node}; need 22.18 or newer (brew install node)`);
  fs.existsSync(path.join(VAULT_ROOT, 'CLAUDE.md')) || fs.existsSync(path.join(VAULT_ROOT, '.obsidian')) ? ok(`vault at ${VAULT_ROOT}`) : bad(`no vault at ${VAULT_ROOT}; set VAULT_PATH`);
  const t0 = Date.now(); const files = walk(); ok(`${files.length} notes readable in ${Date.now() - t0} ms`);
  const cfg = loadConfig();
  cfg ? ok(`config: classifier ${cfg.classifier}, llm ${cfg.llm} (${fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : 'legacy key file or env'})`) : bad(`no config; run node setup.ts`);
  const run = latestRunWith('resolutions.json');
  run ? ok(`latest run ${path.basename(run)} (${fs.readdirSync(run).length} files)`) : bad('no run yet; run node normalize-entities.ts');
  if (cfg && !noNet) {
    try { const r = await decide({ mention: 'Umashakar' }, { same: { type: 'choice', instructions: 'Is the mention a misspelling of Uma Shankar?', criteria: { yes: 'Yes', no: 'No' } } }, { timeoutMs: 8000 }); ok(`Jev answered in ${r.latencyMs} ms (model ${r.model})`); } catch (e) { bad(`Jev call failed: ${(e as Error).message.slice(0, 120)}`); }
    try { const r = await chat([{ role: 'user', content: 'Reply with the single word ready.' }], { maxTokens: 800, timeoutMs: 60000 }); r.content.toLowerCase().includes('ready') ? ok(`LLM ${r.model} answered in ${r.latencyMs} ms`) : bad(`LLM ${r.model} answered but not as expected: ${r.content.slice(0, 60)}`); } catch (e) { bad(`LLM call failed: ${(e as Error).message.slice(0, 120)}`); }
  }
  console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed. Next: node serve.ts and open http://localhost:3043');
  process.exit(fails ? 1 : 0);
}
main();
