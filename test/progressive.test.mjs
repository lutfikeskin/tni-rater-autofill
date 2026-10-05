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
  assert.ok(byQ(plan, '1B8D').note, 'SSN is never filled');
  assert.equal(byQ(plan, '1B8D').value, null);
  assert.ok(progressive.optional.includes('1B80'));
});

test('a vehicle value that is not a dollar amount goes to the agent instead of being typed', () => {
  const record = baseRecord();
  record.vehicles[0].value = 'about 40k';
  const plan = buildPlan(record, progressive, {});
  for (const q of ['2CE8', '2091']) {
    assert.equal(byQ(plan, q).value, null);
    assert.match(byQ(plan, q).note, /about 40k/);
  }
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
  for (const label of ['Exclude Medical Payments', 'Exclude Uninsured Motorists', 'Exclude Comprehensive Coverage', 'Exclude Collision Coverage',
    'Exlucde Transportation Expense/ Rental Reimbursement', 'Exlude Towing & Labor']) {
    assert.equal(exclusions.filter((s) => new RegExp(s.re, 'i').test(label)).length, 1, label);
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
  for (const q of ['1FCD', '1FD2', '1FE4', '1FF2', '1FF9', '2000', '200F', '207F', '208A', '2091', '2007']) {
    assert.equal(steps(q).length, 3, `q${q}: one step per vehicle`);
    assert.deepEqual(steps(q).map((step) => step.activeVehicle), [false, false, true]);
  }
  assert.deepEqual(steps('1FF2').map((step) => step.value), Array(3).fill('$40 per day, $1,200 max'));
  assert.deepEqual(steps('1FF9').map((step) => step.value), Array(3).fill('Not selected'));
  assert.deepEqual(steps('2091').map((step) => [step.path, step.value]), [['vehicles[0].value', 31000], ['vehicles[1].value', 17000], ['vehicles[2].value', 22000]]);
  assert.deepEqual(steps('2091').map((step) => step.vehicleHint), [['2025', 'ram', 'promaster 2500'], ['2019', 'mercedes benz', 'sprinter'], ['2016', 'freightliner', 'cascadia']]);
  // One vehicle: one step, no row matching, as before.
  assert.equal(buildPlan(baseRecord(), progressive, {}).filter((step) => step.q === '2091').length, 1);
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
  assert.ok(ids(record).indexOf('addNtl') < ids(record).indexOf('openCargo'), 'before cargo');
  assert.ok(!ids(record).includes('billPlan'), 'the bill plan is the agent\'s');
  for (const id of ['recalculate', 'print']) {
    const step = plan.find((s) => s.action === id);
    assert.deepEqual(step.afterActions, [], `${id}: no bill plan of ours to wait for`);
    assert.deepEqual(step.after, [], `${id}: NTL may replace the liability limit`);
    assert.deepEqual(step.afterPages, ['ChangePaymentPlan'], `${id}: only after the agent opened the bill plan`);
  }
  assert.match(progressive.agentPages.CoveragesRates(record), /Answer that section yourself, then open the bill plan/);
  // GL without NTL is unchanged: no bill plan of ours, the liability check stays.
  const gl = baseRecord();
  gl.coverage.gl = true;
  assert.deepEqual(actions(gl).find((s) => s.action === 'print').after, ['coverage.autoLiabLimit']);
  assert.ok(ids(baseRecord()).includes('billPlan'), 'and a plain quote keeps our bill plan');
});
