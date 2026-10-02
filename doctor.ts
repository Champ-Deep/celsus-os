// Celsus OS, doctor. Checks a machine end to end and prints one line per check.
//   node doctor.ts [--no-network] [--json]
// Every check is a claim about this machine, so nothing here is allowed to pass on optimism: a check
// that cannot be evaluated says so rather than reporting a green tick it did not earn.
import fs from 'node:fs';
import path from 'node:path';
import { VAULT_ROOT, CELSUS_HOME, RUNS, walk, latestRunWith, countMarkdown } from './vault.ts';
import { loadConfig, CONFIG_PATH, classifierProvider, detectLocalModels } from './config.ts';
import { decide, jevTarget } from './jev.ts';
import { chat } from './llm.ts';

const argv = process.argv.slice(2);
const noNet = argv.includes('--no-network');
const asJson = argv.includes('--json');
const checks: { name: string; ok: boolean; detail: string }[] = [];
const ok = (name: string, detail: string) => { checks.push({ name, ok: true, detail }); if (!asJson) console.log('  pass  ' + name + (detail ? ': ' + detail : '')); };
const bad = (name: string, detail: string) => { checks.push({ name, ok: false, detail }); if (!asJson) console.log('  FAIL  ' + name + (detail ? ': ' + detail : '')); };

async function main() {
  if (!asJson) console.log('Celsus OS doctor\n');
  const [maj, min] = process.versions.node.split('.').map(Number);
  (maj > 22 || (maj === 22 && min >= 18)) ? ok('node', process.versions.node + ' (type stripping available)') : bad('node', process.versions.node + '; need 22.18 or newer (brew upgrade node)');

  const folderOk = fs.existsSync(VAULT_ROOT) && fs.statSync(VAULT_ROOT).isDirectory();
  folderOk ? ok('folder', VAULT_ROOT) : bad('folder', 'not found: ' + VAULT_ROOT + '; set VAULT_PATH or run celsus setup');
  if (folderOk) {
    const t0 = Date.now(); const files = walk();
    files.length ? ok('notes', files.length + ' readable in ' + (Date.now() - t0) + ' ms') : bad('notes', 'zero markdown found under ' + VAULT_ROOT + '; is this the right folder?');
  }

  const cfg = loadConfig();
  cfg ? ok('config', 'classifier ' + cfg.classifier + ', writer ' + cfg.llm + (cfg.llmBaseUrl ? ' (local)' : ' (hosted)') + ' at ' + (fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : 'environment'))
      : bad('config', 'none found; run celsus setup');

  fs.existsSync(CELSUS_HOME) ? ok('state folder', CELSUS_HOME) : bad('state folder', 'absent, expected ' + CELSUS_HOME + ' (a run creates it)');
  const run = latestRunWith('resolutions.json');
  run ? ok('latest run', path.basename(run) + ' (' + fs.readdirSync(run).length + ' files)') : bad('latest run', 'none yet; run celsus run');

  if (cfg) {
    const p = classifierProvider();
    p.key ? ok('classifier provider', p.name + ' -> ' + p.endpoint + ' (' + p.model + ')')
          : bad('classifier provider', 'no key for ' + p.name + '; add an OpenRouter key or a typesafeKey');
    const local = await detectLocalModels(500);
    if (local.length) ok('local models', local.length + ' found, e.g. ' + local[0].name + ' at ' + local[0].baseUrl);
    else if (cfg.llmBaseUrl) bad('local writer', 'configured at ' + cfg.llmBaseUrl + ' but nothing answered there');
  }

  if (cfg && !noNet) {
    try { const r = await decide({ mention: 'Umashakar' }, { same: { type: 'choice', instructions: 'Is the mention a misspelling of Uma Shankar?', criteria: { yes: 'Yes', no: 'No' } } }, { timeoutMs: 8000 }); ok('classifier answered', r.latencyMs + ' ms (model ' + r.model + ' via ' + jevTarget().name + ')'); }
    catch (e) { bad('classifier call', (e as Error).message.slice(0, 140)); }
    try { const r = await chat([{ role: 'user', content: 'Reply with the single word ready.' }], { maxTokens: 800, timeoutMs: 60000 }); r.content.toLowerCase().includes('ready') ? ok('writer answered', r.model + ' in ' + r.latencyMs + ' ms') : bad('writer call', r.model + ' answered unexpectedly: ' + r.content.slice(0, 60)); }
    catch (e) { bad('writer call', (e as Error).message.slice(0, 140)); }
  } else if (noNet) {
    ok('network checks', 'skipped by --no-network');
  }

  const fails = checks.filter(c => !c.ok).length;
  if (asJson) { console.log(JSON.stringify({ ok: !fails, fails, vault: VAULT_ROOT, state: CELSUS_HOME, notes: folderOk ? countMarkdown(VAULT_ROOT) : 0, checks }, null, 2)); }
  else console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed. Next: celsus serve, and open http://localhost:3043');
  process.exit(fails ? 1 : 0);
}
main();
