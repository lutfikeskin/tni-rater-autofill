#!/usr/bin/env node
// Packaged extension, real fixture controls, intercepted Anthropic (Claude) responses. No live API calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), `claude-mock-${Date.now()}`));
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
  res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rater-claude-'));
const checks = [], errors = [];
let context, mock, panel, phase = 'startup', requests = 0, mode = 'normal', started, release;
// The claims-box review (once per intake), counted apart from page questions.
let claimsRequests = 0;
// Fields the rules leave to the agent (manualOnly) that still reached Claude: must stay 0.
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
    if (url.hostname === 'api.anthropic.com') {
      assert.equal(url.pathname, '/v1/messages');
      const request = route.request(), headers = await request.allHeaders();
      // The SDK's browser request: the agent's key, the API version, the direct-browser header.
      assert.equal(headers['anthropic-version'], '2023-06-01');
      assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
      assert.ok(headers['x-api-key']);
      assert.equal(headers.authorization, undefined);
      const body = request.postDataJSON(), state = JSON.parse(body.messages[0].content);
      assert.equal(body.model, 'claude-haiku-5-5');
      assert.equal(body.max_tokens, 16000);
      assert.equal(body.output_config.effort, 'low');
      assert.equal(body.output_config.format.type, 'json_schema');
      assert.equal(body.temperature, undefined);
      assert.equal(body.top_p, undefined);
      assert.equal(body.thinking, undefined);
      assert.equal(JSON.stringify(body).includes('maxItems'), false);
      // A Messages API response: an empty thinking block (adaptive thinking), then the answer.
      const reply = (data, usage) => route.fulfill({ json: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
        content: [{ type: 'thinking', thinking: '', signature: 'mock' }, { type: 'text', text: JSON.stringify(data) }],
        stop_reason: 'end_turn', stop_sequence: null, usage } });
      if (state.claimsBox) {
        claimsRequests++;
        // Nothing flagged: the synthetic claims box holds no coverage request or time in business.
        const lines = Object.fromEntries(Object.keys(state.claimsBox).map(id => [id, { ntl: false, coverageChange: false }]));
        return reply({ lines, businessTime: { line: 'none', years: -1, since: -1 } }, { input_tokens: 50, output_tokens: 5 });
      }
      requests++;
      agentFactsSent += Object.values(state.fields ?? {}).filter(f => AGENT_FACT.test(f.label ?? '')).length;
      if (mode === 'slow') { started?.(); await new Promise(resolve => { release = resolve; }); }
      assert.ok(JSON.stringify(body).length <= 48000);
      assert.ok(Object.keys(state.proposed ?? state.fields).length <= 12);
      if (!state.proposed) assert.equal(state.intake, undefined);
      const decisions = {};
      if (state.proposed) {
        for (const id of Object.keys(state.proposed)) decisions[id] = { supported: true };
      } else {
        const source = Object.keys(state.sources).find(id => state.sources[id].path === 'operations.hazPlacard');
        for (const [id, field] of Object.entries(state.fields)) {
          const option = Object.keys(field.options).find(id => field.options[id] === 'No');
          const matches = field.label.includes('Mock Claude choice') && !!source && !!option;
          decisions[id] = { option: matches ? option : '__leave__', sourceIds: matches ? [source] : [],
            explanation: matches ? 'The supplied intake explicitly says No.' : 'Agent review required.',
            missingInformation: [], conflicts: matches && mode === 'conflict' ? ['Conflicting intake facts require clarification.'] : [] };
        }
      }
      return reply({ decisions }, { input_tokens: 100, output_tokens: 30 });
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
  await worker.evaluate(() => chrome.storage.local.set({ settings: { aiOn: true, aiAuto: true, claudeAuto: false,
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
      field.innerHTML = '<label for="mockClaudeChoice">Mock Claude choice</label><select id="mockClaudeChoice" class="form-control"><option value="">Choose</option><option>Yes</option><option>No</option></select>';
      document.querySelector('.form-tab').append(field);
    });
    await mock.bringToFront();
    await panel.waitForFunction((prefix) => chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => tab?.url?.startsWith(prefix)), `${base}/test/fixtures/amwins/`);
    await panel.waitForFunction(() => document.querySelector('#site')?.textContent.includes('AmWINS'));
  };
  const loadPdf = async ({ missingClaims = false } = {}) => {
    phase = 'load-pdf';
    if (await panel.locator('#clear-client').isVisible()) {
      await panel.locator('#clear-client').click();
      await panel.locator('#home').waitFor({ state: 'visible' });
    }
    const claimsBefore = claimsRequests;
    await panel.setInputFiles('#file', path.join(root, 'test/fixtures/sample-intake.pdf'));
    await panel.locator('#quote').waitFor({ state: 'visible' });
    // With Claude on and its key set, the panel reads the new intake's claims box: let that save
    // first, or it would write over the fixture edit below.
    if (await panel.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); return !!(settings?.aiOn && settings?.claudeKey); })) {
      await panel.waitForFunction(async () => !!(await chrome.storage.session.get('intake')).intake?.notesReview, null, { timeout: 15000 });
      verify('a new intake gets one claims-box review', claimsRequests - claimsBefore, 1);
    }
    // This controlled fixture fact is synthetic; no customer data or external provider is used.
    await panel.evaluate(async (missingClaims) => {
      const { intake } = await chrome.storage.session.get('intake');
      intake.record.operations.hazPlacard = false;
      if (missingClaims) intake.record.claims.hasClaims = null;
      await chrome.storage.session.set({ intake });
    }, missingClaims);
    await panel.reload();
    await panel.locator('#tab-fill').click();
    // The panel reload completes before its async tab refresh on some Chromium/Linux runs.
    // Wait for the active fixture and an enabled Fill control, which are the production
    // conditions needed by the following AI request.
    await panel.waitForFunction((prefix) => chrome.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => tab?.url?.startsWith(prefix)), `${base}/test/fixtures/amwins/`);
    await panel.locator('#fill:not(:disabled)').waitFor({ state: 'visible' });
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
    await panel.locator('#tab-fill').click();
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
      el.__claudeMockEvents = [];
      el.__claudeMockListener = event => el.__claudeMockEvents.push(event.isTrusted);
      for (const type of ['input', 'change']) el.addEventListener(type, el.__claudeMockListener);
    });
    await locator.focus();
    // Start the long-delay gesture with a real key event, then use native typeahead to choose the
    // desired option. This deliberately covers the old recorder window without popup assumptions.
    await locator.press('Home');
    if (delayMs) await mock.waitForTimeout(delayMs);
    await mock.keyboard.type(targetText);
    await mock.keyboard.press('Enter');
    const result = await locator.inputValue();
    const trustedEvents = await locator.evaluate((el) => el.__claudeMockEvents ?? []);
    await locator.evaluate((el) => {
      for (const type of ['input', 'change']) el.removeEventListener(type, el.__claudeMockListener);
      delete el.__claudeMockListener;
      delete el.__claudeMockEvents;
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
  const openAgent = async () => {
    await panel.locator('#agent-btn').click();
    await panel.locator('#agent-popover').waitFor({ state: 'visible' });
  };
  const savedSettings = () => panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  const fillAndWait = async () => {
    await panel.locator('#fill').click();
    await panel.locator('#fill:disabled').waitFor({ state: 'visible' });
    await panel.locator('#fill:not(:disabled)').waitFor({ state: 'visible' });
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
      globalThis.__claudeMockSnapshotInterceptions = () => interceptions;
      globalThis.__claudeMockRestoreSnapshot = () => {
        scripting.executeScript = original;
        delete globalThis.__claudeMockSnapshotInterceptions;
        delete globalThis.__claudeMockRestoreSnapshot;
      };
    }, { firstReversed });
  };
  await openMock();
  await loadPdf();

  // A pre-upgrade profile may contain only legacy Jev and OpenAI (Luna) fields. A pending automatic
  // decision from that profile must remain a review hold after the panel reloads, while Claude
  // receives no key derived from those legacy fields and no legacy provider request is made.
  await mock.bringToFront();
  const legacyTabId = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
  const legacyScope = await panel.evaluate(async () => (await chrome.storage.session.get('session')).session.intakeId);
  await panel.evaluate(({ scope, tabId }) => chrome.storage.local.set({
    settings: { aiOn: true, aiAuto: true, jevKey: 'legacy-typesafe-key', aiKey: 'legacy-openai-key', jevModel: 'jev-1.13.0',
      lunaKey: 'legacy-luna-key', lunaAuto: true,
      autoFollowUps: false, autoPages: false, autoAdvance: true, serverUrl: '', serverToken: '' },
    aiPendingDecisions: [{ version: 1, scope, tabId, page: '/test/fixtures/amwins/application.html',
      model: 'jev-1.13.0', policy: 'jev-evidence-v2', contextHash: 'legacy-context', itemHash: 'legacy-item',
      key: 'mockClaudeChoice', label: 'Mock Claude choice', choice: 'No', controlKind: 'select', done: 'auto',
      approved: false, rejected: false, manual: false, confirmed: false, snapshotHash: null, confidence: null }],
  }), { scope: legacyScope, tabId: legacyTabId });
  await panel.reload();
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  await panel.locator('.ai-approve').waitFor({ timeout: 30000 });
  verify('retired automatic decision requires explicit review', await panel.getByRole('button', { name: 'Confirm the current page answer', exact: true }).count(), 1);
  verify('legacy automatic decision remains a review hold after reload', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  verify('legacy profile makes no Claude or Jev request', requests + claimsRequests, 0);
  verify('legacy profile does not contact the Jev host', unexpectedProviderHosts.size, 0);
  const migratedSettings = await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings ?? {});
  verify('legacy OpenAI/TypeSafe fields do not become a Claude key', migratedSettings.claudeKey ?? '', '');
  verify('legacy settings are purged after migration', ['aiKey', 'jevKey', 'jevModel', 'lunaKey', 'lunaAuto'].every(key => !Object.hasOwn(migratedSettings, key)), true);
  await keyboardSelect(mock.locator('#mockClaudeChoice'), 'Yes');
  await panel.waitForFunction(async () => (await chrome.storage.local.get('aiPendingDecisions')).aiPendingDecisions?.some(x => x.key === 'mockClaudeChoice' && x.manual) === true);
  await panel.reload();
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  await panel.waitForFunction(() => !document.querySelector('#fill').disabled);
  verify('manual upgrade correction releases the retired hold', await panel.locator('.ai-approve').count(), 0);

  // Continue the normal Claude workflow with its dedicated key after the upgrade check.
  await panel.evaluate(() => chrome.storage.local.set({ settings: { aiProvider: 'luna', lunaKey: 'legacy-luna-key', aiOn: true, aiAuto: true, claudeAuto: false,
    claudeKey: '', autoFollowUps: false, autoPages: false, autoAdvance: true, serverUrl: '', serverToken: '' } }));
  await panel.reload();
  // The migration hold fill may have settled every other question on this page. Start a fresh
  // intake so the missing-key path still has an unresolved Claude question to render.

  await openMock();
  await loadPdf();
  phase = 'missing-key';
  await panel.locator('#fill').click();
  await panel.getByText(/Claude Haiku 5.5 needs an Anthropic API key/).waitFor();
  verify('Claude never reuses legacy or TypeSafe keys', requests + claimsRequests, 0);
  await panel.locator('#fill-notices').getByRole('button', { name: 'Add key', exact: true }).click();
  await panel.locator('#ai-anthropic-key').waitFor({ state: 'visible' });
  verify('missing Anthropic key focuses its dedicated field', await panel.evaluate(() => document.activeElement.id), 'ai-anthropic-key');
  verify('automatic selection is visible for Claude', await panel.locator('#ai-auto-option').isVisible(), true);
  verify('Claude defaults automatic selection off despite legacy aiAuto', await panel.locator('#ai-auto').isChecked(), false);
  verify('Claude automatic selection is enabled when assistance is on', await panel.locator('#ai-auto').isDisabled(), false);
  verify('Claude model remains fixed', await panel.locator('#ai-model').isDisabled(), true);
  await panel.locator('#ai-anthropic-key').fill('synthetic-anthropic');
  await panel.locator('#ai-anthropic-key').press('Tab');
  await panel.waitForFunction(async () => (await chrome.storage.local.get('settings')).settings.claudeKey === 'synthetic-anthropic');
  // The key arrived with this intake open: its claims box is read now, once.
  await panel.waitForFunction(async () => !!(await chrome.storage.session.get('intake')).intake?.notesReview, null, { timeout: 15000 });
  verify('adding the key reviews the open intake\'s claims box', claimsRequests, 1);
  verify('Anthropic key save stays in the dedicated Claude field', await panel.evaluate(async () =>
    (await chrome.storage.local.get('settings')).settings.claudeKey === 'synthetic-anthropic'), true);
  await panel.locator('#agent-btn').click();
  await panel.locator('#agent-popover').waitFor({ state: 'visible' });
  await panel.screenshot({ path: path.join(out, 'claude-settings.png'), fullPage: true, animations: 'disabled' });
  await panel.setViewportSize({ width: 320, height: 600 });
  verify('Claude settings fit a narrow side panel', await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await panel.screenshot({ path: path.join(out, 'claude-settings-narrow.png'), fullPage: true, animations: 'disabled' });
  await panel.setViewportSize({ width: 420, height: 900 });
  // With Claude's independent toggle still off, keep the normal suggestion workflow available.
  await panel.locator('#close-agent').click();
  await panel.locator('#fill').click();
  const manual = panel.getByRole('button', { name: 'Use this answer', exact: true });
  await manual.waitFor({ timeout: 30000 });
  verify('Claude stays suggestion-only while claudeAuto is off', await mock.locator('#mockClaudeChoice').inputValue(), '');
  await manual.click();
  await mock.waitForFunction(() => document.querySelector('#mockClaudeChoice').value === 'No');
  await panel.getByText(/Put in .*purple on the page/).first().waitFor();
  await mock.locator('#mockClaudeChoice').selectOption('Yes');
  await panel.waitForTimeout(1800);
  verify('manual Claude acceptance and correction are retained', await mock.locator('#mockClaudeChoice').inputValue(), 'Yes');
  await openAgent();
  await panel.locator('#ai-auto').check();
  await waitSetting('claudeAuto', true);
  verify('Claude auto setting is stored independently', (await savedSettings()).claudeAuto, true);
  await panel.locator('#close-agent').click();
  await openMock(); await loadPdf({ missingClaims: true });
  phase = 'automatic-approval';
  verify('follow-up automation stays off for the explicit approval flow', await panel.locator('#auto-followups').isChecked(), false);
  verify('fixture has no follow-up save before explicit Fill', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  await installSnapshotVariation();
  await panel.locator('#fill').click();
  const approve = panel.getByRole('button', { name: 'Approve and continue', exact: true });
  await approve.waitFor({ timeout: 30000 });
  verify('Claude automatic selection applies only after the evidence check', await mock.locator('#mockClaudeChoice').inputValue(), 'No');
  verify('auto path exercised alternating snapshot metadata order', await panel.evaluate(() =>
    (globalThis.__claudeMockSnapshotInterceptions?.() ?? 0) >= 2), true);
  verify('automatic selection holds Continue for approval', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  const aiText = await panel.locator('.ai-holder').first().innerText();
  verify('Claude automatic review has no confidence percentage', !aiText.includes('%') && !aiText.includes('confidence'), true);
  // Facts the intake doesn't give are the agent's since 2026-10-09 (plan.js `source: 'fact'` and
  // unanswered `clientFact` rules) and hold Continue too. Answering them on the page would change
  // the snapshot the automatic pick was checked against, so the agent dismisses them (×) here:
  // only the Claude approval holds Continue below.
  verify('missing claims does not become a prior-loss answer', await mock.locator('input[name=anyPriorLoss]:checked').count(), 0);
  verify('missing claims has a visible agent review item', await panel.locator('.need', { hasText: 'any prior loss' }).count(), 1);
  for (const label of ['any prior loss', 'how long with current carrier', 'has additional interest', 'can provide claim free loss run', 'valued loss runs']) {
    const need = panel.locator('.need', { hasText: label });
    if (!await need.count()) continue;
    await need.locator('.ignore-review').click();
    await need.waitFor({ state: 'detached', timeout: 30000 });
    await approve.waitFor({ timeout: 30000 });
  }
  verify('agent-dismissed facts leave Continue held for the Claude approval', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  verify('facts left to the agent never reach Claude', agentFactsSent, 0);
  await panel.waitForFunction(async () => (await chrome.storage.local.get('aiPendingDecisions')).aiPendingDecisions?.length > 0);
  await panel.reload();
  await panel.locator('#tab-fill').click();
  await installSnapshotVariation({ firstReversed: true });
  // Re-scan the unchanged page so the restored pending record gets its approval card rendered;
  // aiSettledOnPage prevents a second provider request for the restored choice.
  await panel.locator('#fill').click();
  await approve.waitFor({ timeout: 30000 });
  verify('automatic approval survives a panel reload', await mock.locator('#mockClaudeChoice').inputValue(), 'No');
  await approve.click();
  await mock.waitForFunction(() => window.__amwinsMock.saves > 0, null, { timeout: 30000 });
  verify('reloaded approval exercised reordered snapshot metadata', await panel.evaluate(() =>
    (globalThis.__claudeMockSnapshotInterceptions?.() ?? 0) >= 1), true);
  await panel.evaluate(() => globalThis.__claudeMockRestoreSnapshot?.());
  await panel.waitForFunction(() => !document.querySelector('#fill').disabled);
  verify('approval releases Continue', await mock.evaluate(() => window.__amwinsMock.saves > 0), true);
  verify('approval does not submit the application', await mock.evaluate(() => window.__amwinsMock.submitted), false);
  verify('Claude uses both suggestion and evidence checks', requests >= 2, true);

  // A rejected automatic pick remains blocked until the agent changes the page value.
  mode = 'normal';
  await openMock(); await loadPdf();
  await panel.locator('#fill').click();
  await approve.waitFor({ timeout: 30000 });
  await panel.getByRole('button', { name: 'Reject', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirm the current page answer', exact: true }).waitFor();
  verify('rejected Claude pick keeps Continue held', await mock.evaluate(() => window.__amwinsMock.saves), 0);
  await panel.waitForFunction(() => !document.querySelector('#fill').disabled);
  // selectOption changes the synthetic control; trusted Tab supplies the recorder's user gesture.
  await mock.locator('#mockClaudeChoice').selectOption('Yes');
  await mock.locator('#mockClaudeChoice').focus();
  await mock.locator('#mockClaudeChoice').press('Tab');
  let corrected = false;
  for (let attempt = 0; attempt < 24 && !corrected; attempt++) {
    corrected = await panel.evaluate(async () => {
      const { aiPendingDecisions } = await chrome.storage.local.get('aiPendingDecisions');
      return aiPendingDecisions?.some(x => x.key === 'mockClaudeChoice' && x.manual) === true;
    });
    if (!corrected) await panel.waitForTimeout(250);
  }
  verify('manual correction clears the durable rejected hold', corrected, true);
  await panel.reload();
  await panel.locator('#tab-fill').click();
  await panel.locator('#fill').click();
  await panel.waitForFunction(() => !document.querySelector('#fill').disabled);
  verify('manual correction survives a panel reload', await mock.locator('#mockClaudeChoice').inputValue(), 'Yes');
  verify('rejected hold stays cleared after reload', await panel.getByRole('button', { name: 'Confirm the current page answer', exact: true }).count(), 0);
  verify('rejected pick does not submit the application', await mock.evaluate(() => window.__amwinsMock.submitted), false);

  // Missing years plus three prior rows exercises the recorder's stable anonymous keys. A
  // manual garage-state edit must protect only that state field; it must not make every repeated
  // carrier-name control look manually answered. The native Years In Business choice is then made
  // by the agent and a delayed Fill again must reuse the settled Claude result.
  mode = 'normal';
  await openAgent();
  await panel.locator('#ai-auto').uncheck();
  await waitSetting('claudeAuto', false);
  await panel.locator('#close-agent').click();
  await panel.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, autoAdvance: false } });
  });
  await panel.reload();
  await panel.locator('#tab-fill').click();
  if (await panel.locator('#clear-client').isVisible()) {
    await panel.locator('#clear-client').click();
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

  // Fill immediately after the Years in Business correction. This is the no-extra-Claude-request
  // check; at this point all three prior rows are still the carrier default.
  const beforeYearsFill = requests;
  await fillAndWait();
  await panel.waitForTimeout(1000);
  const yearsFillValues = await priorCarriers.evaluateAll((els) => els.map((el) => el.value));
  verify('Fill again after Years in Business reuses the settled Claude result', requests, beforeYearsFill);
  verify('the agent\'s Years in Business survives Fill again', await mock.locator('#yrsInBusiness').inputValue(), '3');
  verify('prior carrier defaults survive the Years in Business correction', JSON.stringify(yearsFillValues), JSON.stringify(['NO PRIOR', 'NO PRIOR', 'NO PRIOR']));

  // Select one genuine prior row after the Years in Business re-fill. The other two must remain
  // the defaults even when the selected row reveals new required policy fields.
  await keyboardSelect(priorCarriers.nth(1), 'TRAVELERS');
  // TRAVELERS reveals required policy fields, so this follow-up may legitimately add review work
  // and Claude requests. The assertion here is retention of the manually selected repeated row.
  await fillAndWait();
  const delayedValues = await priorCarriers.evaluateAll((els) => els.map((el) => el.value));
  verify('manual prior carrier selection is retained', delayedValues[1], 'TRAVELERS');
  verify('other prior carrier rows stay NO PRIOR', JSON.stringify([delayedValues[0], delayedValues[2]]), JSON.stringify(['NO PRIOR', 'NO PRIOR']));
  verify('garage edit remains isolated from prior carrier rows', await garageState.inputValue(), 'IN');

  mode = 'conflict';
  await openMock(); await loadPdf();
  await panel.locator('#fill').click();
  await panel.getByText('Conflicting intake facts require clarification.', { exact: false }).waitFor();
  verify('conflicting evidence leaves the field unanswered', await mock.locator('#mockClaudeChoice').inputValue(), '');
  verify('conflicting evidence offers no approval button', await approve.count(), 0);

  mode = 'slow';
  await openMock(); await loadPdf();
  const requestStarted = new Promise(resolve => { started = resolve; });
  await panel.locator('#fill').click();
  await requestStarted;
  await openAgent();
  await panel.locator('#ai-on').uncheck();
  await waitSetting('aiOn', false);
  release();
  await panel.waitForTimeout(1000);
  verify('turning assistance off discards an in-flight Claude response', await approve.count(), 0);
  verify('stale provider response never fills the page', await mock.locator('#mockClaudeChoice').inputValue(), '');
  verify('no unrecognized provider host was contacted', unexpectedProviderHosts.size, 0);
  verify('nothing was submitted', await mock.evaluate(() => window.__amwinsMock.submitted), false);
  verify('browser errors', errors.length, 0);
  console.log(`Claude mock: ${checks.length} checks passed.`);
} catch (error) {
  const safe = async (read, fallback = null) => {
    try { return await read(); } catch { return fallback; }
  };
  const settings = await safe(() => panel?.evaluate(async () => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    return {
      aiOn: settings.aiOn === true,
      claudeAuto: settings.claudeAuto === true,
      hasClaudeKey: Boolean(settings.claudeKey),
    };
  }));
  const diagnostics = {
    phase,
    error: String(error?.stack ?? error),
    settings,
    mockChoice: await safe(() => mock?.locator('#mockClaudeChoice').inputValue()),
    saves: await safe(() => mock?.evaluate(() => window.__amwinsMock?.saves ?? null)),
    mockFrames: mock ? mock.frames().map(frame => new URL(frame.url()).pathname).slice(0, 8) : [],
    pageSnapshot: await safe(() => mock?.evaluate(() => {
      const value = globalThis.__raterKit?.decisionSnapshot?.();
      return { available: typeof globalThis.__raterKit?.decisionSnapshot === 'function', length: value?.length ?? null };
    })),
    requestCounts: { claude: requests, claimsReview: claimsRequests, unexpectedProviderHosts: [...unexpectedProviderHosts] },
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
