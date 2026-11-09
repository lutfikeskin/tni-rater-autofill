// @ts-nocheck -- not type-checked yet (audit 2026-11-07, QA-08): fix its errors and take this line out
// The generic hooks a feature can plug into without core code knowing it (docs/agent-defaults-spec.md):
// buildPlan's step overlay, the panel's one planFor, and rulebookFor's rewrite. With nothing plugged in
// each does nothing, so every plan and rulebook is the rules' own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan } from '../src/plan.js';
import { planFor } from '../sidepanel/panel/plan-for.js';
import { rulebookFor } from '../src/ai/tni-rules.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARRIERS = [progressive, amwins, geico];
const record = (state = 'OH') => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', owner1: 'Amina Kone', ownerDrives: true },
  garaging: { street: '1 Test Way', city: 'Testville', state, zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', vehicleOwnership: 'Owned' },
  drivers: [{ first: 'Amina', last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: state, cdl: true }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  trailerInfo: {},
  priorInsurance: [],
  coverage: { autoLiabLimit: '$1M CSL', cargo: false },
  claims: { hasClaims: false },
});
// A plan as data: functions dropped, as when it is sent to the page.
const data = (plan) => JSON.parse(JSON.stringify(plan));

test('no overlay, or one that returns each step as given, leaves the plan as the rules give it', () => {
  for (const carrier of CARRIERS) {
    for (const state of ['OH', 'TX', 'FL']) {
      const plain = buildPlan(record(state), carrier, {});
      assert.deepEqual(data(buildPlan(record(state), carrier, {}, {})), data(plain), `${carrier.id} ${state}: empty options`);
      assert.deepEqual(data(buildPlan(record(state), carrier, {}, { overlay: (step) => step })), data(plain), `${carrier.id} ${state}: identity overlay`);
    }
  }
});

test('the overlay sees each field step once, with its own rule, and never an action', () => {
  const seen = [];
  const plan = buildPlan(record(), geico, {}, { overlay: (step, rule, context) => { seen.push({ step, rule, context }); return step; } });
  const fields = plan.filter((s) => !('action' in s));
  assert.equal(seen.length, fields.length);
  for (const { step, rule, context } of seen) {
    assert.equal(step.q, rule.q ?? null, `${step.name}: its own rule`);
    assert.equal(step.resolution, undefined, 'called before the resolution is decided');
    assert.equal(context.carrier, geico);
    assert.equal(context.record.garaging.state, 'OH');
  }
});

test('a step the overlay changes gets the resolution of the step it returns', () => {
  const plan = buildPlan(record(), progressive, {}, {
    overlay: (step, rule) => (rule.std?.id === 'medPay' ? { ...step, value: '$1,000 per person', source: 'agent-default', standard: false } : step),
  });
  const medPay = plan.find((s) => s.q === '1FE4');
  assert.equal(medPay.value, '$1,000 per person');
  assert.deepEqual([medPay.resolution.answer, medPay.resolution.method], ['$1,000 per person', 'agent-default']);
  const plain = buildPlan(record(), progressive, {}).find((s) => s.q === '1FE4');
  assert.deepEqual([plain.value, plain.resolution.method], ['$5,000 per person', 'standard']);
});

test('a plan step names the rulebook entry its rule follows', () => {
  const plan = buildPlan(record(), geico, {});
  assert.equal(plan.find((s) => s.q === 'UninsuredMotorist').tni, 'geico.um');
  assert.equal(plan.find((s) => s.q === 'PropertyDamage').tni, null);
});

test('planFor gives the plan buildPlan gives', () => {
  for (const carrier of CARRIERS) {
    assert.deepEqual(data(planFor(record(), carrier, {})), data(buildPlan(record(), carrier, {})), carrier.id);
    assert.deepEqual(data(planFor(record(), carrier)), data(buildPlan(record(), carrier)), `${carrier.id}: active defaults to none`);
  }
});

