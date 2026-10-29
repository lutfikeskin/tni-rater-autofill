// TNI's standard coverage answers (src/standards.js), decided once: every carrier's answer to
// them shows those amounts, in the carrier's own words, and so does any amount its rule's name
// states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STANDARDS, usd, usdK } from '../src/standards.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

const CARRIERS = [progressive, amwins, geico];

const record = () => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', owner1: 'Amina Kone', ownerDrives: true },
  garaging: { street: '1 Test Way', city: 'Testville', state: 'NJ', zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', vehicleOwnership: 'Owned' },
  drivers: [{ first: 'Amina', last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: 'NJ', cdl: true }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  trailerInfo: {},
  priorInsurance: [],
  coverage: { autoLiabLimit: '$1M CSL', cargo: false },
  claims: { hasClaims: false },
});

// Each shared standard: the rulebook ids under which the carriers fill it (a carrier-only rule
// under the same id, GEICO's UM deductible and type, is left out by `not`) and its amounts.
const SHARED = [
  { what: 'uninsured motorist', ids: ['progressive.um', 'geico.um', 'amwins.um'], not: /deductible|type/i, amounts: [STANDARDS.umCsl] },
  { what: 'medical payments', ids: ['progressive.medpay', 'geico.medpay-pip', 'amwins.medpay-pip'], only: /^medical payments/i, amounts: [STANDARDS.medPay] },
  { what: 'comprehensive and collision deductible', ids: ['progressive.deductibles', 'geico.comp-coll', 'amwins.comp-coll'], amounts: [STANDARDS.deductible] },
  { what: 'rental reimbursement', ids: ['progressive.rental', 'geico.rental', 'amwins.rental'], amounts: [STANDARDS.rental.perDay, STANDARDS.rental.max] },
];

const written = (amount) => [usd(amount), usdK(amount), usdK(amount, 'K')];
const escape = (s) => s.replace(/[$.]/g, '\\$&');
const shows = (text, amount) => written(amount).some((w) => new RegExp(`${escape(w)}(?![\\d,])`).test(text));

// The carrier's rules for one standard, with the answer each gives this client (text answers only:
// a Yes for "comprehensive or collision wanted" is no amount).
function answers(carrier, { ids, not, only }) {
  return carrier.rules
    .filter((r) => ids.includes(r.tni) && !(not && not.test(r.name ?? '')) && (!only || only.test(r.name ?? '')))
    .map((r) => ({ name: r.name ?? '', value: typeof r.value === 'function' ? r.value(record(), { vehicles: 0, drivers: 0, trailers: 0 }) : r.value }))
    .filter((a) => typeof a.value === 'string');
}

for (const carrier of CARRIERS) {
  test(`${carrier.name}: TNI's shared standard coverages show the amounts in src/standards.js`, () => {
    for (const standard of SHARED) {
      for (const a of answers(carrier, standard)) {
        for (const amount of standard.amounts) assert.ok(shows(a.value, amount), `${carrier.name} ${standard.what}: "${a.value}" shows ${usd(amount)}`);
        // A name that states an amount states the standard's.
        if (/\$\d/.test(a.name)) for (const amount of standard.amounts) assert.ok(shows(a.name, amount), `${carrier.name} ${standard.what}: "${a.name}" says ${usd(amount)}`);
      }
    }
  });
}

test('each shared standard is filled by every carrier', () => {
  for (const standard of SHARED) {
    for (const carrier of CARRIERS) assert.ok(answers(carrier, standard).length, `${carrier.name} fills ${standard.what}`);
  }
});

test('the amounts are written as the carriers\' options write them', () => {
  assert.equal(usd(STANDARDS.umCsl), '$100,000');
  assert.equal(usdK(STANDARDS.umCsl), '$100k');
  assert.equal(usdK(STANDARDS.umCsl, 'K'), '$100K');
  assert.equal(usd(STANDARDS.rental.max), '$1,200');
});

// Luna reads the same amounts: each carrier's rulebook entry for a shared standard states them
// (src/ai/rulebook/<carrier>.js writes them from src/standards.js too).
test('each carrier\'s rulebook states the shared standards\' amounts', async () => {
  const { rulebookFor } = await import('../src/ai/tni-rules.js');
  for (const carrier of CARRIERS) {
    const entries = new Map(rulebookFor(carrier.id).map((e) => [e.id, e.text]));
    for (const standard of SHARED) {
      const texts = standard.ids.filter((id) => entries.has(id)).map((id) => entries.get(id));
      assert.ok(texts.length, `${carrier.name}'s rulebook has ${standard.what}`);
      for (const amount of standard.amounts) assert.ok(texts.some((t) => shows(t, amount)), `${carrier.name}'s rulebook says ${usd(amount)} for ${standard.what}`);
    }
  }
});
