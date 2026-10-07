import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { progressive, owner } from '../src/carriers/progressive.js';

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

test('refrigeration breakdown is requested only when the intake selects Reefer', () => {
  const record = baseRecord();
  for (const selected of [true, false, null, undefined]) {
    record.coverage.reeferBreakdown = selected;
    const step = byQ(buildPlan(record, progressive), '215C');
    assert.equal(step.value, selected === true);
    assert.equal(step.path, 'coverage.reeferBreakdown');
    assert.equal(step.note, null);
  }
});

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
  assert.equal(byQ(plan, '2CE3').value, true, 'no equipment (Add Vehicle and Rates: one field)');
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
  for (const q of ['18F', '194', '1CC', '77', '2DB', '2DD', '2DF', '2B00', '1E7C', '3E96', '3E97', '3EA4', '32CE']) {
    assert.equal(byQ(plan, q).ignore, true, `q${q} is preserved`);
  }
  // Email and Fax are unticked (TNI), so the agent's Print/Send only opens the PDF (Codex on PR #43).
  for (const q of ['32D0', '32DD']) assert.deepEqual([byQ(plan, q).ignore, byQ(plan, q).value], [false, false], q);
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
  assert.deepEqual(recalc.afterActions, ['billPlan']);
  assert.deepEqual(recalc.afterPages, ['ChangePaymentPlan']);
  assert.equal(recalc.verify, 'premium');
  assert.equal(bill.needsPremium, false);
  assert.deepEqual(bill.afterActions, ['doneCargo']);
  assert.ok(new RegExp(bill.text, 'i').test('Billing Options'));
  // Back from the bill plan, Recalculate only when the rates are stale; Print doesn't wait for it.
  assert.equal(recalc.needsRecalculation, true);
  const print = actions.find((step) => step.action === 'print');
  assert.deepEqual(print.afterActions, ['billPlan'], 'Print follows our bill plan; it does not wait for Recalculate');
  assert.deepEqual(print.afterPages, ['ChangePaymentPlan']);
  const addDriver = actions.find((step) => step.action === 'addDriver:0');
  assert.deepEqual(addDriver.unlessActions, ['driverEntered:0']);
  assert.equal(progressive.driverList, 'DriverSummary');
  assert.ok(progressive.agentPages.NoHit);
  const gl = structuredClone(record);
  gl.coverage.gl = true;
  assert.ok(!buildPlan(gl, progressive, {}).some((step) => step.action === 'billPlan'), 'with GL the agent does the rates page');
  assert.ok(bill.afterAny.includes('progressive.q216F'));
  const multi = structuredClone(record);
  multi.vehicles.push({ type: 'Van', year: 2021, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 40000 });
  const comprehensive = buildPlan(multi, progressive, { vehicles: 1 }).filter((step) => step.q === '1FCD');
  assert.equal(comprehensive.length, 2, 'every vehicle row on Rates gets its own step');
  assert.deepEqual(comprehensive.find((step) => step.activeVehicle).vehicleHint, ['2021', 'ford', 'transit']);
  assert.ok(comprehensive.every((step) => step.note === null));
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
  assert.equal(byQ(plan, '1FE4').value, '$5,000 per person');
  for (const q of ['1E69', '1E6E', '1E71', '1E74']) assert.equal(byQ(plan, q).value, 'Not Selected');
  assert.equal(byQ(plan, '1B8D').ignore, true, 'SSN: never filled, and not a "needs you" item (TNI 2026-10-07)');
  assert.ok(progressive.advance.exceptPages.includes('NoHit'), 'NoHit is the agent\'s: never continued automatically');
  assert.equal(byQ(plan, '1B8D').value, null);
  assert.equal(byQ(plan, '1B80').optional, true, 'NoHit middle initial is never "needs you"');
  // FL run 2026-10-07: Progressive's home address line has no suite; street + suite read as a
  // different address on every quote with one.
  record.garaging = { ...record.garaging, street: '100 Example Way', unit: 'Suite 4' };
  assert.equal(byQ(buildPlan(record, progressive, {}), '1B84').value, '100 Example Way');
});

test('a vehicle value that is not a dollar amount goes to the agent instead of being typed', () => {
  const record = baseRecord();
  record.vehicles[0].value = 'about 40k';
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '2CE8').value, null);
  assert.match(byQ(plan, '2CE8').note, /about 40k/);
  record.vehicles[0].value = 40000;
  assert.equal(byQ(buildPlan(record, progressive, {}), '2CE8').value, 40000);
});

