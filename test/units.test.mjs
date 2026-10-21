import test from 'node:test';
import assert from 'node:assert/strict';
import { geico } from '../src/carriers/geico.js';
import { unitListSpecs, unitToAdd, advanceFor } from '../src/units.js';

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

// FL live run 3, 2026-10-21: with "Click Continue when the page is done" on, GEICO's Looks Good is
// clicked once every intake unit is on the list (TNI), never with one still to add or unaccounted for.
test('a unit list is complete only on screen, with as many rows as the intake and every readable unit shown', () => {
  const record = { vehicles: [{ vin: VIN(1) }, { vin: VIN(2) }], trailers: [{ vin: null }], drivers: [] };
  const seen = (rows, shown) => ({ forms: [], lists: [{ rows, shown }, null] });
  assert.equal(unitToAdd(geico, record, VEH, seen(3, [true, true, false])).complete, true, 'the trailer has no VIN: its row counts');
  // A vehicle still to add, a row the intake doesn't have, a VIN the list doesn't show: not complete.
  assert.equal(unitToAdd(geico, record, VEH, seen(2, [true, true, false])).complete, false);
  assert.equal(unitToAdd(geico, record, VEH, seen(4, [true, true, false])).complete, false);
  assert.equal(unitToAdd(geico, record, VEH, seen(3, [true, false, false])).complete, false);
  // The list off screen (a unit's form), or a fill that answered each form but the list not read.
  assert.equal(unitToAdd(geico, record, VEH, { forms: [{ list: 'vehicles', id: 'A', blank: false }], lists: [null, null] }, { unitForms: { vehicles: { A: 0, B: 1 }, trailers: { T: 0 } } }).complete, false);
  // The driver GEICO lists itself (the owner who drives) is on the list as a row of its own.
  const drivers = { applicant: { ownerDrives: true, owner1: 'Pat Owner' }, vehicles: [], trailers: [], drivers: [{ first: 'Pat', last: 'Owner' }, { first: 'Casey', last: 'Example' }] };
  assert.equal(unitToAdd(geico, drivers, DRV, { forms: [], lists: [null, { rows: 2, shown: [true, true] }] }).complete, true);
  assert.equal(unitToAdd(geico, drivers, DRV, { forms: [], lists: [null, { rows: 1, shown: [true, false] }] }).complete, false);
});

test('a carrier\'s Continue for one fill: its list button only once the list is complete', () => {
  assert.equal(advanceFor({ id: 'none' }), null);
  const amwins = { advance: { text: '^save & continue$' } };
  assert.deepEqual([advanceFor(amwins), advanceFor(amwins, true)], [amwins.advance, amwins.advance]);
  const { listed, ...rest } = geico.advance;
  assert.deepEqual(advanceFor(geico), rest);
  assert.deepEqual(advanceFor(geico, true), { ...rest, text: `(?:${rest.text})|(?:${listed})` });
});
