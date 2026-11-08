// An intake value its field's kind can't hold (the text as written, which normalizeIntake keeps in
// the typed slot when it doesn't parse) is never filled as an answered intake value: the step is
// the agent's, with the text quoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { parseEdit } from '../src/normalize.js';
import { progressive } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

const record = ({ dob = '01/02/1980', year = 2022, value = 45000 } = {}) => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', owner1: 'Zed Other', ownerDrives: true },
  garaging: { street: '1 Test Way', city: 'Testville', state: 'OH', zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', vehicleOwnership: 'Owned' },
  // The second driver is the one under test (GEICO's first is the owner it already lists).
  drivers: [
    { first: 'Zed', last: 'Other', dob: '05/06/1970', licenseNumber: 'NJ7654321', licenseState: 'OH', cdl: true },
    { first: 'Amina', last: 'Kone', dob, licenseNumber: 'NJ1234567', licenseState: 'OH', cdl: true },
  ],
  vehicles: [{ type: 'Van', year, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value }],
  trailers: [],
  trailerInfo: {},
  priorInsurance: [],
  coverage: { autoLiabLimit: '$1M CSL', cargo: false },
  claims: { hasClaims: false },
});
// The steps that read the path straight from the intake, not ones only checked against it.
const read = (plan, path) => plan.filter((s) => s.path === path && s.source === 'intake' && !s.verifyOnly && !s.ignore);

for (const carrier of [progressive, amwins, geico]) {
  test(`${carrier.id}: an unreadable date of birth is the agent's, never an answered intake value`, () => {
    const good = read(buildPlan(record(), carrier, { drivers: 1 }), 'drivers[1].dob');
    assert.ok(good.length, 'the carrier has a date of birth step');
    for (const s of good) if (!s.note) assert.equal(s.resolution.status, 'answered');
    const steps = read(buildPlan(record({ dob: '13/45/1980' }), carrier, { drivers: 1 }), 'drivers[1].dob');
    assert.equal(steps.length, good.length);
    for (const s of steps) {
      assert.equal(s.value, null, `${s.name}: not filled`);
      assert.notEqual(s.resolution.status, 'answered');
      assert.ok(s.note, 'says why');
    }
    // A step without a note of its own is the agent's and quotes the text.
    const quoted = steps.filter((s) => !good.find((g) => g.name === s.name && g.note));
    assert.ok(quoted.length, 'some step reads the date of birth unguarded');
    for (const s of quoted) {
      assert.equal(s.resolution.status, 'agent');
      assert.match(s.note, /"13\/45\/1980", which isn't a valid date/);
    }
  });
}

test('an unreadable vehicle year or value, read straight from the intake, is the agent\'s', () => {
  const value = read(buildPlan(record({ value: 'around 40k' }), progressive, {}), 'vehicles[0].value').filter((s) => s.re);
  assert.ok(value.length, 'Progressive has a label rule for the vehicle value');
  for (const s of value) {
    assert.equal(s.value, null);
    assert.equal(s.resolution.status, 'agent');
    assert.match(s.note, /"around 40k", which isn't a dollar amount/);
  }
  const year = read(buildPlan(record({ year: '20O1' }), amwins, {}), 'vehicles[0].year');
  assert.ok(year.length, 'AmWINS has a vehicle year step');
  for (const s of year) {
    assert.equal(s.value, null);
    assert.match(s.note, /"20O1", which isn't a whole number/);
  }
});

test('an agent\'s edit that doesn\'t parse is held the same way', () => {
  const dob = parseEdit('date', '02/30/1980');
  assert.equal(dob, '02/30/1980', 'parseEdit keeps the text');
  const steps = read(buildPlan(record({ dob }), progressive, { drivers: 1 }), 'drivers[1].dob');
  assert.ok(steps.length);
  for (const s of steps) assert.equal(s.resolution.status, 'agent');
});

test('readable values are untouched', () => {
  const plan = buildPlan(record(), amwins, {});
  for (const s of read(plan, 'vehicles[0].year')) assert.equal(s.value, 2022);
  for (const s of read(plan, 'drivers[0].dob')) assert.equal(s.value, '05/06/1970');
});
