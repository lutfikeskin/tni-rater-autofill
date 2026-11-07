// Federal filings by name, one reading for every carrier (src/answers/filings.js; TNI, 2026-11-07,
// the maintainer, audit CARR-01: GEICO's stricter reading, shared by the carriers). The same "which
// filings" texts go through GEICO, AmWINS and Progressive, and each carrier's boxes give the same
// answer: a federal liability filing (GEICO's filing type and Federal Liability box, AmWINS' BMC-91
// and MCS-90, Progressive's Federal filing) and a federal cargo filing (AmWINS' BMC-32; GEICO and
// Progressive have no cargo box). Null is the agent's, with a note, never filled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { geico } from '../src/carriers/geico.js';
import { amwins } from '../src/carriers/amwins.js';
import { progressive } from '../src/carriers/progressive.js';
import { filingsIntent } from '../src/answers/filings.js';

const record = (filingsWhich) => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', mc: 'MC-765432', mcDotWithin60Days: null, owner1: 'Amina Kone', ownerDrives: true, phone: '(555) 010-0100', email: 'client@example.test', fein: null, yearEstablished: 2019, yearsInBusiness: 5, yearsExperience: 3 },
  garaging: { street: '1 Test Way', unit: null, city: 'Testville', state: 'NJ', zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', radius: 'Unlimited', radiusMiles: null, vehicleOwnership: 'Owned', personalUse: false, hazmat: false, hazPlacard: false, filingsRequired: true, filingsWhich, usesEld: false, equipVehicle: null },
  drivers: [{ first: 'Amina', middle: null, last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: 'NJ', cdl: true, cdlYear: 2015, maritalStatus: 'Married' }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  trailerInfo: { ownership: 'Owned', equipTrailer: null },
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Other', limit: '$500k CSL', expiration: '10/31/2099' }],
  coverage: { autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, glLimit: null, reeferBreakdown: null, ntl: null },
  claims: { hasClaims: false, text: 'No', notes: null },
  notes: { text: null },
});
const step = (plan, name) => { const s = plan.find((x) => x.name === name); assert.ok(s, name); return s; };

// Each carrier's answer as the shared tri-state, after checking a null is the agent's with a note.
const agents = (s, what) => {
  assert.equal(s.value, null, `${what}: ${s.name} not filled`);
  assert.ok(s.note, `${what}: ${s.name} has a note`);
  assert.equal(s.manualOnly, true, `${what}: ${s.name} is the agent's, never the AI's`);
  return null;
};
const geicoLiability = (text) => {
  const p = buildPlan(record(text), geico, {});
  const type = step(p, 'State or federal filing');
  const box = step(p, 'Federal liability filing');
  if (type.value == null) { agents(type, text); assert.equal(box.value, null, `${text}: GEICO's box isn't ticked`); return null; }
  const federal = { Federal: true, Both: true, State: false }[type.value];
  assert.equal(box.value, federal || null, `${text}: GEICO's Federal Liability box follows the filing type`);
  return federal;
};
const amwinsAnswers = (text) => {
  const p = buildPlan(record(text), amwins, {});
  const [bmc91, mcs90, bmc32] = ['Federal BMC-91', 'Federal liability MCS-90', 'Federal cargo BMC-32'].map((n) => step(p, n));
  const read = (s) => (s.value == null ? agents(s, text) : (assert.equal(s.source, 'derived', `${text}: ${s.name}`), s.value));
  const liability = read(bmc91);
  assert.equal(read(mcs90), liability, `${text}: MCS-90 comes with BMC-91`);
  return { liability, cargo: read(bmc32) };
};
// Progressive's Filings page: Federal (MCS-90 is ticked by the page with it); State is left as the
// page has it.
const progressiveFederal = (p) => p.find((s) => s.field === 'FilingsInput.FederalOpAuthorityIndicator');
const progressiveLiability = (text) => {
  const s = progressiveFederal(buildPlan(record(text), progressive, {}));
  assert.ok(s, 'Progressive\'s Federal filing');
  if (s.value == null) { assert.equal(s.source, 'fact', `${text}: Progressive's Federal filing`); return agents(s, text); }
  assert.equal(s.source, 'derived', `${text}: Progressive's Federal filing`);
  return s.value;
};

