#!/usr/bin/env node
// GEICO end to end, without the live site: the one-file quote (test/fixtures/geico/quote.html,
// built from the saved NE pages and the FL captures, client details replaced) with the site's
// behaviour played by test/fixtures/geico/mock.js, filled step by step by the real fill engine and
// GEICO rules the way the side panel does it, and the agent's part played with real (trusted)
// clicks and keys: Next on each step that leaves them something, the answers the intake doesn't give,
// a few corrections, and the trailer's Add Vehicle or Trailer and Next with "Click Continue when the
// page is done" off. With it on, the extension adds vehicle 2 and driver 2 itself (the list's "+", the
// chooser's Vehicle and Next), and continues where nothing is left for the agent (geico.advance): Next
// or Save and Continue on a step or unit form up to Additional Business Info, Looks Good on a list that
// holds every intake unit, never on Quote & Coverages. Then every answer is checked against what TNI
// expects.
//
//   npm run mock:geico             # exits 1 on a wrong answer, a missing needs-you item, an agent
//                                  # correction the next fill overwrote (one made on a form no fill
//                                  # had read yet included) or typed over where another step asks it
//                                  # again, one that kept another step's or form's answer from being
//                                  # filled, the agent's changes sent without the unit forms on
//                                  # screen, one unit's answers on another's form, a click the
//                                  # extension must never make (one besides the "+" and the
//                                  # chooser's Next for each unit it adds, once, with the setting
//                                  # on, and its Continues where nothing was left for the agent),
//                                  # anything done on a stop step, a filled Social Security number
//                                  # or a page error
//   npm run mock:geico -- --headed # watch it
//
// As the extension does it: field-key.js, pagekit.js and recorder.js run in an isolated world of
// their own (CDP Page.createIsolatedWorld; GEICO's carrier has no `world`), the recorder is paused
// while the kit fills, and the agent's edits it reports, with the unit forms on screen as the kit
// reads them (`forms`), are kept where they were made (sidepanel.js changeScopes: per step, and on
// Vehicles and Drivers & Incidents per form and its unit) and are the next fills' `skip` and
// `skipBy`. The panel's part is played here: the plan per fill (buildPlan with the picker's vehicle,
// driver and trailer, and the unit it adds: pickUnitToAdd), the fill options as sidepanel.js fillOptions builds them for GEICO
// (replaceChoices, stopSteps, units with the forms each unit was filled on, dropped for a unit picked
// again, fillSkip, fillSkipBy, takenBack with the keys filled so far, the Continue with Looks Good
// once the list holds every intake unit: advanceFor), rememberFill's bookkeeping (with the steps,
// forms and buttons continued from: doneSteps),
// and the follow-up fills when new questions show (on Quote & Coverages only those, never after an
// answer: geico.newQuestionsOnlySteps). Every request off the computer is refused.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildPlan } from '../src/plan.js';
import { geico } from '../src/carriers/geico.js';
import { knownStep } from '../src/usage.js';
import { advanceFor, unitListSpecs, unitToAdd } from '../src/units.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');
const source = (file) => fs.readFileSync(path.join(root, 'src/content', file), 'utf8');
const KIT = ['field-key.js', 'pagekit.js'].map(source).join('\n');
const RECORDER = source('recorder.js');

// A synthetic client (synthetic values only, the VINs from scripts/lib/privacy.mjs ALLOWED): an
// LLC with a USDOT number, two RAM trucks (the first with its VIN, which the mock decodes to the
// same truck; the second without one) and a dry van trailer, the owner driving and one more
// driver, no filings, no hazardous placard, $1M CSL and cargo at a limit and deductible GEICO
// offers, no general liability.
const record = {
  applicant: { name: 'SAMPLE FREIGHT LLC', dot: '1234567', mc: null, mcDotWithin60Days: null, fein: null, yearEstablished: 2019, yearsInBusiness: 7,
    phone: '(402) 555-0100', email: 'client@example.test', owner1: 'SAMPLE DRIVER', owner2: null, ownerDrives: true, yearsExperience: 10, applicationDate: '10/20/2026' },
  garaging: { street: '1 Test Way', unit: null, city: 'Omaha', state: 'NE', zip: '68102' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', radius: '150 miles', radiusMiles: 150, vehicleOwnership: 'Owned', personalUse: false,
    usesEld: false, eldBrand: null, needSr22: false, filingsRequired: false, filingsWhich: null, hazmat: false, hazPlacard: false, movingState: false,
    teamDriving: false, canadaLoads: false, licensePlate: null, equipVehicle: 0 },
  drivers: [
    { first: 'SAMPLE', middle: null, last: 'DRIVER', suffix: null, dob: '01/02/1980', licenseNumber: null, licenseState: 'NE', cdl: true, cdlYear: 2005, maritalStatus: 'Married', gender: null, excluded: false },
    { first: 'CASEY', middle: null, last: 'EXAMPLE', suffix: null, dob: '07/09/1995', licenseNumber: null, licenseState: 'IA', cdl: false, cdlYear: null, maritalStatus: 'Single', gender: null, excluded: false },
  ],
  vehicles: [
    { type: 'Pickup Truck', year: 2019, make: 'RAM', model: '1500', vin: '1FTBR3X80MKA12345', value: 30000 },
    { type: 'Box Truck', year: 2021, make: 'RAM', model: '2500', vin: null, value: 45000 },
  ],
  trailers: [{ type: 'Dry Van', year: 2015, make: 'WABASH', model: null, vin: null, value: 12000 }],
  trailerInfo: { ownership: null, hitch: null, interchange: false, interchangeLimit: null, equipTrailer: 0 },
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'PROGRESSIVE', limit: '$1M CSL', expiration: '12/31/2026' }],
  coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, hasGl: null, glLimit: null, reeferBreakdown: false, ntl: null },
  claims: { hasClaims: false, text: 'No', notes: null },
  notes: { text: null },
};
const PHONE = /^\(?402\)?[\s-]*555-?0100$/;

