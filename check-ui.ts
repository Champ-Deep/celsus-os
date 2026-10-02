// Celsus OS, check the UI script parses. Run by CI, and worth running by hand after any edit to
// ui/index.html.
//
//   node check-ui.ts
//
// The whole app is one inline <script> block in a single HTML file, which means a stray brace makes
// the entire interface a blank page with a console error and nothing else. There is no build step to
// catch it, and a browser screenshot is a slow way to find out. So the block is extracted and handed
// to the same parser the browser would use, which reports the exact line and column.
//
// The IIFE wrapper is stripped before parsing, because a top-level return is illegal in a script and
// legal inside the app's own wrapper. Parsing the wrapper and all is not an option: the wrapper is
// the one thing that makes the app's internals private, and it stays.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const files = ['ui/index.html', 'ui/pets.html'].filter(f => fs.existsSync(path.join(HERE, f)));

if (!files.length) { console.error('No HTML found to check.'); process.exit(1); }

let bad = 0;
for (const f of files) {
  const html = fs.readFileSync(path.join(HERE, f), 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) { console.log(`  ok   ${f}: no inline script`); continue; }
  blocks.forEach((m, i) => {
    const js = m[1];
    const line = html.slice(0, m.index).split('\n').length;
    // Offset the reported line into the HTML file, so the error points at something a person can
    // open rather than at an offset inside a string they cannot see.
    try {
      new vm.Script(js, { filename: `${f}:inline${i}` });
      console.log(`  ok   ${f}: inline script ${i + 1} parses (${js.split('\n').length} lines, from HTML line ${line})`);
    } catch (e: any) {
      bad++;
      const m2 = /:(\d+)$/.exec(String(e.stack || '').split('\n')[0] || '');
      const jsLine = m2 ? Number(m2[1]) : 0;
      console.error(`  FAIL ${f}: inline script ${i + 1} does not parse: ${e.message}`);
      if (jsLine) {
        const L = js.split('\n');
        console.error(`       HTML line ${line + jsLine - 1}: ${(L[jsLine - 1] || '').trim().slice(0, 160)}`);
      }
    }
  });
}

if (bad) { console.error('\nThe interface will not load. Fix the line above before shipping.'); process.exit(1); }
console.log('\nUI script parses.');
