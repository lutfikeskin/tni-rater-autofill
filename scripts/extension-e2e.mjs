#!/usr/bin/env node
// The real extension (dist/tni-rater-autofill, rebuilt by npm run package) in Chromium, its side
// panel opened as a page, on the AmWINS mock (test/fixtures/amwins, served by npm run replay on
// port 8792): loads the sample intake, clicks Fill this page once and checks that the panel goes
// through every step by itself (Save & Continue), stops at the declaration and never submits.
//
//   npm run package && npm run replay   # (in another terminal)
//   npm run e2e:extension -- [screenshot folder]

import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
const ext = path.resolve('dist/tni-rater-autofill');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-ext-'));
const ctx = await chromium.launchPersistentContext(userDir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
console.log('ext id', id);
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
await panel.click('#tab-fill').catch(() => {});
await panel.waitForTimeout(500);
console.log('fill btn:', await panel.textContent('#fill'), 'hint:', await panel.textContent('#fill-hint'));
await panel.click('#fill');
for (let i = 0; i < 60; i++) {
  await panel.waitForTimeout(1000);
  const step = await mock.evaluate(() => window.__amwinsMock && JSON.stringify({ steps: window.__amwinsMock.steps, saves: window.__amwinsMock.saves, submitted: window.__amwinsMock.submitted }));
  if (i % 3 === 0) console.log(i, step);
  if (step && JSON.parse(step).steps.includes('Underwriting')) { await panel.waitForTimeout(4000); break; }
}
// Every step's answers must survive the site's background save and reload (it redraws all
// steps from what was saved): read them once the last reload has landed.
await mock.waitForTimeout(2500);
const kept = await mock.evaluate(() => {
  const v = (sel) => { const el = document.querySelector(sel); if (!el) return '(missing)'; if (el.type === 'checkbox') return el.checked; if (el.classList.contains('datepicker-input')) return el._pickerDate ?? ''; return el.tagName === 'SELECT' ? el.selectedOptions[0]?.text.trim() ?? '' : el.value; };
  return {
    entityType: v('#entityType'), yrsInBusiness: v('#yrsInBusiness'), mailingState: v('#mailingState'), natureOfBusiness: v('#natureOfBusiness'), ownerDob: v('#ownerDob'),
    driverFirst: v('#driversPanel [data-id="firstName"]'), driverDob: v('#driversPanel [data-id="dateOfBirth"]'), gender: v('#driversPanel [data-id="gender"]'),
    usage: v('#vehiclesPanel [data-id="usageType"]'), bodyType: v('#vehiclesPanel [data-id="bodyType"]'),
    medicalPayment: v('#medicalPayment'), symbol6: v('#autoSymbol6'), towing: v('#towingAndLaborReimbursement'),
  };
});
// The sample intake: Illinois, vehicle 1 a Van (Cargo Van on AmWINS).
const EXACT = { mailingState: 'Illinois', bodyType: 'Cargo Van', medicalPayment: '$5,000', towing: '$75', usage: 'FOR HIRE', natureOfBusiness: 'TRANSPORTATION' };
const lost = Object.entries(kept).filter(([k, x]) => x === '' || x === false || x === '(missing)' || x === 'State' || (k in EXACT && x !== EXACT[k])).map(([k]) => k);
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
await ctx.close();
const result = JSON.parse(await Promise.resolve(lastMock));
const ok = !lost.length && result.steps.includes('Underwriting') && savesBefore === 4 && !result.submitted && stayed.step === 'Coverage' && stayed.saves === savesBefore;
console.log(ok ? 'OK: one click filled every step up to the declaration, and going back a step stays there.' : 'FAILED: answers lost in the site\'s reload, the panel did not go through every step by itself, or it pushed the agent forward after Prev.');
process.exit(ok ? 0 : 1);
