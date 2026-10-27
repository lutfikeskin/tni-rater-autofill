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

// TNI, 2026-10-26 (answer to PR question, T1): with the intake's "owner drives" No, GEICO's quote
// leaves the owner's row out. It is never the driver added next, and the list is complete without it.
test('owner drives No: the owner\'s row is never added, and GEICO\'s driver list is complete without it', () => {
  const record = (ownerDrives, drivers = [{ first: 'Pat', last: 'Owner' }, { first: 'Casey', last: 'Example' }]) =>
    ({ applicant: { ownerDrives, owner1: 'Pat Owner' }, vehicles: [], trailers: [], drivers });
  const list = (rows, shown) => ({ forms: [], lists: [null, { rows, shown }] });
  const no = record(false);
  // The list empty: Casey is added next, never the owner.
  assert.deepEqual(unitToAdd(geico, no, DRV, list(0, [false, false])).adding, { list: 'drivers', index: 1 });
  // Casey on the list: nothing left to add, and the list holds every driver GEICO's quote has.
  let out = unitToAdd(geico, no, DRV, list(1, [false, true]));
  assert.deepEqual([out.adding, out.complete, out.read], [null, true, { rows: 1, units: 1, shown: 1, saved: 0 }]);
  // A row that isn't Casey (the agent added the owner by hand): not complete, and nothing added.
  out = unitToAdd(geico, no, DRV, list(1, [true, false]));
  assert.deepEqual([out.adding, out.complete], [null, false]);
  // The owner's name on the second row: the first row is the owner's all the same (TNI, 2026-10-27:
  // answer to PR question V4), so the second is added (before V4: the first, by name).
  assert.deepEqual(unitToAdd(geico, record(false, [{ first: 'Casey', last: 'Example' }, { first: 'Pat', last: 'Owner' }]), DRV, list(0, [false, false])).adding, { list: 'drivers', index: 1 });
  // The owner's row marked Excluded over a blank box or a Yes: left out too (TNI, 2026-10-27: answer to
  // PR question V3), the list complete with Casey on it.
  for (const box of [null, true]) {
    const marked = record(box, [{ first: 'Pat', last: 'Owner', excluded: true }, { first: 'Casey', last: 'Example' }]);
    assert.deepEqual(unitToAdd(geico, marked, DRV, list(0, [false, false])).adding, { list: 'drivers', index: 1 }, String(box));
    assert.equal(unitToAdd(geico, marked, DRV, list(1, [false, true])).complete, true, String(box));
  }
  // Counterexamples: a blank box or the intake's Yes, GEICO lists the owner itself, as a row of its own.
  for (const box of [null, true]) {
    assert.deepEqual(unitToAdd(geico, record(box), DRV, list(1, [true, false])).adding, { list: 'drivers', index: 1 }, String(box));
    assert.equal(unitToAdd(geico, record(box), DRV, list(1, [false, true])).complete, false, String(box));
    assert.equal(unitToAdd(geico, record(box), DRV, list(2, [true, true])).complete, true, String(box));
  }
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

// W44-01, GEICO OH (2026-10-26): "owner drives" blank, so the extension added no driver on GEICO's
// list (driversKnown), and the quote printed with the owner alone while the panel said nothing. Since
// W44-25 a blank box is TNI's Yes and the owner's row is the first (V4), so the plan adds the other
// drivers itself. The list on screen without an intake driver that no helper of the plan adds (the
// picker still on another driver: no form read on the page yet) is named, as left for the agent.
test('a unit the list doesn\'t have and no helper adds is named; one the plan adds, or off the list, isn\'t', () => {
  const record = { applicant: { ownerDrives: null, owner1: 'Pat Owner' }, garaging: { state: 'OH' }, operations: {}, coverage: {}, claims: {}, priorInsurance: [],
    vehicles: [], trailers: [], drivers: [{ first: 'Pat', last: 'Owner' }, { first: 'Sam', last: 'Second' }] };
  const seen = { forms: [], lists: [null, { rows: 1, shown: [true, false] }] };
  const next = unitToAdd(geico, record, DRV, seen);
  assert.deepEqual([next.adding, next.onList], [{ list: 'drivers', index: 1 }, true]);
  const planFor = (r, n, drivers = n.adding.index) => buildPlan(r, geico, { drivers, vehicles: 0, trailers: 0, adding: { ...n.adding, click: true } });
  // The box blank (TNI's Yes: W44-25, the W44-01 case), the intake's Yes, or the owner under a name no
  // row has (the first row is the owner's: V4): the plan adds driver 2 itself, so nothing is named.
  const blank = record;
  const yes = { ...record, applicant: { ownerDrives: true, owner1: 'Pat Owner' } };
  const unmatched = { ...record, applicant: { ownerDrives: true, owner1: 'Someone Else' } };
  for (const [why, r] of [['blank', blank], ['Yes', yes], ['unmatched', unmatched]]) {
    const n = unitToAdd(geico, r, DRV, seen);
    assert.deepEqual(n.adding, { list: 'drivers', index: 1 }, why);
    assert.equal(planFor(r, n).some((s) => s.baseAction === 'addDriver'), true, `${why}: the fill adds driver 2`);
    assert.equal(unitMissing(n, planFor(r, n)), null, why);
  }
  // A driver's form on screen, not the list: nothing named (the agent may be adding them).
  const onForm = unitToAdd(geico, record, DRV, { forms: [{ list: 'drivers', id: 'F', blank: true }], lists: [null, null] });
  assert.equal(onForm.onList, false);
  assert.equal(unitMissing(onForm, planFor(record, onForm)), null);
  // The picker not on driver 2 (no form read yet, so the list didn't move it): nothing adds them in
  // this fill. The note says to pick them, and never blames the owner question: with any driver row
  // GEICO's own are known (driversKnown), the box blank, Yes, No, or the owner under another name.
  const notOwner = { ...record, applicant: { ownerDrives: false, owner1: 'Pat Owner' } };
  const NOTE = 'Sam Second (driver 2 of the intake) isn\'t on GEICO\'s driver list: pick them in the panel and Fill again, or add them with "+" yourself.';
  for (const [why, r, s] of [['blank', blank, seen], ['Yes', yes, seen], ['unmatched', unmatched, seen], ['No', notOwner, { forms: [], lists: [null, { rows: 0, shown: [false, false] }] }]]) {
    const n = unitToAdd(geico, r, DRV, s);
    const stayed = unitMissing(n, planFor(r, n, 0));
    assert.deepEqual(stayed, { list: 'drivers', index: 1 }, why);
    const item = unitMissingItem(geico, r, stayed);
    assert.deepEqual([item.label, item.path, item.key], ['Add Driver', 'drivers[1]', null], why);
    assert.equal(item.note, NOTE, why);
  }
  // Every driver listed: nothing to add, nothing named.
  assert.equal(unitMissing(unitToAdd(geico, record, DRV, { forms: [], lists: [null, { rows: 2, shown: [true, true] }] }), []), null);
});

// The owner's row GEICO's quote leaves out (omittedDriver: the intake's "owner drives" No, TNI
// 2026-10-26, T1; or the row marked Excluded over a blank box or a Yes, 2026-10-27, V3) is no unit of
// GEICO's driver list, so the panel never names it missing from the list (W44-01's unitMissing),
// whatever the list shows or the panel picked. With that owner the intake's only driver (V1) the list
// has no unit: nothing is named, and noOtherDriver's "needs you" item is what holds Continue.
test('the owner GEICO\'s quote leaves out is never named missing from its driver list; the only driver (V1): nothing named, noOtherDriver holds Continue', () => {
  const base = { garaging: { state: 'OH' }, operations: {}, coverage: {}, claims: {}, notes: {}, priorInsurance: [], vehicles: [], trailers: [] };
  const owner = (excluded) => ({ first: 'Pat', last: 'Owner', excluded });
  const casey = { first: 'Casey', last: 'Example', excluded: null };
  const shows = [[false, false], [true, false], [false, true], [true, true]];
  const planAt = (r, drivers, adding) => buildPlan(r, geico, { drivers, vehicles: 0, trailers: 0, ...(adding ? { adding: { ...adding, click: true } } : {}) });
  // The box's No (row unmarked); the row marked Excluded over a blank box or a Yes.
  for (const [box, mark] of [[false, null], [null, true], [true, true]]) {
    const why = `box ${box}, row ${mark ? 'marked' : 'unmarked'}`;
    const r = { ...base, applicant: { ownerDrives: box, owner1: 'Pat Owner' }, drivers: [owner(mark), casey] };
    assert.equal(geico.omittedDriver(r), 0, why);
    for (const rows of [0, 1, 2]) for (const shown of shows) for (const opts of [{}, { done: new Set(['driverEntered:1']) }, { unitForms: { drivers: { F: 1 } } }]) {
      const next = unitToAdd(geico, r, DRV, { forms: [], lists: [null, { rows, shown }] }, opts);
      const at = `${why}, ${rows} rows, shown ${shown}, ${JSON.stringify(opts.unitForms ?? [...(opts.done ?? [])])}`;
      assert.notEqual(next.adding?.index, 0, `${at}: never the owner's row next`);
      // Whichever driver the panel has picked, the owner's row is never the one named missing.
      for (const picked of [0, 1]) {
        const missing = next.adding ? unitMissing(next, planAt(r, picked, next.adding)) : null;
        assert.notEqual(missing?.index, 0, `${at}, picked ${picked}`);
        if (missing) assert.match(unitMissingItem(geico, r, missing).note, /^Casey Example \(driver 2 of the intake\) isn't on GEICO's driver list: pick them/, at);
      }
    }
    // The empty list: Casey is next, added by the plan once picked; with the owner's row picked he is
    // the one named, never the owner.
    const next = unitToAdd(geico, r, DRV, { forms: [], lists: [null, { rows: 0, shown: [false, false] }] });
    assert.deepEqual(next.adding, { list: 'drivers', index: 1 }, why);
    assert.equal(unitMissing(next, planAt(r, 1, next.adding)), null, why);
    assert.deepEqual(unitMissing(next, planAt(r, 0, next.adding)), { list: 'drivers', index: 1 }, why);
    // Casey listed: the list is complete without the owner, nothing named.
    const done = unitToAdd(geico, r, DRV, { forms: [], lists: [null, { rows: 1, shown: [false, true] }] });
    assert.deepEqual([done.adding, done.complete, unitMissing(done, planAt(r, 0))], [null, true, null], why);
  }
  // V1: the owner who doesn't drive is the only driver. The list has no unit: nothing added or named,
  // and the plan's noOtherDriver item ("needs you", pagekit.test.mjs) holds Looks Good.
  for (const [box, mark] of [[false, null], [null, true], [true, true]]) {
    const why = `only driver: box ${box}, row ${mark ? 'marked' : 'unmarked'}`;
    const r = { ...base, applicant: { ownerDrives: box, owner1: 'Pat Owner' }, drivers: [owner(mark)] };
    for (const [rows, shown] of [[0, [false]], [1, [true]], [1, [false]]]) {
      const next = unitToAdd(geico, r, DRV, { forms: [], lists: [null, { rows, shown }] });
      assert.equal(next.adding, null, `${why}, ${rows} rows`);
      assert.equal(unitMissing(next, planAt(r, 0)), null, `${why}, ${rows} rows`);
    }
    const plan = planAt(r, 0);
    assert.ok(!plan.some((s) => s.baseAction === 'addDriver'), `${why}: no "+"`);
    const item = plan.find((s) => s.kind === 'action' && s.action === 'noOtherDriver');
    assert.ok(item, `${why}: the needs-you item`);
    assert.match(item.missing, /no driver besides the owner, who doesn't drive/, why);
  }
});
