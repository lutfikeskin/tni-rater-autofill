// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { buildPlan } from '../src/plan.js';
import { carrierForUrl } from '../src/carriers.js';
import { kitCode } from '../scripts/lib/kit.mjs';
import {
  geicoPa,
  geicoAgeFirstLicensed,
  geicoAnnualMileageBand,
  geicoEducationChoice,
  geicoEmploymentChoice,
  geicoOwnershipLength,
  geicoPriorBiChoice,
  geicoPriorYearsChoice,
  geicoProviderChoice,
  hadInsuranceLast30Days,
  substantialLicenseHistory,
} from '../src/carriers/geico-pa.js';
import { createLocator } from '../src/kit/locator.js';
import { readPremium, premiumHere } from '../src/premium.js';

const PAGEKIT = await kitCode();
const FIELD_KEY = fs.readFileSync(new URL('../src/content/field-key.js', import.meta.url), 'utf8');
const GEICO_PA_ADAPTER = fs.readFileSync(new URL('../src/content/carriers/geico-pa.js', import.meta.url), 'utf8');

/** Synthetic personal-auto client record covering all GEICO PA steps. */
const baseRecord = () => ({
  product: 'personal-auto',
  applicant: { name: 'Jordan Sample', phone: '(555) 010-0142', email: 'sample.client@example.com', applicationDate: '11/20/2026' },
  garaging: { street: '100 Example St', unit: 'Apt 2B', city: 'Knoxville', state: 'TN', zip: '37901' },
  residence: { timeAtAddress: '3 years', priorAddress: null, ownership: 'Own' },
  drivers: [
    {
      first: 'Jordan Michael', middle: null, last: 'Sample', suffix: null, dob: '02/03/1985', gender: 'Female',
      maritalStatus: 'Married', relation: 'Insured', licenseNumber: 'S1234567', licenseState: 'TN',
      yearLicensed: 2003, occupation: 'Teacher', education: "Bachelor's Degree",
      matureCourse: true, goodStudent: null, distantStudent: null,
    },
    {
      first: 'Alex', middle: null, last: 'Sample', suffix: 'Jr', dob: '04/05/1984', gender: 'Male',
      maritalStatus: 'Married', relation: 'Spouse', licenseNumber: 'S7654321', licenseState: 'TN',
      yearLicensed: 2002, occupation: 'Retired', education: 'Some College',
      matureCourse: null, goodStudent: null, distantStudent: null,
    },
    {
      first: 'Casey', middle: null, last: 'Sample', suffix: null, dob: '07/09/2007', gender: 'Male',
      maritalStatus: 'Single', relation: 'Child', licenseNumber: 'S9999999', licenseState: 'TN',
      yearLicensed: 2025, occupation: 'Student', education: 'High school diploma or GED',
      matureCourse: null, goodStudent: true, distantStudent: null,
    },
  ],
  vehicles: [
    {
      year: 2020, make: 'Honda', model: 'Accord', vin: '1HGCM82633A004352',
      use: 'Commute to/from work or school', ownership: 'Financed', value: 18500,
      ownedFor: '6 months - 1 year', annualMiles: 12000, commuteMiles: 15, commuteDays: 5,
      damage: false, fullCoverage: true,
      lienholder: { name: 'Example Credit Union', street: '1 Bank Way', city: 'Dallas', state: 'TX', zip: '75201' },
    },
    {
      year: 2021, make: 'Toyota', model: 'Corolla', vin: '1HGCM82633A004353',
      use: 'Pleasure/Personal', ownership: 'Owned', value: null,
      ownedFor: '3+ years', annualMiles: null, commuteMiles: null, commuteDays: null,
      damage: true, fullCoverage: false,
      lienholder: { name: null, street: null, city: null, state: null, zip: null },
    },
  ],
  trailers: [],
  priorInsurance: [{ currentlyInsured: true, carrier: 'State Farm', limit: '$50k/$100k', insuredFor: '3 years', expiration: '12/31/2026' }],
  coverage: { liabilityLimit: '100/300/100', compDeductible: '$500 w/$50 Glass', collDeductible: '$1,000' },
  notes: { text: null },
});

/** @param {any[]} plan @param {string} step @param {string} field @param {string | number | null} [row] */
const byField = (plan, step, field, row = null) => plan.find((s) =>
  s.kind !== 'action' && s.steps?.includes(step) && s.field === field && (row == null ? s.row == null : s.row === String(row)));

/** @param {any[]} plan @param {string} step @param {string} re @param {string | number | null} [row] */
const byLabel = (plan, step, re, row = null) => plan.find((s) =>
  s.kind !== 'action' && s.steps?.includes(step) && s.re === re && (row == null ? s.row == null : s.row === String(row)));

/** @param {any[]} plan @param {string} id */
const byAction = (plan, id) => plan.find((s) => s.kind === 'action' && s.baseAction === id);

test('geico-pa config metadata, stopSteps, world/pressInPage, gateway routing, Quote Summary guards, and auto-advance on pre-quote steps', () => {
  assert.equal(geicoPa.id, 'geico-pa');
  assert.equal(geicoPa.product, 'personal-auto');
  assert.equal(geicoPa.world, 'MAIN');
  assert.equal(geicoPa.pressInPage, true);
  assert.equal(geicoPa.pageAdapter, 'src/content/carriers/geico-pa.js');
  assert.equal(geicoPa.continueRetry, false);
  assert.deepEqual(geicoPa.newQuestionsOnlySteps, ['Quote Summary']);
  assert.deepEqual(geicoPa.keepTakenBack, ['Quote Summary']);
  assert.deepEqual(geicoPa.advance, {
    text: '^(next|save and continue)$',
    steps: [
      'Policyholder Information',
      'Vehicle Prefill',
      'Current Insurance',
      'Vehicle Information',
      'Driver Information',
      'License History',
      'Select Drivers with Incidents',
      'Groups or Organizations',
    ],
  });
  assert.ok(geicoPa.advance.steps.includes('Vehicle Prefill'), 'Vehicle Prefill auto-advances once "Quote a different vehicle" is selected');
  assert.ok(!geicoPa.advance.steps.includes('Quote Summary'), 'Quote Summary must never auto-advance');
  assert.equal(geicoPa.finishedBy, 'printProposal');
  assert.deepEqual(geicoPa.premiumPages, ['Quote Summary']);
  assert.deepEqual(Object.keys(geicoPa.stopSteps ?? {}), [
    'Vehicle Details',
    'Driver Details',
    'Communication Options',
    'Payment Plan',
    'Payment Type',
  ]);
  assert.equal(geicoPa.layoutSteps?.length, 14);
  assert.equal(geicoPa.autoFillUrl?.test('https://sales.geico.com/quote'), true);
  assert.equal(geicoPa.autoFillUrl?.test('https://gateway2.geico.com/'), true);
  assert.equal(geicoPa.autoFillUrl?.test('https://gateway2.geico.com/search-results'), true);
  assert.equal(geicoPa.autoFillUrl?.test('https://sales.geico.com/PrintQuote?quote=1'), false);
  assert.equal(geicoPa.fillOnDraw?.test('https://gateway2.geico.com/search-results'), true);
  assert.equal(geicoPa.fillOnDraw?.test('https://sales.geico.com/quote'), false);
  assert.equal(carrierForUrl('https://gateway2.geico.com/search-results', { product: 'personal-auto' })?.id, 'geico-pa');
  assert.equal(carrierForUrl('https://gateway2.geico.com/search-results', { product: 'commercial-auto' })?.id, 'geico');
});

