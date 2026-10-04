#!/usr/bin/env node
// Run local intake PDFs against the saved AmWINS mock and captured FAO page replays.
// No carrier or AI requests. Results contain synthetic test inputs; keep them outside source.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readIntakeFields } from '../src/intake.js';
import { normalizeIntake } from '../src/normalize.js';
import { buildPlan } from '../src/plan.js';
import { amwins } from '../src/carriers/amwins.js';
import { progressive } from '../src/carriers/progressive.js';
import { collectItems } from '../src/ai/assist.js';
import { STATES } from '../src/util.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const pool = path.resolve(arg('pool', path.join(root, 'dist/synthetic-intakes')));
const out = path.resolve(arg('out', path.join(os.tmpdir(), `intake-mocks-${Date.now()}`)));
const manifest = JSON.parse(fs.readFileSync(path.join(pool, 'manifest.json')));
const selected = manifest.cases.filter(c => !arg('cases') || arg('cases').split(',').some(prefix => c.id.startsWith(prefix + '-')));
const carriers = arg('carrier', 'both') === 'both' ? ['amwins', 'progressive'] : [arg('carrier')];
if (!selected.length || carriers.some(c => !['amwins', 'progressive'].includes(c))) throw new Error('Select at least one case and a supported carrier: amwins, progressive, or both.');
const workers = Math.max(1, Math.min(8, Number(arg('workers', '4'))));
fs.mkdirSync(out, { recursive: true });
const kit = ['field-key.js', 'pagekit.js'].map(file => fs.readFileSync(path.join(root, 'src/content', file), 'utf8')).join('\n');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const queue = selected.flatMap(c => carriers.map(carrier => ({ c, carrier })));
const results = [];
const started = Date.now();
const check = (list, field, got, want) => list.push({ field, got, want, ok: got === want });
const money = x => Number(String(x).replace(/[^\d.]/g, ''));

async function fill(page, record, carrier, active = {}, advance = null, done = []) {
  return page.evaluate(async ([plan, options]) => window.__raterKit.fill(plan, options), [buildPlan(record, carrier, active), {
    advance, batch: !!carrier.batch, optional: carrier.optional ?? [], replaceChoices: !!carrier.replaceChoices,
    doneActions: done, maxRounds: 120,
  }]);
}

