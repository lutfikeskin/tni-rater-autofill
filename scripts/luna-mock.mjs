#!/usr/bin/env node
// Packaged extension, real fixture controls, intercepted OpenAI responses. No live API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), `luna-mock-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-luna-'));
const checks = [], errors = [];
let context, mock, panel, phase = 'startup', requests = 0, mode = 'normal', started, release;
// The claims-box review (once per intake), counted apart from page questions.
let claimsRequests = 0;
// The driver first-name check (once per intake), and what each one sent.
let namesRequests = 0;
const namesSent = [];
// The intake-checks phase: Luna flags GL in the claims box and a likely-female first name.
let flagIntake = false;
// Fields the rules leave to the agent (manualOnly) that still reached Luna: must stay 0.
let agentFactsSent = 0;
const AGENT_FACT = /how long with current carrier|has additional interest|claim free loss run|valued loss runs|any prior loss|gender|marital|licen[cs]e year/i;
const unexpectedProviderHosts = new Set();
const verify = (name, actual, expected) => {
  checks.push({ name, ok: actual === expected });
  assert.equal(actual, expected, name);
};
try {
  const ext = path.join(root, 'dist/tni-rater-autofill');
  phase = 'launch';
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'api.openai.com') {
      const body = route.request().postDataJSON(), state = JSON.parse(body.input[0].content);
      if (body.text?.format?.name === 'claims_review') {
        claimsRequests++;
        assert.equal(body.store, false);
        assert.equal(body.reasoning.effort, 'low');
        assert.equal(body.max_output_tokens, 2048);
        assert.equal(body.temperature, undefined);
        assert.equal(state.formCoverage.gl, undefined, 'GL is its own question, not form coverage');
        // Nothing flagged: the synthetic claims box holds no coverage request. In the intake-checks
        // phase the first line is flagged as mentioning general liability.
        const lines = Object.fromEntries(Object.keys(state.claimsBox).map((id, i) => [id, { ntl: false, coverageChange: false, businessYears: null, businessSince: null, generalLiability: flagIntake && i === 0 }]));
        return route.fulfill({ json: { status: 'completed', model: 'gpt-6-luna',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ lines }) }] }],
          usage: { input_tokens: 50, output_tokens: 5 } } });
      }
      if (body.text?.format?.name === 'driver_first_names') {
        namesRequests++;
        assert.equal(body.store, false);
        assert.equal(body.reasoning.effort, 'low');
        assert.deepEqual(Object.keys(state), ['firstNames'], 'first names only');
        for (const name of Object.values(state.firstNames)) assert.match(name, /^\p{L}[\p{L}'’-]+$/u, 'one word, letters only');
        namesSent.push(state.firstNames);
        // Everyone unclear (the TNI standard stands), except the first driver in the intake-checks phase.
        const drivers = Object.fromEntries(Object.keys(state.firstNames).map((id, i) => [id, flagIntake && i === 0 ? 'likely_female' : 'unclear']));
        return route.fulfill({ json: { status: 'completed', model: 'gpt-6-luna',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ drivers }) }] }],
          usage: { input_tokens: 50, output_tokens: 5 } } });
      }
      requests++;
      agentFactsSent += Object.values(state.fields ?? {}).filter(f => AGENT_FACT.test(f.label ?? '')).length;
      if (mode === 'slow') { started?.(); await new Promise(resolve => { release = resolve; }); }
      assert.equal(body.reasoning.effort, 'low');
      assert.equal(body.text.verbosity, 'low');
      assert.equal(body.temperature, undefined);
      assert.equal(body.top_p, undefined);
      assert.ok(JSON.stringify(body).length <= 48000);
      assert.equal(body.max_output_tokens, state.proposed ? 2048 : 4096);
      assert.ok(Object.keys(state.proposed ?? state.fields).length <= 12);
      if (!state.proposed) assert.equal(state.intake, undefined);
      const decisions = {};
      if (state.proposed) {
        for (const id of Object.keys(state.proposed)) decisions[id] = { supported: true };
      } else {
        const source = Object.keys(state.sources).find(id => state.sources[id].path === 'operations.hazPlacard');
        for (const [id, field] of Object.entries(state.fields)) {
          const option = Object.keys(field.options).find(id => field.options[id] === 'No');
          const matches = field.label.includes('Mock Luna choice') && !!source && !!option;
          decisions[id] = { option: matches ? option : '__leave__', sourceIds: matches ? [source] : [],
            explanation: matches ? 'The supplied intake explicitly says No.' : 'Agent review required.',
            missingInformation: [], conflicts: matches && mode === 'conflict' ? ['Conflicting intake facts require clarification.'] : [] };
        }
      }
      return route.fulfill({ json: { status: 'completed', model: 'gpt-6-luna',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ decisions }) }] }],
        usage: { input_tokens: 100, output_tokens: 30 } } });
    }
    if (['127.0.0.1', 'localhost', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'code.jquery.com'].includes(url.hostname)
      || url.protocol === 'chrome-extension:') return route.continue();
    if (url.hostname) unexpectedProviderHosts.add(url.hostname);
    return route.abort();
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  mock = await context.newPage();
  panel = await context.newPage();
  await panel.setViewportSize({ width: 420, height: 900 });
  for (const page of [mock, panel]) page.on('pageerror', error => errors.push(error.message));
  phase = 'initial-panel';
  // Configure the synthetic profile before panel init can upload to the default usage server.
  await worker.evaluate(() => chrome.storage.local.set({ settings: { aiOn: true, aiAuto: true, lunaAuto: false,
    jevKey: 'synthetic-typesafe', aiKey: 'synthetic-legacy-openai', jevModel: 'jev-1.13.0',
    autoFollowUps: false, autoPages: false, autoAdvance: true, serverUrl: '', serverToken: '' } }));
  await panel.goto(`chrome-extension://${id}/sidepanel/sidepanel.html`);
  await panel.reload();
  const openMock = async () => {
    phase = 'open-mock';
    await mock.goto(`${base}/test/fixtures/amwins/application.html`);
    await mock.evaluate(() => {
      const field = document.createElement('div');
      field.className = 'form-group';
      field.innerHTML = '<label for="mockLunaChoice">Mock Luna choice</label><select id="mockLunaChoice" class="form-control"><option value="">Choose</option><option>Yes</option><option>No</option></select>';
      document.querySelector('.form-tab').append(field);
    });
    await mock.bringToFront();
    await panel.waitForFunction((prefix) => chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => tab?.url?.startsWith(prefix)), `${base}/test/fixtures/amwins/`);
    await panel.waitForFunction(() => document.querySelector('#site')?.textContent.includes('AmWINS'));
  };
  const loadPdf = async ({ missingClaims = false } = {}) => {
    phase = 'load-pdf';
    if (await panel.locator('#quote').isVisible()) {
      await panel.locator('#file-menu-btn').click();
      await panel.locator('#clear-client').click();
      // Clear asks first; the panel stays as it was until the agent confirms.
      await panel.locator('#file-confirm').waitFor({ state: 'visible' });
      verify('Clear asks before the client goes', await panel.locator('#quote').isVisible(), true);
      await panel.locator('#file-confirm-yes').click();
      await panel.locator('#home').waitFor({ state: 'visible' });
    }
    const claimsBefore = claimsRequests, namesBefore = namesRequests;
    await panel.setInputFiles('#file', path.join(root, 'test/fixtures/sample-intake.pdf'));
    await panel.locator('#quote').waitFor({ state: 'visible' });
    // With Luna on and its key set, the panel reads the new intake's claims box: let that save
    // first, or it would write over the fixture edit below.
    const reviewed = await panel.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); return !!(settings?.aiOn && settings?.lunaKey); });
    if (reviewed) {
      await panel.waitForFunction(async () => !!(await chrome.storage.session.get('intake')).intake?.notesReview, null, { timeout: 15000 });
      verify('a new intake gets one claims-box review', claimsRequests - claimsBefore, 1);
      // And its drivers' first names, also saved before the fixture edit below.
      await panel.waitForFunction(async () => !!(await chrome.storage.session.get('intake')).intake?.namesReview, null, { timeout: 15000 });
      verify('a new intake gets one driver-name check', namesRequests - namesBefore, 1);
    }
    // This controlled fixture fact is synthetic; no customer data or external provider is used.
    await panel.evaluate(async (missingClaims) => {
      const { intake } = await chrome.storage.session.get('intake');
      intake.record.operations.hazPlacard = false;
      if (missingClaims) intake.record.claims.hasClaims = null;
      await chrome.storage.session.set({ intake });
    }, missingClaims);
    await panel.reload();
    // The panel reload completes before its async tab refresh on some Chromium/Linux runs.
    // Wait for the active fixture and an enabled Fill control, which are the production
    // conditions needed by the following AI request.
    await panel.waitForFunction((prefix) => chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => tab?.url?.startsWith(prefix)), `${base}/test/fixtures/amwins/`);
    await panel.locator('#fill:not(:disabled)').waitFor({ state: 'visible' });
    // The reopened panel reads the intake back from storage with its keys in another order. That
    // is no edit: the claims box isn't sent again, and no review result is saved over a fixture
    // edit made after this (Windows smoke 2026-10-10: the missing-years edit was saved over, and
    // Years in Business was filled 5+).
    if (reviewed) verify('reopening the panel does not read the claims box again', claimsRequests - claimsBefore, 1);
    phase = 'fixture-ready';
  };
  const loadPdfMissingYears = async () => {
    await loadPdf();
    // Keep the real normalized fixture and remove only the two years facts needed for this
    // regression. This exercises the carrier's missing-value path without client data in logs.
    await panel.evaluate(async () => {
      const { intake } = await chrome.storage.session.get('intake');
      intake.record.applicant.yearsInBusiness = null;
      intake.record.applicant.yearsExperience = null;
      await chrome.storage.session.set({ intake });
    });
    await panel.reload();
  };
  const keyboardSelect = async (locator, value, delayMs = 0) => {
    let indexes;
    for (let attempt = 0; attempt < 100; attempt++) {
      indexes = await locator.evaluate((el, wanted) => {
        const options = [...el.options];
        return [el.selectedIndex, options.findIndex((option) => option.value === wanted)];
      }, value);
      if (indexes[1] >= 0) break;
      await mock.waitForTimeout(100);
    }
    assert.ok(indexes[1] >= 0, `missing native option ${value}`);
    const targetText = await locator.evaluate((el, wanted) => [...el.options].find((option) => option.value === wanted)?.textContent?.trim() ?? '', value);
    // Native typeahead works in headless Chromium where the OS select popup is unavailable. The
    // browser receives real key events and emits trusted input/change events; selectOption would
    // dispatch untrusted events and bypass the recorder path under test.
    await locator.evaluate((el) => {
      el.__lunaMockEvents = [];
      el.__lunaMockListener = event => el.__lunaMockEvents.push(event.isTrusted);
      for (const type of ['input', 'change']) el.addEventListener(type, el.__lunaMockListener);
    });
    await locator.focus();
    // Start the long-delay gesture with a real key event, then use native typeahead to choose the
    // desired option. This deliberately covers the old recorder window without popup assumptions.
    await locator.press('Home');
    if (delayMs) await mock.waitForTimeout(delayMs);
    await mock.keyboard.type(targetText);
    await mock.keyboard.press('Enter');
    const result = await locator.inputValue();
    const trustedEvents = await locator.evaluate((el) => el.__lunaMockEvents ?? []);
    await locator.evaluate((el) => {
      for (const type of ['input', 'change']) el.removeEventListener(type, el.__lunaMockListener);
      delete el.__lunaMockListener;
      delete el.__lunaMockEvents;
    });
    assert.ok(trustedEvents.some(Boolean), `native ${value} selection emitted no trusted event`);
    return result;
  };
  const addThreePriorRows = async () => {
    const years = mock.locator('#yrsInBusiness');
    verify('setup Years in Business selection is 3', await keyboardSelect(years, '3'), '3');
    await mock.locator('[data-id="saveAndContinueButton"]:visible').first().click();
    await mock.locator('[data-id="prevButton"]:visible').first().waitFor({ state: 'visible' });
    await mock.waitForTimeout(250);
    await mock.locator('[data-id="prevButton"]:visible').first().click();
    await mock.waitForFunction(() => document.querySelectorAll('#priorCarrierPanel > .app-rp-section').length === 3, null, { timeout: 10000 });
    // The recorded site collapses the accordion bodies once several prior years are shown. Open
    // them for Playwright's native select actions while keeping the real page structure intact.
    await mock.evaluate(() => document.querySelectorAll('#priorCarrierPanel > .app-rp-section .card-body').forEach((body) => { body.style.display = ''; }));
  };
  // The brain button opens Settings at the assistant; Done closes it.
  const openAgent = async () => {
    await panel.locator('#agent-btn').click();
    await panel.locator('#settings').waitFor({ state: 'visible' });
  };
  const closeAgent = () => panel.locator('#settings-done').click();
  // The dock's Fill: its button, or its "Fill this page again" while questions remain.
  const clickFill = () => panel.locator('#fill:not([hidden]):not(:disabled), #dock-alt[data-go="fill-again"]:not([hidden])').first().click();
  // No fill running on the tab. On a timeout it says what the dock and the list showed.
  const dockIdle = () => panel.waitForFunction(() => document.querySelector('#dock').dataset.phase !== 'filling', null, { timeout: 30000 })
    .catch(async (error) => {
      const said = await panel.evaluate(() => ['#dock', '#issues', '#feed'].map((id) => document.querySelector(id)?.innerText.replace(/\s+/g, ' ').slice(0, 200)).join(' / ')).catch(() => null);
      throw new Error(`The fill did not finish: ${said}; panel errors: ${errors.join(' | ') || 'none'}`, { cause: error });
    });
  // A question's row in the page's list, opened (its suggestion, choices and buttons are inside).
  const openRow = async (label) => {
    const row = panel.locator('#report .row.need', { hasText: label }).first();
    await row.waitFor({ timeout: 30000 });
    if (!await row.evaluate((n) => n.classList.contains('open'))) await row.locator('.row-head').click();
    return row;
  };
  const savedSettings = () => panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  // The fill started (the dock shows its progress and Stop in place of the button), then ended. Not
  // a new report in front: on the mock, the step the fill read and the one the recorder read
  // afterwards can differ for a moment, and the report is filed under the fill's (1 run in 3).
  const fillAndWait = async () => {
    await clickFill();
    await panel.locator('#fill-progress').waitFor({ state: 'visible' });
    await dockIdle();
  };
  const waitSetting = (key, value) => panel.waitForFunction(([k, v]) => chrome.storage.local.get('settings').then(({ settings }) => settings?.[k] === v), [key, value]);
  const installSnapshotVariation = async ({ firstReversed = false } = {}) => {
    await panel.evaluate(({ firstReversed: reverseFirst }) => {
      const scripting = chrome.scripting;
      const original = scripting.executeScript;
      let interceptions = 0;
      scripting.executeScript = async function (...args) {
        const fn = String(args[0]?.func ?? '');
        const result = await original.apply(this, args);
        if (!fn.includes('globalThis.__raterKit.decisionSnapshot')) return result;
        interceptions++;
        const reverse = reverseFirst ? interceptions % 2 === 1 : interceptions % 2 === 0;
        if (!reverse || !Array.isArray(result)) return result;
        // Preserve every InjectionResult value while changing only metadata insertion order.
        return result.map((frame) => Object.fromEntries(Object.entries(frame).reverse()));
      };
      globalThis.__lunaMockSnapshotInterceptions = () => interceptions;
      globalThis.__lunaMockRestoreSnapshot = () => {
        scripting.executeScript = original;
        delete globalThis.__lunaMockSnapshotInterceptions;
        delete globalThis.__lunaMockRestoreSnapshot;
      };
    }, { firstReversed });
  };
  await openMock();
  await loadPdf();

  // A pre-upgrade profile may contain only legacy Jev/OpenAI fields. A pending automatic
  // decision from that profile must remain a review hold after the panel reloads, while Luna
  // receives no key derived from those legacy fields and no legacy provider request is made.
  await mock.bringToFront();
  const legacyTabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  const legacyScope = await panel.evaluate(async () => (await chrome.storage.session.get('session')).session.intakeId);
  await panel.evaluate(({ scope, tabId }) => chrome.storage.local.set({
    settings: { aiOn: true, aiAuto: true, jevKey: 'legacy-typesafe-key', aiKey: 'legacy-openai-key', jevModel: 'jev-1.13.0',
      autoFollowUps: false, autoPages: false, autoAdvance: true, serverUrl: '', serverToken: '' },
    aiPendingDecisions: [{ version: 1, scope, tabId, page: '/test/fixtures/amwins/application.html',
      model: 'jev-1.13.0', policy: 'jev-evidence-v2', contextHash: 'legacy-context', itemHash: 'legacy-item',
      key: 'mockLunaChoice', label: 'Mock Luna choice', choice: 'No', controlKind: 'select', done: 'auto',
      approved: false, rejected: false, manual: false, confirmed: false, snapshotHash: null, confidence: null }],
  }), { scope: legacyScope, tabId: legacyTabId });
  await panel.reload();
  await clickFill();
  await panel.locator('#ai-approve').waitFor({ timeout: 30000 });
  verify('retired automatic decision requires explicit review', await panel.getByRole('button', { name: 'Confirm the current page answer', exact: true, includeHidden: true }).count(), 1);
  verify('legacy automatic decision remains a review hold after reload', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  verify('legacy profile makes no Luna or Jev request', requests + claimsRequests + namesRequests, 0);
  verify('legacy profile does not contact the Jev host', unexpectedProviderHosts.size, 0);
  const migratedSettings = await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings ?? {});
  verify('legacy OpenAI/TypeSafe fields do not become a Luna key', migratedSettings.lunaKey ?? '', '');
  verify('legacy settings are purged after migration', ['aiKey', 'jevKey', 'jevModel'].every(key => !Object.hasOwn(migratedSettings, key)), true);
  await keyboardSelect(mock.locator('#mockLunaChoice'), 'Yes');
  await panel.waitForFunction(async () => (await chrome.storage.local.get('aiPendingDecisions')).aiPendingDecisions?.some(x => x.key === 'mockLunaChoice' && x.manual) === true);
  await panel.reload();
  await fillAndWait();
  verify('manual upgrade correction releases the retired hold', await panel.locator('#ai-approve').isVisible(), false);

  // Continue the normal Luna workflow with its dedicated key after the upgrade check.
  await panel.evaluate(() => chrome.storage.local.set({ settings: { aiProvider: 'luna', aiOn: true, aiAuto: true, lunaAuto: false,
    lunaKey: '', autoFollowUps: false, autoPages: false, autoAdvance: true, serverUrl: '', serverToken: '' } }));
  await panel.reload();
  // The migration hold fill may have settled every other question on this page. Start a fresh
  // intake so the missing-key path still has an unresolved Luna question to render.

  await openMock();
  await loadPdf();
  phase = 'missing-key';
  await clickFill();
  await panel.getByText(/GPT-6 Luna needs an OpenAI API key/).waitFor();
  verify('Luna never reuses legacy or TypeSafe keys', requests + claimsRequests + namesRequests, 0);
  await panel.locator('#report').getByRole('button', { name: 'Add the key', exact: true }).click();
  await panel.locator('#ai-openai-key').waitFor({ state: 'visible' });
  await panel.waitForFunction(() => document.activeElement?.id === 'ai-openai-key', null, { timeout: 5000 }).catch(() => {});
  verify('missing OpenAI key focuses its dedicated field', await panel.evaluate(() => document.activeElement.id), 'ai-openai-key');
  verify('automatic selection is visible for Luna', await panel.locator('#ai-auto-option').isVisible(), true);
  verify('Luna defaults automatic selection off despite legacy aiAuto', await panel.locator('#ai-auto').isChecked(), false);
  verify('Luna automatic selection is enabled when assistance is on', await panel.locator('#ai-auto').isDisabled(), false);
  verify('Luna model is not offered for editing', await panel.locator('#ai-model').count(), 0);
  await panel.locator('#ai-openai-key').fill('synthetic-openai');
  // Saved with Save or Enter, never while typed.
  await panel.locator('#ai-openai-key').press('Enter');
  await panel.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.lunaKey === 'synthetic-openai');
  // The key arrived with this intake open: its claims box is read now, once.
  await panel.waitForFunction(async () => !!(await chrome.storage.session.get('intake')).intake?.notesReview, null, { timeout: 15000 });
  verify('adding the key reviews the open intake\'s claims box', claimsRequests, 1);
  await panel.waitForFunction(async () => !!(await chrome.storage.session.get('intake')).intake?.namesReview, null, { timeout: 15000 });
  verify('adding the key checks the open intake\'s driver first names', namesRequests, 1);
  verify('OpenAI key save stays in the dedicated Luna field', await panel.evaluate(async () =>
    (await chrome.storage.local.get('settings')).settings.lunaKey === 'synthetic-openai'), true);
  await openAgent();
  await panel.screenshot({ path: path.join(out, 'luna-settings.png'), fullPage: true, animations: 'disabled' });
  await panel.setViewportSize({ width: 320, height: 600 });
  verify('Luna settings fit a narrow side panel', await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: path.join(out, 'luna-settings-narrow.png'), fullPage: true, animations: 'disabled' });
  await panel.setViewportSize({ width: 420, height: 900 });
  // With Luna's independent toggle still off, keep the normal suggestion workflow available.
  await closeAgent();
  await clickFill();
  await openRow('Mock Luna choice');
  const manual = panel.getByRole('button', { name: 'Use this answer', exact: true });
  await manual.waitFor({ timeout: 30000 });
  verify('Luna stays suggestion-only while lunaAuto is off', await mock.locator('#mockLunaChoice').inputValue(), '');
  await manual.click();
  await mock.waitForFunction(() => document.querySelector('#mockLunaChoice').value === 'No');
  await panel.getByText(/Put in .*purple on the page/).first().waitFor();
  await mock.locator('#mockLunaChoice').selectOption('Yes');
  await panel.waitForTimeout(1800);
  verify('manual Luna acceptance and correction are retained', await mock.locator('#mockLunaChoice').inputValue(), 'Yes');
  await openAgent();
  await panel.locator('#ai-auto').check();
  await waitSetting('lunaAuto', true);
  verify('Luna auto setting is stored independently', (await savedSettings()).lunaAuto, true);
  await closeAgent();
  await openMock(); await loadPdf({ missingClaims: true });
  phase = 'automatic-approval';
  verify('follow-up automation stays off for the explicit approval flow', await panel.locator('#auto-followups').isChecked(), false);
  verify('fixture has no follow-up save before explicit Fill', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  await installSnapshotVariation();
  await clickFill();
  // The dock's Approve (its label says whether Continue follows).
  const approve = panel.locator('#ai-approve');
  await approve.waitFor({ timeout: 30000 });
  verify('Luna automatic selection applies only after the evidence check', await mock.locator('#mockLunaChoice').inputValue(), 'No');
  verify('auto path exercised alternating snapshot metadata order', await panel.evaluate(() =>
    (globalThis.__lunaMockSnapshotInterceptions?.() ?? 0) >= 2), true);
  verify('automatic selection holds Continue for approval', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  const aiText = `${await (await openRow('Mock Luna choice')).innerText()} ${await panel.locator('#dock').innerText()}`;
  verify('Luna automatic review has no confidence percentage', !aiText.includes('%') && !aiText.includes('confidence'), true);
  // Facts the intake doesn't give are the agent's since 2026-10-09 (plan.js `source: 'fact'` and
  // unanswered `clientFact` rules) and hold Continue too. Answering them on the page would change
  // the snapshot the automatic pick was checked against, so the agent marks them done here (Mark
  // done: nothing is filled or clicked): only the Luna approval holds Continue below.
  verify('missing claims does not become a prior-loss answer', await mock.locator('input[name=anyPriorLoss]:checked').count(), 0);
  verify('missing claims has a visible agent review item', await panel.locator('#report .row.need', { hasText: 'any prior loss' }).count(), 1);
  const leftBefore = await panel.locator('#finish-summary').innerText();
  for (const label of ['any prior loss', 'how long with current carrier', 'has additional interest', 'can provide claim free loss run', 'valued loss runs']) {
    if (!await panel.locator('#report .row.need', { hasText: label }).count()) continue;
    const need = await openRow(label);
    await need.locator('.mark-done').click();
    await panel.locator('#report .row.need.resolved', { hasText: label }).waitFor({ timeout: 30000 });
  }
  verify('Mark done lowers "left for you" without a refill', await panel.locator('#finish-summary').innerText() !== leftBefore, true);
  verify('Mark done keeps the Luna approval card', await approve.isVisible(), true);
  verify('agent-dismissed facts leave Continue held for the Luna approval', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  verify('facts left to the agent never reach Luna', agentFactsSent, 0);
  await panel.waitForFunction(async () => (await chrome.storage.local.get('aiPendingDecisions')).aiPendingDecisions?.length > 0);
  await panel.reload();
  await installSnapshotVariation({ firstReversed: true });
  // Re-scan the unchanged page so the restored pending record gets its approval card rendered;
  // aiSettledOnPage prevents a second provider request for the restored choice.
  await clickFill();
  await approve.waitFor({ timeout: 30000 });
  verify('automatic approval survives a panel reload', await mock.locator('#mockLunaChoice').inputValue(), 'No');
  await approve.click();
  await mock.waitForFunction(() => window.__amwinsMock.saves > 0, null, { timeout: 30000 });
  verify('reloaded approval exercised reordered snapshot metadata', await panel.evaluate(() =>
    (globalThis.__lunaMockSnapshotInterceptions?.() ?? 0) >= 1), true);
  await panel.evaluate(() => globalThis.__lunaMockRestoreSnapshot?.());
  await dockIdle();
  verify('approval releases Continue', await mock.evaluate(() => window.__amwinsMock.saves > 0), true);
  verify('approval does not submit the application', await mock.evaluate(() => window.__amwinsMock.submitted), false);
  verify('Luna uses both suggestion and evidence checks', requests >= 2, true);

  // A rejected automatic pick remains blocked until the agent changes the page value.
  mode = 'normal';
  await openMock(); await loadPdf();
  await clickFill();
  await approve.waitFor({ timeout: 30000 });
  await (await openRow('Mock Luna choice')).getByRole('button', { name: 'Reject', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm the current page answer', exact: true }).waitFor();
  verify('rejected Luna pick keeps Continue held', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  await dockIdle();
  // selectOption changes the synthetic control; trusted Tab supplies the recorder's user gesture.
  await mock.locator('#mockLunaChoice').selectOption('Yes');
  await mock.locator('#mockLunaChoice').focus();
  await mock.locator('#mockLunaChoice').press('Tab');
  let corrected = false;
  for (let attempt = 0; attempt < 24 && !corrected; attempt++) {
    corrected = await panel.evaluate(async () => {
      const { aiPendingDecisions } = await chrome.storage.local.get('aiPendingDecisions');
      return aiPendingDecisions?.some(x => x.key === 'mockLunaChoice' && x.manual) === true;
    });
    if (!corrected) await panel.waitForTimeout(250);
  }
  verify('manual correction clears the durable rejected hold', corrected, true);
  await panel.reload();
  await fillAndWait();
  verify('manual correction survives a panel reload', await mock.locator('#mockLunaChoice').inputValue(), 'Yes');
  verify('rejected hold stays cleared after reload', await panel.getByRole('button', { name: 'Confirm the current page answer', exact: true, includeHidden: true }).count(), 0);
  verify('rejected pick does not submit the application', await mock.evaluate(() => window.__amwinsMock.submitted), false);

  // Missing years plus three prior rows exercises the recorder's stable anonymous keys. A
  // manual garage-state edit must protect only that state field; it must not make every repeated
  // carrier-name control look manually answered. The native Years In Business choice is then made
  // by the agent and a delayed Fill again must reuse the settled Luna result.
  mode = 'normal';
  await openAgent();
  await panel.locator('#ai-auto').uncheck();
  await waitSetting('lunaAuto', false);
  await closeAgent();
  await panel.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, autoAdvance: false } });
  });
  await panel.reload();
  if (await panel.locator('#quote').isVisible()) {
    await panel.locator('#file-menu-btn').click();
    await panel.locator('#clear-client').click();
    await panel.locator('#file-confirm-yes').click();
    await panel.locator('#home').waitFor({ state: 'visible' });
  }
  await openMock();
  await addThreePriorRows();
  // Generate the dependent rows before the intake loads so this setup selection is the page
  // baseline rather than an agent correction that protects Years In Business.
  await loadPdfMissingYears();

  // Keep the generated prior rows while making the page's Years In Business answer blank. The
  // later keyboard selection is the trusted native change that resolves this page-side warning.
  await mock.locator('#yrsInBusiness').evaluate((el) => { el.value = ''; });
  const garageState = mock.locator('#garagePanel [data-id="state"]');
  await keyboardSelect(garageState, 'IN');
  const priorCarriers = mock.locator('#priorCarrierPanel > .app-rp-section select[data-id="carrierName"]');
  verify('AmWINS fixture exposes three prior carrier rows', await priorCarriers.count(), 3);

  await fillAndWait();
  await panel.waitForTimeout(1000);
  const priorValues = await priorCarriers.evaluateAll((els) => els.map((el) => el.value));
  verify('unrelated garage edit is retained', await garageState.inputValue(), 'IN');
  verify('all three prior carrier rows receive NO PRIOR', JSON.stringify(priorValues), JSON.stringify(['NO PRIOR', 'NO PRIOR', 'NO PRIOR']));
  // Blank years on the intake: TNI's standard New Venture (2026-10-09), which the agent corrects.
  verify('missing intake years get the New Venture standard', await mock.locator('#yrsInBusiness').inputValue(), 'New Venture');

  // Keep the long native-selection pause in the regression without relying on a popup-specific
  // browser behavior; the value is still changed through real keyboard events.
  await keyboardSelect(mock.locator('#yrsInBusiness'), '3', 5000);
  verify('trusted Years in Business selection replaces the standard', await mock.locator('#yrsInBusiness').inputValue(), '3');

  // Fill immediately after the Years in Business correction. This is the no-extra-Luna-request
  // check; at this point all three prior rows are still the carrier default.
  const beforeYearsFill = requests;
  await fillAndWait();
  await panel.waitForTimeout(1000);
  const yearsFillValues = await priorCarriers.evaluateAll((els) => els.map((el) => el.value));
  verify('Fill again after Years in Business reuses the settled Luna result', requests, beforeYearsFill);
  verify('the agent\'s Years in Business survives Fill again', await mock.locator('#yrsInBusiness').inputValue(), '3');
  verify('prior carrier defaults survive the Years in Business correction', JSON.stringify(yearsFillValues), JSON.stringify(['NO PRIOR', 'NO PRIOR', 'NO PRIOR']));

  // Select one genuine prior row after the Years in Business re-fill. The other two must remain
  // the defaults even when the selected row reveals new required policy fields.
  await keyboardSelect(priorCarriers.nth(1), 'TRAVELERS');
  // TRAVELERS reveals required policy fields, so this follow-up may legitimately add review work
  // and Luna requests. The assertion here is retention of the manually selected repeated row.
  await fillAndWait();
  const delayedValues = await priorCarriers.evaluateAll((els) => els.map((el) => el.value));
  verify('manual prior carrier selection is retained', delayedValues[1], 'TRAVELERS');
  verify('other prior carrier rows stay NO PRIOR', JSON.stringify([delayedValues[0], delayedValues[2]]), JSON.stringify(['NO PRIOR', 'NO PRIOR']));
  verify('garage edit remains isolated from prior carrier rows', await garageState.inputValue(), 'IN');

  // Maintainer 2026-10-10: Luna's intake checks. A general-liability mention in the claims box and
  // a first name more often a woman's become step-1 items; their buttons set the record as the
  // agent's edit (saved with the intake, marked agentEdited). Only first names are sent.
  phase = 'intake-checks';
  flagIntake = true;
  await openMock(); await loadPdf();
  flagIntake = false;
  const savedIntake = () => panel.evaluate(async () => (await chrome.storage.session.get('intake')).intake);
  const loaded = await savedIntake();
  const sent = JSON.stringify(namesSent.at(-1));
  verify('the name check sends first names only', loaded.record.drivers.every((d) => !d.last || !sent.includes(d.last))
    && Object.values(namesSent.at(-1)).every((n) => loaded.record.drivers.some((d) => String(d.first ?? '').startsWith(n))), true);
  verify('the fixture has no GL ticked', loaded.record.coverage.gl === true, false);
  if (await panel.locator('#check-view').isHidden()) await panel.locator('#step-check').click();
  const glCard = panel.locator('#warnings .check', { hasText: 'mention general liability' });
  const genderCard = panel.locator('#warnings .check', { hasText: 'is more often a woman\'s name' });
  await glCard.waitFor({ timeout: 15000 });
  const quoted = (await glCard.innerText()).match(/general liability: "(.+?)"\./)?.[1] ?? '';
  verify('the GL item quotes a line of the claims box', quoted.length > 0 && loaded.record.claims.text.replace(/\s+/g, ' ').includes(quoted.replace(/…$/, '')), true);
  const claimsBeforeChoice = claimsRequests;
  verify('the gender item says it is a guess from the name', /guess from the first name only/.test(await genderCard.innerText()), true);
  verify('the gender item says the TNI standard', /filled Male \(TNI standard\)/.test(await genderCard.innerText()), true);
  await panel.locator('#warnings').screenshot({ path: path.join(out, 'luna-intake-checks.png'), animations: 'disabled' });
  await glCard.getByRole('button', { name: 'Client has GL', exact: true }).click();
  await genderCard.getByRole('button', { name: 'Use Female', exact: true }).click();
  await panel.waitForFunction(async () => {
    const { intake } = await chrome.storage.session.get('intake');
    return intake.record.coverage.hasGl === true && intake.record.drivers[0].gender === 'FEMALE';
  }, null, { timeout: 15000 });
  const edited = await savedIntake();
  verify('the buttons are the agent\'s edits', ['coverage.hasGl', 'drivers[0].gender'].every((p) => edited.agentEdited.includes(p)), true);
  verify('Client has GL asks for no GL quote', edited.record.coverage.gl === true, false);
  verify('both items are checked', await panel.locator('#warnings .check', { hasText: /general liability|woman's name/ }).count(), 0);
  await panel.waitForTimeout(500);
  verify('confirming GL does not read the claims box again', claimsRequests, claimsBeforeChoice);

  mode = 'conflict';
  await openMock(); await loadPdf();
  await clickFill();
  await openRow('Mock Luna choice');
  await panel.getByText('Conflicting intake facts require clarification.', { exact: false }).waitFor();
  verify('conflicting evidence leaves the field unanswered', await mock.locator('#mockLunaChoice').inputValue(), '');
  verify('conflicting evidence offers no approval button', await approve.isVisible(), false);

  mode = 'slow';
  await openMock(); await loadPdf();
  const requestStarted = new Promise(resolve => { started = resolve; });
  await clickFill();
  await requestStarted;
  await openAgent();
  await panel.locator('#ai-on').uncheck();
  await waitSetting('aiOn', false);
  release();
  await panel.waitForTimeout(1000);
  verify('turning assistance off discards an in-flight Luna response', await panel.locator('#report .row.pending').count(), 0);
  verify('stale provider response never fills the page', await mock.locator('#mockLunaChoice').inputValue(), '');
  // With assistance off a new intake gets neither check: nothing sent, GL and gender untouched.
  phase = 'intake-checks-off';
  const offBefore = claimsRequests + namesRequests;
  flagIntake = true;
  await closeAgent();
  await openMock(); await loadPdf();
  await panel.waitForTimeout(1000);
  flagIntake = false;
  const offIntake = await savedIntake();
  verify('assistance off: no claims or name check is sent', claimsRequests + namesRequests, offBefore);
  verify('assistance off: no GL or gender item', await panel.locator('#warnings .check', { hasText: /general liability|woman's name/ }).count(), 0);
  verify('assistance off: GL and gender stay as the intake has them', offIntake.record.coverage.gl !== true && offIntake.record.coverage.hasGl !== true && offIntake.record.drivers.every((d) => d.gender == null), true);
  verify('no unrecognized provider host was contacted', unexpectedProviderHosts.size, 0);
  verify('nothing was submitted', await mock.evaluate(() => window.__amwinsMock.submitted), false);
  verify('browser errors', errors.length, 0);
  console.log(`Luna mock: ${checks.length} checks passed.`);
} catch (error) {
  const safe = async (read, fallback = null) => {
    try { return await read(); } catch { return fallback; }
  };
  const settings = await safe(() => panel?.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    return {
      aiOn: settings.aiOn === true,
      lunaAuto: settings.lunaAuto === true,
      hasLunaKey: Boolean(settings.lunaKey),
    };
  }));
  const diagnostics = {
    phase,
    error: String(error?.stack ?? error),
    settings,
    mockChoice: await safe(() => mock?.locator('#mockLunaChoice').inputValue()),
    saves: await safe(() => mock?.evaluate(() => window.__amwinsMock?.saves ?? null)),
    mockFrames: mock ? mock.frames().map(frame => new URL(frame.url()).pathname).slice(0, 8) : [],
    pageSnapshot: await safe(() => mock?.evaluate(() => {
      const value = globalThis.__raterKit?.decisionSnapshot?.();
      return { available: typeof globalThis.__raterKit?.decisionSnapshot === 'function', length: value?.length ?? null };
    })),
    requestCounts: { luna: requests, claimsReview: claimsRequests, driverNames: namesRequests, unexpectedProviderHosts: [...unexpectedProviderHosts] },
    panelReport: (await safe(() => panel?.locator('#report').innerText(), '')).slice(0, 4000),
    pageErrors: errors.slice(-20),
  };
  try { await panel?.screenshot({ path: path.join(out, 'failure.png'), fullPage: true, animations: 'disabled' }); } catch { /* preserve original failure */ }
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify(diagnostics, null, 2));
  throw error;
} finally {
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ checks, errors, requests, unexpectedProviderHosts: [...unexpectedProviderHosts], phase }, null, 2));
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
}