test('Policyholder Information maps insured name (first word only, D6), address autocomplete, phone, effective date (D7), SSN ignore, and credit ack (D2)', () => {
  const plan = buildPlan(baseRecord(), geicoPa, {});
  assert.equal(byField(plan, 'Policyholder Information', 'GiveFirstName').value, 'Jordan');
  assert.equal(byField(plan, 'Policyholder Information', 'GiveLastName').value, 'Sample');
  assert.equal(byField(plan, 'Policyholder Information', 'GiveDateOfBirth').value, '02/03/1985');
  const street = byField(plan, 'Policyholder Information', 'GiveStreet');
  assert.equal(street.kind, 'address-suggest');
  assert.equal(street.value, '100 Example St, Knoxville, TN 37901');
  assert.equal(street.fallback, '100 Example St');
  assert.equal(street.checkNumber, true);
  assert.equal(byField(plan, 'Policyholder Information', 'GiveCity').ignore, true);
  assert.equal(byField(plan, 'Policyholder Information', 'GiveZip').value, '37901');
  assert.equal(byField(plan, 'Policyholder Information', 'GiveUnitNumber').value, 'Apt 2B');
  assert.equal(byField(plan, 'Policyholder Information', 'GiveOwnOrRent').value, 'Own');
  assert.equal(byField(plan, 'Policyholder Information', 'GiveEmail').value, 'sample.client@example.com');
  assert.equal(byField(plan, 'Policyholder Information', 'GivePhoneNumber').value, '(555) 010-0142');
  const eff = byField(plan, 'Policyholder Information', 'GiveEffectiveDate');
  assert.equal(eff.trustPage, true);
  assert.equal(eff.source, 'standard');
  assert.equal(eff.tni, 'geico-pa.effective-date');
  assert.match(String(eff.value), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(byField(plan, 'Policyholder Information', 'GiveSocialSecurityNumber').ignore, true);
  const minor = byField(plan, 'Policyholder Information', 'GiveEmancipatedMinorYesNoRequest');
  assert.deepEqual([minor.value, minor.source, minor.manualOnly], [null, 'fact', true]);
  const credit = byField(plan, 'Policyholder Information', 'GiveCreditAcknowledgement.Yes');
  assert.deepEqual([credit.value, credit.source, credit.tni], [true, 'standard', 'geico-pa.acknowledgements']);
  // Vehicle Prefill selects "Quote a different vehicle" (standard) and removes the manual blocker action.
  assert.equal(byAction(plan, 'vehiclePrefillManual'), undefined);
  const prefillAdd = /** @type {any} */ (plan.find((s) => s.kind !== 'action' && s.steps?.includes('Vehicle Prefill') && 'q' in s && s.q === 'vehiclePrefillAdd'));
  assert.deepEqual([prefillAdd?.selector, prefillAdd?.value, prefillAdd?.source, prefillAdd?.tni], [
    'input[type="checkbox"][value="AddVehicle"]', true, 'standard', 'geico-pa.vehicle-prefill',
  ]);
});

test('Current Insurance maps status, provider aliases + Not Listed standard (D8), tenure, BI limits (no replace), and last 30 days', () => {
  const plan = buildPlan(baseRecord(), geicoPa, {});
  assert.equal(byField(plan, 'Current Insurance', 'GiveCurrentAutoInsuranceStatus').value, 'Yes');
  const curProv = byField(plan, 'Current Insurance', 'GiveCurrentAutoInsuranceProvider');
  assert.deepEqual([curProv.value, curProv.source], ['State Farm Mutual', 'derived']);
  assert.equal(byField(plan, 'Current Insurance', 'GivePreviousAutoInsuranceProvider').ignore, true);
  assert.equal(byField(plan, 'Current Insurance', 'GiveYearsWithCurrentAutoInsurer').value, '3');
  const bi = byField(plan, 'Current Insurance', 'GiveCurrentBodilyInjuryLimits');
  assert.deepEqual([bi.kind, bi.value, bi.source, bi.tni, bi.replace], [
    'choice', '$50,000/$100,000', 'derived', 'geico-pa.prior-bi-state-min', false,
  ]);
  assert.equal(byField(plan, 'Current Insurance', 'YesNoLastThirtyDays').ignore, true);

  // Unknown carrier falls back to "Not Listed" (TNI standard, D8).
  assert.deepEqual(geicoProviderChoice('Allstate Insurance'), { value: 'Allstate/Encompass', source: 'derived', note: null });
  assert.deepEqual(geicoProviderChoice('Liberty Mutual'), { value: 'Liberty Mutual/Safeco', source: 'derived', note: null });
  assert.deepEqual(geicoProviderChoice('Tennessee Farmers'), { value: 'TENNESSEE FARMERS', source: 'derived', note: null });
  assert.deepEqual(geicoProviderChoice('Regional Unknown Mutual'), { value: 'Not Listed', source: 'standard', note: null });
  assert.equal(geicoProviderChoice(null).source, 'fact');

  // Prior years: exact years / < 1 year / 11+ map derived; closed ranges use lower bound (standard),
  // open-ended plus/over ranges use N + 1 capped at '11 or more' (standard when N < 11, derived when N >= 11),
  // month-to-year ranges starting < 12 months map to 'Less than 1'; blank/unreadable stay fact.
  assert.deepEqual(geicoPriorYearsChoice('Less than 1 year'), { value: 'Less than 1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('< 1 year'), { value: 'Less than 1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('under 1 year'), { value: 'Less than 1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('0 years'), { value: 'Less than 1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('6 months'), { value: 'Less than 1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('< 12 months'), { value: 'Less than 1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('1 year'), { value: '1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('24 months'), { value: '2', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('10 years'), { value: '10', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('12 years'), { value: '11 or more', source: 'derived', note: null });

  assert.deepEqual(geicoPriorYearsChoice('1-3 years'), { value: '1', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('3-5 years'), { value: '3', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('1 - 3 years'), { value: '1', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('1 to 3 years'), { value: '1', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('0-1 years'), { value: 'Less than 1', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('11-15 years'), { value: '11 or more', source: 'standard', note: null });

  assert.deepEqual(geicoPriorYearsChoice('5+ years'), { value: '6', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('5+'), { value: '6', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('over 5 years'), { value: '6', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('more than 5 years'), { value: '6', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('5 years or more'), { value: '6', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('10+ years'), { value: '11 or more', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('11+ years'), { value: '11 or more', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('12+ years'), { value: '11 or more', source: 'derived', note: null });

  assert.deepEqual(geicoPriorYearsChoice('6 months - 1 year'), { value: 'Less than 1', source: 'standard', note: null });
  assert.deepEqual(geicoPriorYearsChoice('6-11 months'), { value: 'Less than 1', source: 'derived', note: null });
  assert.deepEqual(geicoPriorYearsChoice('6-12 months'), { value: 'Less than 1', source: 'standard', note: null });

  for (const bad of [null, '', 'a few years', '18 months', '5-3 years']) {
    const res = geicoPriorYearsChoice(bad);
    assert.equal(res.value, null, `expected null for ${JSON.stringify(bad)}`);
    assert.equal(res.source, 'fact', `expected fact for ${JSON.stringify(bad)}`);
    assert.ok(res.note, `expected note for ${JSON.stringify(bad)}`);
  }

  // Plan rule carries tni: 'geico-pa.years-with-insurer' and propagates dynamic source.
  const exactYrStep = byField(plan, 'Current Insurance', 'GiveYearsWithCurrentAutoInsurer');
  assert.deepEqual([exactYrStep.value, exactYrStep.source, exactYrStep.tni], ['3', 'derived', 'geico-pa.years-with-insurer']);
  const range13Rec = baseRecord();
  range13Rec.priorInsurance[0].insuredFor = '1-3 years';
  const range13Step = byField(buildPlan(range13Rec, geicoPa, {}), 'Current Insurance', 'GiveYearsWithCurrentAutoInsurer');
  assert.deepEqual([range13Step.value, range13Step.source, range13Step.tni], ['1', 'standard', 'geico-pa.years-with-insurer']);
  const plus5Rec = baseRecord();
  plus5Rec.priorInsurance[0].insuredFor = '5+ years';
  const plus5Step = byField(buildPlan(plus5Rec, geicoPa, {}), 'Current Insurance', 'GiveYearsWithCurrentAutoInsurer');
  assert.deepEqual([plus5Step.value, plus5Step.source, plus5Step.tni], ['6', 'standard', 'geico-pa.years-with-insurer']);
  const blankYrRec = baseRecord();
  blankYrRec.priorInsurance[0].insuredFor = null;
  const blankYrStep = byField(buildPlan(blankYrRec, geicoPa, {}), 'Current Insurance', 'GiveYearsWithCurrentAutoInsurer');
  assert.deepEqual([blankYrStep.value, blankYrStep.source, blankYrStep.tni], [null, 'fact', 'geico-pa.years-with-insurer']);

  // Prior BI limits: exact split limits map as derived choice; State Minimum / State Minimum or less
  // use pick-not (TNI standard geico-pa.prior-bi-state-min, omit replace so prefilled limits stay);
  // blank / Other / unrecognized strings stay agent-only facts.
  assert.deepEqual(geicoPriorBiChoice('$25k/$50k'), { kind: 'choice', value: '$25,000/$50,000', source: 'derived', note: null });
  assert.deepEqual(geicoPriorBiChoice('$50k/$100k'), { kind: 'choice', value: '$50,000/$100,000', source: 'derived', note: null });
  assert.deepEqual(geicoPriorBiChoice('$100k/$200k'), { kind: 'choice', value: '$100,000/$200,000', source: 'derived', note: null });
  assert.deepEqual(geicoPriorBiChoice('$100k/$300k'), { kind: 'choice', value: '$100,000/$300,000', source: 'derived', note: null });
  assert.deepEqual(geicoPriorBiChoice('$300k/$300k'), { kind: 'choice', value: '$300,000/$300,000', source: 'derived', note: null });
  assert.deepEqual(geicoPriorBiChoice('$250k/$500k'), { kind: 'choice', value: '$250,000/$500,000 or higher', source: 'derived', note: null });
  assert.deepEqual(geicoPriorBiChoice('$500k CSL'), { kind: 'choice', value: '$250,000/$500,000 or higher', source: 'derived', note: null });
  for (const stateMin of ['State Minimum', 'State Minimum or less']) {
    const res = geicoPriorBiChoice(stateMin);
    assert.equal(res.kind, 'pick-not');
    assert.equal(res.source, 'standard');
    assert.equal(res.note, null);
    assert.ok(res.value && typeof res.value === 'object' && 'not' in res.value && res.value.prefer === '^state\\s*min');
  }
  const stateMinRec = baseRecord();
  stateMinRec.priorInsurance[0].limit = 'State Minimum or less';
  const stateMinStep = byField(buildPlan(stateMinRec, geicoPa, {}), 'Current Insurance', 'GiveCurrentBodilyInjuryLimits');
  assert.deepEqual([stateMinStep.kind, stateMinStep.source, stateMinStep.tni, stateMinStep.replace, stateMinStep.note], [
    'pick-not', 'standard', 'geico-pa.prior-bi-state-min', false, null,
  ]);
  for (const badBi of [null, '', 'Other', '300k CSL', 'Unknown tier']) {
    const res = geicoPriorBiChoice(badBi);
    assert.equal(res.kind, 'choice', `expected choice for ${JSON.stringify(badBi)}`);
    assert.equal(res.value, null, `expected null for ${JSON.stringify(badBi)}`);
    assert.equal(res.source, 'fact', `expected fact for ${JSON.stringify(badBi)}`);
    assert.ok(res.note, `expected note for ${JSON.stringify(badBi)}`);
  }

  // Currently insured = No -> 'No' unless notes mention military/deployment; last 30 days derived from expiration.
  const uninsured = baseRecord();
  uninsured.priorInsurance[0] = { currentlyInsured: false, carrier: 'Regional Unknown Mutual', limit: null, insuredFor: null, expiration: '11/10/2026' };
  const up = buildPlan(uninsured, geicoPa, {});
  assert.equal(byField(up, 'Current Insurance', 'GiveCurrentAutoInsuranceStatus').value, 'No');
  assert.equal(byField(up, 'Current Insurance', 'GiveCurrentAutoInsuranceProvider').ignore, true);
  const prevProv = byField(up, 'Current Insurance', 'GivePreviousAutoInsuranceProvider');
  assert.deepEqual([prevProv.value, prevProv.source, prevProv.tni], ['Not Listed', 'standard', 'geico-pa.prior-provider']);

  const deployed = baseRecord();
  deployed.priorInsurance[0].currentlyInsured = false;
  deployed.notes.text = 'Client was deployed overseas with military';
  assert.equal(byField(buildPlan(deployed, geicoPa, {}), 'Current Insurance', 'GiveCurrentAutoInsuranceStatus').source, 'fact');

  assert.equal(hadInsuranceLast30Days('11/10/2026', new Date('2026-11-24')).value, 'Yes');
  assert.equal(hadInsuranceLast30Days('09/01/2026', new Date('2026-11-24')).value, 'No');
  assert.equal(hadInsuranceLast30Days(null, new Date('2026-11-24')).source, 'fact');
});

test('Vehicle Information maps VIN/no-VIN (D10), ownership length, commute, mileage bands (D9), and Add Vehicle actions', () => {
  const plan = buildPlan(baseRecord(), geicoPa, {});
  // Vehicle 1 (row 1): VIN present -> Yes, VIN filled, Year/Make/Model/ABS/Body/Restraint ignored.
  assert.equal(byField(plan, 'Vehicle Information', 'YesNoPreQuoteHaveFullVinActivity', 1).value, 'Yes');
  assert.equal(byField(plan, 'Vehicle Information', 'GiveVinPreQuote', 1).value, '1HGCM82633A004352');
  assert.equal(byField(plan, 'Vehicle Information', 'GiveYear', 1).ignore, true);
  assert.equal(byField(plan, 'Vehicle Information', 'YesNoAntiLockBrakes', 1).ignore, true);
  assert.equal(byField(plan, 'Vehicle Information', 'GiveVehicleOwnerShip', 1).value, 'Financed');
  assert.equal(byField(plan, 'Vehicle Information', 'GiveLengthOfOwnership', 1).value, '2 months to 2 years');
  assert.equal(byField(plan, 'Vehicle Information', 'GiveVehiclePrimaryUse', 1).value, 'Commute');
  assert.equal(byField(plan, 'Vehicle Information', 'GiveDaysPerWeekCommute', 1).value, '5');
  assert.equal(byField(plan, 'Vehicle Information', 'GiveMilesOneWay', 1).value, '15');
  const miles1 = byField(plan, 'Vehicle Information', 'GiveAnnualMileage', 1);
  assert.deepEqual([miles1.value, miles1.replace, miles1.ignore], ['12,000 - 12,999', true, false]);

  // Vehicle 2 (row 2): blank annualMiles -> ignore: true (keep GEICO estimate, D9); 2021 + 3+ years -> '2 to 10 years'.
  assert.equal(byField(plan, 'Vehicle Information', 'GiveAnnualMileage', 2).ignore, true);
  assert.equal(byField(plan, 'Vehicle Information', 'GiveVehiclePrimaryUse', 2).value, 'Pleasure');
  assert.equal(byField(plan, 'Vehicle Information', 'GiveLengthOfOwnership', 2).value, '2 to 10 years');

  // Straddling ownership buckets stay with agent; "3+ years" / "3+years" maps to "2 to 10 years"
  // unconditionally (derived when vehicle age < 10, TNI standard geico-pa.ownership-length when >= 10 or year blank).
  assert.equal(geicoOwnershipLength({ year: 2020, ownedFor: 'Less than 6 months' }, new Date('2026-11-24')).source, 'fact');
  assert.equal(geicoOwnershipLength({ year: 2020, ownedFor: 'Less than 1 year' }, new Date('2026-11-24')).source, 'fact');
  assert.equal(geicoOwnershipLength({ year: 2020, ownedFor: '1 year - 3 years' }, new Date('2026-11-24')).source, 'fact');
  assert.equal(geicoOwnershipLength({ year: 2020, ownedFor: '2 years' }, new Date('2026-11-24')).source, 'fact');
  assert.deepEqual(geicoOwnershipLength({ year: 2021, ownedFor: '3+ years' }, new Date('2026-11-24')), { value: '2 to 10 years', source: 'derived', note: null });
  assert.deepEqual(geicoOwnershipLength({ year: 2012, ownedFor: '3+ years' }, new Date('2026-11-24')), { value: '2 to 10 years', source: 'standard', note: null });
  assert.deepEqual(geicoOwnershipLength({ year: 2012, ownedFor: '3+years' }, new Date('2026-11-24')), { value: '2 to 10 years', source: 'standard', note: null });
  assert.deepEqual(geicoOwnershipLength({ year: null, ownedFor: '3+ years' }, new Date('2026-11-24')), { value: '2 to 10 years', source: 'standard', note: null });
  const oldRec = baseRecord();
  oldRec.vehicles[1].year = 2012;
  oldRec.vehicles[1].ownedFor = '3+years';
  const oldOwn = byField(buildPlan(oldRec, geicoPa, {}), 'Vehicle Information', 'GiveLengthOfOwnership', 2);
  assert.deepEqual([oldOwn.value, oldOwn.source, oldOwn.tni], ['2 to 10 years', 'standard', 'geico-pa.ownership-length']);
  // Strictly inside a single GEICO bucket: unambiguous synonyms map cleanly.
  assert.equal(geicoOwnershipLength({ year: 2026, ownedFor: 'Not yet purchased' }, new Date('2026-11-24')).value, 'Not yet purchased');
  assert.equal(geicoOwnershipLength({ year: 2026, ownedFor: 'Less than 2 months' }, new Date('2026-11-24')).value, 'Less than 2 months');
  assert.equal(geicoOwnershipLength({ year: 2026, ownedFor: '1 month' }, new Date('2026-11-24')).value, 'Less than 2 months');
  assert.equal(geicoOwnershipLength({ year: 2024, ownedFor: '6 months - 2 years' }, new Date('2026-11-24')).value, '2 months to 2 years');
  assert.equal(geicoOwnershipLength({ year: 2024, ownedFor: '1-2 years' }, new Date('2026-11-24')).value, '2 months to 2 years');
  assert.equal(geicoOwnershipLength({ year: 2024, ownedFor: '1 year' }, new Date('2026-11-24')).value, '2 months to 2 years');
  assert.equal(geicoOwnershipLength({ year: 2024, ownedFor: '18 months' }, new Date('2026-11-24')).value, '2 months to 2 years');
  assert.equal(geicoOwnershipLength({ year: 2020, ownedFor: '3-5 years' }, new Date('2026-11-24')).value, '2 to 10 years');
  assert.equal(geicoOwnershipLength({ year: 2020, ownedFor: '5 years' }, new Date('2026-11-24')).value, '2 to 10 years');
  assert.equal(geicoOwnershipLength({ year: 2010, ownedFor: '10+ years' }, new Date('2026-11-24')).value, '10 or more years');
  assert.equal(geicoOwnershipLength({ year: 2010, ownedFor: '12 years' }, new Date('2026-11-24')).value, '10 or more years');

  // Mileage bands.
  assert.equal(geicoAnnualMileageBand(1500), '1,000 - 1,999');
  assert.equal(geicoAnnualMileageBand(29500), '29,000 - 29,999');
  assert.equal(geicoAnnualMileageBand(30000), '30,000+');
  assert.equal(geicoAnnualMileageBand('50,000+'), '30,000+');
  assert.equal(geicoAnnualMileageBand(500), null);

  // No-VIN vehicle (D10): No -> Year/Make/Model filled; ABS/Body/Restraint become agent facts.
  const noVin = baseRecord();
  noVin.vehicles[0].vin = null;
  const nvp = buildPlan(noVin, geicoPa, {});
  assert.equal(byField(nvp, 'Vehicle Information', 'YesNoPreQuoteHaveFullVinActivity', 1).value, 'No');
  assert.equal(byField(nvp, 'Vehicle Information', 'GiveVinPreQuote', 1).ignore, true);
  assert.equal(byField(nvp, 'Vehicle Information', 'GiveYear', 1).value, 2020);
  assert.equal(byField(nvp, 'Vehicle Information', 'GiveMake', 1).value, 'Honda');
  assert.equal(byField(nvp, 'Vehicle Information', 'GiveModel', 1).value, 'Accord');
  assert.equal(byField(nvp, 'Vehicle Information', 'YesNoAntiLockBrakes', 1).source, 'fact');

  // Actions: addVehicle2 present for 2 vehicles; addVehicle3 absent.
  assert.ok(byAction(plan, 'addVehicle2'));
  assert.equal(byAction(plan, 'addVehicle3'), undefined);
});

test('Driver Information maps education, employment (D12), standards (D11), Married auto-spawn guard, and All Drivers ack (D2)', () => {
  const plan = buildPlan(baseRecord(), geicoPa, {});
  // Driver 1 (row 1): first word only, Bachelor's -> Bachelors, Teacher -> Private/Self Employed, Industry/Occupation -> fact, Military -> Does Not Apply.
  assert.equal(byField(plan, 'Driver Information', 'GiveFirstName', 1).value, 'Jordan');
  assert.equal(byField(plan, 'Driver Information', 'GiveEducationLevel', 1).value, 'Bachelors');
  assert.equal(byField(plan, 'Driver Information', 'GiveEmploymentStatus', 1).value, 'A Private Company/Organization or Self Employed');
  assert.equal(byField(plan, 'Driver Information', 'GiveIndustry', 1).source, 'fact');
  assert.equal(byField(plan, 'Driver Information', 'GiveOccupationByIndustry', 1).source, 'fact');
  const mil1 = byField(plan, 'Driver Information', 'GiveGovernmentMilitaryAffiliation', 1);
  assert.deepEqual([mil1.value, mil1.source, mil1.tni], ['Does Not Apply', 'standard', 'geico-pa.military-gov']);
  assert.equal(byField(plan, 'Driver Information', 'GiveDriversLicenseStatus', 1).value, 'Active');
  assert.equal(byField(plan, 'Driver Information', 'YesNoDefensiveDriverCourse', 1).value, 'Yes');
  assert.equal(byField(plan, 'Driver Information', 'YesNoDefensiveDriverCourse', 1).source, 'derived');

  // Driver 2 (row 2): Some College -> fact; Retired -> Retired Private...; Insure -> Yes (standard).
  assert.equal(byField(plan, 'Driver Information', 'GiveEducationLevel', 2).source, 'fact');
  assert.equal(byField(plan, 'Driver Information', 'GiveEmploymentStatus', 2).value, 'Retired Private Company/Organization or Self Employed');
  assert.equal(byField(plan, 'Driver Information', 'GiveRelationshipToInsured', 2).value, 'Spouse');
  const ins2 = byField(plan, 'Driver Information', 'GiveDriverExclusionInsuredYesNo', 2);
  assert.deepEqual([ins2.value, ins2.source, ins2.tni], ['Yes', 'standard', 'geico-pa.driver-insure']);

  // Driver 3 (row 3): Student -> Full Time Student, GoodStudent Yes (derived), StudentAway No (standard).
  assert.equal(byField(plan, 'Driver Information', 'GiveEmploymentStatus', 3).value, 'I am a Full Time Student');
  assert.equal(byField(plan, 'Driver Information', 'YesNoGoodStudentDiscount', 3).value, 'Yes');
  assert.equal(byField(plan, 'Driver Information', 'GiveStudentAway', 3).value, 'No');
  assert.equal(byField(plan, 'Driver Information', 'GiveStudentAway', 3).source, 'standard');

  // All Drivers acknowledgement checked (standard, D2).
  const allDrv = byField(plan, 'Driver Information', 'GiveAllDriversAcknowledgement.Yes');
  assert.deepEqual([allDrv.value, allDrv.source, allDrv.tni], [true, 'standard', 'geico-pa.acknowledgements']);

  // Disabled and Currently in College stay with agent (D12).
  assert.equal(geicoEducationChoice('Currently in College').source, 'fact');
  assert.equal(geicoEducationChoice('PHD').value, 'PhD');
  assert.equal(geicoEmploymentChoice('Disabled').source, 'fact');
  assert.equal(geicoEmploymentChoice('Homemaker').value, 'I am Currently a Homemaker');
  assert.equal(geicoEmploymentChoice('Unemployed').value, 'Not Currently Employed');
  assert.equal(geicoEmploymentChoice('US Army Officer').source, 'fact');

  // addDriver2 waits for drivers[0].maritalStatus so Married auto-spawn runs first,
  // and is NOT immediate so an existing 2-column grid never marks maritalStatus consumed before filling it.
  const add2 = byAction(plan, 'addDriver2');
  assert.ok(add2);
  assert.equal(add2.immediate, false);
  assert.deepEqual(add2.after, ['drivers[0].maritalStatus']);
  assert.equal(add2.unlessSelector, '.ssp-grid table.table thead tr td:nth-of-type(3)');
  assert.ok(byAction(plan, 'addDriver3'));
  assert.equal(byAction(plan, 'addDriver4'), undefined);

  // Excluded driver in notes holds Insure this person? for that driver only.
  const excl = baseRecord();
  excl.notes.text = 'Exclude Casey from policy';
  const ep = buildPlan(excl, geicoPa, {});
  assert.equal(byField(ep, 'Driver Information', 'GiveDriverExclusionInsuredYesNo', 2).value, 'Yes');
  assert.equal(byField(ep, 'Driver Information', 'GiveDriverExclusionInsuredYesNo', 3).source, 'fact');
});

test('License History, Incidents, Groups, and Quote Summary coverages, actions, and premium (A1-A4, D4, D5, D13-D15)', () => {
  const plan = buildPlan(baseRecord(), geicoPa, {});
  // License History (D13, A3): substantial history derived; age & month first licensed are TNI standards.
  assert.equal(byField(plan, 'License History', 'SubstantialLicenseHistoryYesNo', 1).value, 'Yes');
  const age1 = byField(plan, 'License History', 'GiveAgeFirstLicensed', 1);
  assert.deepEqual([age1.value, age1.source, age1.tni], ['18', 'standard', 'geico-pa.license-age']);
  const age3 = byField(plan, 'License History', 'GiveAgeFirstLicensed', 3);
  assert.deepEqual([age3.value, age3.source, age3.tni], ['18', 'standard', 'geico-pa.license-age']);
  const mo3 = byField(plan, 'License History', 'MonthYearAgeFirstLicensed', 3);
  assert.deepEqual([mo3.kind, mo3.source, mo3.tni], ['pick-not', 'standard', 'geico-pa.license-month']);
  assert.deepEqual(mo3.value, { not: '^(?:please select|select)$' });

  // geicoAgeFirstLicensed edge cases: current-year birthday guard, non-US, out-of-bounds, missing.
  assert.equal(geicoAgeFirstLicensed({ dob: '04/10/2008', yearLicensed: 2024, licenseState: 'TN' }, new Date('2026-11-24')).value, '16');
  assert.equal(geicoAgeFirstLicensed({ dob: '04/10/2010', yearLicensed: 2026, licenseState: 'TN' }, new Date('2026-11-24')).value, '16');
  assert.equal(geicoAgeFirstLicensed({ dob: '12/15/2009', yearLicensed: 2026, licenseState: 'TN' }, new Date('2026-11-24')).value, '16');
  assert.equal(geicoAgeFirstLicensed({ dob: '11/28/2010', yearLicensed: 2026, licenseState: 'TN' }, new Date('2026-11-24')).value, '15');
  assert.equal(geicoAgeFirstLicensed({ dob: '07/09/2007', yearLicensed: 2025, licenseState: 'ON' }, new Date('2026-11-24')).source, 'fact');
  assert.equal(geicoAgeFirstLicensed({ dob: '07/09/2007', yearLicensed: 2018, licenseState: 'TN' }, new Date('2026-11-24')).source, 'fact');
  assert.equal(geicoAgeFirstLicensed({ dob: '07/09/2007', yearLicensed: 2028, licenseState: 'TN' }, new Date('2026-11-24')).source, 'fact');
  assert.equal(geicoAgeFirstLicensed({ dob: null, yearLicensed: 2025, licenseState: 'TN' }, new Date('2026-11-24')).source, 'fact');

  assert.equal(substantialLicenseHistory({ dob: '02/03/1985', yearLicensed: 2003, licenseState: 'TN' }, new Date('2026-11-24')).value, 'Yes');
  assert.equal(substantialLicenseHistory({ dob: '02/03/1985', yearLicensed: 2025, licenseState: 'TN' }, new Date('2026-11-24')).value, 'No');
  assert.equal(substantialLicenseHistory({ dob: '02/03/1985', yearLicensed: 2023, licenseState: 'TN' }, new Date('2026-11-24')).source, 'fact');
  assert.equal(substantialLicenseHistory({ dob: '02/03/1985', yearLicensed: 2003, licenseState: 'ON' }, new Date('2026-11-24')).source, 'fact');

  // Incidents (D5): no hold when clean; hold when notes mention ticket/accident.
  assert.equal(byAction(plan, 'incidentsReview'), undefined);
  const withTicket = baseRecord();
  withTicket.notes.text = 'Speeding ticket in 2024';
  assert.ok(byAction(buildPlan(withTicket, geicoPa, {}), 'incidentsReview'));

  // Groups (D14): standard Not a member unless notes mention a group.
  const grp = byField(plan, 'Groups or Organizations', 'GiveSponsoredMarketing');
  assert.deepEqual([grp.value, grp.source, grp.tni], ['Not a member of any of these organizations', 'standard', 'geico-pa.groups']);
  const withGroup = baseRecord();
  withGroup.notes.text = 'Member of BoatU.S.';
  assert.equal(byField(buildPlan(withGroup, geicoPa, {}), 'Groups or Organizations', 'GiveSponsoredMarketing').source, 'fact');

  // Quote Summary (A1, A2, D2, D4, D14, D15):
  const ph = byField(plan, 'Quote Summary', 'PrimaryHeader');
  assert.deepEqual([ph.value, ph.source, ph.tni], [true, 'standard', 'geico-pa.acknowledgements']);
  const bi = byLabel(plan, 'Quote Summary', '^Bodily Injury Liability\\b');
  const pd = byLabel(plan, 'Quote Summary', '^Property Damage Liability\\b');
  const umbi = byLabel(plan, 'Quote Summary', '^Uninsured Motorist Bodily Injury\\b');
  const umpd = byLabel(plan, 'Quote Summary', '^Uninsured Motorist Property Damage\\b');
  assert.deepEqual([bi.value, bi.replace], ['$100,000/$300,000', true]);
  assert.deepEqual([pd.value, pd.replace], ['$100,000', true]);
  assert.deepEqual([umbi.value, umbi.replace, umbi.ignore, umbi.source], ['$100,000/$300,000', 'lower', false, 'derived']);
  assert.deepEqual([umpd.value, umpd.replace, umpd.ignore, umpd.source], ['$100,000', 'lower', false, 'derived']);
  assert.equal(byLabel(plan, 'Quote Summary', '^Medical Payments\\b').ignore, true);
  const pcf = byLabel(plan, 'Quote Summary', '^Purchased Claim Forgiveness\\b');
  assert.deepEqual([pcf.value, pcf.source, pcf.tni, pcf.replace], ['I decline', 'standard', 'geico-pa.claim-forgiveness', true]);

  // Vehicle 1 fullCoverage=true -> Comp/Coll + ERS + RR (A2); Vehicle 2 fullCoverage=false -> I decline + ERS/RR ignored.
  assert.equal(byLabel(plan, 'Quote Summary', '^Comprehensive\\b', 1).value, '$500 deductible');
  assert.equal(byLabel(plan, 'Quote Summary', '^Collision\\b', 1).value, '$1,000 deductible');
  const ers1 = byLabel(plan, 'Quote Summary', '^Emergency Road Service\\b', 1);
  const rr1 = byLabel(plan, 'Quote Summary', '^Rental Reimbursement\\b', 1);
  assert.deepEqual([ers1.value, ers1.source, ers1.tni, ers1.replace, ers1.ignore], ['I accept this coverage', 'standard', 'geico-pa.full-coverage-ers', true, false]);
  assert.deepEqual([rr1.value, rr1.source, rr1.tni, rr1.replace, rr1.ignore], ['$50/day, $1,500 max per claim', 'standard', 'geico-pa.full-coverage-rental', true, false]);
  assert.equal(byLabel(plan, 'Quote Summary', '^Comprehensive\\b', 2).value, 'I decline');
  assert.equal(byLabel(plan, 'Quote Summary', '^Collision\\b', 2).value, 'I decline');
  assert.equal(byLabel(plan, 'Quote Summary', '^Emergency Road Service\\b', 2).ignore, true);
  assert.equal(byLabel(plan, 'Quote Summary', '^Rental Reimbursement\\b', 2).ignore, true);

  // Full coverage without active Comp/Coll deductibles keeps ERS/RR ignored while Comp/Coll hold for agent.
  const noDed = baseRecord();
  noDed.coverage.compDeductible = null;
  const ndp = buildPlan(noDed, geicoPa, {});
  assert.equal(byLabel(ndp, 'Quote Summary', '^Emergency Road Service\\b', 1).ignore, true);
  assert.equal(byLabel(ndp, 'Quote Summary', '^Rental Reimbursement\\b', 1).ignore, true);

  // Unoffered deductibles ($750, $2,000, $2,000 w/$50 Glass) stay agent facts (D15).
  const unoffered = baseRecord();
  unoffered.coverage.compDeductible = '$2,000 w/$50 Glass';
  unoffered.coverage.collDeductible = '$750';
  const uop = buildPlan(unoffered, geicoPa, {});
  assert.equal(byLabel(uop, 'Quote Summary', '^Comprehensive\\b', 1).source, 'fact');
  assert.equal(byLabel(uop, 'Quote Summary', '^Collision\\b', 1).source, 'fact');

  // State Minimum or less uses pick-not on BI, PD, UMBI, UMPD; CSL stays with agent (D15, A1).
  const minRec = baseRecord();
  minRec.coverage.liabilityLimit = 'State Minimum or less';
  const mp = buildPlan(minRec, geicoPa, {});
  assert.equal(byLabel(mp, 'Quote Summary', '^Bodily Injury Liability\\b').kind, 'pick-not');
  assert.equal(byLabel(mp, 'Quote Summary', '^Property Damage Liability\\b').kind, 'pick-not');
  assert.deepEqual([byLabel(mp, 'Quote Summary', '^Uninsured Motorist Bodily Injury\\b').kind, byLabel(mp, 'Quote Summary', '^Uninsured Motorist Bodily Injury\\b').replace], ['pick-not', 'lower']);
  assert.deepEqual([byLabel(mp, 'Quote Summary', '^Uninsured Motorist Property Damage\\b').kind, byLabel(mp, 'Quote Summary', '^Uninsured Motorist Property Damage\\b').replace], ['pick-not', 'lower']);
  const cslRec = baseRecord();
  cslRec.coverage.liabilityLimit = '300 CSL';
  const cp = buildPlan(cslRec, geicoPa, {});
  assert.equal(byLabel(cp, 'Quote Summary', '^Bodily Injury Liability\\b').source, 'fact');
  assert.equal(byLabel(cp, 'Quote Summary', '^Property Damage Liability\\b').source, 'fact');
  assert.equal(byLabel(cp, 'Quote Summary', '^Uninsured Motorist Bodily Injury\\b').ignore, true);
  assert.equal(byLabel(cp, 'Quote Summary', '^Uninsured Motorist Property Damage\\b').ignore, true);

  // Quote Summary actions: editCoverages (once), recalculate (sticky-bar within, quietMs 2000, keepAnswers, reopen Edit, once), printProposal (kitClick, once).
  const editAct = byAction(plan, 'editCoverages');
  const recalcAct = byAction(plan, 'recalculate');
  const printAct = byAction(plan, 'printProposal');
  assert.equal(editAct?.once, true);
  assert.equal(editAct?.immediate, true);
  assert.equal(recalcAct?.once, true);
  assert.equal(recalcAct?.within, 'gds-sticky-bar');
  assert.equal(recalcAct?.quietMs, 2000);
  assert.equal(recalcAct?.keepAnswers, true);
  assert.equal(recalcAct?.reopen, '^edit$');
  assert.equal(recalcAct?.ratedBy, null);
  assert.equal(printAct?.kitClick, true);
  assert.equal(printAct?.needsPremium, true);

  // Premium detection on Quote Summary.
  assert.equal(premiumHere(geicoPa, '/quote', 'Quote Summary'), true);
  assert.equal(premiumHere(geicoPa, '/quote', 'Driver Information'), false);
  assert.equal(readPremium('Quote $175.10 Due Today $1,051.00 Total')?.total, 1051);
});

test('locator row matching pairs multi-column grid, License History, and per-vehicle Quote Summary controls deterministically', () => {
  const squash = (/** @type {any} */ s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let activeStep = 'Driver Information';
  const { assign } = createLocator({
    squash,
    humanize: (/** @type {any} */ s) => String(s ?? ''),
    STATE_NAMES: {},
    isPlaceholderOption: () => false,
    optionsOf: () => [],
    safeMatches: () => false,
    shownControl: () => null,
    unitFormsOf: () => [],
    stepIs: (/** @type {string[]} */ steps, /** @type {string} */ now) => steps.includes(now),
    stepKey: () => activeStep,
    currentPage: () => '/quote',
    extraRowKeys: new Map(),
  });
  const plan = buildPlan(baseRecord(), geicoPa, {});

  // 1. License History: Driver 1 has SubstantialLicenseHistoryYesNo (row 1), Driver 3 has GiveAgeFirstLicensed (row 3).
  // Without row matching, Driver 1's GiveAgeFirstLicensed rule would steal Driver 3's control.
  activeStep = 'License History';
  const licControls = [
    { ref: 'SubstantialLicenseHistoryYesNo', row: '1', kind: 'radio', text: 'were you licensed before turning 38', q: null, el: {} },
    { ref: 'GiveAgeFirstLicensed', row: '3', kind: 'text', text: 'how old was this driver', q: null, el: {} },
  ];
  const licPairs = assign(licControls, plan);
  assert.equal(licPairs.length, 2);
  assert.equal(licPairs.find((/** @type {any} */ p) => p.control === licControls[0]).step.row, '1');
  assert.equal(licPairs.find((/** @type {any} */ p) => p.control === licControls[0]).step.value, 'Yes');
  assert.equal(licPairs.find((/** @type {any} */ p) => p.control === licControls[1]).step.row, '3');
  assert.equal(licPairs.find((/** @type {any} */ p) => p.control === licControls[1]).step.name, 'Driver 3: age first licensed in the U.S.');

  // 2. Quote Summary: policy-level BI (row: null) + 2 vehicles' Comprehensive (row: '1', '2') with tooltip text in label.
  activeStep = 'Quote Summary';
  const qsControls = [
    { ref: null, row: null, kind: 'select', text: 'bodily injury liability bi bi tooltip', q: null, el: {} },
    { ref: null, row: '1', kind: 'select', text: 'comprehensive excluding collision', q: null, el: {} },
    { ref: null, row: '2', kind: 'select', text: 'comprehensive excluding collision', q: null, el: {} },
  ];
  const qsPairs = assign(qsControls, plan);
  assert.equal(qsPairs.length, 3);
  assert.equal(qsPairs.find((/** @type {any} */ p) => p.control === qsControls[0]).step.value, '$100,000/$300,000');
  assert.equal(qsPairs.find((/** @type {any} */ p) => p.control === qsControls[1]).step.value, '$500 deductible');
  assert.equal(qsPairs.find((/** @type {any} */ p) => p.control === qsControls[2]).step.value, 'I decline');
});

test('addDriver2 fills blank Driver 1 GiveMaritalStatus on an already-2-column grid and never clicks before Marital Status on a 1-column grid', async () => {
  /**
   * Builds a minimal Driver Information grid in jsdom with real pagekit + geico-pa adapter.
   * @param {{ twoColumns: boolean, onAddClick?: (doc: Document) => void }} opts
   */
  const mountDriverGrid = ({ twoColumns, onAddClick }) => {
    const html = `<!doctype html><html><head><title>GEICO</title></head><body>
      <gds-vertical-stepper>
        <gds-vertical-stepper-item state="current">Driver Information</gds-vertical-stepper-item>
      </gds-vertical-stepper>
      <div class="ssp-grid">
        <table class="table">
          <thead>
            <tr>
              <td></td>
              <td>Driver 1</td>
              ${twoColumns ? '<td>Driver 2</td>' : ''}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="row-header">Marital Status</td>
              <td>
                <select id="Id_GiveMaritalStatus_101" name="Id_GiveMaritalStatus_101">
                  <option value="">-- Select --</option>
                  <option value="M">Married</option>
                  <option value="S">Single</option>
                </select>
              </td>
              ${twoColumns ? '<td><input id="Id_GiveFirstName_201" name="Id_GiveFirstName_201" type="text" value=""></td>' : ''}
            </tr>
          </tbody>
        </table>
      </div>
      <button id="add-drv-btn" type="button">Add Driver</button>
    </body></html>`;
    const dom = new JSDOM(html, { url: 'https://sales.geico.com/quote', runScripts: 'outside-only' });
    const win = /** @type {any} */ (dom.window);
    // Register the gds-* custom elements so pagekit's `components: 'gds-'` upgrade check passes immediately.
    for (const tag of ['gds-vertical-stepper', 'gds-vertical-stepper-item']) {
      if (!win.customElements.get(tag)) win.customElements.define(tag, class extends win.HTMLElement {});
    }
    // JSDOM has zero layout rects by default; expose non-zero boxes so pagekit treats controls as visible.
    const box = { width: 120, height: 24, top: 10, left: 10, right: 130, bottom: 34, x: 10, y: 10 };
    win.HTMLElement.prototype.getBoundingClientRect = () => box;
    win.HTMLElement.prototype.getClientRects = () => [box];
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.Element.prototype.checkVisibility = () => true;
    let addClicks = 0;
    const addBtn = dom.window.document.getElementById('add-drv-btn');
    addBtn?.addEventListener('click', () => {
      addClicks++;
      onAddClick?.(dom.window.document);
    });
    const ctx = dom.getInternalVMContext();
    vm.runInContext(FIELD_KEY, ctx);
    vm.runInContext(GEICO_PA_ADAPTER, ctx);
    vm.runInContext(PAGEKIT, ctx);
    return { dom, win, getAddClicks: () => addClicks };
  };

  // Case 1: 2-column grid already present (e.g. revisit) with blank Driver 1 GiveMaritalStatus.
  // Must fill GiveMaritalStatus (not skipped by consumedPaths) AND not click Add Driver.
  {
    const rec = baseRecord();
    rec.drivers = rec.drivers.slice(0, 2);
    const plan = buildPlan(rec, geicoPa, {});
    const { dom, win, getAddClicks } = mountDriverGrid({ twoColumns: true });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
    const ms = /** @type {HTMLSelectElement} */ (dom.window.document.getElementById('Id_GiveMaritalStatus_101'));
    const fn2 = /** @type {HTMLInputElement} */ (dom.window.document.getElementById('Id_GiveFirstName_201'));
    assert.equal(ms.value, 'M');
    assert.equal(fn2.value, 'Alex');
    assert.equal(getAddClicks(), 0);
    assert.ok(report.filled.some((/** @type {any} */ f) => f.path === 'drivers[0].maritalStatus'));
    dom.window.close();
  }

  // Case 2: 1-column grid where Driver 1 is Single (no auto-spawn): fills GiveMaritalStatus first,
  // then clicks Add Driver once to spawn column 2 and fills Driver 2.
  {
    const rec = baseRecord();
    rec.drivers = rec.drivers.slice(0, 2);
    rec.drivers[0].maritalStatus = 'Single';
    const plan = buildPlan(rec, geicoPa, {});
    /** @type {string[]} */
    const events = [];
    const { dom, win, getAddClicks } = mountDriverGrid({
      twoColumns: false,
      onAddClick: (doc) => {
        const ms = /** @type {HTMLSelectElement} */ (doc.getElementById('Id_GiveMaritalStatus_101'));
        events.push(`addDriver(ms=${ms.value})`);
        const headTr = doc.querySelector('.ssp-grid table.table thead tr');
        const tdH = doc.createElement('td');
        tdH.textContent = 'Driver 2';
        headTr?.appendChild(tdH);
        const bodyTr = doc.querySelector('.ssp-grid table.table tbody tr');
        const tdB = doc.createElement('td');
        tdB.innerHTML = '<input id="Id_GiveFirstName_201" name="Id_GiveFirstName_201" type="text" value="">';
        bodyTr?.appendChild(tdB);
      },
    });
    await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
    assert.equal(getAddClicks(), 1);
    assert.deepEqual(events, ['addDriver(ms=S)']);
    const fn2 = /** @type {HTMLInputElement | null} */ (dom.window.document.getElementById('Id_GiveFirstName_201'));
    assert.equal(fn2?.value, 'Alex');
    dom.window.close();
  }

  // Case 3: 1-column grid where Driver 1 maritalStatus is missing on intake:
  // Add Driver must NOT click while GiveMaritalStatus is unanswered.
  {
    const rec = baseRecord();
    rec.drivers = rec.drivers.slice(0, 2);
    rec.drivers[0].maritalStatus = null;
    const plan = buildPlan(rec, geicoPa, {});
    const { dom, win, getAddClicks } = mountDriverGrid({ twoColumns: false });
    await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
    assert.equal(getAddClicks(), 0);
    dom.window.close();
  }
});

/**
 * Mounts a synthetic GEICO PA JSDOM page with real pagekit + geico-pa adapter + GDS custom elements.
 * @param {string} html
 * @param {string} [url]
 */
function mountGeicoPaDom(html, url = 'https://sales.geico.com/quote') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const win = /** @type {any} */ (dom.window);
  for (const tag of [
    'gds-vertical-stepper',
    'gds-vertical-stepper-item',
    'gds-button',
    'gds-sticky-bar',
    'gds-label-legend',
    'gds-section-header',
    'gds-card-selections',
    'gds-card-selections-card',
    'gds-card',
  ]) {
    if (!win.customElements.get(tag)) win.customElements.define(tag, class extends win.HTMLElement {});
  }
  const box = { width: 120, height: 24, top: 10, left: 10, right: 130, bottom: 34, x: 10, y: 10 };
  const hiddenByClass = (/** @type {Element} */ el) => !!el.closest?.('.hide, [hidden]') || /** @type {HTMLElement} */ (el).style?.display === 'none';
  win.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return hiddenByClass(this) ? { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0 } : box;
  };
  win.HTMLElement.prototype.getClientRects = function getClientRects() {
    return hiddenByClass(this) ? [] : [box];
  };
  win.HTMLElement.prototype.scrollIntoView = () => {};
  win.Element.prototype.checkVisibility = function checkVisibility() {
    return !hiddenByClass(this);
  };
  // JSDOM omits HTMLElement.prototype.innerText; compute visible text skipping .hide / [hidden] subtrees.
  Object.defineProperty(win.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      /** @param {Node} node @returns {string} */
      const walk = (node) => {
        if (node.nodeType === 3) return node.nodeValue ?? '';
        if (node.nodeType !== 1) return '';
        const el = /** @type {HTMLElement} */ (node);
        if (el.classList?.contains('hide') || el.hasAttribute('hidden') || el.style?.display === 'none') return '';
        return [...el.childNodes].map(walk).join(' ');
      };
      return walk(this).replace(/\s+/g, ' ').trim();
    },
  });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(FIELD_KEY, ctx);
  vm.runInContext(GEICO_PA_ADAPTER, ctx);
  vm.runInContext(PAGEKIT, ctx);
  return { dom, win };
}

/**
 * Builds an interactive Quote Summary JSDOM page mirroring live GEICO PA's collapsed/Edit toggle,
 * top + sticky-bar Recalculate buttons, PrimaryHeader visibility, and optional silent-revert / error behavior.
 * @param {{
 *   initial?: Record<string, string>,
 *   silentRevert?: boolean,
 *   errorAfterRecalc?: string | null,
 * }} [opts]
 */
function mountQuoteSummary({ initial = {}, silentRevert = false, errorAfterRecalc = null } = {}) {
  const defaults = {
    bi: '$50,000/$100,000',
    pd: '$50,000',
    med: 'I decline',
    umbi: '$50,000/$100,000',
    umpd: '$50,000',
    pcf: 'I decline',
    v1Comp: '$500 deductible',
    v1Coll: '$1,000 deductible',
    v1Ers: 'I decline',
    v1Rr: 'I decline',
    v2Comp: 'I decline',
    v2Coll: 'I decline',
    v2Ers: 'I decline',
    v2Rr: 'I decline',
    ...initial,
  };
  /** @type {Record<string, string>} */
  const persisted = { ...defaults };
  /** @type {Record<string, string>} */
  let draft = { ...defaults };
  let expanded = false;
  let stale = false;
  let totalText = '$1,102.00';
  let renderSeq = 1;
  /** @type {string[]} */
  const clicks = [];

  const html = `<!doctype html><html><head><title>GEICO</title></head><body>
    <gds-vertical-stepper>
      <gds-vertical-stepper-item state="current">Quote Summary</gds-vertical-stepper-item>
    </gds-vertical-stepper>
    <div id="top-recalc-wrap" class="button-group-center-stacked hide">
      <gds-button id="top-recalc" type="button"><button type="button">Recalculate</button></gds-button>
    </div>
    <div id="sticky-print-wrap">
      <gds-sticky-bar position="bottom">
        <div class="left-content">
          <div class="left"><h3>Quote</h3></div>
          <div class="right"><p>$185.00</p><h5>Due Today</h5></div>
        </div>
        <div class="right-content">
          <div class="left"><p id="total-amt">${totalText}</p><h5>Total</h5></div>
          <div class="right"><gds-button id="print-btn" type="button" target="_blank" href="/PrintQuote?quote=mock"><a href="/PrintQuote?quote=mock" target="_blank">Print Quote Proposal</a></gds-button></div>
        </div>
      </gds-sticky-bar>
    </div>
    <div id="sticky-recalc-wrap" class="hide">
      <gds-sticky-bar position="bottom">
        <div class="right-content">
          <div class="left"><p>$ --.--</p><h5>Total</h5></div>
          <div class="right"><gds-button id="sticky-recalc" type="button"><button type="button">Recalculate</button></gds-button></div>
        </div>
      </gds-sticky-bar>
    </div>
    <div id="edit-wrap"><gds-button id="edit-btn" type="button"><button type="button">Edit</button></gds-button></div>
    <div id="primary-wrap">
      <input type="checkbox" id="checkbox-Id_PrimaryHeader_1-" name="Id_PrimaryHeader_1">
      <label for="checkbox-Id_PrimaryHeader_1-">Please confirm that you advised the customer.</label>
    </div>
    <span id="cov-error" class="form-message"></span>
    <div id="cov-container"></div>
    <gds-button id="next-btn" type="button"><button type="button">Next</button></gds-button>
  </body></html>`;

  const { dom, win } = mountGeicoPaDom(html);
  const doc = dom.window.document;

  /** @param {string} key @param {string} label @param {string[]} opts */
  const mkSelect = (key, label, opts) => {
    const uid = `Id_00000000-0000-0000-0000-${String(renderSeq++).padStart(12, '0')}_100`;
    const wrap = doc.createElement('div');
    wrap.className = 'coverage-form-field-wrapper';
    const lbl = doc.createElement('gds-label-legend');
    lbl.setAttribute('for', uid);
    lbl.textContent = label;
    const sel = doc.createElement('select');
    sel.id = uid;
    for (const o of ['Please Select', ...opts]) {
      const opt = doc.createElement('option');
      opt.value = o === 'Please Select' ? '' : o;
      opt.textContent = o;
      if (o === draft[key]) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      draft[key] = sel.value;
      stale = true;
      syncChrome();
    });
    wrap.appendChild(lbl);
    wrap.appendChild(sel);
    return wrap;
  };

  const syncChrome = () => {
    doc.getElementById('top-recalc-wrap')?.classList.toggle('hide', !stale);
    doc.getElementById('sticky-recalc-wrap')?.classList.toggle('hide', !stale);
    doc.getElementById('sticky-print-wrap')?.classList.toggle('hide', stale);
    doc.getElementById('primary-wrap')?.classList.toggle('hide', stale);
    doc.getElementById('edit-wrap')?.classList.toggle('hide', expanded);
    const totalEl = doc.getElementById('total-amt');
    if (totalEl) totalEl.textContent = totalText;
  };

  const renderCoverages = () => {
    const c = doc.getElementById('cov-container');
    if (!c) return;
    c.innerHTML = '';
    if (!expanded) return;
    const biOpts = ['$25,000/$50,000', '$50,000/$100,000', '$100,000/$300,000', '$300,000/$300,000', '$250,000/$500,000', '$500,000/$500,000'];
    const pdOpts = ['$25,000', '$50,000', '$100,000', '$250,000'];
    const dedOpts = ['$50 deductible', '$100 deductible', '$250 deductible', '$500 deductible', '$1,000 deductible', '$2,500 deductible', 'I decline'];
    const ersOpts = ['I accept this coverage', 'I decline'];
    const rrOpts = ['I decline', '$35/day, $1,050 max per claim', '$50/day, $1,500 max per claim', '$75/day, $2,250 max per claim'];
    c.appendChild(mkSelect('bi', 'Bodily Injury Liability (BI)', biOpts));
    c.appendChild(mkSelect('pd', 'Property Damage Liability (PD)', pdOpts));
    c.appendChild(mkSelect('med', 'Medical Payments (MED)', ['I decline', '$1,000', '$5,000', '$10,000']));
    c.appendChild(mkSelect('umbi', 'Uninsured Motorist Bodily Injury', ['I decline', ...biOpts]));
    c.appendChild(mkSelect('umpd', 'Uninsured Motorist Property Damage', ['I decline', '$25,000', '$50,000', '$100,000']));
    c.appendChild(mkSelect('pcf', 'Purchased Claim Forgiveness', ['I decline', 'I accept']));

    const h1 = doc.createElement('div');
    h1.innerHTML = '<gds-section-header>2020 Honda Accord 1HGCM82633A004352</gds-section-header>';
    c.appendChild(h1);
    c.appendChild(mkSelect('v1Comp', 'Comprehensive (Excluding Collision)', dedOpts));
    c.appendChild(mkSelect('v1Coll', 'Collision (COLL)', ['I decline', ...dedOpts.slice(0, -1)]));
    c.appendChild(mkSelect('v1Ers', 'Emergency Road Service (ERS)', ersOpts));
    c.appendChild(mkSelect('v1Rr', 'Rental Reimbursement (RR)', rrOpts));

    const h2 = doc.createElement('div');
    h2.innerHTML = '<gds-section-header>2021 Toyota Corolla 1HGCM82633A004353</gds-section-header>';
    c.appendChild(h2);
    c.appendChild(mkSelect('v2Comp', 'Comprehensive (Excluding Collision)', dedOpts));
    c.appendChild(mkSelect('v2Coll', 'Collision (COLL)', ['I decline', ...dedOpts.slice(0, -1)]));
    c.appendChild(mkSelect('v2Ers', 'Emergency Road Service (ERS)', ersOpts));
    c.appendChild(mkSelect('v2Rr', 'Rental Reimbursement (RR)', rrOpts));
  };

  doc.querySelector('#edit-btn button')?.addEventListener('click', () => {
    clicks.push('edit');
    expanded = true;
    draft = { ...persisted };
    renderCoverages();
    syncChrome();
  });

  doc.querySelector('#top-recalc button')?.addEventListener('click', () => {
    clicks.push('top-recalc');
  });

  doc.querySelector('#sticky-recalc button')?.addEventListener('click', () => {
    clicks.push('sticky-recalc');
    if (!silentRevert) Object.assign(persisted, draft);
    draft = { ...persisted };
    stale = false;
    expanded = false;
    totalText = silentRevert ? '$1,102.00' : '$1,257.00';
    const errEl = doc.getElementById('cov-error');
    if (errEl) errEl.textContent = errorAfterRecalc ?? '';
    renderCoverages();
    syncChrome();
  });

  doc.querySelector('#print-btn a')?.addEventListener('click', (e) => {
    e.preventDefault();
    clicks.push('print');
  });

  doc.querySelector('#next-btn button')?.addEventListener('click', () => {
    clicks.push('next');
  });

  syncChrome();
  return { dom, win, persisted, clicks };
}

test('Quote Summary lowers UMBI/UMPD only when higher, sets full-cov ERS/RR, clicks sticky-bar Recalculate, verifies via Edit, then prints (S1, A1, A2)', async () => {
  // 1. Happy path: BI/PD lowered to 25/50/25 -> lowers UMBI & UMPD to match; Vehicle 1 (fullCoverage=true,
  //    even though Comp/Coll already match GEICO defaults!) gets ERS + RR; Vehicle 2 (liability only) keeps I decline.
  //    Clicks sticky-bar Recalculate (NOT top), re-opens Edit to verify persisted values, checks PrimaryHeader, clicks Print.
  {
    const rec = baseRecord();
    rec.coverage = { liabilityLimit: '25/50/25', compDeductible: '$500', collDeductible: '$1,000' };
    const plan = buildPlan(rec, geicoPa, {});
    const { dom, win, persisted, clicks } = mountQuoteSummary();
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance, premiumPages: geicoPa.premiumPages });
    assert.equal(persisted.bi, '$25,000/$50,000');
    assert.equal(persisted.pd, '$25,000');
    assert.equal(persisted.umbi, '$25,000/$50,000');
    assert.equal(persisted.umpd, '$25,000');
    assert.equal(persisted.v1Ers, 'I accept this coverage');
    assert.equal(persisted.v1Rr, '$50/day, $1,500 max per claim');
    assert.equal(persisted.v2Ers, 'I decline');
    assert.equal(persisted.v2Rr, 'I decline');
    assert.deepEqual(clicks, ['edit', 'sticky-recalc', 'edit', 'print']);
    assert.ok(!clicks.includes('top-recalc'), 'must click sticky-bar Recalculate, never top button');
    assert.ok(!clicks.includes('next'), 'Quote Summary must never auto-advance Next');
    assert.equal(report.failed.length, 0);
    assert.equal(report.documentPending, true);
    assert.equal(report.openDocumentUrl, undefined, 'without openDownloadInPanel, link is clicked in-page');
    assert.equal(report.premium?.total, 1257);
    dom.window.close();
  }

  // 1b. With openDownloadInPanel: true (MAIN-world extension path), Print Quote Proposal returns
  //     openDocumentUrl instead of calling a.click() in page world (avoiding Chrome popup blocker
  //     and double tabs), while still recording printProposal and documentPending.
  {
    const rec = baseRecord();
    rec.coverage = { liabilityLimit: '25/50/25', compDeductible: '$500', collDeductible: '$1,000' };
    const plan = buildPlan(rec, geicoPa, {});
    const recalcStep = byAction(plan, 'recalculate');
    if (recalcStep) recalcStep.quietMs = 30;
    const { dom, win, clicks } = mountQuoteSummary();
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance, premiumPages: geicoPa.premiumPages, openDownloadInPanel: true });
    assert.deepEqual(clicks, ['edit', 'sticky-recalc', 'edit'], 'must not call a.click() in MAIN world when openDownloadInPanel is true');
    assert.equal(report.openDocumentUrl, 'https://sales.geico.com/PrintQuote?quote=mock');
    assert.equal(report.documentPending, true);
    assert.ok(report.actions.some((/** @type {any} */ a) => a.id === 'printProposal'));
    assert.equal(report.failed.length, 0);
    dom.window.close();
  }

  // 2. Silent revert trap (098e): Recalculate collapses selects and silently reverts edits ->
  //    answersKept re-opens Edit, detects revert, rejects premium, and BLOCKS Print Quote Proposal!
  {
    const rec = baseRecord();
    rec.coverage = { liabilityLimit: '25/50/25', compDeductible: '$500', collDeductible: '$1,000' };
    const plan = buildPlan(rec, geicoPa, {});
    const recalcStep = byAction(plan, 'recalculate');
    if (recalcStep) recalcStep.quietMs = 30;
    const { dom, win, clicks } = mountQuoteSummary({ silentRevert: true });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance, premiumPages: geicoPa.premiumPages, openDownloadInPanel: true });
    assert.ok(clicks.includes('sticky-recalc'));
    assert.ok(!clicks.includes('print'), 'Print Quote Proposal must be blocked when Recalculate silently reverts edits');
    assert.equal(report.openDocumentUrl, undefined, 'openDocumentUrl must not be returned when Recalculate silently reverts');
    assert.equal(report.premium, undefined);
    assert.ok(report.failed.some((/** @type {any} */ f) => f.code === 'answer.changed'));
    dom.window.close();
  }

  // 3. Error banner (.form-message) after Recalculate rejects premium and blocks Print Quote Proposal.
  {
    const rec = baseRecord();
    rec.coverage = { liabilityLimit: '25/50/25', compDeductible: '$500', collDeductible: '$1,000' };
    const plan = buildPlan(rec, geicoPa, {});
    const recalcStep = byAction(plan, 'recalculate');
    if (recalcStep) recalcStep.quietMs = 30;
    const { dom, win, clicks } = mountQuoteSummary({ errorAfterRecalc: 'Uninsured Motorist limit cannot exceed Liability limit.' });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance, premiumPages: geicoPa.premiumPages, openDownloadInPanel: true });
    assert.ok(!clicks.includes('print'), 'Print Quote Proposal must be blocked when .form-message error is visible');
    assert.equal(report.openDocumentUrl, undefined, 'openDocumentUrl must not be returned when .form-message error is visible');
    assert.equal(report.premium, undefined);
    assert.ok(report.failed.some((/** @type {any} */ f) => f.code === 'answer.changed'));
    dom.window.close();
  }

  // 4. replace: 'lower' never raises UMBI/UMPD, never turns "I decline" into coverage, handles PD > UMPD max,
  //    and lowers UMBI/UMPD under State Minimum or less while preserving "I decline".
  {
    const rec = baseRecord();
    rec.coverage = { liabilityLimit: '250/500/250', compDeductible: '$500', collDeductible: '$1,000' };
    const plan = buildPlan(rec, geicoPa, {});
    const recalcStep = byAction(plan, 'recalculate');
    if (recalcStep) recalcStep.quietMs = 30;
    const { dom, win, persisted, clicks } = mountQuoteSummary({ initial: { umbi: '$50,000/$100,000', umpd: '$50,000' } });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, premiumPages: geicoPa.premiumPages });
    assert.equal(persisted.bi, '$250,000/$500,000');
    assert.equal(persisted.pd, '$250,000');
    assert.equal(persisted.umbi, '$50,000/$100,000', 'never raises UMBI');
    assert.equal(persisted.umpd, '$50,000', 'never raises UMPD and never fails when PD exceeds UMPD max');
    assert.equal(report.failed.length, 0);
    assert.ok(clicks.includes('print'));
    dom.window.close();
  }
  {
    const rec = baseRecord();
    rec.coverage = { liabilityLimit: 'State Minimum or less', compDeductible: '$500', collDeductible: '$1,000' };
    const plan = buildPlan(rec, geicoPa, {});
    const recalcStep = byAction(plan, 'recalculate');
    if (recalcStep) recalcStep.quietMs = 30;
    const { dom, win, persisted, clicks } = mountQuoteSummary({ initial: { umbi: 'I decline', umpd: '$50,000' } });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, premiumPages: geicoPa.premiumPages });
    assert.equal(persisted.bi, '$25,000/$50,000');
    assert.equal(persisted.pd, '$25,000');
    assert.equal(persisted.umbi, 'I decline', 'State Minimum must never turn "I decline" into UMBI coverage');
    assert.equal(persisted.umpd, '$25,000', 'State Minimum lowers UMPD from $50,000 to $25,000');
    assert.equal(report.failed.length, 0);
    assert.ok(clicks.includes('print'));
    dom.window.close();
  }
});

test('License History fills calculated GiveAgeFirstLicensed and picks earliest MonthYearAgeFirstLicensed on follow-up pass (A3)', async () => {
  const html = `<!doctype html><html><head><title>GEICO</title></head><body>
    <gds-vertical-stepper>
      <gds-vertical-stepper-item state="current">License History</gds-vertical-stepper-item>
    </gds-vertical-stepper>
    <form id="salesForm">
      <div><gds-section-header>License History</gds-section-header></div>
      <div><gds-section-header>Jordan Sample</gds-section-header></div>
      <div><gds-section-header>Alex Sample</gds-section-header></div>
      <div id="drv3-sec">
        <gds-section-header>Casey Sample</gds-section-header>
        <div class="form-field">
          <gds-label-legend for="Id_GiveAgeFirstLicensed_301">How old was this driver when they got their driver's license in the U.S.?</gds-label-legend>
          <input id="Id_GiveAgeFirstLicensed_301" name="Id_GiveAgeFirstLicensed_301" type="tel" value="">
        </div>
        <div id="month-host"></div>
      </div>
      <gds-button type="button"><button type="button">Save and Continue</button></gds-button>
    </form>
  </body></html>`;
  const { dom, win } = mountGeicoPaDom(html);
  const doc = dom.window.document;
  let advanced = false;
  doc.querySelector('gds-button button')?.addEventListener('click', () => { advanced = true; });
  doc.getElementById('Id_GiveAgeFirstLicensed_301')?.addEventListener('change', () => {
    const host = doc.getElementById('month-host');
    if (host && !doc.getElementById('Id_MonthYearAgeFirstLicensed_302')) {
      host.innerHTML = `<div class="form-field">
        <gds-label-legend for="Id_MonthYearAgeFirstLicensed_302">When did Casey first obtain their license in the U.S.?</gds-label-legend>
        <select id="Id_MonthYearAgeFirstLicensed_302" name="Id_MonthYearAgeFirstLicensed_302">
          <option value="">Please Select</option>
          <option value="07/2025">July 2025</option>
          <option value="08/2025">August 2025</option>
        </select>
      </div>`;
    }
  });
  const plan = buildPlan(baseRecord(), geicoPa, {});
  const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance });
  const ageInput = /** @type {HTMLInputElement} */ (doc.getElementById('Id_GiveAgeFirstLicensed_301'));
  const monthSel = /** @type {HTMLSelectElement | null} */ (doc.getElementById('Id_MonthYearAgeFirstLicensed_302'));
  assert.equal(ageInput.value, '18');
  assert.equal(monthSel?.value, '07/2025');
  assert.equal(report.blockers.length, 0);
  assert.equal(advanced, true, 'clear License History auto-advances via Save and Continue');
  assert.equal(report.advanced, 'Save and Continue');
  dom.window.close();
});