async function amwinsCase(page, c, record, lookup) {
  // Exact GVW is not supplied by vPIC's class range: this is a declared synthetic decoder
  // response (9000), not a claim about the real VIN's actual registered weight.
  for (const v of lookup.vinLookups) if (v.status === 'found') v.grossVehicleWeight = '9000';
  for (const sequence of lookup.attempts?.vinLookups ?? []) for (const v of sequence) if (v.status === 'found') v.grossVehicleWeight = '9000';
  await page.addInitScript(scenario => { window.__intakeScenario = scenario; }, { lookups: lookup });
  await page.goto(`${base}/test/fixtures/amwins/application.html`);
  await page.evaluate(kit);
  await page.waitForFunction(() => !window.__raterKit.busy());
  const checks = [], reports = [], handoffs = [];
  const done = new Set();
  for (let step = 0; step < 5; step++) {
    const title = await page.locator('.form-tab:visible').getAttribute('data-title');
    const report = await fill(page, record, amwins, {}, amwins.advance, [...done]);
    reports.push({ page: title, ...report });
    for (const action of report.actions ?? []) done.add(action.id);
    if (report.advanced) {
      await page.waitForFunction(before => !window.__raterKit.busy() && document.querySelector('.form-tab:not([style*="none"])')?.getAttribute('data-title') !== before, title);
    } else if (title !== 'Underwriting') {
      // An agent may continue after review. Preserve the stop as a result; do not count it
      // as automatic completion, and never supply an invented owner DOB or failed lookup.
      handoffs.push({ page: title, blockers: report.blockers });
      if (title === 'Vehicles' && c.lookupScenario === 'vin-timeout-retry') {
        await page.locator('#vehLookupButton').click();
        await page.waitForSelector('#vehLookupSuccess.show');
        await page.locator('#vehLookupSuccess .import').click();
        await page.waitForTimeout(700);
        reports.push({ page: title + ' retry', ...await fill(page, record, amwins, {}, null, [...done]) });
      }
      await page.locator('[data-id="saveAndContinueButton"]:visible').first().click();
      await page.waitForFunction(before => !window.__raterKit.busy() && document.querySelector('.form-tab:not([style*="none"])')?.getAttribute('data-title') !== before, title);
    }
  }
  const got = await page.evaluate(() => {
    const value = el => !el ? null : el.type === 'checkbox' ? el.checked : el.classList.contains('datepicker-input') ? el._pickerDate ?? '' : el.tagName === 'SELECT' ? el.selectedOptions[0]?.text.trim() ?? '' : el.value;
    const get = selector => value(document.querySelector(selector));
    const rows = (panel, ids) => [...document.querySelectorAll(`${panel} > .app-rp-section`)].map(row => Object.fromEntries(ids.map(id => [id, value(row.querySelector(`[data-id="${id}"]`))])));
    return { name: get('#name'), owner: get('#ownerName'), ownerDob: get('#ownerDob'), state: get('#mailingState'),
      entity: get('#entityType'), dot: get('#dotNumber'), mc: get('#mcNumber'), remarks: get('#remarks'),
      hasDot: get('#hasDotNumber'), hasMc: get('#hasMcNumber'), noNumber: get('#noNumber'),
      filings: get('[name="fillingRequired"]:checked'), bmc91: get('[name="federalBmc91"]:checked'),
      mcs90: get('[name="federalLiabilityMcs90"]:checked'), classCode: get('#classCodeAndDescription'),
      drivers: rows('#driversPanel', ['firstName', 'lastName', 'dateOfBirth', 'licenseNumber', 'licenseState', 'martialStatus']),
      vehicles: rows('#vehiclesPanel', ['vin', 'year', 'make', 'model', 'costNew', 'bodyType', 'grossVehicleWeight']),
      declaration: get('#accept'), mock: window.__amwinsMock };
  });
  check(checks, 'insured', got.name, c.applicantDisplayName);
  check(checks, 'entity', got.entity, c.entityType === 'LLC' ? 'LLC' : 'SOLE PROPRIETOR');
  check(checks, 'state', got.state, STATES[c.state]);
  check(checks, 'has DOT', got.hasDot, !!c.dot);
  check(checks, 'has MC', got.hasMc, !!c.mc);
  check(checks, 'no authority number', got.noNumber, !c.dot && !c.mc);
  check(checks, 'DOT', got.dot, c.dot ?? '');
  check(checks, 'MC', got.mc, c.mc ?? '');
  check(checks, 'filings required', got.filings, c.filingsRequired ? '1' : '0');
  check(checks, 'freight/expediter class', got.classCode.includes('484122'), true);
  if (c.filingsRequired) {
    check(checks, 'federal liability BMC-91', got.bmc91, '1');
    check(checks, 'federal liability MCS-90', got.mcs90, '1');
  }
  check(checks, 'owner', got.owner, record.applicant.owner1);
  check(checks, 'ownerDOB', got.ownerDob, c.ownerDrives ? record.drivers[0].dob : '');
  check(checks, 'driver count', got.drivers.length, c.driverCount);
  for (const [i, d] of record.drivers.entries()) {
    const g = got.drivers[i] ?? {};
    for (const [field, want] of Object.entries({ firstName: d.first, lastName: d.last, dateOfBirth: d.dob, licenseNumber: d.licenseNumber, martialStatus: d.maritalStatus.toUpperCase() })) check(checks, `driver ${i + 1} ${field}`, g[field], want);
  }
  check(checks, 'vehicle count', got.vehicles.length, c.vehicleCount);
  for (const [i, v] of record.vehicles.entries()) {
    const g = got.vehicles[i] ?? {};
    for (const [field, want] of Object.entries({ vin: v.vin, year: String(v.year), make: v.make, model: v.model })) check(checks, `vehicle ${i + 1} ${field}`, g[field], want);
    check(checks, `vehicle ${i + 1} bodyType`, g.bodyType?.toLowerCase(), 'cargo van');
    check(checks, `vehicle ${i + 1} value`, money(g.costNew), v.value);
  }
  if (c.proofOfPriorStatus === 'unavailable') check(checks, 'missing POP disclosed', /POP.*unavailable/i.test(got.remarks), true);
  if (c.proofOfPriorStatus === 'available') check(checks, 'POP disclosed', /POP Commercial.*Progressive/i.test(got.remarks), true);
  if (c.priorInsuranceStatus === 'none') check(checks, 'no invented prior policy', /POP Commercial/i.test(got.remarks), false);
  if (c.priorInsuranceStatus === 'expired') check(checks, 'expired policy disclosed', /expired|lapsed/i.test(got.remarks), true);
  check(checks, 'declaration untouched', got.declaration, false);
  check(checks, 'never submitted', got.mock.submitted, false);
  await page.screenshot({ path: path.join(out, `${c.id}-amwins.png`), fullPage: false });
  return { checks, handoffs, reports, elapsedScope: 'five-step flow including saves and any recorded agent continuations',
    manualDriverRowsAdded: 0, unsupportedLookupScenarios: c.lookupScenario.startsWith('dot-') ? [c.lookupScenario] : [], retained: got };
}