// [which filings, federal liability, federal cargo]
const CASES = [
  ['Federal Liability Filing', true, false],
  ['BMC-91', true, false],
  ['BMC-91X', true, false],
  ['MCS-90', true, false],
  ['Federal', true, false],
  ['Federal and state', true, false],
  ['Federal liability and BMC-34', true, true],
  ['BMC-91 and BMC-34', true, true],
  // A cargo-only request ticks only the cargo filing; whether a liability one is needed is the agent's.
  ['Federal BMC-34', null, true],
  ['Federal cargo filing', null, true],
  ['Federal cargo (BMC-34)', null, true],
  ['State and federal cargo', null, true],
  ['Federal cargo liability', null, true],
  ['BMC-34', null, true],
  // Beside a state filing too: the cargo filing doesn't say whether a federal liability filing is
  // needed, so it isn't a state-only request (CodeRabbit on #363).
  ['State filing and BMC-34', null, true],
  ['Intrastate, cargo filing', null, true],
  // A cargo filing ruled out is a cargo No; asked for elsewhere in the text, it stays a request; both
  // asked for and ruled out is the agent's (CodeRabbit on #355).
  ['Federal liability only, no cargo filing', true, false],
  ['BMC-91, without BMC-34', true, false],
  ['MCS-90; cargo filing not needed', true, false],
  ['Federal liability, cargo: none', true, false],
  ['Federal, no cargo', true, false],
  ['Federal liability and BMC-34, no cargo filing', true, null],
  ['Federal, BMC-34, no cargo filing', null, null],
  ['Federal liability, BMC-34 for cargo', true, true],
  ['State filing, no cargo', false, false],
  // State filings only: no federal liability filing.
  ['State filing', false, false],
  ['Intrastate', false, false],
  // Not said, or only an SR-22 or FR-44: the agent's.
  ['SR-22', null, null],
  ['Liability filing', null, null],
  ['MC filing', null, null],
  [null, null, null],
];

test('the same which-filings text gives the same federal filings on GEICO, AmWINS and Progressive', () => {
  for (const [text, liability, cargo] of CASES) {
    const intent = filingsIntent(text);
    assert.deepEqual([intent.liability, intent.cargo], [liability, cargo], `${text}: the shared reading`);
    assert.equal(geicoLiability(text), liability, `${text}: GEICO`);
    assert.deepEqual(amwinsAnswers(text), { liability, cargo }, `${text}: AmWINS`);
    assert.equal(progressiveLiability(text), liability, `${text}: Progressive`);
  }
});

test('Progressive: a cargo-only request leaves the Federal filing to the agent, and state filings only untick it with a warning to tick State', () => {
  const federal = (text) => progressiveFederal(buildPlan(record(text), progressive, {}));
  assert.match(federal('Federal BMC-34').note, /"Federal BMC-34".*cargo filing.*Federal filing/);
  assert.match(federal('SR-22').note, /only "SR-22"/);
  assert.match(federal('Federal, BMC-34, no cargo filing').note, /both ask for a cargo filing and rule one out/);
  const state = federal('State filing');
  assert.deepEqual([state.value, state.note ?? null], [false, null]);
  assert.match(state.warn ?? '', /"State filing".*State box is yours/);
  assert.equal(federal('Federal and state').warn ?? null, null, 'a federal filing beside the state one: no warning');
  // A cargo filing beside the state one isn't state filings only: the agent's, with the cargo note, no warning.
  const stateCargo = federal('State filing and BMC-34');
  assert.deepEqual([stateCargo.value, stateCargo.warn ?? null], [null, null]);
  assert.match(stateCargo.note ?? '', /"State filing and BMC-34".*cargo filing/);
  // No filing required, or left blank: the page doesn't show, and Federal keeps the intake's answer.
  for (const [required, value] of [[false, false], [null, null]]) {
    const r = record('Federal BMC-34');
    r.operations.filingsRequired = required;
    const s = progressiveFederal(buildPlan(r, progressive, {}));
    assert.deepEqual([s.value, s.manualOnly, s.warn ?? null], [value, false, null], `filings required ${required}`);
  }
});

test('AmWINS: a cargo-only federal filing ticks BMC-32 alone, and its note says why the liability filings are the agent\'s', () => {
  const p = buildPlan(record('Federal BMC-34'), amwins, {});
  assert.match(step(p, 'Federal BMC-91').note, /"Federal BMC-34".*cargo filing/);
  assert.equal(step(p, 'Federal BMC-91').source, 'fact');
  assert.deepEqual([step(p, 'Federal cargo BMC-32').value, step(p, 'Federal cargo BMC-32').note ?? null], [true, null]);
  // No filing required: the boxes are hidden, nothing to answer and no note.
  const no = record('Federal BMC-34');
  no.operations.filingsRequired = false;
  for (const name of ['Federal BMC-91', 'Federal liability MCS-90', 'Federal cargo BMC-32']) {
    const s = step(buildPlan(no, amwins, {}), name);
    assert.deepEqual([s.value, s.note ?? null, s.manualOnly], [null, null, false], name);
  }
});
