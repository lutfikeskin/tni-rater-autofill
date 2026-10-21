// GEICO commercial auto (src/carriers/geico.js): the plan the page kit gets, for synthetic intakes.
// What the kit does with it on GEICO's pages (steps read from the progress bar, the forms told by
// `whenShown`) is tested with the page kit; here: what each rule answers, from what, and when the
// question is the agent's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, AGENT_SOURCES, SOURCES } from '../src/plan.js';
import { geico } from '../src/carriers/geico.js';
import { CARRIERS, carrierForUrl, quoteProgress } from '../src/carriers.js';
import { knownStep } from '../src/usage.js';
import { advanceFor } from '../src/units.js';

const STEPS = ['Business Class & USDOT', 'Business & Owner Info', 'Vehicles', 'Drivers & Incidents',
  'Additional Business Info', 'Quote & Coverages', 'Final Quote Details', 'MVR & CLUE', 'Payment Information'];
const [BCU, BOI, VEH, DRV, ABI, QC] = STEPS;

// An expediter with one box truck, as an intake gives it (synthetic values only).
const intake = () => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', mc: null, mcDotWithin60Days: null, fein: null, yearEstablished: 2021, yearsInBusiness: 5,
    phone: '(555) 010-0100', email: 'client@example.test', owner1: 'Amina Kone', owner2: null, ownerDrives: true, yearsExperience: 3, applicationDate: '10/20/2026' },
  garaging: { street: '1 Test Way', unit: null, city: 'Testville', state: 'NE', zip: '68000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', radius: '150 miles', radiusMiles: 150, vehicleOwnership: 'Owned', personalUse: false,
    usesEld: false, eldBrand: null, needSr22: false, filingsRequired: true, filingsWhich: 'BMC-91', hazmat: false, hazPlacard: false, movingState: false,
    teamDriving: false, canadaLoads: false, licensePlate: null, equipVehicle: 0 },
  drivers: [{ first: 'Amina', middle: null, last: 'Kone', suffix: null, dob: '01/02/1980', licenseNumber: null, licenseState: 'NE', cdl: true, cdlYear: 2015, maritalStatus: 'Married', gender: null, excluded: false }],
  vehicles: [{ type: 'Box Truck', year: 2021, make: 'FORD', model: 'F-650', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  trailerInfo: { ownership: null, hitch: null, interchange: null, interchangeLimit: null, equipTrailer: null },
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Other Mutual', limit: '$1M CSL', expiration: '12/31/2026' }],
  coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, hasGl: null, glLimit: null, reeferBreakdown: false, ntl: null },
  claims: { hasClaims: false, text: 'No', notes: null },
  notes: { text: null },
});
const with_ = (changes, r = intake()) => {
  for (const [path, value] of Object.entries(changes)) {
    const keys = path.split('.');
    let cur = r;
    for (const k of keys.slice(0, -1)) cur = cur[k];
    cur[keys.at(-1)] = structuredClone(value);
  }
  return r;
};
const CASEY = { first: 'Casey', middle: null, last: 'Example', suffix: null, dob: '07/09/1995', licenseNumber: null, licenseState: 'IA', cdl: false, cdlYear: null, maritalStatus: 'Single', gender: null, excluded: false };
const SECOND_VEHICLE = { type: 'Cargo Van', year: 2019, make: 'RAM', model: 'ProMaster', vin: '1FTBR3X80MKA12399', value: 30000 };
const TRAILER = { type: 'Dry Van', year: 2015, make: 'WABASH', model: null, vin: null, value: 12000 };
// A blank intake: nothing the rules could answer from.
const blank = () => ({
  applicant: { name: null, dot: null, mc: null, mcDotWithin60Days: null, fein: null, yearEstablished: null, yearsInBusiness: null, phone: null, email: null, owner1: null, owner2: null, ownerDrives: null, yearsExperience: null, applicationDate: null },
  garaging: { street: null, unit: null, city: null, state: null, zip: null },
  operations: { businessClass: null, whatHaul: null, radius: null, radiusMiles: null, vehicleOwnership: null, personalUse: null, usesEld: null, eldBrand: null, needSr22: null,
    filingsRequired: null, filingsWhich: null, hazmat: null, hazPlacard: null, movingState: null, teamDriving: null, canadaLoads: null, licensePlate: null, equipVehicle: null },
  drivers: [], vehicles: [], trailers: [],
  trailerInfo: { ownership: null, hitch: null, interchange: null, interchangeLimit: null, equipTrailer: null },
  priorInsurance: [],
  coverage: { autoLiability: null, autoLiabLimit: null, cargo: null, cargoLimit: null, cargoDeductible: null, gl: null, hasGl: null, glLimit: null, reeferBreakdown: null, ntl: null },
  claims: { hasClaims: null, text: null, notes: null },
  notes: { text: null },
});
const RECORDS = () => [
  intake(),
  with_({ vehicles: [intake().vehicles[0], SECOND_VEHICLE], trailers: [TRAILER], drivers: [intake().drivers[0], CASEY], 'trailerInfo.equipTrailer': 2000, 'operations.equipVehicle': 5000 }),
  with_({ 'applicant.name': null, 'applicant.dot': null, 'applicant.ownerDrives': false, priorInsurance: [], 'coverage.gl': true, 'claims.text': 'Wants NTL', 'vehicles.0.vin': null }),
  blank(),
];
const ACTIVES = [{}, { vehicles: 0, drivers: 0, trailers: 0 }, { vehicles: 1, drivers: 1, trailers: 0 }];

const plan = (r, active = {}) => buildPlan(r, geico, active).filter((s) => s.kind !== 'action');
const one = (p, name, step) => {
  const hits = p.filter((s) => s.name === name && (!step || s.steps?.includes(step)));
  assert.equal(hits.length, 1, `${name}${step ? ` on ${step}` : ''}: ${hits.length} steps`);
  return hits[0];
};
const value = (r, name, step, active) => one(plan(r, active), name, step).value;
// The agent's: not filled, with a note saying why.
const agents = (s) => { assert.equal(s.value, null, `${s.name}: not filled`); assert.ok(s.note, `${s.name}: has a note`); };

// --- The carrier --------------------------------------------------------------------------------

test('GEICO is registered: the quote and the gateway are filled', () => {
  assert.ok(CARRIERS.includes(geico));
  assert.equal(carrierForUrl('https://sales.geico.com/quote').id, 'geico');
  assert.equal(carrierForUrl('https://gateway2.geico.com/').id, 'geico', 'the gateway is GEICO\'s');
  for (const url of ['https://sales.geico.com/quote', 'https://sales.geico.com/quote/', 'https://sales.geico.com/quote?id=1', 'https://sales.geico.com/quote#/vehicles']) {
    assert.ok(geico.autoFillUrl.test(url), url);
    assert.ok(geico.layoutUrl.test(url), url);
  }
  // TNI 2026-10-21: the quote starts on the gateway with its ZIP, in the Start New Quote window
  // drawn over any gateway page (FL live run 2: over Recent Policies and Quotes). Its layouts aren't
  // taken; its first fill runs when the window is drawn.
  for (const url of ['https://gateway2.geico.com/', 'https://gateway2.geico.com', 'https://gateway2.geico.com/#home',
    'https://gateway2.geico.com/recent-policy-and-quotes', 'https://gateway2.geico.com/dashboard']) {
    assert.ok(geico.autoFillUrl.test(url), url);
    assert.ok(!geico.layoutUrl.test(url), url);
  }
  // Drawn over a gateway page: its first fill when drawn. The quote's steps draw with their questions.
  assert.ok(geico.fillOnDraw.test('https://gateway2.geico.com/recent-policy-and-quotes'));
  assert.ok(!geico.fillOnDraw.test('https://sales.geico.com/quote'));
  for (const url of ['https://sales.geico.com/dashboard', 'https://sales.geico.com/quotes', 'http://sales.geico.com/quote', 'https://gateway2.geico.com.example.test/']) {
    assert.ok(!geico.autoFillUrl.test(url), url);
    assert.ok(!geico.layoutUrl.test(url), url);
  }
  // The saved pages served from this repo get GEICO's rules, as practice.
  const practice = carrierForUrl('http://localhost:8123/test/fixtures/geico/quote.html');
  assert.deepEqual([practice.id, practice.name, practice.practice, practice.autoFillUrl], ['geico', 'GEICO (practice)', true, null]);
  assert.equal(carrierForUrl('http://localhost:8123/test/fixtures/amwins/app.html').id, 'amwins');
  assert.equal(carrierForUrl('http://localhost:8123/other.html').id, 'test');
});

