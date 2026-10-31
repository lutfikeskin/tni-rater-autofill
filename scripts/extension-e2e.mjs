#!/usr/bin/env node
// The real extension (dist/tni-rater-autofill, rebuilt by npm run package) in Chromium, its side
// panel opened as a page, on the AmWINS mock (test/fixtures/amwins, served by npm run replay on
// port 8792): loads the sample intake, clears one client fact in All client details (the sample
// answers every AmWINS client fact), verifies the missing fact holds Save & Continue, supplies
// explicit synthetic agent answers using trusted browser controls, then resumes from the panel.
// Checks retained answers after reloads, stops at the declaration and never submits, and that the
// panel's document never scrolled its header out of view on the way (W44-10).
// Usage events go to a throwaway local usage server (server/index.mjs on a temporary folder), set
// as the panel's Server before it opens. The run fails if any request leaves the machine (a host
// other than localhost: the production usage server, an AI provider, a CDN), if the intake_loaded
// event, or the intake_profile event whole (nothing in it out of the server's shapes, its contact turned
// into match codes), doesn't reach the local server, or on any console error or uncaught exception
// in the panel, the mock tab or the extension's service worker that isn't on BENIGN. It waits on what the mock
// and the panel do (quiet), never a fixed time, except where it watches that nothing happens.
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
// A test MATCH_KEY, so the profile's contact becomes codes as on Railway (not dropped).
const usageServer = createServer({ dataDir: usageDir, matchKey: 'e2e-match-key-'.padEnd(40, '0') });
await new Promise((resolve) => usageServer.listen(0, '127.0.0.1', resolve));
const usageUrl = `http://127.0.0.1:${usageServer.address().port}`;
const ctx = await chromium.launchPersistentContext(userDir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
// Only this machine: a request to any other host is refused and fails the run (the production
// usage server named apart). The extension's own pages, data: and blob: URLs aren't requests out.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const leavesMachine = (url) => /^(https?|wss?):$/.test(url.protocol) && !LOCAL_HOSTS.has(url.hostname);
// What the mock page's own HTML loads (the captured page's Bootstrap from a CDN, its Intercom frame
// not saved with it): refused or missing, so the run never needs the network, and no request or
// error of the extension's.
const MOCK_URL = 'http://localhost:8792/test/fixtures/amwins/application.html';
const MOCK_HTML = fs.readFileSync('test/fixtures/amwins/application.html', 'utf8');
const MOCK_ASSETS = new Set([...MOCK_HTML.matchAll(/<(?:link|script|iframe|img)\b[^>]*\b(?:href|src)="([^"]+)"/g)].map((m) => new URL(m[1], MOCK_URL).href));
const outside = [];
ctx.on('request', (r) => { if (leavesMachine(new URL(r.url())) && !MOCK_ASSETS.has(r.url())) outside.push(`${r.method()} ${r.url()}`); });
await ctx.route(leavesMachine, (route) => route.abort());
// Errors anywhere fail the run, as they are logged: the panel's (as a page, popped out), the mock
// tab's and the service worker's console errors, and uncaught exceptions in a page. BENIGN: errors
// the run causes on purpose or the browser logs for a reason outside the extension, each with why.
const failedLoad = (text) => /^Failed to load resource\b/.test(text);
const BENIGN = [
  // What the mock page's HTML loads, refused or missing (MOCK_ASSETS).
  (text, url) => failedLoad(text) && MOCK_ASSETS.has(url),
];
const errors = [];
const surface = (page) => (!page ? 'page' : page.url().includes('/sidepanel/') ? (page.url().includes('window=popup') ? 'POPUP' : 'PANEL') : 'MOCK');
const noteError = (where, text, url = '') => {
  console.log(`${where} ERROR`, text, url);
  if (!BENIGN.some((benign) => benign(text, url))) errors.push(`${where}: ${text}${url ? ` (${url})` : ''}`);
};
ctx.on('console', (m) => { if (m.type() === 'error') noteError(surface(m.page()), m.text(), m.location()?.url); });
ctx.on('weberror', (e) => noteError(surface(e.page()), e.error().message));
const watchWorker = (w) => w.on('console', (m) => { if (m.type() === 'error') noteError('WORKER', m.text(), m.location()?.url); });
ctx.serviceWorkers().forEach(watchWorker);
ctx.on('serviceworker', watchWorker);
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
console.log('ext id', id);
// The agent's Server setting, set before the panel first loads (and uploads). Luna, on by default,
// is turned off: this run checks filling, and the local server has no OpenAI key (npm run mock:luna
// checks Luna). Let me look before Continue and Fill each page as soon as it opens, on by default,
// are off: the run presses Fill this page itself and waits for the panel's own Continue.
await sw.evaluate(async (serverUrl) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...settings, serverUrl, aiOn: false, checkBeforeContinue: false, autoPages: false } });
}, usageUrl);
console.log('usage server', usageUrl);
const mock = await ctx.newPage();
await mock.goto(MOCK_URL);
const panel = await ctx.newPage();
// The panel's document never scrolls: its middle (.view) and dock do. A fill's scrollIntoView once
// scrolled the document, and at AmWINS' declaration, the last step, the header and client strip
// stayed out of view (W44-10, 2026-10-26). At a side panel's size, the furthest it ever scrolled.
await panel.setViewportSize({ width: 400, height: 860 });
await panel.addInitScript(() => {
  window.__docScrolled = 0;
  const note = () => { window.__docScrolled = Math.max(window.__docScrolled, document.scrollingElement?.scrollTop ?? 0); };
  document.addEventListener('scroll', note, { capture: true, passive: true });
  setInterval(note, 100);
});
await panel.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
await mock.bringToFront();
// The panel follows the mock's tab, then reads the intake.
const onAmwins = (page) => page.waitForFunction(() => /^AmWINS/.test(document.querySelector('#site')?.textContent ?? ''), null, { timeout: 10000 });
await onAmwins(panel);
await panel.setInputFiles('#file', 'test/fixtures/sample-intake.pdf');
await panel.waitForFunction(async () => !!(await chrome.storage.session.get('intake')).intake, null, { timeout: 15000, polling: 100 });
await panel.locator('#details-row').waitFor({ state: 'visible', timeout: 10000 });
console.log('site:', await panel.textContent('#site'));
// The sample intake answers every client fact AmWINS asks, and TNI's standards answer the rest,
// so nothing would be left to the agent. Clear the second driver's marital status (Married on the
// PDF) in All client details, as an agent correcting the intake would: that row's marital status
// is then a client fact the intake leaves blank (amwins.js `clientFact`), the agent's to answer.
const CLEARED = 'drivers[1].maritalStatus';
await panel.bringToFront();
if (await panel.locator('#check-view').isHidden()) await panel.click('#step-check');
// All client details opens in a drawer from the right (the row under the checks).
await panel.click('#details-row');
await panel.locator('#details-view').waitFor({ state: 'visible' });
if (process.argv[2]) {
  await panel.screenshot({ path: path.join(process.argv[2], 'client-details.png'), animations: 'disabled' });
  const size = panel.viewportSize();
  await panel.setViewportSize({ width: 380, height: 860 });
  await panel.screenshot({ path: path.join(process.argv[2], 'client-details-narrow.png'), animations: 'disabled' });
  await panel.setViewportSize(size);
}
const clearedBox = panel.locator(`#f-${CLEARED.replace(/[^\w]/g, '_')}`);
if (!await clearedBox.inputValue()) throw new Error(`The sample intake no longer answers ${CLEARED}.`);
// Client details draws a <select> for the intake's dropdowns (schema choice/state); a text box
// for the rest. Clearing must work for both: Delete empties a text box, the blank "—" option a select.
const tag = await clearedBox.evaluate((el) => el.tagName);
if (tag === 'SELECT') await clearedBox.selectOption('');
else {
  await clearedBox.click();
  await clearedBox.press('ControlOrMeta+A');
  await clearedBox.press('Delete');
}
await clearedBox.press('Tab'); // the panel saves a client-details edit on change
try {
  await panel.waitForFunction(async path => {
    const { intake } = await chrome.storage.session.get('intake');
    return intake?.agentEdited?.includes(path) && intake.record.drivers[1].maritalStatus == null;
  }, CLEARED, { timeout: 5000, polling: 100 });
} catch (error) {
  throw new Error(`The panel did not save the cleared ${CLEARED}.`, { cause: error });
}
await panel.click('#details-close');
await panel.locator('#details-view').waitFor({ state: 'hidden' });
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The mock and the panel are quiet: every Save & Continue's background save has reloaded the steps,
// the mock's loading overlay is gone, no fill runs, and nothing of these changed for `quietMs`.
// `surface`: the panel's page (the popped-out window once it is the panel). In place of fixed waits.
const quiet = async (surface = panel, quietMs = 1000, timeoutMs = 30000) => {
  const look = async () => JSON.stringify([
    await mock.evaluate(() => {
      const m = window.__amwinsMock;
      const overlay = document.querySelector('#loadingDefault');
      return [m.saves, m.reloads ?? 0, m.steps.length, m.steps.at(-1), m.prevs ?? 0, !!overlay && getComputedStyle(overlay).display !== 'none'];
    }),
    await surface.evaluate(() => { const dock = document.querySelector('#dock'); return [dock.dataset.phase, dock.dataset.report]; }),
  ]);
  let last = null;
  let since = 0;
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(100)) {
    const now = await look();
    const [[saves, reloads, , , , loading], [phase]] = JSON.parse(now);
    if (now !== last) { last = now; since = Date.now(); continue; }
    if (saves === reloads && !loading && phase !== 'filling' && Date.now() - since >= quietMs) return;
  }
  throw new Error(`The mock and the panel did not settle in ${timeoutMs / 1000} s: ${last}`);
};
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
  await quiet(); // the carrier's background save/reload and the next page's fill
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
  // The agent has not answered yet: the blank facts must remain unresolved and Continue held, the
  // mock and the panel quiet for 1.5 s meanwhile.
  await quiet(panel, 1500);
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
const docScrolled = await panel.evaluate(() => window.__docScrolled);
console.log('Panel document scrolled at most:', docScrolled);
if (docScrolled) console.log('SCROLLED: the panel\'s document scrolled, so its header and client strip went out of view.');
if (manualFailures.length) console.log('MANUAL:', manualFailures.join('; '));
// Every step's answers must survive the site's background save and reload (it redraws all
// steps from what was saved): read them once the last reload has landed.
await quiet();
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
const prevsBefore = await mock.evaluate(() => window.__amwinsMock.prevs ?? 0);
await mock.evaluate(() => document.querySelector('.form-tab:not([style*="none"]) [data-id="prevButton"], [data-id="prevButton"]:not([style*="none"])')?.click());
await mock.waitForFunction((n) => (window.__amwinsMock.prevs ?? 0) > n, prevsBefore, { timeout: 5000, polling: 50 });
// Nothing should happen now: watched for 4 s of quiet, long enough for a follow-up fill to start.
await quiet(panel, 4000);
const stayed = await mock.evaluate(() => ({ step: window.__amwinsMock.steps.at(-1), saves: window.__amwinsMock.saves }));
console.log('After Prev:', JSON.stringify(stayed));
const lastMock = await mock.evaluate(() => JSON.stringify(window.__amwinsMock));
console.log('MOCK', lastMock);
console.log('REPORT', (await panel.textContent('#report')).replace(/\s+/g, ' ').slice(0, 1500));
if (process.argv[2]) await panel.screenshot({ path: path.join(process.argv[2], 'panel.png'), fullPage: true });
// An earlier step's answers from the list's page menu: shown read-only (nothing to change there),
// then back to this step's.
const earlierPages = await panel.locator('#page-menu option').allTextContents();
console.log('Earlier pages:', earlierPages.join(', '));
let earlierOk = earlierPages[0] === 'This page' && earlierPages.includes('Insured Info');
if (earlierOk) {
  await panel.locator('#page-menu').selectOption({ label: 'Insured Info' });
  const firstRow = panel.locator('#past .row').first();
  await firstRow.waitFor({ timeout: 5000 });
  await firstRow.locator('.row-head').click();
  if (process.argv[2]) {
    await panel.click('#key-btn');
    await panel.screenshot({ path: path.join(process.argv[2], 'earlier-page.png'), fullPage: true, animations: 'disabled' });
    // As wide as a side panel.
    const size = panel.viewportSize();
    await panel.setViewportSize({ width: 380, height: 860 });
    await panel.screenshot({ path: path.join(process.argv[2], 'earlier-page-narrow.png'), animations: 'disabled' });
    await panel.setViewportSize(size);
    await panel.click('#key-btn');
  }
  earlierOk = await panel.locator('#report').isHidden() && !await firstRow.locator('.change, .mark-done, .show-on-page').evaluateAll((els) => els.some((e) => e.offsetParent !== null));
  await panel.click('#past-back');
  earlierOk &&= await panel.locator('#past').isHidden() && await panel.locator('#report').isVisible();
}
if (!earlierOk) console.log('EARLIER PAGES: the page menu did not show Insured Info read-only and come back to this step.');
// The events the panel uploaded (it sends right after the intake loads, then every minute).
await panel.evaluate(() => document.getElementById('upload-usage')?.click()).catch(() => {});
const eventsIn = () => {
  const dir = path.join(usageDir, 'events');
  return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type)) : [];
};
for (const end = Date.now() + 10000; Date.now() < end && !eventsIn().includes('intake_loaded'); await sleep(100));
// Pop out: the panel in a window of its own follows the quote's tab (the browser window the agent
// last used) and fills it, and the copy that was open gives way, so one copy fills at a time.
// Back to the side panel opens Chrome's side panel and closes the window; a window popped out
// again closes that side panel. Nothing is declared or submitted.
let poppedOk = false;
const panelPages = () => ctx.pages().filter((p) => p.url().includes('/sidepanel/sidepanel.html'));
// Chrome's side panel isn't a page Playwright shows: the extension's own count of them.
const sidePanels = () => sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length);
const within = async (ms, check) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await check()) return true;
  return false;
};
try {
  await panel.bringToFront();
  const opened = ctx.waitForEvent('page', { timeout: 10000 });
  const gaveWay = panel.waitForEvent('close', { timeout: 10000 });
  // Either can fail while the other is awaited: the catch below reports it.
  opened.catch(() => {});
  gaveWay.catch(() => {});
  await panel.click('#pop-out');
  const popup = await opened;
  await popup.waitForURL(/sidepanel\.html\?window=popup$/, { timeout: 10000 });
  await gaveWay;
  await mock.bringToFront();
  await onAmwins(popup);
  // Native clicks need the panel's surface in front on Windows; the quote's window stays the last used.
  await popup.bringToFront();
  // The new copy makes the reports kept in session storage again (W43-39): the earlier steps are in
  // its page menu before it fills anything.
  const restoredOk = await within(5000, async () => (await popup.locator('#page-menu option').allTextContents()).includes('Insured Info'));
  console.log('Restored pages:', (await popup.locator('#page-menu option').allTextContents()).join(', '));
  const before = await popup.locator('#dock').getAttribute('data-report');
  await popup.locator('#fill:not([hidden]):not(:disabled), #dock-alt[data-go="fill-again"]:not([hidden])').first().click({ timeout: 10000 });
  await popup.waitForFunction((old) => {
    const dock = document.querySelector('#dock');
    return dock.dataset.phase !== 'filling' && !!dock.dataset.report && dock.dataset.report !== old;
  }, before, { timeout: 30000, polling: 100 });
  await quiet(popup);
  const after = await mock.evaluate(() => ({ step: window.__amwinsMock.steps.at(-1), submitted: window.__amwinsMock.submitted, declared: document.querySelector('#accept')?.checked }));
  const buttons = { dock: await popup.locator('#dock-back').isVisible(), popOut: await popup.locator('#pop-out').isVisible() };
  console.log('Popped out:', JSON.stringify({ panels: panelPages().length, ...after, ...buttons }), (await popup.textContent('#report')).replace(/\s+/g, ' ').slice(0, 300));
  if (process.argv[2]) {
    await popup.setViewportSize({ width: 420, height: 860 });
    await popup.screenshot({ path: path.join(process.argv[2], 'popped.png'), animations: 'disabled' });
  }
  poppedOk = restoredOk && panelPages().length === 1 && panelPages()[0] === popup && !after.submitted && !after.declared && buttons.dock && !buttons.popOut;
  const docked = popup.waitForEvent('close', { timeout: 10000 });
  docked.catch(() => {});
  await popup.click('#dock-back');
  await docked;
  const dockedOk = await within(5000, async () => await sidePanels() === 1);
  const reopened = ctx.waitForEvent('page', { timeout: 10000 });
  reopened.catch(() => {});
  await sw.evaluate(() => chrome.windows.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html?window=popup'), type: 'popup' }));
  await reopened;
  const gaveWayOk = await within(5000, async () => await sidePanels() === 0);
  const still = await mock.evaluate(() => ({ submitted: window.__amwinsMock.submitted, declared: document.querySelector('#accept')?.checked }));
  console.log('Back to the side panel:', JSON.stringify({ dockedOk, gaveWayOk, ...still }));
  poppedOk &&= dockedOk && gaveWayOk && !still.submitted && !still.declared;
} catch (error) {
  console.log('POP OUT:', error.message);
}
if (!poppedOk) console.log('POP OUT: the panel in its own window did not replace the open one, show the earlier steps’ reports, follow the quote tab and fill it, go back to the side panel, or give way to a new window, or something was declared or submitted.');
await ctx.close();
await new Promise((resolve) => usageServer.close(resolve));
const received = eventsIn();
const stored = fs.readdirSync(path.join(usageDir, 'events')).flatMap((f) => fs.readFileSync(path.join(usageDir, 'events', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const profileWhole = stored.some((e) => e.type === 'intake_profile' && !e.dropped && e.match && e.contact === undefined);
fs.rmSync(usageDir, { recursive: true, force: true });
const toProduction = outside.filter((r) => r.includes(`//${PRODUCTION_HOST}/`));
console.log(`Usage: ${received.length} events to the local server (${[...new Set(received)].join(', ')}), ${outside.length} requests off this machine (${toProduction.length} to production)`);
if (outside.length) console.log('OFF THIS MACHINE:', outside.join('; '));
const usageOk = !outside.length && received.includes('intake_loaded') && profileWhole;
console.log(`Errors: ${errors.length}${errors.length ? ` (${errors.join('; ')})` : ''}`);
const result = JSON.parse(await Promise.resolve(lastMock));
const ok = usageOk && !errors.length && !docScrolled && earlierOk && poppedOk && reachedDeclaration && !manualFailures.length && !kept.declaration && !lost.length && result.steps.includes('Underwriting') && savesBefore === 4 && !result.submitted && stayed.step === 'Coverage' && stayed.saves === savesBefore;
console.log(ok ? 'OK: manual facts held Continue, trusted agent answers survived reloads, going back stayed there, an earlier step showed read-only, the panel popped out alone with the earlier steps’ reports, filled and went back to the side panel, declaration and Submit stayed untouched, usage went only to the local server, nothing left this machine, and nothing logged an error.' : !usageOk ? 'FAILED: a request left this machine, or usage events did not reach the local server.' : errors.length ? 'FAILED: an error was logged (above).' : 'FAILED: the panel’s document scrolled, manual facts did not hold Continue, trusted answers were lost, declaration was ticked, Prev did not stay put, the earlier step was not shown read-only, or Pop out failed.');
process.exit(ok ? 0 : 1);