test('Select Drivers with Incidents auto-advances when clean, holds on incident notes, and Vehicle Prefill selects AddVehicle and auto-advances', async () => {
  const incidentsHtml = `<!doctype html><html><head><title>GEICO</title></head><body>
    <gds-vertical-stepper>
      <gds-vertical-stepper-item state="current">Select Drivers with Incidents</gds-vertical-stepper-item>
    </gds-vertical-stepper>
    <gds-button type="button"><button type="button">Next</button></gds-button>
  </body></html>`;

  // Clean notes (0 fields) -> clicks Next.
  {
    const { dom, win } = mountGeicoPaDom(incidentsHtml);
    let nextClicks = 0;
    dom.window.document.querySelector('gds-button button')?.addEventListener('click', () => { nextClicks++; });
    const plan = buildPlan(baseRecord(), geicoPa, {});
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance });
    assert.equal(nextClicks, 1);
    assert.equal(report.advanced, 'Next');
    dom.window.close();
  }

  // Incident notes -> holds via incidentsReview, does NOT click Next.
  {
    const { dom, win } = mountGeicoPaDom(incidentsHtml);
    let nextClicks = 0;
    dom.window.document.querySelector('gds-button button')?.addEventListener('click', () => { nextClicks++; });
    const rec = baseRecord();
    rec.notes.text = 'At-fault accident in 2024';
    const plan = buildPlan(rec, geicoPa, {});
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance });
    assert.equal(nextClicks, 0);
    assert.equal(report.advanced, undefined);
    assert.ok(report.blockers.length > 0);
    dom.window.close();
  }

  // Vehicle Prefill -> auto-selects "Quote a different vehicle" (AddVehicle), leaves prefilled vehicle
  // cards unchecked, and auto-advances via Next.
  {
    const prefillHtml = `<!doctype html><html><head><title>GEICO</title></head><body>
      <gds-vertical-stepper>
        <gds-vertical-stepper-item state="completed">Policyholder Information</gds-vertical-stepper-item>
        <gds-vertical-stepper-item state="future">Vehicle Information</gds-vertical-stepper-item>
      </gds-vertical-stepper>
      <gds-card-selections id="Id_AutoVehiclePrefill_NativePrefillChoiceSet_45185" input-type="checkbox">
        <gds-card-selections-card id="card-veh-1" input-value="mock-veh-1" input-type="checkbox">
          <div class="image-selection-title"><p>2020 Honda Accord</p></div>
        </gds-card-selections-card>
        <gds-card-selections-card id="card-add" input-value="AddVehicle" input-type="checkbox">
          <div class="image-selection-title"><p>Quote a different vehicle</p></div>
        </gds-card-selections-card>
      </gds-card-selections>
      <gds-button type="button"><button type="button">Next</button></gds-button>
    </body></html>`;
    const { dom, win } = mountGeicoPaDom(prefillHtml);
    const doc = dom.window.document;
    // Mirror GEICO's Lit gds-card-selections-card shadow checkbox + host click toggle.
    /** @type {HTMLInputElement[]} */
    const cardInputs = [];
    for (const [id, val] of [['card-veh-1', 'mock-veh-1'], ['card-add', 'AddVehicle']]) {
      const host = doc.getElementById(id);
      const sr = host?.attachShadow({ mode: 'open' });
      const cb = doc.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'gds-checkbox-input';
      cb.value = val;
      sr?.appendChild(cb);
      host?.addEventListener('click', () => {
        if (host.hasAttribute('selected')) host.removeAttribute('selected');
        else host.setAttribute('selected', '');
        cb.checked = host.hasAttribute('selected');
      });
      cardInputs.push(cb);
    }
    let nextClicks = 0;
    doc.querySelector('gds-button button')?.addEventListener('click', () => { nextClicks++; });
    const plan = buildPlan(baseRecord(), geicoPa, {});
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance });
    assert.equal(cardInputs[0].checked, false, 'prefilled vehicle card must stay unchecked');
    assert.equal(cardInputs[1].checked, true, 'AddVehicle card must be checked');
    assert.equal(doc.getElementById('card-add')?.hasAttribute('selected'), true);
    assert.equal(report.failed.length, 0);
    assert.equal(report.unknown.length, 0);
    assert.equal(nextClicks, 1, 'Vehicle Prefill must auto-advance once AddVehicle is checked');
    assert.equal(report.advanced, 'Next');
    dom.window.close();
  }
});