// What each form must hold when the agent leaves it (mock.js values(): a radio by its value, a
// list by the option shown, a box by its text), by data-model name. '' is left as the page had it:
// the agent's (or GEICO's).
const EXPECT = {
  'Business Class & USDOT': {
    GiveInitialZipCode: '68102', GiveCurrentGeicoCommercialAutoPolicyYesNo: 'No', GiveDepartmentOfTransportationNumberStatus: 'Yes',
    GiveDepartmentOfTransportationNumber: '1234567', GiveAnyVehicleNeedHazardousMaterialPlacardYesNo: 'No',
    // The intake says No; the agent changed it to Yes, and a redraw later it still is.
    TeamDrivingOrSlipSeatingYesNo: 'Yes',
    // An expediter: For Hire Trucking, Other For-Hire Trucking (TNI, 2026-10-21).
    GivePrimaryBusinessDescription: 'For Hire Trucking', GiveSecondaryBusinessDescription: 'Other For-Hire Trucking', GiveExtendUsDotVerifyBusinessAddress: '',
  },
  'Business & Owner Info': {
    GiveFirstName: 'SAMPLE', GiveDateOfBirth: '01/02/1980', GiveMaritalStatus: 'Married', GiveOwnerActiveDriverStatusYesNo: 'Yes',
    GivePhoneNumber: PHONE, GiveBusinessPhoneNumber: PHONE,
    // The agent's corrections (the intake has DRIVER and client@example.test).
    GiveLastName: 'DRIVERS', GiveEmail: 'owner@example.test',
    // GEICO's suggestion for the intake's address, picked by the fill.
    GiveStreet: '1 Test Way', GiveUnitNumber: '', GiveUnitType: '', GiveZip: '68102', GiveCity: 'OMAHA',
    GiveBusinessOwnershipType: 'Limited Liability Company', GiveBusinessName: 'SAMPLE FREIGHT LLC',
  },
  // The owner's identity again, with the Social Security number, which is never filled. The last name
  // is left as the page draws it (empty here), never the intake's: the agent corrected it on Business &
  // Owner Info, which this form asks again.
  'Vehicles: owner check': {
    GiveBusinessName: 'SAMPLE FREIGHT LLC', GiveFirstName: 'SAMPLE', GiveLastName: '', GiveDateOfBirth: '01/02/1980', GiveZip: '68102', GiveCity: 'OMAHA',
    GiveUnitNumber: '', GiveSocialSecurityNumber: '',
  },
  // Year, make and model by the VIN's decode (checked against the intake, never typed).
  'Vehicles: vehicle 1': {
    YesNoPreQuoteHaveFullVinActivity: 'Yes', GiveVinPreQuote: '1FTBR3X80MKA12345', GiveYear: '2019', GiveMake: 'RAM', GiveModel: '1500',
    GiveOtherVehicleType: '', GiveAnyVehicleCustomizationYesNo: 'No', GiveGrossVehicleWeight: '', GiveStreet: '1 Test Way', GiveZip: '68102', GiveCity: 'OMAHA',
    GiveFarthestOneWayDistance: '101-200', GiveCommercialVehicleForPersonalUse: 'No',
  },
  // No VIN: the agent says so, and make and model are picked from the intake. The year is the agent's
  // correction (the intake has 2021), the type the agent's pick, and the distance the agent's too,
  // picked while the form was held.
  'Vehicles: vehicle 2': {
    YesNoPreQuoteHaveFullVinActivity: 'No', GiveVinPreQuote: '', GiveYear: '2022', GiveMake: 'RAM', GiveModel: '2500',
    GiveOtherVehicleType: 'Box/Straight Truck', GiveAnyVehicleCustomizationYesNo: 'No', GiveGrossVehicleWeight: '', GiveStreet: '1 Test Way', GiveZip: '68102', GiveCity: 'OMAHA',
    GiveFarthestOneWayDistance: '201-300', GiveCommercialVehicleForPersonalUse: 'No',
  },
  // The trailer's year as the agent picked it before any fill read the form (the intake has 2015),
  // never a truck's; its type left for the agent though they picked vehicle 2's (the same field name).
  'Vehicles: trailer 1': { GiveYear: '2016', GiveOtherVehicleType: '', GiveStreet: '1 Test Way', GiveZip: '68102', GiveCity: 'OMAHA', GiveCommercialVehicleCompCollision: 'Yes' },
  // The owner's own answers (their driver row), on the form GEICO adds for an owner who drives.
  'Drivers & Incidents: owner': { GiveDriverLicenseState: 'Nebraska', GiveCertificateOfFinancialResponsibilityDriverYesNo: 'No', CommercialDriverLicense: 'Yes' },
  // The added driver's name from the intake, though the agent corrected the owner's (the same field
  // names) on Business & Owner Info; Employee, TNI's standard for a driver besides the owner.
  'Drivers & Incidents: driver 2': {
    GiveFirstName: 'CASEY', GiveLastName: 'EXAMPLE', GiveDriverSuffix: '', GiveDateOfBirth: '07/09/1995', GiveDriverLicenseState: 'Iowa',
    GiveDriverRelationshipToBusiness: 'Employee', CommercialDriverLicense: 'No',
  },
  'Additional Business Info': {
    // The drivers besides the owner, 1-3 years with a current policy, no other liability policy and no
    // additional insured or waiver: TNI's standards.
    GiveBusinessStartDate: '7+', GiveNumberOfEmployees: '1', GiveCurrentAutoInsuranceStatus: 'Yes', GiveYearsWithCurrentAutoInsurer: '1-3 Years',
    GiveCurrentBodilyInjuryLimits: '$1,000,000/$1,000,000 or $1,000,000 CSL', GiveHasFilingsYesNo: 'No', GiveOtherLiabilityInsurance: 'None',
    GiveInsuredOrWaiverYesNo: 'No', GiveHasContractForBlanketAiEndorsement: 'No',
  },
  'Quote & Coverages': {
    'cov:Liability Coverage': 'Bodily Injury and Property Damage Liability',
    // The intake's $1M CSL, changed by the agent, and kept through the agent's Recalculate and the fill after it.
    'cov:Bodily Injury or Combined Single Limit Liability': '$750,000 Combined Single Limit',
    GiveMtcEligibleRequireCoverageYesNo: 'Yes', GiveMtcRequireCoverageForMobileHomesYesNo: 'No', GiveMtcRequireCoverageForBusinessDocumentYesNo: 'No',
    'cov:Motor Truck Cargo': '$100k/$1000 deductible', GiveMotorTruckGeneralLiabilityCoverageRequired: 'No',
    // TNI's (FL live run 4, 2026-10-21): UM/UIM $100,000 CSL, road service accepted, 11 Payments.
    'cov:Uninsured Motorist Bodily Injury (includes Underinsured)': '$100,000 Combined Single Limit',
    // The installments group (the second): 11 Payments is one of its plans View More shows.
    'cov:ERS#1': 'I accept this coverage', 'cov:ERS#2': 'I accept this coverage', 'GivePayPlanV2#2': 'GEICO_PP_11Pay',
    // TNI's (FL live run 5, 2026-10-21: W43-22, W43-23): fire and theft Not Included, rental $40 a day,
    // and the commodities from what they haul (the intake's general freight: other consumer goods).
    'cov:FT#1': 'Not Included', 'cov:FT#2': 'Not Included', 'cov:Rental#1': '$40 Per Day, $1,200 Max', 'cov:Rental#2': '$40 Per Day, $1,200 Max',
    GiveMtcHaulingCommoditiesCollect: ['Consumer Goods - Other Consumer Goods'],
  },
};
// Questions the fill must leave to the agent, each with its note (report.noData), by field key:
// the facts the intake doesn't give, the agent's picks from long lists, the attestation, the
// Social Security number; the per-vehicle coverage rows of both vehicles but comprehensive and
// collision (TNI's $1,000 deductible), found by each one's year, make and model. [form, note pattern, keys].
const NEEDS_YOU = [
  ['Business Class & USDOT', /\S/, ['ref:GiveExtendUsDotVerifyBusinessAddress']],
  ['Business & Owner Info', /\S/, ['ref:GiveEffectiveDate']],
  ['Vehicles: owner check', /never filled/, ['ref:GiveSocialSecurityNumber']],
  ['Vehicles: vehicle 1', /\S/, ['ref:GiveOtherVehicleType', 'ref:GiveGrossVehicleWeight']],
  ['Vehicles: vehicle 2', /\S/, ['ref:YesNoPreQuoteHaveFullVinActivity', 'ref:GiveOtherVehicleType', 'ref:GiveGrossVehicleWeight']],
  ['Vehicles: trailer 1', /trailer/, ['ref:GiveOtherVehicleType']],
  ['Quote & Coverages', /\S/, ['cov:medical payments med', 'ref:GiveMtcRequireCoverageForBusinessDocumentYesNo']],
];
const STOP_STEPS = Object.keys(geico.stopSteps ?? {});

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
// The fixture is one file: anything it asks of a server is refused (and counted).
const refused = [];
await page.route(/^(https?|wss?):/i, (r) => { refused.push(r.request().url()); return r.abort(); });
await page.goto(pathToFileURL(path.join(root, 'test/fixtures/geico/quote.html')).href);
await page.waitForFunction(() => window.__geicoMock?.view === 'business-class');

