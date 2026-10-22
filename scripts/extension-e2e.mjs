#!/usr/bin/env node
// The real extension (dist/tni-rater-autofill, rebuilt by npm run package) in Chromium, its side
// panel opened as a page, on the AmWINS mock (test/fixtures/amwins, served by npm run replay on
// port 8792): loads the sample intake, clears one client fact in All client details (the sample
// answers every AmWINS client fact), verifies the missing fact holds Save & Continue, supplies
// explicit synthetic agent answers using trusted browser controls, then resumes from the panel.
// Checks retained answers after reloads, stops at the declaration and never submits.
// Usage events go to a throwaway local usage server (server/index.mjs on a temporary folder), set
// as the panel's Server before it opens: the harness fails if anything is sent to the production
// usage server, or if the intake_loaded event doesn't reach the local one.
//
//   npm run package && npm run replay   # (in another terminal)
//   npm run e2e:extension -- [screenshot folder]

import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createServer } from '../server/index.mjs';
const PRODUCTION_HOST = 'usage-server-production.up.railway.app';
const ext = path.resolve('dist/tni-rater-autofill');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-ext-'));
const usageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-usage-'));
const usageServer = createServer({ dataDir: usageDir });
await new Promise((resolve) => usageServer.listen(0, '127.0.0.1', resolve));
const usageUrl = `http://127.0.0.1:${usageServer.address().port}`;
const ctx = await chromium.launchPersistentContext(userDir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
// Anything still headed for the production usage server is refused and fails the run.
const toProduction = [];
ctx.on('request', (r) => { if (new URL(r.url()).host === PRODUCTION_HOST) toProduction.push(`${r.method()} ${r.url()}`); });
await ctx.route(`https://${PRODUCTION_HOST}/**`, (route) => route.abort());
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
console.log('ext id', id);
// The agent's Server setting, set before the panel first loads (and uploads).
await sw.evaluate(async (serverUrl) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, serverUrl } });
}, usageUrl);
console.log('usage server', usageUrl);
const mock = await ctx.newPage();
await mock.goto('http://localhost:8792/test/fixtures/amwins/application.html');
const panel = await ctx.newPage();
panel.on('console', (m) => { if (m.type() === 'error') console.log('PANEL', m.text()); });
await panel.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
await mock.bringToFront();
await panel.waitForTimeout(1000);
await panel.setInputFiles('#file', 'test/fixtures/sample-intake.pdf');
await panel.waitForTimeout(2500);
console.log('site:', await panel.textContent('#site'));
await panel.waitForTimeout(500);
// The sample intake answers every client fact AmWINS asks, and TNI's standards answer the rest,
// so nothing would be left to the agent. Clear the second driver's marital status (Married on the
// PDF) in All client details, as an agent correcting the intake would: that row's marital status
// is then a client fact the intake leaves blank (amwins.js `clientFact`), the agent's to answer.
const CLEARED = 'drivers[1].maritalStatus';
await panel.bringToFront();
if (await panel.locator('#check-view').isHidden()) await panel.click('#step-check');
if (!await panel.locator('#details').evaluate(el => el.open)) await panel.click('#details > summary');
if (!await panel.locator('details.section[data-id="drivers"]').evaluate(el => el.open)) await panel.click('details.section[data-id="drivers"] > summary');
const clearedBox = panel.locator(`#f-${CLEARED.replace(/[^\w]/g, '_')}`);
if (!await clearedBox.inputValue()) throw new Error(`The sample intake no longer answers ${CLEARED}.`);
await clearedBox.click();
await clearedBox.press('ControlOrMeta+A');
await clearedBox.press('Delete');
await clearedBox.press('Tab'); // the panel saves a client-details edit on change
try {
  await panel.waitForFunction(async path => {
    const { intake } = await chrome.storage.session.get('intake');
    return intake?.agentEdited?.includes(path) && intake.record.drivers[1].maritalStatus == null;
  }, CLEARED, { timeout: 5000, polling: 100 });
} catch (error) {
  throw new Error(`The panel did not save the cleared ${CLEARED}.`, { cause: error });
}
console.log('fill btn:', await panel.textContent('#fill'), 'hint:', await panel.textContent('#dock-sub'));
await panel.bringToFront();
await panel.click('#fill');
// These are explicit synthetic agent answers for this workflow test, not facts inferred from
// the PDF. Never dismiss a review item or inject protected keys to make navigation succeed.
const AGENT_ANSWERS = [
  // The fact cleared above, answered on the second driver's row only. DIVORCED is neither the
  // PDF's answer (MARRIED) nor the first driver's (SINGLE), so a refill from the intake or from
  // the wrong row shows in EXACT below.
  ['Drivers', /^marital status$/i, '#driversPanel .app-rp-section[data-id="1"] [data-id="martialStatus"]', 'DIVORCED'],
  // TNI standards the extension fills, checked by EXACT below: additional interest and vehicles
  // leased No (2026-10-09); driver gender MALE and license year birth year + 17 (2026-10-10); how
  // long with the current carrier 1 TO 2 YEARS, claim-free and valued loss runs No (2026-10-19).
  // A question left unresolved on any step fails the run.
];
const manualFailures = [], agentAnswered = new Set();
const answeredSteps = new Map();
let reachedDeclaration = false;
const atStep = () => mock.evaluate(() => ({ step: window.__amwinsMock.steps.at(-1), saves: window.__amwinsMock.saves }));
// Idle: no fill running on the tab (the dock's phase), and a fill's report in front (its time).
const idlePanel = () => panel.waitForFunction(() => {
  const dock = document.querySelector('#dock');
  return dock.dataset.phase !== 'filling' && !!dock.dataset.report;
}, null, { timeout: 20000, polling: 100 });
// The dock's way to fill the page again: its button, or its alternative while questions remain.
const fillAgain = () => panel.locator('#fill:not([hidden]):not(:disabled), #dock-alt[data-go="fill-again"]:not([hidden])').first();
const recorderContext = await sw.evaluate(async url => {
  const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
  const { session } = await chrome.storage.session.get('session');
  return { tabId: tab?.id, scope: session?.intakeId };
}, mock.url());
if (!Number.isInteger(recorderContext.tabId) || !recorderContext.scope) throw new Error('The mock tab or intake recorder scope is missing.');
const recordedKey = async selector => {
  const [{ result: key }] = await sw.evaluate(async ({ tabId, selector }) => chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] }, world: 'ISOLATED', args: [selector],
    func: selector => globalThis.__raterFieldKey?.(document.querySelector(selector)),
  }), { tabId: recorderContext.tabId, selector });
  if (!key) throw new Error(`The recorder field key is missing: ${selector}`);
  return key;
};
const acknowledgedEdit = async key => {
  try {
    await panel.waitForFunction(async ({ tabId, scope, key }) => {
      const { agentEditedKeys = [] } = await chrome.storage.local.get('agentEditedKeys');
      return agentEditedKeys.some(record => record.tabId === tabId && record.scope === scope && record.keys.includes(key));
    }, { ...recorderContext, key }, { timeout: 15000, polling: 100 });
  } catch (error) {
    throw new Error(`The recorder did not acknowledge the trusted agent edit: ${key}`, { cause: error });
  }
};
const resumeFromPanel = async () => {
  // The harness opens the side panel as a browser tab. Native clicks need that surface
  // in front on Windows, just as the agent would focus the real side panel to resume.
  await panel.bringToFront();
  await idlePanel();
  const oldReport = await panel.locator('#dock').getAttribute('data-report');
  const deadline = Date.now() + 15000;
  let lastTimeout;
  // Automatic follow-ups do not always replace the report. A click while one is running is
  // ignored. An accepted ordinary Fill starts a new report (the dock's data-report changes);
  // observing that also catches a fill that starts and finishes very quickly.
  const replaced = () => panel.locator('#dock').evaluate((dock, old) => dock.dataset.phase === 'filling' || dock.dataset.report !== old, oldReport);
  while (!await replaced()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('The panel did not accept Fill after the recorder acknowledged the agent answers.', { cause: lastTimeout });
    try {
      await fillAgain().click({ timeout: Math.min(1000, remaining) });
      await panel.waitForFunction(old => { const dock = document.querySelector('#dock'); return dock.dataset.phase === 'filling' || dock.dataset.report !== old; }, oldReport, { timeout: Math.min(250, Math.max(1, deadline - Date.now())), polling: 50 });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      lastTimeout = error;
    }
  }
  await idlePanel();
};
for (let round = 0; round < 20; round++) {
  await idlePanel();
  await mock.waitForTimeout(1500); // the carrier's background save/reload and next-page fill
  if (await panel.locator('#dock').getAttribute('data-phase') === 'filling') continue;
  const before = await atStep();
  const needs = await panel.locator('#report .row.need:not(.resolved) .row-label').allTextContents();
  const unresolved = needs.filter(label => !/i declare/i.test(label));
  console.log('Step:', before.step, 'saves:', before.saves, 'needs:', unresolved.join(', '));
  if (before.step === 'Underwriting' && needs.some(label => /i declare/i.test(label))
    && !unresolved.length && AGENT_ANSWERS.every(([, , selector]) => agentAnswered.has(selector))) {
    reachedDeclaration = true;
    break;
  }
  if (!unresolved.length) continue; // next-page report may still be waiting behind the background save
  // A trusted edit or Save & Continue can land before the panel publishes its next report.
  // Wait only for recognized facts already answered in this or a completed step. Never
  // answer a control twice; the bounded loop and every hold/retention assertion stay active.
  const settlingReport = unresolved.every(label => {
    const matches = AGENT_ANSWERS.filter(([step, re]) =>
      (step === before.step || answeredSteps.get(step) < before.saves) && re.test(label));
    return matches.length > 0 && matches.every(([, , selector]) => agentAnswered.has(selector));
  });
  if (settlingReport) continue;
  const remaining = [...AGENT_ANSWERS];
  const answers = unresolved.map(label => {
    const index = remaining.findIndex(([step, re]) => step === before.step && re.test(label));
    return index < 0 ? null : remaining.splice(index, 1)[0];
  });
  if (!answers.length || answers.some(answer => !answer)) {
    manualFailures.push(`Unexpected unresolved questions on ${before.step}: ${unresolved.join(', ')}`);
    break;
  }
  // The agent has not answered yet: the blank facts must remain unresolved and Continue held.
  await mock.waitForTimeout(1000);
  const held = await atStep();
  if (held.step !== before.step || held.saves !== before.saves) {
    manualFailures.push(`Continue ran before the agent answered ${before.step}`);
    break;
  }
  await mock.bringToFront();
  for (const [, , selector, value] of answers) {
    const key = await recordedKey(selector);
    const control = mock.locator(selector);
    const blank = await control.evaluate(el => el.type === 'radio'
      ? ![...document.querySelectorAll(`input[name="${el.name}"]`)].some(r => r.checked) : !el.value);
    if (!blank) manualFailures.push(`Manual fact was filled before the agent answered: ${selector}`);
    // Observe the real native event: selectOption() dispatches a synthetic change and cannot
    // establish the recorder's trusted agent-answer provenance, so use keyboard selection.
    await control.evaluate(el => {
      el.__harnessTrustedChange = false;
      el.addEventListener('change', event => { if (event.isTrusted) el.__harnessTrustedChange = true; });
    });
    if (await control.evaluate(el => el.type === 'radio')) await control.check();
    else if (await control.evaluate(el => el.tagName === 'SELECT')) {
      const prefix = await control.evaluate((el, want) => {
        const labels = [...el.options].map(option => option.text.trim());
        const label = [...el.options].find(option => option.value === want)?.text.trim();
        if (!label) return null;
        for (let n = 1; n <= label.length; n++) {
          const candidate = label.slice(0, n);
          if (labels.filter(text => text.toLowerCase().startsWith(candidate.toLowerCase())).length === 1) return candidate;
        }
        return null;
      }, value);
      if (!prefix) throw new Error(`Synthetic answer has no unique keyboard prefix: ${selector}`);
      await control.focus();
      await control.pressSequentially(prefix); // native select type-ahead works in headless macOS Chromium
      await control.press('Tab');
    } else {
      await control.click();
      await control.press('ControlOrMeta+A');
      await control.pressSequentially(value);
      await control.press('Tab');
    }
    if (!await control.evaluate((el, want) => el.__harnessTrustedChange && el.value === want, value)) manualFailures.push(`No trusted agent change: ${selector}`);
    await acknowledgedEdit(key);
    agentAnswered.add(selector);
  }
  answeredSteps.set(before.step, before.saves);
  // A trusted edit can schedule a follow-up fill; the explicit panel click is still the
  // ordinary resume action and must preserve every correction the recorder just observed.
  await resumeFromPanel();
  const afterResume = await atStep();
  const freshNeeds = await panel.locator('#report .row.need:not(.resolved) .row-label').allTextContents();
  if (afterResume.step === before.step && freshNeeds.some(label => answers.some(([, re]) => re.test(label)))) {
    manualFailures.push(`The fresh report still needs acknowledged agent answers on ${before.step}: ${freshNeeds.join(', ')}`);
    break;
  }
}
for (const [, , selector] of AGENT_ANSWERS) if (!agentAnswered.has(selector)) manualFailures.push(`Manual hold wasn't exercised: ${selector}`);
if (manualFailures.length) console.log('MANUAL:', manualFailures.join('; '));
// Every step's answers must survive the site's background save and reload (it redraws all
// steps from what was saved): read them once the last reload has landed.
await mock.waitForTimeout(2500);
const kept = await mock.evaluate(() => {
  const v = (sel) => { const el = document.querySelector(sel); if (!el) return '(missing)'; if (el.type === 'checkbox') return el.checked; if (el.classList.contains('datepicker-input')) return el._pickerDate ?? ''; return el.tagName === 'SELECT' ? el.selectedOptions[0]?.text.trim() ?? '' : el.value; };
  return {
    additionalInterest: document.querySelector('input[name="hasAdditionalInterest"]:checked')?.value,
    valuedLossRuns: document.querySelector('input[name="valuedLossRuns"]:checked')?.value,
    claimFreeLossRuns: document.querySelector('input[name="canProvideClaimFreeLossRun"]:checked')?.value,
    currentCarrier: v('#howLongWithCurrentCarrier'),
    licenseYear: v('#driversPanel .app-rp-section[data-id="0"] [data-id="licenseYear"]'),
    secondLicenseYear: v('#driversPanel .app-rp-section[data-id="1"] [data-id="licenseYear"]'),
    secondGender: v('#driversPanel .app-rp-section[data-id="1"] [data-id="gender"]'),
    maritalStatus: v('#driversPanel .app-rp-section[data-id="0"] [data-id="martialStatus"]'),
    secondMaritalStatus: v('#driversPanel .app-rp-section[data-id="1"] [data-id="martialStatus"]'),
    vehicleLeased: document.querySelector('input[name="vehicleLeased"]:checked')?.value,
    declaration: v('#accept'),
    entityType: v('#entityType'), yrsInBusiness: v('#yrsInBusiness'), mailingState: v('#mailingState'), natureOfBusiness: v('#natureOfBusiness'), ownerDob: v('#ownerDob'),
    driverFirst: v('#driversPanel [data-id="firstName"]'), driverDob: v('#driversPanel [data-id="dateOfBirth"]'), gender: v('#driversPanel [data-id="gender"]'),
    usage: v('#vehiclesPanel [data-id="usageType"]'), bodyType: v('#vehiclesPanel [data-id="bodyType"]'),
    medicalPayment: v('#medicalPayment'), symbol6: v('#autoSymbol6'), towing: v('#towingAndLaborReimbursement'),
    prior0: v('#priorCarrierCoveragePanel0 [data-id="carrierName"]'), prior1: v('#priorCarrierCoveragePanel1 [data-id="carrierName"]'), prior2: v('#priorCarrierCoveragePanel2 [data-id="carrierName"]'),
  };
});
// The sample intake: Illinois, vehicle 1 a Van (Cargo Van on AmWINS); drivers born 1988 and 1995,
// so license years 2005 and 2012 and gender MALE (TNI standards, no gender set); the first driver
// Single on the PDF, the second the agent's DIVORCED (AGENT_ANSWERS).
const EXACT = { additionalInterest: '0', valuedLossRuns: '0', claimFreeLossRuns: '0', currentCarrier: '1 TO 2 YEARS', licenseYear: '2005', secondLicenseYear: '2012', gender: 'MALE', secondGender: 'MALE', maritalStatus: 'SINGLE', secondMaritalStatus: 'DIVORCED', vehicleLeased: '0', prior0: 'NO PRIOR', prior1: 'NO PRIOR', prior2: 'NO PRIOR', mailingState: 'Illinois', bodyType: 'Cargo Van', medicalPayment: '$5,000', towing: '$75', usage: 'FOR HIRE', natureOfBusiness: 'TRANSPORTATION' };
const lost = Object.entries(kept).filter(([k, x]) => k !== 'declaration' && (x == null || x === '' || x === false || x === '(missing)' || x === 'State' || (k in EXACT && x !== EXACT[k]))).map(([k]) => k);
console.log('Kept after the reloads:', JSON.stringify(kept));
if (lost.length) console.log('LOST:', lost.join(', '));

