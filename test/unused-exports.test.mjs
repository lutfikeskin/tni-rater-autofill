import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'vendor', 'fixtures', 'replay']);

/**
 * Recursively lists source files under dir as POSIX paths relative to ROOT.
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]}
 */
function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (/\.(m?js|jsx|ts|tsx)$/.test(entry.name)) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

/** @param {string} text */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

/**
 * Extracts exported symbol names declared or re-exported at top level.
 * @param {string} text
 * @returns {string[]}
 */
function exportedNames(text) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of text.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const alias = part.trim().split(/\s+as\s+/).at(-1)?.trim();
      if (alias) names.add(alias);
    }
  }
  return [...names];
}

test('every export in src/ is referenced somewhere in the repository', () => {
  const allFiles = listFiles(ROOT).sort();
  /** @type {Map<string, string>} */
  const texts = new Map(allFiles.map((f) => [f, stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))]));
  const srcFiles = allFiles.filter((f) => f.startsWith('src/'));
  /** @type {string[]} */
  const unused = [];
  for (const file of srcFiles) {
    const text = texts.get(file) ?? '';
    for (const name of exportedNames(text)) {
      const re = new RegExp(`\\b${name}\\b`, 'g');
      let occurrences = 0;
      for (const content of texts.values()) occurrences += (content.match(re) ?? []).length;
      if (occurrences <= 1) unused.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(unused, [], `unused exports in src/:\n${unused.join('\n')}`);
});