// The extension's world: one isolated world for the kit and the recorder. The recorder's messages
// to the panel are kept here (a stand-in for chrome.runtime), and the panel's pause / resume are
// sent to it the same way.
const cdp = await page.context().newCDPSession(page);
const { frameTree } = await cdp.send('Page.getFrameTree');
const { executionContextId: world } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'TNI Rater Autofill (mock)' });
async function inWorld(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, contextId: world, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`in the extension's world: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
await inWorld(`globalThis.chrome = { runtime: { id: 'geico-mock', sent: [],
  sendMessage(msg) { this.sent.push(msg); return Promise.resolve(); },
  onMessage: { listeners: new Set(), addListener(f) { this.listeners.add(f); }, removeListener(f) { this.listeners.delete(f); } } } }; true`);
await inWorld(KIT);
await inWorld(RECORDER);
const tellRecorder = (cmd) => inWorld(`for (const f of chrome.runtime.onMessage.listeners) f({ ra: 'recorder', cmd: ${JSON.stringify(cmd)} }); true`);
const mock = () => page.evaluate(() => { const m = window.__geicoMock; return { view: m.view, step: m.step, log: m.log, stopActions: m.stopActions, units: m.units, recalcs: m.recalcs, premium: m.premium }; });
const values = () => page.evaluate(() => window.__geicoMock.values());

// --- The side panel ----------------------------------------------------------------------------------
// The picker's vehicle, driver and trailer; the forms each was filled on (state.unitForms); the form the
// latest fill ended on (state.unitShown); the step the panel last heard the tab was on (tabStep); the
// agent's edits per scope (changeScopes, editScope); helpers clicked on this quote. Scopes are the
// panel's own strings, on GEICO's one address.
const PAGE = '/quote';
const active = { vehicles: 0, drivers: 0, trailers: 0 };
const unitForms = { vehicles: {}, drivers: {}, trailers: {} };
// The unit form the latest fill ended on, held (the one the agent has to look at) or else filled, with
// its step: { step, list, id, held }, or null once a fill that read a unit step shows none (rememberFill).
let unitShown = null;
let tabStep;
const agentKeys = new Map();
const doneActions = new Set();
// The steps continued from (state.doneSteps, rememberFill), per form and button (advanceKey).
const doneSteps = [];
const stepList = (step) => (geico.vehicleSteps.includes(step) ? 'vehicles' : geico.driverSteps.includes(step) ? 'drivers' : null);
// One vehicle's (trailer's, driver's) edits (sidepanel.js unitScope): `|v<i>`, `|tr<j>`, `|d<k>`.
const unitScope = (list, index) => `${PAGE}|${{ vehicles: 'v', trailers: 'tr', drivers: 'd' }[list]}${index ?? 0}`;
// Where an edit during a fill is kept (sidepanel.js editScope for GEICO, whose steps and forms share
// field names): per step; on a unit step per form, the one the latest fill ended on there: its own
// while held (`|f:<id>`), else its unit's; with none there (the owner check), the step's; before a
// fill read the step, the step's unit. No step known: the page. Also the guess for a change sent with
// no forms known (changeScopes).
function editScope(step, shown = unitShown) {
  if (!step) return PAGE;
  const list = stepList(step);
  if (!list) return `${PAGE}|s:${step}`;
  const here = shown?.step === step ? shown : null;
  if (here?.held) return `${PAGE}|f:${here.id}`;
  if (here && !here.list) return `${PAGE}|s:${step}`;
  const unit = here?.list ?? list;
  return unitScope(unit, active[unit]);
}
// Where the recorder's changes are filed (sidepanel.js changeScopes, the panel's field_changes): on a
// unit step by the unit forms on screen as the recorder saw them with the changes (`forms`, pagekit
// unitFormsNow), so also a form no fill has read yet (a trailer form just opened): each form's own
// (`|f:<id>`), and its unit's too unless the kit would hold the form (bound to another unit, or new
// while the active unit was filled on another: pagekit unitFormsOf). None on screen (the owner check,
// the chooser, a list): the step's. Forms not known: editScope's guess. Other steps: the step's; no
// step: the page.
function changeScopes(step, forms) {
  if (!step) return [PAGE];
  const list = stepList(step);
  if (!list) return [`${PAGE}|s:${step}`];
  if (!Array.isArray(forms)) return [editScope(step)];
  const shown = forms.filter((u) => ['vehicles', 'drivers', 'trailers'].includes(u?.list) && typeof u.id === 'string' && u.id);
  if (!shown.length) return [`${PAGE}|s:${step}`];
  const scopes = new Set();
  for (const { list: unit, id } of shown) {
    const bound = unitForms[unit] ?? {};
    const index = active[unit] ?? 0;
    const boundTo = Object.hasOwn(bound, id) ? bound[id] : null;
    const activeForm = Object.keys(bound).find((k) => bound[k] === index) ?? null;
    const held = (boundTo != null && boundTo !== index) || (boundTo == null && activeForm != null && activeForm !== id);
    scopes.add(`${PAGE}|f:${id}`);
    if (!held) scopes.add(unitScope(unit, index));
  }
  return [...scopes];
}
const keysIn = (scope) => agentKeys.get(scope) ?? agentKeys.set(scope, new Set()).get(scope);
const keysOf = (scope) => [...(agentKeys.get(scope) ?? [])];
// The fill's `skip` (fillSkip): the page's own keys only, edits made where no step was read. The rest
// go by where they were made (fillSkipBy), for the kit to leave alone on that step or form only.
function skipBy() {
  const steps = {}, forms = {};
  for (const [scope, keys] of agentKeys) {
    const rest = scope.startsWith(`${PAGE}|`) ? scope.slice(PAGE.length + 1) : '';
    if (rest.startsWith('s:')) steps[rest.slice(2)] = [...keys];
    if (rest.startsWith('f:')) forms[rest.slice(2)] = [...keys];
  }
  return {
    steps,
    units: Object.fromEntries(['vehicles', 'trailers', 'drivers'].map((list) => [list, keysOf(unitScope(list, active[list]))])),
    forms,
    stepUnits: Object.fromEntries([...geico.vehicleSteps.map((s) => [s, 'vehicles']), ...geico.driverSteps.map((s) => [s, 'drivers'])]),
  };
}
// The unit the fill adds (sidepanel.js pickUnitToAdd, chosen by the same src/units.js unitToAdd), with
// the picker moved to it when no unit form is on screen. `click` with "Click Continue when the page
// is done" on (settings.autoAdvance, read as the kit is called).
const settings = { autoAdvance: true };
// The list on screen holds every intake unit (unitToAdd `complete`): its Looks Good is the fill's
// Continue (advanceFor).
let unitsListed = false;
async function pickUnitToAdd() {
  unitsListed = false;
  const specs = unitListSpecs(geico, record);
  const seen = await inWorld(`(() => { const kit = globalThis.__raterKit; const specs = ${JSON.stringify(specs.map(({ selector, items }) => ({ selector, items })))};
    return { step: kit.step(), forms: kit.unitFormsNow(), lists: specs.map((s) => kit.unitList(s.selector, s.items)) }; })()`);
  const next = unitToAdd(geico, record, knownStep(geico, seen.step), seen, { unitForms, done: doneActions });
  next?.marks.forEach((id) => doneActions.add(id));
  unitsListed = !!next?.complete;
  if (!next?.adding) return null;
  const { list, index } = next.adding;
  if (next.move && active[list] !== index) {
    active[list] = index;
    lines.push(`  (the panel moved to ${list.slice(0, -1)} ${index + 1}: the next to add)`);
  }
  return { list, index, click: settings.autoAdvance };
}

// Picking unit `index` of `list` (renderPickers / releaseUnitForms): only the forms bound to it are let
// go. The form on the page stays the unit's it was filled for: picking the next vehicle before saving
// this one must not type the next vehicle into it.
function pick(list, index) {
  for (const id of Object.keys(unitForms[list])) if (unitForms[list][id] === index) delete unitForms[list][id];
  active[list] = index;
  lines.push(`  (agent picked ${list.slice(0, -1)} ${index + 1} in the panel)`);
}
// What the recorder said since last asked: the step it read, when it is one of GEICO's, is the tab's
// (noteStep); the agent's edits become protected keys where they were made, on that step or else the
// tab's, by the unit forms it saw on screen with them (the panel's field_changes, changeScopes); new
// questions start a follow-up fill. Once a fill has given the kit its plan's unit forms, the agent's
// changes come with the forms on screen ([] for none): in this world the recorder reads them from the
// kit (the first batch without is a failure).
let formless = false;
async function heard() {
  const sent = await inWorld('chrome.runtime.sent.splice(0)');
  let appeared = false;
  for (const m of sent) {
    const step = ['field_changes', 'new_fields', 'page_view', 'step_shown'].includes(m.event) ? knownStep(geico, m.step) : undefined;
    if (step) tabStep = step;
    const byAgent = m.event === 'field_changes' ? m.changes.filter((x) => x.agent) : [];
    if (byAgent.length && fills.length && !Array.isArray(m.forms) && !formless) {
      formless = true;
      fail(`the recorder sent the agent's changes (${byAgent.map((c) => c.key).join(', ')}) without the unit forms on screen (${JSON.stringify(m.forms)}): the panel can only guess their form`);
    }
    if (byAgent.length) for (const scope of changeScopes(step ?? tabStep, m.forms)) for (const c of byAgent) keysIn(scope).add(c.key);
    if (m.event === 'new_fields') appeared = true;
  }
  return { appeared, sent };
}
const poll = async () => { await inWorld('globalThis.__raterRecorder.poll(); true'); return heard(); };