// The agent goes back a step: the panel must leave them there (no second Save & Continue).
const savesBefore = await mock.evaluate(() => window.__amwinsMock.saves);
await mock.evaluate(() => document.querySelector('.form-tab:not([style*="none"]) [data-id="prevButton"], [data-id="prevButton"]:not([style*="none"])')?.click());
await mock.waitForTimeout(6000);
const stayed = await mock.evaluate(() => ({ step: window.__amwinsMock.steps.at(-1), saves: window.__amwinsMock.saves }));
console.log('After Prev:', JSON.stringify(stayed));
const lastMock = await mock.evaluate(() => JSON.stringify(window.__amwinsMock));
console.log('MOCK', lastMock);
console.log('REPORT', (await panel.textContent('#report')).replace(/\s+/g, ' ').slice(0, 1500));
if (process.argv[2]) await panel.screenshot({ path: path.join(process.argv[2], 'panel.png'), fullPage: true });
// The events the panel uploaded (it sends right after the intake loads, then every minute).
await panel.evaluate(() => document.getElementById('upload-usage')?.click()).catch(() => {});
await panel.waitForTimeout(1500);
await ctx.close();
await new Promise((resolve) => usageServer.close(resolve));
const received = fs.readdirSync(path.join(usageDir, 'events')).flatMap((f) => fs.readFileSync(path.join(usageDir, 'events', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type));
fs.rmSync(usageDir, { recursive: true, force: true });
console.log(`Usage: ${received.length} events to the local server (${[...new Set(received)].join(', ')}), ${toProduction.length} requests to production`);
if (toProduction.length) console.log('TO PRODUCTION:', toProduction.join('; '));
const usageOk = !toProduction.length && received.includes('intake_loaded');
const result = JSON.parse(await Promise.resolve(lastMock));
const ok = usageOk && reachedDeclaration && !manualFailures.length && !kept.declaration && !lost.length && result.steps.includes('Underwriting') && savesBefore === 4 && !result.submitted && stayed.step === 'Coverage' && stayed.saves === savesBefore;
console.log(ok ? 'OK: manual facts held Continue, trusted agent answers survived reloads, going back stayed there, declaration and Submit stayed untouched, and usage went only to the local server.' : !usageOk ? 'FAILED: usage events went to the production server, or did not reach the local one.' : 'FAILED: manual facts did not hold Continue, trusted answers were lost, declaration was ticked, or Prev did not stay put.');
process.exit(ok ? 0 : 1);
