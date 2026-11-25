#!/usr/bin/env node
// @ts-check
// GEICO Personal Auto end-to-end mock (npm run mock:geico-pa):
// Serves test/fixtures/geico-pa/quote.html, gateway.html (/search-results), and /PrintQuote
// locally, loads page-press.js, field-key.js, src/content/carriers/geico-pa.js, and the built
// fill engine (scripts/lib/kit.mjs), reads the synthetic personal-auto intake PDF
// (test/fixtures/personal-auto/intake-current.pdf), and drives Phase 3 end-to-end scenarios in
// Chromium:
//   - Gateway /search-results: replaces carried-over ZIP, ticks Auto after Search Products draws
//     LOB checkboxes, never auto-clicks Search Products or Start Quote
//   - Policyholder Info -> Vehicle Prefill (real gds-card-selections host-click toggle + mutual
//     exclusivity clearing prefilled vehicle cards when AddVehicle is selected + auto-advance Next)
//   - Current Insurance, Vehicle Information (including "3+ years" -> "2 to 10 years" on a 10+
//     year-old vehicle), Driver Information, License History (age + DateFirstLicensed earliest month),
//     Incidents, Groups or Organizations
//   - Quote Summary: sticky-bar Recalculate, UMBI/UMPD lowering without raising, ERS+RR on every
//     full-coverage vehicle while liability-only stays declined, openDownloadInPanel /PrintQuote
//     tab opening (and fallback a.click()), plus silent-revert & .form-message Print guards
//   - Full 9-step clear auto-advance chain Policyholder -> Vehicle Prefill -> ... -> Quote Summary,
//     stopping cleanly on Quote Summary and holding Driver Details / Payment Plan stopSteps.

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
import { geicoPa } from '../src/carriers/geico-pa.js';
import { advanceFor } from '../src/units.js';
import { readPremium } from '../src/premium.js';
import { kitCode } from './lib/kit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');
const src = (/** @type {string} */ rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const KIT = [
  src('src/content/page-press.js'),
  src('src/content/field-key.js'),
  src('src/content/carriers/geico-pa.js'),
  await kitCode(),
].join('\n');
const HTML = src('test/fixtures/geico-pa/quote.html');
const GATEWAY_HTML = src('test/fixtures/geico-pa/gateway.html');
const PRINT_QUOTE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GEICO Quote Proposal</title></head><body><h1>Mock GEICO Quote Proposal</h1></body></html>';

const pdfBytes = new Uint8Array(fs.readFileSync(path.join(root, 'test/fixtures/personal-auto/intake-current.pdf')));
const raw = await readIntakeFields(pdfjs, pdfBytes);
const intake = readIntake(raw, { today: new Date('2026-11-24') });
if ('error' in intake) throw new Error(intake.error);
const { record } = intake;

let printQuoteRequests = 0;
const server = http.createServer((req, res) => {
  const reqUrl = req.url ?? '/';
  if (reqUrl.startsWith('/api/')) {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }, 120);
    return;
  }
  if (reqUrl.startsWith('/PrintQuote')) {
    printQuoteRequests++;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PRINT_QUOTE_HTML);
    return;
  }
  if (reqUrl.startsWith('/search-results')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(GATEWAY_HTML);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
const origin = `http://127.0.0.1:${addr.port}`;
const url = `${origin}/test/fixtures/geico-pa/quote.html`;
const gatewayUrl = `${origin}/search-results`;

const browser = await chromium.launch({ headless: !headed });
try {
  const context = await browser.newContext();
  await context.route('**/*', (route) => (route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort()));
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  /** @type {import('playwright').Page[]} */
  const popupPages = [];
  context.on('page', (p) => { if (p !== page) popupPages.push(p); });

  const loadFresh = async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: KIT });
  };

  /**
   * Mirrors sidepanel/panel/fill.js `openFillDocument` + `safeDocumentUrl` for local practice mocks:
   * validates same-origin http://127.0.0.1:<port> URL and opens it in a real new Chromium tab.
   * @param {any} report
   * @param {string} tabUrl
   * @returns {Promise<{ openedUrl: string, title: string } | null>}
   */
  const openPanelDocument = async (report, tabUrl) => {
    const rawUrl = report?.openDocumentUrl;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
    const doc = new URL(rawUrl);
    const tab = new URL(tabUrl);
    assert.equal(doc.origin, tab.origin, 'openDocumentUrl must match filled tab origin');
    assert.equal(doc.protocol, 'http:', 'local mock document URL uses http loopback');
    assert.equal(doc.hostname, '127.0.0.1');
    const tabPage = await context.newPage();
    try {
      await tabPage.goto(doc.href, { waitUntil: 'domcontentloaded' });
      const title = await tabPage.title();
      return { openedUrl: tabPage.url(), title };
    } finally {
      await tabPage.close();
    }
  };

  /**
   * @param {import('playwright').Page} targetPage
   * @param {any} [rec]
   * @param {{ advance?: any, doneSteps?: string[], openDownloadInPanel?: boolean }} [opts]
   */
  const fillOnPage = async (targetPage, rec = record, opts = {}) => {
    const plan = buildPlan(rec, geicoPa, {});
    return targetPage.evaluate(
      ({ p, stopSteps, advance, premiumPages, replaceChoices, doneSteps, openDownloadInPanel }) => /** @type {any} */ (globalThis).__raterKit.fill(p, {
        stopSteps, advance, premiumPages, replaceChoices, doneSteps, openDownloadInPanel,
      }),
      {
        p: plan,
        stopSteps: Object.keys(geicoPa.stopSteps ?? {}),
        advance: 'advance' in opts ? opts.advance : advanceFor(geicoPa),
        premiumPages: geicoPa.premiumPages ?? [],
        replaceChoices: !!geicoPa.replaceChoices,
        doneSteps: opts.doneSteps ?? [],
        openDownloadInPanel: 'openDownloadInPanel' in opts ? opts.openDownloadInPanel : true,
      },
    );
  };
  /**
   * @param {any} [rec]
   * @param {{ advance?: any, doneSteps?: string[], openDownloadInPanel?: boolean }} [opts]
   */
  const fillCurrentStep = (rec = record, opts = {}) => fillOnPage(page, rec, opts);
  const activeStep = () => page.evaluate(() => /** @type {any} */ (globalThis).__raterAdapter.shared.step());
  const setStep = (/** @type {string} */ stepName) => page.evaluate((s) => /** @type {any} */ (window).__setStep(s), stepName);

  // --- 0. Gateway /search-results (ZIP replacement + dynamic Auto checkbox after Search Products; never auto-clicks buttons) ---
  const gwPage = await context.newPage();
  gwPage.on('pageerror', (e) => errors.push(String(e)));
  try {
    await gwPage.goto(gatewayUrl, { waitUntil: 'domcontentloaded' });
    await gwPage.addScriptTag({ content: KIT });
    assert.equal(await gwPage.evaluate(() => /** @type {any} */ (globalThis).__raterAdapter.shared.step()), undefined);
    const rgw1 = await fillOnPage(gwPage);
    assert.equal(rgw1.failed.length, 0, `Gateway initial fill failed: ${JSON.stringify(rgw1.failed)}`);
    assert.equal(rgw1.unknown.length, 0, `Gateway initial fill unknown: ${JSON.stringify(rgw1.unknown)}`);
    assert.equal(rgw1.advanced ?? null, null, 'Gateway must never auto-advance');
    const gw1 = await gwPage.evaluate(() => ({
      zip: /** @type {HTMLInputElement} */ (document.getElementById('start-quote-zip')).value,
      searchClicks: /** @type {any} */ (window).__searchProductsClicks,
      startClicks: /** @type {any} */ (window).__startQuoteClicks,
    }));
    assert.deepEqual(gw1, { zip: '37901', searchClicks: 0, startClicks: 0 });

    // Agent clicks Search Products -> LOB checkboxes appear dynamically -> follow-up fill ticks Auto only.
    await gwPage.click('#btn-search-products');
    const rgw2 = await fillOnPage(gwPage);
    assert.equal(rgw2.failed.length, 0, `Gateway LOB fill failed: ${JSON.stringify(rgw2.failed)}`);
    assert.equal(rgw2.unknown.length, 0, `Gateway LOB fill unknown: ${JSON.stringify(rgw2.unknown)}`);
    assert.equal(rgw2.advanced ?? null, null, 'Gateway must never auto-advance after LOB draw');
    const gw2 = await gwPage.evaluate(() => ({
      zip: /** @type {HTMLInputElement} */ (document.getElementById('start-quote-zip')).value,
      auto: /** @type {HTMLInputElement} */ (document.getElementById('auto')).checked,
      commercial: /** @type {HTMLInputElement} */ (document.getElementById('commercial')).checked,
      motorcycle: /** @type {HTMLInputElement} */ (document.getElementById('motorcycle')).checked,
      umbrella: /** @type {HTMLInputElement} */ (document.getElementById('umbrella')).checked,
      searchClicks: /** @type {any} */ (window).__searchProductsClicks,
      startClicks: /** @type {any} */ (window).__startQuoteClicks,
    }));
    assert.deepEqual(gw2, {
      zip: '37901',
      auto: true,
      commercial: false,
      motorcycle: false,
      umbrella: false,
      searchClicks: 1,
      startClicks: 0,
    });
  } finally {
    await gwPage.close();
  }

  await loadFresh();

  // --- 1. Policyholder Information (clear -> auto-advances via Save and Continue to Vehicle Prefill) ---
  await setStep('Policyholder Information');
  assert.equal(await activeStep(), 'Policyholder Information');
  const r1 = await fillCurrentStep();
  assert.equal(r1.failed.length, 0, `Policyholder failed: ${JSON.stringify(r1.failed)}`);
  assert.equal(r1.unknown.length, 0, `Policyholder unknown: ${JSON.stringify(r1.unknown)}`);
  assert.equal(r1.kept.some((/** @type {any} */ k) => k.differs), false, `Prefilled Effective Date must not flag differs: ${JSON.stringify(r1.kept)}`);
  assert.equal(r1.advanced, 'Save and Continue', 'Clear Policyholder step must auto-advance');
  assert.equal(await activeStep(), 'Vehicle Prefill', 'Policyholder Save and Continue navigated to Vehicle Prefill');
  const phVals = await page.evaluate(() => {
    const sec = /** @type {HTMLElement} */ (/** @type {any} */ (window).__getPanel('Policyholder Information'));
    return {
      first: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveFirstName_90857')).value,
      last: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveLastName_10793')).value,
      dob: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveDateOfBirth_95389')).value,
      street: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveStreet_59106')).value,
      zip: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveZip_14049')).value,
      rentChecked: sec.querySelector('#Id_GiveOwnOrRent_793101')?.hasAttribute('checked'),
      email: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveEmail_78096')).value,
      phoneDigits: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GivePhoneNumber_76864')).value.replace(/\D/g, ''),
      effDate: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveEffectiveDate_58039')).value,
      ssn: /** @type {HTMLInputElement} */ (sec.querySelector('#Id_GiveSocialSecurityNumber_74851')).value,
      creditAck: /** @type {HTMLInputElement} */ (sec.querySelector('#checkbox-Id_GiveCreditAcknowledgement_11223-Yes')).checked,
    };
  });
  assert.deepEqual(phVals, {
    first: 'Jordan',
    last: 'Sample',
    dob: '02/03/1985',
    street: '100 EXAMPLE ST',
    zip: '37901',
    rentChecked: true,
    email: 'sample.client@example.com',
    phoneDigits: '5550100142',
    effDate: '11/25/2026',
    ssn: '',
    creditAck: true,
  });

  // --- 1b. Vehicle Prefill (0 current stepper items; auto-selects AddVehicle, clears prefilled card via mutual exclusivity, auto-advances Next -> Current Insurance) ---
  await page.evaluate(() => /** @type {any} */ (window).__resetVehiclePrefill({ preselect: ['mock-veh-1'] }));
  const prefillDrawer = await page.evaluate(() => ({
    currentCount: document.querySelectorAll('gds-vertical-stepper-item[state="current"]').length,
    completedCount: document.querySelectorAll('gds-vertical-stepper-item[state="completed"]').length,
  }));
  assert.deepEqual(prefillDrawer, { currentCount: 0, completedCount: 1 });
  const r1b = await fillCurrentStep();
  assert.equal(r1b.failed.length, 0, `Vehicle Prefill failed: ${JSON.stringify(r1b.failed)}`);
  assert.equal(r1b.unknown.length, 0, `Vehicle Prefill unknown: ${JSON.stringify(r1b.unknown)}`);
  assert.ok(r1b.filled.some((/** @type {any} */ f) => f.key === 'prefill:AddVehicle'), `AddVehicle must fill with stable key prefill:AddVehicle: ${JSON.stringify(r1b.filled)}`);
  assert.equal(r1b.advanced, 'Next', 'Vehicle Prefill must auto-advance via Next');
  assert.equal(await activeStep(), 'Current Insurance', 'Vehicle Prefill Next navigated to Current Insurance');
  const vpVals = await page.evaluate(() => /** @type {any} */ (window).__lastVehiclePrefillVals);
  assert.deepEqual(vpVals, {
    selectedValues: ['AddVehicle'],
    checkedValues: ['AddVehicle'],
    addVehicleSelected: true,
    addVehicleChecked: true,
  });

  // --- 2. Current Insurance (Yes -> Select2 "Not Listed" -> XHR spawns Years + BI; "1-3 years" -> "1" standard -> auto-advances Next -> Vehicle Information) ---
  assert.equal(await activeStep(), 'Current Insurance');
  const r2 = await fillCurrentStep();
  assert.equal(r2.failed.length, 0, `Current Insurance failed: ${JSON.stringify(r2.failed)}`);
  assert.equal(r2.unknown.length, 0, `Current Insurance unknown: ${JSON.stringify(r2.unknown)}`);
  assert.equal(r2.advanced, 'Next', 'Clear Current Insurance (1-3 years -> 1 standard) must auto-advance via Next');
  assert.equal(await activeStep(), 'Vehicle Information', 'Current Insurance Next navigated to Vehicle Information');
  const ciVals = await page.evaluate(() => {
    const sec = /** @type {HTMLElement} */ (/** @type {any} */ (window).__getPanel('Current Insurance'));
    return {
      yesChecked: sec.querySelector('#Id_GiveCurrentAutoInsuranceStatus_357430')?.hasAttribute('checked'),
      provider: /** @type {HTMLSelectElement} */ (sec.querySelector('#Id_GiveCurrentAutoInsuranceProvider_38641')).selectedOptions[0]?.text,
      years: /** @type {HTMLSelectElement | null} */ (sec.querySelector('[id^="Id_GiveYearsWithCurrentAutoInsurer_"]'))?.selectedOptions[0]?.text ?? null,
      biLimits: /** @type {HTMLSelectElement | null} */ (sec.querySelector('[id^="Id_GiveCurrentBodilyInjuryLimits_"]'))?.selectedOptions[0]?.text ?? null,
    };
  });
  assert.equal(ciVals.yesChecked, true);
  assert.equal(ciVals.provider, 'Not Listed');
  assert.equal(ciVals.years, '1', 'Closed range "1-3 years" maps to lower-bound "1" (TNI standard)');
  assert.equal(ciVals.biLimits, '$50,000/$100,000');

  // --- 3. Vehicle Information (adds Vehicle 2 via XHR, decodes VIN 1, Primary Use settles before Annual Mileage; missing ownership length holds advance) ---
  assert.equal(await activeStep(), 'Vehicle Information');
  const r3 = await fillCurrentStep();
  assert.equal(r3.failed.length, 0, `Vehicle Info failed: ${JSON.stringify(r3.failed)}`);
  assert.equal(r3.unknown.length, 0, `Vehicle Info unknown: ${JSON.stringify(r3.unknown)}`);
  assert.equal(r3.advanced ?? null, null, 'Length of ownership blocker must hold auto-advance');
  const vehVals = await page.evaluate(() => {
    const colSel = (/** @type {number} */ col, /** @type {string} */ prefix) => {
      const el = /** @type {HTMLSelectElement | HTMLInputElement | null} */ (
        document.querySelector(`#veh-tbody td:nth-child(${col + 1}) select[id^="${prefix}"], #veh-tbody td:nth-child(${col + 1}) input[id^="${prefix}"]`)
      );
      if (!el) return null;
      return el.tagName === 'SELECT' ? /** @type {HTMLSelectElement} */ (el).selectedOptions[0]?.text ?? '' : el.value;
    };
    return {
      cols: document.querySelectorAll('#veh-head-row td').length - 1,
      addClicks: /** @type {any} */ (window).__addVehicleClicks,
      v1HasVin: colSel(1, 'Id_YesNoPreQuoteHaveFullVinActivity_'),
      v1Vin: colSel(1, 'Id_GiveVinPreQuote_'),
      v1Owner: colSel(1, 'Id_GiveVehicleOwnerShip_'),
      v1Use: colSel(1, 'Id_GiveVehiclePrimaryUse_'),
      v1Days: colSel(1, 'Id_GiveDaysPerWeekCommute_'),
      v1CommuteMiles: colSel(1, 'Id_GiveMilesOneWay_'),
      v1AnnualMiles: colSel(1, 'Id_GiveAnnualMileage_'),
      v2Owner: colSel(2, 'Id_GiveVehicleOwnerShip_'),
      v2Use: colSel(2, 'Id_GiveVehiclePrimaryUse_'),
      v2AnnualMiles: colSel(2, 'Id_GiveAnnualMileage_'),
    };
  });
  assert.equal(vehVals.cols, 2);
  assert.equal(vehVals.addClicks, 1);
  assert.equal(vehVals.v1HasVin, 'Yes');
  assert.equal(vehVals.v1Vin, '1HGCM82633A004352');
  assert.equal(vehVals.v1Owner, 'Financed');
  assert.equal(vehVals.v1Use, 'Commute');
  assert.equal(vehVals.v1Days, '5');
  assert.equal(vehVals.v1CommuteMiles, '15');
  assert.equal(vehVals.v1AnnualMiles, '12,000 - 12,999', 'Annual Mileage must hold after Primary Use XHR');
  assert.equal(vehVals.v2Owner, 'Owned');
  assert.equal(vehVals.v2Use, 'Pleasure');
  assert.equal(vehVals.v2AnnualMiles, '30,000+', 'Vehicle 2 50,000+ maps to 30,000+ after Pleasure XHR');

  // --- 4. Driver Information (Married auto-spawns Column 2 WITHOUT clicking Add Driver; Industry holds advance) ---
  await setStep('Driver Information');
  assert.equal(await activeStep(), 'Driver Information');
  const r4 = await fillCurrentStep();
  assert.equal(r4.failed.length, 0, `Driver Info failed: ${JSON.stringify(r4.failed)}`);
  assert.equal(r4.unknown.length, 0, `Driver Info unknown: ${JSON.stringify(r4.unknown)}`);
  assert.equal(r4.advanced ?? null, null, 'Industry blocker must hold auto-advance');
  const drvVals = await page.evaluate(() => {
    const colVal = (/** @type {number} */ col, /** @type {string} */ prefix) => {
      const el = /** @type {HTMLSelectElement | HTMLInputElement | null} */ (
        document.querySelector(`#drv-tbody td:nth-child(${col + 1}) select[id^="${prefix}"], #drv-tbody td:nth-child(${col + 1}) input[id^="${prefix}"]`)
      );
      if (!el) return null;
      return el.tagName === 'SELECT' ? /** @type {HTMLSelectElement} */ (el).selectedOptions[0]?.text ?? '' : el.value;
    };
    return {
      cols: document.querySelectorAll('#drv-head-row td').length - 1,
      marriedSpawned: /** @type {any} */ (window).__marriedAutoSpawned,
      addDriverClicks: /** @type {any} */ (window).__addDriverClicks,
      d1First: colVal(1, 'Id_GiveFirstName_'),
      d1Last: colVal(1, 'Id_GiveLastName_'),
      d1Dob: colVal(1, 'Id_GiveDateOfBirth_'),
      d1Gender: colVal(1, 'Id_GiveGender_'),
      d1Marital: colVal(1, 'Id_GiveMaritalStatus_'),
      d1Edu: colVal(1, 'Id_GiveEducationLevel_'),
      d1Emp: colVal(1, 'Id_GiveEmploymentStatus_'),
      d1Lic: colVal(1, 'Id_GiveDriversLicenseStatus_'),
      d1Def: colVal(1, 'Id_YesNoDefensiveDriverCourse_'),
      d2First: colVal(2, 'Id_GiveFirstName_'),
      d2Last: colVal(2, 'Id_GiveLastName_'),
      d2Dob: colVal(2, 'Id_GiveDateOfBirth_'),
      d2Gender: colVal(2, 'Id_GiveGender_'),
      d2Marital: colVal(2, 'Id_GiveMaritalStatus_'),
      d2Rel: colVal(2, 'Id_GiveRelationshipToInsured_'),
      d2Lic: colVal(2, 'Id_GiveDriversLicenseStatus_'),
      d2Insure: colVal(2, 'Id_GiveDriverExclusionInsuredYesNo_'),
      d2GoodStudent: colVal(2, 'Id_YesNoGoodStudentDiscount_'),
      d2StudentAway: colVal(2, 'Id_GiveStudentAway_'),
      d2Def: colVal(2, 'Id_YesNoDefensiveDriverCourse_'),
      allDrvAck: /** @type {HTMLInputElement} */ (document.getElementById('checkbox-Id_GiveAllDriversAcknowledgement_40067-Yes')).checked,
    };
  });
  assert.deepEqual(drvVals, {
    cols: 2,
    marriedSpawned: true,
    addDriverClicks: 0,
    d1First: 'Jordan',
    d1Last: 'Sample',
    d1Dob: '02/03/1985',
    d1Gender: 'Female',
    d1Marital: 'Married',
    d1Edu: 'Bachelors',
    d1Emp: 'A Private Company/Organization or Self Employed',
    d1Lic: 'Active',
    d1Def: 'Yes',
    d2First: 'Casey',
    d2Last: 'Sample',
    d2Dob: '07/09/2007',
    d2Gender: 'Male',
    d2Marital: 'Single',
    d2Rel: 'Child',
    d2Lic: 'Active',
    d2Insure: 'Yes',
    d2GoodStudent: 'Yes',
    d2StudentAway: 'No',
    d2Def: 'No',
    allDrvAck: true,
  });

  // --- 5. License History (Driver 1 Yes + Driver 2 age 16 -> /api/lookup/DateFirstLicensed -> July 2023 -> auto-advance!) ---
  await setStep('License History');
  assert.equal(await activeStep(), 'License History');
  const r5 = await fillCurrentStep();
  assert.equal(r5.failed.length, 0, `License History failed: ${JSON.stringify(r5.failed)}`);
  assert.equal(r5.unknown.length, 0, `License History unknown: ${JSON.stringify(r5.unknown)}`);
  assert.equal(r5.advanced, 'Save and Continue', 'Clear License History must auto-advance');
  assert.equal(await activeStep(), 'Select Drivers with Incidents');
  const licVals = await page.evaluate(() => /** @type {any} */ (window).__lastLicenseHistoryVals);
  assert.equal(licVals.d1Yes, true);
  assert.equal(licVals.d2Age, '16', 'Driver 2 age first licensed (2023 - 2007 = 16) calculated');
  assert.equal(licVals.d2MonthYear, 'July 2023', 'Earliest non-placeholder month picked after DateFirstLicensed XHR');
  assert.equal(licVals.d2MonthOptions.length, 13, 'Please Select + 12 months rendered');

  // --- 6. Select Drivers with Incidents (0 fields, clean record -> auto-advances via Next!) ---
  assert.equal(await activeStep(), 'Select Drivers with Incidents');
  const r6 = await fillCurrentStep();
  assert.equal(r6.failed.length, 0, `Incidents failed: ${JSON.stringify(r6.failed)}`);
  assert.equal(r6.unknown.length, 0, `Incidents unknown: ${JSON.stringify(r6.unknown)}`);
  assert.equal(r6.advanced, 'Next', 'Clean Incidents step must auto-advance via Next');
  assert.equal(await activeStep(), 'Groups or Organizations');

  // --- 7. Groups or Organizations (keeps "Not a member..." -> auto-advances via Save and Continue to Quote Summary!) ---
  assert.equal(await activeStep(), 'Groups or Organizations');
  const r7 = await fillCurrentStep();
  assert.equal(r7.failed.length, 0, `Groups failed: ${JSON.stringify(r7.failed)}`);
  assert.equal(r7.unknown.length, 0, `Groups unknown: ${JSON.stringify(r7.unknown)}`);
  assert.equal(r7.advanced, 'Save and Continue', 'Clear Groups step must auto-advance to Quote Summary');
  assert.equal(await activeStep(), 'Quote Summary');
  const grpVal = await page.evaluate(() => {
    const sec = /** @type {HTMLElement} */ (/** @type {any} */ (window).__getPanel('Groups or Organizations'));
    return /** @type {HTMLSelectElement} */ (sec.querySelector('#Id_GiveSponsoredMarketing_84701')).selectedOptions[0]?.text;
  });
  assert.equal(grpVal, 'Not a member of any of these organizations');

  // --- 8a. Quote Summary: 100/300/100 + openDownloadInPanel opens real /PrintQuote tab without MAIN-world a.click() ---
  assert.equal(await activeStep(), 'Quote Summary');
  const printHitsBefore8a = printQuoteRequests;
  const r8a = await fillCurrentStep();
  assert.equal(r8a.failed.length, 0, `Quote Summary (100/300/100) failed: ${JSON.stringify(r8a.failed)}`);
  assert.equal(r8a.unknown.length, 0, `Quote Summary (100/300/100) unknown: ${JSON.stringify(r8a.unknown)}`);
  assert.equal(r8a.advanced ?? null, null, 'Quote Summary must NEVER auto-advance');
  assert.equal(await activeStep(), 'Quote Summary', 'Must stay on Quote Summary');
  assert.equal(r8a.openDocumentUrl, `${origin}/PrintQuote?quote=mock`, 'openDownloadInPanel must return resolved /PrintQuote URL');
  assert.equal(r8a.documentPending, true);
  assert.ok(r8a.actions?.some((/** @type {any} */ a) => a.id === 'printProposal'), 'printProposal action recorded');
  const opened8a = await openPanelDocument(r8a, page.url());
  assert.deepEqual(opened8a, { openedUrl: `${origin}/PrintQuote?quote=mock`, title: 'GEICO Quote Proposal' });
  assert.equal(printQuoteRequests, printHitsBefore8a + 1, '/PrintQuote tab must actually load on the mock server');
  const qs8a = await page.evaluate(() => ({
    editClicks: /** @type {any} */ (window).__editCoveragesClicks,
    recalcClicks: /** @type {any} */ (window).__recalculateClicks,
    recalcBySource: /** @type {any} */ (window).__recalcClicksBySource,
    recalcReverted: /** @type {any} */ (window).__recalcReverted,
    printClicks: /** @type {any} */ (window).__printProposalClicks,
    nextClicks: /** @type {any} */ (window).__quoteSummaryNextClicks,
    saved: /** @type {any} */ (window).__savedCoverages,
    primaryHdr: /** @type {HTMLInputElement} */ (document.getElementById('checkbox-Id_PrimaryHeader_12345-')).checked,
    text: document.body.innerText,
  }));
  assert.equal(qs8a.recalcClicks, 1);
  assert.deepEqual(qs8a.recalcBySource, { top: 0, sticky: 1 }, 'Must click bottom gds-sticky-bar Recalculate, never top stacked button');
  assert.equal(qs8a.recalcReverted, null, 'Recalculate must stick with zero revert');
  assert.equal(qs8a.printClicks, 0, 'openDownloadInPanel skips MAIN-world a.click() to prevent double tabs');
  assert.equal(qs8a.nextClicks, 0, 'Next on Quote Summary must NEVER be clicked');
  assert.equal(qs8a.primaryHdr, true);
  assert.equal(qs8a.saved.bi, '$100,000/$300,000');
  assert.equal(qs8a.saved.pd, '$100,000');
  assert.equal(qs8a.saved.umbi, '$50,000/$100,000', 'UMBI must NOT be raised when BI rises above default');
  assert.equal(qs8a.saved.umpd, '$50,000', 'UMPD must NOT be raised when PD rises above default');
  assert.equal(qs8a.saved.pcf, 'I decline');
  assert.equal(qs8a.saved.med, '$5,000', 'MED default kept');
  assert.equal(qs8a.saved.v1_comp, '$500 deductible');
  assert.equal(qs8a.saved.v1_coll, '$1,000 deductible');
  assert.equal(qs8a.saved.v1_ers, 'I accept this coverage', 'Full-coverage vehicle must accept ERS');
  assert.equal(qs8a.saved.v1_rr, '$50/day, $1,500 max per claim', 'Full-coverage vehicle must set RR $50/day');
  assert.equal(qs8a.saved.v2_comp, 'I decline');
  assert.equal(qs8a.saved.v2_coll, 'I decline');
  assert.equal(qs8a.saved.v2_ers, 'I decline', 'Liability-only vehicle must keep ERS declined');
  assert.equal(qs8a.saved.v2_rr, 'I decline', 'Liability-only vehicle must keep RR declined');
  assert.equal(readPremium(qs8a.text)?.total, 1142);

  // --- 8b. Quote Summary: 25/50/25 (lowers UMBI/UMPD to match BI/PD so Recalculate sticks; sets ERS+RR even when Comp/Coll already matched default!) ---
  await page.evaluate(() => /** @type {any} */ (window).__resetQuoteSummary({
    v1_comp: '$500 deductible',
    v1_coll: '$1,000 deductible',
    v1_ers: 'I decline',
    v1_rr: 'I decline',
  }));
  const lowLimitRec = structuredClone(record);
  lowLimitRec.coverage.liabilityLimit = '25/50/25';
  const printHitsBefore8b = printQuoteRequests;
  const r8b = await fillCurrentStep(lowLimitRec);
  assert.equal(r8b.failed.length, 0, `Quote Summary (25/50/25) failed: ${JSON.stringify(r8b.failed)}`);
  assert.equal(r8b.openDocumentUrl, `${origin}/PrintQuote?quote=mock`);
  const opened8b = await openPanelDocument(r8b, page.url());
  assert.deepEqual(opened8b, { openedUrl: `${origin}/PrintQuote?quote=mock`, title: 'GEICO Quote Proposal' });
  assert.equal(printQuoteRequests, printHitsBefore8b + 1);
  const qs8b = await page.evaluate(() => ({
    recalcClicks: /** @type {any} */ (window).__recalculateClicks,
    recalcBySource: /** @type {any} */ (window).__recalcClicksBySource,
    recalcReverted: /** @type {any} */ (window).__recalcReverted,
    printClicks: /** @type {any} */ (window).__printProposalClicks,
    nextClicks: /** @type {any} */ (window).__quoteSummaryNextClicks,
    saved: /** @type {any} */ (window).__savedCoverages,
    text: document.body.innerText,
  }));
  assert.equal(qs8b.recalcClicks, 1);
  assert.deepEqual(qs8b.recalcBySource, { top: 0, sticky: 1 });
  assert.equal(qs8b.recalcReverted, null, 'Lowering UMBI/UMPD prevented GEICO silent revert');
  assert.equal(qs8b.printClicks, 0);
  assert.equal(qs8b.nextClicks, 0);
  assert.equal(qs8b.saved.bi, '$25,000/$50,000');
  assert.equal(qs8b.saved.umbi, '$25,000/$50,000', 'UMBI lowered to match BI');
  assert.equal(qs8b.saved.pd, '$25,000');
  assert.equal(qs8b.saved.umpd, '$25,000', 'UMPD lowered to match PD');
  assert.equal(qs8b.saved.v1_ers, 'I accept this coverage', 'ERS set even when Comp/Coll already matched default');
  assert.equal(qs8b.saved.v1_rr, '$50/day, $1,500 max per claim', 'RR set even when Comp/Coll already matched default');
  assert.equal(qs8b.saved.v2_ers, 'I decline');
  assert.equal(qs8b.saved.v2_rr, 'I decline');
  assert.equal(readPremium(qs8b.text)?.total, 918);

  // --- 8c. Quote Summary Regression Trap: Silent Revert blocks Print Quote Proposal (no openDocumentUrl, no tab opened) ---
  await page.evaluate(() => /** @type {any} */ (window).__resetQuoteSummary({}, { forceSilentRevert: true }));
  const printHitsBefore8c = printQuoteRequests;
  const r8c = await fillCurrentStep(record);
  const qs8c = await page.evaluate(() => ({
    editClicks: /** @type {any} */ (window).__editCoveragesClicks,
    recalcClicks: /** @type {any} */ (window).__recalculateClicks,
    recalcReverted: /** @type {any} */ (window).__recalcReverted,
    printClicks: /** @type {any} */ (window).__printProposalClicks,
    nextClicks: /** @type {any} */ (window).__quoteSummaryNextClicks,
  }));
  assert.equal(qs8c.recalcClicks, 1);
  assert.equal(qs8c.recalcReverted?.reason, 'forced');
  assert.ok(qs8c.editClicks >= 2, 'Post-recalculate check reopened Edit to inspect persisted selects');
  assert.ok(r8c.failed.length > 0, 'Silent revert must produce failed/changed answers');
  assert.equal(r8c.premium ?? null, null, 'Stale reverted premium must be rejected');
  assert.equal(r8c.openDocumentUrl ?? null, null, 'Silent revert MUST NOT return openDocumentUrl');
  assert.equal(qs8c.printClicks, 0, 'Print Quote Proposal MUST NOT fire when Recalculate silently reverted edits');
  assert.equal(printQuoteRequests, printHitsBefore8c, '/PrintQuote must NOT be requested on silent revert');
  assert.equal(qs8c.nextClicks, 0);

  // --- 8d. Quote Summary Regression Trap: Visible .form-message error blocks Print Quote Proposal (no openDocumentUrl, no tab opened) ---
  await page.evaluate(() => /** @type {any} */ (window).__resetQuoteSummary({}, { forceFormError: 'Coverage selection could not be updated.' }));
  const printHitsBefore8d = printQuoteRequests;
  const r8d = await fillCurrentStep(record);
  const qs8d = await page.evaluate(() => ({
    printClicks: /** @type {any} */ (window).__printProposalClicks,
    nextClicks: /** @type {any} */ (window).__quoteSummaryNextClicks,
  }));
  assert.ok(r8d.failed.length > 0, 'Visible .form-message after Recalculate must flag failure');
  assert.equal(r8d.openDocumentUrl ?? null, null, 'Visible .form-message MUST NOT return openDocumentUrl');
  assert.equal(qs8d.printClicks, 0, 'Print Quote Proposal MUST NOT fire when .form-message error is visible');
  assert.equal(printQuoteRequests, printHitsBefore8d, '/PrintQuote must NOT be requested on .form-message error');
  assert.equal(qs8d.nextClicks, 0);

  // --- 8e. Fallback mode (openDownloadInPanel: false): clicks shadow <a target="_blank"> directly ---
  await page.evaluate(() => /** @type {any} */ (window).__resetQuoteSummary());
  popupPages.length = 0;
  const r8e = await fillCurrentStep(record, { openDownloadInPanel: false });
  assert.equal(r8e.failed.length, 0, `Quote Summary fallback failed: ${JSON.stringify(r8e.failed)}`);
  assert.equal(r8e.openDocumentUrl ?? null, null, 'openDownloadInPanel: false must not set openDocumentUrl');
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__printProposalClicks), 1, 'Fallback mode clicks shadow <a>');
  for (const p of popupPages.splice(0)) await p.close().catch(() => {});

  // --- 9. Full Clear Auto-Advance Chain (9 steps): Policyholder -> Vehicle Prefill -> ... -> Quote Summary, stopping at Quote Summary ---
  await loadFresh();
  const clearRec = structuredClone(record);
  clearRec.priorInsurance[0].insuredFor = '5+ years';
  clearRec.priorInsurance[0].limit = 'State Minimum or less';
  clearRec.vehicles[0].ownedFor = '6 months - 1 year';
  clearRec.vehicles[1].vin = '1HGCM82653A004353';
  // 2015 Toyota Corolla (11 years old) with "3+ years" must map unconditionally to "2 to 10 years" (standard).
  clearRec.vehicles[1].ownedFor = '3+ years';
  clearRec.drivers[0].occupation = 'Homemaker';
  clearRec.drivers[1].education = 'High School Diploma';
  clearRec.drivers[1].occupation = 'Student';
  clearRec.coverage.liabilityLimit = '25/50/25';

  /** @type {string[]} */
  const visitedSteps = [];
  /** @type {string[]} */
  const doneSteps = [];
  let finishedQuoteSummary = false;
  let chainReport = null;
  let chainCiYears = null;
  let chainCiBiLimits = null;
  let chainVeh2OwnedLength = null;
  const printHitsBeforeChain = printQuoteRequests;
  for (let i = 0; i < 12; i++) {
    const step = await activeStep();
    visitedSteps.push(step);
    const res = await fillCurrentStep(clearRec, { doneSteps });
    assert.equal(res.failed.length, 0, `Auto-advance step "${step}" failed: ${JSON.stringify(res.failed)}`);
    assert.equal(res.unknown.length, 0, `Auto-advance step "${step}" unknown: ${JSON.stringify(res.unknown)}`);
    if (step === 'Current Insurance') {
      ({ years: chainCiYears, biLimits: chainCiBiLimits } = await page.evaluate(() => {
        const sec = /** @type {HTMLElement} */ (/** @type {any} */ (window).__getPanel('Current Insurance'));
        const yrSel = /** @type {HTMLSelectElement | null} */ (sec.querySelector('[id^="Id_GiveYearsWithCurrentAutoInsurer_"]'));
        const biSel = /** @type {HTMLSelectElement | null} */ (sec.querySelector('[id^="Id_GiveCurrentBodilyInjuryLimits_"]'));
        return {
          years: yrSel?.selectedOptions[0]?.text ?? null,
          biLimits: biSel?.selectedOptions[0]?.text ?? null,
        };
      }));
    }
    if (step === 'Vehicle Information') {
      chainVeh2OwnedLength = await page.evaluate(() => {
        const sec = /** @type {HTMLElement} */ (/** @type {any} */ (window).__getPanel('Vehicle Information'));
        const sel = /** @type {HTMLSelectElement | null} */ (sec.querySelector('#veh-tbody td:nth-child(3) select[id^="Id_GiveLengthOfOwnership_"]'));
        return sel?.selectedOptions[0]?.text ?? null;
      });
    }
    if (res.advanced && res.stepKey) doneSteps.push(res.stepKey);
    if (step === 'Quote Summary') {
      assert.equal(res.advanced ?? null, null, 'Auto-advance chain must STOP on Quote Summary');
      chainReport = res;
      finishedQuoteSummary = true;
      break;
    }
    assert.ok(res.advanced, `Clear step "${step}" should have auto-advanced (blockers: ${JSON.stringify(res.blockers)})`);
  }
  assert.equal(finishedQuoteSummary, true);
  assert.deepEqual(visitedSteps, [
    'Policyholder Information',
    'Vehicle Prefill',
    'Current Insurance',
    'Vehicle Information',
    'Driver Information',
    'License History',
    'Select Drivers with Incidents',
    'Groups or Organizations',
    'Quote Summary',
  ]);
  assert.equal(chainCiYears, '6', 'Open-ended "5+ years" must select "6" (first whole year above N)');
  assert.equal(chainCiBiLimits, '$25,000/$50,000', '"State Minimum or less" must pick lowest split option ($25,000/$50,000) on Current Insurance');
  assert.equal(chainVeh2OwnedLength, '2 to 10 years', '10+ year-old vehicle with "3+ years" must select "2 to 10 years"');
  const openedChain = await openPanelDocument(chainReport, page.url());
  assert.deepEqual(openedChain, { openedUrl: `${origin}/PrintQuote?quote=mock`, title: 'GEICO Quote Proposal' });
  assert.equal(printQuoteRequests, printHitsBeforeChain + 1);
  const chainQs = await page.evaluate(() => ({
    step: /** @type {any} */ (globalThis).__raterAdapter.shared.step(),
    recalcBySource: /** @type {any} */ (window).__recalcClicksBySource,
    recalcReverted: /** @type {any} */ (window).__recalcReverted,
    printClicks: /** @type {any} */ (window).__printProposalClicks,
    nextClicks: /** @type {any} */ (window).__quoteSummaryNextClicks,
    saved: /** @type {any} */ (window).__savedCoverages,
  }));
  assert.equal(chainQs.step, 'Quote Summary', 'Auto-advance chain must end on Quote Summary, never Finalize/Payment');
  assert.deepEqual(chainQs.recalcBySource, { top: 0, sticky: 1 });
  assert.equal(chainQs.recalcReverted, null);
  assert.equal(chainQs.printClicks, 0);
  assert.equal(chainQs.nextClicks, 0);
  assert.equal(chainQs.saved.bi, '$25,000/$50,000');
  assert.equal(chainQs.saved.umbi, '$25,000/$50,000');
  assert.equal(chainQs.saved.pd, '$25,000');
  assert.equal(chainQs.saved.umpd, '$25,000');
  assert.equal(chainQs.saved.v1_ers, 'I accept this coverage');
  assert.equal(chainQs.saved.v1_rr, '$50/day, $1,500 max per claim');
  assert.equal(chainQs.saved.v2_ers, 'I decline');
  assert.equal(chainQs.saved.v2_rr, 'I decline');

  // --- 10. Post-quote stopSteps (Driver Details & Payment Plan): fill nothing, click nothing, halt immediately ---
  for (const stopStep of ['Driver Details', 'Payment Plan']) {
    await setStep(stopStep);
    assert.equal(await activeStep(), stopStep);
    const rStop = await fillCurrentStep(clearRec);
    assert.equal(rStop.filled.length, 0, `${stopStep} must fill nothing`);
    assert.equal(rStop.halted, true, `${stopStep} must halt immediately`);
    assert.equal(rStop.advanced ?? null, null, `${stopStep} must never auto-advance`);
  }
  assert.equal(await page.evaluate(() => /** @type {any} */ (window).__paymentSubmitClicks), 0);

  assert.deepEqual(errors, [], `Page errors: ${errors.join('; ')}`);
  const totalFilled = [r1, r1b, r2, r3, r4, r5, r6, r7, r8a].reduce((n, r) => n + r.filled.length, 0);
  console.log(`GEICO PA Phase 3 mock OK: gateway /search-results (ZIP + Auto, buttons never auto-clicked), ${totalFilled} answers across 9 quote steps (including Vehicle Prefill AddVehicle + mutual exclusivity + auto-advance and 3+ years -> 2 to 10 years), openDownloadInPanel /PrintQuote tab opening + fallback + silent-revert/.form-message guards, 9-step clear auto-advance chain stopped cleanly on Quote Summary, Driver Details & Payment Plan stopSteps held.`);
} finally {
  await browser.close();
  server.close();
}
