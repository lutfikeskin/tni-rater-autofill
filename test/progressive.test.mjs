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
  // Continuous coverage: the agent's when not currently insured; Yes when insured (TNI 2026-10-10).
  assert.equal(byQ(plan, '83').value, null);
  assert.match(byQ(plan, '83').note, /continuous coverage/i);
  for (const q of ['95', '9D']) assert.equal(byQ(plan, q).ignore, true);
  record.priorInsurance[0].limit = '$500k CSL';
  record.priorInsurance[0].expiration = '10/31/2026';
  assert.equal(byQ(buildPlan(record, progressive), '81').value, true);
  assert.equal(byQ(buildPlan(record, progressive), '83').value, true);
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

test('Progressive standard answers: USDOT belongs to the business is TNI\'s standard Yes, filings, MCS-90 left to the page', () => {
  const record = baseRecord();
  record.applicant.dot = '1234567';
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '2C1A').value, true, 'for-hire: an expediter hauls for hire');
  assert.equal(byQ(plan, '29F').value, true, 'owner-as-driver follows the intake');
  assert.equal(byQ(plan, '2A5').kind, 'first-option', 'home address: always the first choice');
  assert.equal(byQ(plan, '2CE3').value, true, 'no equipment (Add Vehicle and Rates: one field)');
  assert.equal(byQ(plan, '1FDD').value, 'Not selected', 'UMPD');
  // TNI 2026-10-20: Yes, a standard (the agent's from 2026-10-09); the lookup's registered names are
  // still compared (businessNames), so a different registered name stays the agent's.
  assert.equal(byQ(plan, '20F').value, true);
  assert.equal(byQ(plan, '20F').standard, true);
  assert.equal(byQ(plan, '20F').manualOnly, false);
  assert.deepEqual(byQ(plan, '20F').businessNames, ['Synthetic Expediter LLC']);
  assert.equal(byQ(plan, '20F').keepChoice, true, 'never pre-selected by Progressive: an answer there is a person\'s');
  // No business or owner name on the intake: nothing to check the USDOT record against, so the
  // agent attests it (not a standard left unfilled).
  const nameless = baseRecord();
  Object.assign(nameless.applicant, { dot: '1234567', name: null, owner1: null });
  const unchecked = byQ(buildPlan(nameless, progressive, {}), '20F');
  assert.equal(unchecked.value, null);
  assert.equal(unchecked.source, 'attestation');
  assert.equal(unchecked.standard, false);
  assert.equal(unchecked.manualOnly, true);
  assert.match(unchecked.note, /no business or owner name/);
  assert.equal(byQ(plan, 'F11').value, true);
  assert.equal(byQ(plan, 'F11').standard, true, 'kept as TNI\'s 2026-10-01 decision, marked standard');
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
  assert.ok(byQ(plan, '1FCD').standard && byQ(plan, '1FD2').standard, 'the intake has no deductible field: a standard');
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
  // GL asked for on the intake (TNI 2026-10-20, after an AR run recorded its section): once cargo
  // is done, "+" in its row opens it, its questions and limit fill, its Done closes it, then the
  // bill plan; Recalculate and Print follow our bill plan as on any quote.
  const gl = structuredClone(record);
  gl.coverage.gl = true;
  const glPlan = buildPlan(gl, progressive, {});
  const glActions = glPlan.filter((step) => step.kind === 'action');
  const order = glActions.map((s) => s.action);
  assert.ok(order.indexOf('doneCargo') < order.indexOf('openGl') && order.indexOf('openGl') < order.indexOf('doneGl') && order.indexOf('doneGl') < order.indexOf('billPlan'));
  const openGl = glActions.find((s) => s.action === 'openGl');
  assert.deepEqual([openGl.text, openGl.near, openGl.afterActions, openGl.unless, openGl.label], ['^\+$', 'general liability', ['doneCargo'], ['progressive.q21D1'], 'General liability']);
  const doneGl = glActions.find((s) => s.action === 'doneGl');
  assert.deepEqual([doneGl.afterActions, doneGl.after, doneGl.verify, doneGl.waitRequired], [['openGl'], ['progressive.q21D1'], 'glClosed', true]);
  assert.ok(new RegExp(doneGl.text, 'i').test('Done with this coverage'));
  assert.deepEqual(glActions.find((s) => s.action === 'billPlan').afterActions, ['doneCargo', 'doneGl']);
  for (const id of ['recalculate', 'print']) assert.deepEqual(glActions.find((s) => s.action === id).afterActions, ['billPlan'], `${id} follows our bill plan`);
  assert.ok(!glActions.some((s) => s.action === 'glRates'), 'no "needs you" item any more');
  // GL without cargo: "+" waits for nothing.
  const glOnly = structuredClone(gl);
  glOnly.coverage.cargo = false;
  assert.deepEqual(buildPlan(glOnly, progressive, {}).find((s) => s.action === 'openGl').afterActions, []);
  // TNI's standards for its section, matched by data-model name.
  const glField = (plan, ref) => plan.find((s) => s.field === ref);
  for (const [ref, value] of [['GeneralLiabilityInput.GeneralLiabilityTruckIncome', true], ['GeneralLiabilityInput.GeneralLiabilityTruckOtherPremises', false],
    ['GeneralLiabilityInput.GeneralLiabilityTruckSetup', false], ['GeneralLiabilityInput.GeneralLiabilityTruckOilAndGas', false], ['GeneralLiabilityInput.GeneralLiabilityTruckOtherBusiness', false]]) {
    const step = glField(glPlan, ref);
    assert.deepEqual([step.value, step.standard, step.gl, step.manualOnly], [value, true, 'section', false], ref);
  }
  // No limit on the intake: TNI's default $1M/$2M, filled and marked to confirm.
  const limit = glField(glPlan, 'LineInput.GeneralLiabilityLimit');
  assert.deepEqual([limit.path, limit.value, limit.standard, limit.gl], ['progressive.q21D1', '$1,000,000/ $2,000,000 Aggregate', true, 'limit']);
  assert.match(limit.warn, /TNI's default limit, \$1M\/\$2M .*confirm it with the client/);
  // The intake's $1M/$2M: derived, no warning; one Progressive doesn't offer: the agent's.
  gl.coverage.glLimit = '$1M/$2M';
  const asked = glField(buildPlan(gl, progressive, {}), 'LineInput.GeneralLiabilityLimit');
  assert.deepEqual([asked.value, asked.source, asked.warn], ['$1,000,000/ $2,000,000 Aggregate', 'derived', null]);
  gl.coverage.glLimit = '$500K/$1M';
  const odd = glField(buildPlan(gl, progressive, {}), 'LineInput.GeneralLiabilityLimit');
  assert.equal(odd.value, null);
  assert.match(odd.note, /\$500K\/\$1M general liability limit, which Progressive doesn't offer/);
  // Oil and gas work in what they haul: that question is the agent's.
  const oil = structuredClone(gl);
  oil.operations.whatHaul = 'Frac sand and oilfield equipment';
  const oilStep = glField(buildPlan(oil, progressive, {}), 'GeneralLiabilityInput.GeneralLiabilityTruckOilAndGas');
  assert.equal(oilStep.value, null);
  assert.match(oilStep.note, /mentions oil or gas work \("Frac sand and oilfield equipment"\)/);
  // No GL on the intake: no GL helpers, and a section the agent opened is theirs.
  assert.ok(!actions.some((s) => /Gl$/.test(s.action)), 'no GL requested: no GL helpers');
  for (const ref of ['GeneralLiabilityInput.GeneralLiabilityTruckIncome', 'LineInput.GeneralLiabilityLimit']) {
    const step = glField(plan, ref);
    assert.equal(step.value, null, ref);
    assert.match(step.note, /doesn't ask for general liability/);
  }
  // Any other General Liability question on Rates is the agent's, never the AI's.
  for (const r of [record, gl]) {
    const row = buildPlan(r, progressive, {}).find((s) => s.re === '^general liability');
    assert.deepEqual([row.source, row.manualOnly, row.value, row.ignore], ['fact', true, null, false]);
    assert.match(row.note, /isn't mapped: answer it yourself/);
  }
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
  assert.equal(byQ(buildPlan(record, progressive, {}), '20F').value, true, 'TNI\'s standard Yes (2026-10-20)');
});

test('absent DOT: No only when the intake says no USDOT within 60 days; no answer is the agent\'s', () => {
  const record = baseRecord();
  for (const pending of [null, undefined]) {
    record.applicant.mcDotWithin60Days = pending;
    assert.equal(byQ(buildPlan(record, progressive), '1ED').value, null, 'the intake doesn\'t say: not asserted (2026-10-09)');
    assert.match(byQ(buildPlan(record, progressive), '1ED').note, /60 days/);
  }
  record.applicant.mcDotWithin60Days = false;
  assert.equal(byQ(buildPlan(record, progressive), '1ED').value, 'No - and the customer will not have a USDOT number');
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
  // TNI 2026-10-10: None of the above unless the notes say the client has general liability
  // (then the agent's). GL asked for on the intake alone keeps None (TNI 2026-10-19, AR run).
  assert.deepEqual(['AA', 'B2', 'A8', 'A2'].map((q) => byQ(plan, q).value), [true, true, false, 'None']);
  const gl = baseRecord();
  gl.coverage.gl = true;
  assert.deepEqual(['AA', 'B2', 'A8', 'A2'].map((q) => byQ(buildPlan(gl, progressive, {}), q).value), [true, true, false, 'None'], 'a GL request alone');
  const has = baseRecord();
  has.coverage.hasGl = true;
  for (const q of ['AA', 'B2', 'A8', 'A2']) { const s = byQ(buildPlan(has, progressive, {}), q); assert.equal(s.value, null, q); assert.match(s.note, /general liability/); }
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
  for (const q of ['1DCA', '1DDE', '1DD8', '1DBF']) assert.equal(byQ(plan, q).value, '$100k CSL');
  // AR 2026-10-19: underinsured is offered only up to the uninsured limit, so uninsured is
  // answered first (the fill goes in plan order).
  const at = (q) => plan.findIndex((step) => step.q === q);
  assert.ok(at('1DBF') < at('1DD8') && at('1DCA') < at('1DDE'), 'uninsured before underinsured');
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
  assert.equal(sel('#yearBusinessEstablished').value, new Date().getFullYear(), 'blank on the intake: this year (TNI standard)');
  assert.equal(sel('#yearBusinessEstablished').source, 'standard');
  assert.equal(sel('#classCodeAndDescription').kind, 'search-select');
  assert.equal(sel('#classCodeAndDescription').search, '484122');
  const prior = plan.filter((x) => /^Prior carrier/.test(x.name));
  assert.equal(prior.length, 6, 'every year panel and extra coverage rows');
  for (const step of prior) {
    assert.equal(step.selector, '#priorCarrierPanel .coveragePanel [data-id="carrierName"]', 'any numbering, not the hidden template');
    assert.equal(step.value, 'NO PRIOR');
    assert.equal(step.hidden, true, 'collapsed year panels are filled too');
  }
  assert.equal(named(/^Year licensed/).value, '1985', 'TNI: birth year + 17 (2026-10-10; the agent\'s on 2026-10-09)');
  assert.equal(named(/^Year licensed/).source, 'standard');
  assert.equal(named(/^Gender/).value, 'MALE', 'TNI standard, no gender set in client details');
  assert.equal(named(/^Disclosure/).value, 'Motor Truck Cargo $100K with $1K Ded - Consumer Goods / Other Consumer Goods\nMore than 500 miles radius of operation\nPOP Commercial - Progressive - $1M CSL - Exp Date 12/01/2026');
  assert.equal(sel('#autoSymbol6').value, true);
  assert.equal(sel('#autoSymbol1').value, false);
  assert.equal(plan.find((x) => x.action === 'importVins').immediate, true);
});

// 2026-10-08 live run: AmWINS has no trailer section, and a trailer added as a vehicle row got the
// truck's body type. TNI writes each trailer in the disclosure text instead, after the radius.
test('AmWINS: each intake trailer is a line of the disclosure text, not a vehicle', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  const record = baseRecord();
  record.operations.radius = 'Unlimited';
  record.operations.radiusMiles = null;
  record.coverage = { ...record.coverage, cargo: false };
  record.priorInsurance = [{ type: 'Commercial Auto', carrier: 'PROGRESSIVE', limit: '$1M CSL', expiration: '12/01/2026' }];
  record.trailers = [
    { type: 'Dry Van', year: 2015, make: 'Great Dane', model: null, vin: '1GRAA0621FB700000', value: 25000 },
    { type: 'Flatbed', year: null, make: null, model: null, vin: null, value: 12500 },
    // Codex on PR #58: a year or value the intake couldn't read stays text (flagged on Check intake).
    { type: 'Reefer', year: '20015', make: 'UTILITY', model: null, vin: null, value: 'about 25k' },
  ];
  const plan = buildPlan(record, amwins, {});
  assert.equal(plan.find((x) => /^Disclosure/.test(x.name ?? '')).value, [
    'More than 500 miles radius of operation',
    'Trailer - 2015 Great Dane Dry Van - VIN 1GRAA0621FB700000 - $25K',
    'Trailer - Flatbed - $12.5K',
    'Trailer - UTILITY Reefer',
    'POP Commercial - Progressive - $1M CSL - Exp Date 12/01/2026',
  ].join('\n'));
  assert.equal(plan.find((x) => x.selector === '#vehLookupVin').value.includes('1GRAA0621FB700000'), false, 'not looked up as a vehicle');
  // A trailer row added by hand anyway gets nothing from the generic rules: they are kept out of
  // AmWINS' row sections (pagekit test "a generic label rule never answers inside a carrier row section").
  const generic = plan.filter((x) => x.path === 'vehicles[0].type' || x.path === 'operations.radius');
  assert.ok(generic.length >= 2 && generic.every((x) => x.notWithin?.includes('#vehiclesPanel')));
  assert.ok(plan.filter((x) => /^amwins\.|^#|^Body type/.test(x.path ?? x.name)).every((x) => x.notWithin == null), 'AmWINS\' own rules answer their rows');
  assert.ok(buildPlan(record, null, {}).every((x) => x.notWithin == null), 'no fence without a carrier\'s row sections');
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
  for (const re of [/^Vehicles leased to others/, /^Vehicles not owned/, /^Convictions/, /^Additional interest/]) {
    assert.equal(named(re)[0].value, false, `${re}: TNI's standard No (2026-10-09)`);
    assert.equal(named(re)[0].source, 'standard');
  }
  assert.equal(named(/^Body type/)[0].replace, true);
  assert.equal(named(/^Other topics/)[0].replace, true, 'Yes again after Default all answers to No');
  const actions = plan.filter((s) => s.kind === 'action');
  assert.ok(new RegExp(actions.find((a) => a.action === 'defaultNo').text, 'i').test('Default all answers to "No"'));
  assert.deepEqual(actions.find((a) => a.action === 'openApplication').after, ['amwins.riskState']);
  assert.ok(new RegExp(amwins.advance.text, 'i').test('Save & Continue'));
  assert.ok(!new RegExp(amwins.advance.text, 'i').test('Save & Exit'));
});

test('AmWINS: current carrier tenure (asked with a DOT only) 1 TO 2 YEARS and claim-free loss runs No are TNI standards; marital status the agent\'s; PIP No', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  const record = baseRecord();
  record.applicant.dot = '1234567';
  let plan = buildPlan(record, amwins, {});
  const sel = (s) => plan.find((x) => x.selector === s);
  const named = (re) => plan.find((x) => re.test(x.name ?? ''));
  // TNI 2026-10-19: 1 TO 2 YEARS and No are its standards (2026-10-09 to 10-19 the agent's).
  assert.deepEqual([sel('#howLongWithCurrentCarrier').value, sel('#howLongWithCurrentCarrier').source], ['1 TO 2 YEARS', 'standard']);
  assert.equal(sel('#howLongWithCurrentCarrier').ignore, false);
  assert.deepEqual([named(/^Claim-free loss runs/).value, named(/^Claim-free loss runs/).source], [false, 'standard']);
  assert.deepEqual([named(/^Valued loss runs/).value, named(/^Valued loss runs/).source], [false, 'standard'], 'TNI 2026-10-19 (a later run): always No');
  const pip = named(/^Personal Injury Protection \(/);
  assert.equal(pip.ignore, false);
  assert.equal(pip.value, false, 'No: Medical Payments is offered');
  assert.equal(pip.replace, true, 'replaces the page pre-selected Yes');
  assert.equal(sel('#personalInjuryProtectionLimit').ignore, true);
  const marital = () => sel('#driversPanel [data-id="martialStatus"]');
  assert.equal(marital().value, null, 'no marital status on this record: left to the agent, no Married default (2026-10-09)');
  assert.equal(marital().warn, null);
  record.applicant.dot = null;
  plan = buildPlan(record, amwins, {});
  assert.equal(sel('#howLongWithCurrentCarrier').ignore, true, 'only asked of clients with a DOT number');
  record.drivers[0].maritalStatus = 'Single';
  plan = buildPlan(record, amwins, {});
  assert.equal(marital().value, 'Single', 'the intake\'s answer is filled');
  assert.equal(marital().path, 'drivers[0].maritalStatus');
});

test('Progressive FL run: new USDOT not found yet, safety equipment from the VIN lookup, PD-only and PIP not selected', () => {
  const record = baseRecord();
  record.applicant.dot = '4123456';
  record.applicant.name = null;
  record.applicant.owner1 = 'Amina Kone';
  record.garaging.state = 'FL';
  const plan = buildPlan(record, progressive, {});
  // TNI 2026-10-19: a USDOT the lookup doesn't find was obtained within 60 days, its standard Yes.
  assert.deepEqual([byQ(plan, '21E').value, byQ(plan, '21E').source], [true, 'standard']);
  assert.equal(byQ(plan, '21E').ignore, false);
  assert.equal(byQ(plan, '230').ignore, false, 'business name typed in even with a USDOT number');
  assert.equal(byQ(plan, '230').value, 'Amina Kone', 'no company: the owner');
  // TN 2026-10-08: Vehicle Type is asked only when the VIN lookup disagrees with the tile.
  const vehicleType = plan.find((s) => s.field === 'RiskInput.VehicleTypeToDisplay');
  assert.equal(vehicleType.ignore, true, 'the agent picks the vehicle type');
  assert.match(vehicleType.emptyNote, /VIN lookup doesn't match the intake's Van/);
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
    assert.match(other.emptyNote, /Florida and Arkansas only/, `${state}: an empty PIP goes to the agent`);
  }
  assert.equal(byQ(plan, '1E8D').emptyNote, null);
  // AR 2026-10-19 (live run): PIP is its own control there (PIPInput.Limit, captioned "Limit",
  // unfamiliar until now). TNI's standard: 5k Medical and Hospital alone, where Progressive picked
  // income loss, medical and accidental death. Elsewhere this control keeps Progressive's choice.
  const ar = buildPlan({ ...record, garaging: { ...record.garaging, state: 'AR' } }, progressive, {});
  assert.deepEqual([byQ(ar, '1FB2').field, byQ(ar, '1FB2').value, byQ(ar, '1FB2').source, byQ(ar, '1FB2').ignore, byQ(ar, '1FB2').emptyNote],
    ['PIPInput.Limit', '5k Medical and Hospital', 'standard', false, null]);
  assert.equal(byQ(ar, '1E8D').ignore, true, 'Florida\'s PIP standard is Florida\'s only');
  for (const state of ['FL', 'TX']) {
    const other = byQ(buildPlan({ ...record, garaging: { ...record.garaging, state } }, progressive, {}), '1FB2');
    assert.deepEqual([other.value, other.ignore], [null, true], state);
    assert.match(other.emptyNote, /Florida and Arkansas only/, state);
  }
  record.applicant.dot = null;
  assert.equal(byQ(buildPlan(record, progressive, {}), '21E').ignore, true);
});

test('Progressive NJ run: vehicle registrant, VIN-lookup safety boxes kept, Rates loan/lease carried over, rates helpers wait for the liability limit', () => {
  const plan = buildPlan(baseRecord(), progressive, {});
  assert.equal(byQ(plan, '2C97').value, null, 'the registrant isn\'t on the intake: the agent\'s (2026-10-09)');
  assert.match(byQ(plan, '2C97').note, /registered/);
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
  const glPrint = buildPlan(gl, progressive, {}).find((s) => s.action === 'print');
  assert.deepEqual([glPrint.after, glPrint.afterActions], [[], ['billPlan']], 'with GL too, Print follows our bill plan, which checked the limit');
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
  assert.equal(owner(record).driver, null, 'the same one-word surname with another first name is someone else (audit 2026-10-08)');
});

// Audit 2026-10-08: owner "Alice Sample" who doesn't drive took the first name and date of birth
// of the sole driver "Bob Sample" (through the surname-only match), on both carriers.
test('the owner is never another driver: first names must agree, and a non-driving owner links no row', () => {
  const record = baseRecord();
  record.applicant.owner1 = 'Alice Sample';
  record.applicant.ownerDrives = false;
  record.drivers = [{ first: 'Bob', middle: null, last: 'Sample', dob: '01/02/1990' }];
  let o = owner(record);
  assert.equal(o.driver, null);
  assert.equal(o.first, 'Alice');
  assert.equal(o.last, 'Sample');
  let plan = buildPlan(record, progressive);
  assert.equal(byQ(plan, '295').value, 'Alice');
  assert.equal(byQ(plan, '297').value, 'Sample');
  assert.equal(byQ(plan, '2BB').value, null, 'no date of birth: the agent\'s');
  record.applicant.ownerDrives = true;
  o = owner(record);
  assert.equal(o.driver, null, 'the owner drives, but the sole driver has another first name');
  assert.equal(o.first, 'Alice');
  assert.equal(byQ(buildPlan(record, progressive), '2BB').value, null);
  record.drivers = [{ first: 'Alice', middle: null, last: 'Sample', dob: '03/04/1985' }];
  assert.equal(owner(record).driver?.dob, '03/04/1985', 'the exact full name links');
  record.applicant.ownerDrives = false;
  assert.equal(owner(record).driver, null, 'an owner who doesn\'t drive is not a driver row, even by full name');
  assert.equal(byQ(buildPlan(record, progressive), '2BB').value, null);
  // The owner box holding only the first name still finds the one driver with it, unless the
  // intake says the owner doesn't drive.
  record.applicant.owner1 = 'Alice';
  record.applicant.ownerDrives = null;
  assert.equal(owner(record).driver?.dob, '03/04/1985');
  record.applicant.ownerDrives = false;
  assert.equal(owner(record).driver, null);
  assert.equal(owner(record).last, 'Alice', 'a one-word box: the word, as before');
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
  // GL without NTL: our GL helpers and bill plan. With NTL too, the NTL item says the rest of
  // Rates is theirs: no GL helpers.
  const gl = baseRecord();
  gl.coverage.gl = true;
  assert.ok(ids(gl).includes('billPlan') && ids(gl).includes('openGl') && ids(gl).includes('doneGl'));
  assert.deepEqual(actions(gl).find((s) => s.action === 'print').afterActions, ['billPlan']);
  gl.coverage.ntl = true;
  assert.ok(!ids(gl).includes('openGl') && !ids(gl).includes('doneGl') && ids(gl).includes('ntlRates'));
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
  // No trailer ownership on the intake: the agent's (2026-10-09; TNI's 2026-10-07 "owned" is
  // reversed). One that is none of owned/financed/leased (Rented) is the agent's (Codex on PR #43).
  const blank = byQ(buildPlan({ ...record, trailerInfo: {} }, progressive, { trailers: 0 }), '2AD0');
  assert.equal(blank.value, null);
  assert.match(blank.note, /no trailer ownership/);
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
  // The 2026-10 form's Additional Notes box counts the same.
  const notes = { ...baseRecord(), notes: { text: 'Driver took a defensive driving course last year.' } };
  const fromNotes = byQ(buildPlan(notes, progressive, {}), '299D');
  assert.deepEqual([fromNotes.value, /defensive driving course/.test(fromNotes.note ?? '')], [null, true]);
});

// PA 2026-10-20 (live run): the intake's license box said "Excluded" for driver 1 of 4, and the
// exclude question was answered No, the opposite of the intake. TNI: Yes for that driver.
test('Exclude this driver: No for a listed driver, Yes for one the intake marks excluded', () => {
  const record = baseRecord();
  record.drivers.push({ first: 'Sam', middle: null, last: 'Kone', dob: '03/04/1985', licenseNumber: null, licenseState: 'MD', excluded: true });
  const step = (drivers, q = '28C1') => byQ(buildPlan(record, progressive, { drivers }), q);
  const got = (s) => [s.value, s.source, s.manualOnly, s.note];
  assert.deepEqual(got(step(0)), [false, 'derived', false, null], 'the other driver: No, as before');
  assert.deepEqual(got(step(1)), [true, 'derived', false, null]);
  assert.deepEqual(step(1).from, ['drivers[1].excluded'], 'its evidence: the license box');
  // The box held only the word: no license number, so that box is the agent's.
  assert.equal(step(1, '28B9').value, null);
  // The agent's No in client details: No, as for any listed driver.
  record.drivers[1].excluded = false;
  assert.deepEqual([step(1).value, step(1).source], [false, 'derived']);
});

// TNI, 2026-10-19 (SC live run: each went to the agent and to Luna, though TNI's answer is No).
test('TNI standards of 2026-10-19: blank placard, claims, filings (no USDOT / MC) and a vehicle under a year are No', () => {
  const step = (record, q) => byQ(buildPlan(record, progressive, { drivers: 0, vehicles: 0 }), q);
  const got = (s) => [s.value, s.source, s.standard, !!s.note];

  // Hazmat placard: the intake's answer; blank is No unless they haul hazmat.
  const placard = baseRecord();
  assert.deepEqual(got(step(placard, '2F6')), [false, 'intake', false, false]);
  placard.operations.hazPlacard = true;
  assert.deepEqual(got(step(placard, '2F6')), [true, 'intake', false, false]);
  placard.operations.hazPlacard = null;
  assert.deepEqual(got(step(placard, '2F6')), [false, 'standard', true, false], 'blank: TNI standard No');
  placard.operations.hazmat = true;
  assert.deepEqual(got(step(placard, '2F6')), [null, 'derived', false, true], 'blank but hauls hazmat: the agent\'s');
  assert.equal(step(placard, '2F6').path, 'operations.hazPlacard', 'still linked to the intake answer');
  // What they haul may need a placard (review of PR #97): the agent's; "non-hazardous" isn't.
  placard.operations.hazmat = null;
  for (const what of ['Fuel and propane tanks', 'Industrial chemicals', 'Hazmat loads', 'Lithium batteries']) {
    placard.operations.whatHaul = what;
    assert.deepEqual(got(step(placard, '2F6')), [null, 'derived', false, true], `"${what}": the agent's`);
    assert.match(step(placard, '2F6').note, /may need a placard/);
  }
  for (const what of ['General freight', 'Non-hazardous general freight', 'Dry goods, no hazmat', 'Furniture']) {
    placard.operations.whatHaul = what;
    assert.deepEqual(got(step(placard, '2F6')), [false, 'standard', true, false], `"${what}": TNI standard No`);
  }
  // A placard question found only by its label gets the same answer (review of PR #97).
  const byLabel = (record) => buildPlan(record, progressive, {}).find((s) => s.q == null && s.path === 'operations.hazPlacard');
  assert.deepEqual(got(byLabel(placard)), [false, 'standard', true, false], 'label fallback: TNI standard No');
  placard.operations.whatHaul = 'Diesel fuel';
  assert.deepEqual(got(byLabel(placard)), [null, 'derived', false, true], `label fallback: the agent's`);

  // Accidents, claims or violations: the claims box's Yes or No; neither is No unless the notes
  // mention one.
  const claims = (hasClaims, notes = null, more = null) => ({ ...baseRecord(), claims: { hasClaims, notes }, notes: { text: more } });
  assert.deepEqual(got(step(claims(true), '28F5')), [true, 'intake', false, false]);
  assert.deepEqual(got(step(claims(false), '28F5')), [false, 'intake', false, false]);
  for (const notes of [null, 'Financed', 'No claims or violations in the last 5 years.', 'None', 'N/A', 'Clean record', 'Can provide claim-free loss runs', 'Wants a quote by Friday; loss runs attached', 'Loss payee: First Bank', 'Pickup points in three states']) {
    assert.deepEqual(got(step(claims(null, notes), '28F5')), [false, 'standard', true, false], `"${notes}": TNI standard No`);
  }
  for (const [notes, more] of [['One speeding ticket in 2024', null], ['No accidents but one speeding ticket', null], [null, 'Driver had an at-fault accident in 2023.'], ['DUI 2022', null], ['Prior loss: cargo theft 2024', null],
    // Wordings the first version missed (review of PR #97).
    ['4 points on his license', null], [null, 'License revoked in 2024.'], ['Rear-ended a car in March', null], ['Reckless driving 2023', null], ['OWI 2021', null], [null, 'Small fender bender last year'], ['Hit a deer in 2025', null], ['Needs SR-22', null]]) {
    const s = step(claims(null, notes, more), '28F5');
    assert.deepEqual(got(s), [null, 'derived', false, true], `"${notes ?? more}": the agent's`);
    assert.match(s.note, /answer it yourself/);
  }
  // An SR-22 needed (review of PR #97): the agent's, with the reason.
  const sr22 = claims(null);
  sr22.operations.needSr22 = true;
  assert.deepEqual(got(step(sr22, '28F5')), [null, 'derived', false, true], `SR-22 needed: the agent's`);
  assert.match(step(sr22, '28F5').note, /SR-22/);
  // An explicit No in the box wins over notes that mention something else.
  assert.equal(step(claims(false, 'Ticket paid, dismissed'), '28F5').value, false);

  // Filings: the intake's answer; blank is No only without a USDOT or MC number.
  const filings = baseRecord();
  filings.operations.filingsRequired = null;
  filings.operations.filingsWhich = null;
  assert.deepEqual(got(step(filings, 'CA')), [false, 'standard', true, false], 'blank, no USDOT or MC: TNI standard No');
  assert.equal(step(filings, 'F11').value, null, 'the Filings page (shown only after a Yes) is unchanged');
  // A USDOT coming within 60 days (TNI, 2026-10-19): still No; the USDOT question says "Not Yet".
  filings.applicant.mcDotWithin60Days = true;
  assert.deepEqual(got(step(filings, 'CA')), [false, 'standard', true, false], 'USDOT coming within 60 days: still No');
  assert.match(step(filings, '1ED').value, /^Not Yet - but the customer has applied\/will apply/);
  filings.applicant.dot = '1234567';
  assert.deepEqual(got(step(filings, 'CA')), [null, 'derived', false, false], 'blank with a USDOT number: the agent\'s');
  filings.applicant.dot = null;
  filings.applicant.mc = '765432';
  assert.deepEqual(got(step(filings, 'CA')), [null, 'derived', false, false], 'blank with an MC number: the agent\'s');
  filings.applicant.mc = null;
  // Filings named, or an SR-22 needed, with the answer blank (review of PR #97): the agent's.
  filings.operations.filingsWhich = 'Form E';
  assert.deepEqual(got(step(filings, 'CA')), [null, 'derived', false, true], `blank but filings named: the agent's`);
  assert.match(step(filings, 'CA').note, /Form E/);
  filings.operations.filingsWhich = null;
  filings.operations.needSr22 = true;
  assert.deepEqual(got(step(filings, 'CA')), [null, 'derived', false, true], `blank but SR-22 needed: the agent's`);
  assert.match(step(filings, 'CA').note, /SR-22/);
  filings.operations.filingsRequired = false;
  assert.deepEqual(got(step(filings, 'CA')), [false, 'derived', false, false]);

  // Had the vehicle less than a year: TNI's standard No; how long stays the agent's.
  assert.deepEqual(got(step(baseRecord(), '2C06')), [false, 'standard', true, false]);
  assert.equal(step(baseRecord(), '2C06').field, 'RiskInput.VehicleOwnershipLessThanAYear');
  assert.equal(step(baseRecord(), '2C09').value, null);
  // A vehicle of this model year or later (review of PR #97): likely bought within the year, the agent's.
  const recent = baseRecord();
  recent.vehicles[0].year = new Date().getFullYear();
  assert.deepEqual(got(step(recent, '2C06')), [null, 'fact', false, true], `this model year: the agent's`);
  assert.equal(step(recent, '2C06').manualOnly, true, `never Luna's`);
  recent.vehicles[0].year = new Date().getFullYear() - 1;
  assert.deepEqual(got(step(recent, '2C06')), [false, 'standard', true, false], 'last model year: TNI standard No');
});

// Runs of 2026-10-07 (FL, UT, SC): the CDL year, UMPD per vehicle, SC's glass deductible and
// combined UM/UIM, Rates buttons waiting on required questions, and vehicle ownership length.
test('FL / UT / SC questions of 2026-10-07', () => {
  const record = baseRecord();
  record.drivers[0] = { ...record.drivers[0], cdl: true, cdlYear: 2015 };
  record.vehicles = [{ ...record.vehicles[0] }, { ...record.vehicles[0], year: 2019, make: 'FORD', model: 'TRANSIT' }];
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '295E').value, 2015, 'Year CDL Issued from the intake');
  assert.equal(byQ(plan, '2960').ignore, true, '"Year is unknown" is the agent\'s');
  assert.equal(plan.filter((s) => s.q === '1FDD').length, 2, 'UMPD: one step per vehicle');
  assert.ok(plan.filter((s) => s.q === '1FDD').every((s) => s.value === 'Not selected' && s.vehicleHint));
  assert.ok(byQ(plan, '1FCD').choiceAliases.includes('$1,000 Deductible w/ $0 Glass Deductible'));
  assert.deepEqual([byQ(plan, '1E68').value, byQ(plan, '1E6C').value], ['$100k CSL w/ $200 Deductible', '$100k CSL w/ $0 Deductible']);
  for (const id of ['billPlan', 'recalculate', 'print']) {
    const a = plan.find((s) => s.action === id);
    if (a) assert.equal(a.waitRequired, true, id);
  }
  assert.match(byQ(plan, '2C09').note, /answer it yourself/, 'how long the insured has had the vehicle: the agent\'s (TNI)');
  // Codex on PR #43: a trailer's equipment amount from the intake goes to its Rates row too.
  const trailer = trailerRecord();
  trailer.trailerInfo.equipTrailer = 3500;
  const tr = buildPlan(trailer, progressive, { trailers: 0 }).find((s) => s.q === 'TR2CE0');
  assert.deepEqual([tr.value, tr.ignore, tr.pageOnly], [3500, false, true]);
});

