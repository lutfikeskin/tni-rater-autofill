// A carrier rule that throws while the plan is built never stops the plan and never passes for an
// intake that is silent: its step is the agent's (`ruleError`), and the error is told with the
// rule's names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPlan as plainBuild } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

const record = () => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', owner1: 'Amina Kone', ownerDrives: true },
  garaging: { street: '1 Test Way', city: 'Testville', state: 'OH', zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', vehicleOwnership: 'Owned' },
  drivers: [{ first: 'Amina', last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: 'OH', cdl: true }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  trailerInfo: {},
  priorInsurance: [],
  coverage: { autoLiabLimit: '$1M CSL', cargo: false },
  claims: { hasClaims: false },
});
// The plan's steps as the tests read them (field steps' own keys, without narrowing).
/** @type {(...args: Parameters<typeof plainBuild>) => any[]} */
const buildPlan = plainBuild;
const boom = () => { throw new Error('a record shape the rule did not expect'); };
const data = (plan) => JSON.parse(JSON.stringify(plan));

for (const carrier of [progressive, amwins, geico]) {
  // A rule with a computed value, one step, the one made to throw.
  const at = carrier.rules.findIndex((r) => typeof r.value === 'function' && !r.repeat && !r.scope && r.concept);
  for (const part of ['value', 'note', 'source', 'warn', 'scope', 'ignore']) {
    test(`${carrier.id}: a rule whose ${part} throws is the agent's, the plan still built, the error told`, () => {
      const rule = carrier.rules[at];
      const broken = { ...carrier, rules: carrier.rules.map((r, i) => (i === at ? { ...r, [part]: boom } : r)) };
      const told = [];
      const plan = buildPlan(record(), broken, {}, { onRuleError: (/** @type {any} */ error, where) => told.push([error.message, where]) });
      const plain = buildPlan(record(), carrier, {});
      assert.equal(plan.length, plain.length, 'every step is still there');
      const step = plan.find((s) => s.ruleError);
      assert.ok(step, 'the broken rule has a step');
      assert.equal(step.q, rule.q ?? null);
      assert.equal(step.value, null);
      assert.equal(step.manualOnly, true);
      assert.equal(step.resolution.status, 'agent');
      assert.equal(step.note, "This answer's rule failed: answer it yourself.");
      assert.deepEqual(told, [['a record shape the rule did not expect', { carrier: carrier.id, concept: rule.concept, q: rule.q ?? null, name: rule.name ?? rule.path ?? null }]]);
      // Every other step is as the rules give it.
      const others = (p) => data(p).filter((s) => s.id !== step.id);
      assert.deepEqual(others(plan), others(plain));
    });
  }
}

test('a throw in the overlay hook of another step, or in telling the error, never breaks the plan', () => {
  const at = amwins.rules.findIndex((r) => typeof r.value === 'function' && !r.repeat && !r.scope);
  const broken = { ...amwins, rules: amwins.rules.map((r, i) => (i === at ? { ...r, value: boom } : r)) };
  const plan = buildPlan(record(), broken, {}, { onRuleError: () => { throw new Error('logging failed'); } });
  assert.equal(plan.filter((s) => s.ruleError).length, 1);
});

test('a rule whose scope throws null or 0 is still the agent\'s (the failure is a flag, not the thrown value)', () => {
  for (const thrown of [null, 0, '']) {
    const at = amwins.rules.findIndex((r) => typeof r.value === 'function' && !r.repeat && !r.scope);
    const broken = { ...amwins, rules: amwins.rules.map((r, i) => (i === at ? { ...r, scope: () => { throw thrown; } } : r)) };
    const told = [];
    const plan = buildPlan(record(), broken, {}, { onRuleError: (e) => told.push(e) });
    const steps = plan.filter((s) => s.ruleError);
    assert.equal(steps.length, 1, String(thrown));
    assert.equal(steps[0].resolution.status, 'agent');
    assert.equal(told.length, 1, 'told once');
  }
});

test('no rule throws on an empty record (nothing is reported for a silent intake)', () => {
  const empty = { applicant: {}, garaging: {}, operations: {}, drivers: [], vehicles: [], trailers: [], trailerInfo: {}, priorInsurance: [], coverage: {}, claims: {}, notes: {} };
  for (const carrier of [progressive, amwins, geico]) {
    const told = [];
    buildPlan(empty, carrier, {}, { onRuleError: (e, where) => told.push(where) });
    buildPlan(record(), carrier, {}, { onRuleError: (e, where) => told.push(where) });
    assert.deepEqual(told, [], carrier.id);
  }
});

test('the panel logs a rule error as a client_error naming the rule', () => {
  const planFor = fs.readFileSync(new URL('../sidepanel/panel/plan-for.js', import.meta.url), 'utf8');
  assert.match(planFor, /onRuleError: \(error, at\) => reportRuleError\(error, at\)/);
  const core = fs.readFileSync(new URL('../sidepanel/panel/core.js', import.meta.url), 'utf8');
  assert.match(core, /onPlanRuleError\(\(error, at\) => logCrash\(error, 'plan', at\)\)/);
});
