// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan.js';
import { progressivePa } from '../src/carriers/progressive-pa.js';
import { readPremium, premiumHere } from '../src/premium.js';

/** Synthetic personal-auto client record covering all steps. */
const baseRecord = () => ({
  product: 'personal-auto',
  applicant: { name: 'Jordan Sample', phone: '(555) 010-0142', email: 'sample.client@example.com', applicationDate: '11/20/2026' },
  garaging: { street: '100 Example St', unit: 'Apt 2B', city: 'Knoxville', state: 'TN', zip: '37901' },
  residence: { timeAtAddress: '3 years', priorAddress: null, ownership: 'Own' },
  drivers: [
    {
      first: 'Jordan', middle: 'A', last: 'Sample', suffix: null, dob: '02/03/1985', gender: 'Female',
      maritalStatus: 'Married', relation: 'Insured', licenseNumber: 'S1234567', licenseState: 'TN',
      yearLicensed: 2003, occupation: 'Teacher', education: "Bachelor's Degree",
      matureCourse: true, goodStudent: null, distantStudent: null,
    },
    {
      first: 'Alex', middle: null, last: 'Sample', suffix: 'Jr', dob: '04/05/1984', gender: 'Male',
      maritalStatus: 'Married', relation: 'Spouse', licenseNumber: 'S7654321', licenseState: 'TN',
      yearLicensed: 2002, occupation: 'Retired', education: "Bachelor's Degree",
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
      year: 2019, make: 'Honda', model: 'Accord', vin: '1HGCM82633A004352',
      use: 'Commute to/from work or school', ownership: 'Financed', value: 18500,
      ownedFor: 'Less than 6 months', annualMiles: 12000, commuteMiles: 15, commuteDays: 5,
      damage: false, fullCoverage: true,
      lienholder: { name: 'Example Credit Union', street: '1 Bank Way', city: 'Dallas', state: 'TX', zip: '75201' },
    },
    {
      year: 2015, make: 'Toyota', model: 'Corolla', vin: '1HGCM82633A004353',
      use: 'Pleasure/Personal', ownership: 'Owned', value: null,
      ownedFor: '3+ years', annualMiles: '50,000+', commuteMiles: null, commuteDays: null,
      damage: true, fullCoverage: false,
      lienholder: { name: null, street: null, city: null, state: null, zip: null },
    },
  ],
  trailers: [],
  priorInsurance: [{ currentlyInsured: true, carrier: 'Example Mutual', limit: '$50k/$100k', insuredFor: '1-3 years', expiration: '12/31/2026' }],
  coverage: { liabilityLimit: '100/300/100', compDeductible: '$500', collDeductible: '$1,000' },
  notes: { text: null },
});

const bySel = (plan, sel) => plan.find((s) => s.selector === sel);
const byAction = (plan, id) => plan.find((s) => s.kind === 'action' && s.baseAction === id);