test('the steps come from the progress bar; the last three are the agent\'s', () => {
  assert.deepEqual(geico.layoutSteps, STEPS);
  assert.deepEqual(geico.quoteSteps.map((s) => [s.name, s.step]), STEPS.map((s) => [s, s]));
  assert.deepEqual(quoteProgress(geico, '/quote', 'Vehicles'), { name: 'Vehicles', index: 2, count: 9 });
  assert.equal(quoteProgress(geico, '/quote'), null, 'one address: no step without the progress bar');
  assert.equal(knownStep(geico, 'Drivers & Incidents'), 'Drivers & Incidents');
  assert.equal(knownStep(geico, 'Dashboard'), undefined);
  assert.deepEqual(Object.keys(geico.stopSteps), STEPS.slice(6));
  for (const note of Object.values(geico.stopSteps)) assert.match(note, /yours/);
  assert.deepEqual([geico.vehicleSteps, geico.driverSteps], [[VEH], [DRV]]);
  assert.deepEqual([geico.useGenericRules, geico.replaceChoices], [false, true]);
  for (const key of ['world', 'batch', 'stopPages']) assert.ok(!(key in geico), key);
  // Continue (TNI, FL live run 3, 2026-10-21): Next, or Save and Continue on Add Driver, on each
  // step up to Additional Business Info, never on Quote & Coverages (its Next leads to MVR & CLUE's
  // paid reports) or after it, never the chooser's Next (the add helpers' own); per form and button.
  assert.deepEqual(geico.advance.steps, STEPS.slice(0, 5));
  assert.ok(!geico.advance.steps.includes(QC) && !Object.keys(geico.stopSteps).some((s) => geico.advance.steps.includes(s)));
  const continues = (text, listed = false) => new RegExp(advanceFor(geico, listed).text, 'i').test(text);
  assert.deepEqual(['Next', 'Save and Continue', 'Looks Good', 'Recalculate', 'Print Quote Proposal', 'Cancel', 'Discard Changes', 'Next Step'].map((t) => continues(t)),
    [true, true, false, false, false, false, false, false]);
  // Looks Good leaves a unit list: only once the panel read it and every intake unit is on it.
  assert.deepEqual(['Next', 'Looks Good', 'Looks Good to me'].map((t) => continues(t, true)), [true, true, false]);
  assert.equal(geico.advance.notWithin, '[id^="Id_VehicleOrTrailerCollectAdaptiveActionSet_Container_"]');
  assert.deepEqual([geico.advance.byForm, 'listed' in advanceFor(geico, true)], [true, false]);
  // The page is quiet first: GEICO draws the USDOT record's address check after the number.
  assert.equal(geico.advance.quietMs, 800);
  // No helper but those adding a unit the panel is adding (below): Recalculate is the agent's, after
  // their coverage choices (FL live run, 2026-10-21), and Quote & Coverages takes follow-ups only for
  // questions it draws (FL live run 2: the cargo section's); an answer GEICO takes back there is kept.
  assert.deepEqual(buildPlan(intake(), geico, {}).filter((s) => s.kind === 'action'), []);
  for (const a of geico.actions) assert.ok(a.steps.every((s) => [VEH, DRV].includes(s)), a.id);
  assert.deepEqual([geico.newQuestionsOnlySteps, geico.keepTakenBack], [[QC], [QC]]);
  assert.ok(!('noFollowUpSteps' in geico));
  // The quote stops at Quote & Coverages: said there, and on the steps after it.
  assert.deepEqual(Object.keys(geico.stepNotes), [QC]);
  assert.match(geico.stepNotes[QC], /Recalculate.*Print Quote Proposal.*MVR & CLUE/);
  for (const step of ['Final Quote Details', 'MVR & CLUE']) assert.match(geico.stopSteps[step], /stops GEICO quotes at Quote & Coverages/);
});

// The gateway: its own rules, by selector on any gateway page (never the quote), before any step.
const GATEWAY = (rule) => !!rule.notPages?.includes('/quote') && !rule.steps;

test('every rule names its steps (never one that is the agent\'s), how it is found, and a stable name', () => {
  const gateway = geico.rules.filter(GATEWAY);
  const product = 'input[name="lob-selection"]';
  const other = `${product}:not(#commercial):not([value="commercial"])`;
  assert.deepEqual(gateway.map((r) => [r.selector, r.notPages, r.steps ?? null]), [['#start-quote-zip', ['/quote'], null], ['#dashboard-usdot', ['/quote'], null],
    [`${product}#commercial, ${product}[value="commercial"]`, ['/quote'], null], ['#start-quote-usdot', ['/quote'], null],
    ...['input[name="header-search-type"]', '#search-input-id', other, other, other, '[id^="alerts-pref"]'].map((sel) => [sel, ['/quote'], null])]);
  // The gateway's own controls are never answered, one rule each (a selector rule answers its first
  // match only: FL live run 3, 2026-10-21, the header search took the rule that named the products).
  assert.deepEqual(gateway.slice(4).map((r) => r.ignore), [true, true, true, true, true, true]);
  // Search Products (TNI, FL live run 3): Commercial Auto/Trucking ticked; its USDOT box the intake's.
  const p = plan(intake());
  const commercial = one(p, 'Start quote: Commercial Auto/Trucking (TNI: ticked)');
  assert.deepEqual([commercial.kind, commercial.value, commercial.source], ['bool', true, 'standard']);
  assert.deepEqual([one(p, 'Start quote: USDOT number (Search Products)').value, one(p, 'Start quote: USDOT number').value], ['1234567', '1234567']);
  assert.equal(one(plan(with_({ 'applicant.dot': null })), 'Start quote: USDOT number (Search Products)').ignore, true, 'no USDOT on the intake: left as it is');
  for (const rule of geico.rules.filter((r) => !GATEWAY(r))) {
    const where = rule.name ?? rule.field ?? rule.ask;
    assert.ok(Array.isArray(rule.steps) && rule.steps.length, `${where}: steps`);
    for (const step of rule.steps) {
      assert.ok(STEPS.includes(step), `${where}: ${step}`);
      assert.ok(!(step in geico.stopSteps), `${where}: never on ${step}`);
    }
    assert.ok(rule.field || rule.ask || rule.selector, `${where}: found by name, text or selector`);
    assert.ok(!('page' in rule) && !('label' in rule), `${where}: no page or label rule`);
    assert.ok(rule.path || rule.q, `${where}: its path, or geico.q<name>`);
    for (const cond of [rule.whenShown, rule.unlessShown].filter(Boolean)) assert.ok(cond.field, `${where}: a form's question`);
  }
});

// TNI's GEICO standards (FL live run, 2026-10-21): only these rules may be one.
const STANDARDS = [
  'Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, else the agent\'s pick)', 'Customizations (from the attached equipment value)',
  'Comprehensive or collision wanted (TNI: Yes)', 'Trailer comprehensive or collision wanted (TNI: Yes)',
  'Driver\'s relationship to the business (Owner, else Employee)', 'Number of employees (the drivers besides the owner)',
  'Years with the current auto insurer (1-3 with a current policy)', 'Liability insurance the business has (None unless the notes say)',
  'Named additional insured or waiver of subrogation (TNI: No)', 'Blanket additional insured by contract (TNI: No)', 'Blanket waiver of subrogation by contract (TNI: No)',
  'Medical payments (FL: Not Included, PIP instead)', 'Comprehensive', 'Collision', 'Refrigeration breakdown (Yes with a reefer)',
  'Business description (For Hire Trucking for an expediter or freight hauler)', 'More about the business (Other For-Hire Trucking for an expediter or freight hauler)',
  'Start quote: Commercial Auto/Trucking (TNI: ticked)',
];

test('TNI\'s GEICO standards are the recorded ones, and only GEICO\'s own rules answer', () => {
  const seen = new Set();
  const records = [...RECORDS(), with_({ 'garaging.state': 'FL', 'coverage.reeferBreakdown': null, 'operations.equipVehicle': null, 'vehicles.0.type': 'Van' })];
  for (const rule of geico.rules) {
    const sources = typeof rule.source === 'function' ? records.flatMap((r) => ACTIVES.map((a) => rule.source(r, a))) : [rule.source];
    if (sources.includes('standard')) seen.add(rule.name);
  }
  assert.deepEqual([...seen].sort(), [...STANDARDS].sort());
  for (const r of RECORDS()) {
    for (const active of ACTIVES) {
      const steps = plan(r, active);
      // One vehicle: a step per rule (no generic label rule).
      if (r.vehicles.length <= 1 && !r.trailers.length) assert.equal(steps.length, geico.rules.length);
      for (const s of steps) {
        if (s.standard) assert.ok(STANDARDS.includes(s.name), s.name);
        assert.ok(s.source === null || SOURCES.includes(s.source), s.name);
        assert.ok(s.path.startsWith('geico.q') || !/^geico\./.test(s.path), s.path);
        if (!s.notPages?.includes('/quote')) assert.ok(Array.isArray(s.steps) && s.steps.length, `${s.name}: steps`);
      }
    }
  }
});

test('facts and attestations are never filled and never the AI assistant\'s', () => {
  let facts = 0;
  for (const r of RECORDS()) {
    for (const active of ACTIVES) {
      for (const s of plan(r, active)) {
        if (AGENT_SOURCES.includes(s.source)) { facts++; agents(s); assert.equal(s.manualOnly, true, s.name); }
        else if (s.manualOnly) assert.equal(s.value, null, `${s.name}: manualOnly only while unanswered`);
      }
    }
  }
  assert.ok(facts > 0);
  // The owner's Social Security number: never filled, wherever GEICO asks it.
  const ssn = plan(intake()).filter((s) => s.field === 'GiveSocialSecurityNumber');
  assert.deepEqual(ssn.map((s) => [s.source, s.value, s.manualOnly]), [['fact', null, true]]);
  assert.deepEqual(ssn[0].steps, [BOI, VEH]);
});

