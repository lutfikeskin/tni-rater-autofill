#!/usr/bin/env node
// AmWINS end to end, without the live site: the saved Business Auto application
// (test/fixtures/amwins/application.html, client details removed) with the site's behaviour
// played by test/fixtures/amwins/mock.js, filled step by step by the real fill engine and AmWINS
// rules the way the side panel does it (fill, Save & Continue when nothing is left, fill the next
// step). Then every answer is checked against what TNI expects.
//
//   npm run mock:amwins             # exits 1 when an answer is wrong or a step stops
//   npm run mock:amwins -- --headed # watch it

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildPlan } from '../src/plan.js';
import { amwins } from '../src/carriers/amwins.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headed = process.argv.includes('--headed');
const PAGEKIT = fs.readFileSync(path.join(root, 'src/content/pagekit.js'), 'utf8');

// A synthetic client like the recorded quotes: an expediter with a box truck, no company name.
const record = {
  applicant: { name: null, dot: '1234567', mc: 'MC-765432', owner1: 'SAMPLE', phone: '(402) 555-0100', email: 'client@example.test', yearsInBusiness: null, yearsExperience: 7, yearEstablished: null },
  garaging: { street: '1 Test Way', unit: null, city: 'Omaha', state: 'NE', zip: '68102' },
  operations: { businessClass: 'Expediter', whatHaul: 'General freight hauler', radius: 'Unlimited', radiusMiles: null, hazmat: false, filingsRequired: true, filingsWhich: 'Federal Liability Filing', vehicleOwnership: 'Owned' },
  drivers: [{ first: 'SAMPLE A', middle: null, last: 'DRIVER', dob: '01/02/1968', licenseNumber: 'H1234567', licenseState: 'NE', maritalStatus: 'Married' }],
  vehicles: [{ type: 'Box Truck', year: 2019, make: 'ISUZU', model: 'NPR', vin: '54DC4W1B5KS800000', value: 45000 }],
  trailers: [],
  priorInsurance: [{ type: 'Commercial Auto', carrier: 'PROGRESSIVE', limit: '$1M CSL', expiration: '12/01/2026' }],
  coverage: { autoLiabLimit: '$1M', cargo: true, cargoLimit: 100000, cargoDeductible: 1000 },
  claims: { hasClaims: false },
};