test('Named Insured maps insured driver, contact, address, and TNI standards (D1-D3)', () => {
  const plan = buildPlan(baseRecord(), progressivePa, {});
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_FirstName').value, 'Jordan');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_MiddleInitial').value, 'A');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_LastName').value, 'Sample');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_DateOfBirth').value, '02/03/1985');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_Gender').value, 'Female');
  assert.equal(bySel(plan, '#NamedInsured_PhoneNumbers_List_0_Embedded_Questions_List_PhoneType').value, 'Cell');
  assert.equal(bySel(plan, '#NamedInsured_PhoneNumbers_List_0_Embedded_Questions_List_PhoneType').source, 'standard');
  assert.equal(bySel(plan, '#NamedInsured_PhoneNumbers_List_0_Embedded_Questions_List_PhoneNumber').value, '555-010-0142');
  const addr = bySel(plan, '#NamedInsured_Embedded_Questions_List_MailingAddress');
  assert.equal(addr.kind, 'address-suggest');
  assert.equal(addr.value, '100 Example St, Knoxville, TN 37901');
  assert.equal(addr.fallback, '100 Example St');
  assert.equal(bySel(plan, 'input[type="checkbox"][aria-labelledby="helpTextToggleLabel"]').ignore, true);
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_State').value, 'Tennessee');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_RecentlyMoved').value, 'No');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_RecentlyMoved').source, 'derived');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_DisclosureProvided').value, 'Yes');
  assert.equal(bySel(plan, '#NamedInsured_Embedded_Questions_List_DisclosureProvided').source, 'standard');

  // D2: blank timeAtAddress & priorAddress -> TNI standard No; priorAddress set -> derived Yes; <2 months -> derived Yes; bare >=2 -> derived No.
  const blankMove = baseRecord();
  blankMove.residence.timeAtAddress = null;
  const bm = bySel(buildPlan(blankMove, progressivePa, {}), '#NamedInsured_Embedded_Questions_List_RecentlyMoved');
  assert.deepEqual([bm.value, bm.source], ['No', 'standard']);

  const bareNum = baseRecord();
  bareNum.residence.timeAtAddress = '5';
  const bn = bySel(buildPlan(bareNum, progressivePa, {}), '#NamedInsured_Embedded_Questions_List_RecentlyMoved');
  assert.deepEqual([bn.value, bn.source], ['No', 'derived']);

  const moved = baseRecord();
  moved.residence.priorAddress = '55 Old Rd, Nashville, TN 37201';
  const mv = bySel(buildPlan(moved, progressivePa, {}), '#NamedInsured_Embedded_Questions_List_RecentlyMoved');
  assert.deepEqual([mv.value, mv.source], ['Yes', 'derived']);

  const shortStay = baseRecord();
  shortStay.residence.timeAtAddress = '1 month';
  const ss = bySel(buildPlan(shortStay, progressivePa, {}), '#NamedInsured_Embedded_Questions_List_RecentlyMoved');
  assert.deepEqual([ss.value, ss.source], ['Yes', 'derived']);

  // Second name in first-name box splits to First Name + Middle Initial on both Named Insured and Household Members.
  const twoWord = baseRecord();
  twoWord.drivers[0].first = 'Jordan Michael';
  twoWord.drivers[0].middle = null;
  twoWord.drivers[1].first = 'Alex Patronymic';
  twoWord.drivers[1].middle = null;
  const tp = buildPlan(twoWord, progressivePa, {});
  assert.equal(bySel(tp, '#NamedInsured_Embedded_Questions_List_FirstName').value, 'Jordan');
  assert.equal(bySel(tp, '#NamedInsured_Embedded_Questions_List_MiddleInitial').value, 'M');
  assert.equal(bySel(tp, '#People_Drivers_List_0_Embedded_Questions_List_FirstName').value, 'Jordan');
  assert.equal(bySel(tp, '#People_Drivers_List_0_Embedded_Questions_List_MiddleInitial').value, 'M');
  assert.equal(bySel(tp, '#People_Drivers_List_1_Embedded_Questions_List_FirstName').value, 'Alex');
  assert.equal(bySel(tp, '#People_Drivers_List_1_Embedded_Questions_List_MiddleInitial').value, 'P');
});

