import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { carrierForUrl } from '../src/carriers.js';
import { buildPlan } from '../src/plan.js';
import { PANEL_SOURCE } from './panel-source.mjs';

/** @import { ClientRecord } from '../types.js' */

/** @param {string} name */
function extractFunction(name) {
  const match = PANEL_SOURCE.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(match, `could not find ${name} in PANEL_SOURCE`);
  const start = match.index;
  const params = PANEL_SOURCE.indexOf('(', start);
  let parameterDepth = 1;
  let parameterEnd = params + 1;
  for (; parameterDepth && parameterEnd < PANEL_SOURCE.length; parameterEnd++) {
    if (PANEL_SOURCE[parameterEnd] === '(') parameterDepth++;
    if (PANEL_SOURCE[parameterEnd] === ')') parameterDepth--;
  }
  const open = PANEL_SOURCE.indexOf('{', parameterEnd);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < PANEL_SOURCE.length; i += 1) {
    const ch = PANEL_SOURCE[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && PANEL_SOURCE[i + 1] === '/') {
      i = PANEL_SOURCE.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && PANEL_SOURCE[i + 1] === '*') {
      i = PANEL_SOURCE.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return PANEL_SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

/** @type {ClientRecord} */
const sampleRecord = /** @type {any} */ ({
  applicant: {
    name: 'Synthetic Expediter LLC',
    dba: 'Synthetic Freight',
    dot: '1234567',
    mc: '765432',
    phone: '(555) 010-0100',
    email: 'ops@example.com',
    owner1: 'Amina Kone',
    ownerDrives: true,
    entityType: 'LLC',
    yearsInBusiness: 3,
  },
  garaging: { street: '1 Test Way', city: 'Testville', state: 'OH', zip: '43001' },
  mailing: { street: '1 Test Way', city: 'Testville', state: 'OH', zip: '43001' },
  operations: {
    businessClass: 'Expediter',
    whatHaul: 'General freight',
    radius: '500+',
    vehicleOwnership: 'Owned',
  },
  drivers: [
    { first: 'Amina', last: 'Kone', dob: '01/02/1980', licenseNumber: 'OH1234567', licenseState: 'OH', cdl: true, cdlYears: 5 },
  ],
  vehicles: [
    { type: 'Tractor', year: 2022, make: 'FREIGHTLINER', model: 'Cascadia', vin: '1FUJGLDR5NSAA1234', value: 120000, gvw: 80000 },
  ],
  trailers: [
    { type: 'Dry Van', year: 2021, make: 'UTILITY', vin: '1UYVS2538MU123456', value: 45000 },
  ],
  trailerInfo: {},
  priorInsurance: [
    { carrier: 'Progressive', effectiveDate: '01/01/2025', expirationDate: '01/01/2026' },
  ],
  coverage: { autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: '$100,000', generalLiability: true },
  claims: { hasClaims: false },
});

test('BHHC recon stub matches only portal.bhhomestate.com', () => {
  const bhhc = carrierForUrl('https://portal.bhhomestate.com/breeze/quote');
  assert.ok(bhhc, 'portal.bhhomestate.com matches a carrier');
  assert.equal(bhhc.id, 'bhhc');
  assert.equal(bhhc.product, 'commercial-auto');
  assert.equal(bhhc.recon, true);
  assert.equal(carrierForUrl('https://portal.bhhomestate.com/', { product: 'commercial-auto' })?.id, 'bhhc');

  for (const url of [
    'https://agency.bhhc.com/login',
    'https://policyholder.bhhc.com/',
    'https://quickpay.bhhc.com/pay',
    'https://www.bhhomestate.com/',
    'https://bhhc.com/commercial-auto',
    'https://bhhomestate.com/',
  ]) {
    assert.equal(carrierForUrl(url), null, `${url} must not match BHHC`);
  }
});

test('BHHC recon stub builds an empty plan and never auto-fills', () => {
  const bhhc = carrierForUrl('https://portal.bhhomestate.com/breeze');
  assert.ok(bhhc);
  assert.equal(bhhc.useGenericRules, false);
  assert.deepEqual(bhhc.rules, []);
  assert.equal(bhhc.layoutUrl, undefined);

  const plan = buildPlan(sampleRecord, bhhc, { vehicles: 0, drivers: 0, trailers: 0 });
  assert.deepEqual(plan, [], 'stub produces no fill steps or actions');

  assert.ok(bhhc.autoFillUrl instanceof RegExp, 'autoFillUrl is a RegExp');
  for (const url of [
    '',
    'https://portal.bhhomestate.com/',
    'https://portal.bhhomestate.com/breeze',
    'https://portal.bhhomestate.com/breeze/quote/12345',
    'http://portal.bhhomestate.com/',
  ]) {
    assert.equal(bhhc.autoFillUrl.test(url), false, `autoFillUrl must not match ${url}`);
  }
});

test('recon carrier logs nothing from onRecorderMessage (page_view, field_changes, agent_click, recorder_error) while normal carriers still log', () => {
  /** @param {any} carrier */
  function runEvents(carrier) {
    /** @type {any[]} */
    const logged = [];
    const state = {
      intake: { record: sampleRecord },
      tab: { id: 7, url: 'https://portal.bhhomestate.com/breeze', carrier },
      visitedPages: new Set(),
      layoutNewTabs: new Set(),
      layoutReadyTabs: new Set(),
      stopScreens: new Map(),
      doneActions: new Set(),
      autoPages: new Set(),
      agentKeys: new Map(),
      filled: new Map(),
      labels: new Map(),
      choices: new Map(),
    };
    const sandbox = vm.createContext({
      state,
      usage: { log: (...events) => logged.push(...events), currentSession: () => ({ id: 'sess1', keySalt: 'salt' }) },
      samePage: (p) => String(p ?? ''),
      pageOf: () => '/breeze',
      viewOf: () => 't1',
      stopNoteFor: () => null,
      stopPageIsOurs: () => false,
      showStopPage: () => {},
      seedQuoteState: () => {},
      scheduleLayout: () => {},
      persistDoneActions: () => {},
      unitArrival: () => {},
      switchOn: () => false,
      onQuotePage: () => false,
      fillPage: () => {},
      knownStep: () => null,
      redactor: () => (s) => s,
      redactionTerms: () => [],
      fieldChangeEvent: (c) => ({ type: 'field_change', key: c.key }),
      quoteStatePick: () => undefined,
      noteQuoteState: () => {},
      noteChangedAfterDone: () => false,
      renderSteps: () => {},
      changeScopes: () => [],
      persistAgentKeys: () => {},
      answeredOnPage: () => {},
      settleRejectedAi: () => Promise.resolve(false),
      syncAiBanner: () => {},
      scheduleAutoFill: () => {},
      agentHelperDone: () => {},
      releaseDiscardedForms: () => {},
      clientErrorEvent: (err, { where }) => ({ type: 'client_error', where, error: err.message }),
      loggedCrashes: new Set(),
    });
    vm.runInContext(`${extractFunction('unlogged')}\n${extractFunction('logCrash')}\n${extractFunction('onRecorderMessage')}`, sandbox);
    const sender = { tab: { id: 7 }, frameId: 0 };
    sandbox.onRecorderMessage({ ra: 'usage', event: 'page_view', page: '/breeze', fields: 3 }, sender);
    sandbox.onRecorderMessage({ ra: 'usage', event: 'field_changes', page: '/breeze', changes: [{ key: 'k1', agent: true, after: 'Yes' }] }, sender);
    sandbox.onRecorderMessage({ ra: 'usage', event: 'agent_click', page: '/breeze', text: 'Next' }, sender);
    sandbox.onRecorderMessage({ ra: 'usage', event: 'recorder_error', message: 'boom', stack: '' }, sender);
    return logged;
  }

  const bhhc = carrierForUrl('https://portal.bhhomestate.com/breeze');
  assert.ok(bhhc);
  assert.deepEqual(runEvents(bhhc), [], 'recon carrier logs nothing');

  const normal = { ...bhhc, recon: false };
  const normalLogged = runEvents(normal);
  assert.deepEqual(
    normalLogged.map((e) => e.type),
    ['page_view', 'field_change', 'agent_click', 'client_error'],
    'normal carrier logs all four event types',
  );
});

test('ensureRecorder still injects recorder.js and trace.js on a recon carrier', async () => {
  const bhhc = carrierForUrl('https://portal.bhhomestate.com/breeze');
  assert.ok(bhhc);
  /** @type {any[]} */
  const calls = [];
  const state = {
    intake: { record: sampleRecord },
    tab: { id: 9, url: 'https://portal.bhhomestate.com/breeze', carrier: bhhc },
    recording: { tabId: 9, stopping: false },
    filling: false,
  };
  const sandbox = vm.createContext({
    inExtension: true,
    state,
    chrome: {
      scripting: { executeScript: async (arg) => { calls.push(arg); return []; } },
    },
    tellRecorder: async () => {},
  });
  vm.runInContext(extractFunction('ensureRecorder'), sandbox);
  await sandbox.ensureRecorder();
  assert.equal(calls.length, 1);
  assert.deepEqual([...calls[0].files], ['src/content/field-key.js', 'src/content/recorder.js', 'src/content/trace.js']);
});

test('onQuotePage is false, manual fill is refused with a notice, and runAssist does nothing on a recon carrier', async () => {
  const bhhc = carrierForUrl('https://portal.bhhomestate.com/breeze');
  assert.ok(bhhc);

  // Even if autoFillUrl were null on a recon carrier, onQuotePage must still be false.
  const onQuoteMatch = PANEL_SOURCE.match(/const onQuotePage = \(\) => [^\n]+;/);
  assert.ok(onQuoteMatch, 'found onQuotePage');
  const qState = { tab: { id: 1, url: 'https://portal.bhhomestate.com/breeze', carrier: { ...bhhc, autoFillUrl: null } } };
  const qSandbox = vm.createContext({ state: qState });
  vm.runInContext(`${onQuoteMatch[0]}\nglobalThis.onQuotePage = onQuotePage;`, qSandbox);
  assert.equal(qSandbox.onQuotePage(), false, 'onQuotePage is false for recon even without autoFillUrl');
  qState.tab.carrier = { ...bhhc, recon: false, autoFillUrl: null };
  assert.equal(qSandbox.onQuotePage(), true, 'onQuotePage is true for non-recon without autoFillUrl');

  // Manual fill is refused with a visible notice and never starts a fill; auto fill returns silently.
  /** @type {any[]} */
  const problems = [];
  let kitCalled = false;
  const fState = {
    intake: { record: sampleRecord },
    tab: { id: 5, url: 'https://portal.bhhomestate.com/breeze', carrier: bhhc },
    filling: false,
    closing: false,
    resetting: false,
    newQuoteFailed: false,
    autoPaused: false,
  };
  const fSandbox = vm.createContext({
    state: fState,
    pageOf: () => '/breeze',
    fillProblem: (ctx, msg, tone) => problems.push({ ctx, msg, tone }),
    stopNoteFor: () => null,
    stateIssue: () => null,
    defaultsHold: () => false,
    quoteOwnerIssue: () => null,
    portalHold: () => false,
    onQuotePage: () => true,
    pickListItem: () => { kitCalled = true; },
  });
  vm.runInContext(extractFunction('fillPage'), fSandbox);
  await fSandbox.fillPage();
  assert.equal(kitCalled, false);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].tone, 'notice');
  assert.match(problems[0].msg, /BHHC.*fills nothing/i);

  await fSandbox.fillPage({ auto: 'page' });
  assert.equal(problems.length, 1, 'auto fill refuses silently without adding a notice');

  // runAssist does nothing on a recon carrier.
  let aiChecked = false;
  const aSandbox = vm.createContext({
    state: { intake: { record: sampleRecord }, tab: { id: 5, url: 'https://portal.bhhomestate.com/breeze', carrier: bhhc }, active: {} },
    usage: { currentSession: () => null },
    assistContextKey: () => { aiChecked = true; return 'k'; },
    aiSettings: async () => { aiChecked = true; return { on: true, ready: true }; },
  });
  vm.runInContext(extractFunction('runAssist'), aSandbox);
  await aSandbox.runAssist([], { tabId: 5, page: '/breeze', carrier: bhhc });
  assert.equal(aiChecked, false, 'runAssist exits before touching AI settings or context');
});

