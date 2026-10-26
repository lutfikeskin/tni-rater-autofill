import test from 'node:test';
import assert from 'node:assert/strict';
import { geico } from '../src/carriers/geico.js';
import { unitListSpecs, unitToAdd, unitMissing, unitMissingItem, advanceFor } from '../src/units.js';
import { buildPlan } from '../src/plan.js';

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

// W43-40 (GEICO FL, 2026-10-21 and 2026-10-22): Looks Good was never clicked on a list that needed
// a VIN or name read (0 of 8), only on owner-only driver lists (2 of 2); the captured lists and the
// mock read right. A unit a fill answered and saved a form for counts as on the list, with the
// list's rows matching the intake; a unit neither shown nor saved still holds Looks Good.
test('a unit list is complete with every unit shown or saved from a form a fill answered, and says its counts', () => {
  const record = { vehicles: [{ vin: VIN(1) }, { vin: VIN(2) }, { vin: VIN(3) }], trailers: [], drivers: [] };
  const seen = (rows, shown) => ({ forms: [], lists: [{ rows, shown }, null] });
  const saved = { unitForms: { vehicles: { A: 0, B: 1, C: 2 } } };
  let out = unitToAdd(geico, record, VEH, seen(3, [false, false, false]), saved);
  assert.equal(out.complete, true, 'every vehicle saved by a fill, three rows');
  assert.deepEqual(out.read, { rows: 3, units: 3, shown: 0, saved: 3 });
  assert.equal(unitToAdd(geico, record, VEH, seen(3, [false, false, false]), { unitForms: { vehicles: { A: 0, B: 1 } } }).complete, false, 'one neither shown nor saved');
  assert.equal(unitToAdd(geico, record, VEH, seen(3, [false, false, true]), { unitForms: { vehicles: { A: 0, B: 1 } } }).complete, true, 'that one shown');
  assert.equal(unitToAdd(geico, record, VEH, seen(2, [false, false, false]), saved).complete, false, 'a row short: one saved form was discarded');
  assert.equal(unitToAdd(geico, record, VEH, seen(4, [false, false, false]), saved).complete, false, 'a row the intake does not have');
  assert.equal(unitToAdd(geico, record, VEH, { forms: [], lists: [null, null] }, saved).read, null, 'no list: no read');
});

// W44-01, GEICO OH (2026-10-26): "owner drives" blank, so the extension adds no driver on GEICO's
// list (driversKnown: the owner may be one of them under another name), and the quote printed with
// the owner alone while the panel said nothing. The list on screen without an intake driver that no
// helper of the plan adds is named, as left for the agent.
test('a unit the list doesn\'t have and no helper adds is named; one the plan adds, or off the list, isn\'t', () => {
  const record = { applicant: { ownerDrives: null, owner1: 'Pat Owner' }, garaging: { state: 'OH' }, operations: {}, coverage: {}, claims: {}, priorInsurance: [],
    vehicles: [], trailers: [], drivers: [{ first: 'Pat', last: 'Owner' }, { first: 'Sam', last: 'Second' }] };
  const seen = { forms: [], lists: [null, { rows: 1, shown: [true, false] }] };
  const next = unitToAdd(geico, record, DRV, seen);
  assert.deepEqual([next.adding, next.onList], [{ list: 'drivers', index: 1 }, true]);
  const planFor = (r, n) => buildPlan(r, geico, { drivers: n.adding.index, vehicles: 0, trailers: 0, adding: { ...n.adding, click: true } });
  assert.equal(planFor(record, next).some((s) => s.baseAction === 'addDriver'), false, 'the "+" is the agent\'s here');
  const missing = unitMissing(next, planFor(record, next));
  assert.deepEqual(missing, { list: 'drivers', index: 1 });
  const item = unitMissingItem(geico, record, missing);
  assert.deepEqual([item.label, item.path, item.key], ['Add Driver', 'drivers[1]', null]);
  assert.match(item.note, /^Sam Second \(driver 2 of the intake\) isn't on GEICO's driver list/);
  assert.match(item.note, /doesn't say whether the owner drives/);
  // The owner drives under a name no driver has: the same, with that reason.
  const unmatched = { ...record, applicant: { ownerDrives: true, owner1: 'Someone Else' } };
  assert.match(unitMissingItem(geico, unmatched, missing).note, /no driver on the intake has the owner's name/);
  // Owner drives and is driver 1 (the plan adds driver 2 itself): nothing named.
  const known = { ...record, applicant: { ownerDrives: true, owner1: 'Pat Owner' } };
  const nextKnown = unitToAdd(geico, known, DRV, seen);
  assert.deepEqual(nextKnown.adding, { list: 'drivers', index: 1 });
  assert.equal(unitMissing(nextKnown, planFor(known, nextKnown)), null);
  // A driver's form on screen, not the list: nothing named (the agent may be adding them).
  const onForm = unitToAdd(geico, record, DRV, { forms: [{ list: 'drivers', id: 'F', blank: true }], lists: [null, null] });
  assert.equal(onForm.onList, false);
  assert.equal(unitMissing(onForm, planFor(record, onForm)), null);
  // Every driver listed: nothing to add, nothing named.
  assert.equal(unitMissing(unitToAdd(geico, record, DRV, { forms: [], lists: [null, { rows: 2, shown: [true, true] }] }), []), null);
});