const lines = [];
const failures = [];
const fail = (msg) => failures.push(msg);
const fills = [];
const needsSeen = new Map();
const filledKeys = new Set();
const left = {};
let run = 0;
let totalMs = 0;

// One fill of the page as the panel starts it (fillPage): the recorder paused, the plan for the
// picker's units, the options of sidepanel.js fillOptions for GEICO, then rememberFill's bookkeeping.
async function fill(form) {
  await poll();
  const step = await inWorld('__raterKit.step()');
  const shown = (await mock()).step;
  if (step !== shown) fail(`${form}: the kit reads the step as ${JSON.stringify(step)} while the page is on ${shown}`);
  // The list may have moved the picker to the unit the fill adds.
  const adding = await pickUnitToAdd();
  const fillActive = { ...active };
  const plan = buildPlan(record, geico, adding ? { ...fillActive, adding } : fillActive);
  const options = {
    overwrite: false, replaceChoices: !!geico.replaceChoices, batch: !!geico.batch, doneSteps: [...doneSteps],
    advance: settings.autoAdvance && geico.advance ? advanceFor(geico, unitsListed) : null, hold: false, confirmed: null,
    doneActions: [...doneActions], visitedPages: [], stopPages: Object.keys(geico.stopPages ?? {}), stopSteps: STOP_STEPS,
    units: {
      active: { ...active },
      count: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, record[list]?.length ?? 0])),
      bound: Object.fromEntries(['vehicles', 'drivers', 'trailers'].map((list) => [list, { ...unitForms[list] }])),
    },
    skip: keysOf(PAGE), skipBy: skipBy(), run: ++run,
    takenBack: geico.keepTakenBack?.length ? { steps: geico.keepTakenBack, keys: Object.fromEntries([...filledKeys].map((key) => [key, true])) } : null,
  };
  await tellRecorder('pause');
  const t0 = Date.now();
  const report = await inWorld(`__raterKit.fill(${JSON.stringify(plan)}, ${JSON.stringify(options)})`);
  const ms = Date.now() - t0;
  totalMs += ms;
  // Its Continue: the view it leads to drawn before anything else (the panel waits for the page to change).
  if (report.advanced) {
    doneSteps.push(report.advanceKey ?? report.stepKey);
    await page.waitForFunction((text) => {
      const log = window.__geicoMock.log;
      const at = log.findLastIndex((e) => e.type === 'click' && e.target === 'button' && !e.isTrusted && e.text === text);
      return at >= 0 && log.slice(at + 1).some((e) => e.type === 'view');
    }, report.advanced, { timeout: 15000 }).catch(() => fail(`${form}: the fill clicked ${report.advanced} and no view followed`));
    await settled();
  }
  await tellRecorder('resume');
  await heard();
  // rememberFill: the form the page shows now (held wins over filled; a unit step that shows none,
  // when the fill read it, had its form closed), then the agent's edits during the fill, under the
  // step the fill read and that form; a step it couldn't read, the page's.
  const unitOk = (u) => ['vehicles', 'drivers', 'trailers'].includes(u?.list) && typeof u.id === 'string' && u.id;
  const reportStep = knownStep(geico, report.stepKey);
  const now = unitOk(report.unitHeld) ? report.unitHeld : unitOk(report.unitForm) ? report.unitForm : null;
  if (now) unitShown = { step: reportStep, list: now.list, id: now.id, held: now === report.unitHeld };
  else if (stepList(reportStep) && report.fields > 0) unitShown = { step: reportStep, list: null, id: null, held: false };
  for (const key of report.protectedKeys ?? []) keysIn(editScope(reportStep ?? null)).add(key);
  for (const id of report.invalidatedActions ?? []) doneActions.delete(id);
  for (const x of report.filled) filledKeys.add(x.key);
  for (const a of report.actions ?? []) doneActions.add(a.id);
  // The form it answered is the plan's unit's now, and so are the edits filed under the form itself
  // (made while it was held, or before a fill had read it): GEICO draws a new form when the agent
  // opens a saved unit again.
  if (unitOk(report.unitForm)) {
    const { list, id } = report.unitForm;
    unitForms[list][id] = fillActive[list];
    for (const key of keysOf(`${PAGE}|f:${id}`)) keysIn(unitScope(list, fillActive[list])).add(key);
  }
  // renderReport: the fill's step is the tab's.
  if (reportStep) tabStep = reportStep;
  fills.push({ form, report });
  // What it did, compactly: what it filled, and what it left for the agent that it hadn't before on
  // this form (the same needs-you items come back on every fill of a form).
  const seen = needsSeen.get(form) ?? new Map();
  const fresh = (report.noData ?? []).filter((x) => !x.key || !seen.has(x.key));
  for (const x of fresh) if (x.key) seen.set(x.key, x.note ?? '');
  needsSeen.set(form, seen);
  const named = (items) => items.map((x) => String(x.label ?? x.name ?? x.key).replace(/\s+/g, ' ').slice(0, 60) + (x.reason ? ` (${x.reason})` : '')).join(' · ');
  lines.push(`## ${form} · ${step || 'no step'} · ${(ms / 1000).toFixed(1)} s, ${report.rounds} rounds · filled ${report.filled.length}${report.filled.length ? `: ${named(report.filled)}` : ''}`);
  if (fresh.length) lines.push(`  needs you: ${named(fresh)}`);
  for (const k of ['failed', 'unknown', 'leftRequired', 'checks']) if (report[k]?.length) lines.push(`  ${k}: ${named(report[k])}`);
  if (report.actions?.length) lines.push(`  clicked: ${report.actions.map((a) => a.text).join(' · ')}`);
  if (report.blocked?.length) lines.push(`  waiting: ${report.blocked.map((b) => `${b.id} (${b.why})`).join(' · ')}`);
  if (report.unitHeld) lines.push(`  held: this ${report.unitHeld.list.slice(0, -1)} form may be another unit's`);
  if (report.advanced) lines.push(`  → ${report.advanced}`);
  if (report.halted) lines.push(`  halted: ${report.reason}`);
  for (const x of report.unknown ?? []) fail(`${form}: unfamiliar question "${x.label}" (${x.key}): left for the agent and offered to the AI assistant`);
  for (const x of report.failed ?? []) fail(`${form}: failed "${x.label}" (${x.key}): ${x.reason}`);
  return report;
}

// Fills again while the page shows more (the panel's follow-up fills, on the recorder's new
// questions): an answer that draws the next question, a list loading after the one before. A fill
// that continued left the form.
async function fillAll(form, max = 5) {
  let report;
  for (let i = 0; i < max; i++) {
    report = await fill(form);
    if (report.advanced) break;
    await page.waitForTimeout(700);
    const { appeared } = await poll();
    if (!report.filled.length && !report.actions?.length && !appeared) break;
  }
  return report;
}

// The panel's follow-ups on a step that takes them only for questions it draws (Quote & Coverages:
// newQuestionsOnlySteps): filled again while the page shows new questions, never for an answer alone.
async function fillDrawn(form, max = 5) {
  let report;
  for (let i = 0; i < max; i++) {
    report = await fill(form);
    await page.waitForTimeout(700);
    const { appeared } = await poll();
    if (!appeared) break;
  }
  return report;
}