// What each answer must be when the run ends. [selector, expected] — a radio group by its name.
const EXPECT = [
  ['#name', 'SAMPLE DRIVER'], ['#ownerName', 'SAMPLE DRIVER'], ['#ownerDob', '01/02/1968'],
  ['#mailingAddress', '1 Test Way'], ['#mailingCity', 'Omaha'], ['#mailingState', 'Nebraska'], ['#mailingZip', '68102'], ['#businessPhone', '4025550100'],
  ['#entityType', 'SOLE PROPRIETOR'], ['#yrsInBusiness', '5+'], ['#yearBusinessEstablished', String(new Date().getFullYear())],
  ['radio:isNonProfit', 'No'], ['#inspectionContactName', 'SAMPLE DRIVER'], ['#inspectionContactOfficePhone', '4025550100'],
  ['#inspectionContactEmail', ''], ['radio:isSingleContact', 'Yes'], ['#sameAsMailingAddress0_0_', true],
  ['#garagePanel [data-id="address"]', '1 Test Way'], ['#garagePanel [data-id="city"]', 'Omaha'], ['#garagePanel [data-id="state"]', 'Nebraska'], ['#garagePanel [data-id="zip"]', '68102'],
  ['#natureOfBusiness', 'TRANSPORTATION'], ['#classCodeAndDescription', '484122 - General freight trucking, long-distance, less-than-truckload (LTL)'], ['#operationDescription', 'Trucking for Hire - Other for hire trucking'],
  ['#retailOrServiceOperationPert', '0'],
  ...[0, 1, 2].map((n) => [`#priorCarrierCoveragePanel${n} [data-id="carrierName"]`, 'NO PRIOR']),
  ['radio:valuedLossRuns', 'No'], ['radio:anyPriorLoss', 'No'], ['radio:hasAdditionalInterest', 'No'], ['#waiverType', 'NONE'],
  ['radio:fillingRequired', 'Yes'], ['#hasDotNumber', true], ['#hasMcNumber', true], ['#noNumber', false], ['#dotNumber', '1234567'], ['#mcNumber', '765432'],
  ['#howLongFederalOperatingAuthorityActive', 'MORE THAN 3 YEARS'], ['#howLongWithCurrentCarrier', '1 TO 2 YEARS'], ['radio:canProvideClaimFreeLossRun', 'No'], ['radio:federalBmc91', 'Yes'], ['radio:federalLiabilityMcs90', 'Yes'], ['radio:federalCargoBmc32', 'No'],
  ['#driversPanel [data-id="firstName"]', 'SAMPLE A'], ['#driversPanel [data-id="lastName"]', 'DRIVER'], ['#driversPanel [data-id="dateOfBirth"]', '01/02/1968'],
  ['#driversPanel [data-id="gender"]', 'MALE'], ['#driversPanel [data-id="martialStatus"]', 'MARRIED'], ['#driversPanel [data-id="licenseYear"]', '1985'],
  ['#driversPanel [data-id="licenseNumber"]', 'H1234567'], ['#driversPanel [data-id="licenseState"]', 'Nebraska'],
  ['#vehLookupVin', ''], ['#vehiclesPanel [data-id="vin"]', '54DC4W1B5KS800000'], ['#vehiclesPanel [data-id="bodyType"]', 'Box Truck'],
  ['#vehiclesPanel [data-id="grossVehicleWeight"]', '14500'], ['#marketValue', /45,?000/], ['#vehiclesPanel [data-id="usageType"]', 'FOR HIRE'],
  ['#vehiclesPanel [data-id="radius"]', '201 + MILES'], ['radio:permanentlyAttachedEquipment_0_', 'No'],
  ['#cslLiabilityLimit', '$1M'], ['#medicalPayment', '$5,000'], ['radio:uninsuredMotorists', 'Yes'], ['#uninsuredMotoristsLimit', '$100K'],
  ['#comprehensiveDeductible', '$1,000'], ['#collisionDeductible', '$1,000'], ['radio:hasWaiverOfCollision', 'No'], ['#towingAndLaborReimbursement', '$75'],
  ['#transportationExpenseReimbursement', '$40 day / $1,200 total'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`#autoSymbol${n}`, n === 6]),
  ...['medicalPayment', 'uninsuredMotorists', 'comprehensiveDeductible', 'collisionDeductible', 'towingAndLaborReimbursement', 'transportationExpenseReimbursement']
    .map((c) => [`[name="${c}Exclude"]`, false]),
  ...['subsidiaryToOther', 'subsidiary', 'safetyInfo', 'hazardExposure', 'otherInsurance', 'coverageDenial', 'pastCriminalActivity', 'criminalActivityInPast5Years',
    'codeVoilation', 'finacialDefault', 'finacialJudgement', 'trust', 'foreignOperations', 'otherVenture', 'ownDrones', 'hireOtherToOperateDrones',
    'anyVehicleNotOwned', 'useTheirAuto', 'vehicleMaintenanceProgram', 'vehicleLeased', 'transportingHazardousMaterial', 'vehicleUsedByFamily',
    'mvrVerification', 'recruitingMethod', 'coveredByWC', 'ownedUnscheduledVehicle', 'convictionsMovingViolations'].map((n) => [`radio:${n}`, 'No']),
  ['radio:otherTopic', 'Yes'],
  ['#remarks', 'Motor Truck Cargo $100K with $1K Ded - Consumer Goods / Other Consumer Goods\nMore than 500 miles radius of operation\nPOP Commercial - Progressive - $1M CSL - Exp Date 12/01/2026'],
  ['#accept', false],
];
// Left for the agent on purpose: the runner answers them as the agent would, then fills again
// (the side panel never touches a field the agent changed). The declaration ends the run.
// (none left since TNI gave standard answers for the current-carrier and loss-run questions)
const AGENT_ANSWERS = [];
const DECLARATION = /i declare/i;

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
await page.goto('file://' + path.join(root, 'test/fixtures/amwins/application.html'));
await page.evaluate(PAGEKIT);