async function progressiveCase(page, c, record) {
  const names = fs.readdirSync(path.join(root, 'test/fixtures/progressive'));
  const filename = names.find(n => n.startsWith(`progressive_${c.state}_`));
  if (!filename) throw new Error(`No captured layout for ${c.state}`);
  await page.goto(`${base}/test/replay/`);
  await page.waitForFunction(() => window.Ext && window.replay && window.__raterKit);
  await page.locator('#layout').fill(`/test/fixtures/progressive/${filename}`);
  await page.locator('#load').click();
  await page.waitForFunction(() => document.getElementById('page').options.length > 0);
  await page.evaluate(record => { window.replay.record = record; }, record);
  const layout = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/progressive', filename)));
  const checks = [], reports = [], unsupported = [];
  const pages = Object.keys(layout.pages);
  for (const name of pages) {
    const count = name === 'AddVehicle' ? c.vehicleCount : name === 'AddDriver' ? c.driverCount : 1;
    for (let index = 0; index < count; index++) {
      // Replays are independent captured pages. Explicitly label this scope, rather than
      // treating a programmatic page change as proof of automatic quote navigation.
      await page.evaluate(name => { delete window.replay.byPage[name]; }, name);
      await page.locator('#page').selectOption(name);
      const active = { vehicles: name === 'AddVehicle' ? index : 0, drivers: name === 'AddDriver' ? index : 0 };
      const report = await fill(page, record, progressive, active, null);
      reports.push({ page: name, index, ...report });
      const texts = await page.evaluate(name => window.replay.byPage[name]?.texts ?? {}, name);
      const fields = new Set(layout.pages[name].fields.map(f => f.q));
      const expected = {};
      for (const q of ['81', '83']) if (fields.has(q)) expected[q] = c.priorInsuranceStatus === 'current' ? 'Yes' : 'No';
      if (fields.has('CA')) expected['CA'] = c.filingsRequired ? 'Yes' : 'No';
      if (fields.has('239')) {
        const freight = c.businessType === 'General Freight Hauler';
        const options = layout.pages[name].fields.find(f => f.q === '239').opts ?? [];
        const available = options.find(o => freight ? /^General Freight (Hauler|Trucking)$/i.test(o) : /^For Hire Trucking$/i.test(o));
        if (available) expected['239'] = available;
        else unsupported.push(`${name}: business type search results are truncated; required freight/expediter option is absent`);
      }
      if (name === 'BusinessOwnerInfo') {
        expected['198'] = c.priorInsuranceStatus === 'current' ? 'Yes' : 'No';
        expected['1ED'] = c.dot ? 'Yes - the customer has a USDOT number' : c.mcDotWithin60Days ? 'Not Yet - but the customer has applied/will apply for a USDOT number within 60 days' : 'No - and the customer will not have a USDOT number';
        expected['230'] = c.applicantDisplayName;
        expected['1F3'] = c.dot;
      }
      if (name === 'AddVehicle') {
        expected['2B20'] = record.vehicles[index].vin;
        for (const q of ['2CE8', '2091']) if (fields.has(q)) check(checks, `${name}[${index}] ${q}`, money(texts[q]), record.vehicles[index].value);
      }
      if (name === 'AddDriver') {
        expected['2898'] = record.drivers[index].first;
        expected['289A'] = record.drivers[index].last;
        expected['28A7'] = record.drivers[index].dob;
        expected['28B9'] = record.drivers[index].licenseNumber;
      }
      for (const [q, want] of Object.entries(expected)) {
        if (fields.has(q)) check(checks, `${name}[${index}] ${q}`, texts[q] ?? '', want ?? '');
        else unsupported.push(`${name}: question ${q} absent from captured layout`);
      }
    }
  }
  await page.screenshot({ path: path.join(out, `${c.id}-progressive.png`), fullPage: false });
  return { checks, reports, handoffs: reports.filter(r => r.blockers?.length).map(r => ({ page: r.page, blockers: r.blockers })),
    layout: filename, elapsedScope: 'captured pages and repeated driver/vehicle pages, not automatic navigation',
    unsupportedLookupScenarios: c.lookupScenario === 'success' ? [] : [c.lookupScenario], unsupported };
}

