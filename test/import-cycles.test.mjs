import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static import graph of src/ and background.js must be acyclic. sidepanel/ is left out here:
// its cycle is known and tracked in issue #336.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Recursively lists .js and .mjs files under dir as POSIX paths relative to ROOT.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function listModules(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listModules(full, out);
    else if (/\.m?js$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Strips line and block comments so commented examples are never read as imports.
 * @param {string} text
 * @returns {string}
 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/**
 * Returns relative static ES import/re-export targets of file, as POSIX paths relative to ROOT.
 * @param {string} file
 * @returns {string[]}
 */
function staticImports(file) {
  const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  /** @type {Set<string>} */
  const targets = new Set();
  const re = /(?:^|[\n;])\s*(?:import\s+(?:[^'"();]*?\s+from\s+)?|export\s+[^'"();]*?\s+from\s+)['"](\.[^'"]+)['"]/g;
  for (const match of text.matchAll(re)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
    if (fs.existsSync(path.join(ROOT, target))) targets.add(target);
  }
  return [...targets];
}

/**
 * Canonicalizes a cycle so the same loop is reported once starting at its smallest path.
 * @param {string[]} nodes
 * @returns {string}
 */
function formatCycle(nodes) {
  let start = 0;
  for (let i = 1; i < nodes.length; i++) if (nodes[i] < nodes[start]) start = i;
  const rotated = [...nodes.slice(start), ...nodes.slice(0, start)];
  return [...rotated, rotated[0]].join(' -> ');
}

/**
 * Finds all elementary cycles in the directed graph.
 * @param {Map<string, string[]>} graph
 * @returns {string[]}
 */
function findCycles(graph) {
  /** @type {Set<string>} */
  const cycles = new Set();
  const nodes = [...graph.keys()].sort();
  for (const start of nodes) {
    /** @type {string[]} */
    const stack = [start];
    /** @type {Set<string>} */
    const onPath = new Set([start]);
    /** @param {string} node */
    const walk = (node) => {
      for (const next of graph.get(node) ?? []) {
        if (next === start) {
          cycles.add(formatCycle(stack));
        } else if (next > start && !onPath.has(next)) {
          onPath.add(next);
          stack.push(next);
          walk(next);
          stack.pop();
          onPath.delete(next);
        }
      }
    };
    walk(start);
  }
  return [...cycles].sort();
}

test('src/ and background.js have no static import cycles', () => {
  const files = [...listModules(path.join(ROOT, 'src')), 'background.js'].sort();
  /** @type {Map<string, string[]>} */
  const graph = new Map(files.map((f) => [f, staticImports(f)]));
  const cycles = findCycles(graph);
  assert.deepEqual(cycles, [], `import cycles found:\n${cycles.join('\n')}`);
});