test('a blank intake answers nothing but TNI\'s standards', () => {
  for (const active of ACTIVES) {
    for (const s of plan(blank(), active)) {
      if (s.standard) assert.ok(STANDARDS.includes(s.name), s.name);
      else assert.equal(s.value, null, s.name);
    }
  }
  // With nothing on the intake: no customizations, comprehensive and collision $1,000, None, No.
  const p = plan(blank());
  assert.deepEqual(['Customizations (from the attached equipment value)', 'Comprehensive or collision wanted (TNI: Yes)', 'Liability insurance the business has (None unless the notes say)',
    'Named additional insured or waiver of subrogation (TNI: No)', 'Refrigeration breakdown (Yes with a reefer)'].map((n) => one(p, n).value), [false, true, 'None', false, false]);
  for (const name of ['Number of employees (the drivers besides the owner)', 'Years with the current auto insurer (1-3 with a current policy)', 'Driver\'s relationship to the business (Owner, else Employee)']) agents(one(p, name));
});

test('the plan is plain data: steps and form conditions included', () => {
  const r = RECORDS()[1];
  // What the page kit gets is sent as a message: no functions, patterns or class instances.
  const plain = (x, at) => {
    if (x === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof x)) return;
    if (Array.isArray(x)) { x.forEach((y, i) => plain(y, `${at}[${i}]`)); return; }
    assert.equal(Object.getPrototypeOf(x), Object.prototype, at);
    for (const [k, v] of Object.entries(x)) plain(v, `${at}.${k}`);
  };
  for (const active of ACTIVES) buildPlan(r, geico, active).forEach((s) => plain(s, s.name));
  const p = plan(r, { vehicles: 0, drivers: 1, trailers: 0 });
  const VEHICLE_FORM = { field: 'YesNoPreQuoteHaveFullVinActivity', label: null, unit: 'vehicles' };
  const TRAILER_FORM = { field: 'GiveOtherVehicleType', label: '\\btrailer\\b', unit: 'trailers' };
  const ADD_DRIVER = { field: 'GiveDriverRelationshipToBusiness', label: null, unit: 'drivers' };
  assert.deepEqual(one(p, 'Vehicle year').whenShown, VEHICLE_FORM);
  assert.deepEqual(one(p, 'Trailer year').whenShown, TRAILER_FORM);
  assert.deepEqual(one(p, 'Driver first name').whenShown, ADD_DRIVER);
  assert.deepEqual([one(p, 'Owner\'s license state').unlessShown, one(p, 'Owner\'s license state').whenShown], [{ field: 'GiveDriverRelationshipToBusiness', label: null, unit: null }, null]);
  assert.deepEqual(one(p, 'Owner first name', VEH).whenShown, { field: 'GiveSocialSecurityNumber', label: null, unit: null });
  assert.deepEqual([one(p, 'Owner first name', BOI).whenShown, one(p, 'Owner first name', BOI).unlessShown], [null, null]);
  assert.deepEqual(one(p, 'Owner first name', BOI).steps, [BOI]);
  assert.deepEqual(one(p, 'Has a USDOT number').steps, [BCU, ABI]);
});

// --- Vehicles and trailers ----------------------------------------------------------------------

test('a vehicle\'s form and a trailer\'s never answer each other\'s questions', () => {
  const r = RECORDS()[1];
  const p = plan(r, { vehicles: 1, trailers: 0, drivers: 0 });
  // The trailer form's own question reads "…trailer?"; the vehicle form's the same name, "…vehicle?".
  const trailerType = geico.rules.find((x) => x.q === 'GiveOtherVehicleType.trailer');
  const vehicleType = geico.rules.find((x) => x.q === 'GiveOtherVehicleType');
  const label = new RegExp(trailerType.whenShown.label, 'i');
  assert.ok(label.test(trailerType.ask) && !label.test(vehicleType.ask));
  assert.equal(vehicleType.whenShown.field, 'YesNoPreQuoteHaveFullVinActivity');
  assert.ok(!geico.rules.some((x) => x.whenShown?.unit === 'trailers' && x.field === 'YesNoPreQuoteHaveFullVinActivity'), 'the vehicle form\'s question isn\'t on the trailer form');
  // Every question on Vehicles is one form's, but the chooser, the stated amount and the SSN.
  for (const s of p.filter((x) => x.steps?.includes(VEH) && !x.whenShown)) {
    assert.ok(['GiveVehicleOrTrailer', 'GiveStatedAmount', 'GiveSocialSecurityNumber'].includes(s.field), s.field);
  }
  // Each form reads its own unit: the active vehicle (the second), the active trailer (the first).
  for (const s of p.filter((x) => x.whenShown?.unit === 'vehicles')) assert.ok(!/^trailers/.test(s.path), s.name);
  for (const s of p.filter((x) => x.whenShown?.unit === 'trailers')) assert.ok(!/^vehicles/.test(s.path), s.name);
  assert.deepEqual([one(p, 'Vehicle year').path, one(p, 'Vehicle year').value], ['vehicles[1].year', 2019]);
  assert.deepEqual([one(p, 'Trailer year').path, one(p, 'Trailer year').value], ['trailers[0].year', 2015]);
  assert.deepEqual([one(p, 'Vehicle value without customizations', VEH).value, one(p, 'Trailer value without customizations').value], [30000, 12000]);
  assert.match(one(p, 'Trailer type (the agent\'s pick)').note, /"Dry Van"/);
});

test('vehicle type: a cargo van is GEICO\'s Delivery Van and a semi truck its Tractor (TNI); any other type is the agent\'s pick', () => {
  const type = (t) => one(plan(with_({ 'vehicles.0.type': t })), 'Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, else the agent\'s pick)');
  for (const t of ['Van', 'Cargo Van', 'cargo van ']) assert.deepEqual([type(t).value, type(t).source, type(t).standard], ['Delivery Van', 'standard', true], t);
  for (const t of ['Semi Truck', 'semi-truck']) assert.deepEqual([type(t).value, type(t).source, type(t).standard], ['Tractor', 'standard', true], t);
  for (const t of ['Box Truck', 'Passenger Van', 'Semi Trailer', 'Van Trailer', null]) {
    agents(type(t));
    assert.equal(type(t).standard, false, String(t));
  }
  assert.match(type('Box Truck').note, /"Box Truck"/);
  // Per vehicle: the second one, a cargo van.
  const two = with_({ vehicles: [intake().vehicles[0], SECOND_VEHICLE] });
  assert.equal(one(plan(two, { vehicles: 1 }), 'Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, else the agent\'s pick)').value, 'Delivery Van');
  agents(one(plan(two, { vehicles: 0 }), 'Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, else the agent\'s pick)'));
});

test('with a VIN the year, make and model are checked, never typed; without one they are typed', () => {
  const p = plan(intake());
  for (const name of ['Vehicle year', 'Vehicle make', 'Vehicle model']) assert.equal(one(p, name).verifyOnly, true, name);
  assert.deepEqual([one(p, 'VIN at hand').value, one(p, 'VIN').value], [true, '1FTBR3X87MKA12345']);
  const noVin = plan(with_({ 'vehicles.0.vin': null }));
  for (const name of ['Vehicle year', 'Vehicle make', 'Vehicle model']) assert.equal(one(noVin, name).verifyOnly, false, name);
  assert.deepEqual([one(noVin, 'Vehicle year').value, one(noVin, 'Vehicle make').value], [2021, 'FORD']);
  agents(one(noVin, 'VIN at hand'));
  // Per vehicle: the second has no VIN.
  const two = with_({ vehicles: [intake().vehicles[0], { ...SECOND_VEHICLE, vin: null }] });
  assert.equal(one(plan(two, { vehicles: 0 }), 'Vehicle year').verifyOnly, true);
  assert.equal(one(plan(two, { vehicles: 1 }), 'Vehicle year').verifyOnly, false);
  assert.equal(one(plan(RECORDS()[1]), 'Trailer year').verifyOnly, false);
});

test('customizations come from the attached equipment value; the amount only with one unit', () => {
  assert.deepEqual([value(intake(), 'Customizations (from the attached equipment value)'), value(intake(), 'Customization value (the attached equipment value)', VEH)], [false, 0]);
  const one5k = with_({ 'operations.equipVehicle': 5000 });
  assert.deepEqual([value(one5k, 'Customizations (from the attached equipment value)'), value(one5k, 'Customization value (the attached equipment value)', VEH)], [true, 5000]);
  // Two vehicles: which one carries it isn't on the intake.
  const two = with_({ 'operations.equipVehicle': 5000, vehicles: [intake().vehicles[0], SECOND_VEHICLE] });
  const s = one(plan(two), 'Customization value (the attached equipment value)', VEH);
  agents(s);
  assert.match(s.note, /2 vehicles/);
  // Nor whether this vehicle has customizations at all; $0 is still No for each.
  for (const vehicles of [0, 1]) {
    const yes = one(plan(two, { vehicles }), 'Customizations (from the attached equipment value)');
    agents(yes);
    assert.match(yes.note, /\$5,000\) for 2 vehicles/);
  }
  assert.equal(value(with_({ 'operations.equipVehicle': 0, vehicles: [intake().vehicles[0], SECOND_VEHICLE] }), 'Customizations (from the attached equipment value)', undefined, { vehicles: 1 }), false);
  // None on the intake is TNI's standard No (as Progressive's no-equipment), with one vehicle or several.
  for (const vehicles of [[intake().vehicles[0]], [intake().vehicles[0], SECOND_VEHICLE]]) {
    const none = one(plan(with_({ 'operations.equipVehicle': null, vehicles })), 'Customizations (from the attached equipment value)');
    assert.deepEqual([none.value, none.source, none.standard, none.manualOnly], [false, 'standard', true, false]);
  }
  assert.equal(one(plan(intake()), 'Customizations (from the attached equipment value)').source, 'derived', '$0 on the intake');
  // A trailer's: its own equipment value, with one trailer.
  assert.equal(value(with_({ trailers: [TRAILER], 'trailerInfo.equipTrailer': 2000 }), 'Trailer customization value (the trailer equipment value)'), 2000);
  agents(one(plan(with_({ trailers: [TRAILER, TRAILER], 'trailerInfo.equipTrailer': 2000 })), 'Trailer customization value (the trailer equipment value)'));
  agents(one(plan(with_({ trailers: [TRAILER] })), 'Trailer customization value (the trailer equipment value)'));
});

