import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';

// The import rules that keep products apart (docs/architecture.md, "Products and adding a new line
// of business"): shared parsers know no product, the engine imports no product's code, and one
// product never imports another's. Checked on the import graph of src/ and sidepanel/, read with a
// JavaScript parser so a string or a regular expression can't hide an import.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Shared by every product: value parsers, the address split, record paths, the states.
/** @param {string} f */
const isShared = (f) => f.startsWith('src/shared/') || f === 'src/states.js';
// The engine, which runs any product's plan on any carrier's page, logs it, and draws it in the
// panel. src/ai/ is left out: Luna's prompt and rulebook are commercial auto's until they are split.
const CORE = ['src/plan.js', 'src/resolution.js', 'src/intake.js', 'src/products.js', 'src/kit/', 'src/usage.js', 'sidepanel/'];
// The commercial-auto product's own modules (its intake, record, answers and standards). They stay
// at these paths until the product moves into its own folder (issue #316).
const COMMERCIAL = ['src/normalize.js', 'src/util.js', 'src/answers/', 'src/schema.js', 'src/rules.js', 'src/standards.js'];
// Engine imports of commercial-auto modules still to move behind the product seam (issue #316). A
// new one fails here, and so does one that is gone, until this list says so.
const KNOWN = [
  // The plan: the record's field metadata and the generic label rules.
  'src/plan.js -> src/rules.js',
  'src/plan.js -> src/schema.js',
  // The usage log: whether the prior policy is "none".
  'src/usage.js -> src/util.js',
  // The panel: the commercial record's sections, its edits and checks, the owner row, the standards.
  'sidepanel/panel/agent-defaults/store.js -> src/standards.js',
  'sidepanel/panel/agent-defaults/view.jsx -> src/standards.js',
  'sidepanel/panel/assistant.js -> src/normalize.js',
  'sidepanel/panel/coordinator.js -> src/util.js',
  'sidepanel/panel/intake.js -> src/answers/owner.js',
  'sidepanel/panel/intake.js -> src/normalize.js',
  'sidepanel/panel/quote-summary.js -> src/util.js',
  'sidepanel/panel/record.js -> src/answers/owner.js',
  'sidepanel/panel/record.js -> src/normalize.js',
  'sidepanel/panel/record.js -> src/util.js',
];

/** @param {string} f @param {string[]} list */
const inList = (f, list) => list.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

/**
 * The .js, .mjs and .jsx files under dir, as POSIX paths relative to ROOT.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function listModules(dir, out = []) {
  if (!fs.existsSync(path.join(ROOT, dir))) return out;
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) listModules(rel, out);
    else if (/\.(m?js|jsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/**
 * The module specifiers a source imports or re-exports, statically or with import() of a string.
 * @param {string} text
 * @returns {string[]}
 */
function specifiersIn(text) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} node */
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const declaration = node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration';
    if ((declaration || node.type === 'ImportExpression') && typeof node.source?.value === 'string') out.push(node.source.value);
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(parseAst(text, { lang: 'jsx' }));
  return out;
}

/**
 * The relative modules a file imports, as POSIX paths relative to ROOT.
 * @param {string} file
 * @returns {string[]}
 */
function importsOf(file) {
  return specifiersIn(fs.readFileSync(path.join(ROOT, file), 'utf8'))
    .filter((s) => s.startsWith('.'))
    .map((s) => path.posix.normalize(path.posix.join(path.posix.dirname(file), s)));
}

const FILES = [...listModules('src'), ...listModules('sidepanel')];

test('imports are read from code only: not from comments, strings or regular expressions', () => {
  const text = [
    "import a from './a.js';",
    "const glob = 'src/**/x /* not a comment';",
    "export { b } from './b.js';",
    "export * from './c.js';",
    "const url = 'https://x'; import('./d.js');",
    "// import './commented.js';",
    'import {\n  f,\n} from \'./f.js\';',
    "const view = <p title=\"//\">{'/*'} Don't</p>;",
    "const re = /'\\/*/;",
    "import './g.js';",
  ].join('\n');
  assert.deepEqual(specifiersIn(text), ['./a.js', './b.js', './c.js', './d.js', './f.js', './g.js']);
});

test('the boundary lists name modules that exist', () => {
  for (const p of [...CORE, ...COMMERCIAL]) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} is in the repository`);
  }
  assert.ok(FILES.some(isShared), 'there are shared modules');
});

test('a shared module imports only shared modules', () => {
  const wrong = FILES.filter(isShared).flatMap((f) => importsOf(f).filter((t) => !isShared(t)).map((t) => `${f} -> ${t}`));
  assert.deepEqual(wrong, [], 'shared code knows no product: move what one product means into its own code');
});

test('the engine imports no commercial-auto module but the known ones', () => {
  const edges = FILES.filter((f) => inList(f, CORE))
    .flatMap((f) => importsOf(f).filter((t) => inList(t, COMMERCIAL)).map((t) => `${f} -> ${t}`));
  assert.deepEqual([...new Set(edges)].sort(), [...KNOWN].sort(),
    'an engine module reaches a product module: import from src/shared/, or pass the product\'s part in');
});

test('a product\'s own modules import no other product\'s', () => {
  const wrong = [];
  for (const f of FILES.filter((x) => x.startsWith('src/products/'))) {
    const own = f.split('/')[2];
    for (const t of importsOf(f)) {
      const other = t.startsWith('src/products/') && t.split('/')[2] !== own;
      const commercial = own !== 'commercial-auto' && inList(t, COMMERCIAL);
      if (other || commercial) wrong.push(`${f} -> ${t}`);
    }
  }
  assert.deepEqual(wrong, []);
});
