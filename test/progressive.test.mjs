import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { progressive, owner } from '../src/carriers/progressive.js';
import { amwins } from '../src/carriers/amwins.js';

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
  assert.equal(byQ(buildPlan(record, progressive), '2BB').value, '01/02/1980', 'two drivers by that name: the first one listed (TNI, 2026-10-20)');
});

// TNI 2026-10-01: an insurance type without limit or expiry was currently insured No. TNI
// 2026-10-26 (W44-29): any box filled is proof of prior insurance, so Yes, TNI's assumption, and
// the limit and date are the agent's.
test('an insurance type without limit or expiry is currently insured, the limit and date the agent\'s (W44-29)', () => {
  const record = baseRecord();
  record.priorInsurance = [{ type: 'Commercial Auto', carrier: null, limit: null, expiration: null }];
  const plan = buildPlan(record, progressive);
  assert.deepEqual([byQ(plan, '81').value, byQ(plan, '81').source], [true, 'standard']);
  // Continuous coverage: Yes when insured (TNI 2026-10-10).
  assert.deepEqual([byQ(plan, '83').value, byQ(plan, '83').source], [true, 'standard']);
  for (const q of ['95', '9D']) {
    assert.equal(byQ(plan, q).ignore, false);
    assert.equal(byQ(plan, q).value, null);
    assert.match(byQ(plan, q).note, /has no (limit|expiration date)/);
  }
  record.priorInsurance[0].limit = '$500k CSL';
  record.priorInsurance[0].expiration = '10/31/2026';
  assert.deepEqual([byQ(buildPlan(record, progressive), '81').value, byQ(buildPlan(record, progressive), '81').source], [true, 'derived']);
  assert.equal(byQ(buildPlan(record, progressive), '83').value, true);
  // Nothing on the intake: not currently insured, as before.
  record.priorInsurance = [];
  assert.equal(byQ(buildPlan(record, progressive), '81').value, false);
  assert.equal(byQ(buildPlan(record, progressive), '83').value, null);
  assert.match(byQ(buildPlan(record, progressive), '83').note, /continuous coverage/i);
});

test('sole owner-driver with duplicated first name uses owner surname and driver DOB', () => {
  const record = baseRecord();
  record.drivers[0].last = 'Amina';
  const plan = buildPlan(record, progressive);
  assert.equal(byQ(plan, '2BB').value, record.drivers[0].dob);
  assert.equal(byQ(plan, '297').value, 'Kone');
  // The owner doesn't drive: the first row is still the owner's, its date of birth theirs (TNI,
  // 2026-10-27: answer to PR question V4, with T3; before, none: the name didn't match).
  record.applicant.ownerDrives = false;
  assert.equal(byQ(buildPlan(record, progressive), '2BB').value, record.drivers[0].dob);
});

test('Progressive standard answers: USDOT belongs to the business is TNI\'s standard Yes, filings, MCS-90 left to the page', () => {
  const record = baseRecord();
  record.applicant.dot = '1234567';
  const plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '2C1A').value, true, 'for-hire: an expediter hauls for hire');
  assert.equal(byQ(plan, '29F').value, true, 'owner-as-driver follows the intake (W44-25: blank is TNI\'s Yes)');
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
  for (const q of ['18F', '194', '1CC', '77', '2DB', '2DD', '2DF', '2B00', '3E96', '3E97', '3EA4', '32CE']) {
    assert.equal(byQ(plan, q).ignore, true, `q${q} is preserved`);
  }
  // Maryland's own PIP list is no longer kept as Progressive set it: "$2,500 Full PIP" (TNI,
  // 2026-10-26: answer to PR question; see the FL run's test).
  assert.deepEqual([byQ(plan, '1E7C').ignore, byQ(plan, '1E7C').value], [false, '$2,500 Full PIP'], 'MD PIP');
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
  // The maintainer's order (2026-10-23): cargo, then Recalculate (only with the rates out of date)
  // and its new premium, then bill plan options (automatic payments), back to Rates, then Print.
  assert.deepEqual(recalc.afterActions, ['doneCargo']);
  assert.deepEqual(recalc.afterPages, []);
  assert.equal(recalc.verify, 'premium');
  assert.equal(recalc.needsRecalculation, true);
  assert.equal(bill.needsPremium, true, 'the bill plan waits for a current premium: after Recalculate');
  assert.deepEqual(bill.afterActions, ['doneCargo']);
  assert.ok(new RegExp(bill.text, 'i').test('Billing Options'));
  // Print follows the bill plan and doesn't wait for Recalculate.
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
  // With GL too: Recalculate once cargo and GL are done, then the bill plan, then Print.
  for (const id of ['recalculate', 'billPlan']) assert.deepEqual(glActions.find((s) => s.action === id).afterActions, ['doneCargo', 'doneGl'], id);
  assert.deepEqual(glActions.find((s) => s.action === 'print').afterActions, ['billPlan'], 'print follows our bill plan');
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
  assert.deepEqual(glActions.find((s) => s.action === 'doneCargo').unlessActions, ['openGl'], "GL's Done is never taken for cargo's");
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
  assert.deepEqual([odd.value, odd.manualOnly], [null, true]);
  assert.match(odd.note, /\$500K\/\$1M general liability limit, which Progressive doesn't offer/);
  // Oil and gas work in what they haul: that question is the agent's.
  const oil = structuredClone(gl);
  oil.operations.whatHaul = 'Frac sand and oilfield equipment';
  const oilStep = glField(buildPlan(oil, progressive, {}), 'GeneralLiabilityInput.GeneralLiabilityTruckOilAndGas');
  assert.deepEqual([oilStep.value, oilStep.manualOnly], [null, true], "the agent's, never Luna's");
  const bigRig = structuredClone(gl);
  bigRig.operations.whatHaul = 'General freight in a big rig';
  assert.equal(glField(buildPlan(bigRig, progressive, {}), 'GeneralLiabilityInput.GeneralLiabilityTruckOilAndGas').value, false, '"big rig" is no oil and gas work');
  assert.match(oilStep.note, /mentions oil or gas work \("Frac sand and oilfield equipment"\)/);
  // No GL on the intake: no GL helpers, and a section the agent opened is theirs.
  assert.ok(!actions.some((s) => /Gl$/.test(s.action)), 'no GL requested: no GL helpers');
  for (const ref of ['GeneralLiabilityInput.GeneralLiabilityTruckIncome', 'LineInput.GeneralLiabilityLimit']) {
    const step = glField(plan, ref);
    assert.deepEqual([step.value, step.manualOnly], [null, true], ref);
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
  // TNI, 2026-10-27 (until then $1,000): no deductible on the intake is the agent's, told what it
  // usually is; a client fact, so never Luna's.
  for (const q of ['216F', '2150']) {
    const cargo = byQ(plan, q);
    assert.deepEqual([cargo.value, cargo.source, cargo.manualOnly], [null, 'fact', true], q);
    assert.match(cargo.note, /no deductible.*usually \$1,000 or \$2,500/, q);
  }
  const withDed = buildPlan({ ...record, coverage: { ...record.coverage, cargoDeductible: 2500 } }, progressive, {});
  assert.deepEqual([byQ(withDed, '216F').value, byQ(withDed, '216F').source, byQ(withDed, '216F').note], ['$100000/$2500', 'derived', null]);
  const noCargo = buildPlan({ ...record, coverage: { ...record.coverage, cargo: false } }, progressive, {});
  assert.deepEqual([byQ(noCargo, '216F').value, byQ(noCargo, '216F').note], ['Not selected', null], 'no cargo: no deductible needed');
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

// TNI (2026-10-26, W44-30): "only on NoHit, the first word". Progressive's NoHit page gets the
// first word of a multi-word owner first name (its own advice there: drop the middle name);
// Business Owner Info and the driver forms keep the whole first name.
test('NoHit: the first word of a multi-word owner first name; other pages keep it whole (TNI 2026-10-26, W44-30)', () => {
  const record = baseRecord();
  record.applicant.owner1 = 'Amina Sample Kone';
  record.drivers = [{ first: 'Amina Sample', middle: null, last: 'Kone', dob: '01/02/1980', licenseNumber: 'MD1234567', licenseState: 'MD' }];
  let plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '1B7F').value, 'Amina', 'NoHit: the first word');
  assert.equal(byQ(plan, '1B7F').source, 'derived', 'computed from the intake, not a standard');
  assert.equal(byQ(plan, '1B7F').standard, false);
  assert.equal(byQ(plan, '1B80').ignore, true, 'NoHit middle initial: still left as the page has it');
  assert.equal(byQ(plan, '1B80').value ?? null, null);
  assert.equal(byQ(plan, '1B81').value, 'Kone');
  // Counterexamples: Business Owner Info and the driver form keep the whole first name.
  assert.equal(byQ(plan, '295').value, 'Amina Sample', 'Business Owner Info keeps the whole first name');
  assert.equal(plan.find((s) => s.path === 'drivers[0].first' && s.q === '2898').value, 'Amina Sample', 'Add Driver keeps the whole first name');
  // The owner box alone (the owner doesn't drive): its words before the surname, then the first one.
  record.applicant.ownerDrives = false;
  plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '1B7F').value, 'Amina');
  assert.equal(byQ(plan, '295').value, 'Amina Sample');
  // A hyphenated first name is one word, also beside a second word.
  record.applicant.ownerDrives = true;
  record.applicant.owner1 = 'Mary-Ann Kone';
  record.drivers[0].first = 'Mary-Ann';
  assert.equal(byQ(buildPlan(record, progressive, {}), '1B7F').value, 'Mary-Ann');
  record.applicant.owner1 = 'Mary-Ann Sample Kone';
  record.drivers[0].first = 'Mary-Ann Sample';
  plan = buildPlan(record, progressive, {});
  assert.equal(byQ(plan, '1B7F').value, 'Mary-Ann');
  assert.equal(byQ(plan, '295').value, 'Mary-Ann Sample');
  // A two-word first name the reader keeps as written ("A J") is its first word too.
  record.applicant.owner1 = 'A J Kone';
  record.drivers[0].first = 'A J';
  plan = buildPlan(record, progressive, {});
  assert.deepEqual([byQ(plan, '1B7F').value, byQ(plan, '295').value], ['A', 'A J']);
  // A one-word first name is unchanged, and none stays none.
  const one = baseRecord();
  assert.equal(byQ(buildPlan(one, progressive, {}), '1B7F').value, 'Amina');
  assert.equal(byQ(buildPlan(one, progressive, {}), '1B7F').value, byQ(buildPlan(one, progressive, {}), '295').value);
  one.applicant.owner1 = null;
  one.drivers[0].first = null;
  assert.equal(byQ(buildPlan(one, progressive, {}), '1B7F').value, null);
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
  assert.equal(named(/^Disclosure/).warn, null);
  // No deductible on the intake (TNI, 2026-10-27; until then $1K): the line leaves it out, and the
  // agent adds it.
  record.coverage.cargoDeductible = null;
  const noDed = buildPlan(record, amwins, {}).find((x) => /^Disclosure/.test(x.name ?? ''));
  assert.match(noDed.value, /^Motor Truck Cargo \$100K - Consumer Goods \/ Other Consumer Goods$/m);
  assert.match(noDed.warn, /usually \$1,000 or \$2,500.*Motor Truck Cargo line/);
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