test('AmWINS rules: fields by id, standard answers, declaration left to the agent', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  const record = baseRecord();
  record.applicant.name = 'Sample Expedite LLC';
  record.applicant.yearsInBusiness = 3;
  record.operations.radius = 'Unlimited';
  record.operations.radiusMiles = null;
  const plan = buildPlan(record, amwins, {});
  const bySel = (sel) => plan.find((s) => s.selector === sel);
  const byName = (re) => plan.find((s) => re.test(s.name ?? ''));
  assert.equal(bySel('#entityType').value, 'LLC');
  assert.equal(bySel('#yrsInBusiness').value, '3');
  assert.equal(bySel('#natureOfBusiness').value, 'TRANSPORTATION');
  assert.equal(bySel('#phone').ignore, true, "Agency Information: the agency's phone, not the client's");
  assert.equal(bySel('#contactName').ignore, true);
  assert.equal(bySel('#email').ignore, true);
  assert.equal(byName(/^Radius$/).value, 501, 'Unlimited picks the top band (201 + MILES)');
  assert.equal(byName(/^Usage type/).value, 'FOR HIRE');
  assert.equal(byName(/^Rental/).value, '$40 day / $1,200 total');
  assert.ok(byName(/^Declaration$/).note, 'never filled');
  record.vehicles.push({ vin: '1FTBR3X87MKA12345' });
  assert.match(buildPlan(record, amwins, {}).find((s) => s.selector === '#vehLookupVin').value, /1FTBR3X87MKA12345$/);
});

test('AmWINS second-quote rules: owner from a first-name-only box, years under authority, disclosure text', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  const record = baseRecord();
  record.applicant.name = null;
  record.applicant.owner1 = 'IBRAHIM';
  record.applicant.yearsInBusiness = null;
  record.applicant.yearsExperience = 7;
  record.applicant.yearEstablished = null;
  record.drivers = [{ first: 'IBRAHIM A', last: 'ALHARAZ', dob: '01/01/1968' }];
  record.operations.businessClass = 'Expediter';
  record.operations.whatHaul = 'General freight hauler';
  record.operations.radius = 'Unlimited';
  record.operations.radiusMiles = null;
  record.coverage = { ...record.coverage, cargo: true, cargoLimit: 100000, cargoDeductible: 1000 };
  record.priorInsurance = [{ type: 'Commercial Auto', carrier: 'PROGRESSIVE', limit: '$1M CSL', expiration: '12/01/2026' }];
  const plan = buildPlan(record, amwins, {});
  const sel = (s) => plan.find((x) => x.selector === s);
  const named = (re) => plan.find((x) => re.test(x.name ?? ''));
  assert.equal(sel('#name').value, 'IBRAHIM ALHARAZ', 'no company: the owner, full name from the driver row');
  assert.equal(sel('#ownerName').value, 'IBRAHIM ALHARAZ');
  assert.equal(sel('#ownerDob').value, '01/01/1968');
  assert.equal(sel('#yrsInBusiness').value, '5+', 'years under own authority 7');
  assert.equal(sel('#yearBusinessEstablished').value, new Date().getFullYear());
  assert.equal(sel('#classCodeAndDescription').kind, 'search-select');
  assert.equal(sel('#classCodeAndDescription').search, '484122');
  const prior = plan.filter((x) => /^Prior carrier/.test(x.name));
  assert.equal(prior.length, 6, 'every year panel and extra coverage rows');
  for (const step of prior) {
    assert.equal(step.selector, '#priorCarrierPanel .coveragePanel [data-id="carrierName"]', 'any numbering, not the hidden template');
    assert.equal(step.value, 'NO PRIOR');
    assert.equal(step.hidden, true, 'collapsed year panels are filled too');
  }
  assert.equal(named(/^Year licensed/).value, '1985');
  assert.equal(named(/^Disclosure/).value, 'Motor Truck Cargo $100K with $1K Ded - Consumer Goods / Other Consumer Goods\nMore than 500 miles radius of operation\nPOP Commercial - Progressive - $1M CSL - Exp Date 12/01/2026');
  assert.equal(sel('#autoSymbol6').value, true);
  assert.equal(sel('#autoSymbol1').value, false);
  assert.equal(plan.find((x) => x.action === 'importVins').immediate, true);
});