test('Products maps effective date, named operator, VIN, ownership buckets, mileage, rideshare/delivery, and actions (D4-D8)', () => {
  const plan = buildPlan(baseRecord(), progressivePa, {});
  assert.match(String(bySel(plan, '#ProductsAA_Embedded_Questions_List_PolicyEffectiveDate').value), /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(bySel(plan, 'input[id^="ProductsAA_Embedded_Questions_List_NamedOperatorIndicator_"]').value, false);
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_TypeCode').value, '1981 & Newer - Autos, Pickups, Vans, and Utility Vehicles');
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_Vin').value, '1HGCM82633A004352');
  // D7 overlapping buckets
  const own0 = bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_LengthOfOwnership');
  assert.deepEqual([own0.value, own0.source], ['At least 1 month but less than 6 months', 'standard']);
  const own1 = bySel(plan, '#ProductsAA_Vehicles_List_1_Embedded_Questions_List_LengthOfOwnership');
  assert.deepEqual([own1.value, own1.source], ['At least 3 years but less than 5 years', 'standard']);
  // Vehicle use, commute follow-ups, & annual mileage (including TNI standard 8,000 - 9,999 when blank).
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_VehicleUse').value, 'Commute');
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_CommuteDaysPerWk').value, '5');
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_OneWayCommuteMiles').value, '15');
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_1_Embedded_Questions_List_VehicleUse').value, 'Pleasure/Personal');
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_AnnualMileageForRate').value, '12,000 - 13,999');
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_1_Embedded_Questions_List_AnnualMileageForRate').value, '30,000 - 99,999');
  const blankMiles = baseRecord();
  blankMiles.vehicles[0].annualMiles = null;
  const bmStep = bySel(buildPlan(blankMiles, progressivePa, {}), '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_AnnualMileageForRate');
  assert.deepEqual([bmStep.value, bmStep.source, bmStep.standard], ['8,000 - 9,999', 'standard', true]);
  // Lienholder & Additional Interest modals recognized and left for agent (every: true).
  assert.equal(bySel(plan, '[id^="VehicleLienholdersViewModel_Lienholders_List_"]').every, true);
  assert.equal(bySel(plan, '[id^="AdditionalInterestViewModel_AdditionalInterests_List_"]').every, true);
  // D8 Rideshare / delivery: standard No when clean; held for agent when notes mention Uber/DoorDash.
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_VehicleTransportNetworkCompanyIndicator').value, 'No');
  assert.equal(bySel(plan, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_VehicleUseDelivery').value, 'No');

  const uber = baseRecord();
  uber.notes.text = 'Client drives Uber on weekends';
  const up = buildPlan(uber, progressivePa, {});
  const tnc = bySel(up, '#ProductsAA_Vehicles_List_0_Embedded_Questions_List_VehicleTransportNetworkCompanyIndicator');
  assert.deepEqual([tnc.value, tnc.source, tnc.manualOnly], [null, 'fact', true]);

  // Actions: addVehicle2 + immediate verifyVin1 + immediate verifyVin2 (no addVehicle3 for 2 vehicles).
  assert.ok(byAction(plan, 'addVehicle2'));
  assert.equal(byAction(plan, 'addVehicle3'), undefined);
  assert.equal(byAction(plan, 'verifyVin1').token, 'vinSearchButton_0');
  assert.equal(byAction(plan, 'verifyVin1').immediate, true);
  assert.equal(byAction(plan, 'verifyVin2').token, 'vinSearchButton_1');
  assert.equal(byAction(plan, 'verifyVin2').immediate, true);
  assert.equal(progressivePa.world, 'MAIN');
});

test('Household Members maps drivers, spouse second named insured, non-employed status, discounts, SR-22, and blank yearLicensed (D9-D15)', () => {
  const plan = buildPlan(baseRecord(), progressivePa, {});
  // Driver 0 (Insured): Teacher -> employment left for agent; matureCourse checked -> Yes.
  assert.equal(bySel(plan, '#People_Drivers_List_0_Embedded_Questions_List_EmploymentStatus').value, null);
  assert.equal(bySel(plan, '#People_Drivers_List_0_Embedded_Questions_List_EmploymentStatus').source, 'fact');
  assert.equal(bySel(plan, '#People_Drivers_List_0_ProductSpecificInformation_List_0_Embedded_Questions_List_DriverIncluded').value, 'Rated');
  assert.equal(bySel(plan, '#People_Drivers_List_0_Embedded_Questions_List_LicenseType').value, 'Personal Auto');
  assert.equal(bySel(plan, '#People_Drivers_List_0_Embedded_Questions_List_LicenseStatus').value, 'Valid');
  assert.equal(bySel(plan, '#People_Drivers_List_0_Embedded_Questions_List_LicenseNumber').trustPage, true);
  assert.equal(bySel(plan, '#People_Drivers_List_0_Embedded_Questions_List_LicenseNumber').masked, true);
  assert.equal(bySel(plan, 'input[id^="People_Drivers_List_0_Embedded_Questions_List_StateFiling_"]').value, false);
  assert.equal(bySel(plan, 'select#People_Drivers_List_0_ProductSpecificInformation_List_0_Embedded_Questions_List_SeniorDriver').value, 'Yes');
  // Driver 1 (Spouse): SecondNamedInsured -> Yes; Retired -> mapped non-employed status.
  assert.equal(bySel(plan, 'select#People_Drivers_List_1_ProductSpecificInformation_List_0_Embedded_Questions_List_SecondNamedInsured').value, 'Yes');
  assert.equal(bySel(plan, '#People_Drivers_List_1_Embedded_Questions_List_EmploymentStatus').value, 'Retired (not employed)');
  // Driver 2 (Child): SecondNamedInsured -> No; Student -> mapped; GoodStudent Yes, DistantStudent No (standard).
  assert.equal(bySel(plan, 'select#People_Drivers_List_2_ProductSpecificInformation_List_0_Embedded_Questions_List_SecondNamedInsured').value, 'No');
  assert.equal(bySel(plan, '#People_Drivers_List_2_Embedded_Questions_List_EmploymentStatus').value, 'Full time student (not employed or part-time employed)');
  assert.equal(bySel(plan, 'select#People_Drivers_List_2_ProductSpecificInformation_List_0_Embedded_Questions_List_GoodStudent').value, 'Yes');
  assert.equal(bySel(plan, 'select#People_Drivers_List_2_ProductSpecificInformation_List_0_Embedded_Questions_List_StudentLocation').value, 'No');
  assert.equal(bySel(plan, 'select#People_Drivers_List_2_ProductSpecificInformation_List_0_Embedded_Questions_List_StudentLocation').source, 'standard');
  // Actions: addDriver2 and addDriver3 for 3 drivers.
  assert.ok(byAction(plan, 'addDriver2'));
  assert.ok(byAction(plan, 'addDriver3'));
  assert.equal(byAction(plan, 'addDriver4'), undefined);

  // D11, D12, D13 edge cases: blank licenseNumber, blank yearLicensed, SR-22 in notes.
  const edge = baseRecord();
  edge.drivers[0].licenseNumber = null;
  edge.drivers[0].yearLicensed = null;
  edge.notes.text = 'Needs SR-22 filing';
  const ep = buildPlan(edge, progressivePa, {});
  assert.deepEqual([bySel(ep, '#People_Drivers_List_0_Embedded_Questions_List_LicenseType').value, bySel(ep, '#People_Drivers_List_0_Embedded_Questions_List_LicenseType').source], [null, 'fact']);
  assert.deepEqual([bySel(ep, '#People_Drivers_List_0_ProductSpecificInformation_List_0_Embedded_Questions_List_DriverYearsLicensed').value, bySel(ep, '#People_Drivers_List_0_ProductSpecificInformation_List_0_Embedded_Questions_List_DriverYearsLicensed').source], [null, 'fact']);
  assert.deepEqual([bySel(ep, 'input[id^="People_Drivers_List_0_Embedded_Questions_List_StateFiling_"]').value, bySel(ep, 'input[id^="People_Drivers_List_0_Embedded_Questions_List_StateFiling_"]').source], [null, 'fact']);
});

test('Additional Details and Coverages map prior insurance, standards, fullCoverage per vehicle, State Minimum, and premium (D16-D24)', () => {
  const plan = buildPlan(baseRecord(), progressivePa, {});
  assert.equal(bySel(plan, '#AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_InsuranceToday').value, 'Yes, currently insured');
  assert.equal(bySel(plan, '#AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_PriorCarrierIsProgressive').value, 'No');
  assert.equal(bySel(plan, '#AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_BodilyInjuryLimits').value, 'Greater than State Minimum, Less than 100/300 or 100 CSL');
  assert.equal(bySel(plan, '#AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_RecentAutoInsuranceCompanyPeriod').value, 'At least 1 year but less than 3 years');
  assert.equal(bySel(plan, '#AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_AllDriversAcknowledgement').value, 'Yes');
  assert.equal(bySel(plan, '#AdditionalDetails_Embedded_Questions_List_PaperlessPreference').value, 'Yes');
  assert.equal(bySel(plan, '#AdditionalDetails_Embedded_Questions_List_TotalResidents').value, '3');
  assert.equal(bySel(plan, '#AdditionalDetails_Embedded_Questions_List_PrimaryResidenceDisplay').value, 'Own Home/Condo');
  assert.equal(bySel(plan, '#AdditionalDetails_Embedded_Questions_List_MultiPolInd').value, true);
  assert.equal(bySel(plan, '#AdditionalDetails_Embedded_Questions_List_MultiPolInd').source, 'standard');

  // Coverages: Vehicle 0 fullCoverage=true ($500/$1,000), Vehicle 1 fullCoverage=false (None/None).
  assert.equal(bySel(plan, 'select#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COMP').value, '$500');
  assert.equal(bySel(plan, 'select#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COLL').value, '$1,000');
  assert.equal(bySel(plan, 'select#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_PVP').value, 'None');
  assert.equal(bySel(plan, 'select#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_PVP').source, 'standard');
  assert.equal(bySel(plan, 'input#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_PVP').ignore, true);
  assert.equal(bySel(plan, 'select#CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COMP').value, 'None');
  assert.equal(bySel(plan, 'select#CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COLL').value, 'None');
  assert.equal(bySel(plan, '#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_SnapshotEnrollmentType').value, 'Do Not Participate');
  assert.equal(bySel(plan, 'input[id^="CoveragesAA_PolicyCoverage_Embedded_Questions_List_AccidentForgiveness_"]').value, false);
  assert.equal(bySel(plan, 'input[id^="CoveragesAA_PolicyCoverage_Embedded_Questions_List_DeductibleSavingsBank_"]').value, false);
  assert.equal(bySel(plan, 'input[type="radio"][name="billplanGroup"]').value, 'Pay With EFT');
  assert.equal(bySel(plan, 'input[type="radio"][name="billplanGroup"]').source, 'standard');
  assert.ok(byAction(plan, 'recalculate'));
  assert.equal(byAction(plan, 'recalculate').missing, null);
  assert.ok(byAction(plan, 'emailPrint'));
  // Auto-advance covers steps 1-5 only, never Portfolio/Point of Sale/Final Sale; finishedBy ends on Email/Print.
  assert.deepEqual(progressivePa.advance?.steps, ['Named Insured', 'Products', 'Household Members', 'Additional Details', 'Coverages']);
  assert.equal(progressivePa.continueRetry, false);
  assert.equal(progressivePa.finishedBy, 'emailPrint');
  // UMBI/UMPD/MEDPAY/RENT/ROADSD/PVP/PAYOFF, read-only COLL, and all Portfolio checkboxes are ignored cleanly.
  assert.equal(bySel(plan, '#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_UMBI').ignore, true);
  assert.equal(bySel(plan, '#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_MEDPAY').ignore, true);
  assert.equal(bySel(plan, 'input#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COLL').ignore, true);
  assert.equal(bySel(plan, '[id^="Portfolio_"]').every, true);

  // State Minimum or less uses pick-not to select the lowest non-None BI/PD limit.
  const minRec = baseRecord();
  minRec.coverage.liabilityLimit = 'State Minimum or less';
  const minPlan = buildPlan(minRec, progressivePa, {});
  const bipdMin = minPlan.find((s) => 'selector' in s && s.selector === 'select#CoveragesAA_Vehicles_List_0_Embedded_Questions_List_BIPD' && !s.ignore);
  assert.ok(bipdMin && 'selector' in bipdMin);
  assert.equal(bipdMin.kind, 'pick-not');
  assert.deepEqual(bipdMin.value, { not: '^(?:select|none)$' });

  // Prior carrier = Progressive -> Yes.
  const progPrior = baseRecord();
  progPrior.priorInsurance[0].carrier = 'Progressive Casualty';
  assert.equal(bySel(buildPlan(progPrior, progressivePa, {}), '#AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_PriorCarrierIsProgressive').value, 'Yes');

  // Premium reading on Coverages & Portfolio (D24).
  assert.equal(premiumHere(progressivePa, '/Quote/Index/', 'Coverages'), true);
  assert.equal(premiumHere(progressivePa, '/Quote/Index/', 'Portfolio'), true);
  assert.equal(premiumHere(progressivePa, '/Quote/Index/', 'Products'), false);
  assert.equal(readPremium('Total Auto Premium:$2,618.00')?.total, 2618);
  assert.equal(readPremium('Total Premium$2,618.00')?.total, 2618);
});