// The panel builds every plan through planFor, so a hook plugged in there reaches the plan that fills,
// the one the usage log rebuilds and the one the report comes from alike.
test('no panel file but plan-for.js calls or imports buildPlan', () => {
  const dir = path.join(root, 'sidepanel');
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => /\.(js|jsx)$/.test(f));
  assert.ok(files.length > 10);
  for (const f of files) {
    if (f.replace(/\\/g, '/') === 'panel/plan-for.js') continue;
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /\bbuildPlan\b/, `sidepanel/${f}: build plans with planFor`);
  }
});

test('rulebookFor\'s rewrite: none leaves the entries as written; one gives the entries it returns', () => {
  for (const carrier of CARRIERS) {
    const plain = rulebookFor(carrier.id);
    assert.deepEqual(rulebookFor(carrier.id, {}), plain);
    assert.deepEqual(rulebookFor(carrier.id, { rewrite: (e) => e }), plain);
    const marked = rulebookFor(carrier.id, { rewrite: (e) => (e.id === `${carrier.id}.um` ? { ...e, text: 'UM: the agent\'s default.' } : e) });
    assert.equal(marked.find((e) => e.id === `${carrier.id}.um`).text, 'UM: the agent\'s default.');
    assert.equal(marked.length, plain.length);
  }
  assert.deepEqual(rulebookFor('unknown', { rewrite: () => { throw new Error('not called'); } }), []);
});

// Audit 2026-11-07, CARR-05: a coverage section is the carrier's (`sections`), not the kit's: the
// plan gives a section's Done how its row is read, and a Done closing a section the carrier doesn't
// declare is a configuration error, never a click with nothing checked.
test('a coverage section the carrier declares: the plan gives its Done the section, an undeclared one throws', async () => {
  const { buildPlan } = await import('../src/plan.js');
  const fs = await import('node:fs');
  const carrier = (sections) => ({ id: 'x', hosts: [], useGenericRules: false, sections,
    rules: [{ name: 'Reefer question', selector: '#q', source: 'derived', value: () => 'Yes', section: { id: 'reefer', part: 'section' } }],
    actions: [{ id: 'doneReefer', text: '^done$', verify: { closed: 'reefer' } }] });
  const plan = buildPlan({}, carrier({ reefer: { words: 'reefer[^\\n]*', anyLimit: true } }), {});
  assert.deepEqual(plan.find((s) => s.action === 'doneReefer').verify, { closed: 'reefer', words: 'reefer[^\\n]*', anyLimit: true });
  assert.deepEqual(plan.find((s) => s.name === 'Reefer question').section, { id: 'reefer', part: 'section' });
  assert.throws(() => buildPlan({}, carrier({}), {}), /doneReefer: verify closes "reefer", which its sections don't declare/);
  // The kit names no carrier's coverage.
  for (const file of fs.readdirSync(new URL('../src/kit/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../src/kit/${file}`, import.meta.url), 'utf8'), /motor truck cargo/i, file);
  }
});

// Audit 2026-11-07, CARR-09: the generic label rules (src/rules.js) misfired on Progressive's and
// GEICO's pages, so a carrier gets them only by opting in (`useGenericRules: true`), as AmWINS and
// the local test page do; a new carrier without the key gets its own rules alone.
test('the generic label rules are opt-in: a carrier without useGenericRules gets none', async () => {
  const { CARRIERS } = await import('../src/carriers.js');
  const generic = (carrier) => buildPlan({ applicant: { name: 'Synthetic LLC', phone: '(555) 010-0100' } }, carrier, {}).filter((s) => s.kind !== 'action').length;
  assert.equal(generic({ id: 'new', hosts: [], rules: [] }), 0, 'no key: no generic rules');
  assert.equal(generic({ id: 'new', hosts: [], rules: [], useGenericRules: false }), 0);
  assert.ok(generic({ id: 'new', hosts: [], rules: [], useGenericRules: true }) > 0, 'opted in');
  assert.deepEqual(Object.fromEntries(CARRIERS.map((c) => [c.id, c.useGenericRules])), { progressive: false, geico: false, amwins: true, test: true }, 'every carrier says it');
});