test('distance, personal use and where the unit is parked', () => {
  const band = (miles, radius = `${miles} miles`) => value(with_({ 'operations.radiusMiles': miles, 'operations.radius': radius }), 'Farthest one-way distance (from the radius)');
  assert.deepEqual([band(25), band(26), band(100), band(150), band(500), band(501)], ['0-25', '26-50', '51-100', '101-200', '301-500', 'More than 500']);
  assert.equal(band(null, 'Unlimited'), 'More than 500', 'long haul');
  // An open radius is a lower bound (the reader keeps only its number): 500 and up is "More than
  // 500"; below that the band is the agent's.
  for (const radius of ['500+', 'Over 500', 'more than 500 miles', '600+']) assert.equal(band(Number(radius.match(/\d+/)[0]), radius), 'More than 500', radius);
  for (const radius of ['100+', 'over 300 miles', 'At least 50']) {
    const s = one(plan(with_({ 'operations.radiusMiles': Number(radius.match(/\d+/)[0]), 'operations.radius': radius })), 'Farthest one-way distance (from the radius)');
    agents(s);
    assert.match(s.note, /lower bound/, radius);
  }
  // Miles the agent entered on Check intake count as written.
  assert.equal(band(250, '500+'), '201-300');
  assert.deepEqual([band(150, 'Up to 150'), band(150, 'within 150 miles')], ['101-200', '101-200']);
  const local = one(plan(with_({ 'operations.radiusMiles': null, 'operations.radius': 'Local' })), 'Farthest one-way distance (from the radius)');
  agents(local);
  assert.equal(value(RECORDS()[1], 'Trailer farthest one-way distance (from the radius)'), '101-200');
  // Personal use: No for every vehicle; Yes only with one.
  assert.equal(value(intake(), 'Personal use'), false);
  assert.equal(value(with_({ 'operations.personalUse': true }), 'Personal use'), true);
  const twoYes = one(plan(with_({ 'operations.personalUse': true, vehicles: [intake().vehicles[0], SECOND_VEHICLE] })), 'Personal use');
  agents(twoYes);
  assert.equal(value(with_({ 'operations.personalUse': false, vehicles: [intake().vehicles[0], SECOND_VEHICLE] }), 'Personal use'), false);
  // Parked: GEICO's street is left as it has it; the ZIP and city are the garaging ones.
  const p = plan(intake());
  const street = one(p, 'Where the vehicle is parked: street (as GEICO has it)');
  assert.deepEqual([street.ignore, street.value], [true, null]);
  assert.match(street.emptyNote, /"1 Test Way"/);
  assert.deepEqual([one(p, 'Where the vehicle is parked: ZIP').value, one(p, 'Where the vehicle is parked: city').value], ['68000', 'Testville']);
  // Cost new is the agent's; the weight is GEICO's (TNI: kept as it has it).
  agents(one(p, 'Cost new'));
  const gvw = one(p, 'Gross vehicle weight (as GEICO has it)');
  assert.deepEqual([gvw.ignore, gvw.value, gvw.note], [true, null, null]);
  assert.match(gvw.emptyNote, /registration/);
});

test('comprehensive and collision: TNI adds them with $1,000 deductibles, unless the notes say no', () => {
  const p = plan(with_({ trailers: [TRAILER] }));
  for (const name of ['Comprehensive or collision wanted (TNI: Yes)', 'Trailer comprehensive or collision wanted (TNI: Yes)']) {
    assert.deepEqual([one(p, name).value, one(p, name).source], [true, 'standard'], name);
  }
  for (const name of ['Comprehensive', 'Collision']) assert.deepEqual([one(p, name).value, one(p, name).source, one(p, name).kind], ['$1,000 deductible', 'standard', 'choice'], name);
  // The notes say otherwise: each is the agent's, the line quoted.
  for (const line of ['NO COMP/COLL', 'No physical damage please', 'liability only', 'Client doesn\'t want collision', 'without comprehensive']) {
    const q = plan(with_({ trailers: [TRAILER], 'notes.text': `Financed\n${line}` }));
    for (const name of ['Comprehensive or collision wanted (TNI: Yes)', 'Trailer comprehensive or collision wanted (TNI: Yes)', 'Comprehensive', 'Collision']) {
      agents(one(q, name));
      assert.ok(one(q, name).note.includes(line), `${line}: ${name}`);
    }
  }
  // The claims box's notes count too; its Yes / No line doesn't.
  agents(one(plan(with_({ 'claims.notes': 'no PD' })), 'Comprehensive'));
  for (const line of ['No claims', 'Comp and coll wanted', 'No']) assert.equal(one(plan(with_({ 'notes.text': line })), 'Collision').value, '$1,000 deductible', line);
});

// --- Business and owner -------------------------------------------------------------------------

test('ZIP codes: a ZIP+4 is cut to its ZIP; anything else is the agent\'s', () => {
  assert.equal(value(intake(), 'ZIP code (the garaging ZIP)'), '68000');
  assert.equal(value(with_({ 'garaging.zip': '68000-1234' }), 'ZIP code (the garaging ZIP)'), '68000');
  assert.equal(value(with_({ 'garaging.zip': '680001234' }), 'Business ZIP', BOI), '68000');
  agents(one(plan(with_({ 'garaging.zip': '6800' })), 'Business ZIP', BOI));
  agents(one(plan(with_({ 'garaging.zip': '68000-12' })), 'ZIP code (the garaging ZIP)'));
});