test('AmWINS third-quote rules: contact, garage boxes, one rule per exclusion, underwriting defaults, Save & Continue, start page', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  const record = baseRecord();
  record.applicant.phone = '(402) 555-0100';
  record.vehicles = [{ type: 'Box Truck', vin: '1FTBR3X87MKA12345' }];
  const plan = buildPlan(record, amwins, {});
  const sel = (s) => plan.find((x) => x.selector === s);
  const named = (re) => plan.filter((x) => re.test(x.name ?? ''));
  assert.equal(sel('#inspectionContactOfficePhone').value, '4025550100', 'Contact Information is the client');
  assert.ok(sel('#inspectionContactName').value);
  assert.equal(named(/^Garage (street|city|state|ZIP)$/).length, 4);
  assert.equal(named(/^Garage city$/)[0].value, record.garaging.city);
  const exclusions = named(/^Exclude /);
  assert.equal(exclusions.length, 6, 'one rule per box: a rule fills one field');
  const LABELS = ['Exclude Medical Payments', 'Exclude Uninsured Motorists', 'Exclude Comprehensive Coverage', 'Exclude Collision Coverage',
    'Exlucde Transportation Expense/ Rental Reimbursement', 'Exlude Towing & Labor'];
  for (const label of LABELS) {
    assert.equal(exclusions.filter((s) => new RegExp(s.re, 'i').test(label) && !new RegExp(s.ex, 'i').test(label)).length, 1, label);
  }
  assert.ok(exclusions.every((s) => s.value === false && /^#vehicleCoveragesPanel \[data-id="\w+Exclude"\]$/.test(s.selector)), 'by data-id, not excluded');
  assert.ok(exclusions.every((s) => new RegExp(s.ex, 'i').test('Exclude Waiver of Collision')), 'the waiver box is not the collision box');
  // Three vehicles: each box once per vehicle, on that vehicle's row (the rows' 0-based data-id).
  record.vehicles = [0, 1, 2].map((n) => ({ type: 'Box Truck', vin: `1FTBR3X87MKA1234${n}` }));
  const perVehicle = buildPlan(record, amwins, {}).filter((x) => /^Exclude /.test(x.name ?? ''));
  assert.equal(perVehicle.length, 18);
  for (const row of [0, 1, 2]) {
    const mine = perVehicle.filter((s) => s.selector.startsWith(`#vehicleCoveragesPanel > .app-rp-section[data-id="${row}"] `));
    assert.equal(mine.length, 6, `vehicle ${row + 1}`);
    for (const label of LABELS) assert.equal(mine.filter((s) => new RegExp(s.re, 'i').test(label)).length, 1, `vehicle ${row + 1}: ${label}`);
  }
  assert.ok(plan.some((s) => s.re && new RegExp(s.re, 'i').test('code voilation')), 'the page spells it "voilation"');
  assert.equal(named(/^Vehicles leased/)[0].value, false, 'second section: always No');
  assert.equal(named(/^Body type/)[0].replace, true);
  assert.equal(named(/^Other topics/)[0].replace, true, 'Yes again after Default all answers to No');
  const actions = plan.filter((s) => s.kind === 'action');
  assert.ok(new RegExp(actions.find((a) => a.action === 'defaultNo').text, 'i').test('Default all answers to "No"'));
  assert.deepEqual(actions.find((a) => a.action === 'openApplication').after, ['amwins.riskState']);
  assert.ok(new RegExp(amwins.advance.text, 'i').test('Save & Continue'));
  assert.ok(!new RegExp(amwins.advance.text, 'i').test('Save & Exit'));
});

test('AmWINS standard answers from the agent: current carrier 1-2 years with a DOT only, no claim-free loss runs, PIP left alone, Married to confirm', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  const record = baseRecord();
  record.applicant.dot = '1234567';
  let plan = buildPlan(record, amwins, {});
  const sel = (s) => plan.find((x) => x.selector === s);
  const named = (re) => plan.find((x) => re.test(x.name ?? ''));
  assert.equal(sel('#howLongWithCurrentCarrier').value, '1 TO 2 YEARS');
  assert.equal(sel('#howLongWithCurrentCarrier').ignore, false);
  assert.equal(named(/^Claim-free loss runs/).value, false);
  const pip = named(/^Personal Injury Protection \(/);
  assert.equal(pip.ignore, false);
  assert.equal(pip.value, false, 'No: Medical Payments is offered');
  assert.equal(pip.replace, true, 'replaces the page pre-selected Yes');
  assert.equal(sel('#personalInjuryProtectionLimit').ignore, true);
  const marital = () => sel('#driversPanel [data-id="martialStatus"]');
  assert.equal(marital().value, record.drivers[0].maritalStatus ?? 'MARRIED');
  record.drivers[0].maritalStatus = null;
  record.applicant.dot = null;
  plan = buildPlan(record, amwins, {});
  assert.equal(marital().value, 'MARRIED');
  assert.match(marital().warn, /no marital status/);
  assert.equal(sel('#howLongWithCurrentCarrier').ignore, true, 'only asked of clients with a DOT number');
  record.drivers[0].maritalStatus = 'Single';
  plan = buildPlan(record, amwins, {});
  assert.equal(marital().value, 'Single');
  assert.equal(marital().warn, null);
});

test('Progressive FL run: new USDOT not found yet, safety equipment from the VIN lookup, PD-only and PIP not selected', () => {
  const record = baseRecord();
  record.applicant.dot = '4123456';
  record.applicant.name = null;
  record.applicant.owner1 = 'Amina Kone';
  record.garaging.state = 'FL';
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '21E').value, true, 'obtained within 60 days: Yes');
  assert.equal(byQ(plan, '21E').ignore, false);
  assert.equal(byQ(plan, '230').ignore, false, 'business name typed in even with a USDOT number');
  assert.equal(byQ(plan, '230').value, 'Amina Kone', 'no company: the owner');
  for (const q of ['2BA1', '2BAC', '2BAE']) {
    assert.equal(byQ(plan, q).ignore, true, q);
    assert.match(byQ(plan, q).emptyNote, /VIN lookup/);
  }
  assert.equal(byQ(plan, '1DB8').value, 'Not Selected');
  assert.equal(byQ(plan, '1E8D').value, '$10k w/ $0 Deductible');
  assert.equal(byQ(plan, '1E8D').ignore, false);
  // TX 2026-10-07: PIP shares its data-model name across states; TX's list has other amounts and
  // TNI has no standard there: left as Progressive set it.
  for (const state of ['TX', 'MD']) {
    const other = byQ(buildPlan({ ...record, garaging: { ...record.garaging, state } }, progressive, {}), '1E8D');
    assert.deepEqual([other.value, other.ignore], [null, true], state);
    assert.match(other.emptyNote, /Florida only/, `${state}: an empty PIP goes to the agent`);
  }
  assert.equal(byQ(plan, '1E8D').emptyNote, null);
  record.applicant.dot = null;
  assert.equal(byQ(buildPlan(record, progressive, {}), '21E').ignore, true);
});

