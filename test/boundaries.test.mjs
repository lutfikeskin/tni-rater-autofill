import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The import rules that keep products apart (docs/architecture.md, "Products and adding a new line
// of business"): shared parsers know no product, the engine imports no product's code, and one
// product never imports another's. Checked on the static import graph of src/.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Shared by every product: value parsers, the address split, record paths, the states.
/** @param {string} f */
const isShared = (f) => f.startsWith('src/shared/') || f === 'src/states.js';
// The engine, which runs any product's plan on any carrier's page.
const CORE = ['src/plan.js', 'src/resolution.js', 'src/intake.js', 'src/products.js', 'src/kit/'];
// The commercial-auto product's own modules (its intake, record, answers and standards). They stay
// at these paths until the product moves into its own folder (issue #316).
const COMMERCIAL = ['src/normalize.js', 'src/util.js', 'src/answers/', 'src/schema.js', 'src/rules.js', 'src/standards.js'];
// Engine imports of commercial-auto modules still to move behind the product seam (issue #316):
// the record's field metadata and the generic label rules. A new one fails here, and so does one
// that is gone, until this list says so.
const KNOWN = ['src/plan.js -> src/rules.js', 'src/plan.js -> src/schema.js'];

/** @param {string} f @param {string[]} list */
const inList = (f, list) => list.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

/**
 * The .js and .mjs files under dir, as POSIX paths relative to ROOT.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function listModules(dir, out = []) {
  if (!fs.existsSync(path.join(ROOT, dir))) return out;
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) listModules(rel, out);
    else if (/\.m?js$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** @param {string} text */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/**
 * The relative modules a file imports or re-exports, statically or with import(), as POSIX paths
 * relative to ROOT.
 * @param {string} file
 * @returns {string[]}
 */
function importsOf(file) {
  const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const re = /(?:^|[\n;])\s*(?:import\s+(?:[^'"();]*?\s+from\s+)?|export\s+[^'"();]*?\s+from\s+)['"](\.[^'"]+)['"]|\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  return [...text.matchAll(re)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1] ?? m[2])));
}

const SRC = listModules('src');

test('the boundary lists name modules that exist', () => {
  for (const p of [...CORE, ...COMMERCIAL]) {
    assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} is in the repository`);
  }
  assert.ok(SRC.some(isShared), 'there are shared modules');
});

test('a shared module imports only shared modules', () => {
  const wrong = SRC.filter(isShared).flatMap((f) => importsOf(f).filter((t) => !isShared(t)).map((t) => `${f} -> ${t}`));
  assert.deepEqual(wrong, [], 'shared code knows no product: move what one product means into its own code');
});

test('the engine imports no commercial-auto module but the known ones', () => {
  const edges = SRC.filter((f) => inList(f, CORE))
    .flatMap((f) => importsOf(f).filter((t) => inList(t, COMMERCIAL)).map((t) => `${f} -> ${t}`));
  assert.deepEqual([...new Set(edges)].sort(), [...KNOWN].sort(),
    'an engine module reaches a product module: import from src/shared/, or pass the product\'s part in');
});

test('a product\'s own modules import no other product\'s', () => {
  const wrong = [];
  for (const f of SRC.filter((x) => x.startsWith('src/products/'))) {
    const own = f.split('/')[2];
    for (const t of importsOf(f)) {
      const other = t.startsWith('src/products/') && t.split('/')[2] !== own;
      const commercial = own !== 'commercial-auto' && inList(t, COMMERCIAL);
      if (other || commercial) wrong.push(`${f} -> ${t}`);
    }
  }
  assert.deepEqual(wrong, []);
});