async function lookupCase(page, c, record, lookup) {
  await page.goto(`${base}/test/replay/`);
  await page.waitForFunction(() => window.Ext && window.replay && window.__raterKit);
  const vinMode = c.lookupScenario.startsWith('vin-');
  await page.evaluate(({ lookup, vinMode }) => {
    const r = window.replay;
    r.record = null;
    r.page = vinMode ? 'AddVehicle' : 'BusinessOwnerInfo';
    history.replaceState(null, '', `?pageName=${r.page}`);
    r.byPage = { [r.page]: { answers: {}, texts: {} } };
    const seed = vinMode ? [{ q: '2B20', kind: 'text', caption: 'VIN', req: true }]
      : [{ q: '1F3', kind: 'text', caption: 'USDOT Number', req: true }];
    r.fields = [...seed];
    r.pageButtons = [{ text: vinMode ? 'Lookup VIN' : 'Verify DOT' }];
    r.lookupAttempts = 0;
    r.lookupStatus = null;
    r.click = () => {
      const sequence = vinMode ? lookup.attempts?.vinLookups?.[0] : lookup.attempts?.dotLookup;
      let result = sequence?.[Math.min(r.lookupAttempts, sequence.length - 1)] ?? (vinMode ? lookup.vinLookups[0] : lookup.dotLookup);
      const query = r.byPage[r.page].texts[vinMode ? '2B20' : '1F3'];
      if (query !== (vinMode ? result.vin : result.query)) result = { status: 'not_found' };
      r.lookupAttempts++;
      r.form.mask('Looking up...');
      setTimeout(() => {
        r.lookupStatus = result.status;
        r.fields = [...seed];
        const state = r.byPage[r.page];
        if (result.status === 'found' && vinMode) {
          for (const [i, [caption, value]] of Object.entries({ Year: result.modelYear, Make: result.make, Model: result.model }).entries()) {
            const q = `F${101 + i}`;
            r.fields.push({ q, kind: 'text', caption, req: true });
            state.answers[q] = state.texts[q] = String(value);
          }
        } else if (result.status === 'found') {
          r.fields.push({ q: '22F', kind: 'radio', caption: 'Business Name', req: true,
            opts: [result.company.legalName, 'Enter a different Business Name'] },
          { q: '20F', kind: 'radio', caption: "Does this USDOT Number belong to the customer's business?", req: true, opts: ['Yes', 'No'] });
        } else if (result.status === 'not_found' && !vinMode) {
          r.fields.push({ q: '21E', kind: 'radio', caption: 'Did the customer obtain their USDOT number within the last 60 days?', req: true, opts: ['Yes', 'No'] });
        }
        r.render();
      }, 200);
    };
    r.render();
  }, { lookup, vinMode });
  const reports = [await fill(page, record, progressive)];
  const checks = [];
  const first = await page.evaluate(() => ({ status: window.replay.lookupStatus, texts: window.replay.byPage[window.replay.page].texts, attempts: window.replay.lookupAttempts }));
  check(checks, 'first lookup response', first.status, (vinMode ? lookup.vinLookups[0] : lookup.dotLookup).status);
  if (c.lookupScenario === 'dot-identity-mismatch') {
    check(checks, 'different company not accepted', first.texts['22F'] ?? '', '');
    check(checks, 'ownership not asserted', first.texts['20F'] ?? '', '');
    check(checks, 'identity requires agent review', reports[0].noData.some(x => x.reviewOnly), true);
    check(checks, 'AI cannot bypass identity check', collectItems(reports).blocked.some(x => /identity mismatch/.test(x.why)), true);
  }
  if (c.lookupScenario === 'dot-not-found') check(checks, 'new registration branch', first.texts['21E'], 'Yes');
  if (c.lookupScenario === 'success') check(checks, 'matching company accepted', first.texts['22F'], c.companyName);
  if (c.lookupScenario.endsWith('timeout-retry')) {
    await page.evaluate(() => window.replay.click());
    await page.waitForFunction(() => window.replay.lookupStatus === 'found');
    reports.push(await fill(page, record, progressive, {}, null, reports[0].actions.map(a => a.id)));
    const retried = await page.evaluate(() => ({ status: window.replay.lookupStatus, attempts: window.replay.lookupAttempts }));
    check(checks, 'retry recovered', retried.status, 'found');
    check(checks, 'exactly two attempts', retried.attempts, 2);
  }
  if (vinMode) check(checks, 'VIN retained', first.texts['2B20'], c.vins[0]);
  await page.screenshot({ path: path.join(out, `${c.id}-lookup.png`), fullPage: false });
  return { checks, reports, scope: 'Observed lookup controls with independent injected responses; retry is an explicit agent action, not automatic navigation.' };
}

