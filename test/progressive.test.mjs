import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { progressive } from '../src/carriers/progressive.js';

const baseRecord = () => ({
  applicant: {
    name: 'Synthetic Expediter LLC', dot: null, mc: null, mcDotWithin60Days: null,
    owner1: 'Amina Kone', ownerDrives: true, phone: '(555) 010-0100', email: 'client@example.test',
    fein: null,
  },
  garaging: { street: '1 Test Way', unit: null, city: 'Testville', state: 'MD', zip: '21000' },
  operations: {
    businessClass: 'Expediter', whatHaul: 'General freight', radius: 'Unlimited', radiusMiles: null,
    personalUse: false, hazPlacard: false, filingsRequired: true, filingsWhich: 'Federal Liability Filing', usesEld: null,
  },
  drivers: [{ first: 'Amina', middle: null, last: 'Kone', dob: '01/02/1980', licenseNumber: 'MD1234567', licenseState: 'MD' }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Other', limit: '$500k CSL', expiration: '10/31/2026' }],
  coverage: {
    autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000,
    gl: false, glLimit: null, comprehensiveDeductible: null, collisionDeductible: null,
  },
  claims: { hasClaims: false },
});

const byQ = (plan, q) => plan.find((step) => step.q === q);

test('freight intake maps business type and blank business name to sole proprietor', () => {
  const record = baseRecord();
  record.applicant.name = null;
  record.operations.businessClass = 'Freight Hauler';
  record.operations.whatHaul = 'General freight hauler';
  const plan = buildPlan(record, progressive);
  assert.equal(byQ(plan, '239').value, 'General Freight Hauler');
  assert.deepEqual(byQ(plan, '239').choiceAliases, ['General Freight Trucking']);
  assert.equal(byQ(plan, '239').note, null);
  assert.equal(byQ(plan, '22D').value, 'Individual / Sole Proprietor');
  assert.equal(byQ(plan, '230').value, record.applicant.owner1);
  record.operations.whatHaul = 'Freight';
  assert.equal(byQ(buildPlan(record, progressive), '239').value, 'General Freight Hauler', 'TNI quotes freight haulers as General Freight Hauler');
  record.operations.businessClass = 'Dry Van';
  assert.equal(byQ(buildPlan(record, progressive), '239').value, 'Dry Van', 'anything else goes in as written, for the type-ahead');
});

test('owner name punctuation and reversed order still match the unique driver DOB', () => {
  const record = baseRecord();
  record.applicant.owner1 = 'Kone, Amina';
  const plan = buildPlan(record, progressive);
  assert.equal(byQ(plan, '2BB').value, '01/02/1980');
  assert.equal(byQ(plan, '295').value, 'Amina');
  assert.equal(byQ(plan, '297').value, 'Kone');
  record.drivers.push({ ...record.drivers[0], dob: '02/03/1985' });
  assert.equal(byQ(buildPlan(record, progressive), '2BB').value, null);
});

test('prefilled insurance type without limit or expiry means currently insured No', () => {
  const record = baseRecord();
  record.priorInsurance = [{ type: 'Commercial Auto', carrier: null, limit: null, expiration: null }];
  const plan = buildPlan(record, progressive);
  assert.equal(byQ(plan, '81').value, false);
  assert.equal(byQ(plan, '83').value, false);
  for (const q of ['95', '9D']) assert.equal(byQ(plan, q).ignore, true);
  record.priorInsurance[0].limit = '$500k CSL';
  record.priorInsurance[0].expiration = '10/31/2026';
  assert.equal(byQ(buildPlan(record, progressive), '81').value, true);
});

test('sole owner-driver with duplicated first name uses owner surname and driver DOB', () => {
  const record = baseRecord();
  record.drivers[0].last = 'Amina';
  const plan = buildPlan(record, progressive);
  assert.equal(byQ(plan, '2BB').value, record.drivers[0].dob);
  assert.equal(byQ(plan, '297').value, 'Kone');
  record.applicant.ownerDrives = false;
  assert.equal(byQ(buildPlan(record, progressive), '2BB').value, null);
});

test('Progressive standard answers: USDOT belongs to the business, filings, MCS-90 left to the page', () => {
  const record = baseRecord();
  record.applicant.dot = '1234567';
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '2C1A').value, true, 'for-hire is the supported workflow default');
  assert.equal(byQ(plan, '29F').value, true, 'owner-as-driver follows the intake');
  assert.equal(byQ(plan, '2A5').kind, 'first-option', 'home address: always the first choice');
  assert.equal(byQ(plan, '208A').value, true, 'no equipment, other-state id');
  assert.equal(byQ(plan, '1FDD').value, 'Not selected', 'UMPD');
  assert.equal(byQ(plan, '20F').value, true);
  assert.equal(byQ(plan, '20F').note, null);
  assert.equal(byQ(plan, 'F11').value, true);
  assert.equal(plan.find((step) => step.re === '^federal( liability)?( filing)?$').value, true);
  assert.equal(plan.find((step) => step.re === '^mcs ?-?90$').ignore, true);
  assert.equal(plan.find((step) => step.re === '^state( filing)?$').ignore, true);
});

