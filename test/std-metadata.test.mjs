// A standard rule's `std` (CarrierRule `std`): how it writes a shared TNI amount, for a hook that may
// replace the amount (docs/agent-defaults-spec.md). Nothing reads it without one, so these tests are
// what keeps it honest: given TNI's amount it gives exactly what the rule gives, in every state where
// it applies; it sits only on the rules writing that one amount; and the rules that do write a shared
// amount all carry it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_IDS, usd, usdK } from '../src/standards.js';
import { STATES } from '../src/states.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

const CARRIERS = [progressive, amwins, geico];
const ACTIVE = { vehicles: 0, drivers: 0, trailers: 0 };

// A synthetic client (no client data), garaged in `state`, with the notes given.
const record = (state, notes = '') => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', owner1: 'Amina Kone', ownerDrives: true },
  garaging: { street: '1 Test Way', city: 'Testville', state, zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', vehicleOwnership: 'Owned' },
  drivers: [{ first: 'Amina', last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: state, cdl: true }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [{ type: 'Dry van', year: 2019, make: 'Wabash', value: 20000 }],
  trailerInfo: {},
  priorInsurance: [],
  coverage: { autoLiabLimit: '$1M CSL', cargo: false },
  claims: { hasClaims: false },
  notes,
});
const RECORDS = Object.keys(STATES).map((state) => record(state));

const resolve = (x, r) => (typeof x === 'function' ? x(r, ACTIVE) : x);
const where = (carrier, rule) => `${carrier.id} ${rule.q ?? rule.selector ?? rule.label ?? rule.name}`;
const withStd = (carrier) => carrier.rules.filter((rule) => rule.std);
// The words a TNI amount is written in, any carrier's way.
const shows = (text, amount) => typeof text === 'string'
  && (typeof amount === 'number' ? [usd(amount), usdK(amount), usdK(amount, 'K')] : [usd(amount.perDay), usd(amount.max)]).some((w) => text.includes(w));
// Another amount than TNI's, to show `write` uses the amount it is given.
const other = (amount) => (typeof amount === 'number' ? amount * 3 : { perDay: amount.perDay + 10, max: amount.max + 300 });

// The concept whose answers each id's amount belongs to (src/concepts.js).
const CONCEPT = { umCsl: 'coverage.um', medPay: 'coverage.medpay', compDeductible: 'coverage.comp-coll', collDeductible: 'coverage.comp-coll', rental: 'coverage.rental' };

test('every std names a shared standard, on a standard rule of that standard\'s concept', () => {
  assert.deepEqual(Object.keys(CONCEPT).sort(), Object.keys(STANDARD_IDS).sort());
  for (const carrier of CARRIERS) {
    for (const rule of withStd(carrier)) {
      assert.ok(Object.hasOwn(STANDARD_IDS, rule.std.id), `${where(carrier, rule)}: std id ${rule.std.id}`);
      assert.equal(rule.concept, CONCEPT[rule.std.id], `${where(carrier, rule)}: a ${rule.std.id} std on a ${rule.concept} rule`);
      assert.ok(rule.source === 'standard' || typeof rule.source === 'function', `${where(carrier, rule)}: std on a rule that is never a standard`);
    }
  }
});

// Given TNI's amount, std gives the rule's own value, name, aliases and unoffered note, in each state
// it applies to (50 states and DC). A state branch inside the rule without `applies` fails here, and so
// does a std on a rule writing another answer (a PIP limit is no Med Pay amount).
test('std, given TNI\'s amount, gives what its rule gives, in every state it applies to', () => {
  for (const carrier of CARRIERS) {
    for (const rule of withStd(carrier)) {
      const amount = STANDARD_IDS[rule.std.id]();
      let applied = 0;
      for (const r of RECORDS) {
        if (rule.std.applies && !rule.std.applies(r, ACTIVE)) continue;
        if (resolve(rule.source, r) !== 'standard') continue;
        applied++;
        const at = `${where(carrier, rule)} in ${r.garaging.state}`;
        assert.deepEqual(rule.std.write(amount), resolve(rule.value, r), `${at}: value`);
        if (rule.std.name) assert.equal(rule.std.name(amount), rule.name, `${at}: name`);
        else assert.ok(!shows(rule.name, amount), `${at}: its name states the amount, so std needs name`);
        const aliases = resolve(rule.choiceAliases, r) ?? [];
        if (rule.std.aliases) assert.deepEqual(rule.std.aliases(amount), aliases, `${at}: aliases`);
        else assert.deepEqual(aliases, [], `${at}: it has choice aliases, so std needs aliases`);
        const unoffered = resolve(rule.unofferedNote, r);
        if (rule.std.unofferedNote) assert.equal(rule.std.unofferedNote(amount), unoffered, `${at}: unofferedNote`);
        else assert.ok(!shows(unoffered, amount), `${at}: its unoffered note states the amount, so std needs unofferedNote`);
      }
      assert.ok(applied > 0, `${where(carrier, rule)}: applies in no state`);
      // Another amount is written as that amount: std doesn't just hand back TNI's.
      assert.notDeepEqual(rule.std.write(other(amount)), rule.std.write(amount), `${where(carrier, rule)}: write ignores the amount`);
      if (rule.std.name) assert.notEqual(rule.std.name(other(amount)), rule.std.name(amount), `${where(carrier, rule)}: name ignores the amount`);
    }
  }
});

// Every standard rule writing a shared amount carries std, so a hook can't miss one.
test('every standard rule that writes a shared TNI amount carries std', () => {
  const ids = Object.keys(STANDARD_IDS);
  for (const carrier of CARRIERS) {
    for (const rule of carrier.rules) {
      if (rule.std) continue;
      for (const r of RECORDS) {
        if (resolve(rule.source, r) !== 'standard') continue;
        const value = resolve(rule.value, r);
        const owed = ids.filter((id) => CONCEPT[id] === rule.concept && shows(value, STANDARD_IDS[id]()));
        assert.deepEqual(owed, [], `${where(carrier, rule)} in ${r.garaging.state} writes "${value}" without std`);
      }
    }
  }
});

// Review of #299 (CodeRabbit): a shared tni id or concept also holds other answers. These share one
// with a std rule and must never take its amount.
test('answers beside a shared standard carry no std of its', () => {
  const none = { geico: ['BasicPip', 'UninsuredMotoristDeductible', 'UmUimType'], progressive: ['1E66', '1E7C'] };
  for (const carrier of CARRIERS) {
    for (const q of none[carrier.id] ?? []) {
      const rules = carrier.rules.filter((rule) => rule.q === q);
      assert.ok(rules.length, `${carrier.id} ${q} exists`);
      for (const rule of rules) assert.equal(rule.std, undefined, `${carrier.id} ${q}: no std`);
    }
  }
});

// GEICO's UM limit in Texas is its split exception, not TNI's CSL amount.
test('GEICO\'s UM limit: the standard amount applies outside Texas only', () => {
  const um = geico.rules.find((rule) => rule.q === 'UninsuredMotorist');
  assert.equal(um.std.applies(record('TX'), ACTIVE), false);
  assert.equal(um.std.applies(record('OH'), ACTIVE), true);
  assert.equal(resolve(um.value, record('TX')), '$100,000/$300,000');
});

test('each shared standard is described on every carrier', () => {
  for (const id of Object.keys(STANDARD_IDS)) {
    for (const carrier of CARRIERS) assert.ok(withStd(carrier).some((rule) => rule.std.id === id), `${carrier.id} has a ${id} std`);
  }
});
