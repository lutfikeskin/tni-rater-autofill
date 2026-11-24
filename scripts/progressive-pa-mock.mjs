#!/usr/bin/env node
// @ts-check
// Progressive Personal Auto end-to-end mock (npm run mock:progressive-pa):
// Serves test/fixtures/progressive-pa/quote.html locally, loads the real field-key.js,
// progressive-pa page adapter, and built fill engine (scripts/lib/kit.mjs), reads the synthetic
// personal-auto intake PDF (test/fixtures/personal-auto/intake-current.pdf), and drives all
// 6 quote steps plus the Point of Sale stopStep in Chromium.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromium } from 'playwright';
import { readIntakeFields } from '../src/intake.js';
import { readIntake } from '../src/intake-forms.js';
import { buildPlan } from '../src/plan.js';
import { progressivePa } from '../src/carriers/progressive-pa.js';
import { advanceFor } from '../src/units.js';
import { readPremium } from '../src/premium.js';
import { kitCode } from './lib/kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');
const src = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const KIT = [src('src/content/field-key.js'), src('src/content/carriers/progressive-pa.js'), await kitCode()].join('\n');
const HTML = src('test/fixtures/progressive-pa/quote.html');

const pdfBytes = new Uint8Array(fs.readFileSync(path.join(root, 'test/fixtures/personal-auto/intake-current.pdf')));
const raw = await readIntakeFields(pdfjs, pdfBytes);
const intake = readIntake(raw, { today: new Date('2026-11-24') });
if ('error' in intake) throw new Error(intake.error);
const { record } = intake;

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }, 120);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
const url = `http://127.0.0.1:${addr.port}/test/fixtures/progressive-pa/quote.html`;

