#!/usr/bin/env node
// Celsus OS command line. One entry point for the team.
//   node cli.ts setup | doctor | run | serve | narrate "<entity>" | links | owners | duplicates
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2]; const rest = process.argv.slice(3);
const [nMaj, nMin] = process.versions.node.split('.').map(Number);
if (nMaj < 22 || (nMaj === 22 && nMin < 18)) { console.error(`Celsus OS needs Node 22.18 or newer (found ${process.versions.node}); it runs TypeScript directly. brew upgrade node, or nvm install 22`); process.exit(1); }
if (cmd === 'update') { console.log('Pulling the latest Celsus OS into ' + here); const r = spawnSync('git', ['-C', here, 'pull', '--ff-only'], { stdio: 'inherit' }); process.exit(r.status || 0); }
if (cmd === 'open') { const url = 'http://localhost:' + (rest[rest.indexOf('--port') + 1] || '3043'); spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }); process.exit(0); }
const map: Record<string, string[][]> = {
  setup: [['setup.ts']], doctor: [['doctor.ts']], serve: [['serve.ts']], narrate: [['narrate.ts']],
  links: [['suggest-links.ts', '--live']], owners: [['suggest-owners.ts', '--live']], duplicates: [['find-duplicates.ts']],
  run: [['normalize-entities.ts', '--live'], ['suggest-owners.ts', '--live'], ['suggest-links.ts', '--live'], ['find-duplicates.ts']],
};
if (cmd === 'restart') { const port = rest[rest.indexOf('--port') + 1] || '3043'; spawnSync('sh', ['-c', `lsof -ti:${port} | xargs kill 2>/dev/null; true`], { stdio: 'inherit' }); spawnSync(process.execPath, [path.join(here, 'serve.ts'), '--port', port], { stdio: 'inherit' }); process.exit(0); }
if (!cmd || !map[cmd]) {
  console.log(`Celsus OS, a knowledge base OS over your Obsidian vault

  celsus setup        first run: OpenRouter key, vault folder, models
  celsus doctor       check this machine end to end
  celsus run          full pass over the vault (normalize, owners, links, duplicates), about 4 minutes
  celsus serve        open the app at http://localhost:3043
  celsus restart      stop whatever holds port 3043 and serve again
  celsus open         open the app in your browser
  celsus update       pull the latest version
  celsus narrate "<entity>"        cache an authored view for one entity
  celsus links | owners | duplicates   one step only

If you installed from a clone instead of install.sh, replace "celsus" with "node cli.ts".
Add --dry to run without network where a script supports it.`);
  process.exit(cmd ? 1 : 0);
}
for (const [script, ...flags] of map[cmd]) {
  const args = [path.join(here, script), ...flags.filter(f => !(rest.includes('--dry') && f === '--live')), ...rest.filter(r => r !== '--dry')];
  console.log(`\n> node ${path.basename(script)} ${args.slice(1).join(' ')}`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (r.status !== 0 && cmd !== 'run') process.exit(r.status || 1);
}