test('USDOT: the number and whether there is one, from the intake', () => {
  const p = plan(intake());
  assert.deepEqual([one(p, 'USDOT #').value, one(p, 'USDOT #').ignore, one(p, 'Has a USDOT number').value], ['1234567', false, 'Yes']);
  // No number, none coming and no MC: No; the number box is left alone.
  const none = plan(with_({ 'applicant.dot': null, 'applicant.mcDotWithin60Days': false }));
  assert.deepEqual([one(none, 'Has a USDOT number').value, one(none, 'USDOT #').ignore], ['No', true]);
  // An MC number only, a number coming, or nothing said: the agent's (never "applied for one").
  for (const changes of [{ 'applicant.mc': 'MC-765432' }, { 'applicant.mcDotWithin60Days': true }, {}]) {
    const s = one(plan(with_({ 'applicant.dot': null, ...changes })), 'Has a USDOT number');
    agents(s);
    assert.equal(s.manualOnly, true);
  }
  agents(one(plan(with_({ 'applicant.dot': 'US 12345' })), 'USDOT #'));
  // GEICO's USDOT record: Yes when it shows the intake's house number, street name and ZIP (TNI, FL
  // live run 5, 2026-10-21, W43-24); the page's text is checked by the kit (`labelHas`).
  const RECORD = 'USDOT record is the client\'s business (Yes when it shows the intake\'s street and ZIP)';
  const verify = one(p, RECORD);
  assert.deepEqual([verify.source, verify.value, verify.labelHas, verify.steps], ['derived', true, ['1', 'Test', '68000'], [BCU, ABI]]);
  assert.match(verify.labelNote, /Check GEICO's USDOT record/);
  assert.deepEqual(one(plan(with_({ 'garaging.street': '4521 N. Ocean Blvd' })), RECORD).labelHas, ['4521', 'Ocean', '68000'], 'a direction and a street type are no name');
  // Without a house number, a street name or a ZIP: the agent's attestation, never the AI's.
  for (const changes of [{ 'garaging.street': 'Test Way' }, { 'garaging.street': null }, { 'garaging.zip': null }, { 'garaging.street': '12 N St' }]) {
    const s = one(plan(with_(changes)), RECORD);
    agents(s);
    assert.deepEqual([s.source, s.manualOnly], ['attestation', true], JSON.stringify(changes));
  }
});

test('a current GEICO commercial auto policy: only one on the intake, current', () => {
  const geicoRow = (more = {}) => ({ priorInsurance: [{ type: 'Commercial Auto', carrier: 'GEICO', limit: '$1M CSL', expiration: '12/31/2026', ...more }] });
  const current = (changes) => value(with_(changes), 'Current GEICO commercial auto policy');
  assert.equal(current({}), false, 'another carrier\'s commercial auto policy');
  assert.equal(current(geicoRow()), true);
  assert.equal(current(geicoRow({ type: 'Personal Auto' })), false, 'a personal auto policy');
  assert.equal(current({ priorInsurance: [{ type: null, carrier: 'None', limit: null, expiration: null }] }), false, 'no prior insurance');
  for (const changes of [geicoRow({ expiration: '01/31/2026' }), geicoRow({ expiration: null }), { priorInsurance: [] },
    { priorInsurance: [{ type: 'General Liability', carrier: 'Other Mutual', limit: null, expiration: '12/31/2026' }] }]) {
    const s = one(plan(with_(changes)), 'Current GEICO commercial auto policy');
    agents(s);
    assert.equal(s.manualOnly, true);
  }
});

test('the owner: from their driver row or the owner box, never the first driver', () => {
  // The first driver isn't the owner.
  const r = with_({ drivers: [CASEY, intake().drivers[0]] });
  const p = plan(r);
  assert.deepEqual(['Owner first name', 'Owner last name', 'Owner date of birth', 'Owner marital status'].map((n) => one(p, n, BOI).value), ['Amina', 'Kone', '01/02/1980', 'Married']);
  assert.deepEqual(['Owner first name', 'Owner date of birth'].map((n) => one(p, n, VEH).value), ['Amina', '01/02/1980'], 'and again with the SSN');
  // The owner doesn't drive: the names from the owner box (a lone middle initial left out), the
  // rest the agent's.
  const box = plan(with_({ 'applicant.owner1': 'Amina K. Kone', 'applicant.ownerDrives': false }));
  assert.deepEqual([one(box, 'Owner first name', BOI).value, one(box, 'Owner last name', BOI).value], ['Amina', 'Kone']);
  for (const name of ['Owner date of birth', 'Owner marital status']) {
    agents(one(box, name, BOI));
    assert.equal(one(box, name, BOI).manualOnly, true);
  }
  assert.equal(value(with_({ 'applicant.owner1': 'Mary Ann Kone', 'applicant.ownerDrives': false }), 'Owner first name', BOI), 'Mary Ann');
  agents(one(plan(with_({ 'applicant.owner1': 'Bartholomew-Alexander Kone', 'applicant.ownerDrives': false })), 'Owner first name', BOI));
  agents(one(plan(with_({ 'drivers.0.dob': '1980' })), 'Owner date of birth', BOI));
  // No driver matches the owner: the date of birth is never another driver's (TNI, 2026-10-20).
  const unmatched = one(plan(with_({ 'applicant.owner1': 'Jordan Sample' })), 'Owner date of birth', BOI);
  agents(unmatched);
  assert.match(unmatched.note, /No driver matches the owner/);
  // A blank owner box: the note says there is no owner name (never quotes an empty one).
  for (const name of [null, '', '  ']) {
    const blank = one(plan(with_({ 'applicant.owner1': name })), 'Owner date of birth', BOI);
    agents(blank);
    assert.match(blank.note, /no owner name/, String(name));
  }
  assert.match(one(plan(with_({ 'applicant.owner1': null, 'applicant.ownerDrives': false })), 'Owner date of birth', BOI).note, /owner doesn't drive/);
  // The business name: the company's, else the owner's (also for a company box saying there is none).
  assert.equal(value(intake(), 'Business name (company, else the owner)', BOI), 'Synthetic Expediter LLC');
  for (const name of [null, 'NO', 'N/A', 'None.']) assert.equal(value(with_({ 'applicant.name': name }), 'Business name (company, else the owner)', BOI), 'Amina Kone', String(name));
  assert.equal(value(intake(), 'Owner is a driver'), true);
  agents(one(plan(with_({ 'applicant.ownerDrives': null })), 'Owner is a driver'));
});

test('ownership type from the company name; no suffix, or no name, is the agent\'s', () => {
  const type = (name, owner1 = 'Amina Kone') => one(plan(with_({ 'applicant.name': name, 'applicant.owner1': owner1 })), 'Business ownership type (from the company name)');
  assert.equal(type('Synthetic Expediter LLC').value, 'Limited Liability Company');
  assert.equal(type('Synthetic Expediter L.L.C.').value, 'Limited Liability Company');
  for (const name of ['Synthetic Freight Inc.', 'Synthetic Freight Corp', 'Synthetic Freight Co']) assert.equal(type(name).value, 'Corporation/Other', name);
  // The rule Progressive and AmWINS share (util.js companyStructure, TNI 2026-10-20).
  for (const name of [null, 'NO', 'N/A', 'No company']) assert.equal(type(name).value, 'Individual/Sole Proprietorship', String(name));
  const mid = type('Synthetic LLC DBA Example');
  assert.deepEqual([mid.value, /LLC inside it/.test(mid.warn ?? '')], ['Limited Liability Company', true]);
  assert.equal(type('Synthetic Expediter LLC').warn, null);
  for (const s of [type('Synthetic Freight'), type('Synthetic Cooperative'), type(null, null), type('NO', null)]) {
    agents(s);
    assert.equal(s.manualOnly, true);
  }
});

test('the business address: unit from the intake, street by GEICO\'s suggestion, phone and email', () => {
  const unit = (u) => { const p = plan(with_({ 'garaging.unit': u })); return [one(p, 'Business unit number', BOI), one(p, 'Business unit type', BOI)]; };
  assert.deepEqual(unit('Suite 200').map((s) => [s.value, s.ignore]), [['200', false], ['Suite', false]]);
  assert.deepEqual(unit('Apt 5').map((s) => s.value), ['5', 'Apartment']);
  const [hashNumber, hashType] = unit('#12');
  assert.equal(hashNumber.value, '12');
  agents(hashType);
  for (const s of unit('Rear')) agents(s);
  // No unit: both boxes as the page has them.
  assert.deepEqual(unit(null).map((s) => s.ignore), [true, true]);
  const p = plan(intake());
  // FL live run 3, 2026-10-21 (W43-09): the intake's address typed whole, GEICO's suggestion for it
  // picked (the page kit: its house number and ZIP); none, and the street alone is the agent's to pick.
  const street = one(p, 'Business street (GEICO\'s suggestion for the intake\'s address)', BOI);
  assert.deepEqual([street.kind, street.source, street.value, street.fallback, street.checkNumber, street.note],
    ['address-suggest', 'derived', '1 Test Way, Testville, NE 68000', '1 Test Way', true, null]);
  // The unit has boxes of its own; a ZIP+4 is cut to its ZIP.
  assert.equal(one(plan(with_({ 'garaging.unit': 'Suite 200', 'garaging.zip': '68000-1234' })), street.name, BOI).value, '1 Test Way, Testville, NE 68000');
  agents(one(plan(with_({ 'garaging.street': null })), street.name, BOI));
  assert.deepEqual([one(p, 'Owner phone (the intake\'s phone)').value, one(p, 'Business phone').value, one(p, 'Customer email').value], ['(555) 010-0100', '(555) 010-0100', 'client@example.test']);
  const raw = plan(with_({ 'applicant.phone': '555-0100' }));
  agents(one(raw, 'Owner phone (the intake\'s phone)'));
  agents(one(raw, 'Business phone'));
  // Prefilled by GEICO, never the intake's.
  const start = one(p, 'Coverage start date (as GEICO has it)');
  assert.deepEqual([start.ignore, start.value], [true, null]);
});

test('business class: For Hire Trucking for an expediter or freight hauler (TNI), else the agent\'s picks; team driving and the placard from the intake', () => {
  const DESCRIPTIONS = ['Business description (For Hire Trucking for an expediter or freight hauler)', 'More about the business (Other For-Hire Trucking for an expediter or freight hauler)'];
  // TNI, 2026-10-21: "that's the equivalent of Expediter and General Freight Hauler".
  for (const businessClass of ['Expediter', 'Freight Hauler', 'General Freight Hauler', 'General Freight Hauling']) {
    const p = plan(with_({ 'operations.businessClass': businessClass }));
    assert.deepEqual(DESCRIPTIONS.map((name) => [one(p, name, BCU).value, one(p, name, BCU).source, one(p, name, BCU).kind, one(p, name, BCU).note]),
      [['For Hire Trucking', 'standard', 'choice', null], ['Other For-Hire Trucking', 'standard', 'choice', null]], businessClass);
  }
  // Any other class (or none): the agent's picks, the intake's words quoted; the AI assistant may suggest them.
  for (const businessClass of ['Household Goods Mover', 'Dump Truck', 'Freight Forwarder', null]) {
    const p = plan(with_({ 'operations.businessClass': businessClass }));
    for (const name of DESCRIPTIONS) {
      const s = one(p, name, BCU);
      agents(s);
      assert.deepEqual([s.source, s.standard, s.manualOnly], ['derived', false, false], `${businessClass}: ${name}`);
      if (businessClass) assert.match(s.note, new RegExp(`"${businessClass}"`));
    }
  }
  const p = plan(intake());
  assert.deepEqual([one(p, 'Team driving or slip seating').value, one(p, 'Hazardous material placard').value], [false, false]);
  assert.equal(value(with_({ 'operations.teamDriving': true }), 'Team driving or slip seating'), true);
  agents(one(plan(with_({ 'operations.teamDriving': null })), 'Team driving or slip seating'));
  const placard = one(plan(with_({ 'operations.hazPlacard': null, 'operations.hazmat': true })), 'Hazardous material placard');
  agents(placard);
  assert.match(placard.note, /hazardous material/);
});

test('filings: the kind and the boxes from which filings the intake names', () => {
  const kind = (changes) => one(plan(with_(changes)), 'State or federal filing');
  assert.equal(kind({}).value, 'Federal');
  assert.equal(kind({ 'operations.filingsWhich': 'Federal Liability Filing' }).value, 'Federal');
  assert.equal(kind({ 'operations.filingsWhich': 'State filing' }).value, 'State');
  assert.equal(kind({ 'operations.filingsWhich': 'BMC-91X and intrastate' }).value, 'Both');
  assert.equal(kind({ 'operations.filingsRequired': false, 'operations.filingsWhich': null }).value, 'Neither');
  assert.equal(kind({ 'operations.filingsWhich': 'MCS-90' }).value, 'Federal');
  assert.equal(kind({ 'operations.filingsWhich': 'Federal liability and BMC-34' }).value, 'Federal');
  assert.equal(kind({ 'operations.filingsWhich': 'BMC-91X, BMC-34 and state' }).value, 'Both');
  // SR-22 and FR-44 aren't filings here; a federal cargo filing isn't liability, and "federal" next
  // to a cargo filing may be that one; unnamed is the agent's.
  for (const changes of [{ 'operations.filingsWhich': 'SR-22' }, { 'operations.filingsWhich': 'SR22 / FR-44' }, { 'operations.filingsWhich': 'Federal cargo (BMC-34)' },
    { 'operations.filingsWhich': 'Federal BMC-34' }, { 'operations.filingsWhich': 'Federal (cargo BMC-34)' }, { 'operations.filingsWhich': 'State and federal cargo' },
    { 'operations.filingsWhich': null }, { 'operations.filingsRequired': null }]) {
    const s = kind(changes);
    agents(s);
    assert.equal(s.manualOnly, true);
  }
  // The boxes: ticked only when named, never unticked.
  const boxes = (changes) => { const p = plan(with_(changes)); return ['Federal liability filing', 'State filing'].map((n) => [one(p, n).value, one(p, n).ignore]); };
  assert.deepEqual(boxes({}), [[true, false], [null, true]]);
  assert.deepEqual(boxes({ 'operations.filingsWhich': 'Federal and state' }), [[true, false], [true, false]]);
  assert.deepEqual(boxes({ 'operations.filingsWhich': 'SR-22' }), [[null, true], [null, true]]);
  assert.deepEqual(boxes({ 'operations.filingsWhich': 'Federal BMC-34' }), [[null, true], [null, true]]);
  assert.deepEqual(boxes({ 'operations.filingsWhich': 'State and federal cargo' }), [[null, true], [true, false]]);
  assert.match(one(plan(with_({ 'operations.filingsWhich': 'Federal BMC-34' })), 'State or federal filing').note, /cargo filing/);
  assert.deepEqual(boxes({ 'operations.filingsRequired': false }), [[null, true], [null, true]]);
  assert.equal(one(plan(intake()), 'MCS-90 filing (as the page has it)').ignore, true);
  assert.equal(value(intake(), 'Filings required'), true);
  agents(one(plan(with_({ 'operations.filingsWhich': 'SR-22' })), 'Filings required'));
  agents(one(plan(with_({ 'operations.filingsRequired': null })), 'Filings required'));
});

// --- Drivers ------------------------------------------------------------------------------------

test('drivers: the owner\'s form from the owner\'s row; Add Driver for the panel\'s driver', () => {
  const r = with_({ drivers: [intake().drivers[0], CASEY] });
  const p = plan(r, { drivers: 1 });
  // The form GEICO adds for an owner who drives: the owner's answers, whoever the panel shows.
  assert.deepEqual([one(p, 'Owner\'s license state').value, one(p, 'Owner has a CDL').value], ['NE', true]);
  // Add Driver: the panel's driver.
  assert.deepEqual(['Driver first name', 'Driver last name', 'Driver date of birth', 'Driver license state', 'Driver has a CDL'].map((n) => one(p, n).value), ['Casey', 'Example', '07/09/1995', 'IA', false]);
  assert.equal(one(p, 'Driver suffix').optional, true);
  // Anyone but an owner: TNI's standard Employee.
  const rel = one(p, 'Driver\'s relationship to the business (Owner, else Employee)');
  assert.deepEqual([rel.value, rel.source, rel.standard, rel.manualOnly], ['Employee', 'standard', true, false]);
  // The owner as the panel's driver while GEICO already lists them: Add Driver isn't filled.
  const owner = plan(r, { drivers: 0 });
  for (const name of ['Driver first name', 'Driver last name', 'Driver date of birth', 'Driver license state', 'Driver has a CDL', 'Driver\'s relationship to the business (Owner, else Employee)']) {
    agents(one(owner, name));
    assert.match(one(owner, name).note, /already lists/);
  }
  // Unless the intake doesn't say the owner drives: then an owner's row is the owner.
  const unsaid = plan(with_({ 'applicant.ownerDrives': null }, r), { drivers: 0 });
  const unsaidRel = one(unsaid, 'Driver\'s relationship to the business (Owner, else Employee)');
  assert.deepEqual([one(unsaid, 'Driver first name').value, unsaidRel.value, unsaidRel.source], ['Amina', 'Owner', 'derived']);
  const second = plan(with_({ 'applicant.owner2': 'Casey Example' }, r), { drivers: 1 });
  assert.equal(one(second, 'Driver\'s relationship to the business (Owner, else Employee)').value, 'Owner', 'the second owner');
  // GEICO lists the owner who drives itself: an Add Driver form is never theirs (sidepanel pickUnitForm).
  const two = () => with_({ drivers: [intake().drivers[0], CASEY] });
  assert.deepEqual([geico.listedDriver(two()), geico.listedDriver(with_({ 'applicant.ownerDrives': false }, two())), geico.listedDriver(with_({ 'applicant.owner1': 'Jordan Sample' }, two()))], [0, -1, -1]);
  assert.equal(geico.listedDriver(with_({ drivers: [CASEY, intake().drivers[0]] })), 1);
  // An excluded driver: filled, flagged.
  assert.match(one(plan(with_({ 'drivers.1.excluded': true }, r), { drivers: 1 }), 'Driver first name').warn, /excluded/);
  assert.equal(one(p, 'Driver first name').warn, null);
});

// FL live run, 2026-10-21: "click + and add the new vehicle", "click Next after choosing Vehicle or
// Trailer". The panel names the unit it adds (`adding`, sidepanel pickUnitToAdd); with "Click Continue
// when the page is done" on (`click`) the fill clicks the list's "+" and the chooser's Next for it.
test('adding units: the chooser answers the unit the panel adds; its "+" and Next are clicked once per unit, only with the setting on', () => {
  const r = RECORDS()[1];
  const actions = (active) => buildPlan(r, geico, active).filter((s) => s.kind === 'action');
  const chooser = (active) => one(plan(r, active), 'Vehicle or trailer to add (the next intake unit not on the quote)', VEH);
  // Nothing to add, or not known: no helper, and the chooser is the agent's, never the AI assistant's.
  for (const active of [{}, { vehicles: 1 }]) {
    assert.deepEqual(actions(active), []);
    agents(chooser(active));
    assert.deepEqual([chooser(active).source, chooser(active).manualOnly], ['fact', true]);
  }
  // Vehicle 2, the setting off: Vehicle on the chooser, nothing clicked.
  const off = { vehicles: 1, drivers: 0, trailers: 0, adding: { list: 'vehicles', index: 1, click: false } };
  assert.deepEqual([chooser(off).value, chooser(off).source], ['Vehicle', 'derived']);
  assert.deepEqual(actions(off), []);
  // On: the "+" in the vehicle list's add row, then the chooser's Next once it shows Vehicle, both
  // vehicle 2's (ids per unit: clicked once a quote), on Vehicles only.
  const on = { ...off, adding: { ...off.adding, click: true } };
  const [add, next] = actions(on);
  assert.deepEqual([add.action, add.token, add.within, add.steps, add.verify, add.loads, add.moveOn], ['addVehicle:1', 'addIcon', '#summaryPage-AddCommercialVehicle > li.add-state', [VEH], 'revealed', true, false]);
  assert.deepEqual(add.doneWhen, ['vehicleEntered:1']);
  assert.match(add.unfinished, /vehicle 2 of the intake.*\+, Vehicle, Next/);
  assert.deepEqual([next.action, next.text, next.moveOn, next.after, next.steps], ['chooseVehicle:1', '^next$', true, ['geico.qGiveVehicleOrTrailer'], [VEH]]);
  // Only after the fill's own "+" for that unit: a chooser the agent opened is answered, its Next theirs.
  assert.deepEqual(next.afterActions, ['addVehicle:1']);
  assert.match(next.within, /VehicleOrTrailerCollectAdaptiveActionSet_Container/);
  // The picker isn't on the unit being added (a stale pick): nothing clicked.
  assert.deepEqual(actions({ ...on, vehicles: 0 }), []);
  // The trailer: Trailer on the chooser, its own helpers.
  const trailer = { vehicles: 1, drivers: 0, trailers: 0, adding: { list: 'trailers', index: 0, click: true } };
  assert.equal(chooser(trailer).value, 'Trailer');
  assert.deepEqual(actions(trailer).map((a) => a.action), ['addTrailer:0', 'chooseTrailer:0']);
  // Driver 2 (the owner, GEICO lists, is driver 1): the "+" of the driver list's add row, never the
  // incidents' below it. No chooser there.
  const driver = { vehicles: 1, drivers: 1, trailers: 0, adding: { list: 'drivers', index: 1, click: true } };
  const [addDriver, ...rest] = actions(driver);
  assert.deepEqual([addDriver.action, addDriver.within, addDriver.steps, rest], ['addDriver:1', '#summaryPage-AddDriver > li.add-state', [DRV], []]);
  agents(chooser(driver));
  // An owner who drives under a name no driver row matches, or "owner drives" unanswered: GEICO's
  // own driver row may be one of the intake's, so Add Driver is the agent's.
  for (const changes of [{ 'applicant.owner1': 'Jordan Sample' }, { 'applicant.ownerDrives': null }]) {
    assert.deepEqual(buildPlan(with_(changes, RECORDS()[1]), geico, driver).filter((s) => s.kind === 'action'), []);
  }
  assert.equal(buildPlan(with_({ 'applicant.ownerDrives': false }, RECORDS()[1]), geico, driver).filter((s) => s.kind === 'action').length, 1);
  // Never a button that leaves a step or commits: only the add icon, and Next inside the chooser.
  for (const a of geico.actions) assert.ok(a.token === 'addIcon' || (a.text === '^next$' && a.moveOn && /VehicleOrTrailer/.test(a.within)), a.id);
});

test('SR-22: No for everyone; Yes only when GEICO lists one driver', () => {
  assert.deepEqual([value(intake(), 'SR-22 (the owner)'), value(intake(), 'SR-22 (this driver)', DRV, { drivers: 0 })], [false, null]);
  assert.equal(value(with_({ 'operations.needSr22': true }), 'SR-22 (the owner)'), true);
  const two = with_({ 'operations.needSr22': true, drivers: [intake().drivers[0], CASEY] });
  agents(one(plan(two), 'SR-22 (the owner)'));
  agents(one(plan(two, { drivers: 1 }), 'SR-22 (this driver)'));
  assert.equal(value(with_({ drivers: [intake().drivers[0], CASEY] }), 'SR-22 (this driver)', DRV, { drivers: 1 }), false);
  // The owner listed besides the intake's only driver: GEICO has two, so neither is answered.
  const other = with_({ 'operations.needSr22': true, 'applicant.owner1': 'Jordan Sample' });
  agents(one(plan(other), 'SR-22 (the owner)'));
  agents(one(plan(other, { drivers: 0 }), 'SR-22 (this driver)'));
  assert.match(one(plan(other), 'SR-22 (the owner)').note, /drivers GEICO lists/);
  // The owner doesn't drive: the intake's only driver is GEICO's only one.
  assert.equal(value(with_({ 'operations.needSr22': true, 'applicant.ownerDrives': false, 'applicant.owner1': 'Jordan Sample' }), 'SR-22 (this driver)', DRV, { drivers: 0 }), true);
  // Whether the owner drives isn't on the intake: Add Driver's is the agent's.
  agents(one(plan(with_({ 'operations.needSr22': true, 'applicant.ownerDrives': null, 'applicant.owner1': 'Jordan Sample' }), { drivers: 0 }), 'SR-22 (this driver)'));
  // The owner's own form: the owner isn't matched to a driver.
  agents(one(plan(with_({ 'applicant.owner1': 'Jordan Sample' })), 'Owner\'s license state'));
});

// --- Additional business info -------------------------------------------------------------------

test('years in business, current insurance and its limits', () => {
  const years = (n) => one(plan(with_({ 'applicant.yearsInBusiness': n })), 'Years in business');
  assert.deepEqual([0, 1, 2, 3, 6, 7, 30].map((n) => years(n).value), ['Less than 1', '1', '2', '3-6', '3-6', '7+', '7+']);
  agents(years(null));
  const auto = (changes) => one(plan(with_(changes)), 'Currently has auto insurance');
  assert.equal(auto({}).value, 'Yes');
  assert.equal(auto({ 'priorInsurance.0.type': 'Personal Auto' }).value, 'Yes');
  assert.equal(auto({ priorInsurance: [{ type: null, carrier: 'No', limit: null, expiration: null }] }).value, 'No');
  for (const changes of [{ 'priorInsurance.0.expiration': '01/31/2026' }, { 'priorInsurance.0.expiration': null }, { priorInsurance: [] },
    { 'priorInsurance.0.type': 'General Liability' }]) {
    agents(auto(changes));
    assert.equal(auto(changes).manualOnly, true);
  }
  // The current limit: GEICO's wording of it, exactly; none is "closest".
  const bi = (changes) => one(plan(with_(changes)), 'Current bodily injury limits');
  assert.equal(bi({}).value, '$1,000,000/$1,000,000 or $1,000,000 CSL');
  assert.equal(bi({ 'priorInsurance.0.limit': '$100K/$300K' }).value, '$100,000/$300,000');
  for (const changes of [{ 'priorInsurance.0.limit': '$500K/$1M' }, { 'priorInsurance.0.limit': 'Other' }, { 'priorInsurance.0.expiration': '01/31/2026' }]) agents(bi(changes));
  agents(one(plan(intake()), 'Insured before being deployed'));
});

test('employees, years with the insurer, additional insureds: TNI\'s answers', () => {
  // The intake's drivers besides the owner, as GEICO's band.
  const employees = (drivers, changes = {}) => one(plan(with_({ drivers, ...changes })), 'Number of employees (the drivers besides the owner)');
  const owner = intake().drivers[0];
  const others = (n) => Array.from({ length: n }, (_, i) => ({ ...CASEY, first: `Casey${i}` }));
  assert.deepEqual([[owner], [owner, CASEY], [owner, ...others(3)], [owner, ...others(5)], others(1), others(21)].map((d) => employees(d).value), ['None', '1', '2-3', '4-5', '1', '21+']);
  assert.deepEqual([employees([owner, CASEY]).source, employees([owner, CASEY]).standard], ['standard', true]);
  // The second owner isn't an employee either.
  assert.equal(employees([owner, CASEY], { 'applicant.owner2': 'Casey Example' }).value, 'None');
  agents(employees([]));
  // 1-3 Years with a current auto policy on the intake (proof of prior insurance); otherwise the agent's.
  const years = (changes) => one(plan(with_(changes)), 'Years with the current auto insurer (1-3 with a current policy)');
  assert.deepEqual([years({}).value, years({}).source, years({ 'priorInsurance.0.type': 'Personal Auto' }).value], ['1-3 Years', 'standard', '1-3 Years']);
  for (const changes of [{ priorInsurance: [] }, { 'priorInsurance.0.expiration': '01/31/2026' }, { priorInsurance: [{ type: null, carrier: 'No', limit: null, expiration: null }] }]) agents(years(changes));
  // Additional insureds and waivers: No.
  for (const name of ['Named additional insured or waiver of subrogation (TNI: No)', 'Blanket additional insured by contract (TNI: No)', 'Blanket waiver of subrogation by contract (TNI: No)']) {
    assert.deepEqual([one(plan(intake()), name).value, one(plan(intake()), name).source], [false, 'standard'], name);
  }
});

test('liability insurance the business has: GL from a current GL policy on the intake, else TNI\'s None', () => {
  const other = (changes) => one(plan(with_(changes)), 'Liability insurance the business has (None unless the notes say)');
  const gl = { type: 'General Liability', carrier: 'Other Mutual', limit: null, expiration: '12/31/2026' };
  assert.deepEqual([other({ priorInsurance: [gl] }).value, other({ priorInsurance: [gl] }).source], ['General Liability Policy (GL)', 'derived']);
  assert.equal(other({ priorInsurance: [gl], 'coverage.hasGl': true }).value, 'General Liability Policy (GL)');
  // GL the agent marked from the notes doesn't say which: the agent's.
  const marked = other({ 'coverage.hasGl': true });
  agents(marked);
  assert.match(marked.note, /You marked/);
  assert.equal(marked.manualOnly, true);
  // Nothing in the notes (a GL request isn't GL they have; an expired GL policy isn't current): None.
  for (const changes of [{ 'coverage.gl': true }, {}, { 'coverage.hasGl': false }, { priorInsurance: [{ ...gl, expiration: '01/31/2026' }] }]) {
    assert.deepEqual([other(changes).value, other(changes).source, other(changes).manualOnly], ['None', 'standard', false], JSON.stringify(changes));
  }
});

// --- Quote & Coverages --------------------------------------------------------------------------

test('liability coverage and its limit from the intake; NTL is the agent\'s', () => {
  const liab = (changes) => { const p = plan(with_(changes)); return [one(p, 'Liability coverage'), one(p, 'Liability limit')]; };
  const [type, limit] = liab({});
  assert.deepEqual([type.value, limit.value], ['Bodily Injury and Property Damage Liability', '$1M CSL']);
  assert.equal(liab({ 'coverage.autoLiability': null })[0].value, 'Bodily Injury and Property Damage Liability', 'a limit with the box blank');
  // NTL mentioned and not decided, NTL wanted, or no auto liability: both the agent's.
  for (const changes of [{ 'claims.text': 'Client also wants NTL' }, { 'coverage.ntl': true }, { 'coverage.autoLiability': 'No' }, { 'coverage.autoLiability': null, 'coverage.autoLiabLimit': null }]) {
    for (const s of liab(changes)) agents(s);
  }
  assert.match(liab({ 'notes.text': 'bobtail cover' })[0].note, /Check intake/);
  // Decided No on Check intake: the intake's liability.
  assert.equal(liab({ 'claims.text': 'Client also wants NTL', 'coverage.ntl': false })[0].value, 'Bodily Injury and Property Damage Liability');
  for (const name of ['Uninsured motorist bodily injury', 'Medical payments (FL: Not Included, PIP instead)', 'Policy term', 'Basic personal injury protection']) agents(one(plan(intake()), name));
  const pay = plan(intake()).filter((s) => s.name === 'Payment plan');
  assert.deepEqual(pay.map((s) => [s.each, s.value, s.source]), [[true, null, 'fact'], [true, null, 'fact']]);
});

test('Florida: medical payments Not Included, PIP kept as GEICO offers it (TNI)', () => {
  const fl = plan(with_({ 'garaging.state': 'FL' }));
  const med = one(fl, 'Medical payments (FL: Not Included, PIP instead)');
  assert.deepEqual([med.value, med.source, med.kind], ['Not Included', 'standard', 'choice']);
  for (const name of ['Basic personal injury protection', 'PIP options', 'Excluded work loss', 'Stacked uninsured motorist']) {
    const s = one(fl, name);
    assert.deepEqual([s.ignore, s.value, s.source, s.note], [true, null, null, null], name);
    assert.match(s.emptyNote, /left .* empty/);
  }
  assert.equal(one(plan(with_({ 'garaging.state': ' fl ' })), 'Medical payments (FL: Not Included, PIP instead)').value, 'Not Included');
  // Elsewhere: the agent's.
  for (const name of ['Medical payments (FL: Not Included, PIP instead)', 'Basic personal injury protection', 'Excluded work loss']) agents(one(plan(intake()), name));
});

test('cargo: the intake\'s limit and deductible as one pair; never a default deductible', () => {
  const p = plan(intake());
  assert.deepEqual([one(p, 'Motor truck cargo wanted').value, one(p, 'Motor truck cargo limit and deductible').value], [true, '$100000/$1000']);
  agents(one(plan(with_({ 'coverage.cargoDeductible': null })), 'Motor truck cargo limit and deductible'));
  agents(one(plan(with_({ 'coverage.cargo': false })), 'Motor truck cargo limit and deductible'));
  agents(one(plan(with_({ 'coverage.cargo': null })), 'Motor truck cargo wanted'));
  // Household goods: Yes for a household goods mover; otherwise the agent's, never No.
  const goods = (cls) => one(plan(with_({ 'operations.businessClass': cls })), 'Cargo: household goods or freshly ginned cotton (Yes for a household goods mover)');
  assert.deepEqual([goods('Household Goods Mover').value, goods('Household Goods Mover').source], [true, 'derived']);
  assert.deepEqual([goods('Expediter').value, goods('Expediter').source], [null, 'fact']);
  agents(one(p, 'Cargo commodities'));
  assert.match(one(p, 'Cargo commodities').note, /"General freight"/);
  // Refrigeration breakdown: the intake's answer; blank is Yes with a reefer (TNI), else No.
  const reefer = (changes) => one(plan(with_(changes)), 'Refrigeration breakdown (Yes with a reefer)');
  const REEFER = { ...TRAILER, type: 'Reefer' };
  assert.deepEqual([reefer({}).value, reefer({}).source], [false, 'intake']);
  assert.deepEqual([reefer({ 'coverage.reeferBreakdown': true }).value, reefer({ 'coverage.reeferBreakdown': true }).source], [true, 'intake']);
  assert.deepEqual([reefer({ 'coverage.reeferBreakdown': null, trailers: [REEFER] }).value, reefer({ 'coverage.reeferBreakdown': null, trailers: [REEFER] }).source], [true, 'standard']);
  assert.equal(reefer({ 'coverage.reeferBreakdown': null, 'vehicles.0.type': 'Refrigerated Truck' }).value, true);
  assert.deepEqual([reefer({ 'coverage.reeferBreakdown': null }).value, reefer({ 'coverage.reeferBreakdown': null }).source], [false, 'standard']);
  // The intake says No but lists a reefer: the agent's.
  const conflict = reefer({ trailers: [REEFER] });
  agents(conflict);
  assert.match(conflict.note, /lists a reefer/);
});

test('general liability: the intake\'s request and a limit GEICO lists, no TNI default', () => {
  const gl = (changes) => { const p = plan(with_(changes)); return [one(p, 'Motor truck general liability wanted'), one(p, 'Motor truck general liability limit')]; };
  assert.deepEqual(gl({ 'coverage.gl': true, 'coverage.glLimit': '$1M/$2M' }).map((s) => s.value), [true, '$1,000,000/$2,000,000 aggregate']);
  for (const changes of [{ 'coverage.gl': true }, { 'coverage.gl': true, 'coverage.glLimit': '$2M/$4M' }, {}]) agents(gl(changes)[1]);
  // GL the client already has isn't a request.
  assert.equal(gl({ 'coverage.hasGl': true })[0].value, false);
  for (const name of ['GL: all income from for-hire trucking', 'GL: premises customers visit', 'GL: setup or installation', 'GL: oil and gas production']) agents(one(plan(intake()), name));
});

test('a vehicle\'s coverage rows: by the coverage their id ends in, one step per vehicle', () => {
  const r = with_({ vehicles: [intake().vehicles[0], SECOND_VEHICLE] });
  const p = plan(r, { vehicles: 1 });
  const comp = p.filter((s) => s.name === 'Comprehensive');
  assert.deepEqual(comp.map((s) => [s.selector, s.scope, s.activeVehicle]), [['[id$="_COMP"]', 'vehicle', false], ['[id$="_COMP"]', 'vehicle', true]]);
  assert.deepEqual(comp.map((s) => s.vehicleHint), [['2021', 'ford', 'f 650'], ['2019', 'ram', 'promaster']]);
  // Comprehensive and collision are TNI's $1,000 deductibles; the other rows the agent's.
  for (const s of comp) assert.deepEqual([s.value, s.standard], ['$1,000 deductible', true]);
  for (const name of ['Fire and theft', 'Rental reimbursement', 'Emergency road service', 'Heavy vehicle road service']) for (const s of p.filter((x) => x.name === name)) agents(s);
  // The customization boxes there name no vehicle: the value only with one vehicle.
  const values = p.filter((s) => s.name === 'Vehicle value without customizations' && s.steps.includes(QC));
  assert.deepEqual(values.map((s) => [s.path, s.value]), [['vehicles[0].value', 45000], ['vehicles[1].value', 30000]]);
  const single = plan(intake()).filter((s) => s.steps?.includes(QC) && s.scope === 'vehicle');
  assert.ok(single.every((s) => s.activeVehicle === null && s.vehicleHint === null), 'one vehicle: no rows to tell apart');
});

test('notes are short and plain', () => {
  for (const r of RECORDS()) {
    for (const active of ACTIVES) {
      for (const s of plan(r, active)) {
        for (const text of [s.note, s.emptyNote, s.warn].filter(Boolean)) {
          assert.ok(text.length <= 240, `${s.name}: ${text.length} characters`);
          assert.ok(!/undefined|null|NaN|\[object/.test(text), `${s.name}: ${text}`);
        }
      }
    }
  }
});

// FL live run 2, 2026-10-21: GEICO's VIN decode redrew the vehicle form and cleared the type (the
// Cascadia's Tractor, three times), distance and personal use given before it.
test('with a VIN, the vehicle form\'s answers wait for GEICO\'s decoded year; without one, nothing waits', () => {
  const WAITING = ['Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, else the agent\'s pick)', 'Customizations (from the attached equipment value)',
    'Customization value (the attached equipment value)', 'Vehicle value without customizations', 'Comprehensive or collision wanted (TNI: Yes)',
    'Farthest one-way distance (from the radius)', 'Personal use'];
  const withVin = plan(intake());
  for (const name of WAITING) assert.equal(one(withVin, name, VEH).waitFor, 'GiveYear', name);
  for (const s of withVin.filter((x) => !(WAITING.includes(x.name) && x.steps?.includes(VEH)))) assert.equal(s.waitFor, null, s.name);
  const noVin = plan(with_({ 'vehicles.0.vin': null }));
  for (const name of WAITING) assert.equal(one(noVin, name, VEH).waitFor, null, name);
  // Per vehicle: the second one has its own VIN.
  const two = with_({ vehicles: [{ ...intake().vehicles[0], vin: null }, SECOND_VEHICLE] });
  assert.equal(one(plan(two, { vehicles: 0 }), WAITING[0], VEH).waitFor, null);
  assert.equal(one(plan(two, { vehicles: 1 }), WAITING[0], VEH).waitFor, 'GiveYear');
});
