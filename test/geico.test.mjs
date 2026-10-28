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
const VEHICLE_TYPE = 'Vehicle type (Delivery Van for a cargo van, Tractor for a semi truck, Box Truck or else Box/Straight Truck for a box truck, else the agent\'s pick)';

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
  // Helpers: those adding a unit the panel is adding (below), and on Quote & Coverages (TNI, FL live
  // run 4, 2026-10-21): Motor Truck Cargo opened when the intake asks for cargo (W43-16), then, once
  // nothing there is left for the agent: Recalculate, once a quote, on a page quiet for 2 s, every
  // answer checked after GEICO's redraw (W43-31, after FL live run 6, 2026-10-21: GEICO put its own
  // coverage choices back after each one the fill clicked at once); with the premium current, View
  // More Payment Plans and Print Quote Proposal once a plan is picked (W43-18, W43-32). Quote & Coverages takes
  // follow-ups only for questions it draws (FL live run 2: the cargo section's); an answer GEICO takes
  // back there is kept by an automatic fill (the agent's Fill this page gives it again: sidepanel).
  const quoteHelpers = (r) => buildPlan(r, geico, {}).filter((s) => s.kind === 'action').map((s) => [s.action, s.steps, s.whenClear, s.verify]);
  assert.deepEqual(quoteHelpers(with_({ 'coverage.cargo': null })), [['recalculate', [QC], true, 'premium'], ['morePayPlans', [QC], true, null], ['printProposal', [QC], true, null]]);
  const recalc = buildPlan(intake(), geico, {}).find((s) => s.action === 'recalculate');
  assert.deepEqual([recalc.needsRecalculation, recalc.waitRequired, recalc.quietMs, recalc.once, recalc.keepAnswers], [true, true, 2000, true, true]);
  // Rated once the pay plans are drawn (2026-10-26: a total showed with none).
  assert.equal(recalc.ratedBy, '[id^="Id_GivePayPlanV2_"]');
  assert.deepEqual(quoteHelpers(with_({ 'coverage.cargo': true }))[0], ['openCargo', [QC], false, null]);
  assert.ok(!quoteHelpers(with_({ 'coverage.cargo': false })).some(([id]) => id === 'openCargo'));
  const cargo = geico.actions.find((a) => a.id === 'openCargo');
  assert.deepEqual([cargo.token, cargo.within, cargo.unlessSelector], ['editIcon', 'li[id^="Id_MtcCoverageQuestionsComboActivityData_"]', 'li[id^="Id_MtcCoverageQuestionsComboActivityData_"].expanded']);
  // Print once a pay plan is picked: 11 Payments, or the plan the fill picked in its place.
  assert.deepEqual(geico.actions.find((a) => a.id === 'printProposal').after, ['geico.qGivePayPlanV2']);
  // 11 Payments not offered once View More Payment Plans was clicked: the plan with the most
  // payments offered, Pay In Full counting one (W43-32; the page kit picks it).
  const ORMOST = { count: '^(\\d+)\\s+payments?\\b', one: '^pay\\s+in\\s+full\\b', after: 'morePayPlans', name: 'the plan with the most payments GEICO offers' };
  assert.deepEqual(buildPlan(intake(), geico, {}).filter((s) => s.field === 'GivePayPlanV2').map((s) => [s.value, s.whenOffered, s.orMost]), [['11 Payments', true, ORMOST], ['11 Payments', true, ORMOST]]);
  const most = (texts) => texts.map((t) => (new RegExp(ORMOST.one, 'i').test(t) ? 1 : Number(new RegExp(ORMOST.count, 'i').exec(t)?.[1] ?? NaN)));
  assert.deepEqual(most(['Pay In Full', '4 Payments Bi-Monthly Plan', '9 Payments', '11 Payments', 'Paperless discount']), [1, 4, 9, 11, NaN]);
  assert.ok(geico.actions.filter((a) => a.steps.includes(QC) && !['openCargo', 'recalculate', 'ntlLease'].includes(a.id)).every((a) => a.needsPremium), 'each waits for a current premium');
  for (const a of geico.actions) assert.ok(a.steps.every((s) => [VEH, DRV, QC].includes(s)), a.id);
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
  assert.deepEqual(gateway.map((r) => [r.selector, r.notPages, r.steps ?? null]), [['#start-quote-zip', ['/quote'], null], ['#dashboard-usdot', ['/quote'], null],
    [`${product}#commercial, ${product}[value="commercial"]`, ['/quote'], null], ['#start-quote-usdot', ['/quote'], null],
    ...['input[name="header-search-type"]', '#search-input-id', product, '[id^="alerts-pref"]'].map((sel) => [sel, ['/quote'], null])]);
  // The gateway's own controls are never answered, one rule each (a selector rule answers its first
  // match only: FL live run 3, 2026-10-21, the header search took the rule that named the products).
  assert.ok(gateway.slice(4).every((r) => r.ignore === true));
  // The product boxes Commercial Auto's rule didn't take, however many (W43-25): one rule for all.
  assert.deepEqual(gateway.filter((r) => r.every).map((r) => r.selector), [product]);
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

// W43-28, W43-35 (TNI, 2026-10-21): the Start New Quote ZIP GEICO carried over is replaced (the
// agent's own stays: the fill's skip); a city GEICO doesn't list for the ZIP leaves GEICO's, checked.
// W43-27: GEICO's "Add USDOT Number / Skip" screen is the agent's, known by its button.
test('the gateway ZIP replaces a carried-over one; a city GEICO doesn\'t list keeps GEICO\'s; the USDOT screen is a stop', () => {
  const zip = geico.rules.find((r) => r.selector === '#start-quote-zip');
  assert.deepEqual([zip.replace, zip.path, zip.source], [true, 'garaging.zip', 'derived']);
  assert.ok(geico.rules.filter((r) => r.selector !== '#start-quote-zip').every((r) => !r.replace), 'no other GEICO rule replaces');
  const cities = geico.rules.filter((r) => r.field === 'GiveCity');
  assert.ok(cities.length >= 2 && cities.every((r) => r.keepUnlisted && r.kind === 'choice' && r.path === 'garaging.city'));
  const p = plan(intake());
  assert.ok(p.filter((s) => s.path === 'garaging.city').every((s) => s.keepUnlisted && s.value === 'Testville'));
  assert.equal(p.find((s) => s.name === 'Start quote: ZIP (the garaging ZIP)').replace, true);
});

// TNI's GEICO standards (FL live run, 2026-10-21): only these rules may be one.
const STANDARDS = [
  VEHICLE_TYPE, 'Customizations (from the attached equipment value)',
  'Comprehensive or collision wanted (TNI: Yes)', 'Trailer comprehensive or collision wanted (TNI: Yes)',
  'Driver\'s relationship to the business (Owner, else Employee)', 'Number of employees (the drivers besides the owner)',
  'Years with the current auto insurer (1-3 with a current policy)', 'Liability insurance the business has (None unless the notes say)',
  'Named additional insured or waiver of subrogation (TNI: No)', 'Blanket additional insured by contract (TNI: No)', 'Blanket waiver of subrogation by contract (TNI: No)',
  'Medical payments (TNI: $5,000; Not Included where GEICO offers no limit)', 'Basic personal injury protection (TNI: declined beside medical payments, else $2,500; FL: as GEICO has it)', 'Comprehensive', 'Collision', 'Refrigeration breakdown (Yes with a reefer)',
  'Business description (For Hire Trucking for an expediter or freight hauler)', 'More about the business (Other For-Hire Trucking for an expediter or freight hauler)',
  'Start quote: Commercial Auto/Trucking (TNI: ticked)',
  // FL live run 4, 2026-10-21 (W43-17, W43-18): GEICO in every state.
  'Emergency road service (TNI: accepted)', 'Heavy vehicle road service (TNI: accepted)',
  'Uninsured motorist bodily injury (TNI: $100,000 CSL; TX $100,000/$300,000)', 'Payment plan (TNI: 11 Payments)',
  // FL live run 5, 2026-10-21 (W43-22, W43-23): GEICO in every state.
  'Fire and theft (TNI: Not Included)', 'Rental reimbursement (TNI: $40 Per Day, $1,200 Max)',
  'Cargo: mobile homes, business documents or securities (TNI: No unless the intake names them)', 'Cargo: live animals (TNI: No unless the intake names them)',
  // The 2026-10-21 live runs' review (W43-30, W43-33, W43-34): GEICO in every state.
  'Customization value (the attached equipment value, else TNI: 0)', 'Trailer customization value (the trailer equipment value, else TNI: 0)',
  'Cargo: household goods or freshly ginned cotton (Yes for a household goods mover; TNI: No unless the intake mentions them)',
  'Rental reimbursement with downtime (TNI: Not Included)',
  'Uninsured motorist bodily injury, UMBI (TNI: $100,000 CSL)', 'Underinsured motorist bodily injury, UIMBI (TNI: $100,000 CSL)',
  'Uninsured motorist deductible (TNI: $1,000)', 'UM/UIM type (TNI: Add-On)',
  'SR-22 (the owner; TNI: No unless the intake says otherwise)', 'SR-22 (this driver; TNI: No unless the intake says otherwise)',
  'Hazardous material placard (TNI: No unless the intake says otherwise)', 'Team driving or slip seating (TNI: No unless the intake says otherwise)',
  'Filings required (TNI: No unless the intake says otherwise)', 'Driver has a CDL (TNI: No when the intake leaves it blank)',
  'Owner has a CDL (TNI: No when the intake leaves it blank)',
];
// TNI, 2026-10-26 (W44-25): "Owner Drivers if not excluded, in every case".
const OWNER_DRIVES = 'Owner is a driver (TNI: Yes when the intake leaves it blank, unless excluded)';
const OWNER_DRIVES_ADD = 'Owner is a driver (Add Driver; TNI: Yes when the intake leaves it blank, unless excluded)';
// TNI, 2026-10-27: Yes when the owner drives, No otherwise; with the owner-drives box blank, TNI's.
const OWNER_DAILY = 'Owner involved in daily operations (Yes when the owner drives)';
STANDARDS.push(OWNER_DRIVES, OWNER_DRIVES_ADD, OWNER_DAILY);

