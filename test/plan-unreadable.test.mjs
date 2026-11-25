// An intake value its field's kind can't hold (the text as written, which normalizeIntake keeps in
// the typed slot when it doesn't parse) is never filled as an answered intake value: the step is
// the agent's, with the text quoted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { parseEdit } from '../src/normalize.js';
import { progressive } from '../src/carriers/progressive.js';
import { progressivePa } from '../src/carriers/progressive-pa.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';

// A value as normalizeIntake keeps it: a number when it parses, else the text as written.
/** @param {{ dob?: string, year?: number | string, value?: number | string }} [values] */
const record = ({ dob = '01/02/1980', year = 2022, value = 45000 } = {}) => ({
  applicant: { name: 'Synthetic Expediter LLC', dot: '1234567', owner1: 'Zed Other', ownerDrives: true },
  garaging: { street: '1 Test Way', city: 'Testville', state: 'OH', zip: '07000' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight', vehicleOwnership: 'Owned' },
  // The second driver is the one under test (GEICO's first is the owner it already lists).
  drivers: [
    { first: 'Zed', last: 'Other', dob: '05/06/1970', licenseNumber: 'NJ7654321', licenseState: 'OH', cdl: true },
    { first: 'Amina', last: 'Kone', dob, licenseNumber: 'NJ1234567', licenseState: 'OH', cdl: true },
  ],
  vehicles: [{ type: 'Van', year, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value }],
  trailers: [],
  trailerInfo: {},
  priorInsurance: [],
  coverage: { autoLiabLimit: '$1M CSL', cargo: false },
  claims: { hasClaims: false },
});
// The steps that read the path straight from the intake, not ones only checked against it.
const read = (plan, path) => plan.filter((s) => s.path === path && s.source === 'intake' && !s.verifyOnly && !s.ignore);

for (const carrier of [progressive, amwins, geico]) {
  test(`${carrier.id}: an unreadable date of birth is the agent's, never an answered intake value`, () => {
    const good = read(buildPlan(record(), carrier, { drivers: 1 }), 'drivers[1].dob');
    assert.ok(good.length, 'the carrier has a date of birth step');
    for (const s of good) if (!s.note) assert.equal(s.resolution.status, 'answered');
    const steps = read(buildPlan(record({ dob: '13/45/1980' }), carrier, { drivers: 1 }), 'drivers[1].dob');
    assert.equal(steps.length, good.length);
    for (const s of steps) {
      assert.equal(s.value, null, `${s.name}: not filled`);
      assert.notEqual(s.resolution.status, 'answered');
      assert.ok(s.note, 'says why');
    }
    // A step without a note of its own is the agent's and quotes the text.
    const quoted = steps.filter((s) => !good.find((g) => g.name === s.name && g.note));
    assert.ok(quoted.length, 'some step reads the date of birth unguarded');
    for (const s of quoted) {
      assert.equal(s.resolution.status, 'agent');
      assert.match(s.note, /"13\/45\/1980", which isn't a valid date/);
    }
  });
}

test('an unreadable vehicle year or value, read straight from the intake, is the agent\'s', () => {
  const value = read(buildPlan(record({ value: 'around 40k' }), progressive, {}), 'vehicles[0].value').filter((s) => s.re);
  assert.ok(value.length, 'Progressive has a label rule for the vehicle value');
  for (const s of value) {
    assert.equal(s.value, null);
    assert.equal(s.resolution.status, 'agent');
    assert.match(s.note, /"around 40k", which isn't a dollar amount/);
  }
  const year = read(buildPlan(record({ year: '20O1' }), amwins, {}), 'vehicles[0].year');
  assert.ok(year.length, 'AmWINS has a vehicle year step');
  for (const s of year) {
    assert.equal(s.value, null);
    assert.match(s.note, /"20O1", which isn't a whole number/);
  }
});

test('an agent\'s edit that doesn\'t parse is held the same way', () => {
  const dob = parseEdit('date', '02/30/1980');
  assert.equal(dob, '02/30/1980', 'parseEdit keeps the text');
  const steps = read(buildPlan(record({ dob }), progressive, { drivers: 1 }), 'drivers[1].dob');
  assert.ok(steps.length);
  for (const s of steps) assert.equal(s.resolution.status, 'agent');
});

test('readable values are untouched', () => {
  const plan = buildPlan(record(), amwins, {});
  for (const s of read(plan, 'vehicles[0].year')) assert.equal(s.value, 2022);
  for (const s of read(plan, 'drivers[0].dob')) assert.equal(s.value, '05/06/1970');
});

// W48-02: an intake VIN the intake check flags (vin.invalid: an 18-character VIN on JC's Progressive
// AddVehicle, refused as longer than the field) is never typed: the agent's, on every carrier.
const VALID = '1FTBR3X87MKA12345';
const TOO_LONG = '1FTBR3X87MKA123456';
/** @param {Array<string | null>} vins  the vehicles' VINs @param {Array<string | null>} [trailerVins] */
const units = (vins, trailerVins = []) => ({
  ...record(),
  vehicles: vins.map((vin, i) => ({ type: 'Van', year: 2021 + i, make: 'FORD', model: 'Transit', vin, value: 45000 })),
  trailers: trailerVins.map((vin) => ({ type: 'Enclosed', year: 2019, make: 'Wells', vin, value: 9000 })),
});
// The plan's steps, as the page kit reads them.
/** @returns {any[]} */
const planFor = (r, carrier, active = {}) => buildPlan(r, carrier, active);
const vinSteps = (plan, path) => plan.filter((s) => s.path === path && s.source === 'intake');

for (const carrier of [progressive, amwins, geico]) {
  test(`${carrier.id}: an invalid intake VIN is the agent's, a valid one on the same quote still fills`, () => {
    const plan = planFor(units([VALID, TOO_LONG]), carrier, { vehicles: 1 });
    const bad = vinSteps(plan, 'vehicles[1].vin');
    assert.ok(bad.length, 'the carrier has a VIN step');
    for (const s of bad) {
      assert.equal(s.value, null, `${s.name}: not typed`);
      assert.equal(s.manualOnly, true);
      assert.equal(s.resolution.status, 'agent');
      assert.ok(s.note.includes(`"${TOO_LONG}" has 18 characters (should be 17), so it isn't typed`), s.note);
    }
    const good = vinSteps(planFor(units([VALID, TOO_LONG]), carrier, { vehicles: 0 }), 'vehicles[0].vin');
    assert.ok(good.length);
    for (const s of good) assert.equal(s.value, VALID, `${s.name}: vehicle 1's VIN fills`);
  });
}

test('a valid VIN written with spaces or dashes, or a check-digit typo, reads as the intake check reads it', () => {
  const spaced = vinSteps(planFor(units(['1FTBR 3X87-MKA12345']), progressive), 'vehicles[0].vin');
  assert.ok(spaced.length);
  for (const s of spaced) assert.equal(s.value, '1FTBR 3X87-MKA12345', 'not held');
  const typo = vinSteps(planFor(units(['1FTBR3X80MKA12345']), progressive), 'vehicles[0].vin');
  for (const s of typo) {
    assert.equal(s.value, null);
    assert.match(s.note, /fails the check-digit test/);
  }
});

test('an agent\'s corrected VIN fills; a missing VIN keeps its own handling', () => {
  // The panel's edit: parseEdit keeps the text; the plan reads it as the intake check does.
  const edited = parseEdit('text', ' 1ftbr3x87mka12345 ');
  for (const s of vinSteps(planFor(units([VALID, edited]), progressive, { vehicles: 1 }), 'vehicles[1].vin')) {
    assert.equal(s.value, edited);
    assert.equal(s.manualOnly, false);
  }
  for (const s of vinSteps(planFor(units([VALID, null]), progressive, { vehicles: 1 }), 'vehicles[1].vin')) {
    assert.equal(s.value, null);
    assert.equal(s.manualOnly, false, 'no VIN: as before, nothing the intake check quotes');
    assert.doesNotMatch(s.note ?? '', /isn't typed/);
  }
});

test('Progressive: the trailer\'s invalid VIN is the agent\'s; the VIN lookup is never clicked for it', () => {
  const plan = planFor(units([VALID, TOO_LONG], ['1GRAA0621FB7000001']), progressive, { vehicles: 1 });
  for (const s of vinSteps(plan, 'trailers[0].vin')) {
    assert.equal(s.value, null);
    assert.equal(s.resolution.status, 'agent');
  }
  // The lookup waits for the VIN box, which the fill leaves empty: it runs once the agent types it.
  const lookup = plan.find((s) => s.action === 'lookupVin:1');
  assert.deepEqual(lookup.after, ['vehicles[1].vin']);
});

test('GEICO: "VIN at hand" is the agent\'s for an invalid VIN, and the year, make and model are typed', () => {
  const plan = planFor(units([TOO_LONG]), geico, { vehicles: 0 });
  const atHand = plan.find((s) => s.field === 'YesNoPreQuoteHaveFullVinActivity');
  assert.equal(atHand.value, null);
  assert.match(atHand.note, /has 18 characters \(should be 17\): correct it in client details/);
  for (const field of ['GiveYear', 'GiveMake', 'GiveModel']) assert.equal(plan.find((s) => s.field === field).verifyOnly, false, field);
  assert.equal(plan.find((s) => s.field === 'GiveYear').waitFor, null, 'no decode to wait for');
  const valid = planFor(units([VALID]), geico, { vehicles: 0 });
  assert.equal(valid.find((s) => s.field === 'YesNoPreQuoteHaveFullVinActivity').value, true);
  assert.equal(valid.find((s) => s.field === 'GiveMake').verifyOnly, true);
});

test('AmWINS: an invalid VIN is left out of the VIN list and the trailer line, and named', () => {
  const plan = planFor(units([VALID, TOO_LONG], ['1GRAA0621FB7000001']), amwins, {});
  const list = plan.find((s) => s.path === 'amwins.vinList');
  assert.equal(list.value, VALID, 'the valid vehicle is still looked up');
  assert.match(list.warn, /vehicle 2 \(2022 FORD Transit\): "1FTBR3X87MKA123456" has 18 characters/);
  const disclosure = plan.find((s) => s.name === 'Disclosure details (from the intake)');
  assert.doesNotMatch(disclosure.value, /VIN/);
  assert.match(disclosure.value, /Trailer - 2019 Wells Enclosed - \$9K/);
  assert.match(disclosure.warn, /trailer 1 \(2019 Wells\): "1GRAA0621FB7000001" has 18 characters/);
  // None left to look up: the list is the agent's.
  const none = planFor(units([TOO_LONG]), amwins, {}).find((s) => s.path === 'amwins.vinList');
  assert.equal(none.value, null);
  assert.equal(none.resolution.status, 'agent');
  assert.match(none.note, /vehicle 1 \(2021 FORD Transit\)/);
  // Every VIN valid: listed as before, with no warning.
  const ok = planFor(units([VALID, '1FTBR3X88MKA12399']), amwins, {}).find((s) => s.path === 'amwins.vinList');
  assert.equal(ok.value, `${VALID}\n1FTBR3X88MKA12399`);
  assert.equal(ok.warn, null);
});

// W49-20: an unreadable owner or driver DOB (flagged dob.invalid) must be held through UNREADABLE
// quoting the raw text across all carriers (including derived owner DOB steps like Progressive
// BusinessOwnerDOB / NoHitCredit.DOB, AmWINS #ownerDob, GEICO owner GiveDateOfBirth, and
// Progressive PA Named Insured & Driver DOB), while valid MM/DD/YYYY DOBs fill unchanged.
test('W49-20: unreadable owner and driver DOB (dob.invalid) is held quoting raw text across all carriers', () => {
  const withOwnerDob = (dob) => {
    const r = record();
    r.drivers[0].dob = dob;
    return r;
  };
  for (const badDob of ['13/45/1980', '02/30/1980', 'not-a-date']) {
    const r = withOwnerDob(badDob);
    const progPlan = planFor(r, progressive, { drivers: 0 });
    for (const q of ['2BB', '1B8B', '28A7']) {
      const s = progPlan.find((x) => x.q === q);
      assert.equal(s.value, null, `progressive ${q} (${badDob}): not typed`);
      assert.equal(s.manualOnly, true, `progressive ${q} (${badDob}): manualOnly`);
      assert.equal(s.resolution.status, 'agent', `progressive ${q} (${badDob}): agent`);
      assert.ok(s.note.includes(`"${badDob}"`), `progressive ${q}: quotes raw text (${s.note})`);
    }
    const amwinsPlan = planFor(r, amwins, { drivers: 0 });
    for (const sel of ['#ownerDob', '#driversPanel > .app-rp-section[data-id="0"] [data-id="dateOfBirth"]']) {
      const s = amwinsPlan.find((x) => x.selector === sel);
      assert.equal(s.value, null, `amwins ${sel} (${badDob}): not typed`);
      assert.equal(s.manualOnly, true, `amwins ${sel} (${badDob}): manualOnly`);
      assert.equal(s.resolution.status, 'agent', `amwins ${sel} (${badDob}): agent`);
      assert.ok(s.note.includes(`"${badDob}"`), `amwins ${sel}: quotes raw text (${s.note})`);
    }
    // AmWINS licenseYear (birth year + 17) must not compute a year from an impossible calendar date.
    const licYr = amwinsPlan.find((x) => x.selector === '#driversPanel > .app-rp-section[data-id="0"] [data-id="licenseYear"]');
    assert.equal(licYr.value, null, `amwins licenseYear (${badDob}): not computed`);
    assert.equal(licYr.source, 'fact', `amwins licenseYear (${badDob}): fact`);
    const geicoOwner = planFor(r, geico, { drivers: 0 }).find((x) => x.concept === 'owner.dob');
    assert.equal(geicoOwner.value, null, `geico owner.dob (${badDob}): not typed`);
    assert.equal(geicoOwner.manualOnly, true, `geico owner.dob (${badDob}): manualOnly`);
    assert.equal(geicoOwner.resolution.status, 'agent', `geico owner.dob (${badDob}): agent`);
    assert.ok(geicoOwner.note.includes(`"${badDob}"`), `geico owner.dob: quotes raw text (${geicoOwner.note})`);
    const paPlan = planFor({
      ...r,
      product: 'personal-auto',
      drivers: [{ first: 'Zed', last: 'Other', relation: 'Insured', dob: badDob }],
    }, progressivePa, {});
    for (const concept of ['owner.dob', 'driver.dob']) {
      const s = paPlan.find((x) => x.concept === concept && !x.ignore);
      assert.equal(s.value, null, `progressive-pa ${concept} (${badDob}): not typed`);
      assert.equal(s.manualOnly, true, `progressive-pa ${concept} (${badDob}): manualOnly`);
      assert.equal(s.resolution.status, 'agent', `progressive-pa ${concept} (${badDob}): agent`);
      assert.ok(s.note.includes(`"${badDob}"`), `progressive-pa ${concept}: quotes raw text (${s.note})`);
    }
  }
  // Counterexample: valid MM/DD/YYYY DOBs fill unchanged across every carrier.
  const valid = withOwnerDob('05/06/1970');
  assert.equal(planFor(valid, progressive, { drivers: 0 }).find((x) => x.q === '2BB').value, '05/06/1970');
  assert.equal(planFor(valid, progressive, { drivers: 0 }).find((x) => x.q === '1B8B').value, '05/06/1970');
  assert.equal(planFor(valid, amwins, { drivers: 0 }).find((x) => x.selector === '#ownerDob').value, '05/06/1970');
  assert.equal(planFor(valid, amwins, { drivers: 0 }).find((x) => x.selector === '#driversPanel > .app-rp-section[data-id="0"] [data-id="licenseYear"]').value, '1987');
  assert.equal(planFor(valid, geico, { drivers: 0 }).find((x) => x.concept === 'owner.dob').value, '05/06/1970');
  const validPa = planFor({
    ...valid,
    product: 'personal-auto',
    drivers: [{ first: 'Zed', last: 'Other', relation: 'Insured', dob: '05/06/1970' }],
  }, progressivePa, {});
  assert.equal(validPa.find((x) => x.concept === 'owner.dob').value, '05/06/1970');
  assert.equal(validPa.find((x) => x.concept === 'driver.dob' && !x.ignore).value, '05/06/1970');
});

// W49-19: bare "Other" in coverage.autoLiabLimit is held as Needs you quoting the raw text if
// present on a record (e.g., chosen in the panel), while real limits fill unchanged.
test('W49-19: bare "Other" in coverage.autoLiabLimit is held across carriers, real limits fill', () => {
  const other = { ...record(), coverage: { autoLiability: 'Yes', autoLiabLimit: 'Other', cargo: false } };
  /** @type {Array<{ carrier: any, find: (p: any[]) => any }>} */
  const cases = [
    { carrier: amwins, find: (p) => p.find((x) => x.path === 'coverage.autoLiabLimit') },
    { carrier: progressive, find: (p) => p.find((x) => x.q === '1D97') },
    { carrier: geico, find: (p) => p.find((x) => x.path === 'coverage.autoLiabLimit' && !x.ignore) },
  ];
  for (const { carrier, find } of cases) {
    const step = find(planFor(other, carrier, {}));
    assert.equal(step.value, null, `${carrier.id}: not filled with "Other"`);
    assert.equal(step.manualOnly, true, `${carrier.id}: manualOnly`);
    assert.equal(step.resolution.status, 'agent', `${carrier.id}: agent`);
    assert.match(step.note, /"Other"/, `${carrier.id}: quotes raw text`);
  }
  for (const limit of ['$1,000,000', '$1M CSL', 'State Minimum']) {
    const good = { ...record(), coverage: { autoLiability: 'Yes', autoLiabLimit: limit, cargo: false } };
    assert.equal(planFor(good, amwins, {}).find((x) => x.path === 'coverage.autoLiabLimit').value, limit);
    assert.equal(planFor(good, progressive, {}).find((x) => x.q === '1D97').value, limit);
    assert.equal(planFor(good, geico, {}).find((x) => x.path === 'coverage.autoLiabLimit' && !x.ignore).value, limit);
  }
});