test('Progressive preserves optional and server-owned controls', () => {
  const plan = buildPlan(baseRecord(), progressive, {});
  for (const q of ['18F', '194', '1CC', '77', '2DB', '2DD', '2DF', '2B00', '1E7C', '3E96', '3E97', '3EA4', '32CE', '32D0', '32DD']) {
    assert.equal(byQ(plan, q).ignore, true, `q${q} is preserved`);
  }
  for (const q of ['year', 'make', 'model']) {
    const step = plan.find((s) => s.path === `vehicles[0].${q}`);
    assert.equal(step.verifyOnly, true, `decoded vehicle ${q} is verified, not typed`);
  }
  assert.equal(byQ(plan, '2CE3').value, true, 'standard: no permanently attached equipment');
  for (const q of ['2CE0', '2BB4', '2BCB']) assert.equal(byQ(plan, q).ignore, true, `q${q} is left to the page`);
});

test('Progressive coverage and helper ordering are conservative', () => {
  const record = baseRecord();
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '1DEE').value, '$100k CSL');
  assert.equal(byQ(plan, '2000').kind, 'selected-option');
  assert.equal(byQ(plan, '2000').value, 'Selected');
  assert.equal(byQ(plan, '200F').value, 'Not selected');
  assert.equal(byQ(plan, '216F').value, '$100000/$1000');
  assert.equal(byQ(plan, '1FCD').value, '$1,000 Deductible', 'TNI standard deductible');
  assert.equal(byQ(plan, '1FD2').value, '$1,000 Deductible');
  record.coverage.comprehensiveDeductible = '$500 Deductible';
  assert.equal(byQ(buildPlan(record, progressive, {}), '1FCD').value, '$500 Deductible', 'the intake wins when it has one');
  const actions = plan.filter((step) => step.kind === 'action');
  const recalc = actions.find((step) => step.action === 'recalculate');
  const bill = actions.find((step) => step.action === 'billPlan');
  // Cargo, then bill plan options (automatic payments), back to Rates, then Recalculate.
  assert.deepEqual(recalc.afterActions, ['doneCargo']);
  assert.deepEqual(recalc.afterPages, ['ChangePaymentPlan']);
  assert.equal(recalc.verify, 'premium');
  assert.equal(bill.needsPremium, false);
  assert.deepEqual(bill.afterActions, ['doneCargo']);
  assert.ok(new RegExp(bill.text, 'i').test('Billing Options'));
  const print = actions.find((step) => step.action === 'print');
  assert.deepEqual(print.afterActions, ['recalculate']);
  const gl = structuredClone(record);
  gl.coverage.gl = true;
  assert.ok(!buildPlan(gl, progressive, {}).some((step) => step.action === 'billPlan'), 'with GL the agent does the rates page');
  assert.ok(bill.afterAny.includes('progressive.q216F'));
  const multi = structuredClone(record);
  multi.vehicles.push({ type: 'Van', year: 2021, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 40000 });
  assert.deepEqual(byQ(buildPlan(multi, progressive, { vehicles: 1 }), '1FCD').vehicleHint, ['2021', 'ford', 'transit']);
  assert.equal(byQ(buildPlan(multi, progressive, { vehicles: 1 }), '1FCD').note, null);
  assert.equal(byQ(buildPlan(record, progressive, {}), '1FCD').vehicleHint, null, 'one vehicle: no row matching needed');
});

