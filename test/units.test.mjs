import test from 'node:test';
import assert from 'node:assert/strict';
import { geico } from '../src/carriers/geico.js';
import { unitListSpecs, unitToAdd } from '../src/units.js';

const VEH = 'Vehicles';
const DRV = 'Drivers & Incidents';
const VIN = (n) => `1FTBR3X80MKA1234${n}`;

test('the unit lists are read for VINs and names; a driver another driver\'s name holds is read for nothing', () => {
  const record = { vehicles: [{ vin: VIN(1) }], trailers: [{ vin: null }], drivers: [{ first: 'John', last: 'Smith' }, { first: 'John', last: 'Smith Jr' }] };
  const [vehicles, drivers] = unitListSpecs(geico, record);
  assert.deepEqual(vehicles.items, [VIN(1), '']);
  assert.deepEqual(drivers.items, [[], ['John', 'Smith Jr']]);
});

// Code review of PR #124: a unit the list can't be read for was never taken as on the quote, so one
// the agent added by hand was added again.
test('a unit the list can\'t be read for is never added twice when the list has a row no unit is known to be on', () => {
  const ownerDrives = { ownerDrives: true, owner1: 'Pat Owner' };
  const record = { applicant: ownerDrives, vehicles: [], trailers: [],
    drivers: [{ first: 'Pat', last: 'Owner' }, { first: 'John', last: 'Smith' }, { first: 'John', last: 'Smith Jr' }] };
  // The agent added John Smith by hand: GEICO lists the owner and him. Not him again: John Smith Jr.
  let out = unitToAdd(geico, record, DRV, { forms: [], lists: [null, { rows: 2, shown: [true, false, false] }] });
  assert.deepEqual([out.adding, out.marks], [{ list: 'drivers', index: 2 }, ['driverEntered:0', 'driverEntered:1']]);
  // Nobody added yet (only the owner listed): John Smith next, as before.
  out = unitToAdd(geico, record, DRV, { forms: [], lists: [null, { rows: 1, shown: [true, false, false] }] });
  assert.deepEqual([out.adding, out.marks], [{ list: 'drivers', index: 1 }, ['driverEntered:0']]);

  // Trailers without a VIN, one added by hand: none is added (either may be the one on the list).
  const trailers = { vehicles: [{ vin: VIN(1) }], trailers: [{ vin: null }, { vin: '' }], drivers: [] };
  out = unitToAdd(geico, trailers, VEH, { forms: [], lists: [{ rows: 2, shown: [true, false, false] }, null] });
  assert.deepEqual([out.adding, out.marks], [null, ['vehicleEntered:0', 'trailerEntered:0', 'trailerEntered:1']]);
  // A trailer the extension added (its form filled for trailer 1) is known: trailer 2 is added.
  out = unitToAdd(geico, trailers, VEH, { forms: [], lists: [{ rows: 2, shown: [true, false, false] }, null] }, { unitForms: { trailers: { T: 0 } } });
  assert.deepEqual(out.adding, { list: 'trailers', index: 1 });
  // A unit with a VIN is still added past a row no unit is known to be on: the list shows it isn't in.
  const vins = { vehicles: [{ vin: VIN(1) }, { vin: VIN(2) }], trailers: [{ vin: null }], drivers: [] };
  out = unitToAdd(geico, vins, VEH, { forms: [], lists: [{ rows: 2, shown: [true, false, false] }, null] });
  assert.deepEqual(out.adding, { list: 'vehicles', index: 1 });
});

test('off the unit lists\' steps, or with nothing read, no unit is chosen', () => {
  assert.equal(unitToAdd(geico, { vehicles: [{}] }, 'Quote & Coverages', { forms: [], lists: [null, null] }), null);
  assert.equal(unitToAdd(geico, { vehicles: [{}] }, VEH, null), null);
  assert.equal(unitToAdd({ id: 'progressive' }, { vehicles: [{}] }, VEH, { forms: [], lists: [] }), null);
});
