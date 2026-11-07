import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CARRIERS } from '../src/carriers.js';

// Audit 2026-11-07, ORG-16: adding a carrier touches about a dozen places, listed only in
// docs/new-carrier.md's prose. The new-carrier issue template lists each as a box; this keeps the
// two in step and every path in it real.
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Only the boxes count: a path or setting named in the template's prose has no box to tick (the
// review of #432).
const template = read('.github/ISSUE_TEMPLATE/new-carrier.md').split('\n').filter((l) => l.startsWith('- [ ] ')).join('\n');
const named = [...template.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((p) => /^(src|test|scripts|\.github|docs)\/|\.(js|json|md)$/.test(p));

test('every path the new-carrier template names exists, for each carrier where it names one', () => {
  assert.ok(named.length >= 10, `found ${named.length} paths`);
  for (const p of named) {
    if (!p.includes('<carrier>')) { assert.ok(fs.existsSync(new URL(`../${p}`, import.meta.url)), `${p} exists`); continue; }
    // A page adapter only where the carrier's widgets need one: each carrier that names one
    // (`pageAdapter`) has it at this path. Every carrier with rules of its own (the local test page
    // has none) has the rest.
    if (p === 'src/content/carriers/<carrier>.js') {
      const adapters = CARRIERS.filter((c) => c.pageAdapter);
      assert.ok(adapters.length >= 1);
      for (const c of adapters) {
        assert.equal(c.pageAdapter, p.replace('<carrier>', c.id), `${c.id}'s pageAdapter`);
        assert.ok(fs.existsSync(new URL(`../${c.pageAdapter}`, import.meta.url)), `${c.pageAdapter} exists`);
      }
      continue;
    }
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

// The review of #432: the settings that keep agents' corrections and the agent's own pages safe
// have their boxes too, each one the adapter steps name.
test('the template has a box for the correction keys, the agent\'s stops and where Continue may be clicked', () => {
  const steps = /## Implement the adapter\n([\s\S]*?)\n## /.exec(read('docs/new-carrier.md'))?.[1] ?? '';
  for (const option of ['shared.keys', 'stopPages', 'stopSteps', 'stopButtons', 'stopped', 'advance', 'useGenericRules']) {
    assert.ok(steps.includes(`\`${option}`), `docs/new-carrier.md's adapter steps name ${option}`);
    assert.ok(template.includes(`\`${option}\``), `the template names ${option}`);
  }
  assert.match(template, /`advance` only on pages or steps it lists: never on one that binds, buys, submits, orders reports or signs, and never on a stop page or step/);
  // docs/new-carrier.md step 2: what the intake doesn't answer, without a TNI standard, is the agent's.
  assert.match(steps, /every question the intake doesn't answer is the agent's/);
  assert.match(template, /^- \[ \] Step 2: a question the intake doesn't answer and TNI has no standard for stays the agent's, shown as unanswered: never filled as No or not applicable$/m);
});