test('filings follow the intake; a missing USDOT number is only a warning', () => {
  const record = baseRecord();
  record.applicant.dot = null;
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, 'CA').value, null, 'a note makes the value null: the agent answers it');
  assert.match(byQ(plan, 'CA').note, /no USDOT/i);
  record.applicant.dot = '1234567';
  assert.equal(byQ(buildPlan(record, progressive, {}), 'CA').value, true);
  assert.equal(byQ(buildPlan(record, progressive, {}), '20F').value, true);
});

test('absent DOT means No unless applying within 60 days is explicitly Yes', () => {
  const record = baseRecord();
  for (const pending of [null, undefined, false]) {
    record.applicant.mcDotWithin60Days = pending;
    assert.equal(byQ(buildPlan(record, progressive), '1ED').value, 'No - and the customer will not have a USDOT number');
  }
  record.applicant.mcDotWithin60Days = true;
  assert.match(byQ(buildPlan(record, progressive), '1ED').value, /^Not Yet/);
  record.applicant.dot = '1234567';
  assert.match(byQ(buildPlan(record, progressive), '1ED').value, /^Yes/);
});

test('Type of Trucker is Other For-Hire Trucking for expediters and left alone otherwise', () => {
  for (const businessClass of ['Expediter', 'Expediters', 'General Freight', 'Dry Van', null]) {
    const record = baseRecord();
    record.operations.businessClass = businessClass;
    const step = byQ(buildPlan(record, progressive), '267');
    const expediter = /expedit/i.test(businessClass ?? '');
    assert.equal(step.value, expediter ? 'Other For-Hire Trucking' : null);
    assert.equal(step.ignore, !expediter);
  }
});

test('search-style business type (IN), other-coverage checkboxes, vehicle list', () => {
  const plan = buildPlan(baseRecord(), progressive, {});
  const q36 = byQ(plan, '36');
  assert.equal(q36.value, 'For Hire Trucking');
  assert.deepEqual(q36.choiceAliases, ['General Freight Trucking']);
  assert.equal(byQ(plan, '24D').ignore, true, 'the search box itself is not typed into');
  assert.equal(byQ(plan, '1D').ignore, true);
  assert.equal(byQ(plan, 'AA').value, true, 'coverage not on the intake = None of the above');
  assert.equal(byQ(plan, 'B2').value, true);
  assert.equal(byQ(plan, 'A8').value, false);
  const search = plan.find((s) => s.action === 'businessTypeSearch');
  assert.equal(search.near, 'business type');
  assert.equal(progressive.vehicleList, 'VehicleSummary');
  assert.ok(new RegExp(plan.find((s) => s.action === 'addVehicle:0').text, 'i').test('Add another'));
});

test('Pennsylvania coverages, NoHit owner page, cargo without a deductible', () => {
  const record = baseRecord();
  record.coverage.cargo = true;
  record.coverage.cargoLimit = 100000;
  record.coverage.cargoDeductible = null;
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '216F').value, '$100000/$1000', 'standard $1,000 cargo deductible');
  assert.equal(byQ(plan, '216F').note, null);
  for (const q of ['1DCA', '1DDE', '1DD8']) assert.equal(byQ(plan, q).value, '$100k CSL');
  assert.equal(byQ(plan, '1E66').value, '$5,000');
  for (const q of ['1E69', '1E6E', '1E71', '1E74']) assert.equal(byQ(plan, q).value, 'Not Selected');
  assert.ok(byQ(plan, '1B8D').note, 'SSN is never filled');
  assert.equal(byQ(plan, '1B8D').value, null);
  assert.ok(progressive.optional.includes('1B80'));
});