// --- The agent ---------------------------------------------------------------------------------------
// Real clicks and keys (trusted events), as the agent's own: GEICO's buttons, radios, add icons.
const visible = (sel) => page.locator(sel).filter({ visible: true }).first();
async function settled() {
  await page.waitForTimeout(250);
  await page.waitForFunction(() => !window.__geicoMock || (getComputedStyle(document.getElementById('page-load')).display === 'none'
    && getComputedStyle(document.getElementById('extendedWaiting')).display === 'none'));
}
const agent = {
  async press(text) {
    await page.locator('gds-button').filter({ hasText: new RegExp(`^\\s*${text}\\s*$`, 'i') }).filter({ visible: true }).first().click();
    lines.push(`  (agent pressed ${text})`);
  },
  // Next (or Save and Continue, Looks Good) and the view it leads to.
  async go(text, view) {
    const from = (await mock()).view;
    await this.press(text);
    await page.waitForFunction(([from, view]) => window.__geicoMock.view === view && window.__geicoMock.view !== from, [from, view], { timeout: 15000 });
    await settled();
    await poll();
  },
  async radio(stem, value) {
    await visible(`gds-radio-button[name^="Id_${stem}_"][value="${value}"]`).click();
    await settled();
    await poll();
    lines.push(`  (agent answered ${stem}: ${value})`);
  },
  async text(stem, value) {
    const box = visible(`input[name^="Id_${stem}_"], input[id^="Id_${stem}_"]`);
    await box.fill(value);
    await box.press('Tab');
    await settled();
    await poll();
    lines.push(`  (agent typed ${stem})`);
  },
  // A list picked with the keyboard (a closed list moves with the arrow keys and tells the page).
  async choose(locator, want) {
    await locator.focus();
    for (let i = 0; i < 60; i++) {
      const [now, at, to] = await locator.evaluate((s, w) => [s.selectedOptions[0]?.textContent.trim() ?? '', s.selectedIndex, [...s.options].findIndex((o) => o.textContent.trim() === w && !o.hidden)], want);
      if (now === want) break;
      if (to < 0 || i === 59) throw new Error(`the agent could not pick "${want}"`);
      await page.keyboard.press(to > at ? 'ArrowDown' : 'ArrowUp');
    }
    await page.keyboard.press('Tab');
    await settled();
    await poll();
    lines.push(`  (agent picked "${want}")`);
  },
  async click(selector, what) {
    await visible(selector).click();
    await settled();
    await poll();
    lines.push(`  (agent clicked ${what})`);
  },
  // A select2 list taking several picks (the commodities): its open list was never captured, so the
  // picks are set as select2 sets them, by script (not a trusted edit: the recorder won't call it
  // the agent's).
  async pickList(stem, texts) {
    await page.evaluate(([stem, texts]) => {
      const sel = [...document.querySelectorAll('#salesForm select')].find((x) => (x.name || x.id).startsWith(`Id_${stem}_`));
      for (const o of sel.options) o.selected = texts.includes(o.textContent.trim());
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, [stem, texts]);
    await settled();
    await poll();
    lines.push(`  (agent picked ${texts.length} of ${stem})`);
  },
  // An add-on of Quote & Coverages opened (its edit icon), unless it is open: a redraw (Recalculate)
  // draws them closed.
  async open(item, what) {
    if (await page.locator(`${item}.expanded`).count()) return;
    await this.click(`${item} [data-testid="editIcon"]`, what);
  },
};
// A coverage list (no data-model name, a new id on every render) by its caption.
async function coverage(caption) {
  const id = await page.evaluate((caption) => [...document.querySelectorAll('#salesForm [for]')]
    .find((l) => (l.querySelector('span')?.textContent ?? l.textContent).replace(/\s+/g, ' ').trim() === caption)?.getAttribute('for'), caption);
  if (!id) throw new Error(`no coverage list "${caption}"`);
  return page.locator(`select[id="${id}"]`);
}

async function leave(form) { left[form] = await values(); }
// The fill's Continue (geico.advance, with the setting on), once nothing on the form is the agent's:
// the form as it was left (the mock's `saved`), and the view it led to. A fill that didn't is a
// failure, and the agent clicks it instead.
async function continued(form, text, view) {
  const last = fills.filter((f) => f.form === form).at(-1)?.report;
  if (last?.advanced === text) {
    left[form] = (await page.evaluate(() => window.__geicoMock.saved.at(-1)))?.values ?? {};
    if ((await mock()).view !== view) fail(`${form}: the fill's ${text} led to ${(await mock()).view}, not ${view}`);
    return;
  }
  fail(`${form}: the fill did not click ${text} with nothing left for the agent (${last?.advanced ? `it clicked ${last.advanced}` : last?.blockers?.join('; ') || 'nothing held it'})`);
  await leave(form);
  await agent.go(text, view);
}
const same = (want, got) => (want instanceof RegExp ? want.test(String(got ?? '')) : String(got ?? '') === String(want));
// An agent's correction: theirs once the recorder reported it (the panel then protects its key where
// it was made: `scope`, by default each scope a change made now is filed under, this step's or this
// form's and its unit's), and still on the form after the page redrew with new numbers, or the form
// was filled again.
async function corrected(form, key, name, want, scope = null) {
  const scopes = scope ? [scope] : changeScopes(knownStep(geico, await inWorld('__raterKit.step()')), await inWorld('__raterKit.unitFormsNow()'));
  for (const s of scopes) if (!agentKeys.get(s)?.has(key)) fail(`${form}: the recorder did not report the agent's change of ${name} as theirs (${key}), or the panel kept it elsewhere than ${s}`);
  const got = (await values())[name];
  if (!same(want, got)) fail(`${form}: the agent's ${name} (${JSON.stringify(want)}) was overwritten by a later fill: ${JSON.stringify(got)}`);
}
const formIdOf = (list) => Object.keys(unitForms[list]).find((id) => unitForms[list][id] === active[list]) ?? null;

// --- The quote -----------------------------------------------------------------------------------------
// The agent's run through the quote, step by step. A step that goes wrong stops it: what was
// seen so far is still checked and reported.
let firstForm = null;
const filledOn = (form, key) => fills.some((f) => f.form === form && f.report.filled.some((x) => x.key === key));
async function scenario() {
  // Business Class & USDOT: filled; the agent changes team driving, the page redraws (new render
  // numbers, as after a validation reload), and the next fill leaves the agent's answer.
  await fillAll('Business Class & USDOT');
  await agent.radio('TeamDrivingOrSlipSeatingYesNo', 'Yes');
  await page.evaluate(() => window.__geicoMock.redraw());
  await settled();
  await fillAll('Business Class & USDOT');
  await corrected('Business Class & USDOT', 'ref:TeamDrivingOrSlipSeatingYesNo', 'TeamDrivingOrSlipSeatingYesNo', 'Yes');
  await leave('Business Class & USDOT');
  await agent.go('Next', 'business-owner');

  // Business & Owner Info: the fill types the intake's address and picks GEICO's suggestion for it
  // (FL live run 3, 2026-10-21); the agent corrects the email and the owner's last name; a redraw,
  // and a fill again. The last name is kept on this step, and on the owner check, which asks it
  // again: Add Driver asks each driver's by the same name (both checked below).
  await fillAll('Business & Owner Info');
  if (!filledOn('Business & Owner Info', 'ref:GiveStreet')) fail('Business & Owner Info: the street was not filled with GEICO\'s suggestion for the intake\'s address');
  await agent.text('GiveEmail', 'owner@example.test');
  await agent.text('GiveLastName', 'DRIVERS');
  await page.evaluate(() => window.__geicoMock.redraw());
  await settled();
  await fillAll('Business & Owner Info');
  await corrected('Business & Owner Info', 'ref:GiveEmail', 'GiveEmail', 'owner@example.test');
  await corrected('Business & Owner Info', 'ref:GiveLastName', 'GiveLastName', 'DRIVERS');
  await leave('Business & Owner Info');
  await agent.go('Next', 'owner-verification');

  // The owner's check with their Social Security number (under the title of Vehicles, no unit form on
  // screen): Business & Owner Info's questions again, where the agent's edits on any step apply, so
  // the owner's last name the agent corrected isn't typed over with the intake's.
  await fillAll('Vehicles: owner check');
  await leave('Vehicles: owner check');
  await agent.go('Next', 'vehicle-form');

  // The first vehicle's form, for the picker's vehicle 1.
  await fillAll('Vehicles: vehicle 1');
  firstForm = formIdOf('vehicles');
  await leave('Vehicles: vehicle 1');
  await agent.go('Next', 'vehicle-list');

  // The vehicle list, vehicle 2 not on the quote: with "Click Continue when the page is done" on, the
  // fill adds it (TNI, FL live run 2026-10-21: "click + and add the new vehicle", "click Next after
  // choosing Vehicle or Trailer"): the panel moves to vehicle 2, the fill clicks the list's "+",
  // answers Vehicle on the chooser, clicks its Next, and fills the form that opens, for vehicle 2.
  const added = await fill('Vehicles: vehicle 2');
  const addedIds = (added.actions ?? []).map((a) => a.id);
  if (!['addVehicle:1', 'chooseVehicle:1'].every((id) => addedIds.includes(id))) fail(`Vehicles: the fill did not add vehicle 2 itself (clicked: ${addedIds.join(', ') || 'nothing'})`);
  if ((await mock()).view !== 'vehicle-form') fail(`Vehicles: after the fill on the list the page shows ${(await mock()).view}, not vehicle 2's form`);
  if (active.vehicles !== 1 || added.unitForm?.list !== 'vehicles' || unitForms.vehicles[added.unitForm.id] !== 1) fail('Vehicles: the form the fill opened was not filled for vehicle 2');
  await fillAll('Vehicles: vehicle 2');

  // The agent picks vehicle 1 in the panel while vehicle 2's form is up: held, nothing typed into it.
  pick('vehicles', 0);
  const beforeHeld = await values();
  const held = await fill('Vehicles: vehicle 2 (picker on vehicle 1)');
  const afterHeld = await values();
  if (held.unitHeld?.list !== 'vehicles') fail('Vehicles: the second vehicle\'s form was not held while the picker said vehicle 1');
  if (held.filled.length) fail(`Vehicles: vehicle 1's answers went into the second vehicle's form: ${held.filled.map((x) => x.label).join(', ')}`);
  for (const k of Object.keys(beforeHeld)) if (beforeHeld[k] !== afterHeld[k]) fail(`Vehicles: ${k} changed on the held form (${JSON.stringify(beforeHeld[k])} -> ${JSON.stringify(afterHeld[k])})`);
  if (!held.checks?.some((x) => /vehicle 1\b/.test(x.note ?? '') && !/[A-HJ-NPR-Z0-9]{17}/.test(x.note ?? ''))) fail('Vehicles: the held form has no check naming vehicle 1 by its place');
  // The agent answers a question on the held form before picking its vehicle (the distance, theirs):
  // kept with that form (`|f:<id>`), not with the picker's vehicle 1, so the fill after the pick, which
  // replaces GEICO's pre-selected answers, leaves it.
  const heldForm = held.unitHeld?.id ?? null;
  await agent.choose(page.locator('#salesForm select[id^="Id_GiveFarthestOneWayDistance_"]').first(), '201-300');
  pick('vehicles', 1);
  await fillAll('Vehicles: vehicle 2');
  await corrected('Vehicles: vehicle 2', 'ref:GiveFarthestOneWayDistance', 'GiveFarthestOneWayDistance', '201-300', `${PAGE}|f:${heldForm}`);
  await agent.radio('YesNoPreQuoteHaveFullVinActivity', 'No');
  await fillAll('Vehicles: vehicle 2');
  // The agent corrects the year (the intake has 2021): the page empties make and model, which the next
  // fill gives again. Then they pick its type (the intake's words are quoted in its note). Both are
  // vehicle 2's (its form's and `|v1`): the trailer form asks both by the same names, and they keep
  // nothing there from the fill (checked below).
  await agent.choose(page.locator('#salesForm select[id^="Id_GiveYear_"]').first(), '2022');
  await fillAll('Vehicles: vehicle 2');
  await corrected('Vehicles: vehicle 2', 'ref:GiveYear', 'GiveYear', '2022');
  await agent.choose(page.locator('#salesForm select[id^="Id_GiveOtherVehicleType_"]').first(), 'Box/Straight Truck');
  await fillAll('Vehicles: vehicle 2');
  await corrected('Vehicles: vehicle 2', 'ref:GiveOtherVehicleType', 'GiveOtherVehicleType', 'Box/Straight Truck');
  await leave('Vehicles: vehicle 2');
  await agent.go('Next', 'vehicle-list');

  // The trailer, with "Click Continue when the page is done" off: the fill on the list clicks nothing;
  // the agent clicks "+", the fill answers Trailer on the chooser (the next intake unit), and the agent
  // clicks Next. They pick the trailer's year (2016; the intake has 2015) as soon as the form opens,
  // before any fill has read it: the recorder names the trailer form with the change, so it is kept
  // with that form and trailer 1 (`|f:<id>`, `|tr0`), and the fill, which replaces GEICO's
  // pre-selected answers, leaves it.
  settings.autoAdvance = false;
  lines.push('  (agent turned "Click Continue when the page is done" off)');
  const listOff = await fill('Vehicles: list');
  if (listOff.actions?.length) fail(`Vehicles: the fill clicked ${listOff.actions.map((a) => a.id).join(', ')} with "Click Continue when the page is done" off`);
  await agent.click('[data-testid="addIcon"]', 'Add Vehicle or Trailer');
  const chose = await fill('Vehicles: or trailer');
  if ((await values()).GiveVehicleOrTrailer !== 'No') fail(`Vehicles: the chooser was not answered Trailer for the trailer (${JSON.stringify((await values()).GiveVehicleOrTrailer)})`);
  if (chose.actions?.length || (await mock()).view !== 'vehicle-or-trailer') fail('Vehicles: the chooser\'s Next was clicked with "Click Continue when the page is done" off');
  await agent.go('Next', 'trailer-form');
  await agent.choose(page.locator('#salesForm select[id^="Id_GiveYear_"]').first(), '2016');
  await fillAll('Vehicles: trailer 1');
  await corrected('Vehicles: trailer 1', 'ref:GiveYear', 'GiveYear', '2016');
  await leave('Vehicles: trailer 1');
  await agent.go('Next', 'vehicle-list');
  // Every intake unit on the list, the setting back on: nothing more is added, and the fill clicks
  // Looks Good (TNI, FL live run 3, 2026-10-21).
  settings.autoAdvance = true;
  lines.push('  (agent turned "Click Continue when the page is done" on)');
  const listFull = await fill('Vehicles: list');
  if (listFull.actions?.length) fail(`Vehicles: the fill clicked ${listFull.actions.map((a) => a.id).join(', ')} with every intake unit on the list`);
  await continued('Vehicles: list', 'Looks Good', 'owner-driver');

  // Drivers & Incidents: the owner's form (GEICO adds it: the owner drives), nothing on it the agent's:
  // the fill clicks its Next. Then the driver list, where the fill adds driver 2 itself (the owner,
  // driver 1, GEICO lists): the panel moves to driver 2, the fill clicks the driver list's "+" (not the
  // incidents'), fills Add Driver for them and, nothing left, clicks Save and Continue. On the list
  // with both drivers, the fill clicks Looks Good.
  await fillAll('Drivers & Incidents: owner');
  await continued('Drivers & Incidents: owner', 'Next', 'driver-list');
  const addedDriver = await fillAll('Drivers & Incidents: driver 2');
  const driverAdds = fills.filter((f) => f.form === 'Drivers & Incidents: driver 2').flatMap((f) => f.report.actions ?? []);
  if (!driverAdds.some((a) => a.id === 'addDriver:1')) fail(`Drivers & Incidents: the fill did not add driver 2 itself (clicked: ${driverAdds.map((a) => a.id).join(', ') || 'nothing'})`);
  if (active.drivers !== 1) fail('Drivers & Incidents: the panel did not move to driver 2');
  if (!addedDriver.unitForm || unitForms.drivers[addedDriver.unitForm.id] !== 1) fail('Drivers & Incidents: Add Driver was not filled for driver 2');
  await continued('Drivers & Incidents: driver 2', 'Save and Continue', 'driver-list');
  const driversFull = await fill('Drivers & Incidents: list');
  if (driversFull.actions?.length) fail(`Drivers & Incidents: the fill clicked ${driversFull.actions.map((a) => a.id).join(', ')} with every intake driver on the list`);
  await continued('Drivers & Incidents: list', 'Looks Good', 'business-info');

  // Additional Business Info: nothing on it the agent's; the fill clicks Next, the last step it does.
  await fillAll('Additional Business Info');
  await continued('Additional Business Info', 'Next', 'quote');

  // Quote & Coverages: the fill runs when the step opens and again only for questions it draws
  // (geico.newQuestionsOnlySteps: fillDrawn), never after an answer alone. It opens Motor Truck Cargo
  // (a collapsed card; the intake asks for cargo: W43-16), and each cargo question that draws the next
  // gets the panel's follow-up. Collision's deductibles show a moment after comprehensive is chosen
  // (FL live run 2, 2026-10-21), and the fill waits for them. The fill answers mobile homes No and picks
  // the commodities (W43-23); the agent changes the liability limit, answers household goods and marks
  // the rest done; nothing clicked meanwhile
  // (`whenClear`). Then Fill this page: Recalculate, View More Payment Plans, 11 Payments, Print Quote
  // Proposal, once each (TNI, FL live run 4, 2026-10-21: W43-18), and the agent's limit kept.
  const CARGO = 'li[id^="Id_MtcCoverageQuestionsComboActivityData_"]';
  await fillDrawn('Quote & Coverages');
  if (!doneActions.has('openCargo')) fail('Quote & Coverages: the fill did not open Motor Truck Cargo');
  await agent.choose(await coverage('Bodily Injury or Combined Single Limit Liability'), '$750,000 Combined Single Limit');
  await agent.open(CARGO, 'Motor Truck Cargo');
  await agent.radio('GiveMtcRequireCoverageForBusinessDocumentYesNo', 'No');
  await fillDrawn('Quote & Coverages');
  const early = fills.filter((x) => x.form === 'Quote & Coverages').flatMap((f) => f.report.actions ?? []).filter((a) => a.id !== 'openCargo');
  if (early.length) fail(`Quote & Coverages: a fill clicked ${early.map((a) => a.text).join(', ')} with questions left for the agent`);
  if ((await mock()).recalcs) fail('Quote & Coverages: Recalculate was clicked with questions left for the agent');
  // What is left and stays as GEICO has it: marked done (sidepanel markDone: the step's agent keys).
  const leftKeys = [...(needsSeen.get('Quote & Coverages')?.keys() ?? [])];
  for (const key of leftKeys) keysIn(`${PAGE}|s:Quote & Coverages`).add(key);
  lines.push(`  (agent marked ${leftKeys.length} item(s) done)`);
  const done = await fill('Quote & Coverages');
  await page.waitForTimeout(700);
  await settled();
  await poll();
  // Recalculate leaves the report's actions once a later answer (the pay plan) re-arms it; the page's
  // own count says it ran, once (the click checks below say by whom).
  const clickedIds = done.actions?.map((a) => a.id) ?? [];
  if (JSON.stringify(clickedIds) !== JSON.stringify(['morePayPlans', 'printProposal'])) fail(`Quote & Coverages: the fill clicked [${clickedIds.join(', ')}], expected [morePayPlans, printProposal] after Recalculate`);
  if ((await mock()).recalcs !== 1) fail(`Quote & Coverages: Recalculate ran ${(await mock()).recalcs} time(s), expected once`);
  if (!(await mock()).premium) fail('Quote & Coverages: the fill\'s Recalculate left the premium out of date');
  if ((await values())['GivePayPlanV2#2'] !== 'GEICO_PP_11Pay') fail(`Quote & Coverages: the pay plan is ${JSON.stringify((await values())['GivePayPlanV2#2'])}, not 11 Payments`);
  const after = await fill('Quote & Coverages');
  await corrected('Quote & Coverages', 'cov:bodily injury or combined single limit liability', 'cov:Bodily Injury or Combined Single Limit Liability', '$750,000 Combined Single Limit');
  if (after.filled.length || after.actions?.length) fail(`Quote & Coverages: the fill after Print changed ${after.filled.map((x) => x.label).join('; ')} / clicked ${(after.actions ?? []).map((a) => a.text).join(', ')}`);
  if (!(await mock()).premium) fail('Quote & Coverages: the fill after Print put the premium out of date');
  await leave('Quote & Coverages');
  await agent.go('Next', 'final-quote-details');

  // The stop steps: nothing filled or clicked there by a fill, nor put in by an AI answer the agent
  // accepted (answer(), as the panel calls it); the agent's Next moves on.
  for (const [form, next] of [['Final Quote Details', 'mvr-and-clue'], ['MVR & CLUE', 'payment-information'], ['Payment Information', null]]) {
    const report = await fill(form);
    if (!report.halted || report.stopStep !== form) fail(`${form}: the fill did not stop on the step (${report.reason ?? 'not halted'})`);
    if (report.filled.length || report.actions?.length) fail(`${form}: filled or clicked on a stop step`);
    const label = await inWorld('__raterKit.capture().controls[0]?.label ?? null');
    const applied = await inWorld(`__raterKit.answer([{ key: 'ref:MockPlaceholderQuestion', label: ${JSON.stringify(label)}, value: 'SAMPLE' }], null, null)`);
    if (applied.some((x) => x.ok)) fail(`${form}: an AI answer was put in on a stop step`);
    if ((await values()).MockPlaceholderQuestion) fail(`${form}: the step's question was filled`);
    if (next) await agent.go('Next', next);
  }
}
try {
  await scenario();
} catch (e) {
  fail(`the run stopped: ${String(e.message).split('\n')[0]}`);
}

// --- Checks --------------------------------------------------------------------------------------------
const final = await mock();
let answers = 0;
const wrong = [];
for (const [form, want] of Object.entries(EXPECT)) {
  const got = left[form];
  if (!got) { fail(`${form}: never reached`); continue; }
  for (const [key, w] of Object.entries(want)) {
    answers++;
    if (!(key in got)) wrong.push(`${form}: ${key} not on the form`);
    else if (!same(w, got[key])) wrong.push(`${form}: ${key} expected ${w instanceof RegExp ? w : JSON.stringify(w)}, got ${JSON.stringify(got[key])}`);
  }
}
for (const w of wrong) fail(w);
for (const [form, says, keys] of NEEDS_YOU) {
  const seen = needsSeen.get(form) ?? new Map();
  for (const key of keys) {
    if (!seen.has(key)) fail(`${form}: ${key} was not left for the agent (needs you)`);
    else if (!says.test(seen.get(key) ?? '')) fail(`${form}: ${key} is left for the agent with the note ${JSON.stringify(seen.get(key))}`);
  }
}
// Each saved unit is its own: vehicle 1's and 2's on their forms, the trailer's on the trailer form,
// and the forms the panel bound are the ones each unit was saved from.
const units = final.units;
const year = (u) => u?.values?.GiveYear;
if (year(units.vehicles[0]) !== '2019' || year(units.vehicles[1]) !== '2022') fail(`Vehicles: saved vehicle years ${JSON.stringify(units.vehicles.map(year))}, expected ["2019","2022"] (the second the agent's)`);
if (year(units.trailers[0]) !== '2016') fail(`Vehicles: saved trailer year ${JSON.stringify(year(units.trailers[0]))}, expected "2016" (the agent's: the intake's typed over it, or a vehicle's answers on the trailer form?)`);
if (units.trailers[0] && 'YesNoPreQuoteHaveFullVinActivity' in units.trailers[0].values) fail('Vehicles: the trailer form holds a vehicle question');
if (units.vehicles.length !== 2 || units.trailers.length !== 1 || units.drivers.length !== 2) fail(`units saved: ${units.vehicles.length} vehicles, ${units.trailers.length} trailers, ${units.drivers.length} drivers (expected 2, 1, 2)`);
if (firstForm && units.vehicles[0]?.form !== firstForm) fail('Vehicles: the form bound to vehicle 1 is not the one vehicle 1 was saved from');
if (unitForms.vehicles[units.vehicles[1]?.form] !== 1) fail('Vehicles: the second vehicle\'s form is not bound to vehicle 2');
if (unitForms.trailers[units.trailers[0]?.form] !== 0) fail('Vehicles: the trailer form is not bound to trailer 1');
// An agent's correction protects its field only where it was made (sidepanel.js changeScopes): the
// owner's last name on Business & Owner Info doesn't keep the added driver's (the same field name)
// from being filled, nor vehicle 2's type (or year) the trailer's type from being left for the agent
// with the trailer's note. Where a step asks another's questions again it does: the owner check on
// Vehicles doesn't type the intake's last name over the agent's correction. (A choice made on a held
// form, kept with that form once the agent picked its vehicle, and the trailer's year picked before
// any fill read its form, are checked by corrected().)
if (left['Drivers & Incidents: driver 2'] && !filledOn('Drivers & Incidents: driver 2', 'ref:GiveDriverRelationshipToBusiness')) fail('Drivers & Incidents: driver 2\'s relationship (Employee, TNI\'s standard) was never filled');
for (const key of ['COMP', 'COLL'].flatMap((c) => [`cov:${c}#1`, `cov:${c}#2`])) if (left['Quote & Coverages'] && !filledOn('Quote & Coverages', key)) fail(`Quote & Coverages: ${key} was never filled with TNI's $1,000 deductible`);
if (left['Drivers & Incidents: driver 2'] && !filledOn('Drivers & Incidents: driver 2', 'ref:GiveLastName')) fail('Drivers & Incidents: driver 2\'s last name was never filled: the agent\'s correction of the owner\'s last name on Business & Owner Info kept the fill from it');
if (left['Vehicles: trailer 1'] && !/trailer/.test(needsSeen.get('Vehicles: trailer 1')?.get('ref:GiveOtherVehicleType') ?? '')) fail('Vehicles: the trailer\'s type was never left for the agent with the trailer\'s note: the agent\'s pick of vehicle 2\'s type kept the fill from it');
const ownerCheck = left['Vehicles: owner check'];
if (ownerCheck && (filledOn('Vehicles: owner check', 'ref:GiveLastName') || ownerCheck.GiveLastName === record.drivers[0].last)) fail(`Vehicles: owner check: the owner's last name was typed with the intake's (${JSON.stringify(ownerCheck.GiveLastName)}): the agent's correction on Business & Owner Info didn't reach the step that asks it again`);
// Clicks the kit made (untrusted): radios and boxes, GEICO's address suggestion on Business & Owner
// Info, once, and for each unit it added (with "Click Continue
// when the page is done" on), once, its list's "+" and, for a vehicle, the chooser's Next: vehicle 2's
// and driver 2's, never the trailer's (added with the setting off). Its Continues, once each, where
// nothing was left for the agent: the owner's driver form, Add Driver, both lists with every intake
// unit, Additional Business Info. On Quote & Coverages, once each: Motor Truck Cargo's chevron,
// Recalculate, View More Payment Plans and Print Quote Proposal (TNI, 2026-10-21). Never another Next,
// Save and Continue or Looks Good, Discard, a progress link, another edit icon or link.
const isAdd = (e) => e.type === 'click' && (e.target === 'addIcon' || (e.target === 'button' && e.text === 'Next' && e.view === 'vehicle-or-trailer'));
const adds = final.log.filter((e) => !e.isTrusted && isAdd(e)).map((e) => `${e.target} on ${e.view}`);
const wantAdds = ['addIcon on vehicle-list', 'button on vehicle-or-trailer', 'addIcon on driver-list'];
if (JSON.stringify(adds) !== JSON.stringify(wantAdds)) fail(`the extension's add clicks were [${adds.join(', ')}], expected [${wantAdds.join(', ')}]`);
const isContinue = (e) => e.type === 'click' && e.target === 'button' && /^(next|save and continue|looks good)$/i.test(e.text ?? '') && !isAdd(e);
const continues = final.log.filter((e) => !e.isTrusted && isContinue(e)).map((e) => `${e.text} on ${e.view}`);
const wantContinues = ['Looks Good on vehicle-list', 'Next on owner-driver', 'Save and Continue on add-driver', 'Looks Good on driver-list', 'Next on business-info'];
if (JSON.stringify(continues) !== JSON.stringify(wantContinues)) fail(`the extension's Continues were [${continues.join(', ')}], expected [${wantContinues.join(', ')}]`);
const picks = final.log.filter((e) => !e.isTrusted && e.type === 'click' && e.target === 'option').map((e) => e.view);
if (JSON.stringify(picks) !== '["business-owner"]') fail(`the extension picked address suggestions on [${picks.join(', ')}], expected [business-owner]`);
const isQuoteHelper = (e) => e.type === 'click' && e.view === 'quote' && (e.target === 'editIcon' || (e.target === 'button' && /^(recalculate|print quote proposal)$/i.test(e.text ?? ''))
  || (e.target === 'link' && /^view more payment plans$/i.test(e.text ?? '')));
const helperClicks = final.log.filter((e) => !e.isTrusted && isQuoteHelper(e)).map((e) => `${e.target}${e.text ? ` ${e.text}` : ''}`);
const wantHelpers = ['editIcon', 'button Recalculate', 'link View More Payment Plans', 'button Print Quote Proposal'];
if (JSON.stringify(helperClicks) !== JSON.stringify(wantHelpers)) fail(`the extension's Quote & Coverages clicks were [${helperClicks.join(', ')}], expected [${wantHelpers.join(', ')}]`);
const kitClicks = final.log.filter((e) => !e.isTrusted && (e.type === 'click' || e.type === 'disabled'))
  .filter((e) => !['radio', 'checkbox', 'option'].includes(e.target) && !isAdd(e) && !isContinue(e) && !isQuoteHelper(e));
for (const e of kitClicks) fail(`the extension clicked ${e.target}${e.text ? ` "${e.text}"` : ''} on ${e.step}`);
for (const e of final.stopActions.filter((x) => !x.isTrusted)) fail(`${e.step}: the extension did ${e.type} on ${e.target} (a stop step)`);
// The Social Security number: never typed, by anyone here.
for (const e of final.log.filter((x) => x.target === 'GiveSocialSecurityNumber' && x.type !== 'view')) fail(`the Social Security number was ${e.type === 'change' ? 'changed' : e.type} (${e.isTrusted ? 'agent' : 'extension'})`);
for (const f of fills) for (const x of f.report.filled) if (x.key === 'ref:GiveSocialSecurityNumber') fail(`${f.form}: the Social Security number was filled`);
if (errors.length) fail(`page errors: ${errors.join(' | ')}`);
if (refused.length) lines.push(`Requests refused: ${refused.length}`);

await browser.close();

const views = final.log.filter((e) => e.type === 'view').map((e) => e.target);
lines.push(`Filling time: ${(totalMs / 1000).toFixed(1)} s over ${fills.length} fills`);
lines.push(`Views: ${views.join(' → ')}`);
lines.push(`Recalculate ×${final.recalcs} (premium ${final.premium ? 'rated' : 'out of date'}) · agent's protected keys: ${[...agentKeys].map(([s, k]) => `${s === PAGE ? 'page' : s.slice(PAGE.length + 1)} ${k.size}`).join(', ')}`);
lines.push('', failures.length ? `${failures.length} problem(s):` : `All ${answers} answers as expected; every needs-you item left for the agent; vehicle 2 and driver 2 added by the extension, once each; continued only where nothing was left for the agent; nothing clicked or filled that is the agent's.`);
for (const f of failures) lines.push(`  ${f}`);
console.log(lines.join('\n'));
process.exit(failures.length ? 1 : 0);