const plan = buildPlan(record, amwins, {});
const done = new Set();
const skip = new Set();
const lines = [];
let stoppedAt = null;
let reachedDeclaration = false;
let totalMs = 0;
for (let i = 0; i < 12; i++) {
  const step = await page.evaluate(() => document.querySelector('.form-tab:not([style*="none"])')?.getAttribute('data-title'));
  const t0 = Date.now();
  const report = await page.evaluate(([p, o]) => globalThis.__raterKit.fill(p, o), [plan, { advance: amwins.advance, batch: !process.argv.includes('--no-batch') && !!amwins.batch, doneActions: [...done], skip: [...skip], optional: amwins.optional ?? [], maxRounds: 120 }]);
  for (const a of report.actions ?? []) done.add(a.id);
  const list = (k) => (report[k] ?? []).map((x) => x.label + (x.reason ? ` (${x.reason})` : ''));
  const ms = Date.now() - t0;
  totalMs += ms;
  lines.push(`## ${step} (${(ms / 1000).toFixed(1)} s, ${report.rounds} rounds)`, `filled ${report.filled.length}: ${list('filled').join(' · ')}`);
  for (const k of ['failed', 'noData', 'unknown', 'leftRequired']) if (report[k]?.length) lines.push(`${k}: ${list(k).join(' · ')}`);
  if (report.actions?.length) lines.push(`clicked: ${report.actions.map((a) => a.text).join(' · ')}`);
  lines.push(report.advanced ? `→ ${report.advanced}` : `stopped: ${report.blockers.join(' · ') || 'nothing left'}`, '');
  if (!report.advanced) {
    const left = [...report.noData, ...report.unknown, ...report.failed, ...report.leftRequired];
    if (left.some((x) => DECLARATION.test(x.label)) && left.every((x) => DECLARATION.test(x.label))) { reachedDeclaration = true; break; }
    const answers = left.map((x) => [x, AGENT_ANSWERS.find(([re]) => re.test(x.label))]);
    if (!left.length || answers.some(([, a]) => !a)) { stoppedAt = step; break; }
    for (const [x, [, sel, value]] of answers) {
      await page.evaluate(([sel, value]) => {
        const el = sel.startsWith('radio:') ? document.querySelector(`input[type=radio][name="${sel.slice(6)}"][value="${value}"]`) : document.querySelector(sel);
        if (el.type === 'radio') el.checked = true; else el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, [sel, value]);
      skip.add(x.key);
      lines.push(`(agent answered "${x.label}")`);
    }
    continue;
  }
  // Like the side panel: wait for the background save and reload, and for the next step.
  await page.waitForFunction((before) => !globalThis.__raterKit.busy() && document.querySelector('.form-tab:not([style*="none"])')?.getAttribute('data-title') !== before, step, { timeout: 15000 });
  await page.waitForTimeout(300);
}

const actual = await page.evaluate((expect) => expect.map(([sel]) => {
  if (sel.startsWith('radio:')) {
    const checked = [...document.querySelectorAll(`input[type=radio][name="${sel.slice(6)}"]`)].find((r) => r.checked);
    return checked ? (checked.value === '1' ? 'Yes' : checked.value === '0' ? 'No' : checked.value) : '';
  }
  const el = document.querySelector(sel);
  if (!el) return '(not on the page)';
  if (el.type === 'checkbox') return el.checked;
  // A date counts once the date picker took it (that's what the site saves).
  if (el.classList.contains('datepicker-input')) return el._pickerDate ?? '(not taken by the date picker)';
  if (el.tagName === 'SELECT') return el.selectedOptions[0]?.text.trim() ?? '';
  return el.value;
}), EXPECT);
const wrong = EXPECT.map(([sel, want], i) => ({ sel, want, got: actual[i] }))
  .filter(({ want, got }) => (want instanceof RegExp ? !want.test(String(got)) : got !== want));
const mock = await page.evaluate(() => window.__amwinsMock);
await browser.close();

lines.push(`Filling time: ${(totalMs / 1000).toFixed(1)} s`);
lines.push(`Steps seen: ${mock.steps.join(' → ')} · Save & Continue ×${mock.saves} · Import Data ×${mock.lookups}, Import Valid Records ×${mock.imports} · Default all No ×${mock.defaults} · Submit ${mock.submitted ? 'CLICKED' : 'never clicked'}`);
if (errors.length) lines.push(`Page errors: ${errors.join(' | ')}`);
lines.push('', wrong.length ? `${wrong.length} wrong answer(s):` : `All ${EXPECT.length} answers as expected.`);
for (const w of wrong) lines.push(`  ${w.sel}: expected ${JSON.stringify(String(w.want))}, got ${JSON.stringify(w.got)}`);
if (stoppedAt) lines.push(`Stopped on ${stoppedAt} with something left that isn't the agent's.`);
else if (reachedDeclaration) lines.push('Reached the declaration: everything before it was filled; the declaration and Submit are the agent\'s.');
console.log(lines.join('\n'));
process.exit(wrong.length || stoppedAt || !reachedDeclaration || mock.submitted || errors.length ? 1 : 0);