test('GEICO Gateway /search-results fills 5-digit ZIP (replacing carried-over ZIP) and ticks Auto without clicking Search Products or Start Quote', async () => {
  const gatewayHtml = `<!doctype html><html><head><title>GEICO Gateway</title></head><body>
    <input type="radio" name="header-search-type" value="policy">
    <input id="search-input-id" type="text" value="">
    <input id="alerts-pref-email" type="checkbox">
    <div id="start-quote-modal">
      <label for="start-quote-zip">Zip Code</label>
      <input id="start-quote-zip" type="text" value="99999">
      <button id="search-products-btn" type="button">Search Products</button>
      <input type="checkbox" name="lob-selection" id="auto" value="auto">
      <label for="auto">Auto</label>
      <input type="checkbox" name="lob-selection" id="commercial" value="commercial">
      <label for="commercial">Commercial Auto/Trucking</label>
      <input type="checkbox" name="lob-selection" id="motorcycle" value="motorcycle">
      <label for="motorcycle">Motorcycle</label>
      <button id="start-quote-btn" type="button">Start Quote</button>
    </div>
  </body></html>`;
  const { dom, win } = mountGeicoPaDom(gatewayHtml, 'https://gateway2.geico.com/search-results');
  const doc = dom.window.document;
  let searchClicks = 0;
  let startClicks = 0;
  doc.getElementById('search-products-btn')?.addEventListener('click', () => { searchClicks++; });
  doc.getElementById('start-quote-btn')?.addEventListener('click', () => { startClicks++; });
  const rec = baseRecord();
  rec.garaging.zip = '37901-1234';
  const plan = buildPlan(rec, geicoPa, {});
  const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps, advance: geicoPa.advance });
  assert.equal(/** @type {HTMLInputElement} */ (doc.getElementById('start-quote-zip')).value, '37901');
  assert.equal(/** @type {HTMLInputElement} */ (doc.getElementById('auto')).checked, true);
  assert.equal(/** @type {HTMLInputElement} */ (doc.getElementById('commercial')).checked, false);
  assert.equal(/** @type {HTMLInputElement} */ (doc.getElementById('motorcycle')).checked, false);
  assert.equal(report.failed.length, 0);
  assert.equal(report.unknown.length, 0);
  assert.equal(searchClicks, 0, 'Search Products must stay agent-clicked');
  assert.equal(startClicks, 0, 'Start Quote must stay agent-clicked');
  assert.equal(report.advanced, undefined, 'gateway must never auto-advance');
  dom.window.close();
});