test('Progressive NJ run: vehicle registrant, VIN-lookup safety boxes kept, Rates loan/lease carried over, rates helpers wait for the liability limit', () => {
  const plan = buildPlan(baseRecord(), progressive, {});
  assert.equal(byQ(plan, '2C97').value, 'Named insured');
  for (const q of ['2C2C', '2C2D', '2C2E', '2C45', '2C46', '2C47', '2C48']) assert.equal(byQ(plan, q).ignore, true, q);
  assert.equal(byQ(plan, '2007').ignore, true);
  assert.match(byQ(plan, '2007').emptyNote, /carry over/, 'an empty carryover goes to the agent');
  // The bill plan waits for the liability limit; Recalculate and Print follow the bill plan and
  // don't re-check the limit on the reloaded Rates page (FL/NJ runs).
  assert.deepEqual(plan.find((s) => s.action === 'billPlan').after, ['coverage.autoLiabLimit']);
  for (const id of ['recalculate', 'print']) {
    const step = plan.find((s) => s.action === id);
    assert.deepEqual(step.after, [], id);
    assert.deepEqual(step.afterActions, ['billPlan'], `${id} needs our bill plan click`);
  }
  const gl = structuredClone(baseRecord());
  gl.coverage.gl = true;
  assert.deepEqual(buildPlan(gl, progressive, {}).find((s) => s.action === 'print').after, ['coverage.autoLiabLimit'], 'with GL (no bill plan of ours) the limit check stays');
  assert.deepEqual(plan.find((s) => s.action === 'recalculate').afterPages, ['ChangePaymentPlan']);
});