const browser = await chromium.launch({ headless: !headed });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**/*', (route) => (route.request().url().startsWith(`http://127.0.0.1:${addr.port}/`) ? route.continue() : route.abort()));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: KIT });

  const fillCurrentStep = async () => {
    const plan = buildPlan(record, progressivePa, {});
    return page.evaluate(
      ({ p, stopSteps, advance, premiumPages }) => /** @type {any} */ (globalThis).__raterKit.fill(p, { stopSteps, advance, premiumPages }),
      { p: plan, stopSteps: Object.keys(progressivePa.stopSteps ?? {}), advance: advanceFor(progressivePa), premiumPages: progressivePa.premiumPages ?? [] },
    );
  };
  const activeStep = () => page.evaluate(() => /** @type {any} */ (globalThis).__raterAdapter.shared.step());
  const setStep = (stepName) => page.evaluate((s) => /** @type {any} */ (window).__setStep(s), stepName);

  // 1. Named Insured (auto-advances to Products once clear)
  await setStep('Named Insured');
  const r1 = await fillCurrentStep();
  assert.equal(r1.failed.length, 0, `Named Insured failed: ${JSON.stringify(r1.failed)}`);
  assert.equal(r1.unknown.length, 0, `Named Insured unknown: ${JSON.stringify(r1.unknown)}`);
  assert.equal(r1.advanced, 'PRODUCTS', `Named Insured should auto-advance to Products: ${JSON.stringify(r1.blockers)}`);
  assert.equal(await activeStep(), 'Products', 'Auto-advance from Named Insured should land on Products');
  const niVals = await page.evaluate(() => ({
    first: /** @type {HTMLInputElement} */ (document.getElementById('NamedInsured_Embedded_Questions_List_FirstName')).value,
    last: /** @type {HTMLInputElement} */ (document.getElementById('NamedInsured_Embedded_Questions_List_LastName')).value,
    phoneType: /** @type {HTMLSelectElement} */ (document.getElementById('NamedInsured_PhoneNumbers_List_0_Embedded_Questions_List_PhoneType')).selectedOptions[0]?.text,
    phoneNumber: /** @type {HTMLInputElement} */ (document.getElementById('NamedInsured_PhoneNumbers_List_0_Embedded_Questions_List_PhoneNumber')).value,
    address: /** @type {HTMLInputElement} */ (document.getElementById('NamedInsured_Embedded_Questions_List_MailingAddress')).value,
    zip: /** @type {HTMLInputElement} */ (document.getElementById('NamedInsured_Embedded_Questions_List_ZipCode')).value,
    moved: /** @type {HTMLSelectElement} */ (document.getElementById('NamedInsured_Embedded_Questions_List_RecentlyMoved')).selectedOptions[0]?.text,
    disc: /** @type {HTMLSelectElement} */ (document.getElementById('NamedInsured_Embedded_Questions_List_DisclosureProvided')).selectedOptions[0]?.text,
    agentCode: /** @type {HTMLInputElement} */ (document.getElementById('NamedInsured_Embedded_Questions_List_AgentCode')).value,
  }));
  assert.deepEqual(niVals, {
    first: 'Jordan',
    last: 'Sample',
    phoneType: 'Cell',
    phoneNumber: '555-010-0142',
    address: '100 EXAMPLE ST',
    zip: '37901',
    moved: 'No',
    disc: 'Yes',
    agentCode: '99999',
  });

  // 2. Products (adds vehicle 2 asynchronously + verifies VIN 1 + fills Commute follow-ups;
  // vehicle 2's invalid VIN check digit is intentionally held for the agent so auto-advance waits)
  const r2 = await fillCurrentStep();
  assert.equal(r2.failed.length, 0, `Products failed: ${JSON.stringify(r2.failed)}`);
  assert.equal(r2.unknown.length, 0, `Products unknown: ${JSON.stringify(r2.unknown)}`);
  assert.equal(r2.kept.some((k) => k.differs), false, `Prefilled PolicyEffectiveDate must not flag differs: ${JSON.stringify(r2.kept)}`);
  assert.ok(!r2.advanced, 'Products must hold auto-advance while vehicle 2 VIN needs the agent');
  assert.equal(await activeStep(), 'Products');
  const prodVals = await page.evaluate(() => ({
    vehicleCards: document.querySelectorAll('.vehicle-card').length,
    effDate: /** @type {HTMLInputElement} */ (document.getElementById('ProductsAA_Embedded_Questions_List_PolicyEffectiveDate')).value,
    namedOpNo: /** @type {HTMLInputElement} */ (document.getElementById('ProductsAA_Embedded_Questions_List_NamedOperatorIndicator_N')).checked,
    vin0: /** @type {HTMLInputElement} */ (document.getElementById('ProductsAA_Vehicles_List_0_Embedded_Questions_List_Vin')).value,
    vin1: /** @type {HTMLInputElement} */ (document.getElementById('ProductsAA_Vehicles_List_1_Embedded_Questions_List_Vin')).value,
    verifiedCount: document.querySelectorAll('.vin-input.verified').length,
    use0: /** @type {HTMLSelectElement} */ (document.getElementById('ProductsAA_Vehicles_List_0_Embedded_Questions_List_VehicleUse')).selectedOptions[0]?.text,
    commuteDays0: /** @type {HTMLSelectElement} */ (document.getElementById('ProductsAA_Vehicles_List_0_Embedded_Questions_List_CommuteDaysPerWk')).selectedOptions[0]?.text,
    commuteMiles0: /** @type {HTMLInputElement} */ (document.getElementById('ProductsAA_Vehicles_List_0_Embedded_Questions_List_OneWayCommuteMiles')).value,
    tnc0: /** @type {HTMLSelectElement} */ (document.getElementById('ProductsAA_Vehicles_List_0_Embedded_Questions_List_VehicleTransportNetworkCompanyIndicator')).selectedOptions[0]?.text,
    miles1: /** @type {HTMLSelectElement} */ (document.getElementById('ProductsAA_Vehicles_List_1_Embedded_Questions_List_AnnualMileageForRate')).selectedOptions[0]?.text,
  }));
  assert.deepEqual(prodVals, {
    vehicleCards: 2,
    effDate: '11/25/2026',
    namedOpNo: true,
    vin0: '1HGCM82633A004352',
    // Vehicle 2's VIN in intake-current.pdf has an invalid check digit on purpose, so plan.js
    // safely withholds it for the agent and verifyVin2 does not fire.
    vin1: '',
    verifiedCount: 1,
    use0: 'Commute',
    commuteDays0: '5',
    commuteMiles0: '15',
    tnc0: 'No',
    miles1: '30,000 - 99,999',
  });

  // 3. Household Members (agent moves on from Products; fills drivers + preserves prefilled DL without flagging differs)
  await setStep('Household Members');
  const r3 = await fillCurrentStep();
  assert.equal(r3.failed.length, 0, `Household failed: ${JSON.stringify(r3.failed)}`);
  assert.equal(r3.unknown.length, 0, `Household unknown: ${JSON.stringify(r3.unknown)}`);
  assert.equal(r3.kept.some((k) => k.differs), false, `Prefilled DL must not flag differs: ${JSON.stringify(r3.kept)}`);
  const hhVals = await page.evaluate(() => ({
    d0First: /** @type {HTMLInputElement} */ (document.getElementById('People_Drivers_List_0_Embedded_Questions_List_FirstName')).value,
    d0License: /** @type {HTMLInputElement} */ (document.getElementById('People_Drivers_List_0_Embedded_Questions_List_LicenseNumber')).value,
    d0Mature: /** @type {HTMLSelectElement} */ (document.getElementById('People_Drivers_List_0_ProductSpecificInformation_List_0_Embedded_Questions_List_SeniorDriver')).selectedOptions[0]?.text,
    d0Sr22No: /** @type {HTMLInputElement} */ (document.getElementById('People_Drivers_List_0_Embedded_Questions_List_StateFiling_N')).checked,
    d1First: /** @type {HTMLInputElement} */ (document.getElementById('People_Drivers_List_1_Embedded_Questions_List_FirstName')).value,
    d1LicenseMasked: /** @type {HTMLInputElement} */ (document.getElementById('People_Drivers_List_1_Embedded_Questions_List_LicenseNumber')).value,
    d1Rel: /** @type {HTMLSelectElement} */ (document.getElementById('People_Drivers_List_1_Embedded_Questions_List_Relationship')).selectedOptions[0]?.text,
    d1Second: /** @type {HTMLSelectElement} */ (document.getElementById('People_Drivers_List_1_ProductSpecificInformation_List_0_Embedded_Questions_List_SecondNamedInsured')).selectedOptions[0]?.text,
    d1Good: /** @type {HTMLSelectElement} */ (document.getElementById('People_Drivers_List_1_ProductSpecificInformation_List_0_Embedded_Questions_List_GoodStudent')).selectedOptions[0]?.text,
    d1Distant: /** @type {HTMLSelectElement} */ (document.getElementById('People_Drivers_List_1_ProductSpecificInformation_List_0_Embedded_Questions_List_StudentLocation')).selectedOptions[0]?.text,
  }));
  assert.deepEqual(hhVals, {
    d0First: 'Jordan',
    d0License: 'PREFILLED-99',
    d0Mature: 'Yes',
    d0Sr22No: true,
    d1First: 'Casey',
    d1LicenseMasked: 'XXXXX321',
    d1Rel: 'Child',
    d1Second: 'No',
    d1Good: 'Yes',
    d1Distant: 'No',
  });

  // 4. Additional Details (auto-advances to Coverages once clear)
  if (await activeStep() !== 'Additional Details') await setStep('Additional Details');
  const r4 = await fillCurrentStep();
  assert.equal(r4.failed.length, 0, `Additional Details failed: ${JSON.stringify(r4.failed)}`);
  assert.equal(r4.unknown.length, 0, `Additional Details unknown: ${JSON.stringify(r4.unknown)}`);
  assert.equal(r4.advanced, 'COVERAGES/BILL PLANS', `Additional Details should auto-advance to Coverages: ${JSON.stringify(r4.blockers)}`);
  assert.equal(await activeStep(), 'Coverages', 'Auto-advance from Additional Details should land on Coverages');
  const adVals = await page.evaluate(() => ({
    insured: /** @type {HTMLSelectElement} */ (document.getElementById('AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_InsuranceToday')).selectedOptions[0]?.text,
    priorProg: /** @type {HTMLSelectElement} */ (document.getElementById('AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_PriorCarrierIsProgressive')).selectedOptions[0]?.text,
    allDrv: /** @type {HTMLSelectElement} */ (document.getElementById('AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_AllDriversAcknowledgement')).selectedOptions[0]?.text,
    paperless: /** @type {HTMLSelectElement} */ (document.getElementById('AdditionalDetails_Embedded_Questions_List_PaperlessPreference')).selectedOptions[0]?.text,
    residents: /** @type {HTMLSelectElement} */ (document.getElementById('AdditionalDetails_Embedded_Questions_List_TotalResidents')).selectedOptions[0]?.text,
    residence: /** @type {HTMLSelectElement} */ (document.getElementById('AdditionalDetails_Embedded_Questions_List_PrimaryResidenceDisplay')).selectedOptions[0]?.text,
    rentersChecked: /** @type {HTMLInputElement} */ (document.getElementById('AdditionalDetails_Embedded_Questions_List_Renters')).checked,
    noAddlRisksChecked: /** @type {HTMLInputElement} */ (document.getElementById('AdditionalDetails_Embedded_Questions_List_MultiPolInd')).checked,
  }));
  assert.deepEqual(adVals, {
    insured: 'Yes, currently insured',
    priorProg: 'No',
    allDrv: 'Yes',
    paperless: 'Yes',
    residents: '2',
    residence: 'Rent',
    rentersChecked: false,
    noAddlRisksChecked: true,
  });

  // 5. Coverages (per-vehicle Full Coverage vs Liability Only + PVP None + Snapshot + Policy radios + Recalculate + Pay With EFT + Premium -> auto-advances to Portfolio)
  const r5 = await fillCurrentStep();
  assert.equal(r5.failed.length, 0, `Coverages failed: ${JSON.stringify(r5.failed)}`);
  assert.equal(r5.unknown.length, 0, `Coverages unknown: ${JSON.stringify(r5.unknown)}`);
  assert.equal(r5.advanced, 'PORTFOLIO', `Coverages should auto-advance to Portfolio after Recalculate + Pay With EFT: ${JSON.stringify(r5.blockers)}`);
  assert.equal(await activeStep(), 'Portfolio', 'Auto-advance from Coverages should land on Portfolio');
  const covVals = await page.evaluate(() => ({
    bipd: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_0_Embedded_Questions_List_BIPD')).selectedOptions[0]?.text,
    umbi: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_0_Embedded_Questions_List_UMBI')).selectedOptions[0]?.text,
    comp0: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COMP')).selectedOptions[0]?.text,
    coll0: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_0_Embedded_Questions_List_COLL')).selectedOptions[0]?.text,
    pvp0: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_0_Embedded_Questions_List_PVP')).selectedOptions[0]?.text,
    comp1: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COMP')).selectedOptions[0]?.text,
    coll1Tag: document.getElementById('CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COLL')?.tagName,
    coll1Val: /** @type {HTMLInputElement} */ (document.getElementById('CoveragesAA_Vehicles_List_1_Embedded_Questions_List_COLL')).value,
    pvp1Tag: document.getElementById('CoveragesAA_Vehicles_List_1_Embedded_Questions_List_PVP')?.tagName,
    snap0: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_0_Embedded_Questions_List_SnapshotEnrollmentType')).selectedOptions[0]?.text,
    snap1: /** @type {HTMLSelectElement} */ (document.getElementById('CoveragesAA_Vehicles_List_1_Embedded_Questions_List_SnapshotEnrollmentType')).selectedOptions[0]?.text,
    afNo: /** @type {HTMLInputElement} */ (document.getElementById('CoveragesAA_PolicyCoverage_Embedded_Questions_List_AccidentForgiveness_N')).checked,
    dsbNo: /** @type {HTMLInputElement} */ (document.getElementById('CoveragesAA_PolicyCoverage_Embedded_Questions_List_DeductibleSavingsBank_N')).checked,
    eftChecked: /** @type {HTMLInputElement} */ (document.getElementById('P0400Y_input')).checked,
    recalcVisible: getComputedStyle(document.getElementById('recalc-host')).display !== 'none',
    text: document.body.innerText,
  }));
  assert.equal(covVals.bipd, '100/300/100');
  assert.equal(covVals.umbi, '25/50');
  assert.equal(covVals.comp0, '$500');
  assert.equal(covVals.coll0, '$1,000');
  assert.equal(covVals.pvp0, 'None');
  assert.equal(covVals.comp1, 'None');
  assert.equal(covVals.coll1Tag, 'INPUT');
  assert.equal(covVals.coll1Val, 'None');
  assert.equal(covVals.pvp1Tag, 'INPUT');
  assert.equal(covVals.snap0, 'Do Not Participate');
  assert.equal(covVals.snap1, 'Do Not Participate');
  assert.equal(covVals.afNo, true);
  assert.equal(covVals.dsbNo, true);
  assert.equal(covVals.recalcVisible, false);
  assert.equal(covVals.eftChecked, true);
  assert.equal(r5.premium?.total, 2618);

  // 6. Portfolio (no fills, clicks Email/Print once, reads premium, NEVER advances to Point of Sale)
  const r6 = await fillCurrentStep();
  assert.equal(r6.filled.length, 0);
  assert.equal(r6.unknown.length, 0);
  assert.ok(!r6.advanced, 'Portfolio must never auto-advance to Point of Sale');
  assert.equal(await activeStep(), 'Portfolio', 'Portfolio must stay on Portfolio');
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__pointOfSaleClicks), 0, 'POINT OF SALE must never be clicked');
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__emailPrintClicks), 1);
  assert.equal(readPremium(await page.evaluate(() => document.body.innerText))?.total, 2618);

  // 7. Point of Sale (stopStep: fills nothing and halts)
  await setStep('Point of Sale');
  const r7 = await fillCurrentStep();
  assert.equal(r7.filled.length, 0);
  assert.equal(r7.halted, true);

  assert.deepEqual(errors, [], `Page errors: ${errors.join('; ')}`);
  const totalFilled = [r1, r2, r3, r4, r5].reduce((n, r) => n + r.filled.length, 0);
  console.log(`Progressive PA mock OK: ${totalFilled} answers across 5 steps, auto-advance verified (Named Insured->Products, Additional Details->Coverages->Portfolio), held on invalid VIN & Portfolio, 0 failures, stopStep held, premium $2,618.`);
} finally {
  await browser.close();
  server.close();
}
