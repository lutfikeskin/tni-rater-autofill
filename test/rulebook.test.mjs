// TNI's rulebook as Luna reads it (src/ai/tni-rules.js) and the carrier rules state the same
// standards: every rule that can fill a TNI standard names its rulebook entry (`tni`), in the general
// part or its own carrier's, and every standard entry is filled by a rule (or a click) of a carrier
// that gets it. Luna gets the general part and its own carrier's only, ahead of the intake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERAL, CARRIER_PARTS, rulebookFor } from '../src/ai/tni-rules.js';
import { evidenceFor } from '../src/ai/common.js';
import { buildRequest } from '../src/ai/luna.js';
import { CARRIERS } from '../src/carriers.js';

const KINDS = ['standard', 'intake', 'agent', 'workflow'];
const RULE_CARRIERS = CARRIERS.filter((c) => c.rules.length);
const entriesOf = (part) => part.sections.flatMap((s) => s.rules);
const GENERAL_IDS = new Map(entriesOf(GENERAL).map((e) => [e.id, e]));
const partIds = (carrier) => new Map(entriesOf(CARRIER_PARTS[carrier.id] ?? { sections: [] }).map((e) => [e.id, e]));
const where = (carrier, rule) => `${carrier.id}: ${rule.name ?? rule.q ?? rule.field ?? rule.selector ?? rule.label ?? rule.path ?? rule.id}`;
// A rule fills a TNI standard when its source is 'standard', or a function of the record that can
// return it (every such function names 'standard' in its own text).
const canBeStandard = (rule) => rule.source === 'standard' || (typeof rule.source === 'function' && /'standard'/.test(String(rule.source)));

test('every carrier with rules has a rulebook part, and nothing else does', () => {
  assert.deepEqual(Object.keys(CARRIER_PARTS).sort(), RULE_CARRIERS.map((c) => c.id).sort());
});

test('rulebook entries: unique ids named after their part, a kind, and text', () => {
  const seen = new Set();
  for (const [prefix, part] of [['general', GENERAL], ...Object.entries(CARRIER_PARTS)]) {
    assert.ok(part.title, `${prefix}: a title`);
    for (const section of part.sections) {
      assert.ok(section.heading && section.rules.length, `${prefix}: a section with a heading and rules`);
      for (const entry of section.rules) {
        assert.match(entry.id, new RegExp(`^${prefix}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`), `${entry.id}: <part>.<name>`);
        assert.ok(!seen.has(entry.id), `${entry.id}: unique`);
        seen.add(entry.id);
        assert.ok(KINDS.includes(entry.kind), `${entry.id}: kind "${entry.kind}"`);
        assert.ok(typeof entry.text === 'string' && entry.text.length > 10 && !entry.text.includes('\n'), `${entry.id}: one line of text`);
        // A line that calls its answer a TNI standard is a standard entry, so the test below holds it to the code.
        if (entry.kind !== 'standard') assert.doesNotMatch(entry.text, /\((?:TNI )?standard\)/, `${entry.id}: states a standard, so its kind is standard`);
      }
    }
  }
});

test('every rule that can fill a TNI standard names its standard entry, in the general part or its carrier\'s', () => {
  for (const carrier of RULE_CARRIERS) {
    const own = partIds(carrier);
    for (const rule of carrier.rules) {
      if (!canBeStandard(rule)) continue;
      assert.ok(rule.tni, `${where(carrier, rule)}: a standard rule names its rulebook entry (tni)`);
      const entry = GENERAL_IDS.get(rule.tni) ?? own.get(rule.tni);
      assert.ok(entry, `${where(carrier, rule)}: "${rule.tni}" is in the general part or ${carrier.id}'s`);
      assert.equal(entry.kind, 'standard', `${where(carrier, rule)}: "${rule.tni}" is a standard entry`);
    }
    // Any other rule or click that names an entry names one Luna gets on this carrier.
    for (const step of [...carrier.rules, ...(carrier.actions ?? [])].filter((x) => x.tni)) {
      assert.ok(GENERAL_IDS.has(step.tni) || own.has(step.tni), `${where(carrier, step)}: "${step.tni}" is in the general part or ${carrier.id}'s`);
    }
  }
});