test('Current Insurance GiveCurrentBodilyInjuryLimits picks lowest option for State Minimum when empty and keeps prefilled limits (D8)', async () => {
  /**
   * @param {{ options: string[], selected?: string }} opts
   */
  const mountCurrentBi = ({ options, selected = '' }) => {
    const html = `<!doctype html><html><head><title>GEICO</title></head><body>
      <gds-vertical-stepper>
        <gds-vertical-stepper-item state="current">Current Insurance</gds-vertical-stepper-item>
      </gds-vertical-stepper>
      <form id="salesForm">
        <div class="form-field">
          <gds-label-legend for="Id_GiveCurrentBodilyInjuryLimits_47378">What bodily injury limits do you currently have on your vehicle insurance?</gds-label-legend>
          <select id="Id_GiveCurrentBodilyInjuryLimits_47378" name="Id_GiveCurrentBodilyInjuryLimits_47378">
            ${options.map((o, i) => {
              const val = i === 0 && /^please\s+select$/i.test(o) ? '' : o;
              return `<option value="${val}"${val === selected ? ' selected' : ''}>${o}</option>`;
            }).join('')}
          </select>
        </div>
      </form>
    </body></html>`;
    return mountGeicoPaDom(html);
  };

  const rec = baseRecord();
  rec.priorInsurance[0].limit = 'State Minimum or less';
  const plan = buildPlan(rec, geicoPa, {});

  // (a) Empty select with live 098e options picks lowest split ($25,000/$50,000), skipping Please Select and Not Sure.
  {
    const { dom, win } = mountCurrentBi({
      options: [
        'Please Select',
        '$25,000/$50,000',
        '$50,000/$100,000',
        '$100,000/$200,000',
        '$100,000/$300,000',
        '$300,000/$300,000',
        '$250,000/$500,000 or higher',
        'Not Sure',
      ],
    });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
    const sel = /** @type {HTMLSelectElement} */ (dom.window.document.getElementById('Id_GiveCurrentBodilyInjuryLimits_47378'));
    assert.equal(sel.value, '$25,000/$50,000');
    assert.equal(report.failed.length, 0);
    assert.equal(report.filled.length, 1);
    assert.equal(report.filled[0].source, 'standard');
    assert.equal(report.filled[0].standard, true);
    dom.window.close();
  }

  // (b) Empty select where "I'm Not Sure" appears ahead of split options still skips it and picks $25,000/$50,000.
  {
    const { dom, win } = mountCurrentBi({
      options: ['Please Select', "I'm Not Sure", "I don't know", 'None', '$25,000/$50,000', '$50,000/$100,000'],
    });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
    const sel = /** @type {HTMLSelectElement} */ (dom.window.document.getElementById('Id_GiveCurrentBodilyInjuryLimits_47378'));
    assert.equal(sel.value, '$25,000/$50,000');
    assert.equal(report.failed.length, 0);
    dom.window.close();
  }

  // (c) Empty select that explicitly offers "State Minimum" prefers it over other split options.
  {
    const { dom, win } = mountCurrentBi({
      options: ['Please Select', '$25,000/$50,000', 'State Minimum', '$50,000/$100,000', 'Not Sure'],
    });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
    const sel = /** @type {HTMLSelectElement} */ (dom.window.document.getElementById('Id_GiveCurrentBodilyInjuryLimits_47378'));
    assert.equal(sel.value, 'State Minimum');
    assert.equal(report.failed.length, 0);
    dom.window.close();
  }

  // (d) Prefilled $50,000/$100,000 is KEPT even when intake says "State Minimum or less" (D8: omit replace).
  {
    const { dom, win } = mountCurrentBi({
      options: [
        'Please Select',
        '$25,000/$50,000',
        '$50,000/$100,000',
        '$100,000/$200,000',
        '$100,000/$300,000',
        '$300,000/$300,000',
        '$250,000/$500,000 or higher',
        'Not Sure',
      ],
      selected: '$50,000/$100,000',
    });
    const report = await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
    const sel = /** @type {HTMLSelectElement} */ (dom.window.document.getElementById('Id_GiveCurrentBodilyInjuryLimits_47378'));
    assert.equal(sel.value, '$50,000/$100,000', 'prefilled 3rd-party current BI limit must be preserved');
    assert.equal(report.failed.length, 0);
    assert.equal(report.filled.length, 0);
    assert.equal(report.kept.length, 1);
    dom.window.close();
  }
});

