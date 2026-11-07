import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CARRIERS } from '../src/carriers.js';

// Audit 2026-11-07, ORG-16: adding a carrier touches about a dozen places, listed only in
// docs/new-carrier.md's prose. The new-carrier issue template lists each as a box; this keeps the
// two in step and every path in it real.
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const template = read('.github/ISSUE_TEMPLATE/new-carrier.md');
const named = [...template.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((p) => /^(src|test|scripts|\.github|docs)\/|\.(js|json|md)$/.test(p));

test('every path the new-carrier template names exists, for each carrier where it names one', () => {
  assert.ok(named.length >= 10, `found ${named.length} paths`);
  for (const p of named) {
    if (!p.includes('<carrier>')) { assert.ok(fs.existsSync(new URL(`../${p}`, import.meta.url)), `${p} exists`); continue; }
    // Each carrier with rules of its own (the local test page has none) has it; the page adapter
    // only where the carrier's widgets need one.
    if (p === 'src/content/carriers/<carrier>.js') continue;
    for (const carrier of CARRIERS.filter((c) => c.rules?.length).map((c) => c.id)) {
      const real = p.replace('<carrier>', carrier);
      assert.ok(fs.existsSync(new URL(`../${real}`, import.meta.url)), `${real} exists, as the template's ${p} says each carrier has`);
    }
  }
});

test('the template names every file docs/new-carrier.md\'s adapter steps link to', () => {
  const steps = /## Implement the adapter\n([\s\S]*?)\n## /.exec(read('docs/new-carrier.md'))?.[1] ?? '';
  // The general part of the rulebook is linked as what already holds TNI's decisions, not a touchpoint.
  const linked = [...steps.matchAll(/\]\(\.\.\/([^)#]+)/g)].map((m) => m[1]).filter((p) => !p.startsWith('docs/') && p !== 'src/ai/rulebook/general.js');
  assert.ok(linked.length >= 8, `found ${linked.length} links`);
  for (const p of new Set(linked)) assert.ok(named.some((n) => n === p || n.startsWith(p)), `the template names ${p}`);
});
