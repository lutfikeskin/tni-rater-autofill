// @ts-check
// AmWINS-specific rule tests (W48-12: "Any prior loss" TNI standard No, keeping W48-04 Loss
// History rows as client facts if opened manually).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { amwins } from '../src/carriers/amwins.js';

/** @param {Record<string, any>} [overrides] */
const baseRecord = (overrides = {}) => ({
  product: 'commercial-auto',
  applicant: {
    name: 'Synthetic Expediter LLC', dot: '1234567', mc: 'MC-765432', mcDotWithin60Days: null,
    owner1: 'Amina Kone', ownerDrives: true, phone: '(555) 010-0100', email: 'client@example.test',
    fein: null, yearEstablished: 2019, yearsInBusiness: 5, yearsExperience: 3,
  },
  garaging: { street: '1 Test Way', unit: null, city: 'Testville', state: 'NJ', zip: '07000' },
  operations: {
    businessClass: 'Expediter', whatHaul: 'General freight', radius: 'Unlimited', radiusMiles: null,
    vehicleOwnership: 'Owned', personalUse: false, hazmat: false, hazPlacard: false,
    filingsRequired: true, filingsWhich: 'Federal Liability Filing', usesEld: false, equipVehicle: null,
  },
  drivers: [{ first: 'Amina', middle: null, last: 'Kone', dob: '01/02/1980', licenseNumber: 'NJ1234567', licenseState: 'NJ', cdl: true, cdlYear: 2015, maritalStatus: 'Married' }],
  vehicles: [{ type: 'Van', year: 2022, make: 'FORD', model: 'Transit', vin: '1FTBR3X87MKA12345', value: 45000 }],
  trailers: [],
  trailerInfo: { ownership: 'Owned', equipTrailer: null },
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'Synthetic Mutual', limit: '$1M CSL', expiration: '10/31/2099' }],
  coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, cargoDeductible: 1000, gl: false, glLimit: null, reeferBreakdown: null, ntl: null },
  claims: { hasClaims: false, text: 'No', notes: null },
  notes: { text: null },
  ...overrides,
});

/** @import { FieldStep } from '../types.js' */

/** @param {any} overrides @returns {FieldStep[]} */
const fieldPlan = (overrides) => /** @type {FieldStep[]} */ (buildPlan(baseRecord(overrides), amwins, {}).filter((s) => s.kind !== 'action'));

// W48-12 (TNI standard, 2026-11-25): "Always No on AmWINS prior loss", whatever the intake's
// claims box says, while keeping W48-04 Loss History rows mapped as client facts if opened manually.
test('AmWINS "Any prior loss" is always No (TNI standard, 2026-11-25, W48-12)', () => {
  for (const claims of [
    { hasClaims: true, text: 'Yes\nCargo claim 2024, $8,000 paid', notes: 'Cargo claim 2024, $8,000 paid' },
    { hasClaims: false, text: 'No', notes: null },
    { hasClaims: null, text: null, notes: null },
  ]) {
    const step = fieldPlan({ claims }).find((s) => s.re === '^any prior loss$');
    assert.ok(step, 'Any prior loss step present');
    assert.deepEqual(
      [step.value, step.source, step.standard, step.manualOnly, step.note, step.tni],
      [false, 'standard', true, false, null, 'amwins.prior-loss'],
      JSON.stringify(claims),
    );
  }
  // Review mode: unvalidated business class flags this TNI standard as reviewRequired.
  const reviewStep = fieldPlan({
    operations: { ...baseRecord().operations, businessClass: 'Dump Truck', whatHaul: 'Gravel' },
    claims: { hasClaims: true, text: 'Yes', notes: null },
  }).find((s) => s.re === '^any prior loss$');
  assert.ok(reviewStep, 'Any prior loss step present in review mode');
  assert.equal(reviewStep.value, false);
  assert.equal(reviewStep.reviewRequired, true);
  assert.match(reviewStep.warn ?? '', /Review mode/);
});

test('AmWINS W48-04 Loss History rows stay mapped as client facts when opened manually', () => {
  const lossRows = fieldPlan({
    claims: { hasClaims: true, text: 'Yes\nCargo claim 2024, $8,000 paid', notes: 'Cargo claim 2024, $8,000 paid' },
  }).filter((s) => /^Loss history:/.test(s.name ?? ''));
  assert.equal(lossRows.length, 48, '6 rows x 8 loss-history fields');
  for (const s of lossRows) {
    assert.equal(s.source, 'fact', s.name);
    assert.equal(s.value, null, s.name);
    assert.equal(s.manualOnly, true, s.name);
    assert.match(s.note ?? '', /Cargo claim 2024, \$8,000 paid/, s.name);
  }
});
