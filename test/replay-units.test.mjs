import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = {};
vm.runInNewContext(fs.readFileSync(new URL('./replay/units.js', import.meta.url), 'utf8'), context);
const { replayUnitRows: unitRows, replayUnitCaption: unitCaption } = context;
// Plain objects: the script's arrays are another realm's.
const withUnits = (...args) => JSON.parse(JSON.stringify(context.replayWithUnits(...args)));

// The sample intake's units, as test/fixtures/sample-intake.pdf reads (no trailers).
const sample = {
  vehicles: [
    { type: 'Van', year: 2021, make: 'FORD', model: 'Transit 350', vin: '1FTBR3X87MKA12345', value: 45000 },
    { type: 'Box Truck', year: 2019, make: 'ISUZU', model: 'NPR HD', vin: '1FTBR3X80MKA12399', value: 38000 },
  ],
  trailers: [],
};
const row = (ref, caption, r) => ({ ref, kind: 'combo', caption, row: r });

test('the replay finds a layout\'s units by their Rates rows, in row order, one name per row', () => {
  const units = unitRows({ pages: {
    AddVehicle: { fields: [{ kind: 'text', caption: 'VIN' }] },
    CoveragesRates: { fields: [
      row('LineInput.RBIPDLimit', 'Bodily Injury and Property Damage Liability', '8_1'),
      row('ComprehensiveInput.Deductible', '2019 Wilson', '8_10'),
      row('ComprehensiveInput.Deductible', '2013 PETERBILT 388', '8_1'),
      row('ComprehensiveInput.Deductible', '2016 FREIGHTLINER CASCADIA 125', '8_2'),
      // Another quote's truck in row 2 of a merged layout: the row keeps its first name.
      row('RentalWithDTInput.Limit', '2018 KENWORTH T680', '8_2'),
      // Recorded before rows (a question id only): no unit of its own, drawn apart.
      { q: '1FCD', kind: 'combo', caption: '2016 FREIGHTLINER CASCADIA 125' },
    ] },
  } });
  assert.equal(units.page, 'CoveragesRates');
  assert.deepEqual([...units.list], ['2013 PETERBILT 388', '2016 FREIGHTLINER CASCADIA 125', '2019 Wilson']);
  assert.equal(units.apart.size, 1);
  assert.equal(unitCaption({ caption: '2018 KENWORTH T680', row: '8_2' }, units, 'CoveragesRates'), '2016 FREIGHTLINER CASCADIA 125');
  assert.equal(unitCaption({ caption: 'Bodily Injury and Property Damage Liability', row: '8_1' }, units, 'CoveragesRates'), 'Bodily Injury and Property Damage Liability');
  // A layout recorded before rows: one unit per name.
  const before = unitRows({ pages: { CoveragesRates: { fields: [{ caption: '2025 RAM PROMASTER 2500' }, { caption: '2025 RAM PROMASTER 2500' }, { caption: '2019 MERCEDES-BENZ SPRINTER' }] } } });
  assert.deepEqual([...before.list], ['2025 RAM PROMASTER 2500', '2019 MERCEDES-BENZ SPRINTER']);
  assert.equal(before.apart.size, 0);
});

test('the replay gives the sample intake as many vehicles and trailers as the layout, named after its rows', () => {
  // One vehicle: the sample's first, by its own name, as before.
  const one = withUnits(sample, { vehicles: 1, trailers: false }, ['2025 RAM PROMASTER 2500']);
  assert.deepEqual(one.vehicles, [sample.vehicles[0]]);
  assert.deepEqual(one.trailers, []);
  // Three vehicles: the third repeats the sample's first with another VIN; each takes its row's name.
  const three = withUnits(sample, { vehicles: 3, trailers: false }, ['2025 RAM PROMASTER 2500', '2019 MERCEDES-BENZ SPRINTER', '2016 FREIGHTLINER CASCADIA 125']);
  assert.deepEqual(three.vehicles.map((v) => [v.year, v.make, v.model]), [[2025, 'RAM', 'PROMASTER 2500'], [2019, 'MERCEDES-BENZ', 'SPRINTER'], [2016, 'FREIGHTLINER', 'CASCADIA 125']]);
  assert.deepEqual(three.vehicles.map((v) => v.value), [45000, 38000, 45000]);
  assert.equal(new Set(three.vehicles.map((v) => v.vin)).size, 3);
  // A vehicle and a trailer; the rows show a second trailer the context didn't count.
  const trailers = withUnits(sample, { vehicles: 1, trailers: true }, ['2013 PETERBILT 388', '2019 Wilson', '2020 Great Dane']);
  assert.deepEqual(trailers.vehicles.map((v) => `${v.year} ${v.make} ${v.model}`), ['2013 PETERBILT 388']);
  assert.deepEqual(trailers.trailers.map((t) => [t.year, t.make, t.model, t.type]), [[2019, 'Wilson', null, 'Dry Van'], [2020, 'Great', 'Dane', 'Dry Van']]);
  // More rows than the context's vehicles, without trailers: more vehicles.
  assert.equal(withUnits(sample, { vehicles: 1, trailers: false }, ['2025 RAM PROMASTER 2500', '2020 FORD TRANSIT']).vehicles.length, 2);
  // A trailer with no rows to name it keeps the made-up one's name.
  assert.deepEqual(withUnits(sample, { vehicles: 1, trailers: true }, []).trailers.map((t) => t.make), ['WABASH']);
});