test('AmWINS: current carrier tenure (asked with a federal filing required) 1 TO 2 YEARS and claim-free loss runs No are TNI standards; marital status the agent\'s; PIP No', async () => {
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
  // Medical Payments $5,000 and PIP No (TNI, 2026-10-26, W44-26: Medical Payments $5,000 wherever
  // offered, PIP not selected; AmWINS always offers Medical Payments), in every state AmWINS asks it.
  // No-fault states too (FL, NY, MI): AmWINS PIP stays as it is in every state, because AmWINS, as
  // the broker, picks the right coverage on its side when it prepares the quote (TNI, 2026-10-26:
  // answer to PR question).
  for (const state of ['TX', 'MD', 'WA', 'FL', 'NY', 'MI']) {
    const p = buildPlan({ ...record, garaging: { ...record.garaging, state } }, amwins, {});
    const pip = p.find((x) => /^Personal Injury Protection \(/.test(x.name ?? ''));
    assert.deepEqual([pip.value, pip.source, pip.ignore, pip.replace], [false, 'standard', false, true], `${state}: PIP No, replacing the page's pre-selected Yes`);
    assert.deepEqual([p.find((x) => x.selector === '#medicalPayment').value, p.find((x) => x.selector === '#medicalPayment').source], ['$5,000', 'standard'], state);
    assert.equal(p.find((x) => x.selector === '#personalInjuryProtectionLimit').ignore, true, 'its limit only shows with Yes');
  }
  const marital = () => sel('#driversPanel [data-id="martialStatus"]');
  assert.equal(marital().value, null, 'no marital status on this record: left to the agent, no Married default (2026-10-09)');
  assert.equal(marital().warn, null);
  record.applicant.dot = null;
  plan = buildPlan(record, amwins, {});
  // TNI, 2026-10-26 (round 2, R7): AmWINS asks it with a federal filing required (this record's),
  // also with no DOT or MC number; it is answered wherever the page shows it (until then: only with a DOT number).
  assert.deepEqual([sel('#howLongWithCurrentCarrier').ignore, sel('#howLongWithCurrentCarrier').value, sel('#howLongWithCurrentCarrier').source], [false, '1 TO 2 YEARS', 'standard']);
  record.drivers[0].maritalStatus = 'Single';
  plan = buildPlan(record, amwins, {});
  assert.equal(marital().value, 'Single', 'the intake\'s answer is filled');
  assert.equal(marital().path, 'drivers[0].maritalStatus');
});

// TNI, 2026-10-26, W44-32 (the maintainer: "Your recommendations good"): AmWINS' "Is a Federal
// Filing Required?" left blank on the intake is No when the intake doesn't ask for filings. Its own
// Yes or No wins; named filings or a line of its notes mentioning a filing leave it to the agent, with
// what it says; an SR-22 alone doesn't (2026-10-26). A Non-Trucking quote is W44-28's, not this standard.
test('AmWINS filing required: blank is TNI\'s No unless the intake asks for filings (W44-32)', () => {
  const filing = (changes = {}, { notes = null, ntl = null, applicant = {} } = {}) => {
    const r = baseRecord();
    Object.assign(r.operations, { filingsRequired: null, filingsWhich: null, needSr22: null }, changes);
    Object.assign(r.applicant, applicant);
    if (notes) r.notes = { text: notes };
    r.coverage.ntl = ntl;
    return buildPlan(r, amwins, {}).find((s) => s.re === '^filling required$');
  };
  const silent = filing();
  assert.deepEqual([silent.value, silent.source, silent.standard, silent.note], [false, 'standard', true, null]);
  // A USDOT or MC number alone doesn't ask for filings.
  const numbers = filing({}, { applicant: { dot: '1234567', mc: 'MC-765432' } });
  assert.deepEqual([numbers.value, numbers.source], [false, 'standard']);
  // A notes line that names no filing doesn't either.
  assert.equal(filing({}, { notes: 'Hauls general freight. Clean record.' }).value, false);
  // The intake's own answer.
  for (const answer of [true, false]) {
    const s = filing({ filingsRequired: answer, filingsWhich: answer ? 'Federal Liability Filing' : null });
    assert.deepEqual([s.value, s.source, s.standard], [answer, 'derived', false], String(answer));
  }
  // Blank, while the intake asks for filings: the agent's, with what it says.
  // (A notes line naming only an SR-22 is No since R16, in the next test.)
  for (const [changes, notes, says] of [[{ filingsWhich: 'BMC-91' }, null, /"BMC-91"/], [{ filingsWhich: 'BMC-91', needSr22: true }, null, /"BMC-91"/],
    [{}, 'Needs MCS-90 for the broker', /"Needs MCS-90 for the broker"/]]) {
    const s = filing(changes, { notes });
    assert.deepEqual([s.value, s.standard], [null, false], JSON.stringify([changes, notes]));
    assert.match(s.note, says);
  }
  // An SR-22 alone (the intake's SR-22 box): No. It is a state filing, and AmWINS asks about a federal
  // one (TNI, 2026-10-26: answer to PR question). With filings asked for, the intake's Yes stays.
  for (const applicant of [{}, { dot: '1234567' }]) {
    const s = filing({ needSr22: true }, { applicant });
    assert.deepEqual([s.value, s.source, s.standard, s.note], [false, 'standard', true, null], JSON.stringify(applicant));
  }
  assert.deepEqual([filing({ needSr22: true, filingsRequired: true, filingsWhich: 'Federal Liability Filing' }).value, filing({ needSr22: true, filingsRequired: true }).source], [true, 'derived']);
  // Non-Trucking: never this standard; W44-28's No instead (#192).
  assert.equal(filing({}, { ntl: true }).value, false);
});

// TNI, 2026-10-26 (answer to PR question, R16): a notes line or a which-filings box naming only an
// SR-22 or FR-44 (state filings) is No too, as the SR-22 box alone is. One naming anything federal, or
// another filing, stays the agent's; an intake that asks for filings keeps its Yes.
test('AmWINS filing required: a notes line or which-filings box naming only an SR-22 or FR-44 is TNI\'s No (R16)', () => {
  const filing = (changes = {}, { notes = null, ntl = null, applicant = {} } = {}) => {
    const r = baseRecord();
    Object.assign(r.operations, { filingsRequired: null, filingsWhich: null, needSr22: null }, changes);
    Object.assign(r.applicant, applicant);
    if (notes) r.notes = { text: notes };
    r.coverage.ntl = ntl;
    return buildPlan(r, amwins, {}).find((s) => s.re === '^filling required$');
  };
  // Only an SR-22 or FR-44, with words that only describe it: No.
  for (const [changes, notes, applicant] of [
    [{ filingsWhich: 'SR-22' }, null], [{ filingsWhich: 'SR22 / FR-44' }, null], [{ filingsWhich: 'FR-44' }, null], [{ filingsWhich: 'State SR-22 filing' }, null],
    [{}, 'Owner needs an SR-22 filing'], [{}, 'Driver 2 needs an FR44'], [{}, 'Filings: SR-22'], [{}, 'SR-22 and FR-44 filings needed (state filings)'],
    [{ needSr22: true }, 'SR-22 for the owner'], [{ filingsWhich: 'SR-22' }, 'Hauls general freight.\nOwner needs an SR-22 filing'],
    [{}, 'Owner needs an SR-22 filing', { dot: '1234567', mc: 'MC-765432' }],
  ]) {
    const s = filing(changes, { notes, applicant });
    assert.deepEqual([s.value, s.source, s.standard, s.note], [false, 'standard', true, null], JSON.stringify([changes, notes]));
  }
  // Anything federal, or another filing, beside it: the agent's, with what it says (as before R16).
  for (const [changes, notes, says] of [
    [{ filingsWhich: 'SR-22 and MCS-90' }, null, /names filings \("SR-22 and MCS-90"\)/], [{}, 'SR-22 and MCS-90', /"SR-22 and MCS-90"/],
    [{ filingsWhich: 'SR-22, BMC-91' }, null, /"SR-22, BMC-91"/], [{ filingsWhich: 'SR-22 and federal' }, null, /"SR-22 and federal"/],
    [{}, 'FR-44 and BMC-34 cargo', /"FR-44 and BMC-34 cargo"/], [{}, 'SR-22 plus BMC-32', /"SR-22 plus BMC-32"/],
    [{}, 'SR-22 plus ICC filing', /"SR-22 plus ICC filing"/], [{}, 'SR-22 and MC filing', /"SR-22 and MC filing"/], [{}, 'SR-22 and Federal', /"SR-22 and Federal"/],
    [{ filingsWhich: 'SR-22 & Fed.' }, null, /"SR-22 & Fed\."/], [{}, 'SR-22 and interstate', /"SR-22 and interstate"/],
    [{}, 'SR-22 plus other filings', /"SR-22 plus other filings"/],
    // The which-filings box names only an SR-22, but a notes line names a federal filing: that line.
    [{ filingsWhich: 'SR-22' }, 'Needs MCS-90 for the broker', /its notes say "Needs MCS-90 for the broker"/],
    [{}, 'Owner needs SR-22\nBroker wants BMC-91', /its notes say "Broker wants BMC-91"/],
    // (An SR-22 beside a Form E or H, and a state filing with no SR-22 or FR-44 named, were the agent's
    // here until T9 made them No: the T9 tests below.)
  ]) {
    const s = filing(changes, { notes });
    assert.deepEqual([s.value, s.source, s.standard], [null, 'derived', false], JSON.stringify([changes, notes]));
    assert.match(s.note, says);
  }
  // An intake that asks for filings keeps its Yes, also naming only an SR-22.
  for (const changes of [{ filingsRequired: true, filingsWhich: 'SR-22' }, { filingsRequired: true }]) {
    const s = filing(changes, { notes: 'Owner needs an SR-22 filing' });
    assert.deepEqual([s.value, s.source, s.standard], [true, 'derived', false], JSON.stringify(changes));
  }
  // A notes line about something else entirely changes nothing.
  assert.deepEqual([filing({}, { notes: 'Hauls general freight. Clean record.' }).value, filing({ filingsWhich: 'BMC-91' }, { notes: 'Hauls general freight.' }).value], [false, null]);
  // Non-Trucking: never this standard; W44-28's No instead (#192).
  assert.equal(filing({ filingsWhich: 'SR-22' }, { ntl: true }).value, false);
});

// TNI, 2026-10-26 (answer to PR question, T9): with "filings required" blank, four more texts in the
// which-filings box or a notes line are TNI's No (`standard`, as R16's) on AmWINS' "Is a Federal Filing
// Required?": an SR-22 beside a Form E or H; "State filing" or "Intrastate" alone; an SR-22 beside an MC
// number on the same line; "SR-22 and filings". Anything federal beside them stays the agent's, quoted;
// an intake that asks for filings keeps its Yes; a Non-Trucking quote is never this standard.
const amwinsFiling = (changes = {}, { notes = null, ntl = null } = {}) => {
  const r = baseRecord();
  Object.assign(r.operations, { filingsRequired: null, filingsWhich: null, needSr22: null }, changes);
  if (notes) r.notes = { text: notes };
  r.coverage.ntl = ntl;
  return buildPlan(r, amwins, {}).find((s) => s.re === '^filling required$');
};
const filingTniNo = (cases) => {
  for (const [changes, notes] of cases) {
    const s = amwinsFiling(changes, { notes });
    assert.deepEqual([s.value, s.source, s.standard, s.note], [false, 'standard', true, null], JSON.stringify([changes, notes]));
  }
};
const filingAgents = (cases) => {
  for (const [changes, notes, says] of cases) {
    const s = amwinsFiling(changes, { notes });
    assert.deepEqual([s.value, s.source, s.standard], [null, 'derived', false], JSON.stringify([changes, notes]));
    assert.match(s.note, says);
  }
};
const filingKept = (text) => {
  for (const [changes, notes] of [[{ filingsRequired: true, filingsWhich: text }, null], [{ filingsRequired: true }, text]]) {
    const s = amwinsFiling(changes, { notes });
    assert.deepEqual([s.value, s.source, s.standard], [true, 'derived', false], `filings asked for: ${JSON.stringify([changes, notes])}`);
  }
  assert.equal(amwinsFiling({ filingsWhich: text }, { ntl: true }).value, false, `NTL, W44-28's No (#192): ${text}`);
};

test('AmWINS filing required: an SR-22 beside a Form E or H is TNI\'s No (T9)', () => {
  filingTniNo([[{ filingsWhich: 'SR-22 and Form E' }, null], [{ filingsWhich: 'SR-22, Form H' }, null], [{ filingsWhich: 'SR22 / Form E / Form H' }, null],
    [{ filingsWhich: 'FR-44 and Forms E and H' }, null], [{}, 'Owner needs an SR-22 and a Form E filing'], [{}, 'SR-22 plus Form H'], [{ needSr22: true }, 'SR-22, Form E/H']]);
  // Anything federal beside them: the agent's. (A Form E or H with no SR-22 or FR-44 named is No
  // since V12: the V12 tests below.)
  filingAgents([[{ filingsWhich: 'SR-22, Form E and MCS-90' }, null, /names filings \("SR-22, Form E and MCS-90"\)/], [{}, 'SR-22 and Form H, BMC-91', /its notes say "SR-22 and Form H, BMC-91"/]]);
  filingKept('SR-22 and Form E');
});

test('AmWINS filing required: "State filing" or "Intrastate" alone is TNI\'s No (T9)', () => {
  filingTniNo([[{ filingsWhich: 'State filing' }, null], [{ filingsWhich: 'State filings' }, null], [{ filingsWhich: 'Intrastate' }, null], [{ filingsWhich: 'Intrastate filing' }, null],
    [{ filingsWhich: 'Intra-state' }, null], [{}, 'Needs a state filing'], [{}, 'Intrastate filings only']]);
  // Anything federal or another filing beside them: the agent's. (A lone "State", and a state filing
  // beside a Form E or H, are No since V12: the V12 tests below.)
  filingAgents([[{ filingsWhich: 'State and federal filings' }, null, /"State and federal filings"/], [{ filingsWhich: 'Intrastate and interstate' }, null, /"Intrastate and interstate"/],
    [{}, 'State filing, BMC-91', /"State filing, BMC-91"/], [{}, 'State filing and other filings', /"State filing and other filings"/]]);
  filingKept('State filing');
});

test('AmWINS filing required: an SR-22 beside an MC number on the same line is TNI\'s No (T9)', () => {
  filingTniNo([[{}, 'SR-22, MC 123456'], [{}, 'Owner needs an SR-22 filing. MC# 123456'], [{ filingsWhich: 'SR-22 / MC-123456' }, null], [{ filingsWhich: 'MC number 123456, SR22' }, null],
    [{}, 'Hauls general freight.\nFR-44 - MC123456']]);
  // An MC filing beside it, with or without the number, and anything else federal: the agent's.
  filingAgents([[{}, 'SR-22, MC 123456, needs MCS-90', /"SR-22, MC 123456, needs MCS-90"/], [{}, 'SR-22, MC 123456 filing', /"SR-22, MC 123456 filing"/],
    [{ filingsWhich: 'SR-22, MC filing' }, null, /"SR-22, MC filing"/], [{}, 'SR-22, MC 123456, interstate', /"SR-22, MC 123456, interstate"/]]);
  filingKept('SR-22, MC 123456');
});

test('AmWINS filing required: "SR-22 and filings" is TNI\'s No (T9)', () => {
  filingTniNo([[{ filingsWhich: 'SR-22 and filings' }, null], [{}, 'SR-22 and filings'], [{}, 'SR22 & filings needed'], [{ filingsWhich: 'FR-44 and filings' }, null],
    [{}, 'SR-22 for the owner and filings'], [{ filingsWhich: 'SR-22, Form E, MC 123456 and filings' }, null]]);
  // Other, federal or named filings beside it: the agent's. A bare "filings" with no SR-22 or FR-44
  // named isn't settled by T9 or V12: the agent's, as before. ("filings" before the SR-22, or
  // "additional filings", is No since V12: the V12 tests below.)
  filingAgents([[{ filingsWhich: 'SR-22 and other filings' }, null, /"SR-22 and other filings"/], [{}, 'SR-22 and federal filings', /"SR-22 and federal filings"/],
    [{}, 'SR-22 and filings, MCS-90', /"SR-22 and filings, MCS-90"/], [{}, 'SR-22 and BMC-91 filings', /"SR-22 and BMC-91 filings"/],
    [{ filingsWhich: 'Filings' }, null, /"Filings"/], [{}, 'Filings needed', /"Filings needed"/]]);
  filingKept('SR-22 and filings');
});

// TNI, 2026-10-27 (answer to PR question V12): with "filings required" blank, the cases T9 left to the
// agent are state filings too, so TNI's No (`standard`, as T9's) on AmWINS' "Is a Federal Filing
// Required?": a Form E or H with no SR-22 or FR-44 named; a lone "State" in the which-filings box; a
// state filing or intrastate beside the client's MC number; a bare or "additional" "filings" before or
// after the SR-22. Anything federal beside them stays the agent's, quoted; an intake that asks for
// filings keeps its Yes; a Non-Trucking quote is never this standard. FR-44 counts as SR-22 throughout
// (V13, confirmed).
test('AmWINS filing required: a Form E or H with no SR-22 or FR-44 named is TNI\'s No (V12)', () => {
  filingTniNo([[{ filingsWhich: 'Form E' }, null], [{}, 'Needs a Form H filing'], [{ filingsWhich: 'State filing and Form E' }, null], [{ filingsWhich: 'Form H' }, null],
    [{ filingsWhich: 'Forms E and H' }, null], [{}, 'Form E filing for the state'], [{ filingsWhich: 'Intrastate, Form E' }, null], [{ filingsWhich: 'FR-44, Form E' }, null]]);
  // Anything federal or another filing beside them: the agent's.
  filingAgents([[{ filingsWhich: 'Form E and MCS-90' }, null, /names filings \("Form E and MCS-90"\)/], [{}, 'Form H, BMC-91', /its notes say "Form H, BMC-91"/],
    [{ filingsWhich: 'Form E and federal filings' }, null, /"Form E and federal filings"/], [{}, 'Form E, interstate', /"Form E, interstate"/],
    [{ filingsWhich: 'Form E and other filings' }, null, /"Form E and other filings"/], [{}, 'Form H, MC filing', /"Form H, MC filing"/],
    [{ filingsWhich: 'State filing, Form E and BMC-34' }, null, /"State filing, Form E and BMC-34"/]]);
  filingKept('Form E');
});

test('AmWINS filing required: a lone "State" in the which-filings box is TNI\'s No (V12)', () => {
  filingTniNo([[{ filingsWhich: 'State' }, null], [{ filingsWhich: 'state' }, null], [{ filingsWhich: ' STATE ' }, null], [{ filingsWhich: 'State.' }, null]]);
  // "State" beside anything federal, or in another phrase, doesn't make the box No: the agent's.
  filingAgents([[{ filingsWhich: 'State and federal filings' }, null, /"State and federal filings"/], [{ filingsWhich: 'United States DOT' }, null, /"United States DOT"/],
    [{ filingsWhich: 'State, MCS-90' }, null, /"State, MCS-90"/], [{ filingsWhich: 'State and interstate' }, null, /"State and interstate"/],
    [{ filingsWhich: 'State and federal' }, null, /"State and federal"/], [{ filingsWhich: 'Interstate' }, null, /"Interstate"/],
    [{ filingsWhich: 'State' }, 'Broker wants BMC-91', /its notes say "Broker wants BMC-91"/]]);
  filingKept('State');
});

test('AmWINS filing required: "State filing" or "Intrastate" beside an MC number is TNI\'s No (V12)', () => {
  filingTniNo([[{}, 'State filing, MC 123456'], [{ filingsWhich: 'Intrastate, MC# 123456' }, null], [{}, 'Hauls general freight.\nIntrastate filing - MC-123456'],
    [{ filingsWhich: 'MC number 123456, state filing' }, null], [{}, 'FR44, state filing, MC 123456']]);
  // An MC filing beside it, with or without the number, and anything else federal: the agent's.
  filingAgents([[{}, 'State filing, MC 123456 filing', /"State filing, MC 123456 filing"/], [{ filingsWhich: 'Intrastate, MC filing' }, null, /"Intrastate, MC filing"/],
    [{}, 'State filing, MC 123456, interstate', /"State filing, MC 123456, interstate"/], [{}, 'State filing, MC 123456, BMC-91', /"State filing, MC 123456, BMC-91"/],
    [{ filingsWhich: 'State and federal filings, MC 123456' }, null, /"State and federal filings, MC 123456"/]]);
  filingKept('State filing, MC 123456');
});

test('AmWINS filing required: a bare or "additional" "filings" before or after the SR-22 or FR-44 is TNI\'s No (V12, V13)', () => {
  filingTniNo([[{}, 'Filings and SR-22'], [{}, 'SR-22 and additional filings'], [{ filingsWhich: 'Filings and FR-44' }, null], [{ filingsWhich: 'FR-44 and additional filings' }, null],
    [{}, 'Additional filings and SR-22'], [{ filingsWhich: 'Filings, SR22' }, null], [{}, 'Needs filings & FR44'], [{ filingsWhich: 'Filings / SR-22 / Form E' }, null]]);
  // Other, federal or named filings, before or after it: the agent's.
  filingAgents([[{}, 'Other filings and SR-22', /"Other filings and SR-22"/], [{ filingsWhich: 'Federal filings and SR-22' }, null, /"Federal filings and SR-22"/],
    [{}, 'Filings and SR-22, MCS-90', /"Filings and SR-22, MCS-90"/], [{}, 'BMC-91 filings and FR-44', /"BMC-91 filings and FR-44"/],
    [{}, 'MC filings and SR-22', /"MC filings and SR-22"/], [{}, 'SR-22 and additional federal filings', /"SR-22 and additional federal filings"/],
    [{ filingsWhich: 'FR-44 and other filings' }, null, /"FR-44 and other filings"/], [{ filingsWhich: 'Additional filings' }, null, /"Additional filings"/]]);
  filingKept('Filings and SR-22');
  filingKept('FR-44 and additional filings');
});

// The same texts on Progressive (T9 counterexample): its "Are state or federal filings required?"
// (`CA`) asks about state filings too, so the which-filings box naming any of them still leaves a
// blank to the agent, as before T9. (Progressive doesn't read the notes for this question.)
test('Progressive filings required: T9\'s texts in the which-filings box stay the agent\'s (state or federal)', () => {
  // V12's texts too (TNI, 2026-10-27: Progressive unchanged).
  for (const which of ['SR-22 and Form E', 'State filing', 'Intrastate', 'SR-22, MC 123456', 'SR-22 and filings',
    'Form E', 'State', 'State filing, MC 123456', 'Filings and SR-22', 'SR-22 and additional filings', 'Filings and FR-44']) {
    const r = baseRecord();
    Object.assign(r.operations, { filingsRequired: null, filingsWhich: which, needSr22: null });
    const s = byQ(buildPlan(r, progressive, {}), 'CA');
    assert.deepEqual([s.value, s.source, s.standard], [null, 'derived', false], which);
    assert.match(s.note, new RegExp(`names filings \\("${which}"\\)`));
  }
});

// TNI's AmWINS coverage standards, recorded as TNI's on 2026-10-26 (W44-32: "limits are fine").
test('AmWINS towing $75, rental $40 a day ($1,200), uninsured motorists Yes at $100K are TNI standards (W44-32)', () => {
  const plan = buildPlan(baseRecord(), amwins, {});
  for (const [find, value] of [[(s) => s.selector === '#towingAndLaborReimbursement', '$75'], [(s) => /^Rental reimbursement \(/.test(s.name), '$40 day / $1,200 total'],
    [(s) => s.re === '^uninsured motorists$', true], [(s) => s.selector === '#uninsuredMotoristsLimit', '$100K']]) {
    const s = plan.find(find);
    assert.deepEqual([s.value, s.source, s.standard], [value, 'standard', true], s.name);
  }
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
  // The anti-theft device (2BAC) is TNI's None when the lookup leaves it empty (W44-32, below).
  for (const q of ['2BA1', '2BAE']) {
    assert.equal(byQ(plan, q).ignore, true, q);
    assert.match(byQ(plan, q).emptyNote, /VIN lookup/);
  }
  assert.equal(byQ(plan, '1DB8').value, 'Not Selected');
  assert.equal(byQ(plan, '1E8D').value, '$10k w/ $0 Deductible');
  assert.equal(byQ(plan, '1E8D').ignore, false);
  // PIP shares its data-model name across states. TX (TNI, 2026-10-26, W44-26: Medical Payments
  // $5,000 wherever offered, PIP not selected unless the state requires it): Progressive offers
  // medical payments there, so PIP is Not Selected (its list: Not Selected, $2,500 to $25,000).
  const tx = byQ(buildPlan({ ...record, garaging: { ...record.garaging, state: 'TX' } }, progressive, {}), '1E8D');
  assert.deepEqual([tx.value, tx.source, tx.standard, tx.ignore, tx.emptyNote], ['Not Selected', 'standard', true, false, null], 'TX: not selected');
  assert.equal(byQ(buildPlan({ ...record, garaging: { ...record.garaging, state: 'TX' } }, progressive, {}), '1FE4').value, '$5,000 per person', 'TX: medical payments instead');
  // Counterexamples: Maryland (its PIP is its own list, 1E7C, below), Utah (PIP required, "$3k
  // Basic" its only option, no medical payments: it stays), Kentucky (base PIP required there:
  // Progressive's stays; TNI, 2026-10-26: answers to PR questions) and a state without PIP keep
  // Progressive's, as before.
  for (const state of ['MD', 'KY', 'UT', 'IA']) {
    const other = byQ(buildPlan({ ...record, garaging: { ...record.garaging, state } }, progressive, {}), '1E8D');
    assert.deepEqual([other.value, other.ignore], [null, true], state);
    assert.match(other.emptyNote, /Florida, Texas and Arkansas only/, `${state}: an empty PIP goes to the agent`);
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
    assert.match(other.emptyNote, /Florida, Texas and Arkansas only/, state);
  }
  // Maryland's PIP list (Not selected, $2,500 Full PIP, $2,500 Guest PIP; found by its option, its
  // box has no question text): Progressive's MD page offers no medical payments, so W44-26 gives PIP
  // $2,500, and it is "$2,500 Full PIP", not Guest PIP (TNI, 2026-10-26: answer to PR question).
  const md = byQ(buildPlan({ ...record, garaging: { ...record.garaging, state: 'MD' } }, progressive, {}), '1E7C');
  assert.deepEqual([md.value, md.source, md.standard, md.ignore, md.withOption], ['$2,500 Full PIP', 'standard', true, false, '$2,500 Full PIP'], 'MD: Full PIP');
  // Counterexample: another state showing this list (none captured so far) keeps Progressive's choice.
  for (const state of ['FL', 'TX', 'KY', 'UT']) {
    const other = byQ(buildPlan({ ...record, garaging: { ...record.garaging, state } }, progressive, {}), '1E7C');
    assert.deepEqual([other.value, other.ignore], [null, true], `${state}: 1E7C as Progressive set it`);
  }
  // Guest and Optional Personal Injury Protection (KY live run, 2026-10-26: no rule knew them, and
  // Guest PIP was left required and empty): Not selected (TNI, 2026-10-26, W44-32), in every state.
  for (const state of ['KY', 'FL', 'TX']) {
    const p = buildPlan({ ...record, garaging: { ...record.garaging, state } }, progressive, {});
    for (const [field, ask] of [['LineInput.GuestPIPLimit', 'Guest Personal Injury Protection'], ['LineInput.OptionalPIPLimit', 'Optional Personal Injury Protection']]) {
      const s = p.find((x) => x.field === field);
      assert.deepEqual([s?.value, s?.source, s?.standard, s?.ignore, s?.ask], ['Not selected', 'standard', true, false, [ask]], `${state} ${field}`);
    }
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
  // Recalculate and the bill plan wait for the liability limit; Print follows the bill plan and
  // doesn't re-check the limit on the reloaded Rates page (FL/NJ runs).
  for (const id of ['recalculate', 'billPlan']) assert.deepEqual(plan.find((s) => s.action === id).after, ['coverage.autoLiabLimit'], id);
  const printStep = plan.find((s) => s.action === 'print');
  assert.deepEqual([printStep.after, printStep.afterActions], [[], ['billPlan']], 'Print needs our bill plan click');
  const gl = structuredClone(baseRecord());
  gl.coverage.gl = true;
  const glPrint = buildPlan(gl, progressive, {}).find((s) => s.action === 'print');
  assert.deepEqual([glPrint.after, glPrint.afterActions], [[], ['billPlan']], 'with GL too, Print follows our bill plan, which checked the limit');
  assert.deepEqual(plan.find((s) => s.action === 'print').afterPages, ['ChangePaymentPlan']);
});

test('the owner with a two-word surname is matched to their driver row (date of birth)', () => {
  const record = baseRecord();
  record.applicant.owner1 = 'Sample Vinicius Testa Examplo';
  record.drivers = [{ first: 'Sample Vinicius', middle: null, last: 'Testa Examplo', dob: '01/02/1980' }];
  assert.equal(owner(record).driver?.dob, '01/02/1980');
  record.applicant.owner1 = 'Sample Examplo';
  assert.equal(owner(record).driver?.dob, '01/02/1980', 'surname word matches the last-name box');
  // Another first name is another name: the row gives no name (it is still the owner's row, the
  // first: TNI, 2026-10-27, answer to PR question V4; before, no row at all).
  record.applicant.owner1 = 'Alice Smith';
  record.drivers = [{ first: 'Bob', middle: null, last: 'Jones Smith', dob: '01/02/1980' }];
  assert.deepEqual([owner(record).named, owner(record).first, owner(record).driver], [null, 'Alice', record.drivers[0]], 'a shared surname word with another first name is another name');
  record.drivers = [{ first: 'Bob', middle: null, last: 'Smith', dob: '01/02/1980' }];
  assert.deepEqual([owner(record).named, owner(record).first], [null, 'Alice'], 'the same one-word surname with another first name is another name (audit 2026-10-08)');
});

// TNI, 2026-10-26 (W44-25): "Owner Drivers if not excluded, in every case".
test('owner is a driver (29F): blank is TNI\'s Yes; the intake\'s No, or an owner marked excluded, is No', () => {
  const step = (change) => {
    const record = baseRecord();
    record.drivers.push({ first: 'Casey', middle: null, last: 'Example', dob: '07/09/1995', licenseNumber: 'MD7654321', licenseState: 'MD' });
    change(record);
    const s = byQ(buildPlan(record, progressive), '29F');
    return [s.value, s.source, s.standard, s.manualOnly, s.note];
  };
  assert.deepEqual(step((r) => { r.applicant.ownerDrives = null; }), [true, 'standard', true, false, null], 'blank: TNI\'s standard Yes');
  assert.deepEqual(step(() => {}), [true, 'intake', false, false, null], 'the intake\'s Yes');
  assert.deepEqual(step((r) => { r.applicant.ownerDrives = false; }), [false, 'intake', false, false, null], 'the intake\'s No stays No');
  // Another driver marked excluded: still the owner's Yes.
  assert.deepEqual(step((r) => { r.applicant.ownerDrives = null; r.drivers[1].excluded = true; }), [true, 'standard', true, false, null]);
  // The owner's own row marked excluded: not a driver, No, from the exclusion.
  assert.deepEqual(step((r) => { r.applicant.ownerDrives = null; r.drivers[0].excluded = true; }), [false, 'derived', false, false, null]);
  assert.deepEqual(step((r) => { r.applicant.ownerDrives = false; r.drivers[0].excluded = true; }), [false, 'intake', false, false, null]);
  // The intake's Yes with the owner's row excluded: No, with a warning to confirm.
  const record = baseRecord();
  record.drivers[0].excluded = true;
  const both = byQ(buildPlan(record, progressive), '29F');
  assert.deepEqual([both.value, both.source], [false, 'derived']);
  assert.match(both.warn, /says the owner drives.*excluded/);
  // A blank box with an owner no driver row matches: still TNI's Yes (the Intake step warns).
  assert.deepEqual(step((r) => { r.applicant.ownerDrives = null; r.applicant.owner1 = 'Jordan Sample'; }), [true, 'standard', true, false, null]);
});

// TNI, 2026-10-26 (answer to PR question): the owner's name matched two driver rows (a Sr and a Jr)
// and only one was marked excluded: whether the owner drives was the agent's, with the reason. TNI,
// 2026-10-27 (answer to PR question V4) replaces it: the owner is the first row, whose mark decides.
test('owner is a driver (29F): the owner\'s name on two driver rows, one excluded: the first row decides (V4 replaces the agent\'s)', () => {
  const step = (box, excluded) => {
    const record = baseRecord();
    const senior = record.drivers[0];
    record.applicant.ownerDrives = box;
    record.drivers = [{ ...senior, excluded: excluded[0] }, { ...senior, suffix: 'Jr', dob: '03/04/2004', licenseNumber: 'MD7654321', excluded: excluded[1] }];
    const s = byQ(buildPlan(record, progressive), '29F');
    return [s.value, s.source, s.manualOnly, s.note];
  };
  for (const box of [null, true]) {
    assert.deepEqual(step(box, [true, false]), [false, 'derived', false, null], `box ${box}: the first row marked`);
    assert.deepEqual(step(box, [false, true]), [true, box ? 'intake' : 'standard', false, null], `box ${box}: the Jr marked`);
  }
  // The intake's No stands.
  assert.deepEqual(step(false, [true, false]), [false, 'intake', false, null]);
  // Counterexamples: none excluded keeps the standard Yes; both excluded keeps No.
  assert.deepEqual(step(null, [false, false]), [true, 'standard', false, null]);
  assert.deepEqual(step(null, [true, true]), [false, 'derived', false, null]);
});

// TNI, 2026-10-27: Progressive's president/CEO daily-operations checkbox is Yes when the owner
// drives and isn't excluded; No otherwise.
test('owner daily operations (2D7): Yes when the owner drives; No otherwise', () => {
  const daily = (box, excluded = false) => {
    const r = baseRecord();
    r.applicant.ownerDrives = box;
    if (excluded) r.drivers[0].excluded = true;
    return byQ(buildPlan(r, progressive), '2D7');
  };
  const said = (s) => [s.value, s.source, s.manualOnly, s.note];
  assert.deepEqual(said(daily(true)), [true, 'derived', false, null]);
  assert.deepEqual(said(daily(null)), [true, 'standard', false, null], 'blank box: TNI\'s Yes');
  assert.deepEqual(said(daily(false)), [false, 'derived', false, null]);
  assert.deepEqual(said(daily(null, true)), [false, 'derived', false, null]);
  assert.match(daily(true, true).warn ?? '', /marks their driver row excluded/, 'says Yes, excluded: warned');
  assert.equal(daily(true).warn ?? null, null);
});

// TNI, 2026-10-26 (answer to PR question, R1): "owner drives" says only whether the owner drives; if
// the owner's row is marked Excluded, or the answer is No, the owner is excluded. The intake's No
// makes the owner's driver row (the first: V4) an excluded driver, as an "Excluded" mark does: the
// exclude question (28C1) is Yes for it. The record keeps the row as read.
test('owner drives No: the owner\'s driver row is excluded (28C1 Yes); blank, Yes, the agent\'s No and other drivers unchanged', () => {
  const record = (box, change = () => {}) => {
    const r = baseRecord();
    r.applicant.ownerDrives = box;
    r.drivers.push({ first: 'Casey', middle: null, last: 'Example', dob: '07/09/1995', licenseNumber: 'MD7654321', licenseState: 'MD' });
    change(r);
    return r;
  };
  const exclude = (r, drivers) => byQ(buildPlan(r, progressive, { drivers }), '28C1');
  const got = (s) => [s.value, s.source, s.manualOnly, s.note];
  const no = record(false);
  assert.deepEqual(got(exclude(no, 0)), [true, 'derived', false, null], 'the owner\'s row: excluded');
  assert.deepEqual(got(exclude(no, 1)), [false, 'derived', false, null], 'another driver: never');
  assert.ok(exclude(no, 0).from.includes('applicant.ownerDrives'), 'its evidence: the owner-drives box');
  assert.equal(no.drivers[0].excluded, undefined, 'the record keeps the row as read');
  // The owner-driver question stays the intake's No.
  const owner29F = byQ(buildPlan(no, progressive), '29F');
  assert.deepEqual([owner29F.value, owner29F.source, owner29F.note, owner29F.warn], [false, 'intake', null, null]);
  // Counterexamples: a blank box or the intake's Yes, the owner's row unmarked: a listed driver.
  for (const box of [null, true]) assert.deepEqual([exclude(record(box), 0).value, exclude(record(box), 1).value], [false, false], String(box));
  // The agent's No for the owner's row in client details stands.
  assert.equal(exclude(record(false, (r) => { r.drivers[0].excluded = false; }), 0).value, false);
  // No with an owner no driver row's name matches: the first row is the owner's all the same (TNI,
  // 2026-10-27: answer to PR question V4; before, nobody was excluded).
  const other = record(false, (r) => { r.applicant.owner1 = 'Jordan Sample'; });
  assert.deepEqual([exclude(other, 0).value, exclude(other, 1).value], [true, false]);
  // The owner's name on two rows (a Sr and a Jr), only one marked excluded: with the intake's No the
  // No decides, so there is no mixed case (TNI, 2026-10-26: answer to PR question, R1). 29F is the
  // intake's No without the mixed-rows note. The No excludes only the owner's row, the first (V4;
  // before, T2's row with exactly the owner's full name, the first here too); the Jr is excluded by
  // their own mark only.
  for (const [marked, excluded] of [[0, [true, false, false]], [1, [true, true, false]]]) {
    const family = baseRecord();
    family.applicant.ownerDrives = false;
    const senior = family.drivers[0];
    family.drivers = [{ ...senior, excluded: null }, { ...senior, suffix: 'Jr', dob: '03/04/2004', licenseNumber: 'MD7654321', excluded: null },
      { first: 'Casey', middle: null, last: 'Example', dob: '07/09/1995', licenseNumber: 'MD1112223', licenseState: 'MD', excluded: null }];
    family.drivers[marked].excluded = true;
    const s = byQ(buildPlan(family, progressive), '29F');
    assert.deepEqual([s.value, s.source, s.manualOnly, s.note], [false, 'intake', false, null], `row ${marked} marked`);
    assert.deepEqual([0, 1, 2].map((i) => exclude(family, i).value), excluded, `row ${marked} marked`);
  }
});

// TNI, 2026-10-26 (answer to PR question, T3), the intake's "owner drives" No: the owner's date of
// birth comes from the owner's row (T3, asked of GEICO: Progressive asks it too, on Business Owner
// Info and NoHit; V2, 2026-10-27: confirmed). The owner's row is the first (V4, 2026-10-27, which
// replaces T2's row by the owner's exact full name, and the agent's with none: the test after this
// one has the Sr, Jr and other-name cases).
test('owner drives No (T3, V2): the owner\'s date of birth from the owner\'s row, the first; the agent\'s No on it leaves it the agent\'s', () => {
  const casey = { first: 'Casey', middle: null, last: 'Example', dob: '07/09/1995', licenseNumber: 'MD1112223', licenseState: 'MD' };
  const record = (drivers, box = false) => {
    const r = baseRecord();
    r.applicant.ownerDrives = box;
    r.drivers = drivers;
    return r;
  };
  const senior = baseRecord().drivers[0];
  const exclude = (r, drivers) => byQ(buildPlan(r, progressive, { drivers }), '28C1');
  const dob = (r) => ['2BB', '1B8B'].map((q) => byQ(buildPlan(r, progressive), q));
  const r = record([senior, casey]);
  assert.deepEqual([0, 1].map((i) => [exclude(r, i).value, exclude(r, i).source, exclude(r, i).note]), [[true, 'derived', null], [false, 'derived', null]]);
  assert.deepEqual(dob(r).map((s) => [s.value, s.source, s.note]), [['01/02/1980', 'derived', null], ['01/02/1980', 'derived', null]]);
  // The agent's No on the owner's row (client details): not excluded, and the date of birth is theirs.
  const corrected = record([{ ...senior, excluded: false }, casey]);
  assert.deepEqual([exclude(corrected, 0).value, dob(corrected)[0].value, dob(corrected)[0].manualOnly], [false, null, true]);
  assert.match(dob(corrected)[0].note, /owner doesn't drive/);
});

// TNI, 2026-10-27 (answers to PR questions V4, V3, V2): the owner is always the first driver on the
// intake's list, Sr or Jr regardless, on Progressive and AmWINS too. The owner's date of birth (V2:
// T3 holds on both, confirmed), the "Excluded" mark and the exclusion under the box's No come from
// the first row; the rows after it are ordinary drivers, even with the owner's name. V3: the first
// row marked Excluded over a blank box or a Yes stays an excluded driver here (28C1 Yes, "(Excluded)"
// after the license number on AmWINS), as T1 left them; only GEICO leaves it out.
test('the owner is the first driver (V4) on Progressive and AmWINS: date of birth (V2) and exclusion from row 1; V3 keeps the marked row excluded', () => {
  const owner = baseRecord().drivers[0];
  const casey = { first: 'Casey', middle: null, last: 'Example', dob: '07/09/1995', licenseNumber: 'MD1112223', licenseState: 'MD' };
  const riley = { first: 'Riley', middle: null, last: 'Sample', dob: '11/12/1985', licenseNumber: 'KS1112223', licenseState: 'KS' };
  const senior = { ...owner, suffix: 'Sr' };
  const junior = { ...owner, suffix: 'Jr', dob: '03/04/2004', licenseNumber: 'MD7654321' };
  const twin = { ...owner, dob: '05/06/1990', licenseNumber: 'MD2223334' };
  const record = (drivers, box) => {
    const r = baseRecord();
    r.applicant.ownerDrives = box;
    r.drivers = drivers.map((d) => ({ ...d }));
    return r;
  };
  const exclude = (r, i) => byQ(buildPlan(r, progressive, { drivers: i }), '28C1').value;
  const dob = (r) => [byQ(buildPlan(r, progressive), '2BB').value, byQ(buildPlan(r, progressive), '1B8B').value, buildPlan(r, amwins).find((s) => s.selector === '#ownerDob').value];
  const license = (r, i) => buildPlan(r, amwins, { drivers: i }).find((s) => s.path === `drivers[${i}].licenseNumber`).value;
  const drives = (r) => { const s = byQ(buildPlan(r, progressive), '29F'); return [s.value, s.source, s.note]; };
  const cases = [
    ['Sr first, Jr second', [senior, junior], '01/02/1980'],
    ['Jr first, Sr second', [junior, senior], '03/04/2004'],
    ['a first row with another name', [riley, casey], '11/12/1985'],
    ['the owner\'s name on row 2 only', [casey, owner], '07/09/1995'],
    ['two rows with the owner\'s exact name', [owner, twin], '01/02/1980'],
  ];
  for (const [why, drivers, ownerDob] of cases) {
    for (const box of [null, true, false]) assert.deepEqual(dob(record(drivers, box)), [ownerDob, ownerDob, ownerDob], `${why}, box ${box}`);
    // The intake's No: the first row is excluded, the second is a driver like any other.
    const no = record(drivers, false);
    assert.deepEqual([exclude(no, 0), exclude(no, 1)], [true, false], why);
    assert.deepEqual([license(no, 0), license(no, 1)], [`${drivers[0].licenseNumber} (Excluded)`, drivers[1].licenseNumber], why);
    // A blank box: nobody excluded, and the owner a driver (TNI's Yes).
    assert.deepEqual([exclude(record(drivers, null), 0), exclude(record(drivers, null), 1)], [false, false], why);
    assert.deepEqual(drives(record(drivers, null)), [true, 'standard', null], why);
  }
  // The owner's names stay the owner box's when the first row carries another name.
  const other = buildPlan(record([riley, casey], true), progressive);
  assert.deepEqual([byQ(other, '295').value, byQ(other, '297').value], ['Amina', 'Kone']);
  // "Excluded" is the first row's: a later row with the owner's name marked excluded is an ordinary
  // excluded driver, and the owner still drives (V4 replaces the 2026-10-26 answer for several rows).
  const markedJr = record([senior, { ...junior, excluded: true }], null);
  assert.deepEqual([drives(markedJr), exclude(markedJr, 0), exclude(markedJr, 1)], [[true, 'standard', null], false, true]);
  // V3: the first row marked Excluded over a blank box or a Yes: still an excluded driver here.
  for (const box of [null, true]) {
    const r = record([{ ...owner, excluded: true }, casey], box);
    assert.deepEqual([exclude(r, 0), exclude(r, 1), license(r, 0), license(r, 1)], [true, false, 'MD1234567 (Excluded)', 'MD1112223'], String(box));
    assert.deepEqual(drives(r).slice(0, 2), [false, 'derived'], String(box));
  }
  // No driver rows: no owner row, so the owner's date of birth is the agent's (unchanged).
  for (const box of [null, false]) {
    const none = record([], box);
    assert.deepEqual(dob(none), [null, null, null], String(box));
    assert.equal(byQ(buildPlan(none, progressive), '2BB').manualOnly, true);
  }
});

// Audit 2026-10-08: owner "Alice Sample" who doesn't drive took the first name and date of birth
// of the sole driver "Bob Sample" (through the surname-only match), on both carriers. The names
// still never come from another person's row. The date of birth does since TNI, 2026-10-27 (answer
// to PR question V4): "The owner is always the first driver on the intake's driver list", whatever
// its name (the Intake step says so: drivers.owner-name-differs). Before, an owner no row's name
// matched got none, with a warning (TNI, 2026-10-20: never another driver's).
test('the owner\'s names are never another person\'s; the first driver row is the owner\'s, for the date of birth (V4)', () => {
  const record = baseRecord();
  record.applicant.owner1 = 'Alice Sample';
  record.applicant.ownerDrives = false;
  record.drivers = [{ first: 'Bob', middle: null, last: 'Sample', dob: '01/02/1990' }];
  let o = owner(record);
  assert.deepEqual([o.driver, o.named, o.first, o.last], [null, null, 'Alice', 'Sample']);
  let plan = buildPlan(record, progressive);
  assert.equal(byQ(plan, '295').value, 'Alice');
  assert.equal(byQ(plan, '297').value, 'Sample');
  assert.equal(byQ(plan, '2BB').value, '01/02/1990', 'the first row\'s, the owner\'s (V4, T3)');
  record.applicant.ownerDrives = true;
  o = owner(record);
  assert.deepEqual([o.driver, o.named, o.first], [record.drivers[0], null, 'Alice'], 'the owner drives: the first row, but not its name');
  // The date of birth: the first row's, on both carriers.
  for (const q of ['2BB', '1B8B']) assert.deepEqual([byQ(buildPlan(record, progressive), q).value, byQ(buildPlan(record, progressive), q).note], ['01/02/1990', null], q);
  assert.equal(buildPlan(record, amwins).find((s) => s.selector === '#ownerDob').value, '01/02/1990');
  assert.equal(buildPlan(record, amwins).find((s) => s.selector === '#ownerName').value, 'Alice Sample');
  // No driver rows: the agent's, with the warning (unchanged).
  record.drivers = [];
  for (const q of ['2BB', '1B8B']) {
    const step = byQ(buildPlan(record, progressive), q);
    assert.deepEqual([step.value, step.manualOnly], [null, true], q);
    assert.match(step.note, /The intake lists no drivers, so no driver row gives the owner.s date of birth/, q);
  }
  record.drivers = [{ first: 'Alice', middle: null, last: 'Sample', dob: '03/04/1985' }];
  assert.equal(owner(record).named?.dob, '03/04/1985', 'the exact full name gives the name too');
  record.applicant.ownerDrives = false;
  assert.equal(owner(record).driver, null, 'an owner who doesn\'t drive is not a driver row, even by full name');
  // ... but their own row gives their date of birth (TNI, 2026-10-26: answer to PR question, T3).
  assert.equal(byQ(buildPlan(record, progressive), '2BB').value, '03/04/1985');
  // The owner box holding only the first name still takes the rest of the name from the row, unless
  // the intake says the owner doesn't drive.
  record.applicant.owner1 = 'Alice';
  record.applicant.ownerDrives = null;
  assert.deepEqual([owner(record).named?.dob, owner(record).last], ['03/04/1985', 'Sample']);
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
  for (const id of ['openCargo', 'addCargoCommodity', 'doneCargo', 'billPlan', 'recalculate', 'recalculateAgain', 'print']) {
    assert.deepEqual(actions(no).find((s) => s.action === id).heldBy, ['ntlStillAdded'], `${id} waits while NTL is still on the quote`);
  }
  // Codex on PR #22: an earlier bill plan visit must not let Recalculate or Print run while the
  // new NTL questions are open. Until the section has been seen live, the whole page is the agent's.
  for (const id of ['billPlan', 'recalculate', 'recalculateAgain', 'print']) assert.ok(!ids(record).includes(id), `${id} is the agent's`);
  // Print/Send is always the agent's click (Chrome opens the PDF only for it); the panel says so.
  assert.ok(!ids(record).includes('printSend'));
  assert.match(progressive.agentPages.PrintEmailFax, /Click Print\/Send yourself/);
  assert.ok(progressive.advance.exceptPages.includes('PrintEmailFax'), 'never continued past the Print page');
  assert.match(progressive.agentPages.CoveragesRates(record), /The rest of this page is yours: cargo, general liability, the bill plan, Recalculate and Print/);
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
  for (const id of ['openCargo', 'billPlan', 'recalculate', 'recalculateAgain', 'print']) assert.ok(!ids(record).includes(id), `${id} waits for the agent's NTL answer`);
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

// TNI, 2026-10-26, W44-32 (KY live run: the question asked about an Armed Forces course, the fill
// held it as reworded, and the agent confirmed No; the maintainer: "Military Stuff NO"): the same
// field in either wording, TNI's No. A course the notes mention that isn't said to be military
// doesn't change the Armed Forces wording's No (TNI, 2026-10-26: answer to PR question); it is still
// the agent's in the old wording, and a military course is the agent's in either.
test('defensive driver discount asked about an Armed Forces course: TNI\'s No, also with a civilian course in the notes (W44-32)', () => {
  const ARMED = 'Has this driver completed an approved United States Armed Forces defensive driving course within the last 3 years?';
  const FORM = { field: 'DriverInput.DefensiveDriverDiscount', label: 'armed forces', unit: null };
  const steps = (notes = null) => buildPlan({ ...baseRecord(), notes: { text: notes } }, progressive, {}).filter((s) => s.q === '299D');
  const [old, armed] = steps();
  assert.deepEqual([old.ask, old.unlessShown, old.whenShown, armed.ask, armed.whenShown, armed.unlessShown], [['Defensive Driver Discount'], FORM, null, [ARMED], FORM, null]);
  for (const s of [old, armed]) assert.deepEqual([s.field, s.path, s.value, s.source, s.standard, s.note], ['DriverInput.DefensiveDriverDiscount', 'progressive.q299D', false, 'standard', true, null], s.name);
  const [oldCivilian, armedCivilian] = steps('Driver took a defensive driving course last year.');
  assert.deepEqual([oldCivilian.value, armedCivilian.value, armedCivilian.note], [null, false, null]);
  assert.match(oldCivilian.note, /defensive driving course/);
  for (const notes of ['Completed the Army defensive driving course in 2024.', 'Took a military defensive driving class', 'Navy defensive driver training 2025']) {
    const [oldMilitary, armedMilitary] = steps(notes);
    assert.deepEqual([oldMilitary.value, armedMilitary.value], [null, null], notes);
    assert.match(armedMilitary.note, /military/, notes);
  }
});

// TNI, 2026-10-26, W44-32 (KY live run: Progressive's anti-theft list was unfamiliar and required,
// with nothing selected, and the agent picked None; the maintainer: "If not selected automatically,
// no"): the anti-theft device is Progressive's own choice (the VIN lookup's) when it made one, and
// None when it didn't, in either of Progressive's lists. The other safety equipment is unchanged.
test('Progressive anti-theft device: None when Progressive has not selected one, its own choice kept (W44-32)', () => {
  const plan = buildPlan(baseRecord(), progressive, { vehicles: 0 });
  for (const [q, field] of [['2CFA', 'RiskInputNonShredded.AntiTheftDeviceAgentOptions'], ['2BAC', 'RiskInput.AntiTheftDevice']]) {
    const s = byQ(plan, q);
    assert.deepEqual([s.field, s.value, s.source, s.standard, s.keepPreset, s.ignore, s.note, s.emptyNote], [field, 'None', 'standard', true, true, false, null, null], q);
  }
  for (const q of ['2BA1', '2BAE']) assert.deepEqual([byQ(plan, q).ignore, byQ(plan, q).keepPreset], [true, false], q);
  // NJ's safety equipment boxes stay as the VIN lookup ticked them (an unticked box is no device).
  for (const q of ['2C45', '2C46', '2C47', '2C48']) assert.equal(byQ(plan, q).ignore, true, q);
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

  // Filings: the intake's answer; blank is No, with or without a USDOT or MC number (TNI, 2026-10-26:
  // answer to PR question; until then a number left it to the agent).
  const filings = baseRecord();
  filings.operations.filingsRequired = null;
  filings.operations.filingsWhich = null;
  assert.deepEqual(got(step(filings, 'CA')), [false, 'standard', true, false], 'blank, no USDOT or MC: TNI standard No');
  assert.equal(step(filings, 'F11').value, null, 'the Filings page (shown only after a Yes) is unchanged');
  // A USDOT coming within 60 days (TNI, 2026-10-19): still No; the USDOT question says "Not Yet".
  filings.applicant.mcDotWithin60Days = true;
  assert.deepEqual(got(step(filings, 'CA')), [false, 'standard', true, false], 'USDOT coming within 60 days: still No');
  assert.match(step(filings, '1ED').value, /^Not Yet - but the customer has applied\/will apply/);
  filings.applicant.mcDotWithin60Days = null;
  filings.applicant.dot = '1234567';
  assert.deepEqual(got(step(filings, 'CA')), [false, 'standard', true, false], 'blank with a USDOT number: TNI standard No (2026-10-26)');
  filings.applicant.dot = null;
  filings.applicant.mc = '765432';
  assert.deepEqual(got(step(filings, 'CA')), [false, 'standard', true, false], 'blank with an MC number: TNI standard No (2026-10-26)');
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

// TNI, 2026-10-26 (answer to PR question, W44-32): "filings required" left blank on an intake with a
// USDOT or MC number is No on every carrier, Progressive too, replacing its 2026-10-19 rule that left
// it to the agent. An intake that asks for filings keeps its Yes; filings named or an SR-22 needed
// with the box blank stay the agent's; an NTL quote (decided or only mentioned) is W44-28's, unchanged.
test('Progressive filings required: blank with a USDOT or MC number is TNI\'s No; filings asked for and NTL unchanged (2026-10-26)', () => {
  const ca = (changes = {}, { applicant = {}, coverage = {}, notes = null } = {}) => {
    const r = baseRecord();
    Object.assign(r.operations, { filingsRequired: null, filingsWhich: null, needSr22: null }, changes);
    Object.assign(r.applicant, applicant);
    Object.assign(r.coverage, coverage);
    if (notes) r.notes = { text: notes };
    const s = byQ(buildPlan(r, progressive, {}), 'CA');
    return [s.value, s.source, s.standard, !!s.note];
  };
  for (const applicant of [{ dot: '1234567' }, { mc: '765432' }, { dot: '1234567', mc: '765432' }, { dot: '1234567', mcDotWithin60Days: false }]) {
    assert.deepEqual(ca({}, { applicant }), [false, 'standard', true, false], JSON.stringify(applicant));
  }
  // The intake's own answer.
  assert.deepEqual(ca({ filingsRequired: true, filingsWhich: 'Federal Liability Filing' }, { applicant: { dot: '1234567' } }), [true, 'derived', false, false]);
  assert.deepEqual(ca({ filingsRequired: false }, { applicant: { dot: '1234567' } }), [false, 'derived', false, false]);
  // Blank, while the intake names filings or needs an SR-22 (Progressive asks about state filings too): the agent's.
  assert.deepEqual(ca({ filingsWhich: 'BMC-91' }, { applicant: { dot: '1234567' } }), [null, 'derived', false, true]);
  assert.deepEqual(ca({ needSr22: true }, { applicant: { mc: '765432' } }), [null, 'derived', false, true]);
  // NTL decided: W44-28's No, also with a number; only mentioned in the notes: held for the agent (#192).
  assert.deepEqual(ca({}, { applicant: { dot: '1234567' }, coverage: { ntl: true } }), [false, 'standard', true, false], 'NTL: W44-28\'s No (#192)');
  assert.deepEqual(ca({}, { applicant: { dot: '1234567' }, notes: 'Client asked about non-trucking liability' }), [null, 'fact', false, true], 'NTL mentioned: held with its note (#192)');
  // Without a number the 2026-10-19 No stands, NTL or not.
  assert.deepEqual(ca({}, { coverage: { ntl: true } }), [false, 'standard', true, false]);
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
  for (const id of ['billPlan', 'recalculate', 'recalculateAgain', 'print']) {
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


// The maintainer, 2026-10-26, live run (Progressive, NTL on the form): after Add Non-Trucking
// Liability instead?, Progressive asks "Is the customer under permanent lease to a motor carrier…"
// (LineInput.NTLLease) and its "Non-Trucking Liability coverage limit" (LineInput.NTLLimit, $300k to
// $1 million CSL); the fill had put $1 million CSL in Bodily Injury and Property Damage Liability,
// which must stay Not selected.
test('an NTL quote on Rates: NTL added first, liability Not selected, lease Yes, the intake\'s limit for NTL', () => {
  const record = baseRecord();
  record.coverage.ntl = true;
  const steps = buildPlan(record, progressive, {});
  const at = (q) => steps.find((s) => s.q === q && s.kind !== 'action');
  assert.deepEqual([at('1D97').value, at('1D97').source], ['Not selected', 'derived']);
  assert.deepEqual([at('1DF0').value, at('1DF0').source, at('1DF0').field], [true, 'standard', 'LineInput.NTLLease']);
  assert.deepEqual([at('1DF2').value, at('1DF2').field], [record.coverage.autoLiabLimit, 'LineInput.NTLLimit']);
  assert.ok(new RegExp(at('1DF0').re ?? at('1DF0').label, 'i').test('Is the customer under permanent lease to a motor carrier that provides primary liability coverage when the customer'));
  assert.equal(steps.find((s) => s.action === 'addNtl').immediate, true, 'NTL is added before the liability limit is touched');
  // Without NTL: the intake's limit, and neither NTL question.
  const plain = buildPlan(baseRecord(), progressive, {});
  assert.deepEqual([plain.find((s) => s.q === '1D97').value, plain.find((s) => s.q === '1D97').source], [baseRecord().coverage.autoLiabLimit, 'intake']);
  for (const q of ['1DF0', '1DF2']) assert.equal(plain.find((s) => s.q === q).ignore, true, q);
  for (const q of ['1DF0', '1DF2']) assert.equal(at(q).ignore, false, q);
});

// The maintainer, 2026-10-26 (W44-28): "US DOT is not added and filings not added if its NTL, in
// every case". W44-07 (OH): the intake asked for NTL $1M and federal filings; with the federal
// filing ticked Progressive offered only $750k to $2M CSL primary liability, and NTL couldn't be rated.
const ntlRecord = (changes = {}) => {
  const r = baseRecord();
  Object.assign(r.applicant, { dot: '1234567', mc: '765432' });
  Object.assign(r.coverage, { ntl: true, autoLiability: 'Non-Trucking' }, changes);
  return r;
};
const gave = (s) => [s.value, s.source, s.standard, s.note ?? null];

test('an NTL quote on Progressive: no USDOT number, no Verify USDOT and no filings, whatever the intake asks (W44-28)', () => {
  const plan = (r) => buildPlan(r, progressive, {});
  const federal = (p) => p.find((s) => s.re === '^federal( liability)?( filing)?$');
  const NO = 'No - and the customer will not have a USDOT number';
  // With cargo or general liability too it is still an NTL quote; NTL the agent set with auto liability blank too.
  for (const r of [ntlRecord(), ntlRecord({ cargo: false }), ntlRecord({ cargo: false, gl: true }), ntlRecord({ autoLiability: null })]) {
    const p = plan(r);
    const what = JSON.stringify(r.coverage);
    assert.deepEqual(gave(byQ(p, '1ED')), [NO, 'standard', true, null], `"Does the customer have a USDOT Number?" ${what}`);
    assert.equal(byQ(p, '1F3').ignore, true, `the USDOT number box: never typed ${what}`);
    assert.ok(!p.some((s) => s.baseAction === 'verifyDot'), `Verify USDOT: never clicked ${what}`);
    assert.deepEqual(gave(byQ(p, 'CA')), [false, 'standard', true, null], `"Are state or federal filings required?" ${what}`);
    assert.deepEqual(gave(federal(p)), [false, 'standard', true, null], `the Federal filing: never ticked ${what}`);
    assert.equal(p.find((s) => s.re === '^state( filing)?$').ignore, true, 'the State filing: left as the page has it, as on any quote');
  }
  // Blank filings with an SR-22 needed (otherwise the agent's), and no USDOT number with one coming
  // within 60 days (otherwise "Not Yet"): No too, "in every case".
  const sr22 = ntlRecord();
  Object.assign(sr22.operations, { filingsRequired: null, filingsWhich: null, needSr22: true });
  assert.deepEqual(gave(byQ(plan(sr22), 'CA')), [false, 'standard', true, null]);
  const soon = ntlRecord();
  Object.assign(soon.applicant, { dot: null, mc: null, mcDotWithin60Days: true });
  assert.deepEqual(gave(byQ(plan(soon), '1ED')), [NO, 'standard', true, null]);
  // Not an NTL quote: as before. (NTL with primary auto liability too: the agent's, the next test.)
  for (const r of [ntlRecord({ ntl: null, autoLiability: 'Yes' }), ntlRecord({ ntl: false, autoLiability: 'Yes' })]) {
    const p = plan(r);
    const what = JSON.stringify(r.coverage);
    assert.deepEqual(gave(byQ(p, '1ED')), ['Yes - the customer has a USDOT number', 'derived', false, null], what);
    assert.equal(byQ(p, '1F3').ignore, false, what);
    assert.ok(p.some((s) => s.baseAction === 'verifyDot'), what);
    assert.deepEqual(gave(byQ(p, 'CA')), [true, 'derived', false, null], what);
    assert.deepEqual(gave(federal(p)), [true, 'derived', false, null], what);
  }
  // An NTL intake with no USDOT number, none coming and no filings: nothing to leave out, nothing changes.
  const none = (changes) => {
    const r = ntlRecord(changes);
    Object.assign(r.applicant, { dot: null, mc: null, mcDotWithin60Days: false });
    Object.assign(r.operations, { filingsRequired: false, filingsWhich: null });
    return plan(r);
  };
  const [withNtl, without] = [none({}), none({ ntl: null, autoLiability: 'Yes' })];
  for (const q of ['1ED', '1F3', 'CA', '21E', '20F', '22F', '277', '230']) {
    const [a, b] = [byQ(withNtl, q), byQ(without, q)];
    assert.deepEqual([a.value, a.source, a.standard, a.ignore, a.note], [b.value, b.source, b.standard, b.ignore, b.note], q);
  }
  assert.deepEqual([...gave(federal(withNtl)), federal(withNtl).ignore], [...gave(federal(without)), federal(without).ignore]);
});

// The same decision on AmWINS: "Does the insured have a DOT or MC number?" (NONE / DOT / MC boxes)
// and Filing required.
test('an NTL quote on AmWINS: the DOT box unticked, no DOT number and Filing required No (W44-28)', () => {
  const plan = (r) => buildPlan(r, amwins, {});
  const sel = (p, selector) => p.find((s) => s.selector === selector);
  const filing = (p) => p.find((s) => s.re === '^filling required$');
  const federal = (p) => p.find((s) => s.re === '^federal bmc91$');
  const dotOnly = ntlRecord();
  dotOnly.applicant.mc = null;
  for (const r of [dotOnly, ntlRecord({ cargo: false }), ntlRecord({ autoLiability: null })]) {
    const p = plan(r);
    const what = JSON.stringify([r.applicant.mc, r.coverage]);
    assert.deepEqual(gave(filing(p)), [false, 'standard', true, null], `Filing required ${what}`);
    assert.deepEqual(gave(sel(p, '#hasDotNumber')), [false, 'standard', true, null], `the DOT box ${what}`);
    assert.equal(sel(p, '#dotNumber').value, null, `the DOT number: never typed ${what}`);
    assert.equal(federal(p).value, null, `no federal filing ticked ${what}`);
  }
  // With no MC number either, NONE is ticked (the DOT isn't added); an MC number stays the intake's.
  assert.deepEqual(gave(sel(plan(dotOnly), '#noNumber')), [true, 'standard', true, null]);
  const mc = plan(ntlRecord());
  assert.deepEqual([sel(mc, '#hasMcNumber').value, sel(mc, '#mcNumber').value, sel(mc, '#noNumber').value, sel(mc, '#noNumber').source], [true, '765432', false, 'derived']);
  // Not an NTL quote: as before. (NTL with primary auto liability too: the agent's, below.)
  for (const r of [ntlRecord({ ntl: null, autoLiability: 'Yes' }), ntlRecord({ ntl: false, autoLiability: 'Yes' })]) {
    const p = plan(r);
    assert.deepEqual(gave(filing(p)), [true, 'derived', false, null]);
    assert.deepEqual([sel(p, '#hasDotNumber').value, sel(p, '#dotNumber').value, sel(p, '#noNumber').value], [true, '1234567', false]);
    assert.equal(federal(p).value, true);
  }
  // An NTL intake with no DOT or MC number and no filings: nothing changes.
  const none = (changes) => {
    const r = ntlRecord(changes);
    Object.assign(r.applicant, { dot: null, mc: null });
    r.operations.filingsRequired = false;
    return plan(r);
  };
  const [withNtl, without] = [none({}), none({ ntl: null, autoLiability: 'Yes' })];
  for (const find of [filing, federal, (p) => sel(p, '#hasDotNumber'), (p) => sel(p, '#noNumber'), (p) => sel(p, '#dotNumber'), (p) => sel(p, '#hasMcNumber')]) {
    const [a, b] = [find(withNtl), find(without)];
    assert.deepEqual([a.value, a.source, a.standard, a.ignore, a.note], [b.value, b.source, b.standard, b.ignore, b.note], a.name);
  }
});

// (TNI, 2026-10-26: answers to PR questions, #192) NTL with primary auto liability too (auto
// liability Yes): the USDOT and filings questions are the agent's, with a note naming the conflict.
// NTL mentioned in the claims box or the notes (or flagged by Luna) and not answered yet: they wait
// for the answer, with a note to answer NTL on the Intake step first. Answered, the PR's rules.
const heldRecords = () => {
  const mentioned = (where, changes = {}) => {
    const r = ntlRecord({ ntl: null, autoLiability: 'Yes', ...changes });
    if (where === 'claims') r.claims = { hasClaims: false, text: 'No\nAsked about NTL too' };
    else if (where === 'notes') r.notes = { text: 'Client may want non-trucking' };
    else r.claims = { hasClaims: false, aiNtl: true };
    return r;
  };
  return {
    held: [[ntlRecord({ autoLiability: 'Yes' }), /primary auto liability/], [mentioned('claims'), /Intake step/], [mentioned('notes'), /Intake step/],
      [mentioned('luna'), /Intake step/], [mentioned('notes', { autoLiability: null }), /Intake step/]],
    mentioned,
  };
};
const agentsWith = (s, why, what) => {
  assert.deepEqual([s.value, s.source, s.standard, s.manualOnly], [null, 'fact', false, true], `${s.name}: the agent's ${what}`);
  assert.match(s.note ?? '', why, `${s.name}: the note says why ${what}`);
};

test('NTL with primary auto liability, or NTL mentioned and not answered: the USDOT and filings questions are the agent\'s on Progressive', () => {
  const plan = (r) => buildPlan(r, progressive, {});
  const federal = (p) => p.find((s) => s.re === '^federal( liability)?( filing)?$');
  const { held, mentioned } = heldRecords();
  for (const [r, why] of held) {
    const p = plan(r);
    const what = JSON.stringify([r.coverage, r.claims, r.notes]);
    for (const s of [byQ(p, '1ED'), byQ(p, 'CA'), federal(p)]) agentsWith(s, why, what);
    // The USDOT number on Business Owner Info, before Rates: not typed, and never verified.
    assert.deepEqual([byQ(p, '1F3').value, byQ(p, '1F3').ignore], [null, false], `the USDOT number box ${what}`);
    assert.match(byQ(p, '1F3').note ?? '', why, what);
    assert.ok(!p.some((s) => s.baseAction === 'verifyDot'), `Verify USDOT: not clicked ${what}`);
  }
  // No USDOT number on the intake: the box stays ignored, as without NTL; the question still waits.
  const noDot = mentioned('notes');
  noDot.applicant.dot = null;
  assert.equal(byQ(plan(noDot), '1F3').ignore, true);
  agentsWith(byQ(plan(noDot), '1ED'), /Intake step/, 'no USDOT number');
  // Answered No (with the mention still there): as on any quote. Answered Yes (Non-Trucking): the NTL quote's.
  const no = plan(mentioned('notes', { ntl: false }));
  assert.deepEqual(gave(byQ(no, '1ED')), ['Yes - the customer has a USDOT number', 'derived', false, null]);
  assert.equal(byQ(no, '1F3').ignore, false);
  assert.equal(byQ(no, '1F3').note, null);
  assert.ok(no.some((s) => s.baseAction === 'verifyDot'));
  assert.deepEqual(gave(byQ(no, 'CA')), [true, 'derived', false, null]);
  const yes = plan(mentioned('notes', { ntl: true, autoLiability: 'Non-Trucking' }));
  assert.deepEqual(gave(byQ(yes, '1ED')), ['No - and the customer will not have a USDOT number', 'standard', true, null]);
  assert.ok(!yes.some((s) => s.baseAction === 'verifyDot'));
  assert.deepEqual(gave(byQ(yes, 'CA')), [false, 'standard', true, null]);
  // Neither NTL nor a mention: unchanged.
  const plain = plan(ntlRecord({ ntl: null, autoLiability: 'Yes' }));
  assert.deepEqual(gave(byQ(plain, '1ED')), ['Yes - the customer has a USDOT number', 'derived', false, null]);
  assert.ok(plain.some((s) => s.baseAction === 'verifyDot'));
});

test('NTL with primary auto liability, or NTL mentioned and not answered: Filing required and the DOT boxes are the agent\'s on AmWINS', () => {
  const plan = (r) => buildPlan(r, amwins, {});
  const sel = (p, selector) => p.find((s) => s.selector === selector);
  const filing = (p) => p.find((s) => s.re === '^filling required$');
  const BMC = ['^federal bmc91$', '^federal liability mcs90$', '^federal cargo bmc32$'];
  const { held } = heldRecords();
  for (const [r, why] of held) {
    r.applicant.mc = null;
    const p = plan(r);
    const what = JSON.stringify([r.coverage, r.claims, r.notes]);
    for (const s of [filing(p), sel(p, '#hasDotNumber'), sel(p, '#noNumber'), sel(p, '#dotNumber'), ...BMC.map((re) => p.find((x) => x.re === re))]) agentsWith(s, why, what);
  }
  // An MC number: its boxes stay the intake's, and NONE is unticked whatever the DOT answer.
  const [withMc] = heldRecords().held[0];
  const p = plan(withMc);
  assert.deepEqual([sel(p, '#hasMcNumber').value, sel(p, '#mcNumber').value, sel(p, '#noNumber').value, sel(p, '#noNumber').source], [true, '765432', false, 'derived']);
  agentsWith(sel(p, '#hasDotNumber'), /primary auto liability/, 'with an MC number');
  // Answered No: as on any quote.
  const no = plan(heldRecords().mentioned('notes', { ntl: false }));
  assert.deepEqual(gave(filing(no)), [true, 'derived', false, null]);
  assert.deepEqual([sel(no, '#hasDotNumber').value, sel(no, '#dotNumber').value, sel(no, '#dotNumber').note], [true, '1234567', null]);
});

// The maintainer, 2026-10-26: a blank CDL box on the intake means No (TNI's standard).
test('a blank CDL on the intake is No on Add Driver, as TNI\'s standard', () => {
  const record = baseRecord();
  record.drivers[0].cdl = null;
  const cdl = buildPlan(record, progressive, { drivers: 0 }).find((s) => s.q === '28E6');
  assert.deepEqual([cdl.value, cdl.source], [false, 'standard']);
  record.drivers[0].cdl = true;
  const yes = buildPlan(record, progressive, { drivers: 0 }).find((s) => s.q === '28E6');
  assert.deepEqual([yes.value, yes.source], [true, 'intake']);
  // The review of PR #176: a CDL year with the box blank says they may have one: not No, the agent's.
  record.drivers[0].cdl = null;
  record.drivers[0].cdlYear = 2015;
  const year = buildPlan(record, progressive, { drivers: 0 }).find((s) => s.q === '28E6');
  assert.deepEqual([year.value, year.source], [null, 'intake']);
  // A driver the intake doesn't have: nothing, as before.
  const none = buildPlan(record, progressive, { drivers: 3 }).find((s) => s.q === '28E6');
  assert.deepEqual([none.value, none.source], [null, 'intake']);
});

// The review of PR #176: Mark done on a helper's reminder released NTL still on the quote
// (ntlStillAdded, the hold on the Rates helpers) and the NTL question (ntlDecide). Only the NTL
// quote's reminder that the rest of Rates is the agent's (ntlRates) can be marked done.
test('only the NTL-with-cargo Rates reminder can be marked done', () => {
  const markable = (change) => {
    const record = baseRecord();
    Object.assign(record.coverage, change);
    return buildPlan(record, progressive, {}).filter((s) => s.kind === 'action' && s.markable).map((s) => s.action);
  };
  assert.deepEqual(markable({ ntl: true, cargo: true }), ['ntlRates']);
  assert.deepEqual(markable({ ntl: true, cargo: false, gl: false }), [], 'NTL only: no reminder');
  assert.deepEqual(markable({ ntl: false }), [], 'ntlStillAdded: settled only by the page');
  const mention = baseRecord();
  mention.coverage.ntl = null;
  mention.claims = { ...mention.claims, text: 'No\nNeeds NTL' };
  assert.ok(buildPlan(mention, progressive, {}).some((s) => s.action === 'ntlDecide' && !s.markable), 'ntlDecide: answered on the Intake step');
});


// The maintainer, 2026-10-26, live run (NTL, no cargo or GL): after the NTL section the agent clicked
// its Done with this coverage, Recalculate, View bill plan options and Print, Email, Fax, as on a
// quote without NTL. The fill does them now, so the quote ends at Print (and its sound plays). With
// cargo or GL too, Rates after NTL stays the agent's, with a reminder they can mark done.
test('an NTL-only quote: Done with this coverage after the NTL limit, then Rates as on any quote', () => {
  const record = baseRecord();
  record.coverage.ntl = true;
  record.coverage.cargo = false;
  const steps = buildPlan(record, progressive, {});
  const act = (id) => steps.find((s) => s.action === id);
  const done = act('doneNtl');
  assert.deepEqual([done.afterActions, done.after, done.waitRequired], [['addNtl'], ['progressive.q1DF2'], true]);
  assert.ok(new RegExp(done.text, 'i').test('Done with this coverage'));
  const ntlLimit = steps.find((s) => s.q === '1DF2' && s.kind !== 'action');
  assert.deepEqual([ntlLimit.path, ntlLimit.value], ['progressive.q1DF2', '$1M CSL'], 'its own path, so Done and the rates helpers wait for it');
  for (const id of ['recalculate', 'billPlan']) assert.deepEqual([act(id).afterActions, act(id).after], [['doneNtl'], ['progressive.q1DF2']], id);
  for (const id of ['recalculateAgain', 'print']) assert.ok(act(id), id);
  assert.ok(!act('ntlRates') && !act('openCargo') && !act('openGl'), 'no reminder, no cargo or GL helpers');
  assert.equal(progressive.agentPages.CoveragesRates(record), null);
  assert.equal(progressive.finishedBy, 'print', 'Print, Email, Fax ends it: the quote-done sound');
  // With cargo (or GL): the reminder, and the rest of Rates is the agent's.
  for (const changes of [{ cargo: true }, { gl: true }]) {
    const r = baseRecord();
    Object.assign(r.coverage, { ntl: true, cargo: false, gl: false }, changes);
    const ids = buildPlan(r, progressive, {}).filter((s) => s.kind === 'action').map((s) => s.action);
    assert.ok(ids.includes('ntlRates') && !ids.includes('doneNtl') && !ids.includes('print') && !ids.includes('recalculate'), JSON.stringify(changes));
  }
  // Without NTL: as before.
  const plain = buildPlan(baseRecord(), progressive, {});
  assert.deepEqual(plain.find((s) => s.action === 'recalculate').afterActions, ['doneCargo']);
  assert.deepEqual(plain.find((s) => s.action === 'recalculate').after, ['coverage.autoLiabLimit']);
  assert.ok(!plain.some((s) => s.action === 'doneNtl'));
});

// The maintainer, 2026-10-26, live run: no quote-done sound on an NTL quote. The NTL limit is found
// by its data-model name, and its caption checked against the rule's pattern as the page kit reads
// captions (squashed: "Non-Trucking" is "non trucking"); "non-?trucking" didn't match, so the kit
// took the question for reworded, a check for the agent, and a quote with a check isn't done.
test('the NTL questions\' patterns match their captions as the page kit reads them', () => {
  const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const rule = (q) => progressive.rules.find((r) => r.q === q);
  assert.match(squash('Non-Trucking Liability coverage limit'), new RegExp(rule('1DF2').label, 'i'));
  assert.match(squash('Is the customer under permanent lease to a motor carrier that provides primary liability coverage when the customer is under dispatch?'), new RegExp(rule('1DF0').label, 'i'));
});
