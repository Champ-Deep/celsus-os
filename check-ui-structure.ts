// Structure check for the UI. Parses the HTML and asserts the parentage the CSS depends on.
//
// Why this exists. check-ui.ts parses the inline script, and it passed green while the entire layout
// was broken. Removing the Map and Ask buttons left one closing </div> too many on the search bar
// line. The HTML stayed well formed, the JavaScript stayed valid, typecheck stayed clean, and the
// damage was that #graph closed early, so .toolbar and .canvas fell out of the graph section and
// became grid children of .body: a 241px dead band, the canvas detached from the graph, and every
// other screen shoved down the page. Only a person looking at the page noticed.
//
// The first version of this file matched the source with regexes. It was worse than useless, because
// it passed on the exact markup it was written to catch: nesting is a question about the parse tree,
// not about the text. This walks a real tree instead.
//
// The parser is a small, purpose-built tag scanner. It is not a general HTML parser and does not try
// to be: it needs to know the parent of a handful of known elements, and it must not become a
// dependency. Void elements, comments, and closing-tag bookkeeping are the only rules it follows.
// Run with `node check-ui-structure.ts`.
import fs from 'node:fs';
import path from 'node:path';

const ui = path.join(import.meta.dirname, 'ui', 'index.html');
const html = fs.readFileSync(ui, 'utf8');

interface Node { tag: string; id: string; cls: string; kids: Node[]; parent: Node | null }

const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

function parse(src: string): Node {
  const root: Node = { tag: '#root', id: '', cls: '', kids: [], parent: null };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[1]) {
      if (m[1].toLowerCase() === cur.tag) { cur = cur.parent ?? root; continue; }
      let up = cur;
      while (up.parent && up.tag !== m[1].toLowerCase()) up = up.parent;
      cur = up.parent ?? root;
      continue;
    }
    const tag = m[2].toLowerCase();
    const attrs = m[3] || '';
    const node: Node = {
      tag,
      id: (attrs.match(/\bid="([^"]*)"/) || [])[1] || '',
      cls: (attrs.match(/\bclass="([^"]*)"/) || [])[1] || '',
      kids: [], parent: cur,
    };
    cur.kids.push(node);
    if (!VOID.has(tag) && !attrs.trimEnd().endsWith('/')) cur = node;
  }
  return root;
}

function find(root: Node, pred: (n: Node) => boolean): Node | null {
  for (const k of root.kids) { if (pred(k)) return k; const f = find(k, pred); if (f) return f; }
  return null;
}
function findAll(root: Node, pred: (n: Node) => boolean): Node[] {
  const out: Node[] = [];
  const rec = (n: Node) => { for (const k of n.kids) { if (pred(k)) out.push(k); rec(k); } };
  rec(root);
  return out;
}
function under(kid: Node | null, anc: Node | null): boolean {
  for (let p = kid?.parent; p; p = p.parent) if (p === anc) return true;
  return false;
}

const tree = parse(html);
const byId = (id: string) => find(tree, n => n.id === id);
const byCls = (cls: string) => findAll(tree, n => n.cls.split(/\s+/).includes(cls));

const problems: string[] = [];
const body = byCls('body')[0];
if (!body) { console.error('FAIL ui/index.html structure: no .body element'); process.exit(1); }

// 1. .body holds exactly two children: the rail and one wrapper for every screen. A third child
// lands on a second grid row, which is the dead band that broke the page.
const bodyKids = body.kids.filter(k => k.tag === 'div' || k.tag === 'section');
if (bodyKids.length !== 2) {
  problems.push(`.body has ${bodyKids.length} element children, expected 2 (the rail and the screen wrapper). A third child opens a dead row across the page.`);
}
const rail = byCls('rail')[0];
if (!rail || !under(rail, body)) problems.push('.rail is not a child of .body');

// 2. All six screens are siblings inside that wrapper. An escaped section lands outside and its tab
// renders empty.
const SCREENS = ['graph', 'decide', 'health', 'missing', 'dups', 'rules'];
const found: Record<string, Node> = {};
for (const s of byCls('screen')) if (s.id) found[s.id] = s;
for (const want of SCREENS) {
  if (!found[want]) { problems.push(`screen section #${want} is missing`); continue; }
  if (!under(found[want], body)) problems.push(`#${want} has escaped .body: its tab would render empty`);
}
const graph = found['graph'];
if (graph) {
  const wrapper = graph.parent;
  for (const other of SCREENS) {
    if (other === 'graph' || !found[other]) continue;
    if (found[other].parent !== wrapper) problems.push(`#${other} is not a sibling of #graph: only one screen could ever be visible`);
  }
  for (const [label, node] of [['the filter toolbar', byCls('toolbar')[0]], ['the canvas', byId('canvasWrap')], ['the search bar', byCls('ask')[0]]] as const) {
    if (!node) problems.push(`${label} is missing from the page`);
    else if (!under(node, graph)) problems.push(`${label} is not inside #graph: it has fallen out of the section and renders in the wrong place`);
  }
}

if (problems.length) {
  console.error('FAIL ui/index.html structure');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('ok   ui/index.html structure');
console.log('       .body has 2 children, so the grid is one row: rail + screens');
console.log(`       all ${SCREENS.length} screens are siblings inside one wrapper`);
console.log('       the search bar, filter toolbar and canvas are all inside #graph');