test('every standard entry is filled by the code: a carrier part by its carrier, the general part by any', () => {
  const named = (carrier) => new Set([...carrier.rules, ...(carrier.actions ?? [])].map((x) => x.tni).filter(Boolean));
  const anywhere = new Set(RULE_CARRIERS.flatMap((c) => [...named(c)]));
  for (const entry of entriesOf(GENERAL).filter((e) => e.kind === 'standard')) {
    assert.ok(anywhere.has(entry.id), `${entry.id}: no carrier rule fills this standard`);
  }
  for (const carrier of RULE_CARRIERS) {
    for (const entry of entriesOf(CARRIER_PARTS[carrier.id]).filter((e) => e.kind === 'standard')) {
      assert.ok(named(carrier).has(entry.id), `${entry.id}: no ${carrier.id} rule fills this standard`);
    }
  }
});

const record = () => ({
  applicant: { name: 'Synthetic Freight LLC', owner1: 'Sam Example', ownerDrives: true, dot: '1234567', yearsInBusiness: 4 },
  garaging: { street: '1 Test Way', city: 'Testville', state: 'TX', zip: '75000' },
  operations: { businessClass: 'Expediter', radius: '300', radiusMiles: 300 },
  coverage: { autoLiabLimit: '$1M CSL', cargo: false },
  drivers: [{ first: 'Sam', last: 'Example', dob: '01/02/1980', cdl: null }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', value: 40000 }],
  claims: { hasClaims: false, text: 'No' },
});

test('Luna gets the general part and its own carrier\'s, ahead of the intake', () => {
  for (const carrier of RULE_CARRIERS) {
    const { sources } = evidenceFor({ carrier: carrier.id, record: record(), active: { drivers: 0, vehicles: 0 } });
    const rules = Object.entries(sources).filter(([, s]) => s.basis === 'tni_rule');
    const expected = rulebookFor(carrier.id).map((e) => e.id);
    assert.deepEqual(rules.map(([id]) => id), expected, `${carrier.id}: the general part, then its own`);
    assert.ok(expected.some((id) => id.startsWith('general.')) && expected.some((id) => id.startsWith(`${carrier.id}.`)));
    assert.ok(rules.every(([id]) => id.startsWith('general.') || id.startsWith(`${carrier.id}.`)), `${carrier.id}: no other carrier's rules`);
    // The rules lead, so a carrier's requests share one start.
    const keys = Object.keys(sources);
    assert.deepEqual(keys.slice(0, rules.length), expected);
    assert.ok(keys.slice(rules.length).every((k) => sources[k].basis === 'intake'));
    assert.deepEqual(sources[expected.at(-1)], { basis: 'tni_rule', rule: rulebookFor(carrier.id).at(-1).text });
  }
  // GEICO used to get the intake alone.
  const geico = Object.values(evidenceFor({ carrier: 'geico', record: record(), active: {} }).sources).filter((s) => s.basis === 'tni_rule');
  assert.ok(geico.some((s) => /Delivery Van/.test(s.rule)) && geico.some((s) => /CDL/.test(s.rule)));
  // A carrier without a part gets no TNI rules.
  assert.equal(Object.values(evidenceFor({ carrier: 'test', record: record(), active: {} }).sources).some((s) => s.basis === 'tni_rule'), false);
});

test('a carrier\'s page reviews start the same way, through its last rule', () => {
  const item = (label) => ({ id: 'f1', key: 'k1', label, section: null, controlKind: 'radio', options: ['Yes', 'No'], current: null, status: 'unfamiliar' });
  for (const carrier of RULE_CARRIERS) {
    const other = record();
    other.applicant.name = 'Other Example Inc';
    other.operations.radius = '100';
    other.vehicles[0].value = 25000;
    const a = buildRequest([item('Question one?')], { carrier: carrier.id, page: 'PageA', record: record(), active: { drivers: 0, vehicles: 0 } });
    const b = buildRequest([item('Another question?')], { carrier: carrier.id, page: 'PageB', record: other, active: { drivers: 0, vehicles: 0 } });
    const [ca, cb] = [a.input[0].content, b.input[0].content];
    const last = JSON.stringify(rulebookFor(carrier.id).at(-1).text);
    const end = ca.indexOf(last) + last.length;
    assert.ok(end > last.length, `${carrier.id}: the rules are in the request`);
    assert.equal(ca.slice(0, end), cb.slice(0, end), `${carrier.id}: the same start through the last rule`);
    assert.ok(ca.startsWith(`{"carrier":"${carrier.id}","sources":{"general.`), `${carrier.id}: the carrier, then its rules`);
    assert.equal(a.instructions, b.instructions);
  }
});