test('AmWINS vehicle rows are found by their VIN (witness), not their position; drivers and coverages keep theirs', async () => {
  const { amwins } = await import('../src/carriers/amwins.js');
  const record = baseRecord();
  record.vehicles.push({ type: 'Box Truck', year: 2019, make: 'ISUZU', model: 'NPR', vin: '54DC4W1B5KS800001', value: 45000 });
  const plan = buildPlan(record, amwins, {});
  const bodies = plan.filter((s) => /^Body type/.test(s.name));
  assert.deepEqual(bodies.map((s) => s.selector), Array(2).fill('#vehiclesPanel .app-rp-section [data-id="bodyType"]'), 'no row index in the selector');
  assert.deepEqual(bodies.map((s) => s.witness), [
    { selector: '[data-id="vin"]', path: 'vehicles[0].vin', value: '1FTBR3X87MKA12345' },
    { selector: '[data-id="vin"]', path: 'vehicles[1].vin', value: '54DC4W1B5KS800001' },
  ]);
  const vins = plan.filter((s) => s.path.endsWith('.vin') && s.selector?.includes('vehiclesPanel'));
  assert.equal(vins.length, 2);
  assert.ok(vins.every((s) => s.trustPage && s.witness?.value === s.value), 'the VIN rule keeps the page\'s VIN on its matched row');
  const value = plan.find((s) => s.path === 'vehicles[1].value');
  assert.equal(value.selector, '#vehiclesPanel .app-rp-section [data-id="costNew"]');
  assert.equal(value.witness.value, '54DC4W1B5KS800001');
  // The import is done once the rows changed. Rules without a witness have none.
  assert.equal(plan.find((s) => s.baseAction === 'importVinRecords').verify, 'revealed');
  assert.equal(plan.find((s) => s.selector === '#driversPanel [data-id="firstName"]').witness, null);
  assert.equal(plan.find((s) => /^Exclude Medical/.test(s.name)).witness, null);
  record.vehicles.pop();
  const one = buildPlan(record, amwins, {}).find((s) => /^Body type/.test(s.name));
  assert.equal(one.selector, '#vehiclesPanel [data-id="bodyType"]');
  assert.equal(one.witness.value, '1FTBR3X87MKA12345', 'one vehicle: still its VIN\'s row');
  // Progressive's lookups are done once the page shows their result; its rules have no witness.
  const p = buildPlan(record, progressive, {});
  assert.equal(p.find((s) => s.baseAction === 'lookupVin').verify, 'revealed');
  assert.equal(p.find((s) => s.baseAction === 'verifyDot').verify, 'revealed');
  // Already shown before Fill (the agent ran it): the decoded year/make/model of the active
  // vehicle, all answered; the USDOT record's questions, any of them.
  const second = buildPlan(record, progressive, { vehicles: 1 });
  assert.deepEqual(second.find((s) => s.baseAction === 'lookupVin').shownBy, { all: ['vehicles[1].year', 'vehicles[1].make', 'vehicles[1].model'], any: [], answered: true });
  assert.deepEqual(p.find((s) => s.baseAction === 'verifyDot').shownBy, { all: [], any: ['progressive.q20F', 'progressive.q21E', 'progressive.q22F', 'progressive.q277'], answered: false });
  assert.ok(p.filter((s) => s.kind !== 'action').every((s) => s.witness === null));
});