async function worker() {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const { c, carrier } = job;
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const t0 = Date.now();
    let result;
    try {
      const raw = await readIntakeFields(pdfjs, new Uint8Array(fs.readFileSync(path.join(pool, c.pdf))));
      const { record, error } = normalizeIntake(raw, { today: new Date(2026, 9, 2) });
      if (error) throw new Error(error);
      const lookup = JSON.parse(fs.readFileSync(path.join(pool, 'lookups', `${c.id}.json`)));
      result = await (process.argv.includes('--lookup-check') ? lookupCase(page, c, record, lookup)
        : carrier === 'amwins' ? amwinsCase(page, c, record, lookup) : progressiveCase(page, c, record));
    } catch (e) { result = { checks: [], error: e.stack }; }
    result = { caseId: c.id, carrier, milliseconds: Date.now() - t0, errors, ...result };
    result.wrong = result.checks.filter(x => !x.ok);
    results.push(result);
    fs.writeFileSync(path.join(out, `${c.id}-${carrier}.json`), JSON.stringify(result, null, 2));
    console.log(`${carrier} ${c.id}: ${result.error ? 'ERROR' : `${result.checks.length - result.wrong.length}/${result.checks.length} correct`}, ${(result.milliseconds / 1000).toFixed(1)}s`);
    await page.close();
  }
}

try { await Promise.all(Array.from({ length: workers }, worker)); }
finally { await browser.close(); server.close(); }
const summary = { cases: selected.length, runs: results.length, elapsedMs: Date.now() - started,
  correct: results.reduce((n, r) => n + r.checks.filter(c => c.ok).length, 0),
  checked: results.reduce((n, r) => n + r.checks.length, 0),
  failedRuns: results.filter(r => r.error || r.wrong.length || r.errors.length).length,
  runsWithReviewStops: results.filter(r => r.handoffs?.length).length,
  unsupportedChecks: results.reduce((n, r) => n + (r.unsupported?.length ?? 0) + (r.unsupportedLookupScenarios?.length ?? 0), 0),
  limitation: 'FAO is captured-page replay, not full flow. AI is not measured by this run; lookup scenarios marked unsupported are not exercised.',
  results: results.map(({ reports, retained, ...r }) => r) };
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ out, ...summary, results: undefined }, null, 2));
process.exitCode = summary.failedRuns ? 1 : 0;