test('the owner with a two-word surname is matched to their driver row (date of birth)', () => {
  const record = baseRecord();
  record.applicant.owner1 = 'Sample Vinicius Testa Examplo';
  record.drivers = [{ first: 'Sample Vinicius', middle: null, last: 'Testa Examplo', dob: '01/02/1980' }];
  assert.equal(owner(record).driver?.dob, '01/02/1980');
  record.applicant.owner1 = 'Sample Examplo';
  assert.equal(owner(record).driver?.dob, '01/02/1980', 'surname word matches the last-name box');
  record.applicant.owner1 = 'Alice Smith';
  record.drivers = [{ first: 'Bob', middle: null, last: 'Jones Smith', dob: '01/02/1980' }];
  assert.equal(owner(record).driver, null, 'a shared surname word with another first name is someone else');
  record.drivers = [{ first: 'Bob', middle: null, last: 'Smith', dob: '01/02/1980' }];
  assert.equal(owner(record).driver?.dob, '01/02/1980', 'the same one-word surname, as before');
});

// 2026-10-05 FL run: two vans and a Semi Truck.
test('vehicle tiles follow the intake type; unmapped types and a Reefer outside a Reefer business go to the agent', () => {
  const tile = (type, businessClass = 'Expediter') => {
    const record = baseRecord();
    record.vehicles[0].type = type;
    record.operations.businessClass = businessClass;
    return buildPlan(record, progressive, {}).find((step) => step.action === 'vehicleTile:0');
  };
  assert.equal(tile('Van').text, '^Cargo Van$');
  assert.equal(tile('Semi Truck').text, '^Truck Tractor$');
  assert.equal(tile('Flatbed').text, '^Flatbed Truck$');
  assert.equal(tile('Box Truck').text, '^Box Truck$');
  assert.ok(tile('Semi Truck').unique, 'two matching tiles are never guessed between');
  const reefer = tile('Reefer Truck', 'Reefer');
  assert.ok(new RegExp(reefer.text, 'i').test('Refrigerated Truck'));
  assert.ok(new RegExp(reefer.text, 'i').test('Reefer'));
  assert.equal(tile('Reefer Truck', 'Expediter').text, null, 'Reefer needs the Reefer business class too');
  assert.match(tile('Reefer Truck', 'Expediter').missing, /business class is not Reefer/);
  for (const type of ['Tanker', 'Dump Truck', 'Other']) {
    assert.equal(tile(type).text, null, `${type} is the agent's to pick`);
    assert.match(tile(type).missing, /pick the vehicle yourself/);
  }
  assert.match(tile('Semi Truck').missing, /No tile on this page matches the intake's Semi Truck/);
  // Continue is remembered per vehicle on these pages, per driver on the driver page.
  assert.deepEqual(progressive.vehiclePages, ['MostCommonVehicles', 'AddVehicle']);
  assert.equal(progressive.driverPage, 'AddDriver');
});

test('every vehicle on Rates gets the standard per-vehicle coverages; Rental with downtime is Not selected', () => {
  const record = baseRecord();
  record.vehicles = [
    { type: 'Van', year: 2025, make: 'RAM', model: 'ProMaster 2500', vin: 'SYNTHETICVIN00001', value: 31000 },
    { type: 'Van', year: 2019, make: 'MERCEDES-BENZ', model: 'Sprinter', vin: 'SYNTHETICVIN00002', value: 17000 },
    { type: 'Semi Truck', year: 2016, make: 'FREIGHTLINER', model: 'Cascadia', vin: 'SYNTHETICVIN00003', value: 22000 },
  ];
  const plan = buildPlan(record, progressive, { vehicles: 2 });
  const steps = (q) => plan.filter((step) => step.q === q);
  for (const q of ['1FCD', '1FD2', '1FE4', '1FF2', '1FF9', '2000', '200F', '2CCE', '2CE3', '2CE8', '2007']) {
    assert.equal(steps(q).length, 3, `q${q}: one step per vehicle`);
    assert.deepEqual(steps(q).map((step) => step.activeVehicle), [false, false, true]);
  }
  assert.deepEqual(steps('1FF2').map((step) => step.value), Array(3).fill('$40 per day, $1,200 max'));
  assert.deepEqual(steps('1FF9').map((step) => step.value), Array(3).fill('Not selected'));
  assert.deepEqual(steps('2CE8').map((step) => [step.path, step.value]), [['vehicles[0].value', 31000], ['vehicles[1].value', 17000], ['vehicles[2].value', 22000]]);
  assert.deepEqual(steps('2CE8').map((step) => step.vehicleHint), [['2025', 'ram', 'promaster 2500'], ['2019', 'mercedes benz', 'sprinter'], ['2016', 'freightliner', 'cascadia']]);
  // One vehicle: one step, no row matching, as before.
  assert.equal(buildPlan(baseRecord(), progressive, {}).filter((step) => step.q === '2CE8').length, 1);
});

// PR #17 review: NTL is added only once the agent set it, the click is verified, and the bill
// plan, Recalculate and Print wait for the agent (who answers the NTL section first).
test('an NTL quote: Add Non-Trucking Liability once the agent set it, verified, then Rates is the agent\'s', () => {
  const record = baseRecord();
  const actions = (r) => buildPlan(r, progressive, {}).filter((s) => s.kind === 'action');
  const ids = (r) => actions(r).map((s) => s.action);
  assert.ok(!ids(record).includes('addNtl'), 'not without NTL');
  assert.equal(progressive.agentPages.CoveragesRates(record), null);
  record.coverage.ntl = null;
  assert.ok(!ids(record).includes('addNtl'), 'not while unresolved (a claims-box mention only)');
  record.coverage.ntl = true;
  const plan = actions(record);
  const ntl = plan.find((s) => s.action === 'addNtl');
  assert.deepEqual(ntl.pages, ['CoveragesRates']);
  assert.equal(ntl.verify, 'gone', 'done only when the link is gone afterwards');
  assert.ok(new RegExp(ntl.text, 'i').test('Add Non-Trucking Liability instead?'));
  assert.ok(!new RegExp(ntl.text, 'i').test('Help Text For Non-Trucking Liability'));
  // Codex on PR #22: cargo helpers are the agent's too once NTL is on, and NTL added then set back
  // to No stays a "needs you" item (the filler never removes it).
  assert.ok(!ids(record).some((id) => /Cargo/.test(id)), 'no cargo helpers with NTL');
  assert.ok(!ids(record).includes('ntlStillAdded'));
  const no = structuredClone(record);
  no.coverage.ntl = false;
  const kept = actions(no).find((s) => s.action === 'ntlStillAdded');
  assert.deepEqual([kept.text, kept.afterActions, kept.label], [null, ['addNtl'], 'Non-trucking liability']);
  assert.match(kept.missing, /remove it on this page yourself/);
  assert.ok(new RegExp(kept.resolvedBy, 'i').test('Add Non-Trucking Liability instead?'), 'settled when the page offers Add NTL again');
  for (const id of ['openCargo', 'addCargoCommodity', 'doneCargo', 'billPlan', 'recalculate', 'print']) {
    assert.deepEqual(actions(no).find((s) => s.action === id).heldBy, ['ntlStillAdded'], `${id} waits while NTL is still on the quote`);
  }
  // Codex on PR #22: an earlier bill plan visit must not let Recalculate or Print run while the
  // new NTL questions are open. Until the section has been seen live, the whole page is the agent's.
  for (const id of ['billPlan', 'recalculate', 'print']) assert.ok(!ids(record).includes(id), `${id} is the agent's`);
  // Print/Send is always the agent's click (Chrome opens the PDF only for it); the panel says so.
  assert.ok(!ids(record).includes('printSend'));
  assert.match(progressive.agentPages.PrintEmailFax, /Click Print\/Send yourself/);
  assert.ok(progressive.advance.exceptPages.includes('PrintEmailFax'), 'never continued past the Print page');
  assert.match(progressive.agentPages.CoveragesRates(record), /The rest of this page is yours: answer that section, then cargo, the bill plan, Recalculate and Print/);
  // GL without NTL is unchanged: no bill plan of ours, the liability check stays.
  const gl = baseRecord();
  gl.coverage.gl = true;
  assert.deepEqual(actions(gl).find((s) => s.action === 'print').after, ['coverage.autoLiabLimit']);
  assert.ok(ids(baseRecord()).includes('billPlan'), 'and a plain quote keeps our bill plan');
});

// Codex on PR #22: an NTL mention not answered yet is not a No, and an NTL quote's Rates page is
// never continued for the agent.
test('Rates waits for an unanswered NTL mention, and an NTL quote keeps Continue for the agent', () => {
  const record = baseRecord();
  const ids = (r) => buildPlan(r, progressive, {}).filter((s) => s.kind === 'action').map((s) => s.action);
  const step = (r, id) => buildPlan(r, progressive, {}).find((s) => s.action === id);
  record.claims = { text: 'No\nAsked about bobtail' };
  record.coverage.ntl = null;
  for (const id of ['openCargo', 'billPlan', 'recalculate', 'print']) assert.ok(!ids(record).includes(id), `${id} waits for the agent's NTL answer`);
  assert.match(step(record, 'ntlDecide').missing, /set it to Yes or No/);
  assert.equal(step(record, 'ntlDecide').text, null, 'never clicked');
  record.coverage.ntl = false;
  assert.ok(ids(record).includes('billPlan') && !ids(record).includes('ntlDecide'), 'an explicit No is a normal quote');
  record.coverage.ntl = true;
  assert.match(step(record, 'ntlRates').missing, /Continue yourself/, 'a needs-you item: Rates is never continued for the agent');
  assert.ok(!ids(record).includes('ntlDecide'));
  const plain = baseRecord();
  assert.ok(!ids(plain).includes('ntlDecide') && !ids(plain).includes('ntlRates'), 'no mention, no NTL: nothing');
  // Codex on PR #22: Luna's NTL flag for a line the words miss ("bobtale") holds Rates the same way.
  const flagged = baseRecord();
  flagged.claims = { text: 'No\nNeeds bobtale coverage', aiNtl: true };
  flagged.coverage.ntl = null;
  assert.ok(ids(flagged).includes('ntlDecide') && !ids(flagged).includes('billPlan'));
  flagged.coverage.ntl = false;
  assert.ok(!ids(flagged).includes('ntlDecide') && ids(flagged).includes('billPlan'), 'answered No: a normal quote');
});

test('DeclinationNotice is a stop page: the agent is told the client already has Progressive commercial auto', () => {
  const note = progressive.stopPages?.DeclinationNotice;
  assert.match(note, /already has a commercial auto policy with Progressive/);
  assert.match(note, /stops here/);
  // Only that page: the quote pages around it are filled as before.
  assert.deepEqual(Object.keys(progressive.stopPages), ['DeclinationNotice']);
  assert.ok(!progressive.actions.some((a) => [].concat(a.page ?? []).includes('DeclinationNotice')), 'no helper button belongs to it');
});

// TN live run, 2026-10-07: the first intake trailer (a flatbed), added by hand after Vehicle
// Summary's Continue left it out. TNI's trailer answers (2026-10-07).
const trailerRecord = () => ({
  ...baseRecord(),
  garaging: { street: '1 Test Way', unit: null, city: 'Testville', state: 'TN', zip: '37000' },
  operations: { ...baseRecord().operations, businessClass: 'Freight Hauler', radius: 'Unlimited', radiusMiles: null },
  vehicles: [{ type: 'Semi Truck', year: 2013, make: 'PETERBILT', model: '388', vin: '1XPWD40X1DD000001', value: 60000 }],
  trailers: [{ type: 'Flatbed', year: 2019, make: 'WILSON', model: null, vin: '1W1MAFZB0KA000002', value: 45000 }],
  trailerInfo: { ownership: 'Financed' },
});

test('trailers: Add Trailer once the vehicles are in, its tile, its page, and its own row on Rates', () => {
  const record = trailerRecord();
  const plan = buildPlan(record, progressive, { trailers: 0 });
  const add = plan.find((s) => s.action === 'addTrailer:0');
  assert.ok(add && new RegExp(add.text, 'i').test('Add Trailer'));
  assert.deepEqual([add.afterActions, add.unlessActions, add.opener], [['lookupVin:0'], ['trailerEntered:0'], '^add$']);
  assert.match(add.missing, /Add Trailer/, 'Continue never leaves the trailer out silently');
  assert.ok(new RegExp(plan.find((s) => s.action === 'trailerTile:0').text).test('Flatbed Trailer'));
  // Types without a known tile are the agent's to pick.
  record.trailers[0].type = 'Lowboy';
  const lowboy = buildPlan(record, progressive, { trailers: 0 }).find((s) => s.action === 'trailerTile:0');
  assert.equal(lowboy.text, null);
  assert.match(lowboy.missing, /Lowboy/);
  record.trailers[0].type = 'Flatbed';
  // Add Trailer: the trailer's answers, found on that page only; the vehicle's never there.
  const step = (q) => plan.find((s) => s.q === q);
  assert.deepEqual(['2A29', '2A2A', '2A2B', '2A65', '2AD0', '2AEE', '2AFF', '2B04'].map((q) => step(q).value),
    ['1W1MAFZB0KA000002', 2019, 'WILSON', 501, 'Yes - Loan', true, true, 45000]);
  assert.ok(['2A29', '2B04'].every((q) => step(q).pageOnly && step(q).pages.includes('AddTrailer')));
  assert.ok(step('2B20').notPages.includes('AddTrailer'), "the vehicle's VIN is never looked for on the trailer page");
  assert.ok(plan.find((s) => s.path === 'vehicles[0].vin' && s.re).notPages.includes('AddTrailer'));
  // Codex on PR #43: an equipment value on the intake is entered, not "no equipment".
  assert.deepEqual([step('2AFF').value, step('2AFC').ignore, step('TR2CE3').value], [true, true, true], 'none on the intake: no equipment');
  const equipped = buildPlan({ ...record, trailerInfo: { ...record.trailerInfo, equipTrailer: 3500 } }, progressive, { trailers: 0 });
  assert.deepEqual(['2AFF', '2AFC', 'TR2CE3'].map((q) => equipped.find((s) => s.q === q).value), [false, 3500, false]);
  assert.equal(equipped.find((s) => s.q === '2AFC').ignore, false);
  const done = plan.find((s) => s.action === 'addTrailer:0');
  assert.deepEqual(done.doneWhen, ['trailerEntered:0']);
  assert.match(done.unfinished, /never entered/);
  // No trailer ownership on the intake: owned (TNI). One that is none of owned/financed/leased
  // (Rented) is the agent's (Codex on PR #43).
  assert.equal(byQ(buildPlan({ ...record, trailerInfo: {} }, progressive, { trailers: 0 }), '2AD0').value, 'No');
  assert.equal(byQ(buildPlan({ ...record, trailerInfo: { ownership: 'Owned' } }, progressive, { trailers: 0 }), '2AD0').value, 'No');
  assert.equal(byQ(buildPlan({ ...record, trailerInfo: { ownership: 'Leased' } }, progressive, { trailers: 0 }), '2AD0').value, 'Yes - Lease');
  const rented = byQ(buildPlan({ ...record, trailerInfo: { ownership: 'Rented' } }, progressive, { trailers: 0 }), '2AD0');
  assert.equal(rented.value, null);
  assert.match(rented.note, /Rented/);
  // Rates: the trailer's row by its year and make; the vehicle's by its own (a row each).
  assert.deepEqual([step('TR1FCD').value, step('TR1FF2').value, step('TR200F').value], ['$1,000 Deductible', 'Not selected', 'Not selected']);
  assert.deepEqual(step('TR1FF2').vehicleHint, ['2019', 'wilson']);
  assert.deepEqual(plan.find((s) => s.q === '1FF2').vehicleHint, ['2013', 'peterbilt', '388']);
  // Without trailers: none of it.
  const none = buildPlan({ ...record, trailers: [] }, progressive, {});
  assert.ok(!none.some((s) => /^(addTrailer|trailerTile):/.test(s.action ?? '') || /^TR/.test(s.q ?? '')));
  assert.equal(none.find((s) => s.q === '1FF2').vehicleHint, null, 'one vehicle, no trailer: its row needs no name');
});

// TNI 2026-10-07: "Defensive driver ... default answer no, AI can check the Description box of the
// intake for that". A course mentioned there is the agent's (Codex on PR #43: not a silent No).
test('defensive driver discount: No, unless the description box mentions a course', () => {
  const record = baseRecord();
  assert.deepEqual([byQ(buildPlan(record, progressive, {}), '299D').value, byQ(buildPlan(record, progressive, {}), '299D').note], [false, null]);
  record.claims = { ...record.claims, notes: 'No accidents. Driver completed a defensive driving course in 2025.' };
  const step = byQ(buildPlan(record, progressive, {}), '299D');
  assert.equal(step.value, null);
  assert.match(step.note, /defensive driving course/);
});