test('TNI\'s GEICO standards are the recorded ones, and only GEICO\'s own rules answer', () => {
  const seen = new Set();
  const records = [...RECORDS(), with_({ 'garaging.state': 'FL', 'coverage.reeferBreakdown': null, 'operations.equipVehicle': null, 'vehicles.0.type': 'Van' }),
    with_({ drivers: [{ ...intake().drivers[0], cdl: null, cdlYear: null }, { ...CASEY, cdl: null }] })];
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
  // The 2026-10-21 review's (W43-30, W43-34): No, 0 and Not Included where the intake says nothing.
  assert.deepEqual(['Team driving or slip seating (TNI: No unless the intake says otherwise)', 'Hazardous material placard (TNI: No unless the intake says otherwise)',
    'Filings required (TNI: No unless the intake says otherwise)', 'SR-22 (the owner; TNI: No unless the intake says otherwise)',
    'Cargo: household goods or freshly ginned cotton (Yes for a household goods mover; TNI: No unless the intake mentions them)',
    'Customization value (the attached equipment value, else TNI: 0)'].map((n) => one(p, n, n.startsWith('Customization') ? VEH : undefined).value), [false, false, false, false, false, 0]);
  // ELD has no standard; whether the owner drives is TNI's Yes (W44-25), and daily operations
  // follows it (TNI, 2026-10-27), TNI's too.
  agents(one(p, 'Electronic logging device (ELD)'));
  assert.deepEqual([one(p, OWNER_DRIVES).value, one(p, OWNER_DRIVES).source], [true, 'standard']);
  assert.deepEqual([one(p, OWNER_DAILY, BOI).value, one(p, OWNER_DAILY, BOI).source], [true, 'standard']);
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

// TNI, 2026-10-26, W44-32 (PA live run: an intake "Box Truck" was the agent's, who picked
// Box/Straight Truck; the maintainer: "If Box Truck is available, yes, if no, Box/Straight Truck").
test('vehicle type: a cargo van is GEICO\'s Delivery Van, a semi truck its Tractor, a box truck its Box Truck or else Box/Straight Truck (TNI); any other type is the agent\'s pick', () => {
  const type = (t) => one(plan(with_({ 'vehicles.0.type': t })), VEHICLE_TYPE);
  const answer = (t) => [type(t).value, type(t).choiceAliases, type(t).source, type(t).standard];
  for (const t of ['Van', 'Cargo Van', 'cargo van ']) assert.deepEqual(answer(t), ['Delivery Van', [], 'standard', true], t);
  for (const t of ['Semi Truck', 'semi-truck']) assert.deepEqual(answer(t), ['Tractor', [], 'standard', true], t);
  for (const t of ['Box Truck', 'box truck', ' Box  Truck ']) assert.deepEqual(answer(t), ['Box Truck', ['Box/Straight Truck'], 'standard', true], t);
  for (const t of ['Straight Truck', 'Box Truck Trailer', 'Flatbed', 'Passenger Van', 'Semi Trailer', 'Van Trailer', null]) {
    agents(type(t));
    assert.equal(type(t).standard, false, String(t));
  }
  assert.match(type('Flatbed').note, /"Flatbed"/);
  // Per vehicle: a flatbed (the agent's), then a cargo van.
  const two = with_({ vehicles: [{ ...intake().vehicles[0], type: 'Flatbed' }, SECOND_VEHICLE] });
  assert.equal(one(plan(two, { vehicles: 1 }), VEHICLE_TYPE).value, 'Delivery Van');
  agents(one(plan(two, { vehicles: 0 }), VEHICLE_TYPE));
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
  assert.deepEqual([value(intake(), 'Customizations (from the attached equipment value)'), value(intake(), 'Customization value (the attached equipment value, else TNI: 0)', VEH)], [false, 0]);
  const one5k = with_({ 'operations.equipVehicle': 5000 });
  assert.deepEqual([value(one5k, 'Customizations (from the attached equipment value)'), value(one5k, 'Customization value (the attached equipment value, else TNI: 0)', VEH)], [true, 5000]);
  // Two vehicles: which one carries it isn't on the intake.
  const two = with_({ 'operations.equipVehicle': 5000, vehicles: [intake().vehicles[0], SECOND_VEHICLE] });
  const s = one(plan(two), 'Customization value (the attached equipment value, else TNI: 0)', VEH);
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
  assert.equal(value(with_({ trailers: [TRAILER], 'trailerInfo.equipTrailer': 2000 }), 'Trailer customization value (the trailer equipment value, else TNI: 0)'), 2000);
  agents(one(plan(with_({ trailers: [TRAILER, TRAILER], 'trailerInfo.equipTrailer': 2000 })), 'Trailer customization value (the trailer equipment value, else TNI: 0)'));
  // No value on the intake: TNI's 0 (W43-30), with one unit or several, unless a line of the notes
  // mentions customizations or equipment: then the agent's, quoted. A customer isn't a customization.
  const VALUE = 'Customization value (the attached equipment value, else TNI: 0)';
  const TRAILER_VALUE = 'Trailer customization value (the trailer equipment value, else TNI: 0)';
  for (const r of [with_({ 'operations.equipVehicle': null }), with_({ 'operations.equipVehicle': null, vehicles: [intake().vehicles[0], SECOND_VEHICLE] }),
    with_({ 'operations.equipVehicle': null, 'notes.text': 'Customer wants a quote by Friday' })]) {
    const steps = plan(r).filter((s) => s.name === VALUE);
    assert.deepEqual(steps.map((s) => s.steps[0]), [VEH, ...r.vehicles.map(() => QC)]);
    for (const s of steps) assert.deepEqual([s.value, s.source, s.standard, s.manualOnly], [0, 'standard', true, false]);
  }
  const zero = one(plan(with_({ trailers: [TRAILER] })), TRAILER_VALUE);
  assert.deepEqual([zero.value, zero.source, zero.standard], [0, 'standard', true]);
  for (const [box, text] of [['notes.text', 'Liftgate and custom-built bed added 2024'], ['claims.notes', 'Truck has aftermarket upfit']]) {
    const mentioned = with_({ 'operations.equipVehicle': null, trailers: [TRAILER], [box]: text });
    for (const s of [one(plan(mentioned), VALUE, VEH), one(plan(mentioned), VALUE, QC), one(plan(mentioned), TRAILER_VALUE)]) {
      agents(s);
      assert.equal(s.source, 'fact', s.name);
      assert.ok(s.note.includes(text), s.note);
    }
  }
  // The intake's own value is never overridden by a mention.
  assert.equal(value(with_({ 'operations.equipVehicle': 5000, 'notes.text': 'Aftermarket upfit' }), VALUE, VEH), 5000);
  // The Yes/No follows the same notes (review of #139): none on the intake with a notes line about
  // customizations is the agent's, quoted, not the standard No.
  const YES_NO = 'Customizations (from the attached equipment value)';
  for (const text of ['Liftgate and custom-built bed added 2024', 'Ladder rack is permanently attached', 'Modifications to the truck: crane']) {
    const s = one(plan(with_({ 'operations.equipVehicle': null, 'notes.text': text })), YES_NO);
    agents(s);
    assert.equal(s.source, 'fact', text);
    assert.ok(s.note.includes(text), s.note);
  }
  // Ordinary freight wording isn't a customization: the standard No and 0 stay.
  for (const text of ['Hauls construction equipment', 'Equipment rental deliveries', 'Modified schedule in winter']) {
    const r = with_({ 'operations.equipVehicle': null, 'notes.text': text });
    const [yesNo, amount] = [one(plan(r), YES_NO), one(plan(r), VALUE, VEH)];
    assert.deepEqual([yesNo.value, yesNo.source, amount.value, amount.source], [false, 'standard', 0, 'standard'], text);
  }
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
  // A number coming within 60 days: Not yet (TNI, 2026-10-27; until then the agent's).
  assert.equal(one(plan(with_({ 'applicant.dot': null, 'applicant.mcDotWithin60Days': true })), 'Has a USDOT number').value, 'Not yet, but the customer has applied for one.');
  // An MC number only, or nothing said: the agent's.
  for (const changes of [{ 'applicant.mc': 'MC-765432' }, {}]) {
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
  // Every word of the name, never its first alone ("of" matches any record), and no unit.
  assert.deepEqual(one(plan(with_({ 'garaging.street': '100 Avenue of the Americas Suite 5' })), RECORD).labelHas, ['100', 'of', 'the', 'Americas', '68000']);
  assert.deepEqual(one(plan(with_({ 'garaging.street': '100 Old Dixie Hwy #2' })), RECORD).labelHas, ['100', 'Old', 'Dixie', '68000']);
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
  // GEICO misspelled or with a suffix is GEICO (TNI, 2026-10-26, W44-06): never "no current GEICO
  // policy" for it; another insurer with a similar name stays No.
  for (const carrier of ['GICO', 'Gieco', 'Geico Commercial', 'GEICO Ins.']) assert.equal(current(geicoRow({ carrier })), true, carrier);
  for (const carrier of ['Gainsco', 'Gateway', 'GAIC']) assert.equal(current(geicoRow({ carrier })), false, carrier);
  // An expired misspelled GEICO policy is the agent's, as GEICO's is.
  for (const carrier of ['GICO', 'Gieco']) agents(one(plan(with_(geicoRow({ carrier, expiration: '01/31/2026' }))), 'Current GEICO commercial auto policy'));
  for (const changes of [geicoRow({ expiration: '01/31/2026' }), { priorInsurance: [] },
    { priorInsurance: [{ type: 'General Liability', carrier: 'Other Mutual', limit: null, expiration: '12/31/2026' }] }]) {
    const s = one(plan(with_(changes)), 'Current GEICO commercial auto policy');
    agents(s);
    assert.equal(s.manualOnly, true);
  }
});

// TNI, 2026-10-26: answer to PR question 9 (#189, #194): a commercial auto policy with GEICO itself
// is a current GEICO policy also when the intake gives no usable expiration date (blank, or a remark
// in the date box), as W44-29 reads proof of prior insurance: any box filled and no date already
// passed. TNI's answer, so a standard; a dated one stays derived. An expired one stays the agent's.
test('an undated GEICO commercial auto policy is a current GEICO policy (TNI, 2026-10-26)', () => {
  const geicoRow = (more = {}) => ({ priorInsurance: [{ type: 'Commercial Auto', carrier: 'GEICO', limit: '$1M CSL', expiration: null, ...more }] });
  const step = (changes) => one(plan(with_(changes)), 'Current GEICO commercial auto policy');
  for (const more of [{}, { carrier: 'Gieco' }, { carrier: 'Geico Commercial' }, { limit: null }, { expiration: 'renews in spring' }]) {
    const s = step(geicoRow(more));
    assert.deepEqual([s.value, s.source, s.note], [true, 'standard', null], JSON.stringify(more));
  }
  assert.deepEqual([step(geicoRow({ expiration: '12/31/2026' })).value, step(geicoRow({ expiration: '12/31/2026' })).source], [true, 'derived'], 'a dated one: derived, as before');
  // Unchanged: expired (the agent's), a personal auto policy (No), no prior insurance (No), another
  // insurer's commercial auto policy (No), a GL policy with GEICO and one of no type (the agent's).
  agents(step(geicoRow({ expiration: '01/31/2026' })));
  assert.equal(step(geicoRow({ type: 'Personal Auto' })).value, false);
  assert.equal(step(geicoRow({ type: null, carrier: 'No GEICO', limit: null })).value, false, 'no prior insurance');
  assert.equal(step(geicoRow({ carrier: 'Gainsco' })).value, false);
  for (const type of ['General Liability', null]) agents(step(geicoRow({ type })));
  assert.equal(step(geicoRow({ carrier: 'Gainsco' })).source, 'derived');
});

// TNI, 2026-10-26: answer to PR question R9 (#189): a policy with GEICO itself whose policy type is
// left blank is the agent's (a `fact`, never filled), with a note that the type isn't on the intake,
// dated, undated or expired. A commercial auto policy with GEICO keeps its Yes; personal auto and
// another insurer's commercial auto policy keep No.
test('a GEICO policy of no type: the current GEICO policy question is the agent\'s (TNI, 2026-10-26, R9)', () => {
  const geicoRow = (more = {}) => ({ priorInsurance: [{ type: null, carrier: 'GEICO', limit: '$1M CSL', expiration: '12/31/2026', ...more }] });
  const step = (changes) => one(plan(with_(changes)), 'Current GEICO commercial auto policy');
  for (const more of [{}, { type: '' }, { type: '  ' }, { carrier: 'Gieco' }, { expiration: null }, { limit: null, expiration: 'see notes' }, { expiration: '01/31/2026' }]) {
    const s = step(geicoRow(more));
    agents(s);
    assert.deepEqual([s.source, s.manualOnly], ['fact', true], JSON.stringify(more));
    assert.match(s.note, /policy type isn't on the intake/, JSON.stringify(more));
  }
  // Counterexamples: a commercial auto policy with GEICO keeps its Yes (dated derived, undated
  // standard); personal auto keeps No; another insurer's commercial auto policy keeps No; no prior
  // insurance ("No GEICO" without a date) keeps No; another insurer's policy of no type is unchanged
  // (the agent's, derived, its own note).
  assert.deepEqual([step(geicoRow({ type: 'Commercial Auto' })).value, step(geicoRow({ type: 'Commercial Auto' })).source], [true, 'derived']);
  assert.deepEqual([step(geicoRow({ type: 'Commercial Auto', expiration: null })).value, step(geicoRow({ type: 'Commercial Auto', expiration: null })).source], [true, 'standard']);
  assert.deepEqual([step(geicoRow({ type: 'Personal Auto' })).value, step(geicoRow({ type: 'Personal Auto' })).source], [false, 'derived']);
  assert.deepEqual([step(geicoRow({ type: 'Commercial Auto', carrier: 'Gainsco' })).value, step(geicoRow({ type: 'Commercial Auto', carrier: 'Gainsco' })).source], [false, 'derived']);
  assert.equal(step(geicoRow({ carrier: 'No GEICO', limit: null, expiration: null })).value, false, 'no prior insurance');
  const other = step(geicoRow({ carrier: 'Other Mutual' }));
  agents(other);
  assert.equal(other.source, 'derived');
  assert.doesNotMatch(other.note, /policy type/);
});

// TNI, 2026-10-27 (answer to PR question V4): the owner is always the first driver on the intake's
// list. Before, this test said "never the first driver": the owner's details came from the row their
// name matched (TNI, 2026-10-20), and an owner no row matched got none. The names still never come
// from a row carrying another name (the FL generic run put the first driver in the owner boxes).
test('the owner: names from the owner box (or their row when it carries the name), details from the first driver row (V4)', () => {
  // The first driver has another name: still the owner's row, for the details; the names are the owner box's.
  const r = with_({ drivers: [CASEY, intake().drivers[0]] });
  const p = plan(r);
  assert.deepEqual(['Owner first name', 'Owner last name', 'Owner date of birth', 'Owner marital status'].map((n) => one(p, n, BOI).value), ['Amina', 'Kone', '07/09/1995', 'Single']);
  assert.deepEqual(['Owner first name', 'Owner date of birth'].map((n) => one(p, n, VEH).value), ['Amina', '07/09/1995'], 'and again with the SSN');
  // The owner doesn't drive: the names from the owner box (a lone middle initial left out); the date
  // of birth and marital status from the owner's driver row (TNI, 2026-10-26: answer to PR question,
  // T3; the first row since V4), and the agent's when no row is theirs.
  // (The row as the intake reads it: `excluded` null. This file's intake() has the agent's No.)
  const box = plan(with_({ 'applicant.owner1': 'Amina K. Kone', 'applicant.ownerDrives': false, 'drivers.0.excluded': null }));
  assert.deepEqual([one(box, 'Owner first name', BOI).value, one(box, 'Owner last name', BOI).value], ['Amina', 'Kone']);
  assert.deepEqual([one(box, 'Owner date of birth', BOI).value, one(box, 'Owner marital status', BOI).value], ['01/02/1980', 'Married']);
  // The first row under another name is still the owner's (V4); the agent's Excluded driver No on it
  // (CASEY's here) leaves no owner's row, and the details are the agent's.
  const firstRow = plan(with_({ 'applicant.owner1': 'Amina K. Kone', 'applicant.ownerDrives': false, drivers: [{ ...CASEY, excluded: null }] }));
  assert.deepEqual([one(firstRow, 'Owner date of birth', BOI).value, one(firstRow, 'Owner marital status', BOI).value], ['07/09/1995', 'Single']);
  const noRow = plan(with_({ 'applicant.owner1': 'Amina K. Kone', 'applicant.ownerDrives': false, drivers: [CASEY] }));
  for (const name of ['Owner date of birth', 'Owner marital status']) {
    agents(one(noRow, name, BOI));
    assert.equal(one(noRow, name, BOI).manualOnly, true);
  }
  assert.equal(value(with_({ 'applicant.owner1': 'Mary Ann Kone', 'applicant.ownerDrives': false }), 'Owner first name', BOI), 'Mary Ann');
  agents(one(plan(with_({ 'applicant.owner1': 'Bartholomew-Alexander Kone', 'applicant.ownerDrives': false })), 'Owner first name', BOI));
  agents(one(plan(with_({ 'drivers.0.dob': '1980' })), 'Owner date of birth', BOI));
  // No driver's name is the owner's: the first row's date of birth all the same (V4; before, never
  // another driver's: TNI, 2026-10-20). With no driver rows: the agent's.
  assert.equal(value(with_({ 'applicant.owner1': 'Jordan Sample' }), 'Owner date of birth', BOI), '01/02/1980');
  const unmatched = one(plan(with_({ 'applicant.owner1': 'Jordan Sample', drivers: [] })), 'Owner date of birth', BOI);
  agents(unmatched);
  assert.match(unmatched.note, /The intake lists no drivers, so no driver row gives the owner.s date of birth/);
  // A blank owner box: the first row's too (V4); with no driver rows, the note says there is no owner
  // name (never quotes an empty one).
  for (const name of [null, '', '  ']) {
    assert.equal(value(with_({ 'applicant.owner1': name }), 'Owner date of birth', BOI), '01/02/1980', String(name));
    const blank = one(plan(with_({ 'applicant.owner1': name, drivers: [] })), 'Owner date of birth', BOI);
    agents(blank);
    assert.match(blank.note, /no owner name/, String(name));
  }
  assert.match(one(plan(with_({ 'applicant.owner1': null, 'applicant.ownerDrives': false })), 'Owner date of birth', BOI).note, /owner doesn't drive/);
  // The business name: the company's, else the owner's (also for a company box saying there is none).
  assert.equal(value(intake(), 'Business name (company, else the owner)', BOI), 'Synthetic Expediter LLC');
  for (const name of [null, 'NO', 'N/A', 'None.']) assert.equal(value(with_({ 'applicant.name': name }), 'Business name (company, else the owner)', BOI), 'Amina Kone', String(name));
  assert.equal(value(intake(), OWNER_DRIVES), true);
});

// W44-01: an OH quote printed with one of the intake's two drivers: the "owner drives" box was
// blank, so the owner-driver question and Add Driver were left to the agent. TNI, 2026-10-26
// (W44-25): "Owner Drivers if not excluded, in every case".
test('owner drives (W44-25): blank is TNI\'s Yes and GEICO adds the other drivers; the intake\'s No, or an excluded owner, is No', () => {
  const two = (changes = {}) => with_(changes, with_({ drivers: [intake().drivers[0], CASEY] }));
  const drives = (r, step = BOI, active = {}) => one(plan(r, active), step === BOI ? OWNER_DRIVES : OWNER_DRIVES_ADD, step);
  const said = (s) => [s.value, s.source, s.standard, s.manualOnly, s.note, s.warn];
  // Blank: TNI's standard Yes, on Business & Owner Info and again on Add Driver.
  const blank = two({ 'applicant.ownerDrives': null, 'applicant.owner2': 'Casey Example' });
  assert.deepEqual(said(drives(blank)), [true, 'standard', true, false, null, null]);
  assert.deepEqual(said(drives(blank, DRV, { drivers: 1 })), [true, 'standard', true, false, null, null]);
  // ... so GEICO lists the owner (their row is never added again) and adds every other intake driver.
  assert.equal(geico.listedDriver(two({ 'applicant.ownerDrives': null })), 0);
  const adding = { vehicles: 1, drivers: 1, trailers: 0, adding: { list: 'drivers', index: 1, click: true } };
  const addDriver = (r) => buildPlan(r, geico, adding).filter((s) => s.kind === 'action' && !s.steps.includes(QC)).map((s) => s.action);
  assert.deepEqual(addDriver(two({ 'applicant.ownerDrives': null })), ['addDriver:1']);
  // The owner as the panel's driver: GEICO already lists them, so Add Driver isn't filled.
  assert.match(one(plan(two({ 'applicant.ownerDrives': null }), { drivers: 0 }), 'Driver first name').note, /already lists/);
  // The intake's own answer: Yes and No as written.
  assert.deepEqual(said(drives(two())), [true, 'intake', false, false, null, null]);
  assert.deepEqual(said(drives(two({ 'applicant.ownerDrives': false }))), [false, 'intake', false, false, null, null]);
  // Another driver marked excluded doesn't change the owner's answer.
  assert.deepEqual(said(drives(two({ 'applicant.ownerDrives': null, 'drivers.1.excluded': true }))), [true, 'standard', true, false, null, null]);
  // The owner's own driver row marked excluded: the owner isn't a driver, No (from the exclusion);
  // GEICO lists no driver itself, and its quote leaves the owner's row out (TNI, 2026-10-27: answer to
  // PR question V3; before, the fill added it, flagged as excluded): the fill adds the other drivers.
  const excluded = two({ 'applicant.ownerDrives': null, 'drivers.0.excluded': true });
  assert.deepEqual(said(drives(excluded)), [false, 'derived', false, false, null, null]);
  assert.deepEqual([geico.listedDriver(excluded), geico.omittedDriver(excluded)], [-1, 0]);
  assert.deepEqual(addDriver(excluded), ['addDriver:1']);
  assert.deepEqual([one(plan(excluded, { drivers: 0 }), 'Driver first name').warn, one(plan(excluded, { drivers: 0 }), 'Driver first name').value], [null, null]);
  assert.match(one(plan(excluded, { drivers: 0 }), 'Driver first name').note, /owner, who doesn't drive/);
  // The intake says No and marks them excluded: No, the intake's.
  assert.deepEqual(said(drives(two({ 'applicant.ownerDrives': false, 'drivers.0.excluded': true }))), [false, 'intake', false, false, null, null]);
  // The intake says Yes but marks the owner's row excluded: No, flagged for the agent to confirm.
  const both = drives(two({ 'drivers.0.excluded': true }));
  assert.deepEqual([both.value, both.source, both.note], [false, 'derived', null]);
  assert.match(both.warn, /says the owner drives.*excluded/);
  // A blank box with an owner no driver row's name matches: Yes, and the first row is the owner
  // (TNI, 2026-10-27: answer to PR question V4), so the fill adds the second. (Before V4, adding the
  // drivers stayed the agent's: the owner might be one of them spelled otherwise.)
  const unmatched = two({ 'applicant.ownerDrives': null, 'applicant.owner1': 'Jordan Sample' });
  assert.deepEqual(said(drives(unmatched)), [true, 'standard', true, false, null, null]);
  assert.deepEqual([geico.listedDriver(unmatched), addDriver(unmatched)], [0, ['addDriver:1']]);
  // In review mode (a class the standards weren't set on) the standard Yes is a check item.
  const review = drives(two({ 'applicant.ownerDrives': null, 'operations.businessClass': 'Dump Truck' }));
  assert.deepEqual([review.value, review.standard, review.reviewRequired], [true, true, true]);
});

// TNI, 2026-10-27: "Is the owner involved in the daily operations of the business?" is Yes when the
// owner drives and isn't excluded; No when they don't drive or are excluded.
test('owner daily operations: Yes when the owner drives; No otherwise', () => {
  const daily = (r) => one(plan(r), OWNER_DAILY, BOI);
  const said = (s) => [s.value, s.source, s.manualOnly, s.note];
  // Drives: the intake's Yes (derived from it), or a blank box (TNI's Yes, so TNI's standard).
  assert.deepEqual(said(daily(intake())), [true, 'derived', false, null]);
  assert.deepEqual(said(daily(with_({ 'applicant.ownerDrives': null }))), [true, 'standard', false, null]);
  // Doesn't drive, or excluded: No.
  assert.deepEqual(said(daily(with_({ 'applicant.ownerDrives': false }))), [false, 'derived', false, null]);
  assert.deepEqual(said(daily(with_({ 'applicant.ownerDrives': null, 'drivers.0.excluded': true }))), [false, 'derived', false, null]);
  // The intake says the owner drives but excludes them: No, with the warning to confirm it.
  assert.match(daily(with_({ 'applicant.ownerDrives': true, 'drivers.0.excluded': true })).warn ?? '', /marks their driver row excluded/);
  assert.equal(daily(intake()).warn ?? null, null);
});

// TNI, 2026-10-26 (answer to PR question): the owner's name matched two driver rows (a Sr and a Jr)
// and only one was marked excluded: which row was the owner, and so whether the owner drives, wasn't
// on the intake, so it was the agent's. TNI, 2026-10-27 (answer to PR question V4) replaces it: the
// owner is the first row, so its "Excluded" mark decides, and the second is an ordinary driver.
test('owner drives: the owner\'s name on two driver rows, one excluded: the first row decides (V4 replaces the agent\'s)', () => {
  // The owner box's own name (no suffix), and a Jr with the same name: both carry the owner's name.
  const senior = intake().drivers[0];
  const junior = { ...senior, suffix: 'Jr', dob: '03/04/2004', cdl: false, cdlYear: null, maritalStatus: 'Single' };
  const family = (excluded, changes = {}) => with_(changes, with_({ drivers: [{ ...senior, excluded: excluded[0] }, { ...junior, excluded: excluded[1] }] }));
  const drives = (r, step = BOI, active = {}) => one(plan(r, active), step === BOI ? OWNER_DRIVES : OWNER_DRIVES_ADD, step);
  const said = (s) => [s.value, s.source, s.standard, s.manualOnly, s.note];
  const adding = { vehicles: 1, drivers: 1, trailers: 0, adding: { list: 'drivers', index: 1, click: true } };
  const addDriver = (r) => buildPlan(r, geico, adding).filter((s) => s.kind === 'action' && !s.steps.includes(QC)).map((s) => s.action);
  for (const box of [null, true]) {
    const why = String(box);
    // The first row marked: the owner doesn't drive, No; GEICO's quote leaves that row out (V3) and
    // adds the Jr.
    const first = family([true, false], { 'applicant.ownerDrives': box });
    assert.deepEqual(said(drives(first)).slice(0, 2), [false, 'derived'], why);
    assert.deepEqual([geico.listedDriver(first), geico.omittedDriver(first), addDriver(first)], [-1, 0, ['addDriver:1']], why);
    // The Jr marked: the owner drives (the box's answer), GEICO lists them, and the Jr is added with the
    // excluded-driver warning, as any excluded driver.
    const second = family([false, true], { 'applicant.ownerDrives': box });
    assert.deepEqual(said(drives(second)), [true, box ? 'intake' : 'standard', !box, false, null], why);
    assert.deepEqual([geico.listedDriver(second), geico.omittedDriver(second), addDriver(second)], [0, -1, ['addDriver:1']], why);
    assert.match(one(plan(second, { drivers: 1 }), 'Driver first name', DRV).warn, /^The intake marks this driver to be excluded/, why);
  }
  // The intake's No stands: the owner isn't a driver, and the fill adds the other driver.
  const no = family([true, false], { 'applicant.ownerDrives': false });
  assert.deepEqual(said(drives(no)), [false, 'intake', false, false, null]);
  assert.deepEqual(addDriver(no), ['addDriver:1']);
  // Counterexamples: none excluded keeps the standard Yes (GEICO lists the first row and adds the
  // other); both excluded keeps No (the first left out, the second added).
  const none = family([false, false], { 'applicant.ownerDrives': null });
  assert.deepEqual(said(drives(none)), [true, 'standard', true, false, null]);
  assert.deepEqual([geico.listedDriver(none), addDriver(none)], [0, ['addDriver:1']]);
  const all = family([true, true], { 'applicant.ownerDrives': null });
  assert.deepEqual(said(drives(all)), [false, 'derived', false, false, null]);
  assert.deepEqual([geico.listedDriver(all), geico.omittedDriver(all), addDriver(all)], [-1, 0, ['addDriver:1']]);
});

// TNI, 2026-10-26 (answer to PR question, R1): "owner drives" says only whether the owner drives; if
// the owner's row is marked Excluded, or the answer is No, the owner is excluded. GEICO asks nothing
// about exclusion, and doesn't list the owner as a driver. Since T1 (TNI, 2026-10-26: answer to PR
// question) the owner's row isn't on GEICO's quote at all: no Add Driver form is filled for it (the
// test below); before, it carried the excluded-driver warning.
test('owner drives No: the owner\'s driver row is left off GEICO\'s quote (T1), never listed by GEICO; other drivers unchanged', () => {
  const two = (changes = {}) => with_(changes, with_({ drivers: [{ ...intake().drivers[0], excluded: null }, { ...CASEY, excluded: null }] }));
  const firstName = (r, drivers) => one(plan(r, { drivers }), 'Driver first name', DRV);
  const no = two({ 'applicant.ownerDrives': false });
  // GEICO isn't told the owner drives, on Business & Owner Info or on another driver's Add Driver form.
  for (const s of [one(plan(no), OWNER_DRIVES, BOI), one(plan(no, { drivers: 1 }), OWNER_DRIVES_ADD, DRV)]) assert.deepEqual([s.value, s.source, s.note, s.warn], [false, 'intake', null, null]);
  assert.equal(geico.listedDriver(no), -1);
  // The owner's row: no Add Driver form is filled for it (T1), so no exclusion warning either.
  assert.deepEqual([firstName(no, 0).value, firstName(no, 0).warn], [null, null]);
  assert.match(firstName(no, 0).note, /owner, who doesn't drive/, 'not the "GEICO already lists" note: GEICO doesn\'t list the owner');
  assert.equal(firstName(no, 1).warn, null);
  assert.equal(no.drivers[0].excluded, null, 'the record keeps the row as read');
  // Counterexamples: a blank box or the intake's Yes, the owner's row unmarked: GEICO lists the owner,
  // and no form carries the warning.
  for (const box of [null, true]) {
    const r = two({ 'applicant.ownerDrives': box });
    assert.equal(geico.listedDriver(r), 0, String(box));
    assert.deepEqual([firstName(r, 0).warn, firstName(r, 1).warn], [null, null], String(box));
  }
  // The agent's No for the owner's row in client details stands: no warning.
  assert.equal(firstName(two({ 'applicant.ownerDrives': false, 'drivers.0.excluded': false }), 0).warn, null);
  // A row the intake marks excluded keeps its own warning.
  assert.match(firstName(two({ 'applicant.ownerDrives': false, 'drivers.1.excluded': true }), 1).warn, /^The intake marks this driver to be excluded/);
  // The owner's name on two rows (a Sr and a Jr), one marked excluded: with the intake's No the No
  // decides, so there is no mixed case. Both owner-driver questions are the intake's No without the
  // mixed-rows note. Since T2 only the row with exactly the owner's full name (here the first) is the
  // owner's, left off the quote (T1); the Jr is excluded only by their own mark, the other driver never.
  for (const [marked, warned] of [[0, [false, false, false]], [1, [false, true, false]]]) {
    const senior = { ...intake().drivers[0], excluded: null };
    const family = with_({ 'applicant.ownerDrives': false, drivers: [senior, { ...senior, suffix: 'Jr', dob: '03/04/2004' }, { ...CASEY, excluded: null }] });
    family.drivers[marked].excluded = true;
    for (const s of [one(plan(family), OWNER_DRIVES, BOI), one(plan(family, { drivers: 1 }), OWNER_DRIVES_ADD, DRV)]) {
      assert.deepEqual([s.value, s.source, s.manualOnly, s.note], [false, 'intake', false, null], `row ${marked} marked`);
    }
    assert.deepEqual([geico.listedDriver(family), geico.omittedDriver(family)], [-1, 0]);
    assert.deepEqual([0, 1, 2].map((i) => /excluded/.test(firstName(family, i).warn ?? '')), warned, `row ${marked} marked`);
  }
});

// TNI, 2026-10-26 (answers to PR questions, T1, T3), the intake's "owner drives" No:
// - T1: GEICO's quote leaves the owner's row out. The fill doesn't add it, nor fills an Add Driver
//   form for it; only the other intake drivers are added. (R1 had it added, as an excluded driver
//   GEICO asks nothing about.)
// - T3: the owner's date of birth, marital status, license state and CDL come from that row.
// The owner's row is the first (TNI, 2026-10-27: answer to PR question V4, which replaces T2's row by
// the owner's exact full name, and the agent's with none: the test after this one).
test('owner drives No (T1, T3): GEICO leaves the owner\'s row, the first, out and adds the others; the owner\'s details from that row', () => {
  const owner = { ...intake().drivers[0], excluded: null };
  const casey = { ...CASEY, excluded: null };
  const no = (drivers, changes = {}) => with_({ 'applicant.ownerDrives': false, drivers, ...changes });
  const added = (r, index) => buildPlan(r, geico, { vehicles: 0, drivers: index, trailers: 0, adding: { list: 'drivers', index, click: true } })
    .filter((s) => s.kind === 'action' && !s.steps.includes(QC)).map((s) => s.action);
  const form = (r, drivers, name = 'Driver first name') => one(plan(r, { drivers }), name, DRV);
  const ADD_DRIVER = ['Driver first name', 'Driver last name', 'Driver date of birth', 'Driver license state', 'Driver has a CDL (TNI: No when the intake leaves it blank)',
    'Driver\'s relationship to the business (Owner, else Employee)', OWNER_DRIVES_ADD];
  const DETAILS = ['Owner date of birth', 'Owner marital status', 'Owner\'s license state', 'Owner has a CDL (TNI: No when the intake leaves it blank)'];
  const details = (r) => DETAILS.map((name) => one(plan(r), name, name.startsWith('Owner\'s') || name.startsWith('Owner has') ? DRV : BOI));

  // T1: the owner's row is never added, and no Add Driver form is filled for it; the other driver is.
  const r = no([owner, casey]);
  assert.deepEqual([geico.omittedDriver(r), geico.listedDriver(r)], [0, -1]);
  assert.deepEqual(added(r, 1), ['addDriver:1']);
  assert.deepEqual(added(r, 0), [], 'never the owner\'s "+"');
  for (const name of ADD_DRIVER) {
    agents(form(r, 0, name));
    assert.match(form(r, 0, name).note, /owner, who doesn't drive.*GEICO's quote leaves them out.*pick the driver this form is for/, name);
  }
  assert.equal(form(r, 0).warn, null, 'no exclusion warning: the row isn\'t added');
  assert.deepEqual([form(r, 1).value, form(r, 1).note, form(r, 1).warn], ['Casey', null, null]);
  // Both owner-driver questions stay the intake's No.
  assert.deepEqual([one(plan(r), OWNER_DRIVES, BOI).value, form(r, 1, OWNER_DRIVES_ADD).value], [false, false]);
  // The owner's name on the second row: the first row is the owner's all the same (V4; before, the
  // second was, by name); the owner's row the intake also marks excluded: left out the same way.
  assert.deepEqual([geico.omittedDriver(no([casey, owner])), added(no([casey, owner]), 0), added(no([casey, owner]), 1)], [0, [], ['addDriver:1']]);
  const marked = no([{ ...owner, excluded: true }, casey]);
  assert.deepEqual([geico.omittedDriver(marked), added(marked, 0), form(marked, 0).warn], [0, [], null]);
  // Counterexamples. A blank box or the intake's Yes: GEICO lists the owner itself (W44-25), and the
  // other driver is added.
  for (const box of [null, true]) {
    const yes = no([owner, casey], { 'applicant.ownerDrives': box });
    assert.deepEqual([geico.omittedDriver(yes), geico.listedDriver(yes), added(yes, 1)], [-1, 0, ['addDriver:1']], String(box));
  }
  // The owner's row marked excluded with the box blank: left out too since V3 (TNI, 2026-10-27; before,
  // added with the 2026-10-20 warning): the test of V3 below.
  const blankMarked = no([{ ...owner, excluded: true }, casey], { 'applicant.ownerDrives': null });
  assert.deepEqual([geico.omittedDriver(blankMarked), added(blankMarked, 0)], [0, []]);
  // The agent's No for the owner's row in client details: added as any.
  const corrected = no([{ ...owner, excluded: false }, casey]);
  assert.deepEqual([geico.omittedDriver(corrected), added(corrected, 0), form(corrected, 0).value], [-1, ['addDriver:0'], 'Amina']);
  // An owner no driver row's name matches: the first row is still the owner's (V4; before, every
  // intake driver was added).
  const unmatched = no([owner, casey], { 'applicant.owner1': 'Jordan Sample' });
  assert.deepEqual([geico.omittedDriver(unmatched), added(unmatched, 0), added(unmatched, 1)], [0, [], ['addDriver:1']]);

  // T3: the owner's details from their row, with the source the row's value has (not TNI's standard).
  assert.deepEqual(details(r).map((s) => [s.value, s.source, s.note]), [['01/02/1980', 'derived', null], ['Married', 'derived', null], ['NE', 'derived', null], [true, 'derived', null]]);
  // The owner's names stay the owner box's.
  assert.deepEqual([one(plan(no([owner], { 'applicant.owner1': 'Amina K. Kone' })), 'Owner first name', BOI).value, details(no([owner], { 'applicant.owner1': 'Amina K. Kone' }))[0].value], ['Amina', '01/02/1980']);
  // The first row under another name: its details (V4; before, the agent's).
  assert.deepEqual(details(unmatched).map((s) => s.value), ['01/02/1980', 'Married', 'NE', true]);
  // No driver rows, or the agent's No for the owner's row: the agent's, with the reason.
  for (const s of [...details(no([])), ...details(corrected)]) {
    agents(s);
    assert.match(s.note, /owner doesn't drive/, s.name);
  }
});

// TNI, 2026-10-27 (answer to PR question V4): "The owner is always the first driver on the intake's
// driver list", Sr or Jr regardless. The owner's details, the "Excluded" mark and the relationship
// Owner come from the first row; the rows after it are ordinary drivers and employees, even with the
// owner's name, and a first row with another name is still the owner (the Intake step warns:
// normalize.test.mjs). It replaces T2's exact-full-name match. V5 (confirmed): the owner's row with a
// blank CDL box gets TNI's CDL standard No, as every driver.
test('the owner is the first driver (V4): details, "Excluded" and relationship from row 1; later rows ordinary, even with the owner\'s name', () => {
  const owner = { ...intake().drivers[0], excluded: null };
  const casey = { ...CASEY, excluded: null };
  const riley = { ...CASEY, first: 'Riley', last: 'Sample', dob: '11/12/1985', licenseState: 'KS', maritalStatus: 'Divorced', excluded: null };
  const senior = { ...owner, suffix: 'Sr' };
  const junior = { ...owner, suffix: 'Jr', dob: '03/04/2004', maritalStatus: 'Single', licenseState: 'IA', cdl: false, cdlYear: null };
  const twin = { ...owner, dob: '05/06/1990', maritalStatus: 'Single', licenseState: 'IA', cdl: false, cdlYear: null };
  const rec = (drivers, changes = {}) => with_({ drivers, 'applicant.ownerDrives': null, ...changes });
  const added = (r, index) => buildPlan(r, geico, { vehicles: 0, drivers: index, trailers: 0, adding: { list: 'drivers', index, click: true } })
    .filter((s) => s.kind === 'action' && !s.steps.includes(QC)).map((s) => s.action);
  const RELATION = 'Driver\'s relationship to the business (Owner, else Employee)';
  const relation = (r, i) => one(plan(r, { drivers: i }), RELATION, DRV);
  const employees = (r) => value(r, 'Number of employees (the drivers besides the owner)', ABI);
  const DETAILS = ['Owner date of birth', 'Owner marital status', 'Owner\'s license state', 'Owner has a CDL (TNI: No when the intake leaves it blank)'];
  const details = (r) => DETAILS.map((name) => one(plan(r), name, name.startsWith('Owner\'s') || name.startsWith('Owner has') ? DRV : BOI).value);
  const names = (r) => ['Owner first name', 'Owner last name'].map((n) => value(r, n, BOI));
  // Each case: the drivers, whose details are the owner's, and the second row an ordinary driver.
  const cases = [
    ['Sr first, Jr second', [senior, junior], ['01/02/1980', 'Married', 'NE', true]],
    ['Jr first, Sr second', [junior, senior], ['03/04/2004', 'Single', 'IA', false]],
    ['a first row with another name', [riley, casey], ['11/12/1985', 'Divorced', 'KS', false]],
    ['the owner\'s name on row 2 only', [casey, owner], ['07/09/1995', 'Single', 'IA', false]],
    ['two rows with the owner\'s exact name', [owner, twin], ['01/02/1980', 'Married', 'NE', true]],
  ];
  for (const [why, drivers, ownerDetails] of cases) {
    // A blank box (TNI's Yes) and the intake's Yes: GEICO lists the first row as the owner and adds the second.
    for (const box of [null, true]) {
      const r = rec(drivers, { 'applicant.ownerDrives': box });
      assert.deepEqual([geico.listedDriver(r), geico.omittedDriver(r), added(r, 1)], [0, -1, ['addDriver:1']], `${why}, box ${box}`);
      assert.deepEqual([relation(r, 1).value, relation(r, 1).source], ['Employee', 'standard'], `${why}: the second row is an employee`);
      assert.equal(employees(r), '1', `${why}: the owner isn't counted, the second row is`);
      assert.deepEqual(details(r), ownerDetails, why);
      assert.deepEqual([one(plan(r), OWNER_DRIVES, BOI).value, one(plan(r), OWNER_DRIVES, BOI).note], [true, null], why);
    }
    // The intake's No: the first row is the owner's, left off GEICO's quote (T1); the second is added,
    // and the owner's details still come from the first.
    const no = rec(drivers, { 'applicant.ownerDrives': false });
    assert.deepEqual([geico.listedDriver(no), geico.omittedDriver(no), added(no, 0), added(no, 1)], [-1, 0, [], ['addDriver:1']], `${why}, box No`);
    assert.deepEqual([one(plan(no, { drivers: 1 }), 'Driver first name', DRV).note, one(plan(no, { drivers: 1 }), 'Driver first name', DRV).warn], [null, null], why);
    assert.deepEqual(details(no), ownerDetails, `${why}, box No`);
    assert.equal(employees(no), '1', `${why}, box No`);
  }
  // The owner's names stay the owner box's when the first row carries another name.
  assert.deepEqual(names(rec([riley, casey])), ['Amina', 'Kone']);
  assert.deepEqual(names(rec([casey, owner])), ['Amina', 'Kone']);
  // The "Excluded" mark is the first row's: a later row with the owner's name, marked or not, is an
  // ordinary driver (no longer the agent's: V4 replaces the 2026-10-26 answer for several rows).
  const markedJr = rec([senior, { ...junior, excluded: true }]);
  assert.deepEqual([one(plan(markedJr), OWNER_DRIVES, BOI).value, one(plan(markedJr), OWNER_DRIVES, BOI).source, one(plan(markedJr), OWNER_DRIVES, BOI).note], [true, 'standard', null]);
  assert.deepEqual([geico.listedDriver(markedJr), added(markedJr, 1)], [0, ['addDriver:1']]);
  assert.match(one(plan(markedJr, { drivers: 1 }), 'Driver first name', DRV).warn, /^The intake marks this driver to be excluded/);
  const markedSr = rec([{ ...senior, excluded: true }, junior]);
  assert.deepEqual([one(plan(markedSr), OWNER_DRIVES, BOI).value, one(plan(markedSr), OWNER_DRIVES, BOI).source], [false, 'derived']);
  // A second owner (the owner box's second name) on a later row is still their Owner (unchanged).
  assert.equal(relation(rec([owner, casey], { 'applicant.owner2': 'Casey Example' }), 1).value, 'Owner');
  // V5 (confirmed): the owner's row with a blank CDL box: TNI's CDL standard No, as every driver.
  for (const box of [null, false]) {
    const blankCdl = rec([{ ...owner, cdl: null, cdlYear: null }, casey], { 'applicant.ownerDrives': box });
    const cdl = one(plan(blankCdl), DETAILS[3], DRV);
    assert.deepEqual([cdl.value, cdl.source, cdl.note], [false, 'standard', null], `box ${box}`);
  }
});

// TNI, 2026-10-27 (answer to PR question V3): the owner's row (the first) marked "Excluded" with the
// "owner drives" box blank or Yes: GEICO leaves the row out, as T1 does for the box's No (R1: Excluded
// means the owner doesn't drive). Progressive and AmWINS keep it as an excluded driver
// (progressive.test.mjs). Before, GEICO added it with the excluded-driver warning (2026-10-20 rule).
test('the owner\'s row marked Excluded over a blank box or Yes (V3): GEICO leaves it out and adds the others', () => {
  const owner = { ...intake().drivers[0], excluded: true };
  const casey = { ...CASEY, excluded: null };
  const added = (r, index) => buildPlan(r, geico, { vehicles: 0, drivers: index, trailers: 0, adding: { list: 'drivers', index, click: true } })
    .filter((s) => s.kind === 'action' && !s.steps.includes(QC)).map((s) => s.action);
  const form = (r, drivers) => one(plan(r, { drivers }), 'Driver first name', DRV);
  for (const box of [null, true]) {
    const r = with_({ drivers: [owner, casey], 'applicant.ownerDrives': box });
    assert.deepEqual([geico.omittedDriver(r), geico.listedDriver(r), added(r, 0), added(r, 1)], [0, -1, [], ['addDriver:1']], String(box));
    assert.equal(form(r, 0).value, null, 'no Add Driver form is filled for the owner');
    assert.match(form(r, 0).note, /owner, who doesn't drive.*GEICO's quote leaves them out/);
    assert.equal(form(r, 0).warn, null, 'no exclusion warning: the row isn\'t added');
    assert.deepEqual([form(r, 1).value, form(r, 1).warn], ['Casey', null]);
    assert.deepEqual([one(plan(r), OWNER_DRIVES, BOI).value, one(plan(r), OWNER_DRIVES, BOI).source], [false, 'derived']);
  }
  // The intake's Yes still asks the agent to confirm the No.
  assert.match(one(plan(with_({ drivers: [owner, casey], 'applicant.ownerDrives': true })), OWNER_DRIVES, BOI).warn, /says the owner drives.*excluded/);
  // Counterexamples: another driver marked Excluded is added with the warning; the owner's row
  // unmarked is listed by GEICO.
  const other = with_({ drivers: [{ ...owner, excluded: null }, { ...casey, excluded: true }], 'applicant.ownerDrives': null });
  assert.deepEqual([geico.omittedDriver(other), geico.listedDriver(other), added(other, 1)], [-1, 0, ['addDriver:1']]);
  assert.match(form(other, 1).warn, /^The intake marks this driver to be excluded/);
});

// TNI, 2026-10-27 (answer to PR question V1): on GEICO, the owner the intake's only driver and not
// driving (the box's No, or V3's Excluded): no driver is added (T1, V3), and a "needs you" item on
// Drivers & Incidents says so and holds Continue: which driver GEICO's quote has is the agent's.
test('the owner the intake\'s only driver, who doesn\'t drive (V1): GEICO adds no driver, and a needs-you item holds Continue', () => {
  const owner = { ...intake().drivers[0], excluded: null };
  const steps = (r) => buildPlan(r, geico, { vehicles: 0, drivers: 0, trailers: 0, adding: { list: 'drivers', index: 0, click: true } }).filter((s) => s.kind === 'action');
  const item = (r) => steps(r).find((s) => s.action === 'noOtherDriver');
  for (const [why, r] of [['box No', with_({ drivers: [owner], 'applicant.ownerDrives': false })],
    ['row marked Excluded, box blank', with_({ drivers: [{ ...owner, excluded: true }], 'applicant.ownerDrives': null })],
    ['row marked Excluded, box Yes', with_({ drivers: [{ ...owner, excluded: true }], 'applicant.ownerDrives': true })]]) {
    assert.equal(geico.omittedDriver(r), 0, why);
    assert.ok(!steps(r).some((s) => /^addDriver/.test(s.action)), `${why}: no driver added`);
    const s = item(r);
    assert.ok(s, `${why}: the item`);
    assert.deepEqual([s.text, s.token, s.steps, s.markable], [null, null, [DRV], false], `${why}: never clicked, on Drivers & Incidents`);
    assert.match(s.missing, /no driver besides the owner, who doesn't drive.*GEICO's quote.*yours/, why);
  }
  // Counterexamples: another driver to add; the owner who drives; the agent's Excluded driver No on
  // the owner's row; no driver rows at all (the Intake step's own item).
  for (const [why, r] of [['another driver', with_({ drivers: [owner, CASEY], 'applicant.ownerDrives': false })],
    ['the owner drives', with_({ drivers: [owner], 'applicant.ownerDrives': null })],
    ['the agent\'s No', with_({ drivers: [{ ...owner, excluded: false }], 'applicant.ownerDrives': false })],
    ['no drivers', with_({ drivers: [], 'applicant.ownerDrives': false })]]) {
    assert.equal(item(r), undefined, why);
  }
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
  // W43-36 (TNI, 2026-10-21): GA's unit was "Apt A", a letter: both boxes were left to the agent, who
  // typed A, picked Apartment and took the unit off the street. A letter after the kind is its number.
  assert.deepEqual(unit('Apt A').map((s) => s.value), ['A', 'Apartment']);
  for (const [u, want] of [['Apt. B', ['B', 'Apartment']], ['Apartment C', ['C', 'Apartment']], ['Unit 4B', ['4B', 'Unit']], ['Ste. 200', ['200', 'Suite']], ['Suite #3', ['3', 'Suite']], ['Apt5', ['5', 'Apartment']]]) {
    assert.deepEqual(unit(u).map((s) => s.value), want, u);
  }
  const [letterNumber, letterType] = unit('#A');
  assert.equal(letterNumber.value, 'A');
  agents(letterType);
  // A kind GEICO's Unit Type doesn't list: its number filled, the type the agent's, named.
  const [hangarNumber, hangarType] = unit('Hngr 3');
  assert.equal(hangarNumber.value, '3');
  agents(hangarType);
  assert.match(hangarType.note, /GEICO's Unit Type has no "Hngr"/);
  // A kind without a number is no number: "Suite" alone stays the agent's.
  for (const s of unit('Suite')) agents(s);
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
  // W43-36: a street still ending in its unit (one the intake's address split didn't take off) gives
  // it to the unit boxes, and is typed, and left when GEICO suggests nothing, without it: GEICO's
  // suggestion still matches. The intake's own unit wins; a street name that only reads like a unit
  // stays the street's.
  const split = (s, u = null) => {
    const q = plan(with_({ 'garaging.street': s, 'garaging.unit': u }));
    const [st, number, kind] = [street.name, 'Business unit number', 'Business unit type'].map((name) => one(q, name, BOI));
    return [st.value, st.fallback, number.value, kind.value];
  };
  const typed = '1 Test Way, Testville, NE 68000';
  assert.deepEqual(split('1 Test Way Apt A'), [typed, '1 Test Way', 'A', 'Apartment']);
  assert.deepEqual(split('1 Test Way, Suite 200'), [typed, '1 Test Way', '200', 'Suite']);
  assert.deepEqual(split('1 Test Way Ste. B'), [typed, '1 Test Way', 'B', 'Suite']);
  assert.deepEqual(split('1 Test Way Apartment 12'), [typed, '1 Test Way', '12', 'Apartment']);
  assert.deepEqual(split('1 Test Way Unit 4B'), [typed, '1 Test Way', '4B', 'Unit']);
  assert.deepEqual(split('1 Test Way #12').slice(0, 3), [typed, '1 Test Way', '12']);
  assert.deepEqual(split('1 Test Way', 'Unit 4'), [typed, '1 Test Way', '4', 'Unit']);
  assert.deepEqual(split('1 Test Way Apt A', 'Suite 9'), ['1 Test Way Apt A, Testville, NE 68000', '1 Test Way Apt A', '9', 'Suite']);
  for (const s of ['1 Unit Rd', '100 Avenue A', '1 Test Way Apt', '12 Suite Ln']) assert.deepEqual(split(s), [`${s}, Testville, NE 68000`, s, null, null], s);
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
  const TEAM = 'Team driving or slip seating (TNI: No unless the intake says otherwise)';
  const PLACARD = 'Hazardous material placard (TNI: No unless the intake says otherwise)';
  const p = plan(intake());
  assert.deepEqual([one(p, TEAM).value, one(p, PLACARD).value], [false, false]);
  assert.deepEqual([one(p, TEAM).source, one(p, PLACARD).source], ['intake', 'intake']);
  assert.equal(value(with_({ 'operations.teamDriving': true }), TEAM), true);
  assert.equal(value(with_({ 'operations.hazPlacard': true }), PLACARD), true);
  // Blank: TNI's No (W43-34)…
  const silent = plan(with_({ 'operations.teamDriving': null, 'operations.hazPlacard': null }));
  for (const name of [TEAM, PLACARD]) assert.deepEqual([one(silent, name).value, one(silent, name).source, one(silent, name).standard], [false, 'standard', true], name);
  // …unless the intake points the other way: then the agent's, what it says quoted.
  const team = one(plan(with_({ 'operations.teamDriving': null, 'notes.text': 'Husband and wife team on the 2021' })), TEAM);
  agents(team);
  assert.equal(team.source, 'fact');
  assert.match(team.note, /"Husband and wife team on the 2021"/);
  assert.equal(value(with_({ 'operations.teamDriving': null, 'notes.text': 'Teamsters member; no co-signer' }), TEAM), false, 'no team or co-driver named');
  for (const [changes, says] of [[{ 'operations.hazmat': true }, /hazardous material/], [{ 'operations.whatHaul': 'Propane tanks' }, /"Propane tanks"/],
    [{ 'claims.notes': 'Occasional fuel loads' }, /"Occasional fuel loads"/]]) {
    const placard = one(plan(with_({ 'operations.hazPlacard': null, ...changes })), PLACARD);
    agents(placard);
    assert.equal(placard.source, 'fact');
    assert.match(placard.note, says);
  }
  for (const whatHaul of ['Non-hazardous freight', 'No hazmat, dry goods']) assert.equal(value(with_({ 'operations.hazPlacard': null, 'operations.whatHaul': whatHaul }), PLACARD), false, whatHaul);
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
  const FILINGS = 'Filings required (TNI: No unless the intake says otherwise)';
  assert.equal(value(intake(), FILINGS), true);
  assert.equal(value(with_({ 'operations.filingsRequired': false, 'operations.filingsWhich': null }), FILINGS), false);
  agents(one(plan(with_({ 'operations.filingsWhich': 'SR-22' })), FILINGS));
  // Blank: TNI's No (W43-34), unless the intake names filings or its notes mention one. An SR-22 or
  // FR-44 isn't one: GEICO's question excludes them (review of #139).
  for (const changes of [{}, { 'operations.needSr22': true }, { 'operations.filingsWhich': 'SR-22' }, { 'operations.filingsWhich': 'SR-22 / FR-44' },
    { 'notes.text': 'Owner needs an SR-22 filing' }, { 'claims.notes': 'FR-44 on file' }]) {
    const silent = one(plan(with_({ 'operations.filingsRequired': null, 'operations.filingsWhich': null, ...changes })), FILINGS);
    assert.deepEqual([silent.value, silent.source, silent.standard], [false, 'standard', true], JSON.stringify(changes));
  }
  for (const [changes, says] of [[{ 'operations.filingsWhich': 'BMC-91' }, /names filings \("BMC-91"\)/], [{ 'notes.text': 'SR-22 and BMC-91 filings' }, /"SR-22 and BMC-91 filings"/],
    [{ 'notes.text': 'Needs MCS-90 for the broker' }, /"Needs MCS-90 for the broker"/], [{ 'claims.notes': 'State filing pending' }, /"State filing pending"/]]) {
    const s = one(plan(with_({ 'operations.filingsRequired': null, 'operations.filingsWhich': null, ...changes })), FILINGS);
    agents(s);
    assert.equal(s.source, 'fact');
    assert.match(s.note, says);
  }
});

// The texts AmWINS' "Is a Federal Filing Required?" answers No since T9 (TNI, 2026-10-26: an SR-22
// beside a Form E or H, "State filing" or "Intrastate" alone, an SR-22 beside an MC number, "SR-22
// and filings"): GEICO asks about proof of insurance or filings to a state or federal agency, so they
// stay as before T9. In the which-filings box each is the agent's. So do V12's (TNI, 2026-10-27: a
// Form E or H, a lone "State", a state filing beside an MC number, "Filings and SR-22").
test('filings required: AmWINS\' T9 texts stay the agent\'s in GEICO\'s which-filings box (state or federal)', () => {
  const FILINGS = 'Filings required (TNI: No unless the intake says otherwise)';
  // V12's texts too (TNI, 2026-10-27: GEICO unchanged).
  for (const which of ['SR-22 and Form E', 'State filing', 'Intrastate', 'SR-22, MC 123456', 'SR-22 and filings',
    'Form E', 'State', 'State filing, MC 123456', 'Filings and SR-22', 'SR-22 and additional filings', 'Filings and FR-44']) {
    const s = one(plan(with_({ 'operations.filingsRequired': null, 'operations.filingsWhich': which })), FILINGS);
    agents(s);
    assert.match(s.note, new RegExp(`names filings \\("${which}"\\)`));
  }
  // A notes line naming a Form E or H, a state filing or a bare "filings" beside an SR-22: also the agent's.
  for (const notes of ['SR-22 and Form E', 'Needs a state filing', 'SR-22 and filings',
    'Needs a Form H filing', 'State filing, MC 123456', 'Filings and SR-22', 'SR-22 and additional filings']) {
    const s = one(plan(with_({ 'operations.filingsRequired': null, 'operations.filingsWhich': null, 'notes.text': notes })), FILINGS);
    agents(s);
    assert.match(s.note, new RegExp(`"${notes}"`));
  }
});

// --- Drivers ------------------------------------------------------------------------------------

test('drivers: the owner\'s form from the owner\'s row; Add Driver for the panel\'s driver', () => {
  const r = with_({ drivers: [intake().drivers[0], CASEY] });
  const p = plan(r, { drivers: 1 });
  // The form GEICO adds for an owner who drives: the owner's answers, whoever the panel shows.
  assert.deepEqual([one(p, 'Owner\'s license state').value, one(p, 'Owner has a CDL (TNI: No when the intake leaves it blank)').value], ['NE', true]);
  // Add Driver: the panel's driver.
  assert.deepEqual(['Driver first name', 'Driver last name', 'Driver date of birth', 'Driver license state', 'Driver has a CDL (TNI: No when the intake leaves it blank)'].map((n) => one(p, n).value), ['Casey', 'Example', '07/09/1995', 'IA', false]);
  assert.equal(one(p, 'Driver suffix').optional, true);
  // Anyone but an owner: TNI's standard Employee.
  const rel = one(p, 'Driver\'s relationship to the business (Owner, else Employee)');
  assert.deepEqual([rel.value, rel.source, rel.standard, rel.manualOnly], ['Employee', 'standard', true, false]);
  // The owner as the panel's driver while GEICO already lists them: Add Driver isn't filled.
  const owner = plan(r, { drivers: 0 });
  for (const name of ['Driver first name', 'Driver last name', 'Driver date of birth', 'Driver license state', 'Driver has a CDL (TNI: No when the intake leaves it blank)', 'Driver\'s relationship to the business (Owner, else Employee)']) {
    agents(one(owner, name));
    assert.match(one(owner, name).note, /already lists/);
  }
  // The intake says the owner doesn't drive: GEICO's quote leaves the owner's row out, so Add Driver
  // isn't filled for them either (TNI, 2026-10-26: answer to PR question, T1). A blank box is TNI's
  // Yes (W44-25): GEICO lists them, as above.
  const unsaid = plan(with_({ 'applicant.ownerDrives': false, 'drivers.0.excluded': null }, r), { drivers: 0 });
  agents(one(unsaid, 'Driver first name'));
  assert.match(one(unsaid, 'Driver\'s relationship to the business (Owner, else Employee)').note, /owner, who doesn't drive/);
  assert.match(one(plan(with_({ 'applicant.ownerDrives': null }, r), { drivers: 0 }), 'Driver first name').note, /already lists/);
  const second = plan(with_({ 'applicant.owner2': 'Casey Example' }, r), { drivers: 1 });
  assert.equal(one(second, 'Driver\'s relationship to the business (Owner, else Employee)').value, 'Owner', 'the second owner');
  // GEICO lists the owner who drives itself: an Add Driver form is never theirs (sidepanel pickUnitForm).
  const two = () => with_({ drivers: [intake().drivers[0], CASEY] });
  // The owner's row is the first, whatever its name (TNI, 2026-10-27: answer to PR question V4;
  // before, the row the owner's name matched, and none for an owner no row matched).
  assert.deepEqual([geico.listedDriver(two()), geico.listedDriver(with_({ 'applicant.ownerDrives': false }, two())), geico.listedDriver(with_({ 'applicant.owner1': 'Jordan Sample' }, two()))], [0, -1, 0]);
  assert.equal(geico.listedDriver(with_({ drivers: [CASEY, intake().drivers[0]] })), 0);
  // An excluded driver: filled, flagged.
  assert.match(one(plan(with_({ 'drivers.1.excluded': true }, r), { drivers: 1 }), 'Driver first name').warn, /excluded/);
  assert.equal(one(p, 'Driver first name').warn, null);
  // Add Driver for a driver who is the owner asks again whether the owner drives, and the owner's
  // mobile phone (PA live run, 2026-10-21, W43-29): the intake's answer and its phone.
  const ownerForm = plan(with_({ 'applicant.ownerDrives': false, 'applicant.owner2': 'Casey Example' }, two()), { drivers: 1 });
  const drives = one(ownerForm, OWNER_DRIVES_ADD);
  assert.deepEqual([drives.value, drives.field, drives.ask, drives.steps], [false, 'GiveOwnerActiveDriverStatusYesNo', ['Is the owner a driver on the policy?'], [DRV]]);
  const mobile = one(ownerForm, 'Owner\'s mobile phone (the intake\'s phone)');
  assert.deepEqual([mobile.value, mobile.field, mobile.steps], ['(555) 010-0100', 'GiveMobilePhoneNumber', [DRV]]);
  // A phone that isn't 10 digits: the agent's. (A blank owner-drives box is TNI's Yes: W44-25, above.)
  agents(one(plan(with_({ 'applicant.phone': '555-0100' }, two()), { drivers: 1 }), 'Owner\'s mobile phone (the intake\'s phone)'));
  // Business & Owner Info's own question stays the intake's answer there.
  assert.deepEqual(plan(two(), { drivers: 1 }).filter((s) => s.field === 'GiveOwnerActiveDriverStatusYesNo').map((s) => [s.name, s.steps, s.value]),
    [[OWNER_DRIVES, [BOI], true], [OWNER_DRIVES_ADD, [DRV], true]]);
});

test('ELD: the intake\'s answer; blank is the agent\'s (W43-29)', () => {
  const eld = (changes) => one(plan(with_(changes)), 'Electronic logging device (ELD)');
  assert.deepEqual([eld({}).value, eld({}).field, eld({}).ask, eld({}).steps, eld({}).source], [false, 'GiveElectronicLoggingDevice',
    ['Does the customer have an electronic logging device (ELD) in their vehicle(s)?'], [BCU], 'intake']);
  assert.equal(eld({ 'operations.usesEld': true }).value, true);
  agents(eld({ 'operations.usesEld': null }));
});

// FL live run, 2026-10-21: "click + and add the new vehicle", "click Next after choosing Vehicle or
// Trailer". The panel names the unit it adds (`adding`, sidepanel pickUnitToAdd); with "Click Continue
// when the page is done" on (`click`) the fill clicks the list's "+" and the chooser's Next for it.
test('adding units: the chooser answers the unit the panel adds; its "+" and Next are clicked once per unit, only with the setting on', () => {
  const r = RECORDS()[1];
  const actions = (active) => buildPlan(r, geico, active).filter((s) => s.kind === 'action' && !s.steps.includes(QC));
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
  // Whoever clicked "+" (W43-14, TNI 2026-10-21: after the agent's "+", Fill pressed three times did
  // nothing, waiting for the fill's own): the chooser for the unit the panel adds is continued.
  assert.deepEqual(next.afterActions, []);
  // A Continue that hasn't moved GEICO's step is never clicked again (W43-13).
  assert.equal(geico.continueRetry, false);
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
  // An owner who drives under a name no driver row matches (an answered or a blank box, TNI's Yes):
  // the first row is still the owner, GEICO's own (TNI, 2026-10-27: answer to PR question V4), so the
  // second is added. (Before V4: Add Driver was the agent's, the owner perhaps one of them.)
  for (const changes of [{ 'applicant.owner1': 'Jordan Sample' }, { 'applicant.owner1': 'Jordan Sample', 'applicant.ownerDrives': null }]) {
    assert.deepEqual(buildPlan(with_(changes, RECORDS()[1]), geico, driver).filter((s) => s.kind === 'action' && !s.steps.includes(QC)).map((s) => s.action), ['addDriver:1']);
  }
  // The owner matched, the box blank (W44-01, W44-25: TNI's Yes), or the owner not driving: added.
  for (const changes of [{ 'applicant.ownerDrives': null }, { 'applicant.ownerDrives': false }]) {
    assert.equal(buildPlan(with_(changes, RECORDS()[1]), geico, driver).filter((s) => s.kind === 'action' && !s.steps.includes(QC)).length, 1, JSON.stringify(changes));
  }
  // Never a button that leaves a step or commits: on the unit steps only the add icon and Next inside
  // the chooser; on Quote & Coverages the cargo card's chevron, View More Payment Plans and Print
  // Quote Proposal (TNI, 2026-10-21), Recalculate once a quote (W43-31), never its Next (MVR & CLUE).
  // A "needs you" item with no button at all (V1's noOtherDriver) is never clicked.
  for (const a of geico.actions) {
    assert.ok(a.token === 'addIcon' || (a.text === '^next$' && a.moveOn && /VehicleOrTrailer/.test(a.within)) || (!a.text && !a.token && !!a.missing)
      || (a.steps.includes(QC) && (a.token === 'editIcon' || ['^recalculate$', '^view more payment plans$', '^print quote proposal$', '^yes,?\\s*under permanent lease$'].includes(a.text))), a.id);
  }
});

test('SR-22: No for everyone; Yes only when GEICO lists one driver', () => {
  assert.deepEqual([value(intake(), 'SR-22 (the owner; TNI: No unless the intake says otherwise)'), value(intake(), 'SR-22 (this driver; TNI: No unless the intake says otherwise)', DRV, { drivers: 0 })], [false, null]);
  assert.equal(value(with_({ 'operations.needSr22': true }), 'SR-22 (the owner; TNI: No unless the intake says otherwise)'), true);
  const two = with_({ 'operations.needSr22': true, drivers: [intake().drivers[0], CASEY] });
  agents(one(plan(two), 'SR-22 (the owner; TNI: No unless the intake says otherwise)'));
  agents(one(plan(two, { drivers: 1 }), 'SR-22 (this driver; TNI: No unless the intake says otherwise)'));
  assert.equal(value(with_({ drivers: [intake().drivers[0], CASEY] }), 'SR-22 (this driver; TNI: No unless the intake says otherwise)', DRV, { drivers: 1 }), false);
  // The intake's only driver under another name than the owner box's: still the owner, the first
  // driver (TNI, 2026-10-27: answer to PR question V4), so GEICO lists one driver and the owner's form
  // gets the Yes. (Before V4: the owner listed besides that driver, two, so neither was answered.)
  const other = with_({ 'operations.needSr22': true, 'applicant.owner1': 'Jordan Sample' });
  assert.equal(value(other, 'SR-22 (the owner; TNI: No unless the intake says otherwise)'), true);
  agents(one(plan(other, { drivers: 0 }), 'SR-22 (this driver; TNI: No unless the intake says otherwise)'));
  // The owner doesn't drive, but the agent set the only row's Excluded driver to No (this file's
  // intake): the row is added, GEICO's only driver.
  assert.equal(value(with_({ 'operations.needSr22': true, 'applicant.ownerDrives': false, 'applicant.owner1': 'Jordan Sample' }), 'SR-22 (this driver; TNI: No unless the intake says otherwise)', DRV, { drivers: 0 }), true);
  // A blank owner-drives box is TNI's Yes (W44-25): GEICO lists the owner, the only row, so no Add
  // Driver form is theirs.
  agents(one(plan(with_({ 'operations.needSr22': true, 'applicant.ownerDrives': null, 'applicant.owner1': 'Jordan Sample' }), { drivers: 0 }), 'SR-22 (this driver; TNI: No unless the intake says otherwise)'));
  // The owner's own form: from the first row, whatever its name (V4); no driver rows: the agent's.
  assert.equal(value(with_({ 'applicant.owner1': 'Jordan Sample' }), 'Owner\'s license state'), 'NE');
  agents(one(plan(with_({ drivers: [] })), 'Owner\'s license state'));
  // Blank: TNI's No for every driver (W43-34), unless the filings or the notes name an SR-22, an FR-44
  // or financial responsibility: then the agent's, quoted.
  const silent = with_({ 'operations.needSr22': null, drivers: [intake().drivers[0], CASEY] });
  for (const s of [one(plan(silent), 'SR-22 (the owner; TNI: No unless the intake says otherwise)'), one(plan(silent, { drivers: 1 }), 'SR-22 (this driver; TNI: No unless the intake says otherwise)', DRV)]) {
    assert.deepEqual([s.value, s.source, s.standard], [false, 'standard', true], s.name);
  }
  for (const [changes, says] of [[{ 'operations.filingsWhich': 'SR-22 for the owner' }, /"SR-22 for the owner"/], [{ 'notes.text': 'Driver 2 needs an FR44' }, /"Driver 2 needs an FR44"/],
    [{ 'claims.notes': 'Financial responsibility filing in GA' }, /"Financial responsibility filing in GA"/]]) {
    const mentioned = with_({ 'operations.needSr22': null, 'applicant.ownerDrives': false, 'applicant.owner1': 'Jordan Sample', ...changes });
    for (const s of [one(plan(mentioned), 'SR-22 (the owner; TNI: No unless the intake says otherwise)'), one(plan(mentioned, { drivers: 0 }), 'SR-22 (this driver; TNI: No unless the intake says otherwise)', DRV)]) {
      agents(s);
      assert.equal(s.source, 'fact', s.name);
      assert.match(s.note, says);
    }
  }
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
  // Undated: proof of prior insurance assumed (TNI, 2026-10-26, W44-29; the agent's before).
  assert.deepEqual([auto({ 'priorInsurance.0.expiration': null }).value, auto({ 'priorInsurance.0.expiration': null }).source], ['Yes', 'standard']);
  for (const changes of [{ 'priorInsurance.0.expiration': '01/31/2026' }, { priorInsurance: [] },
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
  // The owner is the first driver, whatever its name (TNI, 2026-10-27: answer to PR question V4), so
  // a list with no row carrying the owner's name counts all but its first (before V4: all of them).
  assert.deepEqual([[owner], [owner, CASEY], [owner, ...others(3)], [owner, ...others(5)], others(1), others(21)].map((d) => employees(d).value), ['None', '1', '2-3', '4-5', 'None', '11-20']);
  // A Jr after the owner is an employee (V4).
  assert.equal(employees([owner, { ...owner, suffix: 'Jr' }]).value, '1');
  assert.deepEqual([employees([owner, CASEY]).source, employees([owner, CASEY]).standard], ['standard', true]);
  // The second owner isn't an employee either.
  assert.equal(employees([owner, CASEY], { 'applicant.owner2': 'Casey Example' }).value, 'None');
  agents(employees([]));
  // 1-3 Years with a current auto policy on the intake (proof of prior insurance); otherwise the agent's.
  const years = (changes) => one(plan(with_(changes)), 'Years with the current auto insurer (1-3 with a current policy)');
  assert.deepEqual([years({}).value, years({}).source, years({ 'priorInsurance.0.type': 'Personal Auto' }).value], ['1-3 Years', 'standard', '1-3 Years']);
  for (const changes of [{ priorInsurance: [] }, { 'priorInsurance.0.expiration': '01/31/2026' }, { priorInsurance: [{ type: null, carrier: 'No', limit: null, expiration: null }] }]) agents(years(changes));
  // Additional insureds and waivers: No (TNI, 2026-10-27: after the policy starts, not at quote).
  for (const name of ['Named additional insured or waiver of subrogation (TNI: No)', 'Blanket additional insured by contract (TNI: No)', 'Blanket waiver of subrogation by contract (TNI: No)']) {
    assert.deepEqual([one(plan(intake()), name).value, one(plan(intake()), name).source], [false, 'standard'], name);
  }
  // Both GEICO wordings of the named-AI question (it dropped "or a designated insured").
  const named = one(plan(intake()), 'Named additional insured or waiver of subrogation (TNI: No)');
  assert.deepEqual(named.ask, [
    'Does the customer need to add a named additional insured? Or do they need a named waiver of subrogation?',
    'Does the customer need to add a named additional insured or a designated insured? Or do they need a named waiver of subrogation?',
  ]);
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

test('liability coverage and its limit from the intake; an NTL mention not answered is the agent\'s', () => {
  const liab = (changes) => { const p = plan(with_(changes)); return [one(p, 'Liability coverage'), one(p, 'Liability limit')]; };
  const [type, limit] = liab({});
  assert.deepEqual([type.value, limit.value], ['Bodily Injury and Property Damage Liability', '$1M CSL']);
  assert.equal(liab({ 'coverage.autoLiability': null })[0].value, 'Bodily Injury and Property Damage Liability', 'a limit with the box blank');
  // NTL mentioned and not decided, or no auto liability: both the agent's (an NTL quote: below).
  for (const changes of [{ 'claims.text': 'Client also wants NTL' }, { 'coverage.autoLiability': 'No' }, { 'coverage.autoLiability': null, 'coverage.autoLiabLimit': null }]) {
    for (const s of liab(changes)) agents(s);
  }
  assert.match(liab({ 'notes.text': 'bobtail cover' })[0].note, /the Intake step/);
  // Decided No on Check intake: the intake's liability.
  assert.equal(liab({ 'claims.text': 'Client also wants NTL', 'coverage.ntl': false })[0].value, 'Bodily Injury and Property Damage Liability');
  agents(one(plan(intake()), 'Policy term'));
  // TNI's (FL live run 4, 2026-10-21, every state): UM/UIM $100,000 CSL (W43-17); 11 Payments,
  // waited for until View More Payment Plans shows it (W43-18).
  // Texas lists only split limits: $100,000/$300,000 there (W43-33). GA and SC caption it "(UMBI)",
  // SC asks underinsured apart ("(UIMBI)"): $100,000 CSL each.
  const UM = 'Uninsured motorist bodily injury (TNI: $100,000 CSL; TX $100,000/$300,000)';
  for (const [r, limit] of [[intake(), '$100,000 Combined Single Limit'], [blank(), '$100,000 Combined Single Limit'], [with_({ 'garaging.state': 'TX' }), '$100,000/$300,000'],
    [with_({ 'garaging.state': ' tx ' }), '$100,000/$300,000'], [with_({ 'garaging.state': 'FL' }), '$100,000 Combined Single Limit']]) {
    const um = one(plan(r), UM);
    assert.deepEqual([um.value, um.source, um.standard, um.ask], [limit, 'standard', true, ['Uninsured Motorist Bodily Injury (includes Underinsured)']]);
    for (const [name, ask] of [['Uninsured motorist bodily injury, UMBI (TNI: $100,000 CSL)', 'Uninsured Motorist Bodily Injury (UMBI)'],
      ['Underinsured motorist bodily injury, UIMBI (TNI: $100,000 CSL)', 'Underinsured Motorist Bodily Injury (UIMBI)']]) {
      const s = one(plan(r), name);
      assert.deepEqual([s.value, s.source, s.standard, s.ask, s.control], ['$100,000 Combined Single Limit', 'standard', true, [ask], 'select']);
    }
    const pay = plan(r).filter((s) => s.field === 'GivePayPlanV2');
    assert.deepEqual(pay.map((s) => [s.each, s.value, s.source, s.whenOffered]), [[true, '11 Payments', 'standard', true], [true, '11 Payments', 'standard', true]]);
  }
  // TNI, 2026-10-27: when asked, UM/UIM type is Add-On and deductible $1,000.
  for (const r of [intake(), with_({ 'garaging.state': 'TX' }), blank()]) {
    assert.deepEqual([one(plan(r), 'UM/UIM type (TNI: Add-On)').value, one(plan(r), 'UM/UIM type (TNI: Add-On)').source], ['Add-On', 'standard']);
    assert.deepEqual([one(plan(r), 'Uninsured motorist deductible (TNI: $1,000)').value, one(plan(r), 'Uninsured motorist deductible (TNI: $1,000)').source], ['$1,000', 'standard']);
  }
  // Property damage liability and UMPD stay the agent's (W43-33).
  for (const name of ['Property damage liability', 'Uninsured motorist property damage']) {
    for (const r of [intake(), with_({ 'garaging.state': 'TX' })]) {
      const s = one(plan(r), name);
      agents(s);
      assert.deepEqual([s.source, s.manualOnly], ['fact', true], name);
    }
  }
});

// TNI, 2026-10-26, W44-26 (the maintainer: "Always add medical payments at $5K, there is no medical
// payments, choose PIP"; GEICO offering both: "MedPay $5K, PIP yok"), replacing that morning's "If
// there is personal injury protection available, we always prefer PIP" and Florida's Medical
// Payments Not Included (2026-10-21). What the page kit does with the lists: test/pagekit.test.mjs.
const MED = 'Medical payments (TNI: $5,000; Not Included where GEICO offers no limit)';
const BASIC_PIP = 'Basic personal injury protection (TNI: declined beside medical payments, else $2,500; FL: as GEICO has it)';
test('Medical Payments $5,000 wherever GEICO offers it, PIP declined beside it and $2,500 without it; Florida keeps its PIP (TNI)', () => {
  // Every state, Florida too: $5,000, and Not Included where GEICO's list offers no limit (TX).
  for (const r of [intake(), with_({ 'garaging.state': 'TX' }), with_({ 'garaging.state': 'FL' }), with_({ 'garaging.state': ' fl ' }), blank()]) {
    const med = one(plan(r), MED);
    assert.deepEqual([med.value, med.source, med.standard, med.kind, med.ignore, med.onlyIf], ['$5,000', 'standard', true, 'choice', false,
      [{ path: null, limit: true, value: null }, { path: null, limit: false, value: 'Not Included' }]], r.garaging.state ?? 'blank');
    assert.match(med.unofferedNote, /doesn't list \$5,000 medical payments/, 'a list without $5,000 is the agent\'s at once');
  }
  // Basic PIP outside Florida: I decline where Medical Payments lists a limit, else $2,500 (read from
  // the Medical Payments list, or none off the page). A list without the answer is the agent's at once.
  for (const r of [intake(), with_({ 'garaging.state': 'TX' })]) {
    const p = plan(r);
    const pip = one(p, BASIC_PIP);
    const med = one(p, MED);
    assert.deepEqual([pip.value, pip.source, pip.standard, pip.ignore, pip.whenOffered, pip.emptyNote, pip.onlyIf], ['$2,500', 'standard', true, false, false, null,
      [{ path: med.path, limit: true, value: 'I decline' }, { path: med.path, limit: false, value: null }]], r.garaging.state);
    assert.match(pip.unofferedNote, /basic personal injury protection/);
    // The other PIP lists stay the agent's outside Florida.
    for (const name of ['Excluded work loss', 'PIP options']) agents(one(p, name));
  }
  // Florida requires PIP: the PIP lists (one choice each) are kept as GEICO has them.
  const fl = plan(with_({ 'garaging.state': 'FL' }));
  for (const name of [BASIC_PIP, 'PIP options', 'Excluded work loss', 'Stacked uninsured motorist']) {
    const s = one(fl, name);
    assert.deepEqual([s.ignore, s.value, s.source, s.note, s.onlyIf], [true, null, null, null, null], name);
    assert.match(s.emptyNote, /left .* empty/);
  }
});

test('cargo: the intake\'s limit and deductible as one pair; never a default deductible', () => {
  const p = plan(intake());
  assert.deepEqual([one(p, 'Motor truck cargo wanted').value, one(p, 'Motor truck cargo limit and deductible').value], [true, '$100000/$1000']);
  const noDed = one(plan(with_({ 'coverage.cargoDeductible': null })), 'Motor truck cargo limit and deductible');
  agents(noDed);
  // TNI, 2026-10-27: the agent's alone (a client fact, never Luna's), told what it usually is.
  assert.deepEqual([noDed.source, noDed.manualOnly], ['fact', true]);
  assert.match(noDed.note, /usually \$1,000 or \$2,500/);
  agents(one(plan(with_({ 'coverage.cargo': false })), 'Motor truck cargo limit and deductible'));
  agents(one(plan(with_({ 'coverage.cargo': null })), 'Motor truck cargo wanted'));
  // Household goods: Yes for a household goods mover; otherwise TNI's No (W43-30), unless the class,
  // what they haul or the notes mention household goods, household moving or cotton: then the agent's, quoted.
  const GOODS = 'Cargo: household goods or freshly ginned cotton (Yes for a household goods mover; TNI: No unless the intake mentions them)';
  const goods = (changes) => one(plan(with_(changes)), GOODS);
  const mover = goods({ 'operations.businessClass': 'Household Goods Mover' });
  assert.deepEqual([mover.value, mover.source, mover.note], [true, 'derived', null]);
  for (const changes of [{}, { 'operations.businessClass': 'Expediter', 'operations.whatHaul': null }, { 'operations.whatHaul': 'Removals of office furniture' },
    { 'notes.text': 'Keeps loads moving 24/7' }, { 'operations.whatHaul': 'Prime movers and parts' }, { 'notes.text': 'Relocating the yard to Omaha in May' }]) {
    const s = goods(changes);
    assert.deepEqual([s.value, s.source, s.standard, s.note], [false, 'standard', true, null], JSON.stringify(changes));
  }
  for (const [changes, says] of [[{ 'operations.whatHaul': 'Household goods, local moves' }, /"Expediter \/ Household goods, local moves"/],
    [{ 'operations.businessClass': 'Moving company' }, /"Moving company \/ General freight"/], [{ 'operations.whatHaul': 'Ginned cotton bales' }, /cotton bales/],
    [{ 'notes.text': 'Some residential relocation work' }, /"Some residential relocation work"/], [{ 'notes.text': 'Also does home moves on weekends' }, /home moves/]]) {
    const s = goods(changes);
    agents(s);
    assert.equal(s.source, 'fact');
    assert.match(s.note, says);
  }
  // Commodities from the business class and what they haul (TNI, FL live run 5, 2026-10-21, W43-23):
  // general freight other consumer goods, an auto hauler automobiles, a reefer four picks.
  const goodsFor = (changes) => one(plan(with_(changes)), 'Cargo commodities');
  const REEFER_PICKS = 'Consumer Goods - Pharmaceuticals (Over The Counter); Food & Beverage - Other Food & Beverages; Refrigerated Goods - Dairy; Refrigerated Goods - Frozen Seafood';
  assert.deepEqual([goodsFor({}).value, goodsFor({}).source], ['Consumer Goods - Other Consumer Goods', 'derived']);
  for (const [cls, haul] of [['General Freight Hauler', null], ['Expediter', 'Dry Freight'], ['Expediter', 'Consumer goods'], ['Expediter', 'General']]) {
    assert.equal(goodsFor({ 'operations.businessClass': cls, 'operations.whatHaul': haul }).value, 'Consumer Goods - Other Consumer Goods', `${cls} / ${haul}`);
  }
  assert.equal(goodsFor({ 'operations.businessClass': 'Auto Hauler', 'operations.whatHaul': null }).value, 'Aircraft/Auto/Boats - Automobiles');
  // Auto parts aren't automobiles: TNI's auto accessories (not tires), also named with general freight
  // (TNI, 2026-10-28; before, other consumer goods with general freight, alone the agent's).
  const PARTS = 'Aircraft/Auto/Boats - Auto Accessories (Not Tires)';
  for (const [cls, haul] of [['Expediter', 'General freight, auto parts'], ['Auto Parts Distributor', 'Car parts'], ['Expediter', 'Auto-parts'], ['Expediter', 'Auto body parts']]) {
    assert.deepEqual([goodsFor({ 'operations.businessClass': cls, 'operations.whatHaul': haul }).value, goodsFor({ 'operations.businessClass': cls, 'operations.whatHaul': haul }).source], [PARTS, 'derived'], `${cls} / ${haul}`);
  }
  assert.equal(goodsFor({ trailers: [{ ...TRAILER, type: 'Reefer' }] }).value, REEFER_PICKS, 'a reefer listed: the reefer picks, before general freight');
  assert.equal(goodsFor({ 'operations.businessClass': 'Expediter', 'operations.whatHaul': 'Refrigerated produce' }).value, REEFER_PICKS);
  // No match ("cargo" isn't a car): the agent's, quoted, and open to the AI's suggestion (not manualOnly).
  const other = goodsFor({ 'operations.businessClass': 'Expediter', 'operations.whatHaul': 'Cargo and parcels' });
  agents(other);
  assert.match(other.note, /"Cargo and parcels"/);
  assert.equal(other.manualOnly, false);
  // Mobile homes, documents or securities, and live animals: TNI's No, unless the intake names them.
  for (const [name, words] of [['Cargo: mobile homes, business documents or securities (TNI: No unless the intake names them)', 'Mobile homes'], ['Cargo: live animals (TNI: No unless the intake names them)', 'Livestock']]) {
    assert.deepEqual([one(p, name).value, one(p, name).source], [false, 'standard'], name);
    agents(one(plan(with_({ 'operations.whatHaul': words })), name));
  }
  // Whole words only: paint pigments, horsepower parts and modular furniture name none of them.
  for (const haul of ['Paint and pigments', 'Horsepower parts', 'Modular office furniture']) {
    for (const name of ['Cargo: mobile homes, business documents or securities (TNI: No unless the intake names them)', 'Cargo: live animals (TNI: No unless the intake names them)']) {
      assert.equal(one(plan(with_({ 'operations.whatHaul': haul })), name).value, false, `${haul}: ${name}`);
    }
  }
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
  // Rental reimbursement with downtime: TNI's Not Included on every vehicle (W43-30), unless a line of
  // the notes mentions downtime or rental: then the agent's, quoted.
  const DOWNTIME = 'Rental reimbursement with downtime (TNI: Not Included)';
  assert.deepEqual(p.filter((x) => x.name === DOWNTIME).map((s) => [s.value, s.source, s.selector]), [['Not Included', 'standard', '[id$="_RRWDT"]'], ['Not Included', 'standard', '[id$="_RRWDT"]']]);
  for (const [box, text] of [['notes.text', 'Wants downtime coverage if offered'], ['claims.notes', 'Asked about rental while in the shop']]) {
    const s = one(plan(with_({ [box]: text })), DOWNTIME);
    agents(s);
    assert.equal(s.source, 'fact');
    assert.ok(s.note.includes(text), s.note);
  }
  // Fire and theft Not Included, rental $40 a day, on every vehicle (TNI, FL live run 5, 2026-10-21, W43-22).
  assert.deepEqual(p.filter((x) => /^Fire and theft/.test(x.name)).map((s) => [s.value, s.source]), [['Not Included', 'standard'], ['Not Included', 'standard']]);
  assert.deepEqual(p.filter((x) => /^Rental reimbursement \(/.test(x.name)).map((s) => [s.value, s.source]), [['$40 Per Day, $1,200 Max', 'standard'], ['$40 Per Day, $1,200 Max', 'standard']]);
  // Rental needs comprehensive and collision: with the notes declining them, the agent's.
  agents(one(plan(with_({ 'notes.text': 'liability only' })), 'Rental reimbursement (TNI: $40 Per Day, $1,200 Max)'));
  assert.equal(one(plan(with_({ 'notes.text': 'liability only' })), 'Fire and theft (TNI: Not Included)').value, 'Not Included');
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
  const WAITING = [VEHICLE_TYPE, 'Customizations (from the attached equipment value)',
    'Customization value (the attached equipment value, else TNI: 0)', 'Vehicle value without customizations', 'Comprehensive or collision wanted (TNI: Yes)',
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


// The maintainer, 2026-10-26, live run (GEICO, TX, NTL on the form): picking Non-Trucking Liability
// for Liability Coverage, GEICO asks "Yes, under permanent lease" and puts Liability Coverage back
// until it is answered; then it draws "Non Trucking Liability (NTL)" ($300,000 to $1,000,000 CSL,
// GEICO's $300,000 picked) in place of the liability limit, and resets UM to $300,000.
test('an NTL quote: Non-Trucking Liability, the permanent lease Yes, the intake\'s limit for NTL', () => {
  const r = with_({ 'coverage.ntl': true, 'coverage.autoLiability': 'Non-Trucking' });
  const p = plan(r);
  const type = one(p, 'Liability coverage');
  assert.deepEqual([type.value, type.note ?? null], ['Non-Trucking Liability', null]);
  const ntl = one(p, 'Non-trucking liability limit (the intake\'s liability limit)');
  assert.deepEqual([ntl.value, ntl.ask, ntl.control], ['$1M CSL', ['Non Trucking Liability (NTL)'], 'select']);
  assert.equal(one(p, 'Liability limit').ignore, true, 'GEICO hides the liability limit with NTL');
  assert.equal(one(plan(intake()), 'Non-trucking liability limit (the intake\'s liability limit)').ignore, true, 'not without NTL');
  assert.equal(one(plan(intake()), 'Liability limit').ignore, false);
  // The pop-up: clicked first thing the next round, again whenever it shows again.
  const lease = buildPlan(r, geico, {}).find((s) => s.action === 'ntlLease');
  assert.deepEqual([lease.immediate, lease.verify], [true, 'gone']);
  assert.ok(new RegExp(lease.text, 'i').test('Yes, under permanent lease'));
  assert.ok(!buildPlan(intake(), geico, {}).some((s) => s.action === 'ntlLease'), 'not without NTL');
});

// The maintainer, 2026-10-26 (W44-28): "US DOT is not added and filings not added if its NTL, in
// every case" (W44-07: with the federal filing ticked Progressive offered only primary liability).
// On GEICO: no USDOT number on the gateway or on Business Class & USDOT, "has a USDOT number" No,
// filings No and Neither, no filing box ticked. The Add USDOT Number screen stays the agent's.
test('an NTL quote: no USDOT number and no filings on GEICO (W44-28)', () => {
  const NTL = { 'coverage.ntl': true, 'coverage.autoLiability': 'Non-Trucking' };
  const FILINGS = 'Filings required (TNI: No unless the intake says otherwise)';
  const USDOT_BOXES = ['USDOT #', 'Start quote: USDOT number', 'Start quote: USDOT number (Search Products)'];
  const got = (s) => [s.value, s.source, s.standard, s.note ?? null];
  // With cargo or GL too, NTL the agent set with auto liability blank, an MC number, a notes line
  // naming a filing, a USDOT number coming within 60 days and none now: still none of either.
  for (const changes of [NTL, { ...NTL, 'coverage.cargo': false }, { ...NTL, 'coverage.gl': true }, { ...NTL, 'coverage.autoLiability': null },
    { ...NTL, 'applicant.mc': 'MC-765432' }, { ...NTL, 'operations.filingsRequired': null, 'operations.filingsWhich': null, 'notes.text': 'Needs MCS-90 for the broker' },
    { ...NTL, 'applicant.dot': null, 'applicant.mcDotWithin60Days': true }]) {
    const p = plan(with_(changes));
    const what = JSON.stringify(changes);
    assert.deepEqual(got(one(p, 'Has a USDOT number')), ['No', 'standard', true, null], `"Does the customer have a USDOT Number registered to themselves or their business?" ${what}`);
    for (const name of USDOT_BOXES) assert.equal(one(p, name).ignore, true, `${name}: never typed ${what}`);
    assert.deepEqual(got(one(p, FILINGS)), [false, 'standard', true, null], `"Is the customer required to provide proof of insurance/filings to a state or federal agency?" ${what}`);
    assert.deepEqual(got(one(p, 'State or federal filing')), ['Neither', 'standard', true, null], what);
    for (const name of ['Federal liability filing', 'State filing']) assert.equal(one(p, name).ignore, true, `${name}: never ticked ${what}`);
  }
  // Not an NTL quote: as before. (NTL with primary auto liability too: the agent's, the next test.)
  for (const changes of [{}, { 'coverage.ntl': false }]) {
    const p = plan(with_(changes));
    const what = JSON.stringify(changes);
    assert.deepEqual(got(one(p, 'Has a USDOT number')), ['Yes', 'derived', false, null], what);
    for (const name of USDOT_BOXES) assert.equal(one(p, name).ignore, false, `${name} ${what}`);
    assert.deepEqual(got(one(p, FILINGS)), [true, 'intake', false, null], what);
    assert.deepEqual(got(one(p, 'State or federal filing')), ['Federal', 'derived', false, null], what);
    assert.deepEqual([one(p, 'Federal liability filing').value, one(p, 'Federal liability filing').ignore], [true, false], what);
  }
  // An NTL intake with no USDOT or MC number, none coming and no filings: nothing changes.
  const none = { 'applicant.dot': null, 'applicant.mc': null, 'applicant.mcDotWithin60Days': false, 'operations.filingsRequired': false, 'operations.filingsWhich': null };
  const [withNtl, without] = [plan(with_({ ...NTL, ...none })), plan(with_(none))];
  for (const name of ['Has a USDOT number', ...USDOT_BOXES, FILINGS, 'State or federal filing', 'Federal liability filing', 'State filing']) {
    const [a, b] = [one(withNtl, name), one(without, name)];
    assert.deepEqual([a.value, a.source, a.standard, a.ignore, a.note], [b.value, b.source, b.standard, b.ignore, b.note], name);
  }
  // GEICO's "Add USDOT Number / Skip" screen: still the agent's (nothing clicked); on an NTL quote its
  // note says TNI adds no USDOT number there. Elsewhere it says what it said.
  const note = geico.stopButtons['USDOT Number'].note;
  assert.match(note(with_(NTL)), /non-trucking liability \(NTL\) quote/i);
  assert.match(note(with_(NTL)), /TNI adds no USDOT number/);
  assert.match(note(with_(NTL)), /yours/);
  assert.equal(note(intake()), 'GEICO asks for a USDOT number; the intake\'s is "1234567". Add USDOT Number or Skip is yours.');
  assert.equal(note(with_({ 'applicant.dot': null })), 'GEICO asks for a USDOT number, and the intake has none. Add USDOT Number or Skip is yours.');
  assert.equal(note(null), 'GEICO asks for a USDOT number, and the intake has none. Add USDOT Number or Skip is yours.');
});

// (TNI, 2026-10-26: answers to PR questions, #192) NTL with primary auto liability too (auto
// liability Yes): the USDOT and filings questions are the agent's, with a note naming the conflict.
// NTL mentioned in the claims box or the notes (or flagged by Luna) and not answered yet: they wait
// for the answer, with a note to answer NTL on the Intake step first. Answered, the PR's rules.
test('NTL with primary auto liability, or NTL mentioned and not answered: the USDOT and filings questions are the agent\'s on GEICO', () => {
  const FILINGS = 'Filings required (TNI: No unless the intake says otherwise)';
  const USDOT_BOXES = ['USDOT #', 'Start quote: USDOT number', 'Start quote: USDOT number (Search Products)'];
  const got = (s) => [s.value, s.source, s.standard, s.note ?? null];
  const held = [[{ 'coverage.ntl': true, 'coverage.autoLiability': 'Yes' }, /primary auto liability/], [{ 'claims.text': 'No\nAsked about NTL too' }, /Intake step/],
    [{ 'notes.text': 'Client may want bobtail' }, /Intake step/], [{ 'claims.aiNtl': true }, /Intake step/], [{ 'notes.text': 'Needs NTL', 'coverage.autoLiability': null }, /Intake step/]];
  for (const [changes, why] of held) {
    const p = plan(with_(changes));
    const what = JSON.stringify(changes);
    for (const name of ['Has a USDOT number', FILINGS, 'State or federal filing', 'Federal liability filing']) {
      const s = one(p, name);
      assert.deepEqual([s.value, s.source, s.standard, s.manualOnly], [null, 'fact', false, true], `${name}: the agent's ${what}`);
      assert.match(s.note ?? '', why, `${name}: the note says why ${what}`);
    }
    for (const name of USDOT_BOXES) {
      const s = one(p, name);
      assert.deepEqual([s.value, s.ignore], [null, false], `${name}: not typed ${what}`);
      assert.match(s.note ?? '', why, `${name} ${what}`);
    }
    // The Add USDOT Number screen: still the agent's, its note says why.
    assert.match(geico.stopButtons['USDOT Number'].note(with_(changes)), why, what);
  }
  // Answered No (with the mention still there): as on any quote. Answered Yes (Non-Trucking): the NTL quote's.
  const no = plan(with_({ 'notes.text': 'Needs NTL', 'coverage.ntl': false }));
  assert.deepEqual(got(one(no, 'Has a USDOT number')), ['Yes', 'derived', false, null]);
  assert.deepEqual(got(one(no, FILINGS)), [true, 'intake', false, null]);
  for (const name of USDOT_BOXES) assert.deepEqual([one(no, name).ignore, one(no, name).note], [false, null], name);
  const yes = plan(with_({ 'notes.text': 'Needs NTL', 'coverage.ntl': true, 'coverage.autoLiability': 'Non-Trucking' }));
  assert.deepEqual(got(one(yes, 'Has a USDOT number')), ['No', 'standard', true, null]);
  assert.deepEqual(got(one(yes, FILINGS)), [false, 'standard', true, null]);
  // Neither NTL nor a mention: unchanged, the stop screen's note too.
  assert.deepEqual(got(one(plan(intake()), 'Has a USDOT number')), ['Yes', 'derived', false, null]);
  assert.equal(geico.stopButtons['USDOT Number'].note(with_({ 'notes.text': 'Needs NTL', 'coverage.ntl': false })), 'GEICO asks for a USDOT number; the intake\'s is "1234567". Add USDOT Number or Skip is yours.');
});

// The same live run: in Texas with a CSL liability or NTL, GEICO lists UM in CSL only, so the split
// $100,000/$300,000 found no option and GEICO's $300,000 stayed. $100,000 CSL then.
test('Texas UM: $100,000/$300,000 when GEICO lists split limits, else $100,000 CSL', () => {
  const um = one(plan(with_({ 'garaging.state': 'TX' })), 'Uninsured motorist bodily injury (TNI: $100,000 CSL; TX $100,000/$300,000)');
  assert.deepEqual([um.value, um.choiceAliases], ['$100,000/$300,000', ['$100,000 Combined Single Limit']]);
  assert.deepEqual(one(plan(intake()), 'Uninsured motorist bodily injury (TNI: $100,000 CSL; TX $100,000/$300,000)').choiceAliases, []);
});

// The maintainer, 2026-10-26: a blank CDL box on the intake means No (TNI's standard), for the
// owner's form and Add Driver alike; the live run left both drivers' CDL questions yellow.
test('a blank CDL on the intake is No, as TNI\'s standard', () => {
  const blankCdl = with_({ drivers: [{ ...intake().drivers[0], cdl: null, cdlYear: null }, { ...CASEY, cdl: null }] });
  const p = plan(blankCdl, { drivers: 1 });
  const ownerCdl = one(p, 'Owner has a CDL (TNI: No when the intake leaves it blank)');
  const driverCdl = one(p, 'Driver has a CDL (TNI: No when the intake leaves it blank)');
  assert.deepEqual([ownerCdl.value, ownerCdl.source, driverCdl.value, driverCdl.source], [false, 'standard', false, 'standard']);
  const yes = plan(with_({ drivers: [intake().drivers[0], { ...CASEY, cdl: true }] }), { drivers: 1 });
  assert.deepEqual([one(yes, 'Driver has a CDL (TNI: No when the intake leaves it blank)').value, one(yes, 'Driver has a CDL (TNI: No when the intake leaves it blank)').source], [true, 'intake']);
  // The review of PR #176: a CDL year with the box blank says they may have one: not No, the agent's.
  const year = plan(with_({ drivers: [{ ...intake().drivers[0], cdl: null, cdlYear: 2015 }, { ...CASEY, cdl: null, cdlYear: 2015 }] }), { drivers: 1 });
  const [o, d] = [one(year, 'Owner has a CDL (TNI: No when the intake leaves it blank)'), one(year, 'Driver has a CDL (TNI: No when the intake leaves it blank)')];
  assert.deepEqual([o.value, o.source, d.value, d.source], [null, 'derived', null, 'intake']);
  // A driver the intake doesn't have: nothing, as before.
  const none = one(plan(blankCdl, { drivers: 5 }), 'Driver has a CDL (TNI: No when the intake leaves it blank)');
  assert.deepEqual([none.value, none.source], [null, 'intake']);
});