test('capturePage still runs on a recon carrier', async () => {
  const bhhc = carrierForUrl('https://portal.bhhomestate.com/breeze');
  assert.ok(bhhc);
  let kitRuns = 0;
  let downloaded = null;
  const state = {
    intake: { record: sampleRecord },
    tab: { id: 12, url: 'https://portal.bhhomestate.com/breeze', carrier: bhhc },
    active: { vehicles: 0, drivers: 0, trailers: 0 },
    intakeRevision: 1,
    captureStatus: '',
  };
  const sandbox = vm.createContext({
    state,
    redactor: () => (s) => s,
    redactionTerms: () => [],
    $: () => ({ value: 'recon-walk' }),
    usage: { currentSession: () => ({ id: 'abcd1234' }) },
    pageOf: () => '/breeze',
    viewOf: () => 't1',
    planFor: (rec, c, active) => buildPlan(rec, c, active),
    runKit: async () => {
      kitRuns += 1;
      return [{ result: { isTopFrame: true, page: '/breeze', step: null, controls: [{ label: 'DOT' }], messages: [], openLists: [] } }];
    },
    nextCaptureNumber: async () => 1,
    captureSaid: (t) => { state.captureStatus = t; },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
    Blob,
    document: { createElement: () => ({ click() { downloaded = this.download; } }) },
    setTimeout: () => 0,
  });
  vm.runInContext(extractFunction('capturePage'), sandbox);
  const file = await sandbox.capturePage();
  assert.equal(kitRuns, 1, 'capturePage invokes runKit on a recon carrier');
  assert.ok(file && file.startsWith('capture-bhhc-'), `expected capture-bhhc-* filename, got ${file}`);
  assert.equal(downloaded, file);
});