test('PR #603 review regressions: Tennessee Farmers alias, GiveZip ZIP+4, Excluded license status, exact "3 years", DST/invalid date in hadInsuranceLast30Days, and wrapped License History driver row', async () => {
  // 1. Non-exact Tennessee Farmers variants must not be shadowed by generic Farmers/21st Century.
  assert.deepEqual(geicoProviderChoice('Tennessee Farmers Mutual'), { value: 'TENNESSEE FARMERS', source: 'derived', note: null });
  assert.deepEqual(geicoProviderChoice('Tennessee Farmers Insurance'), { value: 'TENNESSEE FARMERS', source: 'derived', note: null });
  assert.deepEqual(geicoProviderChoice('TN Farmers'), { value: 'TENNESSEE FARMERS', source: 'derived', note: null });
  assert.deepEqual(geicoProviderChoice('Farmers Insurance'), { value: 'Farmers/21st Century', source: 'derived', note: null });

  // 2. Policyholder GiveZip normalizes ZIP+4 to 5 digits and rejects non-5-digit ZIPs with zipNote.
  const zipRec = baseRecord();
  zipRec.garaging.zip = '37901-1234';
  const zipPlan = buildPlan(zipRec, geicoPa, {});
  const phZip = byField(zipPlan, 'Policyholder Information', 'GiveZip');
  assert.deepEqual([phZip.value, phZip.source, phZip.note], ['37901', 'derived', null]);
  zipRec.garaging.zip = 'ABCDE';
  const badZipPlan = buildPlan(zipRec, geicoPa, {});
  const badPhZip = byField(badZipPlan, 'Policyholder Information', 'GiveZip');
  assert.equal(badPhZip.value, null);
  assert.equal(badPhZip.source, 'fact');
  assert.match(String(badPhZip.note), /isn't a 5-digit ZIP/i);

  // 3. GiveDriversLicenseStatus must NOT fill 'Active' when licenseNumber contains exclusion text.
  const exRec = baseRecord();
  exRec.drivers[1].licenseNumber = 'Excluded';
  const exPlan = buildPlan(exRec, geicoPa, {});
  const exLicStatus = byField(exPlan, 'Driver Information', 'GiveDriversLicenseStatus', '2');
  assert.equal(exLicStatus.value, null);
  assert.equal(exLicStatus.source, 'fact');
  assert.match(String(exLicStatus.note), /confirm license status/i);

  // 4. Exact "3 years" maps as derived even on >= 10 year old or blank-year vehicles (only "3+ years" uses standard).
  const refToday = new Date(2026, 10, 24);
  assert.deepEqual(geicoOwnershipLength({ year: 2012, ownedFor: '3 years' }, refToday), { value: '2 to 10 years', source: 'derived', note: null });
  assert.deepEqual(geicoOwnershipLength({ year: null, ownedFor: '3 years' }, refToday), { value: '2 to 10 years', source: 'derived', note: null });
  assert.deepEqual(geicoOwnershipLength({ year: 2012, ownedFor: '3+ years' }, refToday), { value: '2 to 10 years', source: 'standard', note: null });

  // 5. hadInsuranceLast30Days: 31-day span across Spring-forward DST is 'No', 30-day span is 'Yes', invalid rolled-over dates return null.
  assert.deepEqual(hadInsuranceLast30Days('02/12/2026', new Date(2026, 2, 15)), { value: 'No', source: 'derived', note: null });
  assert.deepEqual(hadInsuranceLast30Days('03/01/2026', new Date(2026, 3, 1)), { value: 'No', source: 'derived', note: null });
  assert.deepEqual(hadInsuranceLast30Days('03/02/2026', new Date(2026, 3, 1)), { value: 'Yes', source: 'derived', note: null });
  for (const badDate of ['02/31/2026', '13/01/2026', '04/31/2026']) {
    const res = hadInsuranceLast30Days(badDate, new Date(2026, 3, 1));
    assert.equal(res.value, null, `invalid calendar date ${badDate} must not roll over`);
    assert.equal(res.source, 'fact');
  }

  // 6. Wrapped License History driver section binds Driver 3's own calculated age (not Driver 2's).
  const rec = baseRecord();
  rec.drivers[1].dob = '06/15/1984';
  rec.drivers[1].yearLicensed = 2002; // age 18
  rec.drivers[2].dob = '06/15/2007';
  rec.drivers[2].yearLicensed = 2023; // age 16 (distinct from Driver 2)
  const html = `<!doctype html><html><head><title>GEICO</title></head><body>
    <gds-vertical-stepper><gds-vertical-stepper-item state="current">License History</gds-vertical-stepper-item></gds-vertical-stepper>
    <form id="salesForm">
      <div><gds-section-header>License History</gds-section-header></div>
      <div><gds-section-header>Jordan Sample</gds-section-header></div>
      <div><gds-section-header>Alex Sample</gds-section-header></div>
      <div id="drv3-sec">
        <gds-section-header>Casey Sample</gds-section-header>
        <input id="Id_GiveAgeFirstLicensed_301" name="Id_GiveAgeFirstLicensed_301" type="tel" value="">
      </div>
    </form>
  </body></html>`;
  const { dom, win } = mountGeicoPaDom(html);
  const plan = buildPlan(rec, geicoPa, {});
  await win.__raterKit.fill(plan, { highlight: false, stepNames: geicoPa.layoutSteps });
  const ageInput = /** @type {HTMLInputElement} */ (dom.window.document.getElementById('Id_GiveAgeFirstLicensed_301'));
  assert.equal(ageInput.value, '16', 'Driver 3 wrapped section receives Driver 3 age (16), not Driver 2 age (18)');
  dom.window.close();
});
