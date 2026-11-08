// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// Every carrier rule says what it is about: a concept of src/concepts.js, so one concept can be
// followed across carriers (docs/concepts.md, `npm run concepts`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CONCEPTS } from '../src/concepts.js';
import { conceptMarkdown, questionId, RULE_SETS } from '../scripts/lib/concepts.mjs';

test('every carrier rule and generic label rule names a concept in the catalog', () => {
  const missing = [];
  for (const set of RULE_SETS()) {
    set.rules.forEach((r, i) => {
      if (typeof r.concept !== 'string' || !Object.hasOwn(CONCEPTS, r.concept)) missing.push(`${set.id} rule ${i} (${questionId(r)}): ${r.concept ?? 'no concept'}`);
    });
  }
  assert.deepEqual(missing, []);
});

test('every concept in the catalog is asked somewhere, and its id is <subject>.<name>', () => {
  const asked = new Set(RULE_SETS().flatMap((s) => s.rules.map((r) => r.concept)));
  assert.deepEqual(Object.keys(CONCEPTS).filter((c) => !asked.has(c)), []);
  assert.deepEqual(Object.keys(CONCEPTS).filter((c) => !/^[a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c)), []);
  assert.ok(Object.values(CONCEPTS).every((m) => typeof m === 'string' && m.length > 5));
});

// A concept is the question's meaning across carriers: the same TNI decision is one concept, so a
// change to it can be followed to every carrier's question.
test('a concept asked on several carriers: owner drives, UM and GL\'s trucking income on all that ask them', () => {
  const where = (id) => RULE_SETS().filter((s) => s.rules.some((r) => r.concept === id)).map((s) => s.id);
  assert.deepEqual(where('owner.drives'), ['progressive', 'geico']);
  assert.deepEqual(where('coverage.um'), ['progressive', 'geico', 'amwins']);
  assert.deepEqual(where('gl.trucking-income'), ['progressive', 'geico']);
  // Rules that state a TNI answer and name the same rulebook entry are about the same thing.
  const byTni = new Map();
  for (const s of RULE_SETS()) for (const r of s.rules) if (r.tni === 'general.owner-drives') byTni.set(r.concept, true);
  assert.deepEqual([...byTni.keys()], ['owner.drives']);
});

test('docs/concepts.md is current (npm run concepts)', () => {
  const doc = fs.readFileSync(new URL('../docs/concepts.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(doc, conceptMarkdown(), 'docs/concepts.md is not current: run npm run concepts');
});
