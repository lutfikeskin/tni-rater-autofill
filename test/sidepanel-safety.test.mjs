import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assistContextKey, stableJson, neverReason, pageAnswers } from '../src/ai/common.js';
import { DEFAULT_MODEL, POLICY_VERSION } from '../src/ai/luna.js';
import { fillEvents, sha256Hex, knownStep } from '../src/usage.js';
import { unitToAdd, unitListSpecs, unitMissing, unitMissingItem, advanceFor } from '../src/units.js';
import { buildPlan } from '../src/plan.js';
import { intakeNotes } from '../src/normalize.js';
import { amwins } from '../src/carriers/amwins.js';
import { geico } from '../src/carriers/geico.js';
import { progressive } from '../src/carriers/progressive.js';
import { quoteProgress, stopScreen } from '../src/carriers.js';
import { quotedCarrierPolicy } from '../src/util.js';
import { SECTIONS, fieldInfo } from '../src/schema.js';


const SIDEPANEL = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');
// Layout scheduling has its own tests (layoutHarness); others only need it to exist.
const LAYOUT_STUB = '\nfunction scheduleLayout() {}';

// Most tests take single functions out of the panel's script, and some only match its text: the
// whole script must still parse (a stray line break in a string once passed them all).
test('the panel script parses', () => {
  const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('../sidepanel/sidepanel.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

// $(id) finds the first: an icon named like its button once took the button's clicks.
test('every id in the panel\'s page is used once', () => {
  const html = fs.readFileSync(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('AI accept refuses a suggestion for a previous driver, vehicle or intake', async () => {
  const record = { vehicles: [{ value: 34000 }, { value: 36000 }] };
  const active = { drivers: 0, vehicles: 0 };
  const ctx = { tabId: 1, page: '/quote', contextKey: assistContextKey(record, active) };
  let writes = 0;
  const state = { filling: false, tab: { id: 1, url: 'https://example.test/quote' }, intake: { record }, active };
  const sandbox = { state, assistContextKey, pageOf: url => new URL(url).pathname, tellRecorder: () => { writes++; } };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('applyAi'), sandbox);
  state.active = { ...active, vehicles: 1 };
  assert.equal(await sandbox.applyAi([], ctx, 'accepted'), false);
  state.active = { ...active, drivers: 1 };
  assert.equal(await sandbox.applyAi([], ctx, 'accepted'), false);
  state.active = active;
  record.vehicles[0].value = 50000;
  assert.equal(await sandbox.applyAi([], ctx, 'accepted'), false);
  assert.equal(writes, 0, 'stale choices never reach the page');
});

// Keep these tests coupled to the production functions.  The side panel is an ES module with
// browser-only imports, so extract only the functions under test and evaluate those functions in
// a small VM harness instead of copying their implementation into a test helper.
function extractFunction(name) {
  const match = SIDEPANEL.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(match, `could not find ${name} in sidepanel/sidepanel.js`);
  const start = match.index;
  const params = SIDEPANEL.indexOf('(', start);
  let parameterDepth = 1, parameterEnd = params + 1;
  for (; parameterDepth && parameterEnd < SIDEPANEL.length; parameterEnd++) {
    if (SIDEPANEL[parameterEnd] === '(') parameterDepth++;
    if (SIDEPANEL[parameterEnd] === ')') parameterDepth--;
  }
  const open = SIDEPANEL.indexOf('{', parameterEnd);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < SIDEPANEL.length; i += 1) {
    const ch = SIDEPANEL[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && SIDEPANEL[i + 1] === '/') {
      i = SIDEPANEL.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (ch === '/' && SIDEPANEL[i + 1] === '*') {
      i = SIDEPANEL.indexOf('*/', i + 2) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (!depth) {
        let source = SIDEPANEL.slice(start, i + 1);
        if (name !== 'persistGuardedEdits' && /\bpersistGuardedEdits\(/.test(source)) source += `\n${extractFunction('persistGuardedEdits')}`;
        // Agent-edit scoping is shared by many functions: bring its helpers along.
        if (name !== 'agentEdited' && /\bagentEdited\(/.test(source)) source += `\n${extractFunction('agentEdited')}`;
        // So are a fill's context and its tab's maps (fillContext, rememberFill), and the tab's
        // step with the stops it may carry (tabStep, stopNoteFor: GEICO's stop steps), and the agent's
        // keys a fill leaves alone (fillSkip, fillSkipBy, formScoped: GEICO's per step and form) or
        // an edit is filed under (changeScopes, unitScope: GEICO's by the forms on screen). The
        // panel's cards and row heads (issueCard, setRowHead) come along as they are.
        for (const helper of ['finishLeftOk', 'itemsLeft', 'tabMaps', 'fillContext', 'staleFill', 'fillCurrent', 'noteStaleFill', 'logFill', 'fillErrorText', 'fillErrorMessage', 'logFillError', 'stepOfResults', 'tabStep', 'stopNoteFor', 'fillSkip', 'fillSkipBy', 'formScoped', 'changeScopes', 'unitScope', 'issueCard', 'setRowHead', 'answerSources', 'groupRows', 'choicesOf', 'pdfAvailable', 'scrollBehavior', 'pageMoved', 'notePageMoved', 'firstUnits', 'finishingAction']) {
          if (name !== helper && new RegExp(`\\b${helper}\\(`).test(source) && !new RegExp(`function ${helper}\\(`).test(source)) source += `\n${extractFunction(helper)}`;
        }
        // The quote-state hold (stateIssue) has its own tests: elsewhere no state differs, unless
        // the harness gives one.
        if (name !== 'stateIssue' && /\bstateIssue\(/.test(source) && !/function stateIssue\(/.test(source)) source += '\nvar stateIssue = globalThis.stateIssue ?? (() => null);';
        // Reports kept for a reopened panel (keepReport, forgetKeptReports) have their own tests:
        // elsewhere nothing is kept, unless the harness gives a store. So has the agent's change
        // after the quote's finishing action (noteChangedAfterDone): elsewhere nothing is marked. And
        // the chime when the quote is done (noteQuoteDone): elsewhere nothing sounds.
        for (const kept of ['keepReport', 'forgetKeptReports', 'noteChangedAfterDone', 'noteQuoteDone']) {
          if (name !== kept && new RegExp(`\\b${kept}\\(`).test(source) && !new RegExp(`function ${kept}\\(`).test(source)) source += `\nvar ${kept} = globalThis.${kept} ?? (() => {});`;
        }
        return name !== 'editScope' && /\beditScope\(/.test(source) ? `${source}\n${extractFunction('editScope')}` : name !== 'stepScope' && /\bstepScope\(/.test(source) && name === 'editScope' ? `${source}\n${extractFunction('stepScope')}` : source;
      }
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const HELPERS_START = SIDEPANEL.indexOf('const samePage =');
const HELPERS_END = SIDEPANEL.indexOf('\n\n// Watch the rater tab', HELPERS_START);
const PAGE_HELPERS = SIDEPANEL.slice(HELPERS_START, HELPERS_END);
const FUNCTIONS = ['rememberFill', 'scheduleAutoFill', 'tabInView', 'refreshTab', 'quoteFinished'].map(extractFunction).join('\n') + LAYOUT_STUB;

function harness() {
  const state = {
    tab: null,
    filled: new Map(),
    labels: new Map(),
    choices: new Map(),
    autoPages: new Set(),
    tabSessions: new Map(),
    agentKeys: new Map(),
    filling: false,
    autoTimer: null,
    autoPending: false,
    autoPaused: false,
    doneActions: new Set(),
    visitedPages: new Set(),
  };
  const ui = { 'auto-followups': { checked: true } };
  const scheduled = [];
  const cleared = [];
  const rendered = [];
  let timerId = 0;
  let activeTab = null;
  const openTabs = new Map();

  const context = {
    URL,
    state,
    inExtension: true,
    $: (id) => ui[id],
    onQuotePage: () => true,
    setTimeout: (fn, ms) => {
      const handle = { id: ++timerId };
      scheduled.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout: (handle) => cleared.push(handle),
    renderSite: () => rendered.push(state.tab?.id ?? null), renderPickers: () => {}, save: () => {},
    ensureRecorder: async () => {}, retireAiOrigins: async () => {}, restoreAgentKeys: async () => {}, persistAgentKeys: async () => {}, restoreDoneActions: async () => {}, persistDoneActions: async () => {}, restoreReports: async () => {},
    seedQuoteState: () => {}, noteQuoteState: () => {}, knownStep, popped: false,
    dropReports() {}, clientNote() {}, fillProblem() {}, answeredOnPage() {},
    pendingAi: () => [],
    carrierForUrl: (url) => (/foragentsonly/.test(url) ? { id: 'progressive', practice: false } : null),
    chrome: {
      scripting: {},
      tabs: { query: async () => [activeTab], get: async (id) => (openTabs.get(id) ?? Promise.reject(new Error('No tab'))) },
    },
  };
  vm.runInNewContext(`${PAGE_HELPERS}\n${FUNCTIONS}`, context, { filename: 'sidepanel/sidepanel.js' });

  return {
    state,
    context,
    ui,
    scheduled,
    cleared,
    rendered,
    refreshTab: context.refreshTab,
    rememberFill: context.rememberFill,
    scheduleAutoFill: context.scheduleAutoFill,
    setActiveTab(tab) { activeTab = tab; },
    openTab(tab) { openTabs.set(tab.id, tab); },
  };
}

const quoteTab = (id, page = 'AddVehicle') => ({
  id,
  url: `https://clpolicy.foragentsonly.com/Express/Default.aspx?pageName=${page}`,
});

test('a halted fill persists the pause, clears pending work, and protects keys', () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  h.state.agentKeys.set('AddVehicle', new Set(['agent-edited']));
  h.state.autoTimer = { id: 'pending-followup' };
  h.state.autoPending = true;

  h.rememberFill([{
    fields: 2,
    halted: true,
    reason: 'Unknown relevant question',
    protectedKeys: ['newly-revealed'],
    filled: [],
    actions: [],
  }]);

  assert.equal(h.state.autoPaused, true);
  assert.equal(h.state.autoPending, false);
  assert.deepEqual([...h.state.agentKeys.get('AddVehicle')].sort(), ['agent-edited', 'newly-revealed']);
  assert.deepEqual(h.cleared, [{ id: 'pending-followup' }]);

  h.scheduleAutoFill('AddVehicle');
  assert.equal(h.scheduled.length, 0, 'a paused session must not schedule another follow-up');
});

test('a rejected automatic choice keeps blocking until manual change or explicit confirmation', () => {
  const sig = '1\nQuote\ngpt-6-luna\nluna-v1\ncontext\nitem';
  const state = { aiCache: new Map([[sig, { done: 'auto', rejected: true, key: 'optional-choice' }]]) };
  const context = { state, aiDecisionBlocks: undefined };
  vm.runInNewContext(`${extractFunction('aiDecisionBlocks')}\n${extractFunction('pendingAi')}`, context);
  assert.equal(context.pendingAi(1, 'Quote').length, 1, 'rejection remains a continuation blocker');
  state.aiCache.get(sig).manual = true;
  assert.equal(context.pendingAi(1, 'Quote').length, 0, 'a manual field change releases the blocker');
  state.aiCache.get(sig).manual = false;
  state.aiCache.get(sig).confirmed = true;
  assert.equal(context.pendingAi(1, 'Quote').length, 0, 'explicit confirmation releases the blocker');
});

test('a persisted manual correction is protected after the panel reloads', () => {
  const sig = '1\nQuote\ngpt-6-luna\nluna-v1\ncontext\nitem';
  const state = { aiCache: new Map([[sig, { key: 'optional-choice', manual: true }]]) };
  const context = { state };
  vm.runInNewContext(`${extractFunction('aiDecisionBlocks')}\n${extractFunction('aiSettledOnPage')}`, context);
  assert.equal(context.aiSettledOnPage(1, 'Quote', { key: 'optional-choice', current: 'Yes' }), true);
  assert.equal(context.aiSettledOnPage(1, 'Quote', { key: 'other-choice', current: 'Yes' }), false);
  state.aiCache.set(`${sig}-pending`, { key: 'pending-choice', done: 'auto', approved: false, manual: false, confirmed: false });
  assert.equal(context.aiSettledOnPage(1, 'Quote', { key: 'pending-choice', current: '' }), true, 'a pending answer is not re-asked after reload');
});

test('invalidated actions are removed before newly successful actions are recorded', () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  h.state.doneActions = new Set(['stale-lookup', 'keep-me']);

  h.rememberFill([{
    fields: 1,
    filled: [],
    invalidatedActions: ['stale-lookup'],
    actions: [{ id: 'fresh-lookup' }],
  }]);

  assert.deepEqual([...h.state.doneActions].sort(), ['fresh-lookup', 'keep-me']);
});

test('combo choices from every fill are kept per tab, for the usage log', async () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  h.rememberFill([{ filled: [], choices: [['2C1A', ['Transit 150', 'Transit 250']]] }]);
  // A searched combo lists other options on the next fill; the earlier ones are still options.
  h.rememberFill([{ filled: [], choices: [['2C1A', ['Transit 350']], ['2C1B', ['Yes', 'No']]] }]);
  assert.deepEqual([...h.state.choices.get('2C1A')], ['Transit 150', 'Transit 250', 'Transit 350']);
  assert.deepEqual([...h.state.choices.get('2C1B')], ['Yes', 'No']);

  h.setActiveTab(quoteTab(2));
  await h.refreshTab();
  assert.equal(h.state.choices.size, 0, 'another quote tab starts without them');
  h.setActiveTab(quoteTab(1));
  await h.refreshTab();
  assert.deepEqual([...h.state.choices.get('2C1A')], ['Transit 150', 'Transit 250', 'Transit 350']);
});

test('switching tabs stores and restores agent keys and the persistent pause', async () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'BusinessOwnerInfo'), carrier: { id: 'progressive' } };
  h.state.agentKeys = new Map([['BusinessOwnerInfo', new Set(['agent-key'])]]);
  h.state.autoPaused = true;
  h.state.autoPending = true;

  h.setActiveTab(quoteTab(2));
  await h.refreshTab();

  assert.equal(h.state.tab.id, 2);
  assert.equal(h.state.autoPaused, false, 'a newly visited tab starts unpaused');
  assert.equal(h.state.agentKeys.size, 0);
  assert.ok(h.state.tabSessions.has(1));
  assert.equal(h.state.tabSessions.get(1).autoPaused, true);
  assert.equal(h.state.tabSessions.get(1).agentKeys.get('BusinessOwnerInfo').has('agent-key'), true);

  const secondTabKeys = h.state.agentKeys;
  h.state.agentKeys.set('AddVehicle', new Set(['second-tab-key']));
  h.state.autoPaused = true;
  h.setActiveTab(quoteTab(1, 'BusinessOwnerInfo'));
  await h.refreshTab();

  assert.equal(h.state.tab.id, 1);
  assert.equal(h.state.autoPaused, true);
  assert.notEqual(h.state.agentKeys, secondTabKeys);
  assert.deepEqual([...h.state.agentKeys.get('BusinessOwnerInfo')], ['agent-key']);
  assert.equal(h.state.agentKeys.has('AddVehicle'), false);
});

// W43-37 (FL, 2026-10-22): a Progressive quote opened after a GEICO quote on its second driver
// filled Progressive's first driver form with the second driver's answers.
test('a quote tab the panel has no record for starts on vehicle 1 and driver 1; the reopened panel keeps its tab\'s', async () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  h.state.active = { drivers: 1, vehicles: 2, trailers: 0 };
  h.setActiveTab(quoteTab(2, 'AddDriver'));
  await h.refreshTab();
  assert.deepEqual({ ...h.state.active }, { drivers: 0, vehicles: 0, trailers: 0 });
  h.state.active.drivers = 1;
  h.setActiveTab(quoteTab(1));
  await h.refreshTab();
  assert.deepEqual({ ...h.state.active }, { drivers: 1, vehicles: 2, trailers: 0 }, 'its own tab keeps its selection');

  // The panel opened again: the selection saved is that tab's, and only that tab's.
  for (const [saved, front, drivers] of [[5, 5, 1], [4, 5, 0], [null, 5, 0]]) {
    const r = harness();
    r.state.active = { drivers: 1, vehicles: 0, trailers: 0 };
    r.state.activeTab = saved;
    r.setActiveTab(quoteTab(front, 'AddDriver'));
    await r.refreshTab();
    assert.equal(r.state.active.drivers, drivers, `saved for tab ${saved}`);
  }
});

test('the driver a form named is the one entered once the list comes back; a form for no intake driver marks none', () => {
  const progressive = { driverPage: 'AddDriver', driverList: 'DriverSummary' };
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'AddDriver'), carrier: progressive };
  h.state.active = { drivers: 1, vehicles: 0, trailers: 0 };
  h.rememberFill([{ filled: [], halted: true, reason: 'This form is for Jordan Sample, not Casey Example', unitNamed: { list: 'drivers', index: 0 } }], { page: 'AddDriver' });
  assert.deepEqual({ ...h.state.unitNamed }, { list: 'drivers', index: 0, page: 'AddDriver' });

  const context = { state: h.state, persistDoneActions: () => {} };
  vm.runInNewContext(extractFunction('unitArrival'), context);
  context.unitArrival(progressive, 'AddDriver', 'DriverSummary');
  assert.deepEqual([...h.state.doneActions], ['driverEntered:0'], 'the named driver, not the selected one');
  assert.equal(h.state.unitNamed, null);

  h.state.unitNamed = { list: 'drivers', index: null, page: 'AddDriver' };
  context.unitArrival(progressive, 'AddDriver', 'DriverSummary');
  assert.deepEqual([...h.state.doneActions], ['driverEntered:0'], 'no intake driver: none marked');
  // A blank form named no one: the selected driver, as before.
  context.unitArrival(progressive, 'AddDriver', 'DriverSummary');
  assert.deepEqual([...h.state.doneActions].sort(), ['driverEntered:0', 'driverEntered:1']);
});

test('the fill hands the kit the named-form check and what this tab\'s fills gave', () => {
  const context = {};
  vm.runInNewContext(`${extractFunction('unitNameFor')}\nglobalThis.unitNameFor = unitNameFor;`, context);
  const record = { drivers: [{ first: 'Jordan', last: 'Sample-Smith' }, { first: 'Casey', last: 'Example' }, { first: null, last: null }] };
  const spec = { unitNames: [{ page: 'AddDriver', list: 'drivers', text: '^questions about (.+)$' }] };
  assert.deepEqual(JSON.parse(JSON.stringify(context.unitNameFor(spec, 'AddDriver', { drivers: 1 }, record))), {
    list: 'drivers', text: '^questions about (.+)$', names: [['JORDAN', 'SAMPLE', 'SMITH'], ['CASEY', 'EXAMPLE'], []], active: 1, label: 'Casey Example',
  });
  assert.equal(context.unitNameFor(spec, 'BusinessOwnerInfo', { drivers: 1 }, record), null, 'another page');
  assert.equal(context.unitNameFor({}, 'AddDriver', { drivers: 1 }, record), null, 'a carrier whose forms name no one');
  assert.equal(context.unitNameFor(spec, 'AddDriver', { drivers: 2 }, record).label, 'the selected driver');
  assert.equal(progressive.unitNames[0].page, progressive.driverPage);
  assert.ok(new RegExp(progressive.unitNames[0].text, 'i').test('Questions about Jordan Sample'));

  const start = SIDEPANEL.indexOf('const fillOptions =');
  const body = SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start));
  assert.match(body, /formUnit: unitNameFor\(carrier, extra\.expectPage \?\? pageOf\(state\.tab\?\.url\), active, state\.intake\?\.record\)/);
  assert.match(body, /givenBefore: Object\.fromEntries\(\[\.\.\.\(state\.filled \?\? \[\]\)\]\.map\(\(\[key, x\]\) => \[key, \{ path: x\.path \?\? null, shown: x\.shown \?\? null \}\]\)\)/);
});


// renderReport's sandbox: the page's list (its box), putReport keeping the report for its page (here:
// showing it), and the rows built as the panel builds them (answerRow, needRow, agentPickable).
function reportHarness(state, extra = {}) {
  const box = { className: '', children: [], replaceChildren(...children) { this.children = children; } };
  const context = {
    $: () => box, knownStep, renderSteps() {}, announce() {}, refreshAnswers() {}, currentReportKey: () => null,
    state, pageOf: (url) => url, neverReason, sourcePlace: () => null, fieldInfo: (path) => ({ label: path }), get: () => undefined,
    h: (tag, props, ...children) => ({ tag, props, children }),
    reportKey: (tabId, page) => `${tabId}|${page}`,
    putReport(entry, nodes) { box.replaceChildren(...nodes); state.reportFor = entry; },
    ...extra,
  };
  vm.runInNewContext(['renderReport', 'answerRow', 'needRow', 'agentPickable', 'choiceSaid', 'choiceList', 'pdfPageSaid'].map(extractFunction).join('\n'), context);
  return { context, box };
}
// Every node under `node` (children and arrays of them), for finding buttons and text.
const nodesIn = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => nodesIn(n, out));
  else if (node && typeof node === 'object') { out.push(node); nodesIn(node.children, out); }
  return out;
};
// What an opened row says its source is ("Intake, page 2").
const srcTitle = (row) => nodesIn(row).find((n) => n.props?.class === 'src-title')?.children[0] ?? null;
// The report's list of answers and items, in order.
const rowsOf = (box) => nodesIn(box.children.find((n) => n?.props?.class === 'rows')?.children ?? []).filter((n) => /^row(\s|$)/.test(n.props?.class ?? ''));
// A row as the agent reads it: its label, what it says, its source tag (none for an intake answer,
// whose source is said only to screen readers: `quiet`), and whether it needs them.
const rowSaid = (row) => {
  const head = row.children.find((n) => n?.props?.class === 'row-head');
  const text = head.children.find((n) => n?.props?.class === 'row-text');
  const tag = head.children.find((n) => /^tag\b/.test(n?.props?.class ?? ''));
  const quiet = head.children.find((n) => n?.props?.class === 'sr-only');
  return { label: text.children[0].children[0], value: text.children[1].children[0], tag: tag ? tag.children[0] : null, quiet: quiet ? quiet.children[0] : null, need: /\bneed\b/.test(row.props.class) };
};

test('fill report omits absent sections without rendering null text', () => {
  const { context, box } = reportHarness({ tab: { id: 1, url: 'https://example.test/?pageName=AddVehicle' } }, { pageOf: () => 'AddVehicle' });
  context.renderReport([{ fields: 1, filled: [{ label: 'Zip Code', shown: '21000' }], kept: [], failed: [], noData: [], leftRequired: [], actions: [] }]);
  assert.ok(box.children.length > 0);
  assert.ok(box.children.every((child) => child != null && child !== false), 'DOM replaceChildren must receive only actual report nodes');
  assert.deepEqual(rowsOf(box).map(rowSaid).map((r) => [r.label, r.value]), [['Zip Code', '21000']]);
});

// W43-32 (TNI, 2026-10-21): GEICO without 11 Payments; the fill picked the plan with the most payments
// offered (pagekit `orMost`). Said above the list, and nothing is left for the agent by it.
test('fill report names an answer picked in place of one the page does not offer', () => {
  const { context, box } = reportHarness({ tab: { id: 1, url: '/quote' } }, { pageOf: () => '/quote' });
  const said = 'The page doesn\'t offer "11 Payments" here: the fill picked "9 Payments", the plan with the most payments GEICO offers.';
  context.renderReport([{ fields: 2, filled: [{ label: 'give pay plan v2', shown: '9 Payments', standard: true, said }, { label: 'Liability Coverage', shown: 'Bodily Injury and Property Damage Liability' }],
    kept: [], failed: [], noData: [], leftRequired: [], actions: [{ id: 'printProposal', text: 'Print Quote Proposal' }] }]);
  const lines = box.children.filter((n) => n?.props?.class === 'note-line said');
  assert.deepEqual(lines.map((n) => n.children[0]), [said]);
  assert.ok(box.children.indexOf(lines[0]) < box.children.findIndex((n) => n?.props?.class === 'rows'), 'above the list');
  assert.equal(context.state.reportFor.left, 0);
});

// FL live run, 2026-10-07: "See what was filled always shows 0". A follow-up pass finds the
// answers an earlier pass filled already there; they're still ours, counted and shown as filled.
test('fill report counts answers an earlier pass on the page filled', () => {
  const state = { tab: { id: 1, url: 'https://example.test/?pageName=AddVehicle' }, filled: new Map([['ref:RiskInput.VIN', { path: 'vehicles[0].vin', shown: '1FTBR3X87MKA12345' }]]) };
  const { context, box } = reportHarness(state, { pageOf: () => 'AddVehicle' });
  context.renderReport([{ fields: 3, filled: [], failed: [], noData: [], leftRequired: [], actions: [],
    kept: [{ label: 'VIN', key: 'ref:RiskInput.VIN' }, { label: 'Annual Mileage', key: 'ref:RiskInput.AnnualMileage' }] }]);
  assert.equal(context.state.reportFor.filled, 1, 'step 2 counts what we filled');
  assert.deepEqual(rowsOf(box).map(rowSaid).map((r) => [r.label, r.value, r.tag]), [
    ['VIN', '1FTBR3X87MKA12345', null],
    ['Annual Mileage', 'left as the page had it', 'On the page'],
  ], 'a value the page had itself is still said so');
});

// Codex on c31942e: a TNI standard keeps its tag when an earlier pass filled it or the page
// already had it (kept), not only when this pass filled it.
test('fill report tags standards that an earlier pass filled or the page already had', () => {
  const state = { tab: { id: 1, url: 'https://example.test/?pageName=AddDriver' }, filled: new Map([['earlier-std', { path: null, shown: 'No', standard: true }], ['earlier-intake', { path: 'drivers[0].first', shown: 'Test' }]]) };
  const { context, box } = reportHarness(state, { pageOf: () => 'AddDriver' });
  context.renderReport([{ fields: 4, filled: [], failed: [], noData: [], leftRequired: [], actions: [],
    kept: [{ label: 'Defensive driver', key: 'earlier-std' }, { label: 'First name', key: 'earlier-intake' },
      { label: 'Waiver', key: 'page-std', standard: true }, { label: 'Middle', key: 'page-intake' }] }]);
  assert.deepEqual(rowsOf(box).map(rowSaid).map((r) => [r.label, r.tag]), [
    ['Defensive driver', 'TNI standard'], ['First name', null], ['Waiver', 'TNI standard'], ['Middle', 'On the page']]);
});

// PR #72 audit: the AmWINS gender the agent chose (Use Female / Keep Male, or client details) was
// listed as from the intake. An answer filled from a field the agent set is theirs: Your edit. One
// worked out from intake answers says so; a TNI standard stays a standard.
test('fill report tags answers filled from the agent\'s edits as theirs, and worked-out ones as such', () => {
  const state = { tab: { id: 1, url: 'https://example.test/?pageName=Drivers' }, intake: { agentEdited: ['drivers[0].gender', 'applicant.yearsInBusiness'], record: {} } };
  const { context, box } = reportHarness(state, { pageOf: () => 'Drivers' });
  context.renderReport([{ fields: 5, kept: [], failed: [], noData: [], leftRequired: [], actions: [],
    filled: [{ label: 'First name', shown: 'Ann', path: 'drivers[0].first', stepId: 's1' },
      { label: 'Gender', shown: 'FEMALE', stepId: 's2' },
      { label: 'Years in business', shown: '3', path: 'applicant.yearsInBusiness', stepId: 's3' },
      { label: 'Year licensed', shown: '1997', stepId: 's4', standard: true },
      { label: 'Radius', shown: '300', stepId: 's5' }] }],
  { plan: [{ id: 's2', from: ['drivers[0].gender'] }, { id: 's4', from: ['drivers[0].dob'] }, { id: 's5', from: ['operations.radius'] }] });
  assert.deepEqual(rowsOf(box).map(rowSaid).map((r) => [r.label, r.tag]), [
    ['First name', null], ['Gender', 'Your edit'], ['Years in business', 'Your edit'], ['Year licensed', 'TNI standard'], ['Radius', 'Worked out']]);
});

// Live review 2026-10-09: 38 filled rows pushed what was left off screen, so the old list showed six.
// v5 lists every answer and item in one list, in the page order of their fields, each with its
// source; the filters and the dock's Show the next one find what needs the agent.
test('fill report lists every answer and item in the page order of their fields, the first item open', () => {
  const { context, box } = reportHarness({ tab: { id: 1, url: 'Quote' } });
  context.renderReport([{ fields: 10, kept: [], failed: [], noData: [], leftRequired: [], actions: [{ id: 'addNtl', text: 'Add NTL' }],
    filled: Array.from({ length: 9 }, (_, i) => ({ label: `Q${i}`, key: `k${i}`, shown: 'x', order: i * 2 })),
    unknown: [{ key: 'u', label: 'Unfamiliar', order: 5 }] }]);
  const rows = rowsOf(box);
  assert.deepEqual(rows.map(rowSaid).map((r) => r.label), ['Q0', 'Q1', 'Q2', 'Unfamiliar', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8', 'Clicked']);
  assert.deepEqual(rows.map(rowSaid).filter((r) => !r.need).map((r) => r.tag), [...Array(9).fill(null), 'Clicked']);
  assert.deepEqual(rows.map(rowSaid).filter((r) => !r.need && !r.tag).map((r) => r.quiet), Array(9).fill('From the intake'),
    'an intake answer has no tag to read past, and says where it came from to screen readers');
  assert.equal(context.state.reportFor.filled, 9);
  assert.deepEqual(rows.filter((r) => /\bopen\b/.test(r.props.class)).map((r) => rowSaid(r).label), ['Unfamiliar'], 'the first item starts open');
});

// Live run 2026-10-09: AmWINS' auto symbol showed as nine rows ("1 standard unchecked", …). One
// question asked as several boxes is one row: the question and the boxes ticked, counted once.
test('fill report lists a question asked as several boxes once, with the boxes ticked', () => {
  const { context, box } = reportHarness({ tab: { id: 1, url: 'Quote' } });
  const boxes = [1, 2, 6, 9].map((n, i) => ({ stepId: i, label: String(n), key: `s${n}`, shown: n === 6 ? 'checked' : 'unchecked', standard: true }));
  context.renderReport([{ fields: 6, kept: [], failed: [], noData: [], leftRequired: [], actions: [],
    // An earlier step's field, filled again while hidden (pagekit otherStep): not this step's.
    filled: [{ stepId: 9, label: 'Medical payment', key: 'm', shown: '$5,000', standard: true }, ...boxes, { stepId: 8, label: '', name: 'Prior carrier 1', key: 'p', shown: 'NO PRIOR', otherStep: true }] }],
  { plan: [0, 1, 2, 3].map((id) => ({ id, group: 'Liability coverage auto symbol', value: id === 2 })) });
  assert.deepEqual(rowsOf(box).map(rowSaid).map((r) => [r.label, r.value, r.tag]), [
    ['Medical payment', '$5,000', 'TNI standard'], ['Liability coverage auto symbol', '6', 'TNI standard']]);
  assert.equal(context.state.reportFor.filled, 2);
});

// Answers on this page, opened: each filled answer is read back from the page (pagekit readBack,
// read-only). One the page shows differently now says what it shows; spacing and punctuation
// aside, and one whose field isn't on the page now is left alone. Only for the page in front.
test('answers on this page mark an answer the page shows differently now', async () => {
  const row = (key, field, value, step = '') => {
    const r = { dataset: { key, field, value, step }, changed: false, now: { hidden: true, textContent: '' } };
    r.classList = { toggle: (name, on) => { r.changed = on; }, contains: () => r.changed };
    r.querySelector = () => r.now;
    return r;
  };
  const rows = [row('phone', 'Phone', '(312) 555-0100'), row('limit', 'Limit', '$1,000,000'), row('box', 'Box', 'checked'), row('gone', 'Gone', 'x'), row('off', 'Off', 'unchecked'), row('text', 'Text', 'Main St'),
    // The Google suggestion picked; the page then keeps the street only (the kit says it agrees).
    row('addr', 'Address', '5001 Sheridan Street Davenport, IA, USA', '7')];
  const asked = [];
  const selectors = [];
  const body = { querySelectorAll: (sel) => { selectors.push(sel); return rows; } };
  const said = [];
  const context = {
    state: { tab: { id: 1, url: 'Quote' } }, pageOf: (url) => url, announce: (text) => said.push(text),
    runKit: async (tabId, carrier, fn, args) => {
      asked.push(JSON.parse(JSON.stringify(args)));
      return [{ result: [{ key: 'phone', label: 'Phone', shown: '3125550100', empty: false }, { key: 'limit', label: 'Limit', shown: '$500,000', empty: false }] },
        { result: [{ key: 'box', label: 'Box', shown: 'unchecked', empty: true }, { key: 'off', label: 'Off', shown: 'unchecked', empty: true },
          { key: 'text', label: 'Text', shown: '', empty: true }, { key: 'addr', label: 'Address', shown: '5001 Sheridan St', empty: false, agrees: true }] }];
    },
  };
  vm.runInNewContext(extractFunction('checkAnswers'), context);
  const plan = [{ id: 7, kind: 'address-suggest', value: '5001 Sheridan Street Davenport, IA, USA' }, { id: 8, kind: 'text', value: 'other' }];
  await context.checkAnswers(body, 1, 'Quote', { id: 'progressive' }, plan);
  assert.deepEqual(asked[0][0].map((x) => x.key), ['phone', 'limit', 'box', 'gone', 'off', 'text', 'addr']);
  assert.deepEqual(asked[0][1].map((s) => s.id), [7], 'only the steps of the rows asked about');
  assert.equal(rows[6].changed, false, 'an address the page wrote its own way is the same answer');
  assert.equal(rows[0].changed, false, 'the page formatting a phone number is the same answer');
  assert.equal(rows[1].changed, true);
  assert.equal(rows[1].now.textContent, 'Now on the page: $500,000');
  assert.equal(rows[2].now.textContent, 'Now on the page: unchecked');
  assert.equal(rows[4].changed, false, 'a box we left unticked is still our answer');
  assert.equal(rows[5].now.textContent, 'Now on the page: empty', 'a box the page cleared');
  assert.equal(rows[3].changed, false, 'not on the page now: left alone');
  assert.deepEqual(selectors, ['.row:not(.need)[data-key]'], 'the answers that went in, not the items left');
  assert.deepEqual(said, ['3 answers on the page changed since the fill.']);
  // Opened again once the agent put it back: no longer said changed.
  context.runKit = async () => [{ result: [{ key: 'limit', label: 'Limit', shown: '$1,000,000', empty: false }] }];
  await context.checkAnswers(body, 1, 'Quote', { id: 'progressive' });
  assert.equal(rows[1].changed, false);
  assert.equal(rows[1].now.hidden, true);
  assert.deepEqual(said.at(-1), '2 answers on the page changed since the fill.', 'the box and the box cleared: not read again');
  // Another page in front: nothing read.
  context.state.tab.url = 'Drivers';
  context.runKit = async () => assert.fail('reads only the page in front');
  await context.checkAnswers(body, 1, 'Quote', { id: 'progressive' });
});

// A derived answer (plan.js `from`) links to the intake answers it was worked out from; a TNI
// standard is tagged, never linked; nothing links while the PDF isn't kept.
test('fill report links each answer to its source on the intake PDF', () => {
  const places = { fields: { dot_number: { page: 0, rect: [74, 681, 162, 695] }, company_name: { page: 0, rect: [10, 10, 20, 20] } } };
  const state = { tab: { id: 1, url: 'Quote' }, intake: { places, rows: {}, pdfKept: true } };
  const opened = [];
  const { context, box } = reportHarness(state, { sourcePlace: (paths) => ([].concat(paths).includes('applicant.dot') ? { page: 0, rect: [0, 0, 1, 1] } : null),
    openPdf: (target) => opened.push(target) });
  const frame = { fields: 3, kept: [], failed: [], noData: [], leftRequired: [], actions: [], filled: [
    { stepId: 0, label: 'DOT number', path: 'amwins.q4', shown: '1234567' },
    { stepId: 1, label: 'Company', path: 'applicant.name', shown: 'X' },
    { stepId: 2, label: 'Waiver', path: 'amwins.q9', shown: 'NONE', standard: true }] };
  context.renderReport([frame], { plan: [{ id: 0, from: ['applicant.dot'] }] });
  const links = () => rowsOf(box).map((row) => nodesIn(row).find((n) => /\bsrc\b/.test(n.props?.class ?? '') && n.tag === 'button') ?? null);
  assert.equal(links()[0].children[0], 'See in intake');
  assert.deepEqual(rowsOf(box).map(rowSaid).map((r) => r.tag), ['Worked out', null, 'TNI standard'], 'an intake answer: no tag');
  assert.equal(srcTitle(rowsOf(box)[1]), 'Intake', 'a one-page intake: no page number');
  links()[0].props.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ path: 'amwins.q4', from: ['applicant.dot'], label: 'DOT number', kind: 'filled' }]);
  assert.equal(links()[1], null, 'a path the PDF has no field for: no link');
  assert.equal(links()[2], null, 'a standard: tagged, no link');
  // An intake answer the PDF has a field for, on an intake of several pages: which page.
  context.sourcePlace = (paths) => ({ page: [].concat(paths).includes('applicant.dot') ? 0 : 1, rect: [0, 0, 1, 1] });
  state.intake.places.pages = [{}, {}];
  context.renderReport([frame], { plan: [{ id: 0, from: ['applicant.dot'] }] });
  assert.equal(srcTitle(rowsOf(box)[1]), 'Intake, page 2', 'several pages: which one, once the row opens');
  assert.ok(links()[1], 'linked once the PDF has its field');
  state.intake.pdfKept = false;
  context.renderReport([frame], { plan: [{ id: 0, from: ['applicant.dot'] }] });
  assert.deepEqual(links(), [null, null, null], 'no PDF kept: no link');
  assert.equal(srcTitle(rowsOf(box)[1]), 'Intake', 'nor a page');
});

// FL live run, 2026-10-07: the cargo commodity list has no caption, and the panel showed a
// failure with no name. Such a field is named after its rule.
test('fill report names a field without a caption after its rule', () => {
  const { context, box } = reportHarness({ tab: { id: 1, url: 'https://example.test/?pageName=CoveragesRates' } }, { pageOf: () => 'CoveragesRates' });
  context.renderReport([{ fields: 2, kept: [], noData: [], leftRequired: [], actions: [],
    filled: [{ label: '', name: 'Cargo commodity category', key: 'a', shown: 'Consumer Goods' }],
    failed: [{ label: '', name: 'Cargo commodity', key: 'b', reason: 'no option matches' }] }]);
  assert.deepEqual(rowsOf(box).map(rowSaid).map((r) => [r.label, r.need]), [['Cargo commodity', true], ['Cargo commodity category', false]],
    'the failure is named, and so is the answer');
});

// Fable on PR #43: a page the carrier changed (a known field renamed, most questions unfamiliar)
// says so at the top of the report.
test('fill report says when the carrier seems to have changed the page', () => {
  const { context, box } = reportHarness({ tab: { id: 1, url: 'https://example.test/?pageName=BusinessOwnerInfo', carrier: { name: 'Progressive' } } }, { pageOf: () => 'BusinessOwnerInfo' });
  const frame = { fields: 8, filled: [], kept: [], failed: [], noData: [], leftRequired: [], actions: [], unknown: Array.from({ length: 5 }, (_, i) => ({ label: `Q${i}`, key: `k${i}` })), renamed: [{ name: 'Business / sole proprietor name' }], pageChanged: true };
  context.renderReport([frame]);
  const alarmIn = () => box.children.find((c) => /^issue\b/.test(c?.props?.class ?? '') && nodesIn(c).some((n) => n.props?.class === 'issue-title' && n.children[0] === 'This page seems to have changed'));
  const alarm = alarmIn();
  assert.ok(alarm, 'the alarm is shown');
  assert.equal(alarm.props.role, 'alert');
  const text = nodesIn(alarm).find((n) => n.tag === 'span' && /changed this page/.test(n.children[0]));
  assert.match(text.children[0], /^Progressive seems to have changed this page: 5 question\(s\) aren't known, and "Business \/ sole proprietor name" moved/);
  assert.ok(box.children.indexOf(alarm) < box.children.findIndex((n) => n?.props?.class === 'rows'), 'at the top of the report');
  context.renderReport([{ ...frame, pageChanged: false }]);
  assert.equal(alarmIn(), undefined);
});

// Live review 2026-10-09: the × beside an item was 26 by 20 px, had no undo, and refilled the page,
// which could click Continue. Mark done only settles the item: nothing is filled or clicked.
test('Mark done settles only the chosen field on the current page, without filling or continuing', async () => {
  const state = { tab: { id: 1, url: 'Rates' }, agentKeys: new Map(), filling: false };
  const settled = [];
  const context = { state, persistAgentKeys: async () => {}, pageOf: (url) => url, fillPage: () => { throw new Error('Mark done never fills'); },
    settleNeed: (item, how, undo) => settled.push([item, how, typeof undo]) };
  vm.runInNewContext(extractFunction('markDone'), context);
  await context.markDone('item-1', '200F', 1, 'Rates');
  assert.deepEqual(settled, [['item-1', 'marked', 'function']]);
  await context.markDone('item-2', 'other', 2, 'Rates');
  await context.markDone('item-2', 'other', 1, 'OldPage');
  state.filling = true;
  await context.markDone('item-2', 'other', 1, 'Rates');
  assert.equal(settled.length, 1, 'another tab or page, or a fill running: nothing');
  assert.deepEqual([...state.agentKeys.get('Rates')], ['200F']);
  // A field the agent already edited on the page is theirs: nothing to undo.
  state.filling = false;
  await context.markDone('item-3', '200F', 1, 'Rates');
  assert.deepEqual(settled.at(-1), ['item-3', 'marked', 'object']);
});

test('Undo after Mark done gives the field back only while the agent hasn\'t answered it on the page', async () => {
  const state = { tab: { id: 1, url: 'Rates' }, agentKeys: new Map([['Rates', new Set(['200F'])]]), filling: false };
  const node = () => ({ hidden: true, children: [], focus() {}, replaceChildren(...c) { this.children = c; } });
  const parts = { '.mark-done': node(), '.need-note': node() };
  const item = { dataset: { settled: 'answered' }, classList: { remove() {} }, querySelector: (sel) => parts[sel] };
  let counted = 0;
  const context = { state, persistAgentKeys: async () => {}, pageOf: (url) => url, recount: () => { counted++; } };
  vm.runInNewContext(extractFunction('undoMarkDone'), context);
  await context.undoMarkDone(item, '200F', 1, 'Rates');
  assert.deepEqual([...state.agentKeys.get('Rates')], ['200F'], 'answered on the page since: the agent\'s edit stays protected');
  item.dataset.settled = 'marked';
  Object.assign(parts['.need-note'], { hidden: false, children: ['✓ Marked done'] });
  await context.undoMarkDone(item, '200F', 1, 'Rates');
  assert.deepEqual([...state.agentKeys.get('Rates')], []);
  assert.deepEqual([parts['.mark-done'].hidden, item.dataset.settled, counted], [false, undefined, 1]);
  // Open again: its note is empty and hidden (the row itself says where to answer it).
  assert.deepEqual([parts['.need-note'].hidden, parts['.need-note'].children.length], [true, 0]);
});

// pagekit `covered`: something on the page was open over Continue, so the fill didn't click it.
test('fill report says Continue wasn\'t clicked when something was open over it', () => {
  const said = (frames) => {
    const { context, box } = reportHarness({ tab: { id: 1, url: 'AddVehicle' } }, { pageOf: () => 'AddVehicle' });
    context.renderReport(frames);
    return nodesIn(box.children).filter((n) => n.props?.class === 'issue-title').map((n) => n.children[0]);
  };
  const frame = { fields: 1, filled: [{ label: 'VIN', shown: '1FTBR3X87MKA12345' }], kept: [], failed: [], noData: [], leftRequired: [], actions: [] };
  assert.deepEqual(said([{ ...frame, covered: true, blockers: ['something on the page is open over Continue: close it, then fill again'] }]), ['Continue wasn’t clicked']);
  assert.deepEqual(said([frame]), []);
  // Continued in another frame: nothing to say.
  assert.deepEqual(said([{ ...frame, covered: true }, { ...frame, advanced: 'Continue' }]), []);
  // A helper held for it (pagekit `coveredHelpers`), by its words.
  assert.deepEqual(said([{ ...frame, coveredHelpers: ['Lookup VIN'] }]), ['Lookup VIN wasn’t clicked']);
  assert.deepEqual(said([{ ...frame, coveredHelpers: ['Lookup VIN'] }, { ...frame, covered: true }]), ['Lookup VIN and Continue weren’t clicked']);
  // A follow-up fill shows its report for it, as for a page held for the agent's check.
  assert.match(extractFunction('autoFill'), /const covered = frames\.some\(\(f\) => f\.covered \|\| f\.coveredHelpers\?\.length\);[\s\S]{0,1500}const rendered = current && \([^)]*\bcovered\b[^)]*\);[\s\S]{0,120}if \(current && \(newStep \|\| unseen \|\| held \|\| covered\)\) showFinish/);
});

test('each item left for the agent has a labelled Mark done bound to its field and page', () => {
  const clicks = [];
  const { context, box } = reportHarness({ tab: { id: 7, url: 'Rates' } }, { markDone: (item, ...args) => clicks.push(args) });
  context.renderReport([{ fields: 3, halted: true, unknown: [{ key: '200F', label: 'Vehicle field' }], failed: [{ key: 'failed', label: 'Rejected', reason: 'invalid' }], noData: [{ key: 'missing', label: 'Missing' }] }]);
  const buttons = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button' && /\bmark-done\b/.test(node.props.class)) buttons.push(node);
    visit(node.children);
  };
  visit(box.children);
  assert.equal(buttons.length, 3);
  assert.deepEqual(buttons.map((b) => b.props['aria-label']), ['Mark done: Vehicle field', 'Mark done: Rejected', 'Mark done: Missing']);
  assert.ok(buttons.every((b) => b.children[0] === 'Mark done'));
  buttons.forEach((button) => button.props.onclick());
  assert.deepEqual(clicks.map((c) => c.slice(0, 3)), [['200F', 7, 'Rates'], ['failed', 7, 'Rates'], ['missing', 7, 'Rates']]);
  assert.deepEqual(clicks.map((c) => c[3].key), ['200F', 'failed', 'missing'], 'and the row, for the log of what was dismissed');
});

// Design review, good-to-have #3: step 3 listed what's left by kind, so its order changed between
// fills and didn't follow the page. It follows the page now (pagekit `order`, within a frame;
// frames in the order given), whatever kind each item is, among the answers; an item with no field
// on the page comes after them, as it came. v5: each item the panel can't answer says to answer it
// on the rater page (no line above the list); only the first starts open.
test('the page list keeps items in the page order of their fields, the first open, their notes empty', () => {
  const { context, box } = reportHarness({ tab: { id: 7, url: 'Rates' } });
  context.renderReport([
    { fields: 7, filled: [], actions: [],
      unknown: [{ key: 'u', label: 'Unfamiliar', order: 5 }, { key: 'z', label: 'No place' }],
      failed: [{ key: 'f', label: 'Failed', reason: 'invalid', order: 1 }],
      noData: [{ key: null, label: 'Helper', note: 'Click it yourself.' }, { key: 'n', label: 'Missing', order: 3 }],
      leftRequired: [{ key: 'r', label: 'Required', order: 4 }],
      kept: [{ key: 'k', label: 'Differs', differs: true, order: 2 }, { key: 'same', label: 'Kept', order: 0 }],
      checks: [{ key: 'c', label: 'Check', note: 'Check it.', order: 0 }] },
    { fields: 1, filled: [], actions: [], noData: [{ key: 'g', label: 'Other frame', order: 0 }] },
  ]);
  const rows = rowsOf(box);
  assert.deepEqual(rows.map((r) => rowSaid(r).label), ['Kept', 'Check', 'Failed', 'Differs', 'Missing', 'Required', 'Unfamiliar', 'Other frame', 'No place', 'Helper']);
  const needs = rows.filter((r) => rowSaid(r).need);
  assert.deepEqual(needs.map((r) => rowSaid(r).label), ['Check', 'Failed', 'Differs', 'Missing', 'Required', 'Unfamiliar', 'Other frame', 'No place', 'Helper']);
  assert.deepEqual(needs.map((r) => /\bopen\b/.test(r.props.class)), [true, ...Array(8).fill(false)], 'only the first item starts open');
  assert.deepEqual(needs.map((r) => r.children[1].props.hidden), [false, ...Array(8).fill(true)]);
  assert.equal(box.children.some((c) => /\bneeds-say\b/.test(c?.props?.class ?? '')), false, 'no line above the list');
  // An item with a field, or a helper's reminder, can be marked done here; one with neither (a
  // helper the fill couldn't click) has no Mark done, so its row says only where to do it (the
  // maintainer, 2026-10-26: a row said "mark it done here" with no button to press).
  const say = (r) => nodesIn(r).find((n) => n.props?.class === 'row-say')?.children[0];
  assert.deepEqual(needs.map(say), [...Array(8).fill('Answer it on the rater page, then mark it done here.'), 'Do it on the rater page.'],
    'an item the panel can not answer says where to answer it');
  const notes = needs.map((r) => r.children[1].children.at(-1));
  assert.ok(notes.every((note) => note.props.class === 'need-note' && note.props.hidden === true && !note.children.length), 'each note empty and hidden while open');
  assert.equal(context.state.reportFor.left, 9);
});

// What's left follows what the agent settles (recount): the count, the steps and the dock, and once
// nothing is left the panel's Continue is a click away (settled), never on its own.
test('what is left on the page follows the items settled and opened again', () => {
  const need = () => ({ classList: { set: new Set(['row', 'need']), contains(c) { return this.set.has(c); } } });
  const items = [need(), need()];
  const asked = [];
  const report = { querySelectorAll: (sel) => { asked.push(sel); return items; } };
  const entry = { key: 'k', fields: 2, left: 2 };
  const said = [];
  let drawn = 0;
  const context = { state: { reportFor: entry }, $: () => report, renderSteps() { drawn++; }, announce: (t) => said.push(t) };
  vm.runInNewContext(extractFunction('recount'), context);
  context.recount();
  assert.deepEqual([drawn, said.length], [0, 0], 'nothing settled: nothing to redraw');
  items.forEach((n) => n.classList.set.add('resolved'));
  context.recount();
  assert.deepEqual([entry.left, entry.settled, drawn], [0, true, 1]);
  items[0].classList.set.delete('resolved');
  context.recount();
  assert.deepEqual([entry.left, entry.settled, drawn], [1, false, 2]);
  assert.deepEqual(said, ['Nothing is left for you on this page.', '1 left for you on this page.']);
  assert.ok(asked.every((sel) => sel === '.row.need'));
  // No fill report shown: nothing counted.
  context.state.reportFor = { key: 'x' };
  context.recount();
  assert.equal(drawn, 2);
});

test('each item with a field has a labelled Show on page bound to its field, tab, page and carrier', () => {
  const calls = [];
  const carrier = { id: 'progressive', world: 'MAIN' };
  const { context, box } = reportHarness({ tab: { id: 7, url: 'Rates', carrier } }, { showOnPage: (item, x, ...rest) => calls.push([x.key, x.label, ...rest]) });
  context.renderReport([{ fields: 2, unknown: [{ key: '200F', label: 'Vehicle field', order: 0 }], noData: [{ key: null, label: 'Helper', note: 'Click it yourself.' }] }]);
  const buttons = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button' && /\bshow-on-page\b/.test(node.props.class)) buttons.push(node);
    visit(node.children);
  };
  visit(box.children);
  assert.deepEqual(buttons.map((b) => [b.props['aria-label'], b.children[0]]), [['Show on page: Vehicle field', 'Show on page']], 'none for an item without a field');
  buttons[0].props.onclick();
  assert.deepEqual(calls, [['200F', 'Vehicle field', 7, 'Rates', carrier]]);
});

// Show on page only scrolls and flashes the field (pagekit reveal), in whichever frame of the
// item's own tab has it; it is never sent to another tab or page.
test('Show on page asks every frame of the item\'s own tab to reveal its field, and says when none has it', async () => {
  const carrier = { id: 'progressive', world: 'MAIN' };
  const state = { tab: { id: 7, url: 'Rates', carrier }, filling: false };
  const runs = [];
  let frames = [{ frameId: 0, result: false }, { frameId: 3, result: true }];
  const said = [];
  const timers = [];
  const where = { hidden: true, textContent: '' };
  const item = { querySelector: (sel) => (sel === '.need-where' ? where : null) };
  const context = { state, pageOf: (u) => u, announce: (t) => said.push(t),
    runKit: async (...args) => { runs.push(args); if (frames instanceof Error) throw frames; return frames; },
    setTimeout: (fn) => timers.push(fn), clearTimeout() {} };
  vm.runInNewContext(extractFunction('showOnPage'), context);
  const x = { key: '200F', label: 'Vehicle field' };
  // Another tab or page, or an item without a field: nothing is asked of any page.
  await context.showOnPage(item, x, 8, 'Rates', carrier);
  await context.showOnPage(item, x, 7, 'OldPage', carrier);
  await context.showOnPage(item, { key: null, label: 'Helper' }, 7, 'Rates', carrier);
  assert.equal(runs.length, 0);
  await context.showOnPage(item, x, 7, 'Rates', carrier);
  assert.equal(runs.length, 1);
  const [tabId, kitCarrier, func, args] = runs[0];
  assert.deepEqual([tabId, kitCarrier, [...args]], [7, carrier, ['200F', 'Vehicle field']]);
  assert.deepEqual([where.hidden, where.textContent, said.length], [true, '', 0], 'found in a frame: nothing to say');
  // What runs in each frame: the kit's reveal, nothing else of it. A kit without it finds nothing.
  const seen = [];
  context.__raterKit = { reveal: (...a) => { seen.push(a); return true; }, fill: () => { throw new Error('never fills'); }, answer: () => { throw new Error('never answers'); } };
  assert.equal(func('200F', 'Vehicle field'), true);
  assert.deepEqual(seen, [['200F', 'Vehicle field']]);
  context.__raterKit = {};
  assert.equal(func('200F', 'Vehicle field'), false);
  // No frame has it: said on the item and announced, for a few seconds.
  frames = [{ frameId: 0, result: false }];
  await context.showOnPage(item, x, 7, 'Rates', carrier);
  assert.deepEqual([where.hidden, where.textContent], [false, 'Not on the page now (it may be in a closed section).']);
  assert.deepEqual(said, ['Not on the page now (it may be in a closed section).']);
  timers.at(-1)();
  assert.deepEqual([where.hidden, where.textContent], [true, '']);
  // The page navigating meanwhile: not found either.
  frames = new Error('Frame was removed');
  await context.showOnPage(item, x, 7, 'Rates', carrier);
  assert.equal(where.hidden, false);
});

// Live run 2026-10-09: with automatic filling on, the agent moved to AmWINS' Vehicles step (same
// address, new questions) and it was filled as a quiet follow-up: no report, and "Fill this page
// again" as if done. A page or step without a report is filled as a new page, with its report.
test('an automatic follow-up on a step without a report fills it as a new page, with its report', async () => {
  const fills = [];
  const state = { tab: { id: 1, url: 'Quote', carrier: { id: 'amwins', layoutSteps: ['Insured Info', 'Vehicles'] } }, intake: { record: {} }, autoPaused: false, filling: false,
    reports: new Map([['1|Insured Info', { fields: 9 }]]), tabSteps: new Map([[1, 'Vehicles']]) };
  const context = { watchFill: () => () => {}, state, pageOf: (u) => u, fillPage: (o) => fills.push(o), reportKey: (tabId) => `${tabId}|${state.tabSteps.get(tabId)}`,
    fillContext: () => { throw new Error('no follow-up fill'); }, stateIssue: () => null };
  // autoFill alone: its helpers (fillContext and the rest) are the stubs above; its stop check is
  // the panel's own (no stop here).
  context.renderSteps ??= () => {};
  vm.runInNewContext(`${extractFunction('autoFill').split('\nfunction ')[0]}\n${extractFunction('stopNoteFor')}`, context);
  await context.autoFill('Quote');
  assert.deepEqual(JSON.parse(JSON.stringify(fills)), [{ auto: 'page' }]);
  // Back on the step that has its report: a follow-up there stays a follow-up.
  state.tabSteps.set(1, 'Insured Info');
  await assert.rejects(context.autoFill('Quote'), /no follow-up fill/);
  assert.equal(fills.length, 1);
});

// Live run 2026-10-19: a step shown again without any change (AmWINS' Drivers and Vehicles tabs)
// left the panel on the other step's report. The recorder's step_shown moves it.
test('the panel follows a step the recorder saw shown, and only a known step of this tab', () => {
  let rendered = 0;
  const state = { tab: { id: 1, carrier: { id: 'amwins', layoutSteps: ['Drivers', 'Vehicles'] } }, intake: { record: {} }, tabSteps: new Map([[1, 'Vehicles']]) };
  const context = { state, renderSite: () => rendered++, knownStep: (carrier, step) => carrier.layoutSteps.find((s) => s === step) };
  vm.runInNewContext(extractFunction('noteStep'), context);
  context.noteStep({ ra: 'usage', event: 'step_shown', page: '/application/businessauto', step: 'Drivers' }, { tab: { id: 1 } });
  assert.deepEqual([state.tabSteps.get(1), rendered], ['Drivers', 1]);
  context.noteStep({ ra: 'usage', event: 'step_shown', step: 'Drivers' }, { tab: { id: 1 } });
  assert.equal(rendered, 1, 'the same step: nothing to redraw');
  context.noteStep({ ra: 'usage', event: 'step_shown', step: 'Insured by Jane' }, { tab: { id: 1 } });
  context.noteStep({ ra: 'usage', event: 'step_shown', step: 'Vehicles' }, { tab: { id: 2 } });
  assert.deepEqual([state.tabSteps.get(1), rendered], ['Drivers', 1], 'an unknown heading or another tab: kept');
});

test('a fill report does not list the buttons waiting on others', () => {
  assert.doesNotMatch(extractFunction('renderReport'), /'Buttons waiting'/);
});

test('an automatic fill says so in step 2 and brings step 3 into view, unless the agent is working in step 1', () => {
  const { context, box } = reportHarness({ tab: { id: 1, url: 'Quote' } });
  context.renderReport([{ fields: 2, kept: [], failed: [], noData: [], leftRequired: [], actions: [], filled: [{ label: 'A', key: 'a', shown: 'x' }] }], { auto: 'page' });
  assert.equal(context.state.reportFor.auto, true);
  assert.equal(rowsOf(box).length, 1);
  assert.match(extractFunction('renderSteps'), /`\$\{report\.filled\} filled\$\{report\.auto \? ' automatically' : ''\}`/);
  let focused = true, scrolled = 0, shown = 0;
  const state = { view: 'check' };
  const ctx = { state, renderSteps() {}, showScreen() { shown++; }, matchMedia: () => ({ matches: true }), document: { activeElement: 'field' },
    $: (id) => (id === 'check-view' ? { contains: () => focused } : { scrollIntoView: () => scrolled++ }) };
  vm.runInNewContext(extractFunction('showFinish'), ctx);
  ctx.showFinish({ auto: true });
  assert.deepEqual([state.view, shown, scrolled], ['check', 0, 0], 'step 1 stays where the agent is working');
  focused = false;
  ctx.showFinish({ auto: true });
  assert.deepEqual([state.view, shown, scrolled], ['page', 1, 1]);
  // Asked for (Fill this page): the answers come into view wherever the agent is.
  state.view = 'check';
  focused = true;
  ctx.showFinish();
  assert.deepEqual([state.view, shown, scrolled], ['page', 2, 2]);
});

// The page view's list as nodes: what the report helpers put in and take out.
function reportDom() {
  const box = () => ({ childNodes: [], get children() { return this.childNodes; }, replaceChildren(...c) { this.childNodes = c; } });
  return { report: box() };
}

// Live review 2026-10-09 (r20): switching to another quote tab and back lost the fill report, and
// a fill finishing on another tab put its report on the tab in front. Each tab and page (on
// AmWINS, each step) keeps its own, with its nodes, so its buttons and AI cards work again.
test('each tab, page and AmWINS step keeps its own fill report, shown again with its nodes', () => {
  const ui = reportDom();
  const amw = { layoutSteps: ['Applicant', 'Vehicles'] };
  const prog = { vehiclePages: ['AddVehicle'] };
  const state = { tab: { id: 1, url: 'Rates', carrier: prog }, reports: new Map(), reportFor: null, active: { vehicles: 0 }, tabSteps: new Map() };
  const context = { state, $: (id) => ui[id], pageOf: (u) => u, renderSteps() {}, Date };
  vm.runInNewContext(['stepScope', 'reportKey', 'currentReportKey', 'showReport', 'putReport', 'dropReports', 'fillProblem'].map(extractFunction).join('\n'), context);
  const a = { key: context.reportKey(1, 'Rates', prog), tabId: 1, fields: 3 };
  context.putReport(a, ['A-row']);
  assert.deepEqual([ui.report.childNodes, state.reportFor], [['A-row'], a]);
  // A fill finishing on tab 2 while tab 1 is in front: kept for tab 2, not shown here.
  const b = { key: context.reportKey(2, 'Quote', amw, {}, 'Vehicles'), tabId: 2, fields: 5 };
  context.putReport(b, ['B-row']);
  assert.deepEqual([ui.report.childNodes, state.reportFor], [['A-row'], a]);
  // Tab 2 in front on that step; then its next step, at the same address: a different report.
  state.tab = { id: 2, url: 'Quote', carrier: amw };
  state.tabSteps.set(2, 'Vehicles');
  assert.equal(context.showReport(), b);
  assert.deepEqual(ui.report.childNodes, ['B-row']);
  state.tabSteps.set(2, 'Applicant');
  assert.equal(context.showReport(), null);
  assert.deepEqual(ui.report.childNodes, []);
  // Back on tab 1: its report as it was, said to be from an earlier fill.
  state.tab = { id: 1, url: 'Rates', carrier: prog };
  assert.equal(context.showReport(), a);
  assert.deepEqual(ui.report.childNodes, ['A-row']);
  assert.equal(a.restored, true);
  // One vehicle's page is not the next one's.
  state.tab = { id: 1, url: 'AddVehicle', carrier: prog };
  const v0 = { key: context.reportKey(1, 'AddVehicle', prog), tabId: 1, fields: 1 };
  context.putReport(v0, ['V0']);
  state.active = { vehicles: 1 };
  assert.equal(context.showReport(), null);
  // A fill problem on a page without a report makes one there; on one with a report, it's said in it.
  context.fillProblem({ tabId: 1, page: 'AddVehicle', carrier: prog }, 'The tab was closed');
  assert.equal(state.reportFor.error, 'The tab was closed');
  context.fillProblem({ tabId: 1, page: 'AddVehicle', carrier: prog }, 'No questions found.', 'notice');
  assert.deepEqual([state.reportFor.error, state.reportFor.notice], [null, 'No questions found.']);
  // A closed tab's reports go with it; the one shown, when it's among them, leaves steps 2 and 3.
  state.tab = { id: 2, url: 'Quote', carrier: amw };
  state.tabSteps.set(2, 'Vehicles');
  context.showReport();
  context.dropReports((e) => e.tabId === 2);
  assert.deepEqual([state.reports.has(b.key), state.reportFor, ui.report.childNodes], [false, null, []]);
  assert.equal(state.reports.has(a.key), true);
  context.dropReports();
  assert.equal(state.reports.size, 0, 'a new or cleared client: none kept');
});

/// Live review 2026-10-09: "3 left for you" stayed at 3 after the agent answered them on the page.
// An answer that went in and that the agent changed on the page is theirs now: said so on its row.
test('"left for you" follows what the agent settles, without a refill', () => {
  const need = (key) => ({ dataset: { key }, classList: { set: new Set(['row', 'need']), contains(c) { return this.set.has(c); }, add(c) { this.set.add(c); } } });
  const items = [need('a'), need('b')];
  // An answer that went in, with its head (setRowHead): its icon, its value and its source tag.
  const parts = { '.row-icon': { textContent: '✓' }, '.row-value': { textContent: 'Old' }, '.tag': { remove() { head.tag = null; } } };
  const head = { tag: 'Intake', querySelector: (sel) => (sel === '.tag' ? (head.tag ? parts[sel] : null) : parts[sel]), append(node) { head.tag = node; } };
  const done = { dataset: { key: 'c', value: 'Old' }, classList: { remove(c) { this.removed = c; } }, querySelector: (sel) => (sel === '.row-head' ? head : null) };
  const report = { querySelectorAll: (sel) => (sel === '.row.need' ? items : sel === '.row:not(.need)[data-key]' ? [done] : []) };
  const said = [];
  const settledWith = [];
  const entry = { key: 'k', fields: 4, left: 2, advanced: null };
  const state = { tab: { id: 1, url: 'Rates' }, reportFor: entry };
  const context = { state, $: () => report, renderSteps() {}, announce: (t) => said.push(t), pageOf: (u) => u, h: (tag, props, ...children) => ({ tag, props, children }),
    settleNeed: (item, how, undo, shown) => { settledWith.push([item.dataset.key, how, shown]); item.classList.add('resolved'); context.recount(); } };
  vm.runInNewContext(['recount', 'answeredOnPage'].map(extractFunction).join('\n'), context);
  context.answeredOnPage('Rates', [{ key: 'a', label: 'A', after: 'Yes' }, { key: 'zzz' }]);
  assert.deepEqual([entry.left, entry.settled, said], [1, false, ['1 left for you on this page.']]);
  assert.deepEqual(settledWith, [['a', 'answered', 'Yes']], 'with what the page holds now');
  context.answeredOnPage('OtherPage', [{ key: 'b' }]);
  assert.equal(entry.left, 1, 'an edit on another page settles nothing here');
  context.answeredOnPage('Rates', [{ key: 'b' }, { key: 'c', label: 'Something else', after: 'New' }]);
  assert.deepEqual([entry.left, entry.settled], [0, true]);
  assert.equal(said.at(-1), 'Nothing is left for you on this page.');
  assert.deepEqual([done.dataset.value, done.classList.removed, parts['.row-value'].textContent], ['New', 'changed', 'New']);
  assert.deepEqual(JSON.parse(JSON.stringify(head.tag)), { tag: 'span', props: { class: 'tag you', title: 'You changed it on the page: no fill puts it back' }, children: ['You'] }, 'tagged the agent\'s');
  // An answer changed without a value read: left as it was.
  parts['.row-value'].textContent = 'Kept';
  context.answeredOnPage('Rates', [{ key: 'c' }]);
  assert.equal(parts['.row-value'].textContent, 'Kept');
});

// Review 2026-10-22: rows of one repeated question share its key (one per driver). The agent's change
// to one of them retags that row only, by its label; one that doesn't say which leaves them all.
test('an answer the agent changes on the page retags only its own row where rows share a key', () => {
  const row = (field) => {
    const parts = { '.row-icon': { textContent: '✓' }, '.row-value': { textContent: 'Old' }, '.tag': { remove() {} } };
    const head = { querySelector: (sel) => parts[sel] ?? null, append(node) { head.tag = node; } };
    return { parts, head, dataset: { key: 'k', field, value: 'Old' }, classList: { remove() {} }, querySelector: (sel) => (sel === '.row-head' ? head : null) };
  };
  const rows = [row('Driver 1'), row('Driver 2')];
  const report = { querySelectorAll: (sel) => (sel === '.row:not(.need)[data-key]' ? rows : []) };
  const state = { tab: { id: 1, url: 'Drivers' }, reportFor: { key: 'k', fields: 2, left: 0 } };
  const context = { state, $: () => report, pageOf: (u) => u, h: (tag, props, ...children) => ({ tag, props, children }), settleNeed() {} };
  vm.runInNewContext(extractFunction('answeredOnPage'), context);
  context.answeredOnPage('Drivers', [{ key: 'k', label: 'Driver 2', after: 'No' }]);
  assert.deepEqual(rows.map((r) => [r.dataset.value, r.parts['.row-value'].textContent, !!r.head.tag]), [['Old', 'Old', false], ['No', 'No', true]]);
  context.answeredOnPage('Drivers', [{ key: 'k', label: 'Driver', after: 'Yes' }]);
  assert.deepEqual(rows.map((r) => r.dataset.value), ['Old', 'No'], 'a change that names neither row leaves both');
});

test('a file loaded again keeps the agent\'s corrections and checks, and says what stayed', () => {
  const context = {};
  vm.runInNewContext(['keepWork', 'workSaid'].map(extractFunction).join('\n'), context);
  const was = { record: { applicant: { name: 'Corrected' } }, warnings: [{ text: 'w' }], done: [0], agentEdited: ['applicant.name'], notesReview: { a: 1 }, ntlAdded: true };
  const fresh = { record: { applicant: { name: 'From PDF' } }, warnings: [], done: [], agentEdited: [], places: { fresh: true }, fileName: 'same.pdf' };
  context.keepWork(fresh, was);
  assert.equal(fresh.record.applicant.name, 'Corrected');
  assert.deepEqual(JSON.parse(JSON.stringify([fresh.done, fresh.agentEdited, fresh.ntlAdded, fresh.places])), [[0], ['applicant.name'], true, { fresh: true }]);
  assert.notEqual(fresh.done, was.done, 'copies, not the old intake\'s lists');
  assert.equal(context.workSaid(2, 1), 'corrected 2 answers and checked 1 item');
  assert.equal(context.workSaid(0, 0), '');
  assert.match(extractFunction('loadFile'), /usage\.currentSession\(\)\?\.intakeId === summary\.intakeId \? state\.intake : null/, 'only the same intake keeps them');
});

// Live review 2026-10-09: "Clear this client" and "Change file" took the agent's work in one click.
test('Clear always asks first, and Change file asks once the agent has done work', () => {
  assert.match(SIDEPANEL, /\$\('clear-client'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,300}askFile\('clear'/);
  assert.match(SIDEPANEL, /\$\('replace'\)\.addEventListener\('click', \(\) => \{\s+const work = workSaid\([\s\S]{0,200}if \(!work\) \{[\s\S]{0,120}\$\('file'\)\.click\(\); return; \}\s+askFile\('replace'/);
  assert.match(SIDEPANEL, /\$\('file-confirm-no'\)\.addEventListener\('click', \(\) => \{ state\.fileConfirm = null;/);
});

test('a fill error is said in words the agent can act on, with the redacted detail after', () => {
  const context = { fillErrorText: (ctx, e) => `redacted:${e.message}` };
  vm.runInNewContext(extractFunction('fillErrorMessage').replace(/\nfunction fillErrorText[\s\S]*$/, ''), context);
  assert.match(context.fillErrorMessage({}, new Error('Cannot access contents of the page')), /^The browser blocked the extension on this page\. Reload/);
  assert.match(context.fillErrorMessage({}, new Error('No tab with id: 7')), /^The tab was closed/);
  assert.match(context.fillErrorMessage({}, new Error('Frame with ID 0 was removed')), /^The page changed or reloaded/);
  assert.equal(context.fillErrorMessage({}, new Error('x')), 'Filling failed. Check the page, then fill again. (redacted:x)');
});

test('warning-only automatic follow-ups render and log unfamiliar fields without pausing', async () => {
  const frames = [{ fields: 1, filled: [], actions: [], unknown: [{ key: 'new', label: 'New question' }], halted: false }];
  const logged = [], rendered = [], layouts = [], assisted = [];
  const state = { tab: { id: 1, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, active: {}, agentKeys: new Map(), autoPaused: false, filling: false, layoutReadyTabs: new Set() };
  const context = { watchFill: () => () => {},
    state, Date, crypto, rulesVersion: null, $: () => ({ checked: false }), pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options, viewOf: () => 't1',
    runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {},
    renderReport: (result) => rendered.push(result), recordLayout: (page) => layouts.push(page),
    fillEvents: () => [{ type: 'fill_field', result: 'unfamiliar' }], knownStep,
    redactionTerms: () => [], redactor: () => (s) => s, usage: { log: (...events) => logged.push(...events), currentSession: () => null },
    runAssist: (result, ctx) => assisted.push({ result, ctx, filling: state.filling }),
    pickListItem: async () => {}, noteMissingUnit: () => {}, retireAiOrigins: async () => {},
    afterFill: () => {},
    runPendingPage: () => {}, fillProblem() {}, reportShown: () => true,
  };
  context.reportKey = () => 'k'; state.reports = new Map([['k', {}]]);
  context.renderSteps ??= () => {};
  vm.runInNewContext(extractFunction('assistAfterFill') + extractFunction('autoFill'), context);
  await context.autoFill('Rates');
  assert.equal(state.autoPaused, false);
  assert.equal(state.filling, false);
  assert.equal(rendered.length, 1);
  assert.equal(logged[0].result, 'unfamiliar');
  assert.deepEqual(layouts, ['Rates']);
  // The AI assistant gets the flagged questions, only once the fill has let go of the page.
  assert.equal(assisted.length, 1);
  assert.deepEqual(assisted[0].result, frames);
  assert.equal(assisted[0].ctx.page, 'Rates');
  assert.equal(assisted[0].filling, false);
});

// FL live run 6, 2026-10-21: follow-up fills answered vehicles 2 and 3 on GEICO while the panel kept
// showing the vehicle before's answers. A unit with no report yet gets its report shown; a follow-up
// on one that has a report adds a line to it, as before.
test('an automatic fill shows the report of a unit that has none yet', async () => {
  const frames = [{ fields: 3, filled: [{ key: 'ref:GiveVinPreQuote', label: 'VIN' }], actions: [], unknown: [], halted: false }];
  const rendered = [];
  const state = { tab: { id: 1, url: '/quote', carrier: { id: 'geico' } }, intake: { record: {} }, active: { vehicles: 0 }, agentKeys: new Map(), autoPaused: false, filling: false, layoutReadyTabs: new Set(),
    reports: new Map([['v0', {}]]), reportFor: {} };
  let next = 1;
  // The page's list on the report shown, where a follow-up's answers join it.
  const appended = [];
  const list = { append: (...rows) => appended.push(...rows) };
  const context = { watchFill: () => () => {},
    state, Date, crypto, rulesVersion: null, $: () => ({ checked: false, append() {}, querySelector: (sel) => (sel === ':scope > .rows' ? list : null) }), pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options, viewOf: () => 't1',
    runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {},
    renderReport: (result) => rendered.push(result), recordLayout: () => {}, renderSteps: () => {}, announce: () => {}, h: () => ({}), answerRow: (row) => row,
    fillEvents: () => [], knownStep, fillSkip: () => [], fillSkipBy: () => null, tabMaps: () => ({ agentKeys: new Map() }), showFinish: () => {},
    redactionTerms: () => [], redactor: () => (s) => s, usage: { log: () => {}, currentSession: () => null },
    runAssist: () => {}, retireAiOrigins: async () => {}, afterFill: () => {}, runPendingPage: () => {}, fillProblem() {}, reportShown: () => true,
    // The list moved the picker to the vehicle it adds (pickUnitToAdd).
    pickListItem: async () => { state.active.vehicles = next; }, noteMissingUnit: () => {},
    reportKey: (tabId, page, carrier, active = state.active) => `v${active.vehicles}`,
  };
  context.renderSteps ??= () => {};
  vm.runInNewContext(extractFunction('assistAfterFill') + extractFunction('autoFill'), context);
  await context.autoFill('/quote');
  assert.equal(rendered.length, 1, 'vehicle 2 has no report yet: shown');
  state.reports.set('v1', {});
  await context.autoFill('/quote');
  assert.equal(rendered.length, 1, 'a follow-up on vehicle 2: a line on its report');
  assert.deepEqual(appended.map((row) => [row.label, row.fresh]), [['VIN', true]], 'its answer joins the list, marked new');
  assert.equal(state.reportFor.filled, 1, 'and is counted');
  next = 2;
  await context.autoFill('/quote');
  assert.equal(rendered.length, 2, 'vehicle 3: shown');
});

test('during a quote, switching to a non-rater tab keeps the panel on the quote tab (background)', async () => {
  const h = harness();
  h.state.intake = { record: {} };
  h.state.tab = { ...quoteTab(1, 'AddVehicle'), carrier: { id: 'progressive' } };
  h.state.autoPages = new Set(['AddVehicle']);
  h.openTab(quoteTab(1, 'AddDriver'));
  h.setActiveTab({ id: 9, url: 'https://mail.example.test/inbox' });
  await h.refreshTab();
  assert.equal(h.state.tab.id, 1, 'still the quote tab');
  assert.equal(h.state.tab.background, true);
  assert.match(h.state.tab.url, /AddDriver/, 'follows the quote tab as it moves on');
  assert.ok(h.state.autoPages.has('AddVehicle'), 'quote progress kept');
  // Another rater tab is followed as before.
  h.setActiveTab(quoteTab(2));
  await h.refreshTab();
  assert.equal(h.state.tab.id, 2);
  assert.equal(h.state.tab.background, false);
  // The quote tab closed: the panel follows the active tab.
  h.state.tab = { ...quoteTab(3), carrier: { id: 'progressive' } };
  h.setActiveTab({ id: 9, url: 'https://mail.example.test/inbox' });
  await h.refreshTab();
  assert.equal(h.state.tab.id, 9);
});

test('an AI pick made before an intake or driver/vehicle change still holds Continue until the agent decides', () => {
  const before = assistContextKey({ drivers: [{ first: 'Alex' }] }, { drivers: 0 });
  const after = assistContextKey({ drivers: [{ first: 'Alex' }] }, { drivers: 1 });
  const stale = { done: 'auto', approved: false, rejected: false, contextKey: before };
  const fresh = { done: 'auto', approved: false, rejected: false, contextKey: after };
  const state = { aiCache: new Map([[`1\n/quote\nm\n${before}\nk1`, stale], [`1\n/quote\nm\n${after}\nk2`, fresh], [`1\n/other\nm\n${after}\nk3`, { ...fresh }]]) };
  const context = { state };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('aiDecisionBlocks')}\n${extractFunction('pendingAi')}`, context);
  assert.equal(context.pendingAi(1, '/quote').length, 2, 'the earlier pick is still pending on this page');
  stale.rejected = true;
  const left = context.pendingAi(1, '/quote');
  assert.equal(left.length, 2, 'rejection still holds Continue until resolved');
  stale.confirmed = true;
  assert.equal(context.pendingAi(1, '/quote').length, 1, 'explicit confirmation releases the rejected pick');
  assert.equal(context.pendingAi(1, '/quote')[0], fresh);
});

test('correcting a rejected field releases only its originating frame hold', async () => {
  const origin = { frameId: 0, documentId: 'doc-1', questionHash: JSON.stringify(['choice', 'Choice']), fieldHash: 'live' };
  const first = { key: 'choice', done: 'auto', rejected: true, origin };
  const second = { key: 'choice', done: 'auto', rejected: true, origin: { ...origin, documentId: 'doc-2' } };
  const otherTab = { key: 'choice', done: 'auto', rejected: true, origin };
  const state = { tab: { id: 1 }, aiCache: new Map([['1\nQuote\nfirst', first], ['1\nQuote\nsecond', second], ['2\nQuote\nother', otherTab]]) };
  let writes = 0;
  const context = { state, aiQuestionHash: field => JSON.stringify([field.key, field.label]), persistAiPending: () => { writes++; } };
  vm.runInNewContext(extractFunction('settleRejectedAi'), context);
  const sender = { frameId: 0, documentId: 'doc-1' };
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], sender), true,
    'only the sender document is settled');
  assert.equal(first.manual, true);
  assert.equal(second.manual, undefined);
  assert.equal(otherTab.manual, undefined, 'another quote tab remains untouched');
  assert.equal(writes, 1);
  first.manual = undefined;
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], { frameId: 1, documentId: 'other-doc' }), false,
    'a same-key edit from another frame cannot release the hold');
});

test('legacy in-memory holds require a fresh unique sender frame', async () => {
  const legacy = { key: 'choice', done: 'auto', rejected: true };
  const fresh = [{ frameId: 3, documentId: 'doc-3', result: JSON.stringify(['Quote', [{ key: 'choice', label: 'Choice', current: 'No' }]]) }];
  const state = { tab: { id: 1, carrier: {} }, aiCache: new Map([['1\nQuote', legacy]]) };
  const context = { state, aiQuestionHash: field => JSON.stringify([field.key, field.label]),
    aiSnapshotFields: null, runKit: async () => fresh, persistAiPending: () => {} };
  vm.runInNewContext(`${extractFunction('aiSnapshotFields')}\n${extractFunction('settleRejectedAi')}`, context);
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], { frameId: 4, documentId: 'doc-4' }), false);
  fresh.push({ ...fresh[0], frameId: 4, documentId: 'doc-4' });
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], { frameId: 3, documentId: 'doc-3' }), false,
    'a duplicate key in another frame leaves legacy holds unresolved');
  fresh.pop();
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], { frameId: 3, documentId: 'doc-3' }), true);
  legacy.manual = false;
  let finish;
  context.runKit = () => new Promise(resolve => { finish = resolve; });
  const pending = context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], { frameId: 3, documentId: 'doc-3' });
  state.aiCache.clear();
  finish(fresh);
  assert.equal(await pending, false, 'a cleared intake cannot be settled by a late snapshot');
  assert.equal(legacy.manual, false);
});

test('retired assistant decisions retain their hold and require current-answer review', async () => {
  const record = { scope: 'intake', tabId: 1, page: 'Quote', model: 'retired-model', policy: 'retired-policy',
    contextHash: 'context', itemHash: 'item', key: 'choice', label: 'Choice', choice: 'No', done: 'auto' };
  const state = { tab: { id: 1, carrier: {} }, aiCache: new Map() };
  const fresh = [{ frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [{ key: 'choice', label: 'Choice', current: 'No' }]]) }];
  const context = { state, aiFingerprint: JSON.stringify, runKit: async () => fresh, DEFAULT_MODEL, POLICY_VERSION, usage: { currentSession: () => ({ intakeId: 'intake' }) },
    aiPendingStore: { get: async () => [record], set: async () => {} }, persistAiPending: () => {} };
  vm.createContext(context);
  vm.runInContext(['aiOriginRecord', 'aiSnapshotFields', 'aiQuestionHash', 'aiCacheSignature', 'restoreAiPending', 'aiDecisionBlocks', 'pendingAi', 'settleRejectedAi']
    .map(extractFunction).join('\n'), context);
  await context.restoreAiPending();
  const restored = [...state.aiCache.values()][0];
  assert.equal(restored.retired, true);
  assert.equal(restored.autoOk, false, 'old model verification cannot qualify as Luna verification');
  assert.equal(restored.rejected, true, 'explicit confirmation or a manual correction is required');
  assert.equal(context.pendingAi(1, 'Quote').length, 1);
  const sender = { frameId: 0, documentId: 'doc-0' };
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'unrelated', label: 'Other' }], sender), false);
  assert.equal(context.pendingAi(1, 'Quote').length, 1);
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], sender), true);
  assert.equal(context.pendingAi(1, 'Quote').length, 0);
});

test('current Luna decisions and completed retired corrections retain their review state', async () => {
  const base = { scope: 'intake', tabId: 1, page: 'Quote', contextHash: 'context', key: 'choice', done: 'auto' };
  const records = [{ ...base, model: DEFAULT_MODEL, policy: POLICY_VERSION, itemHash: 'current' },
    { ...base, model: 'retired-model', policy: 'retired-policy', itemHash: 'manual', manual: true },
    { ...base, model: 'retired-model', policy: 'retired-policy', itemHash: 'confirmed', confirmed: true }];
  const state = { aiCache: new Map() };
  const context = { state, DEFAULT_MODEL, POLICY_VERSION, usage: { currentSession: () => ({ intakeId: 'intake' }) },
    aiPendingStore: { get: async () => records, set: async () => {} } };
  vm.createContext(context);
  vm.runInContext(['aiOriginRecord', 'aiCacheSignature', 'restoreAiPending', 'aiDecisionBlocks', 'pendingAi'].map(extractFunction).join('\n'), context);
  await context.restoreAiPending();
  const [current, manual, confirmed] = [...state.aiCache.values()];
  assert.equal(current.retired, false);
  assert.equal(current.rejected, false);
  assert.equal(current.autoOk, true);
  assert.equal(manual.manual, true);
  assert.equal(confirmed.confirmed, true);
  assert.equal(context.pendingAi(1, 'Quote').length, 1, 'only the unresolved Luna answer blocks');
});

test('safety metadata changes invalidate cached choice fingerprints', () => {
  const context = { aiFingerprint: JSON.stringify };
  vm.runInNewContext(extractFunction('aiItemFingerprint'), context);
  const field = { key: 'choice', label: 'Choice', options: ['Yes', 'No'], current: '', manualOnly: false, reviewOnly: false, fieldType: null };
  const before = context.aiItemFingerprint(field);
  for (const metadata of [{ manualOnly: true }, { reviewOnly: true }, { fieldType: 'identity' }]) {
    assert.notEqual(context.aiItemFingerprint({ ...field, ...metadata }), before);
  }
});

test('a quote opened in a new tab is followed once it loads, even while the old portal tab is followed', () => {
  let refreshed = 0;
  const context = { state: { tab: { id: 1 } }, refreshTab: () => { refreshed++; } };
  vm.createContext(context);
  vm.runInContext(extractFunction('onTabUpdated'), context);
  context.onTabUpdated(2, { status: 'complete' }, { id: 2, active: true });
  assert.equal(refreshed, 1, 'the active new tab finished loading');
  context.onTabUpdated(3, { status: 'complete' }, { id: 3, active: false });
  assert.equal(refreshed, 1, 'a background tab loading elsewhere is ignored');
  context.onTabUpdated(1, { url: 'https://example.test/next' }, { id: 1, active: false });
  assert.equal(refreshed, 2, 'the followed tab still counts');
  context.onTabUpdated(2, { title: 'x' }, { id: 2, active: true });
  assert.equal(refreshed, 2, 'no reload or address change: nothing to do');
});


test('ordinary manual keys survive reload and remain scoped to the intake, tab and page', async () => {
  let records = [];
  const state = { tab: { id: 1 }, agentKeys: new Map([['Quote', new Set(['manual-choice'])]]) };
  let scope = 'first-intake';
  const context = { state, agentKeysQueue: Promise.resolve(), usage: { currentSession: () => ({ intakeId: scope }) },
    agentKeysStore: { get: async () => records, set: async value => { records = value; } } };
  vm.createContext(context);
  vm.runInContext(['persistAgentKeys', 'restoreAgentKeys'].map(extractFunction).join('\n'), context);
  await context.persistAgentKeys();
  state.agentKeys = new Map();
  await context.restoreAgentKeys(1);
  assert.equal(state.agentKeys.get('Quote').has('manual-choice'), true);
  assert.equal(state.agentKeys.has('OtherPage'), false);
  state.agentKeys = new Map(); state.tab.id = 2;
  await context.restoreAgentKeys(2);
  assert.equal(state.agentKeys.size, 0, 'another quote tab is untouched');
  state.tab.id = 1; scope = 'second-intake';
  await context.restoreAgentKeys(1);
  assert.equal(state.agentKeys.size, 0, 'a different intake is untouched');
  assert.deepEqual(Object.keys(records[0]).sort(), ['keys', 'page', 'scope', 'tabId']);
});

test('canonical AI snapshots ignore Chromium metadata and frame ordering but retain identity', () => {
  const context = { aiFingerprint: JSON.stringify };
  vm.runInNewContext([
    extractFunction('canonicalSnapshotMetadata'), extractFunction('canonicalSnapshotFrame'),
    extractFunction('canonicalSnapshots'), extractFunction('snapshotFingerprint'),
    extractFunction('snapshotsEqual'), extractFunction('snapshotHashMatches'),
  ].join('\n'), context);
  const first = [
    { result: 'frame 2', frameId: 2, documentId: 'doc-2' },
    { documentId: 'doc-0', result: 'frame 0', frameId: 0 },
  ];
  const reordered = [
    { frameId: 0, result: 'frame 0', documentId: 'doc-0' },
    { result: 'frame 2', documentId: 'doc-2', frameId: 2 },
  ];
  assert.deepEqual(context.canonicalSnapshots(first), context.canonicalSnapshots(reordered));
  assert.equal(context.snapshotsEqual(first, reordered), true);
  assert.equal(context.snapshotHashMatches(first, context.snapshotFingerprint(reordered)), true);
  assert.equal(context.snapshotHashMatches(first, JSON.stringify(first)), true, 'old raw hashes remain readable');
  assert.equal(context.snapshotsEqual(first, [{ ...reordered[0], documentId: 'different-document' }, reordered[1]]), false,
    'document identity remains part of the guard');
  assert.equal(context.snapshotsEqual(first, [{ ...reordered[0], frameId: 9 }, reordered[1]]), false,
    'frame identity remains part of the guard');
  assert.equal(context.snapshotsEqual(first, [{ result: 'frame 0', documentId: 'doc-0' }, reordered[1]]), false,
    'an omitted frame identity remains part of the guard');
  assert.equal(context.snapshotsEqual(first, [{ ...reordered[0], current: 'changed', options: { beta: true } }, reordered[1]]), false,
    'current and options metadata remain part of the guard');
  assert.equal(context.canonicalSnapshots(first)[0].result, 'frame 0', 'the raw pagekit result string is preserved');
  assert.equal(context.snapshotsEqual(first, [{ ...reordered[0], result: 'changed page' }, reordered[1]]), false,
    'the pagekit result remains part of the guard');
  assert.equal(context.snapshotsEqual([], null), false, 'invalid snapshots do not equal an empty snapshot');
});

test('restored confirmation uses a field fingerprint instead of redacted display strings', () => {
  const context = { aiFingerprint: JSON.stringify };
  vm.runInNewContext([
    extractFunction('canonicalSnapshotMetadata'), extractFunction('canonicalSnapshotFrame'),
    extractFunction('canonicalSnapshots'), extractFunction('snapshotFingerprint'),
    extractFunction('aiSnapshotFields'), extractFunction('aiLiveFieldHash'),
    extractFunction('aiQuestionHash'), extractFunction('aiOriginRecord'),
    extractFunction('snapshotHashMatches'), extractFunction('aiCurrentAnswerPresent'),
  ].join('\n'), context);
  const field = { key: 'choice', label: 'Driver Alex Example', current: 'Client 12345' };
  const frames = [{ result: JSON.stringify(['Quote', [field]]) }];
  const origin = { frameId: 0, documentId: 'doc-0', questionHash: JSON.stringify([field.key, field.label]),
    fieldHash: JSON.stringify([field.key, field.label, field.current]) };
  const x = { key: 'choice', label: 'Driver [redacted]', choice: 'Client [redacted]', origin,
    fieldHash: origin.fieldHash };
  const identified = [{ frameId: 0, documentId: 'doc-0', result: frames[0].result }];
  assert.equal(context.aiCurrentAnswerPresent(identified, x), true);
  assert.equal(context.aiCurrentAnswerPresent([{ frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [{ ...field, current: 'Other value' }]]) }], x), false);
  assert.equal(context.aiCurrentAnswerPresent([{ frameId: 1, documentId: 'doc-1', result: frames[0].result }], x), false);
  assert.equal(context.aiCurrentAnswerPresent(frames, { ...x, origin: null, fieldHash: null, snapshotHash: JSON.stringify(frames) }), true,
    'old redacted records can be confirmed only if their whole page is unchanged');
  assert.equal(context.aiCurrentAnswerPresent(frames, { ...x, origin: null, fieldHash: x.fieldHash }), false,
    'old field hashes without a whole-page proof cannot identify a frame');
});

test('restored confirmation requires the originating frame and rejects duplicate questions', () => {
  const context = { aiFingerprint: JSON.stringify };
  vm.runInNewContext([
    extractFunction('aiSnapshotFields'), extractFunction('aiLiveFieldHash'),
    extractFunction('aiQuestionHash'), extractFunction('aiOriginRecord'),
    extractFunction('aiSnapshotFieldMatches'), extractFunction('aiAnswerOrigin'),
    extractFunction('aiCurrentAnswerPresent'),
  ].join('\n'), context);
  const field = { key: 'choice', label: 'Choice', current: 'No' };
  const frame = { frameId: 4, documentId: 'doc-4', result: JSON.stringify(['Quote', [field]]) };
  const answerFrame = { ...frame, shown: 'No' };
  const origin = context.aiAnswerOrigin([frame], field, answerFrame);
  assert.equal(JSON.stringify(origin), JSON.stringify({
    frameId: 4, documentId: 'doc-4',
    questionHash: JSON.stringify(['choice', 'Choice']),
    fieldHash: JSON.stringify(['choice', 'Choice', 'No']),
  }));
  assert.equal(context.aiCurrentAnswerPresent([frame], { ...field, origin }), true);
  assert.equal(context.aiCurrentAnswerPresent([{ ...frame, documentId: 'replaced-doc' }], { ...field, origin }), false,
    'a replacement document cannot satisfy the confirmation');
  assert.equal(context.aiCurrentAnswerPresent([{ ...frame, frameId: 5 }], { ...field, origin }), false,
    'the same value in another frame cannot satisfy the confirmation');
  assert.equal(context.aiCurrentAnswerPresent([frame, { ...frame, frameId: 5, documentId: 'doc-5' }], { ...field, origin }), false,
    'duplicate same-key same-label frames fail closed');
  assert.equal(context.aiCurrentAnswerPresent([{ ...frame, result: JSON.stringify(['Quote', [{ ...field, current: 'Yes' }]]) }], { ...field, origin }), false,
    'the originating live value must still match');
  const changed = [{ ...frame, result: JSON.stringify(['Quote', [{ ...field, current: 'Yes' }]]) }];
  const expectedOrigin = context.aiAnswerOrigin(changed, field, answerFrame);
  assert.equal(expectedOrigin.fieldHash, origin.fieldHash, 'the successful answer value remains the expected value');
  assert.equal(context.aiCurrentAnswerPresent(changed, { ...field, origin: expectedOrigin }), false,
    'a changed post-answer value cannot be approved');
});


test('AI application drops stale in-flight work and refuses duplicate frame questions', async () => {
  for (const scenario of ['new-intake', 'evicted', 'tab', 'url', 'duplicates']) {
    const record = { drivers: [] }, intake = { record };
    const x = { key: 'choice', label: 'Choice', controlKind: 'radio', choice: 'No', autoOk: true };
    const frame = { frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [{ key: x.key, label: x.label, current: '' }]]) };
    const frames = scenario === 'duplicates' ? [frame, { ...frame, frameId: 2, documentId: 'doc-2' }] : [frame];
    const state = { filling: false, intake, active: {}, tab: { id: 1, url: 'https://example.test/quote' },
      aiCache: new Map([['1\n/quote', x]]), agentKeys: new Map() };
    const ctx = { tabId: 1, page: '/quote', tabUrl: state.tab.url, intake, carrier: { practice: true },
      contextKey: assistContextKey(record, state.active), snapshots: frames };
    let resolveSnapshot, snapshotEntered, calls = 0, persisted = 0;
    const started = new Promise(resolve => { snapshotEntered = resolve; });
    const snapshot = new Promise(resolve => { resolveSnapshot = resolve; });
    const context = { state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, pageOf: url => new URL(url).pathname,
      runKit: (tabId, carrier, func) => /answerEdits/.test(String(func)) ? frames.map(frame => ({ ...frame, result: [] })) : (calls++, snapshotEntered(), snapshot), tellRecorder: async () => {},
      persistAiPending: async () => { persisted++; }, usage: { currentSession: () => ({ intakeId: 'scope' }) } };
    vm.runInNewContext(['aiActionCurrent', 'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots',
      'snapshotsEqual', 'aiSnapshotFields', 'aiSnapshotFieldMatches', 'applyAi'].map(extractFunction).join('\n') + LAYOUT_STUB, context);
    const action = context.applyAi([x], ctx, 'auto');
    await started;
    if (scenario === 'new-intake') state.intake = { record };
    if (scenario === 'evicted') state.aiCache.clear();
    if (scenario === 'tab') state.tab = { ...state.tab, id: 2 };
    if (scenario === 'url') state.tab = { ...state.tab, url: 'https://example.test/quote?quote=other' };
    resolveSnapshot(frames);
    assert.equal(await action, false, scenario);
    assert.equal(calls, 1, `${scenario}: no answer execution follows the snapshot`);
    assert.equal(x.done, undefined, `${scenario}: stale work cannot become a pending approval`);
    if (scenario !== 'duplicates') assert.equal(persisted, 0, `${scenario}: stale work is not persisted`);
  }
});

test('approval expects the successful answer when a carrier redraw changes its value', async () => {
  const record = {}, intake = { record };
  const x = { key: 'choice', label: 'Choice', controlKind: 'radio', choice: 'No', autoOk: true };
  const field = { key: x.key, label: x.label, current: '' };
  const pre = [{ frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [field]]) }];
  const post = [{ ...pre[0], result: JSON.stringify(['Quote', [{ ...field, current: 'Yes' }]]) }];
  const responses = [pre, [{ frameId: 0, documentId: 'doc-0', result: [{ key: x.key, label: x.label, ok: true, shown: 'No' }] }], post];
  const state = { filling: false, intake, active: {}, tab: { id: 1, url: 'https://example.test/quote' },
    aiCache: new Map([['1\n/quote', x]]), agentKeys: new Map(), filled: new Map() };
  const ctx = { tabId: 1, page: '/quote', tabUrl: state.tab.url, intake, carrier: { practice: true },
    contextKey: assistContextKey(record, state.active), snapshots: pre };
  const context = { state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, pageOf: url => new URL(url).pathname,
    runKit: async (tabId, carrier, func) => /answerEdits/.test(String(func)) ? pre.map(frame => ({ ...frame, result: [] })) : responses.shift(), tellRecorder: async () => {}, persistAiPending: async () => {},
    usage: { currentSession: () => ({ intakeId: 'scope' }) }, aiSafeText: String, aiRetiredSignatures: new Set() };
  vm.runInNewContext(['aiActionCurrent', 'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots',
    'snapshotsEqual', 'snapshotFingerprint', 'snapshotHashMatches', 'aiSnapshotFields', 'aiSnapshotFieldMatches',
    'aiQuestionHash', 'aiLiveFieldHash', 'aiOriginRecord', 'aiAnswerOrigin', 'aiCurrentAnswerPresent',
    'applyAi'].map(extractFunction).join('\n') + LAYOUT_STUB, context);
  assert.equal(await context.applyAi([x], ctx, 'auto'), true);
  assert.equal(x.done, 'auto', 'the applied choice remains a review hold');
  assert.equal(x.origin.fieldHash, JSON.stringify(['choice', 'Choice', 'No']));
  assert.equal(context.aiCurrentAnswerPresent(post, x), false, 'the redraw cannot substitute a new approval value');
  assert.equal(context.aiCurrentAnswerPresent([{ ...post[0], result: JSON.stringify(['Quote', [{ ...field, current: 'No' }]]) }], x), true);
});

// Codex review (2026-10-09): answer()'s protection did not survive executeScript, and a halt in one
// frame did not stop the others. The items carry it now; frames go one at a time.
test('an agent edit caught during an AI apply is protected, and stops the answers of the frames still to come', async () => {
  const record = {}, intake = { record };
  const xs = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }].map(x => ({ ...x, controlKind: 'radio', choice: 'No', autoOk: true }));
  const pre = [0, 1].map(i => ({ frameId: i, documentId: `doc-${i}`, result: JSON.stringify(['Quote', [{ key: xs[i].key, label: xs[i].label, current: '' }]]) }));
  const answered = [];
  // Frame 0 answers A; the agent edited C meanwhile. Frame 1 has nothing of A's.
  const runKit = async (tabId, carrier, func, args = []) => {
    if (/answerEdits/.test(String(func))) return pre.map(frame => ({ ...frame, result: [] }));
    if (!args.length) return pre;
    answered.push(args[0].map(a => a.key).join(','));
    return [{ frameId: 0, documentId: 'doc-0', result: [{ key: 'a', label: 'A', ok: true, shown: 'No' },
      { key: 'c', label: 'C', ok: false, protected: true, reason: 'you changed this question yourself while the AI answers went in; your answer stays' }] },
    { frameId: 1, documentId: 'doc-1', result: [{ key: 'a', label: 'A', ok: false, reason: 'the question is no longer on this page' }] }];
  };
  let persisted = 0;
  const state = { filling: false, intake, active: {}, tab: { id: 1, url: 'https://example.test/quote' },
    aiCache: new Map(xs.map((x, i) => [`${i}\n/quote`, x])), agentKeys: new Map(), filled: new Map() };
  const ctx = { tabId: 1, page: '/quote', tabUrl: state.tab.url, intake, carrier: { practice: true },
    contextKey: assistContextKey(record, state.active), snapshots: pre };
  const context = { state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, pageOf: url => new URL(url).pathname,
    runKit, tellRecorder: async () => {}, persistAiPending: async () => {},
    agentKeysQueue: Promise.resolve(), agentKeysStore: { get: async () => [], set: async () => { persisted++; } },
    usage: { currentSession: () => ({ intakeId: 'scope' }) }, aiSafeText: String, aiRetiredSignatures: new Set() };
  vm.runInNewContext(['aiActionCurrent', 'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots',
    'snapshotsEqual', 'snapshotFingerprint', 'snapshotHashMatches', 'aiSnapshotFields', 'aiSnapshotFieldMatches',
    'aiQuestionHash', 'aiLiveFieldHash', 'aiOriginRecord', 'aiAnswerOrigin', 'aiCurrentAnswerPresent',
    'applyAi'].map(extractFunction).join('\n') + LAYOUT_STUB, context);
  const applied = await context.applyAi(xs, ctx, 'auto');
  assert.equal(applied, true, JSON.stringify(xs.map(x => x.error)));
  assert.deepEqual(answered, ['a'], 'frame 1\'s answer is not sent after the halt');
  assert.equal(xs[0].done, 'auto');
  assert.equal(xs[1].done, null);
  assert.match(xs[1].error, /agent edit interrupted/);
  assert.deepEqual([...state.agentKeys.get('/quote')].sort(), ['a', 'c'], 'the agent\'s edit is kept from a later fill');
  assert.equal(persisted, 1);
});

const AI_ACTION_FUNCTIONS = [
  'canonicalSnapshotMetadata', 'canonicalSnapshotFrame',
  'canonicalSnapshots', 'snapshotFingerprint', 'snapshotsEqual', 'snapshotHashMatches',
  'aiSnapshotFields', 'aiLiveFieldHash', 'aiQuestionHash', 'aiOriginRecord',
  'aiCurrentAnswerPresent', 'aiActionCurrent', 'aiDecisionBlocks', 'pendingAi', 'renderAi',
].map(extractFunction).join('\n');

function aiActionTreeText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(aiActionTreeText).join('');
  if (typeof node === 'string') return node;
  return aiActionTreeText(node.children);
}

function aiActionButtons(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const child of node) aiActionButtons(child, out);
    return out;
  }
  if (node.tag === 'button') out.push(node);
  aiActionButtons(node.children, out);
  return out;
}

function makeAiActionHarness({ rejected = false, via = 'row' } = {}) {
  const frame = {
    frameId: 0,
    documentId: 'doc-1',
    result: JSON.stringify(['Quote', [{
      key: 'choice', label: 'Choice', current: 'No', options: ['Yes', 'No'],
    }]]),
  };
  const intake = { record: { client: 'synthetic' } };
  const tab = { id: 1, url: 'https://example.test/quote' };
  const x = {
    key: 'choice', label: 'Choice', choice: 'No', controlKind: 'select',
    section: 'Quote', options: ['Yes', 'No'], current: 'No', done: 'auto',
    autoOk: true, approved: false, rejected, manual: false, confirmed: false,
    dismissed: false, leave: false, applyable: true, provider: 'luna', evidenceSources: [],
    model: 'synthetic-model', policy: 'synthetic-policy', basis: 'intake',
    intakePath: 'record.client', confidence: 0.9, checks: [], tip: '',
  };
  const signature = '1\n/quote\nsynthetic-model\nsynthetic-policy\ncontext\nitem';
  const state = {
    filling: false, tab, intake, active: { drivers: 0, vehicles: 0 },
    aiCache: new Map([[signature, x]]), agentKeys: new Map(), aiRun: 0, aiDocks: new Map(),
  };
  const ctx = {
    tabId: 1, tabUrl: tab.url, page: '/quote', intake, contextKey: 'context',
    snapshots: [frame], carrier: { id: 'synthetic', practice: true, advance: () => {} },
  };
  const ui = { 'auto-advance': { checked: true }, 'ai-note': { textContent: '' } };
  const holder = {
    isConnected: true, children: [],
    replaceChildren(...children) { this.children = children; },
  };
  const report = { querySelectorAll() { return []; }, append(...children) { this.children = children; } };
  let releaseSnapshot;
  let snapshotStarted;
  const snapshotStartedPromise = new Promise(resolve => { snapshotStarted = resolve; });
  const calls = [];
  let fillCalls = 0;
  const fakeH = (tag, props = {}, ...children) => {
    const node = {
      tag, props, children: children.flat().filter(child => child != null && child !== false),
      dataset: { ...(props.dataset ?? {}) }, disabled: false, textContent: '',
    };
    node.textContent = aiActionTreeText(node.children);
    return node;
  };
  const context = {
    state,
    $: id => id === 'report' ? report : ui[id],
    h: fakeH,
    pageOf: url => new URL(url).pathname,
    assistContextKey: () => 'context',
    aiFingerprint: JSON.stringify,
    runKit: (...args) => {
      calls.push(args);
      snapshotStarted();
      return new Promise(resolve => { releaseSnapshot = resolve; });
    },
    fillPage: () => { fillCalls += 1; },
    persistAiPending: async () => {},
    syncAiBanner: async () => {},
    recount() {},
    renderSteps() {},
    usage: { log: () => {} },
  };
  vm.runInNewContext(AI_ACTION_FUNCTIONS, context, { filename: 'sidepanel/sidepanel.js' });
  x.snapshotHash = context.snapshotFingerprint([frame]);
  x.origin = {
    frameId: frame.frameId, documentId: frame.documentId,
    questionHash: context.aiQuestionHash({ key: 'choice', label: 'Choice' }),
    fieldHash: context.aiLiveFieldHash({ key: 'choice', label: 'Choice', current: 'No' }),
  };
  context.renderAi(holder, [x], ctx);
  // The pick has no row here: its card is above the list, with its own button; the dock's Approve
  // (state.aiDocks, by tab and page) acts on every pick waiting on the page.
  const phrase = rejected ? 'Confirm the current page answer' : 'Approve';
  const own = () => aiActionButtons(holder.children)
    .find(candidate => aiActionTreeText(candidate.children) === phrase);
  assert.ok(own(), 'real renderAi ' + (rejected ? 'Confirm' : 'Approve') + ' button rendered');
  assert.deepEqual([[...state.aiDocks.keys()], state.aiDocks.get('1|/quote').canContinue], [['1|/quote'], true], 'the dock approves the picks of this page');
  const dockGo = state.aiDocks.get('1|/quote').go;
  const button = () => (via === 'dock' ? { props: { onclick: dockGo } } : own());
  return {
    state, ctx, x, frame, holder, calls, fillCalls: () => fillCalls, button,
    snapshotStartedPromise, release: (snapshot = [frame]) => releaseSnapshot(snapshot),
  };
}

test('a question Luna left shows its recommendation; an answered one shows none', () => {
  const holder = { isConnected: true, children: [], replaceChildren(...c) { this.children = c; } };
  const fakeH = (tag, props = {}, ...children) => ({ tag, props, children: children.flat().filter(c => c != null && c !== false), dataset: {} });
  const state = { filling: false, tab: { id: 1, url: 'https://example.test/quote' }, intake: { record: {} }, active: {}, aiCache: new Map(), agentKeys: new Map(), aiRun: 0, aiDocks: new Map() };
  const context = { state, $: id => (id === 'report' ? { querySelectorAll: () => [] } : { checked: false }), h: fakeH, pageOf: url => new URL(url).pathname,
    assistContextKey: () => 'context', aiFingerprint: JSON.stringify, runKit: async () => [], usage: { log() {} }, recount() {}, renderSteps() {} };
  vm.runInNewContext(AI_ACTION_FUNCTIONS, context, { filename: 'sidepanel/sidepanel.js' });
  const ctx = { tabId: 1, page: '/quote', carrier: { id: 'synthetic', practice: true } };
  const left = { key: 'sr22', label: 'SR-22?', leave: true, applyable: true, controlKind: 'radio', options: ['Yes', 'No'], tip: 'Not on the intake.',
    nextStep: 'The intake leaves "Needs SR-22" blank: confirm it with the client, then add it under All client details.', checks: [] };
  context.renderAi(holder, [left], ctx);
  const text = aiActionTreeText(holder.children);
  assert.match(text, /this one is yours to decide/);
  assert.match(text, /Luna recommends: The intake leaves "Needs SR-22" blank/);
  assert.equal(aiActionButtons(holder.children).some(b => /Use this answer/.test(aiActionTreeText(b.children))), false, 'a recommendation is no answer to put in');
  context.renderAi(holder, [{ ...left, leave: false, choice: 'No', nextStep: null, evidenceSources: [] }], ctx);
  assert.doesNotMatch(aiActionTreeText(holder.children), /recommends/);
});

async function awaitDeferredAction(harness, mutate) {
  const action = harness.button().props.onclick();
  await harness.snapshotStartedPromise;
  mutate(harness);
  harness.release();
  await action;
}

test('renderAi approval ignores a deferred snapshot after intake, cache, tab, or URL changes', async () => {
  const mutations = [
    ['new intake', h => { h.state.intake = { record: { client: 'replacement' } }; }],
    ['cleared intake', h => { h.state.intake = null; h.state.aiCache.clear(); }],
    ['cache eviction', h => { h.state.aiCache.clear(); }],
    ['cached item replacement', h => {
      const [sig] = h.state.aiCache.keys();
      h.state.aiCache.set(sig, { ...h.x });
    }],
    ['cache replacement', h => {
      h.state.aiCache = new Map([['1\n/quote\nreplacement', { key: 'replacement' }]]);
    }],
    ['tab replacement', h => { h.state.tab = { id: 2, url: h.ctx.tabUrl }; }],
    ['URL change', h => { h.state.tab.url = 'https://example.test/quote?quote=other'; }],
  ];
  for (const via of ['row', 'dock']) for (const [label, mutate] of mutations) {
    const h = makeAiActionHarness({ via });
    await awaitDeferredAction(h, mutate);
    assert.equal(h.x.approved, false, via + ', ' + label + ': late approval did not mark the cached item');
    assert.equal(h.x.rejected, false, via + ', ' + label + ': late approval did not rewrite the item as moved');
    assert.equal(h.fillCalls(), 0, via + ', ' + label + ': late approval did not call fillPage');
  }
});

test('renderAi confirmation ignores a deferred snapshot after intake, cache, tab, or URL changes', async () => {
  const mutations = [
    ['new intake', h => { h.state.intake = { record: { client: 'replacement' } }; }],
    ['cleared intake', h => { h.state.intake = null; h.state.aiCache.clear(); }],
    ['cache eviction', h => { h.state.aiCache.clear(); }],
    ['cached item replacement', h => {
      const [sig] = h.state.aiCache.keys();
      h.state.aiCache.set(sig, { ...h.x });
    }],
    ['cache replacement', h => {
      h.state.aiCache = new Map([['1\n/quote\nreplacement', { key: 'replacement' }]]);
    }],
    ['tab replacement', h => { h.state.tab = { id: 2, url: h.ctx.tabUrl }; }],
    ['URL change', h => { h.state.tab.url = 'https://example.test/quote?quote=other'; }],
  ];
  for (const via of ['row', 'dock']) for (const [label, mutate] of mutations) {
    const h = makeAiActionHarness({ rejected: true, via });
    await awaitDeferredAction(h, mutate);
    assert.equal(h.x.confirmed, false, via + ', ' + label + ': late confirmation did not settle the hold');
    assert.equal(h.fillCalls(), 0, via + ', ' + label + ': late confirmation did not call fillPage');
  }
});

test('renderAi approval and confirmation allow an active-driver change when intake/page/cache remain current', async () => {
  for (const via of ['row', 'dock']) {
  const approved = makeAiActionHarness({ via });
  const approval = approved.button().props.onclick();
  await approved.snapshotStartedPromise;
  approved.state.active = { drivers: 1, vehicles: 0 };
  approved.release();
  await approval;
  assert.equal(approved.x.approved, true, 'active-driver change does not invalidate approval');
  assert.equal(approved.fillCalls(), 1, 'current approval still continues the fill');

  const confirmed = makeAiActionHarness({ rejected: true, via });
  const confirmation = confirmed.button().props.onclick();
  await confirmed.snapshotStartedPromise;
  confirmed.state.active = { drivers: 1, vehicles: 0 };
  confirmed.release();
  await confirmation;
  assert.equal(confirmed.x.confirmed, true, 'active-driver change does not invalidate confirmation');
  assert.equal(confirmed.fillCalls(), 1, 'current confirmation still continues the fill');
  }
});

const DISPATCH_HELPERS = ['aiOriginRecord', 'aiSnapshotFields', 'aiSnapshotFieldMatches', 'aiQuestionHash',
  'aiLiveFieldHash', 'aiAnswerOrigin', 'aiActionCurrent', 'aiCacheSignature', 'aiDecisionBlocks',
  'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots', 'snapshotsEqual',
  'snapshotFingerprint', 'aiPendingRecord', 'persistAiPending', 'restoreAiPending',
  'discardAiSuggestions', 'pendingAi', 'applyAi'].map(extractFunction).join('\n') + LAYOUT_STUB;

test('dispatched answers retain durable holds across intake, cache and transport changes', async () => {
  for (const scenario of ['intake-replaced', 'intake-cleared', 'cache-cleared', 'transport-error']) {
    const record = {}, intake = { record }, url = 'https://example.test/quote';
    const x = { key: 'choice', label: 'Choice', controlKind: 'radio', choice: 'No', autoOk: true };
    const quoteHash = JSON.stringify(url);
    const sig = ['1', '/quote', 'gpt-6-luna', 'policy', 'context', 'item', quoteHash].join('\n');
    const field = { key: x.key, label: x.label, current: '' };
    const pre = [{ frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [field]]) }];
    const after = [{ ...pre[0], result: JSON.stringify(['Quote', [{ ...field, current: 'No' }]]) }];
    const state = { filling: false, intake, active: {}, tab: { id: 1, url },
      aiCache: new Map([[sig, x]]), agentKeys: new Map(), filled: new Map() };
    const ctx = { tabId: 1, page: '/quote', tabUrl: url, intake, carrier: { practice: true },
      contextKey: assistContextKey(record, state.active), snapshots: pre };
    let stored = [], scope = 'original-intake', calls = 0, release, fail, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const settlement = new Promise((resolve, reject) => { release = resolve; fail = reject; });
    const context = { state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, aiSafeText: String,
      DEFAULT_MODEL: 'gpt-6-luna', POLICY_VERSION: 'policy', pageOf: value => new URL(value).pathname,
      usage: { currentSession: () => scope ? { intakeId: scope } : null },
      aiPersistQueue: Promise.resolve(), aiRetiredSignatures: new Set(),
      aiPendingStore: { get: async () => stored, set: async value => { stored = value; } },
      tellRecorder: async () => {},
      runKit: (tabId, carrier, func) => {
        if (/answerEdits/.test(String(func))) return Promise.resolve(pre.map(frame => ({ ...frame, result: [] })));
        calls++;
        if (calls === 1) return Promise.resolve(pre);
        if (calls === 2) { entered(); return settlement; }
        return Promise.resolve(after);
      } };
    vm.runInNewContext(DISPATCH_HELPERS, context);
    const action = context.applyAi([x], ctx, 'auto');
    await started;
    assert.equal(stored.length, 1, 'the hold is saved before answer dispatch settles');
    assert.equal(stored[0].origin.documentId, 'doc-0');
    if (scenario === 'intake-replaced') {
      state.intake = { record: { replacement: true } }; scope = 'replacement-intake';
      context.discardAiSuggestions();
    } else if (scenario === 'intake-cleared') {
      state.intake = null; scope = null; state.aiCache.clear();
    } else state.aiCache.clear();
    if (scenario === 'transport-error') fail(new Error('settlement unavailable'));
    else release([{ frameId: 0, documentId: 'doc-0', result: [{ key: x.key, label: x.label, ok: true, shown: 'No' }] }]);
    await action;
    assert.equal(stored.length, 1, `${scenario}: no lost or duplicated pending record`);
    assert.equal(stored[0].scope, 'original-intake');
    assert.equal(context.pendingAi(1, '/quote').length, 1, `${scenario}: Continue still waits`);
    assert.equal(state.filled.size, 0, 'stale execution does not update the replacement intake bookkeeping');
    state.aiCache.clear(); scope = 'replacement-intake';
    await context.restoreAiPending();
    assert.equal(context.pendingAi(1, '/quote').length, 1, 'the physical quote hold survives reload under a new intake');
    assert.equal(stored.some(value => Object.hasOwn(value, 'record') || Object.hasOwn(value, 'contextKey')), false);
  }
});

test('a trusted correction before Reject settles the originating automatic choice', async () => {
  const x = { key: 'choice', done: 'auto', rejected: false,
    origin: { frameId: 0, documentId: 'doc-0', questionHash: JSON.stringify(['choice', 'Choice']), fieldHash: 'expected' } };
  const state = { tab: { id: 1 }, aiCache: new Map([['1\nQuote', x]]) };
  const context = { state, aiQuestionHash: value => JSON.stringify([value.key, value.label]), persistAiPending: async () => {} };
  vm.runInNewContext(['aiDecisionBlocks', 'pendingAi', 'settleRejectedAi'].map(extractFunction).join('\n'), context);
  assert.equal(await context.settleRejectedAi('Quote', [{ key: 'choice', label: 'Choice' }], { frameId: 0, documentId: 'doc-0' }), true);
  assert.equal(x.manual, true);
  x.rejected = true;
  assert.equal(context.pendingAi(1, 'Quote').length, 0, 'Reject cannot reinstate a hold on an already trusted correction');
});

function quoteRetirementHarness() {
  const url = 'https://example.test/quote?id=one', intake = { record: {} };
  const x = { key: 'choice', done: 'auto', rejected: true, quoteHash: JSON.stringify(url),
    origin: { frameId: 0, documentId: 'original-doc', questionHash: 'question', fieldHash: 'value' } };
  const other = { ...x };
  const state = { intake, tab: { id: 1, url }, aiCache: new Map([['1\n/quote', x], ['2\n/quote', other]]),
    agentKeys: new Map([['/quote', new Set(['choice'])]]) };
  let saved = 0;
  const context = { state, aiFingerprint: JSON.stringify, aiRetiredSignatures: new Set(),
    persistAiPending: async () => { saved++; }, persistAgentKeys: async () => {},
    aiDocumentGone: async () => false, runKit: async () => [] };
  vm.runInNewContext(['aiOriginRecord', 'aiDecisionBlocks', 'pendingAi', 'retireAiOrigins'].map(extractFunction).join('\n'), context);
  return { state, context, x, other, ctx: { tabId: 1, tabUrl: url, intake, carrier: {} }, saved: () => saved };
}

test('retirement distinguishes replacement documents from changed answers and isolates quotes', async () => {
  const live = quoteRetirementHarness();
  assert.equal(await live.context.retireAiOrigins(live.ctx, [{ frameId: 0, documentId: 'original-doc', result: 'changed value' }]), false);
  assert.equal(live.context.pendingAi(1, '/quote').length, 1, 'a changed answer in the same document still requires review');
  const replaced = quoteRetirementHarness();
  assert.equal(await replaced.context.retireAiOrigins(replaced.ctx, [{ frameId: 0, documentId: 'replacement-doc' }]), true);
  assert.equal(replaced.context.pendingAi(1, '/quote').length, 0);
  assert.equal(replaced.state.aiCache.get('2\n/quote'), replaced.other, 'another tab is untouched');
  assert.equal(replaced.x.approved, undefined, 'retirement cannot approve an answer');
  const otherQuote = quoteRetirementHarness();
  otherQuote.state.tab.url = 'https://example.test/quote?id=two';
  assert.equal(otherQuote.context.pendingAi(1, '/quote').length, 0, 'normalized page names cannot inherit another quote hold');
  assert.equal(await otherQuote.context.retireAiOrigins({ ...otherQuote.ctx, tabUrl: otherQuote.state.tab.url }, []), true);
});

test('missing frame results do not retire a hold without explicit document-gone proof', async () => {
  const h = quoteRetirementHarness();
  h.x.origin.frameId = 2;
  const frames = [{ frameId: 0, documentId: 'top-doc' }];
  assert.equal(await h.context.retireAiOrigins(h.ctx, frames), false);
  assert.equal(h.context.pendingAi(1, '/quote').length, 1);
  h.context.aiDocumentGone = async () => true;
  assert.equal(await h.context.retireAiOrigins(h.ctx, frames), true);
});

test('stale retirement snapshots cannot remove a replacement intake or cached decision', async () => {
  for (const change of ['intake', 'url', 'cache']) {
    const h = quoteRetirementHarness();
    let release;
    h.context.runKit = () => new Promise(resolve => { release = resolve; });
    const action = h.context.retireAiOrigins(h.ctx);
    if (change === 'intake') h.state.intake = { record: {} };
    if (change === 'url') h.state.tab.url = 'https://example.test/quote?id=two';
    if (change === 'cache') h.state.aiCache.set('1\n/quote', { ...h.x });
    release([{ frameId: 0, documentId: 'replacement-doc' }]);
    assert.equal(await action, false);
    assert.equal(h.state.aiCache.has('1\n/quote'), true);
    assert.equal(h.saved(), 0);
  }
});

test('reloading an intake drops settled ledger entries without losing unresolved holds', async () => {
  const record = {}, scope = 'same-intake';
  const manualSig = '1\n/quote\ngpt-6-luna\npolicy\ncontext\nmanual';
  const pendingSig = '1\n/quote\ngpt-6-luna\npolicy\ncontext\npending';
  const manual = { key: 'manual', label: 'Manual', choice: 'Yes', done: 'auto', manual: true };
  const pending = { key: 'pending', label: 'Pending', choice: 'No', done: 'auto' };
  const state = { intake: { record }, tabSessions: new Map(), layoutPending: null, aiCache: new Map([[manualSig, manual], [pendingSig, pending]]) };
  let stored = [];
  const context = { state, DEFAULT_MODEL: 'gpt-6-luna', POLICY_VERSION: 'policy',
    aiFingerprint: JSON.stringify, aiSafeText: String, aiPersistQueue: Promise.resolve(), aiRetiredSignatures: new Set(),
    aiPendingStore: { get: async () => stored, set: async value => { stored = value; } },
    usage: { currentSession: () => ({ intakeId: scope }), startSession: () => ({ intakeId: scope }), log() {} },
    $: () => ({}), clearTimeout() {}, pdfjs: {}, readIntakeFields: async () => ({ synthetic: true }), readIntakePlaces: async () => null, keepPdf: async () => {},
    normalizeIntake: () => ({ record, warnings: [] }), intakeSummary: async () => ({ intakeId: scope }),
    store: { set: async () => {} }, doneRestored: new Set(['same-intake|1']), pruneAgentRecords: async () => [], testIntakes: { get: async () => [] }, logSettings: async () => {}, platformOf: () => ({ os: null, chrome: null }), uploadNow() {},
    profileTimer: null, logProfile: () => false,
    save: async () => {}, render() {}, refreshTab() {}, reviewClaimsBox() {}, reviewIntake() {}, dropReports() {}, clientNote() {} };
  vm.runInNewContext(['aiOriginRecord', 'aiCacheSignature', 'aiPendingRecord', 'aiDecisionBlocks',
    'persistAiPending', 'restoreAiPending', 'discardAiSuggestions', 'cancelLayouts', 'holdLayouts', 'resetViews', 'saveViews', 'firstView', 'loadFile', 'keepWork', 'workSaid'].map(extractFunction).join('\n'), context);
  await context.persistAiPending();
  assert.equal(stored.length, 2, 'the previous ledger contains the settled and unresolved decisions');
  await context.loadFile({ name: 'synthetic.pdf', arrayBuffer: async () => new ArrayBuffer(1) });
  assert.equal(state.aiCache.has(manualSig), false, 'the old manual decision cannot suppress a fresh unresolved question');
  assert.equal(state.aiCache.get(pendingSig), pending, 'the existing unresolved hold keeps its identity');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, 'pending');
  assert.equal(context.doneRestored.size, 0, 'the intake\'s done actions may be restored again (its records are kept now)');
});

// 2026-10-05 FL run: after the first vehicle's Add Vehicle was continued, the second and third
// vehicles' (same headings) were taken for the agent going back, and Continue wasn't clicked.
test('a continued step is remembered per vehicle on vehicle pages, per driver on the driver page, quote-wide elsewhere', () => {
  const progressive = { vehicleList: 'VehicleSummary', driverList: 'DriverSummary', vehiclePages: ['MostCommonVehicles', 'AddVehicle'], driverPage: 'AddDriver' };
  const state = { active: { vehicles: 0, drivers: 0 }, doneSteps: new Set(), autoPaused: false, tab: { carrier: progressive } };
  const watched = [];
  const context = { state, $: () => ({ checked: false }), scheduleAutoFill: () => {}, setTimeout: () => {}, watchNextStep: (...args) => watched.push(args), persistDoneActions: () => {} };
  vm.runInNewContext(extractFunction('stepScope') + extractFunction('afterFill'), context);
  const continued = (page, stepKey) => context.afterFill([{ advanced: 'Continue', signatureBefore: 'before', stepKey }], { carrier: progressive, page });
  continued('AddVehicle', 'Vehicle Information / Common Questions');
  continued('BusinessOwnerInfo', 'Named Insured');
  continued('AddDriver', 'Driver');
  assert.deepEqual([...state.doneSteps], ['AddVehicle|v0|Vehicle Information / Common Questions', 'BusinessOwnerInfo||Named Insured', 'AddDriver|d0|Driver']);
  assert.equal(watched[0][3], 'AddVehicle|v0|Vehicle Information / Common Questions', 'the lost-Continue retry uses the same entry');
  const remembered = (page) => [...state.doneSteps].filter((s) => s.startsWith(context.stepScope(page, progressive))).length;
  assert.equal(remembered('AddVehicle'), 1, 'back on the first vehicle: not continued again');
  state.active.vehicles = 1;
  assert.equal(remembered('AddVehicle'), 0, 'the next vehicle is a new step');
  state.active.drivers = 1;
  assert.equal(remembered('BusinessOwnerInfo'), 1, 'a picker change never makes a page the agent left new again');
  assert.equal(remembered('AddDriver'), 0, 'the next driver is a new step');
  // One-address applications (AmWINS) keep one entry per page and step, whatever the active row.
  assert.equal(context.stepScope('Step', {}), 'Step||');
});

// OK live run, 2026-10-07: Progressive had filled the owner's driver page itself (nothing to fill,
// four answers kept), so the driver wasn't counted as entered and the driver list added it again.
test('a driver is entered once the driver list comes back from its page, filled or already there', async () => {
  const progressive = { driverPage: 'AddDriver', driverList: 'DriverSummary' };
  const state = { active: { drivers: 0 }, doneActions: new Set(), doneSteps: new Set(), autoPaused: false, intake: { record: { drivers: [{}, {}] } } };
  const context = { state, $: () => ({ checked: false }), scheduleAutoFill: () => {}, setTimeout: () => {}, watchNextStep: () => {}, persistDoneActions: () => {}, save: async () => {}, renderPickers: () => {} };
  vm.runInNewContext(['stepScope', 'afterFill', 'verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem', 'unitArrival'].map(extractFunction).join('\n'), context);
  // Codex on PR #43: answers on the page alone (one may have failed, or the page was left) don't count.
  context.afterFill([{ filled: [], kept: [{ label: 'Driver Last Name' }] }], { carrier: progressive, page: 'AddDriver' });
  assert.ok(!state.doneActions.has('driverEntered:0'));
  context.unitArrival(progressive, 'AddDriver', 'DriverSummary');
  assert.ok(state.doneActions.has('driverEntered:0'), 'continued: the list comes back from it');
  await context.pickListItem(progressive, 'DriverSummary');
  assert.equal(state.active.drivers, 1, 'the next driver');
  // Add Driver opened for the next one and left: not entered.
  state.doneActions.add('addDriver:1');
  await context.pickListItem(progressive, 'DriverSummary');
  assert.equal(state.active.drivers, 1);
  assert.ok(!state.doneActions.has('driverEntered:1'));
});

// TN live run, 2026-10-07: the first intake trailer. Its pages are per trailer, its page marks it
// entered, and the vehicle list then works on the next trailer not entered yet.
test('trailers: their own page scope, entered once their page is filled, the next one picked on the list', async () => {
  const carrier = { vehicleList: 'VehicleSummary', vehiclePages: ['MostCommonVehicles', 'AddVehicle'], trailerList: 'VehicleSummary', trailerPages: ['MostCommonTrailers', 'AddTrailer'], trailerPage: 'AddTrailer', driverPage: 'AddDriver' };
  const record = { vehicles: [{}], trailers: [{}, {}], drivers: [{}] };
  const state = { active: { drivers: 0, vehicles: 0, trailers: 0 }, doneActions: new Set(['lookupVin:0', 'addTrailer:0']), doneSteps: new Set(), autoPaused: false, intake: { record } };
  let persisted = 0;
  const context = { state, $: () => ({ checked: false }), scheduleAutoFill: () => {}, setTimeout: () => {}, watchNextStep: () => {}, save: async () => {}, renderPickers: () => {}, persistDoneActions: () => { persisted++; } };
  vm.runInNewContext(['stepScope', 'afterFill', 'verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem', 'unitArrival'].map(extractFunction).join('\n'), context);
  assert.equal(context.stepScope('AddTrailer', carrier), 'AddTrailer|tr0|');
  assert.equal(context.stepScope('MostCommonTrailers', carrier), 'MostCommonTrailers|tr0|');
  // Codex on PR #43: Add Trailer opened isn't the trailer entered (an unsupported tile, left), nor
  // answers filled on its page (one may have failed): only the list coming back from it.
  await context.pickListItem(carrier, 'VehicleSummary');
  assert.equal(state.active.trailers, 0, 'still the first trailer');
  context.afterFill([{ filled: [{ label: 'VIN' }], kept: [] }], { carrier, page: 'AddTrailer' });
  context.unitArrival(carrier, 'AddTrailer', 'MostCommonTrailers');
  assert.ok(!state.doneActions.has('trailerEntered:0'), 'filled, or gone back to the tiles: not entered');
  context.unitArrival(carrier, 'AddTrailer', 'VehicleSummary');
  assert.ok(state.doneActions.has('trailerEntered:0'));
  assert.ok(persisted > 0, 'kept for a panel reload');
  await context.pickListItem(carrier, 'VehicleSummary');
  assert.equal(state.active.trailers, 1, 'the next trailer not entered');
  assert.equal(state.active.vehicles, 0, 'the vehicle stays');
});

// Codex on PR #43: coming back to the list (Back, the top menu) is no proof; the list showing the
// trailer's VIN is. Progressive lists each unit on the quote with its VIN.
test('a trailer is on the quote when the vehicle list shows its VIN', async () => {
  const carrier = { trailerList: 'VehicleSummary', vehicleList: 'VehicleSummary', trailerPage: 'AddTrailer' };
  const record = { vehicles: [{ vin: '1XPWD40X1DD000001' }], trailers: [{ vin: '1W1MAFZB0KA000002' }], drivers: [] };
  const run = async (doneActions, shown) => {
    const state = { tab: { id: 3 }, intake: { record }, active: { vehicles: 0, trailers: 0, drivers: 0 }, doneActions: new Set(doneActions) };
    const asked = [];
    const context = { state, persistDoneActions: () => {}, save: async () => {}, renderPickers: () => {},
      runKit: async (tabId, c, func, args) => { asked.push(args[0]); return [{ result: shown }]; } };
    vm.runInNewContext(['verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem'].map(extractFunction).join('\n'), context);
    await context.pickListItem(carrier, 'VehicleSummary');
    return { done: state.doneActions, asked };
  };
  // Listed: entered, whatever the return looked like.
  let r = await run(['lookupVin:0', 'addTrailer:0'], [true, true]);
  assert.ok(r.done.has('trailerEntered:0'));
  assert.deepEqual(JSON.parse(JSON.stringify(r.asked)), [['1XPWD40X1DD000001', '1W1MAFZB0KA000002']]);
  // Back from Add Trailer (marked on the return), the list shows the truck's VIN but not the trailer's: not entered.
  r = await run(['lookupVin:0', 'addTrailer:0', 'trailerEntered:0'], [true, false]);
  assert.ok(!r.done.has('trailerEntered:0'));
  // A list that shows no VINs at all proves nothing: the return decides.
  r = await run(['lookupVin:0', 'addTrailer:0', 'trailerEntered:0'], [false, false]);
  assert.ok(r.done.has('trailerEntered:0'));
});

// Codex on PR #43: the panel closed while the agent finished a driver's page misses the return; the
// driver list showing the driver's name counts.
test('a driver the driver list shows by name is entered', async () => {
  const carrier = { driverList: 'DriverSummary', driverPage: 'AddDriver' };
  const record = { vehicles: [], trailers: [], drivers: [{ first: 'Jordan', last: 'Sample' }, { first: 'Casey', last: 'Example' }] };
  const state = { tab: { id: 3 }, intake: { record }, active: { vehicles: 0, trailers: 0, drivers: 1 }, doneActions: new Set(['driverEntered:0', 'addDriver:1']) };
  const context = { state, persistDoneActions: () => {}, save: async () => {}, renderPickers: () => {},
    runKit: async () => [{ result: [true, true] }] };
  vm.runInNewContext(['verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem'].map(extractFunction).join('\n'), context);
  await context.pickListItem(carrier, 'DriverSummary');
  assert.ok(state.doneActions.has('driverEntered:1'), 'listed: entered');
  // Not shown proves nothing (the list may write the name another way): markers stay.
  context.runKit = async () => [{ result: [false, false] }];
  await context.pickListItem(carrier, 'DriverSummary');
  assert.ok(state.doneActions.has('driverEntered:0'));
});

// Codex on PR #43: one row with a name two intake drivers share would count for both, and the
// second driver would never be added. Such a name (or one inside another's) proves nothing.
test('a driver name another intake driver shares is not taken as entered', async () => {
  const carrier = { driverList: 'DriverSummary', driverPage: 'AddDriver' };
  const record = { vehicles: [], trailers: [], drivers: [
    { first: 'Jordan', last: 'Sample' }, { first: 'Jordan', last: 'Sample' },
    { first: 'Mary Ann', last: 'Lee' }, { first: 'Ann', last: 'Lee' }, { first: 'Casey', last: 'Example' },
  ] };
  const state = { tab: { id: 3 }, intake: { record }, active: { vehicles: 0, trailers: 0, drivers: 0 }, doneActions: new Set() };
  const asked = [];
  // Every name asked about is on the list (as the page's listed() would say for a shown row).
  const context = { state, persistDoneActions: () => {}, save: async () => {}, renderPickers: () => {},
    runKit: async (tabId, c, func, args) => { asked.push(args[0]); return [{ result: args[0].map((n) => n.length >= 2) }]; } };
  vm.runInNewContext(['verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem'].map(extractFunction).join('\n'), context);
  await context.pickListItem(carrier, 'DriverSummary');
  assert.deepEqual(JSON.parse(JSON.stringify(asked[0])), [[], [], ['Mary Ann', 'Lee'], [], ['Casey', 'Example']]);
  assert.deepEqual([...state.doneActions].sort(), ['driverEntered:2', 'driverEntered:4']);
  assert.equal(state.active.drivers, 0, 'the first Jordan Sample is still to add');
});

// Codex on PR #43: the agent switched tabs while the list was read: the answer is the old tab's.
test('a list read for one tab is not applied after the agent switched tabs', async () => {
  const carrier = { trailerList: 'VehicleSummary', vehicleList: 'VehicleSummary', trailerPage: 'AddTrailer' };
  const record = { vehicles: [{ vin: '1XPWD40X1DD000001' }], trailers: [{ vin: '1W1MAFZB0KA000002' }], drivers: [] };
  const state = { tab: { id: 3 }, intake: { record }, active: { vehicles: 0, trailers: 0, drivers: 0 }, doneActions: new Set(['lookupVin:0']) };
  const context = { state, persistDoneActions: () => {}, save: async () => {}, renderPickers: () => {},
    runKit: async () => { state.tab = { id: 4 }; return [{ result: [true, true] }]; } };
  vm.runInNewContext(['verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem'].map(extractFunction).join('\n'), context);
  await context.pickListItem(carrier, 'VehicleSummary');
  assert.ok(!state.doneActions.has('trailerEntered:0'));
});

// Live run 2026-10-10: the agent ran the VIN lookup on Add Vehicle themselves, and on Vehicle
// Summary the automatic fill clicked Add Vehicle for the same vehicle again. A vehicle back from
// its own pages that the list shows by its VIN is on the quote: no Add Vehicle for it. The VIN
// alone isn't enough (audit 2026-10-10): the list also shows the vehicles the USDOT lookup found,
// which are added only with Add Vehicle.
test('a vehicle back from its pages that the summary lists by its VIN counts as added', async () => {
  const carrier = { trailerList: 'VehicleSummary', vehicleList: 'VehicleSummary', vehiclePages: ['MostCommonVehicles', 'AddVehicle'] };
  const record = { vehicles: [{ vin: '1XPWD40X1DD000001' }, { vin: '1FTBR3X87MKA00002' }], trailers: [], drivers: [] };
  const state = { tab: { id: 3 }, intake: { record }, active: { vehicles: 0, trailers: 0, drivers: 0 }, doneActions: new Set() };
  const context = { state, persistDoneActions: () => {}, save: async () => {}, renderPickers: () => {},
    runKit: async () => [{ result: [true, true] }] };
  vm.runInNewContext(['verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem', 'unitArrival'].map(extractFunction).join('\n'), context);
  // Both VINs shown (the USDOT lookup's list), neither vehicle's page visited: still to add.
  await context.pickListItem(carrier, 'VehicleSummary');
  assert.deepEqual([...state.doneActions], []);
  assert.equal(state.active.vehicles, 0);
  // The agent added the first one themselves (its VIN lookup on Add Vehicle) and came back.
  context.unitArrival(carrier, 'AddVehicle', 'VehicleSummary');
  context.unitArrival(carrier, 'DriverSummary', 'VehicleSummary');
  await context.pickListItem(carrier, 'VehicleSummary');
  assert.deepEqual([...state.doneActions].sort(), ['addVehicle:0', 'lookupVin:0', 'vehicleReturned:0']);
  assert.equal(state.active.vehicles, 1, 'the second vehicle is the one to add');
  // Back from the second one's pages, but the list doesn't show its VIN: proves nothing.
  context.runKit = async () => [{ result: [true, false] }];
  context.unitArrival(carrier, 'AddVehicle', 'VehicleSummary');
  await context.pickListItem(carrier, 'VehicleSummary');
  assert.ok(!state.doneActions.has('addVehicle:1') && !state.doneActions.has('lookupVin:1'));
  // Shown now: added.
  context.runKit = async () => [{ result: [true, true] }];
  await context.pickListItem(carrier, 'VehicleSummary');
  assert.ok(state.doneActions.has('lookupVin:1') && state.doneActions.has('addVehicle:1'));
});

// Codex on PR #43: a panel closed or reloaded mid-quote must not add a vehicle or trailer again.
test('done actions are kept per intake and tab, restored once after a reload', async () => {
  const memoryStore = {};
  const tab = { id: 7 };
  const session = { intakeId: 'intake-a' };
  const make = () => {
    const state = { tab, doneActions: new Set() };
    const context = { state, usage: { currentSession: () => session }, Promise, Set,
      doneActionsStore: { get: async (scope, tabId) => memoryStore[`${scope}:${tabId}`] ?? [], set: async (scope, tabId, ids) => { memoryStore[`${scope}:${tabId}`] = ids; } }, doneActionsQueue: Promise.resolve(),
      unitFormsStore: { get: async () => null } };
    vm.runInNewContext(`var doneActionsQueue = Promise.resolve();\n${SIDEPANEL.match(/const doneRestored = new Set\(\);/)[0]}\n` + ['persistDoneActions', 'restoreDoneActions'].map(extractFunction).join('\n'), context);
    return context;
  };
  const before = make();
  before.state.doneActions = new Set(['lookupVin:0', 'trailerEntered:0']);
  await before.persistDoneActions();
  const after = make();
  await after.restoreDoneActions(7);
  assert.deepEqual([...after.state.doneActions].sort(), ['lookupVin:0', 'trailerEntered:0']);
  after.state.doneActions.delete('lookupVin:0');
  await after.restoreDoneActions(7);
  assert.ok(!after.state.doneActions.has('lookupVin:0'), 'restored once: a later arrival keeps the panel\'s own set');
  session.intakeId = 'intake-b';
  const other = make();
  await other.restoreDoneActions(7);
  assert.equal(other.state.doneActions.size, 0, 'another intake starts clean');
  // Codex on PR #43: another tab's record is its own key; writing one never drops the other.
  session.intakeId = 'intake-a';
  const otherTab = make();
  otherTab.state.tab = { id: 8 };
  otherTab.state.doneActions = new Set(['trailerEntered:0']);
  await otherTab.persistDoneActions();
  const back = make();
  await back.restoreDoneActions(7);
  assert.deepEqual([...back.state.doneActions].sort(), ['lookupVin:0', 'trailerEntered:0'], 'tab 7 kept');
});

// W43-39 (2026-10-22): opened again three times on one quote, the panel came back with no report.
// Each tab's reports are kept in storage.session (the panel's `store`) as the fill results they were
// made from, and made again from them on reopen. `memory`: the store's contents.
function keptReportsHarness(memory, { session = { intakeId: 'intake-a' }, state = {} } = {}) {
  const rendered = [];
  const context = {
    state: { tab: { id: 7, carrier: { id: 'progressive' } }, intake: { record: {} }, reports: new Map(), ...state },
    usage: { currentSession: () => session },
    store: { get: async (k) => structuredClone(memory[k]), set: async (k, v) => { memory[k] = structuredClone(v); }, remove: async (k) => { delete memory[k]; }, keys: async () => Object.keys(memory) },
    firstUnits: () => ({ vehicles: 0, drivers: 0, trailers: 0 }),
    buildPlan: (record, carrier, active) => [{ drivers: active.drivers }],
    renderReport: (frames, ctx) => rendered.push({ frames, ctx }), refreshAnswers: () => rendered.push('refreshAnswers'),
  };
  const block = SIDEPANEL.slice(SIDEPANEL.indexOf("const REPORTS_PREFIX = 'reports:';"), SIDEPANEL.indexOf('let reportsQueue = Promise.resolve();'));
  vm.runInNewContext(`${block}\nvar reportsQueue = Promise.resolve();\n${['keepReport', 'forgetKeptReports', 'restoreReports'].map(extractFunction).join('\n')}\nglobalThis.kept = () => reportsQueue;`, context);
  return { context, rendered };
}

test('each quote tab keeps its last reports for the intake, as the fill results they were made from (W43-39)', async () => {
  const memory = {};
  const session = { intakeId: 'intake-a' };
  const { context } = keptReportsHarness(memory, { session });
  const frame = { fields: 2, filled: [{ label: 'First name', shown: 'A' }], kept: [], stepKey: 'Drivers', layout: { fields: [] }, progress: 3 };
  context.keepReport(7, { key: '7|AddDriver|d1', page: 'AddDriver', active: { drivers: 1 }, at: 100, stopped: false, frames: [frame] });
  await context.kept();
  assert.deepEqual(memory['reports:7'], { scope: 'intake-a', entries: [{ key: '7|AddDriver|d1', page: 'AddDriver', active: { drivers: 1 }, at: 100, stopped: false,
    frames: [{ fields: 2, filled: [{ label: 'First name', shown: 'A' }], kept: [], stepKey: 'Drivers' }] }] }, 'only the parts a report is made from');
  // A page filled again replaces its report, now the newest; the last 30 are kept.
  for (let i = 0; i < 31; i++) context.keepReport(7, { key: `7|Page${i}`, page: `Page${i}`, active: {}, at: 200 + i, stopped: false, frames: [{ fields: 1 }] });
  context.keepReport(7, { key: '7|Page30', page: 'Page30', active: {}, at: 300, stopped: true, frames: [{ fields: 1 }] });
  await context.kept();
  const entries = memory['reports:7'].entries;
  assert.equal(entries.length, 30);
  assert.deepEqual([entries[0].key, entries.at(-2).key, entries.at(-1).key, entries.at(-1).at, entries.at(-1).stopped], ['7|Page1', '7|Page29', '7|Page30', 300, true]);
  // Another tab keeps its own; another intake's start over; no intake or no tab keeps nothing.
  context.keepReport(8, { key: '8|Drivers', page: 'Drivers', active: {}, at: 400, stopped: false, frames: [{ fields: 1 }] });
  await context.kept();
  assert.equal(memory['reports:7'].entries.length, 30);
  assert.deepEqual(memory['reports:8'].entries.map((e) => e.key), ['8|Drivers']);
  session.intakeId = 'intake-b';
  context.keepReport(7, { key: '7|Drivers', page: 'Drivers', active: {}, at: 500, stopped: false, frames: [{ fields: 1 }] });
  await context.kept();
  assert.deepEqual([memory['reports:7'].scope, memory['reports:7'].entries.map((e) => e.key)], ['intake-b', ['7|Drivers']]);
  session.intakeId = null;
  context.keepReport(7, { key: '7|Other', page: 'Other', active: {}, at: 600, stopped: false, frames: [{ fields: 1 }] });
  session.intakeId = 'intake-b';
  context.keepReport(undefined, { key: 'x', page: 'Other', active: {}, at: 600, stopped: false, frames: [{ fields: 1 }] });
  await context.kept();
  assert.deepEqual(Object.keys(memory).sort(), ['reports:7', 'reports:8']);
  assert.equal(memory['reports:7'].entries.length, 1);
  // Within about 512 KB a tab (the store also holds the intake and its PDF): the oldest go first.
  const big = (i) => ({ key: `7|Big${i}`, page: `Big${i}`, active: {}, at: 700 + i, stopped: false, frames: [{ fields: 1, filled: [{ label: 'Note', shown: 'x'.repeat(200 * 1024) }] }] });
  for (let i = 0; i < 4; i++) context.keepReport(7, big(i));
  await context.kept();
  assert.deepEqual(memory['reports:7'].entries.map((e) => e.key), ['7|Big2', '7|Big3']);
  context.keepReport(7, { ...big(4), frames: [{ fields: 1, filled: [{ label: 'Note', shown: 'x'.repeat(600 * 1024) }] }] });
  await context.kept();
  assert.deepEqual(memory['reports:7'].entries.map((e) => e.key), ['7|Big4'], 'the newest stays');
});

test('the panel opened again makes the tab\'s kept reports again, as of their fill, then checks the one in front against the page (W43-39)', async () => {
  const memory = { 'reports:7': { scope: 'intake-a', entries: [
    { key: '7|Drivers', page: 'Drivers', active: { drivers: 0 }, at: 100, stopped: false, frames: [{ fields: 1 }] },
    { key: '7|AddDriver|d1', page: 'AddDriver', active: { drivers: 1 }, at: 200, stopped: true, frames: [{ fields: 2 }] },
    { key: '7|Shown', page: 'Shown', at: 300, frames: [{ fields: 1 }] },
    { key: '8|Elsewhere', page: 'Elsewhere', at: 400, frames: [{ fields: 1 }] },
  ] } };
  const { context, rendered } = keptReportsHarness(memory, { state: { reports: new Map([['7|Shown', { key: '7|Shown' }]]) } });
  await context.restoreReports(7);
  const said = () => rendered.map((r) => (r === 'refreshAnswers' ? r : [r.ctx.keptKey, r.ctx.page, r.ctx.restoredAt, r.ctx.stopped, r.ctx.active.drivers, r.ctx.active.vehicles, r.ctx.plan[0].drivers, r.frames[0].fields]));
  assert.deepEqual(said(), [
    ['7|Drivers', 'Drivers', 100, false, 0, 0, 0, 1],
    ['7|AddDriver|d1', 'AddDriver', 200, true, 1, 0, 1, 2],
    'refreshAnswers',
  ], 'a report made since the panel opened is newer, and another tab\'s is never this one\'s');
  await context.restoreReports(7);
  assert.equal(rendered.length, 3, 'made again once: a later visit keeps what the panel has');
  // Another intake's, or a tab no longer in front: nothing.
  const other = keptReportsHarness(memory, { session: { intakeId: 'intake-b' } });
  await other.context.restoreReports(7);
  const moved = keptReportsHarness(memory, { state: { tab: { id: 9, carrier: { id: 'progressive' } } } });
  await moved.context.restoreReports(7);
  const none = keptReportsHarness({});
  await none.context.restoreReports(7);
  assert.deepEqual([other.rendered.length, moved.rendered.length, none.rendered.length], [0, 0, 0]);
  // A tab first shown off the rater gets them once it shows the rater.
  const later = keptReportsHarness(memory, { state: { tab: { id: 7, carrier: null } } });
  await later.context.restoreReports(7);
  assert.equal(later.rendered.length, 0);
  later.context.state.tab.carrier = { id: 'progressive' };
  await later.context.restoreReports(7);
  assert.equal(later.rendered.length, 4, 'all three reports, then the check against the page');
  // The panel's tab switch makes them again after the tab's other records.
  assert.match(extractFunction('refreshTab'), /await restoreDoneActions\(state\.tab\?\.id\);\n\s+await restoreReports\(state\.tab\?\.id\);/);
});

test('kept reports go with the shown ones: a closed tab\'s, a cleared page\'s, all for a new or cleared client (W43-39)', async () => {
  const memory = { intake: { kept: true },
    'reports:7': { scope: 'intake-a', entries: [{ key: '7|A', page: 'A' }, { key: '7|B', page: 'B' }] },
    'reports:8': { scope: 'intake-a', entries: [{ key: '8|A', page: 'A' }] } };
  const { context } = keptReportsHarness(memory);
  context.forgetKeptReports((e) => e.tabId === 8);
  await context.kept();
  assert.deepEqual(Object.keys(memory).sort(), ['intake', 'reports:7']);
  context.forgetKeptReports((e) => e.key === '7|A');
  await context.kept();
  assert.deepEqual(memory['reports:7'].entries.map((e) => e.key), ['7|B']);
  context.forgetKeptReports(() => true);
  await context.kept();
  assert.deepEqual(Object.keys(memory), ['intake'], 'the intake itself stays');
  assert.match(extractFunction('dropReports'), /forgetKeptReports\(drop\);/);
});

test('a fill\'s report is kept for the panel opened again; one made again from it keeps its key and time and moves no step (W43-39)', () => {
  const kept = [];
  const state = { tab: { id: 7, url: 'AddDriver' }, active: { drivers: 1 }, tabSteps: new Map() };
  const { context } = reportHarness(state, { keepReport: (tabId, saved) => kept.push({ tabId, saved }), knownStep: (carrier, key) => key ?? null });
  const frame = { fields: 1, filled: [{ label: 'Zip Code', shown: '21000' }], kept: [], failed: [], noData: [], leftRequired: [], actions: [] };
  context.renderReport([frame], { tabId: 7, page: 'AddDriver' });
  assert.equal(kept.length, 1);
  assert.deepEqual([kept[0].tabId, kept[0].saved.key, kept[0].saved.page, kept[0].saved.active.drivers, kept[0].saved.stopped], [7, '7|AddDriver', 'AddDriver', 1, false]);
  assert.equal(kept[0].saved.frames[0], frame);
  assert.ok(!state.reportFor.restored);
  // Answers filled while Continue is tried again in a moment: kept too. The silent one isn't.
  context.renderReport([frame], { tabId: 7, page: 'AddDriver', retrying: true });
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [], notDrawn: true }], { tabId: 7, page: 'AddDriver', retrying: true });
  assert.equal(kept.length, 2);
  context.renderReport([{ ...frame, stepKey: 'Drivers' }], { tabId: 7, page: 'AddDriver', keptKey: '7|AddDriver|Drivers', restoredAt: 1234 });
  assert.equal(kept.length, 2, 'one made again from what was kept isn\'t kept again');
  assert.deepEqual([state.reportFor.key, state.reportFor.at, state.reportFor.restored], ['7|AddDriver|Drivers', 1234, true]);
  assert.equal(state.tabSteps.size, 0, 'an earlier step\'s report leaves the tab\'s step');
  // A panel opened again doesn't keep the pause, so a stop made again doesn't say it.
  const halted = { fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [], halted: true, reason: 'The page changed.' };
  context.renderReport([halted], { tabId: 7, page: 'AddDriver' });
  assert.equal(state.reportFor.error, 'Automatic filling and helpers paused. The page changed.');
  context.renderReport([halted], { tabId: 7, page: 'AddDriver', keptKey: '7|AddDriver', restoredAt: 1234 });
  assert.equal(state.reportFor.error, 'The page changed.');
});

test('a Luna request waiting for a follow-up fill belongs to its tab', async () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'CoveragesRates'), carrier: { id: 'progressive' } };
  h.state.assistPage = 'CoveragesRates';
  h.setActiveTab(quoteTab(2, 'CoveragesRates'));
  await h.refreshTab();
  assert.equal(h.state.assistPage, null, 'another quote on the same page starts without it');
  h.state.assistPage = null;
  h.setActiveTab(quoteTab(1, 'CoveragesRates'));
  await h.refreshTab();
  assert.equal(h.state.assistPage, 'CoveragesRates', 'back on the first quote it is still waiting');
});

test('each quote tab keeps its own active vehicle and driver', async () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'AddVehicle'), carrier: { id: 'progressive' } };
  h.state.active = { drivers: 0, vehicles: 2, trailers: 0 };
  h.setActiveTab(quoteTab(2, 'AddVehicle'));
  await h.refreshTab();
  h.state.active.vehicles = 0;
  h.setActiveTab(quoteTab(1, 'AddVehicle'));
  await h.refreshTab();
  assert.equal(h.state.active.vehicles, 2, 'the first quote is back on its own vehicle');
  h.setActiveTab(quoteTab(2, 'AddVehicle'));
  await h.refreshTab();
  assert.equal(h.state.active.vehicles, 0);
});

// Codex on PR #21: on a page of tiles only, the vehicle-type note was hidden by "No form fields".
test('a page without form fields still shows what needs the agent', () => {
  const state = { tab: { id: 7, url: 'MostCommonVehicles' } };
  const { context, box } = reportHarness(state);
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [],
    noData: [{ label: 'Vehicle type', key: null, note: 'Tanker isn\'t matched to a Progressive tile yet: pick the vehicle yourself.' }] }]);
  const text = JSON.stringify(box.children);
  assert.match(text, /Vehicle type/);
  assert.match(text, /pick the vehicle yourself/);
  assert.equal(state.reportFor.notice, undefined);
  // A page that should have questions and has none yet (pagekit notDrawn), filled again: said empty.
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [], notDrawn: true }]);
  assert.match(state.reportFor.notice, /No questions found on this page/, 'an empty page is still said to be empty (in step 2)');
  assert.equal(state.reportFor.empty, undefined);
  // One with no question for the fill (a unit list, every unit on it) is done (W43-40).
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [] }]);
  assert.equal(state.reportFor.notice, 'Nothing to fill on this page.');
  assert.equal(state.reportFor.empty, true);
});

function assistHarness({ suggest, cfg = {}, record = { vehicles: [] } } = {}) {
  const logged = [], rendered = [], applied = [];
  const node = (tag, props = {}, ...children) => ({ tag, props, children: children.flat(), isConnected: true,
    replaceChildren(...next) { this.children = next; }, remove() { this.isConnected = false; }, before() {} });
  const report = { append(child) { child.isConnected = true; this.children = [...(this.children ?? []), child]; }, querySelector: () => null };
  const state = { intake: { record }, active: { drivers: 0, vehicles: 0 }, tab: { id: 1, url: 'https://rater.test/Default.aspx?pageName=CoveragesRates' },
    aiRun: 0, aiCache: new Map(), aiSettingsRun: 0, aiAsking: new Map(), agentKeys: new Map(), filling: false };
  const context = {
    state, assistContextKey, pageOf: (url) => new URL(url).searchParams.get('pageName'), h: node, $: () => report,
    aiSettings: async () => ({ on: true, apiKey: 'synthetic', ready: true, model: 'gpt-6-luna', provider: 'luna', auto: false, ...cfg }),
    PROVIDERS: { luna: { name: 'Luna', policy: 'synthetic-policy' } },
    collectItems: () => ({ items: [{ key: '1FF9', label: '2016 FREIGHTLINER CASCADIA 125' }], blocked: [] }),
    aiSettledOnPage: () => false, aiFingerprint: (v) => JSON.stringify(v), aiItemFingerprint: (x) => `${x.key}|${x.label}`,
    aiCacheSignature: (x) => JSON.stringify(x), runKit: async () => [{ frameId: 0, result: 'snapshot' }],
    suggest, AssistError: class extends Error {}, usage: { log: (...events) => logged.push(...events) },
    renderAi: (...args) => rendered.push(args), applyAi: async (...args) => { applied.push(args); return false; },
    syncAiBanner: () => {}, pendingAi: () => [], pageAnswers, redactor: () => (s) => s, redactionTerms: () => [],
  };
  vm.runInNewContext(extractFunction('aiActionCurrent') + extractFunction('leaveCounts') + extractFunction('runAssist'), context);
  const ctx = { tabId: 1, page: 'CoveragesRates', carrier: { id: 'progressive' } };
  return { state, context, ctx, report, logged, rendered, applied, holder: () => report.children.at(-1) };
}

// 2026-10-05 FL run: Luna answered in 17 s, but the page had changed meanwhile; the panel kept
// "Asking Luna about 14 questions…" on screen for minutes.
test('an AI answer that arrives after the page changed replaces the waiting message and is still logged', async () => {
  const answer = { suggestions: [{ key: '1FF9', label: '2016 FREIGHTLINER CASCADIA 125', leave: true }], tokensIn: 10, tokensOut: 2, modelCalls: 1 };
  const t = assistHarness({ suggest: async () => {
    t.state.tab = { ...t.state.tab, url: 'https://rater.test/Default.aspx?pageName=CoveragesRates-Reload' };
    return answer;
  } });
  await t.context.runAssist([{}], t.ctx);
  const text = JSON.stringify(t.holder().children);
  assert.match(text, /Luna: it answered after the tab or page changed, so nothing was applied\. Click Fill this page to ask again\./);
  assert.doesNotMatch(text, /Asking/);
  assert.equal(t.rendered.length, 0, 'stale suggestions are never shown as current');
  assert.equal(t.state.aiCache.size, 0, 'nor cached');
  assert.equal(t.logged[0].type, 'ai_suggest');
  assert.equal(t.logged[0].tokensIn, 10, 'the spent tokens are logged');
  assert.equal(t.logged[0].error, 'Answer discarded: the tab or page changed.');
  // The same answer while the page is unchanged is shown.
  const fresh = assistHarness({ suggest: async () => answer });
  await fresh.context.runAssist([{}], fresh.ctx);
  assert.equal(fresh.rendered.length, 1);
  assert.equal(fresh.logged[0].error, undefined);
});

// 2026-10-27: Luna sees the page's other answers (as the agent does), and the log says why questions
// were left, as counts.
test('Luna gets the page’s other answers from the snapshot, and the log counts why questions were left', async () => {
  let sent;
  const why = ['missing', 'unverified', 'unverified', 'chose', null];
  const t = assistHarness({ suggest: async (items, context) => {
    sent = context;
    return { suggestions: why.map((leaveWhy, i) => ({ key: `k${i}`, label: `Q${i}`, leave: !!leaveWhy, leaveWhy })), tokensIn: 1, tokensOut: 1, modelCalls: 1 };
  } });
  t.context.runKit = async () => [{ frameId: 0, result: JSON.stringify(['https://rater.test/', [
    { key: 'liab', label: 'Liability limit', kind: 'select', current: '$1,000,000 CSL' },
    { key: 'typed', label: 'Years in business', kind: 'text', current: '7' },
    { key: '1FF9', label: '2016 FREIGHTLINER CASCADIA 125', kind: 'select', current: null },
  ]]) }];
  await t.context.runAssist([{}], t.ctx);
  assert.deepEqual(sent.pageAnswers, [{ label: 'Liability limit', answer: '$1,000,000 CSL' }], 'choice answers only, not the questions asked or typed values');
  const { leaveMissing, leaveConflict, leaveChose, leaveNoSource, leaveUnverified, leave } = t.logged[0];
  assert.deepEqual({ leave, leaveMissing, leaveConflict, leaveChose, leaveNoSource, leaveUnverified },
    { leave: 4, leaveMissing: 1, leaveConflict: 0, leaveChose: 1, leaveNoSource: 0, leaveUnverified: 2 });
});

// 2026-10-09 to 10-26: 12 of 58 page reviews ended "The page or intake changed", most on GEICO's
// quote page: a fill of the same page redrew the report and asked Luna again while it answered,
// so its answer was thrown away and the same questions were asked (and paid for) twice.
const lunaAnswer = { suggestions: [{ key: '1FF9', label: '2016 FREIGHTLINER CASCADIA 125', choice: 'Yes', autoOk: false }], tokensIn: 10, tokensOut: 2, modelCalls: 1 };
function lunaCalls(answers = [lunaAnswer]) {
  const calls = [];
  const suggest = (items, context, cfg, opts) => new Promise((resolve, reject) => calls.push({ items, opts, resolve: () => resolve(answers[calls.length - 1] ?? lunaAnswer), reject }));
  return { calls, suggest };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
// What a fill's renderReport does to the report on screen: the holder is no longer in it.
const redraw = (t) => { for (const child of t.report.children ?? []) child.isConnected = false; t.report.children = []; };

test('a Luna answer that comes after a fill of the same page redrew it is kept, and the newer request shows it without asking again', async () => {
  const luna = lunaCalls();
  const t = assistHarness({ suggest: luna.suggest });
  const first = t.context.runAssist([{}], t.ctx);
  await settle();
  assert.equal(luna.calls.length, 1);
  // The fill redraws the report and asks about the same page again.
  redraw(t);
  const second = t.context.runAssist([{}], t.ctx);
  await settle();
  assert.equal(luna.calls.length, 1, 'the same questions are not asked twice while the first request answers them');
  assert.equal(luna.calls[0].opts.isStale(), false, 'Luna is not stopped between its calls for a newer request of the same page');
  assert.match(JSON.stringify(t.holder().children), /Asking Luna about 1 question left for you/);
  luna.calls[0].resolve();
  await Promise.all([first, second]);
  assert.equal(t.logged.length, 1);
  assert.equal(t.logged[0].error, undefined, 'the answer is used, not discarded');
  assert.equal(t.state.aiCache.size, 1, 'and cached');
  assert.equal(t.rendered.length, 1, 'shown once, in the redrawn report');
  const [holder, suggestions, ctx] = t.rendered[0];
  assert.equal(holder, t.holder());
  assert.equal(holder.isConnected, true);
  assert.deepEqual(suggestions.map((x) => x.choice), ['Yes']);
  // Applying it checks the newer request's own page snapshot and run (applyAi).
  assert.equal(ctx.run, t.state.aiRun);
  assert.equal(ctx.snapshots[0].result, 'snapshot');
});

test('a Luna answer that comes after the report was redrawn is cached, and the next Fill shows it without asking again', async () => {
  const luna = lunaCalls();
  const t = assistHarness({ suggest: luna.suggest });
  const first = t.context.runAssist([{}], t.ctx);
  await settle();
  redraw(t);
  luna.calls[0].resolve();
  await first;
  assert.equal(t.logged[0].error, undefined);
  assert.equal(t.state.aiCache.size, 1);
  assert.equal(t.rendered.length, 0, 'never shown in a report that is gone');
  await t.context.runAssist([{}], t.ctx);
  assert.equal(luna.calls.length, 1, 'asked once');
  assert.equal(t.rendered.length, 1);
});

test('a Luna answer is still discarded when the driver/vehicle, page or assistant settings changed while it answered', async () => {
  const record = { vehicles: [{ year: 2016 }, { year: 2019 }] };
  for (const [scenario, change, error] of [
    ['vehicle', (t) => { t.state.active = { ...t.state.active, vehicles: 1 }; }, 'Answer discarded: the intake or driver/vehicle changed.'],
    ['intake', (t) => { t.state.intake = { record: { ...record } }; }, 'Answer discarded: the tab or page changed.'],
    ['page', (t) => { t.state.tab = { ...t.state.tab, url: 'https://rater.test/Default.aspx?pageName=ChangePaymentPlan' }; }, 'Answer discarded: the tab or page changed.'],
    ['settings', (t) => { t.state.aiSettingsRun = ++t.state.aiRun; t.state.aiAsking.clear(); }, 'Answer discarded: the assistant settings changed.'],
  ]) {
    const luna = lunaCalls();
    const t = assistHarness({ suggest: luna.suggest, record });
    const first = t.context.runAssist([{}], t.ctx);
    await settle();
    change(t);
    redraw(t);
    assert.equal(luna.calls[0].opts.isStale(), true, `${scenario}: Luna stops between its calls`);
    luna.calls[0].resolve();
    await first;
    assert.equal(t.logged[0].error, error, scenario);
    assert.equal(t.state.aiCache.size, 0, `${scenario}: nothing cached`);
    assert.equal(t.state.aiAsking.size, 0, `${scenario}: nothing left waiting`);
    assert.equal(t.rendered.length, 0, `${scenario}: nothing shown`);
  }
});

test('a newer request that waited for a Luna request that failed asks the questions itself', async () => {
  const luna = lunaCalls();
  const t = assistHarness({ suggest: luna.suggest });
  const first = t.context.runAssist([{}], t.ctx);
  await settle();
  redraw(t);
  const second = t.context.runAssist([{}], t.ctx);
  await settle();
  luna.calls[0].reject(new t.context.AssistError('Luna is rate-limited. Try again shortly.'));
  await first;
  await settle();
  assert.equal(luna.calls.length, 2);
  luna.calls[1].resolve();
  await second;
  assert.equal(t.rendered.length, 1);
  assert.equal(t.state.aiAsking.size, 0);
});

test('Luna waits for the follow-up fill of a helper it clicked, and is not asked about a page the fill left', async () => {
  const asked = [];
  const state = { assistPage: null, tab: { id: 1 }, tabSessions: new Map() };
  const context = { state, runAssist: (frames, ctx) => asked.push(ctx.page) };
  vm.runInNewContext(extractFunction('assistAfterFill'), context);
  context.assistAfterFill([{ actions: [{ id: 'openCargo' }] }], { tabId: 1, page: 'CoveragesRates' }, true);
  assert.deepEqual(asked, []);
  assert.equal(state.assistPage, 'CoveragesRates', 'held for the follow-up fill');
  context.assistAfterFill([{ navigatedTo: 'ChangePaymentPlan' }], { tabId: 1, page: 'CoveragesRates' }, false);
  assert.deepEqual(asked, [], 'the bill plan opened: nothing to ask about this page');
  assert.equal(state.assistPage, null);
  context.assistAfterFill([{}], { tabId: 1, page: 'CoveragesRates' }, false);
  assert.deepEqual(asked, ['CoveragesRates']);
  // Codex on PR #21: the agent switched to another quote tab while this fill ran.
  const other = { assistPage: null };
  state.tab = { id: 2 };
  state.tabSessions.set(1, other);
  context.assistAfterFill([{ actions: [{ id: 'openCargo' }] }], { tabId: 1, page: 'CoveragesRates' }, true);
  assert.equal(state.assistPage, null, 'the visible tab is untouched');
  assert.equal(other.assistPage, 'CoveragesRates', 'its own tab waits');
  context.assistAfterFill([{}], { tabId: 1, page: 'CoveragesRates' }, false);
  assert.deepEqual(asked, ['CoveragesRates'], 'Luna is not asked about a tab in the background');
});

test('the follow-up fill a Luna request waited for asks it, even with nothing unfamiliar left', async () => {
  const run = async (followUp) => {
    const frames = [{ fields: 2, filled: [], actions: [], unknown: [], noData: [{ key: 'k', label: 'Cargo limit' }], halted: false }];
    const rendered = [], assisted = [];
    const state = { tab: { id: 1, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, active: {}, agentKeys: new Map(), layoutReadyTabs: new Set(),
      autoPaused: false, filling: false, assistPage: 'Rates' };
    const context = { watchFill: () => () => {},
      state, Date, crypto, rulesVersion: null, $: () => ({ checked: false }), pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options,
      runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {}, renderReport: (result) => rendered.push(result),
      recordLayout: () => {}, fillEvents: () => [], redactionTerms: () => [], redactor: () => (s) => s, usage: { log: () => {}, currentSession: () => null },
      runAssist: (result, ctx) => assisted.push(ctx.page), pickListItem: async () => {}, noteMissingUnit: () => {}, retireAiOrigins: async () => {},
      afterFill: () => followUp, runPendingPage: () => {}, viewOf: () => 't1',
    };
    context.reportKey = () => 'k'; state.reports = new Map([['k', {}]]);
  context.renderSteps ??= () => {};
  vm.runInNewContext(extractFunction('assistAfterFill') + extractFunction('autoFill'), context);
    await context.autoFill('Rates');
    return { rendered: rendered.length, assisted, assistPage: state.assistPage };
  };
  assert.deepEqual(await run(false), { rendered: 1, assisted: ['Rates'], assistPage: null });
  assert.deepEqual(await run(true), { rendered: 1, assisted: [], assistPage: 'Rates' }, 'another follow-up is coming: still held');
});

// PR #17 review, on Luna: the in-flight marker is taken before the first await (two triggers
// close together ask once), a replaced intake never gets the result, and a failed review is
// visible on Check intake and tried again only when the assistant settings change.
function claimsHarness() {
  const logs = [], requests = [];
  const gates = [];
  const t = { logs, requests, reply: 'ok', onRequest: null };
  const state = { intake: null, notesAsking: null, notesRetry: null };
  class AssistError extends Error {}
  const context = {
    state, AssistError, Date, stableJson, redactor: () => (s) => s, redactionTerms: () => [], claimsTruncated: (text) => /LONG/.test(text ?? ''), intakeNotes,
    aiSettings: async () => ({ on: !state.offline, apiKey: 'k', ready: true, model: 'gpt-6-luna' }),
    reviewNotes: async (record, cfg, opts) => {
      requests.push({ record, opts, reply: t.reply });
      const reply = t.reply;
      await new Promise((resolve) => gates.push(resolve));
      if (reply === 'fail') throw new AssistError('Luna took too long. Nothing was applied.');
      return { warnings: [{ code: 'ai.ntl', level: 'check', path: 'coverage.ntl', msg: 'x' }], lines: 1, flagged: 1, tokensIn: 5, tokensOut: 1, modelCalls: 1, reasoningTokens: 0, cachedTokens: 2, cacheWriteTokens: 1 };
    },
    usage: { log: (e) => logs.push(e) }, save: async () => {}, render: () => {},
  };
  vm.runInNewContext(extractFunction('claimsContext') + extractFunction('supersedeClaimsItems') + extractFunction('reviewClaimsBox'), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Lets the oldest pending request answer, then lets the panel finish with it.
  t.answer = async () => { await settle(); gates.shift()(); for (let i = 0; i < 5; i++) await settle(); };
  return Object.assign(t, { state, review: context.reviewClaimsBox, settle });
}
const claimsIntake = (text) => ({ record: { claims: { text }, coverage: { cargo: true, ntl: null } }, warnings: [{ code: 'other', level: 'check' }], done: [] });

test('Luna reads the claims box once per intake, visibly fails, and retries on a settings change', async () => {
  const t = claimsHarness();
  const intake = claimsIntake('Leased on, needs coverage off dispatch');
  t.state.intake = intake;
  const first = t.review();
  t.review();
  assert.equal(t.state.notesAsking, intake, 'taken before the settings were read');
  await t.answer();
  await first;
  assert.equal(t.requests.length, 1, 'two triggers close together ask once');
  assert.equal(typeof t.requests[0].opts.redact, 'function', 'names are redacted before the request');
  assert.deepEqual(intake.warnings.map((w) => w.code), ['other', 'ai.ntl']);
  assert.deepEqual(Object.keys(t.logs[0]).sort(), ['cacheWriteTokens', 'cachedTokens', 'items', 'leave', 'model', 'modelCalls', 'ms', 'page', 'reasoningTokens', 'suggested', 'tokensIn', 'tokensOut', 'type'], 'counts only, never the text');
  await t.review({ retry: true });
  assert.equal(t.requests.length, 1, 'once per intake');

  // A failure is a Check intake item, not silence; a plain reload doesn't ask again.
  const failing = claimsIntake('Needs physical damage');
  failing.done = [0];
  t.state.intake = failing;
  t.reply = 'fail';
  t.review();
  await t.answer();
  assert.deepEqual(failing.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.claims-review-failed', 'check']]);
  assert.match(failing.warnings[1].msg, /Read them for coverage requests/);
  assert.equal(t.logs.at(-1).error, 'Luna took too long. Nothing was applied.');
  await t.review();
  assert.equal(t.requests.length, 2, 'not retried on every panel reload');
  // A settings change tries again; the failure item is replaced in place (checked marks are by position).
  t.reply = 'ok';
  t.review({ retry: true });
  await t.answer();
  assert.deepEqual(failing.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.claims-reviewed', 'info'], ['ai.ntl', 'check']]);
  assert.deepEqual(failing.done, [0]);
});

// Windows smoke on PR #72 (mock:luna, 2026-10-10): chrome.storage gives objects back with their
// keys sorted. The panel reopening on the same intake took that order for a coverage edit, retired
// Luna's items, sent the claims box again and saved the intake over a change made meanwhile.
test('reopening the panel on a reviewed intake neither re-reads the claims box nor retires its items', async () => {
  const t = claimsHarness();
  const intake = { record: { claims: { text: 'Leased on, needs coverage off dispatch' },
    coverage: { autoLiability: 'Yes', autoLiabLimit: '$1M CSL', cargo: true, cargoLimit: 100000, gl: false, glLimit: null, ntl: null, hasGl: null } },
  warnings: [{ code: 'other', level: 'check' }], done: [] };
  t.state.intake = intake;
  const first = t.review();
  await t.answer();
  await first;
  assert.equal(t.requests.length, 1);
  // What chrome.storage.session hands the reopened panel: the same values, keys in sorted order.
  const sortedKeys = (v) => (Array.isArray(v) ? v.map(sortedKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortedKeys(v[k])])) : v);
  const reopened = sortedKeys(JSON.parse(JSON.stringify(intake)));
  assert.notEqual(JSON.stringify(reopened.record.coverage), JSON.stringify(intake.record.coverage), 'the round trip reorders the keys');
  t.state.intake = reopened;
  // Not awaited: a request sent again would wait for its answer.
  t.review();
  for (let i = 0; i < 5; i++) await t.settle();
  assert.equal(t.requests.length, 1, 'the box is not sent again');
  assert.equal(JSON.stringify(sortedKeys(reopened.notesReview)), JSON.stringify(sortedKeys(intake.notesReview)), 'the review stands');
  assert.deepEqual(reopened.warnings.map((w) => w.code), ['other', 'ai.ntl'], 'Luna\'s item is not retired');
  // Client has GL answers Luna's own question: no change to the box either.
  reopened.record.coverage.hasGl = true;
  t.review();
  for (let i = 0; i < 5; i++) await t.settle();
  assert.equal(t.requests.length, 1, 'Client has GL is no coverage edit');
  // A real coverage edit still counts.
  reopened.record.coverage.cargoLimit = 50000;
  t.review();
  await t.settle();
  assert.equal(t.requests.length, 2, 'an edited coverage is read again');
  assert.equal(reopened.warnings[1].code, 'ai.claims-superseded');
  await t.answer();
});

// Codex on PR #22.
test('a settings change during a review runs it again, an edit during it discards the answer, a replaced intake logs nothing', async () => {
  // The key is corrected while the old-key request is still out: tried again once it fails.
  let t = claimsHarness();
  const intake = claimsIntake('Needs physical damage');
  t.state.intake = intake;
  t.reply = 'fail';
  t.review();
  await t.settle();
  t.reply = 'ok';
  await t.review({ retry: true });
  assert.equal(t.requests.length, 1, 'one request at a time');
  await t.answer();
  assert.equal(t.requests.length, 2, 'the queued retry runs once the first ends');
  await t.answer();
  assert.equal(intake.notesReview.done, true);
  assert.deepEqual(intake.warnings.map((w) => w.code), ['other', 'ai.claims-reviewed', 'ai.ntl']);

  // The agent edits the claims box while Luna reads the old text: that answer is dropped, the
  // new text is read. Setting NTL itself (not sent to Luna) doesn't count as a change.
  t = claimsHarness();
  const edited = claimsIntake('Needs physical damage');
  t.state.intake = edited;
  t.review();
  await t.settle();
  edited.record.coverage.ntl = true;
  edited.record.claims.text = 'Needs hired auto';
  await t.answer();
  assert.equal(t.logs[0].error, 'Answer discarded: the claims box or coverages changed.');
  assert.equal(edited.notesReview, undefined, 'not marked reviewed');
  assert.deepEqual(edited.warnings.map((w) => w.code), ['other'], 'no warning from the old text');
  assert.equal(t.requests.length, 2, 'the new text is read');
  assert.equal(t.requests[1].record.claims.text, 'Needs hired auto');
  await t.answer();
  assert.equal(edited.notesReview.done, true);
  const untouched = claimsHarness();
  const ntlOnly = claimsIntake('NTL please');
  untouched.state.intake = ntlOnly;
  untouched.review();
  await untouched.settle();
  ntlOnly.record.coverage.ntl = true;
  await untouched.answer();
  assert.equal(untouched.requests.length, 1, 'setting NTL is not a change to what Luna read');
  assert.equal(ntlOnly.notesReview.done, true);

  // A request for an intake that was replaced meanwhile: no result and nothing logged.
  for (const reply of ['ok', 'fail']) {
    t = claimsHarness();
    const old = claimsIntake('NTL please');
    t.state.intake = old;
    t.reply = reply;
    t.review();
    await t.settle();
    t.state.intake = claimsIntake('');
    await t.answer();
    assert.deepEqual(old.warnings.map((w) => w.code), ['other'], reply);
    assert.equal(old.notesReview, undefined, reply);
    assert.equal(t.logs.length, 0, `${reply}: not attributed to the new intake`);
  }
});

// Codex on PR #22: an edit after a finished review is read again; Luna's old items are replaced in place.
test('the claims box is reviewed again after the agent edits what Luna read', async () => {
  const t = claimsHarness();
  const intake = claimsIntake('Needs physical damage');
  t.state.intake = intake;
  t.review();
  await t.answer();
  assert.deepEqual(intake.warnings.map((w) => w.code), ['other', 'ai.ntl']);
  intake.done = [1];
  await t.review();
  assert.equal(t.requests.length, 1, 'unchanged: not read again');
  intake.record.coverage.ntl = true;
  await t.review({ retry: true });
  assert.equal(t.requests.length, 1, 'setting NTL is not a change to what Luna read');
  intake.record.claims.text = 'Needs physical damage\nNeeds hired auto';
  t.review({ retry: true });
  await t.answer();
  assert.equal(t.requests.length, 2, 'the edited box is read again');
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.claims-superseded', 'info'], ['ai.ntl', 'check']],
    'the old item is replaced in place (checked marks are by position), the new one added');
  assert.deepEqual(intake.done, [1]);
});

// PR #95: the Additional Notes box is part of what Luna read. Editing it retires Luna's items and
// reads again; an intake without the box (saved before it existed) keeps its review context.
test('editing the Additional Notes box retires Luna\'s items and reads again', async () => {
  const t = claimsHarness();
  const intake = claimsIntake('No');
  intake.record.notes = { text: 'Needs physical damage' };
  t.state.intake = intake;
  t.review();
  await t.answer();
  assert.deepEqual(intake.warnings.map((w) => w.code), ['other', 'ai.ntl']);
  intake.record.notes.text = 'Needs physical damage\nNeeds hired auto';
  t.review({ retry: true });
  await t.answer();
  assert.equal(t.requests.length, 2, 'the edited notes are read again');
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.claims-superseded', 'info'], ['ai.ntl', 'check']]);
  // Only notes text changes the context: none, or a blank box, reads as before the box existed.
  const context = vm.runInNewContext(`${extractFunction('claimsContext')}; claimsContext`, { stableJson });
  const before = context({ claims: { text: 'No' }, coverage: { cargo: true } });
  assert.equal(context({ claims: { text: 'No' }, notes: { text: null }, coverage: { cargo: true } }), before);
  assert.notEqual(context({ claims: { text: 'No' }, notes: { text: 'Financed' }, coverage: { cargo: true } }), before);
});

test('a panel edit of the claims box or the Additional Notes box asks Luna again; other edits do not', async () => {
  const { get, set } = await import('../src/util.js');
  const { rederive } = await import('../src/normalize.js');
  const calls = [];
  const sandbox = {
    state: { intake: { record: { claims: { text: 'No' }, notes: { text: null }, applicant: {} }, warnings: [] } },
    get, set, rederive, document: { getElementById: () => null }, intakeEdited: () => {}, usage: { log: () => {} }, save: async () => {}, profileLater() {},
    claimsTextEdited: () => calls.push('claimsTextEdited'), reviewClaimsBox: () => calls.push('reviewClaimsBox'), reviewDriverGender: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('agentEdit'), sandbox);
  await sandbox.agentEdit('notes.text', 'Needs hired auto', 'textarea');
  assert.deepEqual(calls.splice(0), ['claimsTextEdited', 'reviewClaimsBox']);
  await sandbox.agentEdit('claims.text', 'Yes', 'textarea');
  assert.deepEqual(calls.splice(0), ['claimsTextEdited', 'reviewClaimsBox']);
  await sandbox.agentEdit('applicant.name', 'X', 'text');
  assert.deepEqual(calls, []);
});

// Codex on PR #22: an edit retires Luna's old items even when no new review can run.
test('editing what Luna read retires its items at once, also with the assistant off', async () => {
  const t = claimsHarness();
  const intake = claimsIntake('Needs physical damage');
  t.state.intake = intake;
  t.review();
  await t.answer();
  assert.deepEqual(intake.warnings.map((w) => w.code), ['other', 'ai.ntl']);
  intake.record.claims.text = 'Financed';
  t.state.offline = true;
  await t.review({ retry: true });
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.claims-superseded', 'info']]);
  assert.equal(t.requests.length, 1, 'no request without the assistant');
  assert.equal(intake.notesReview, null, 'read again once the assistant can');
});

// Codex on PR #22: the long-claims-box item is the code's own; a coverage edit doesn't retire it.
test('the long-claims-box item stays while the box is still too long, and isn\'t added twice', async () => {
  const t = claimsHarness();
  const intake = claimsIntake('LONG claims box');
  intake.warnings.push({ code: 'ai.claims-truncated', level: 'check', path: 'claims.text', msg: 'read the rest' });
  intake.notesReview = { done: true, context: JSON.stringify(['LONG claims box', { cargo: true }]) };
  t.state.intake = intake;
  t.state.offline = true;
  intake.record.coverage.cargo = false;
  await t.review({ retry: true });
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.claims-truncated', 'check']], 'kept with the assistant off');
  t.state.offline = false;
  const reviewing = t.review({ retry: true });
  await t.answer();
  await reviewing;
  assert.equal(intake.warnings.filter((w) => w.code === 'ai.claims-truncated').length, 1);
  intake.record.claims.text = 'short now';
  t.state.offline = true;
  await t.review({ retry: true });
  assert.ok(!intake.warnings.some((w) => w.code === 'ai.claims-truncated' && w.level === 'check'), 'retired once the box is short enough');
});

// Codex on PR #22: the intake's own NTL item and the checked long-box / failed-review items follow
// claims-box edits; Luna's NTL flag holds Rates; a done Add NTL survives a panel reload.
test('claims-box edits keep the NTL, long-box and failed-review items current', () => {
  const ntlCheckMessage = (line) => `NTL: ${line}`;
  const ntlMention = (text) => String(text ?? '').split('\n').find((l) => /\bntl\b|bobtail/i.test(l))?.trim() || null;
  const intake = { record: { claims: { text: 'No\nNeeds NTL' } }, done: [0, 1, 2],
    warnings: [{ code: 'coverage.ntl', path: 'coverage.ntl', level: 'check', msg: 'NTL: Needs NTL' },
      { code: 'ai.claims-truncated', level: 'check' }, { code: 'ai.claims-review-failed', level: 'check' }] };
  const context = { ntlMention, ntlCheckMessage, intakeNotes, save() {}, render() {} };
  vm.runInNewContext(`${extractFunction('claimsTextEdited')}\n${extractFunction('ntlNotesItem')}`, context);
  intake.record.claims.text = 'No\nNeeds bobtail off dispatch';
  context.claimsTextEdited(intake);
  assert.equal(intake.warnings[0].msg, 'NTL: Needs bobtail off dispatch', 'the quoted line follows the edit');
  assert.deepEqual(intake.done, [], 'all three are asked again for the new text');
  intake.done = [0];
  intake.record.claims.text = 'No\nFinanced';
  context.claimsTextEdited(intake);
  assert.deepEqual([intake.warnings[0].level, intake.warnings.length], ['info', 3], 'retired in place when NTL is no longer mentioned');
  intake.record.claims.text = 'No\nNTL please';
  context.claimsTextEdited(intake);
  assert.equal(intake.warnings.length, 3, 'the retired item is not reused');
  const fresh = { record: { claims: { text: 'No\nNTL please' } }, done: [], warnings: [] };
  context.claimsTextEdited(fresh);
  assert.deepEqual(fresh.warnings.map((w) => [w.code, w.level]), [['coverage.ntl', 'check']], 'an NTL mention added after load is asked');
});

test('Luna\'s NTL flag holds Rates until superseded, and a done Add NTL survives a panel reload', async () => {
  const t = claimsHarness();
  const intake = claimsIntake('Needs bobtale coverage');
  t.state.intake = intake;
  t.review();
  await t.answer();
  assert.equal(intake.record.claims.aiNtl, true, 'the plan sees the unresolved NTL flag');
  intake.record.claims.text = 'Financed';
  t.state.offline = true;
  await t.review({ retry: true });
  assert.equal(intake.record.claims.aiNtl, false, 'cleared with its item');
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'CoveragesRates'), carrier: { id: 'progressive' } };
  h.state.intake = { record: {} };
  h.rememberFill([{ actions: [{ id: 'addNtl' }], protectedKeys: [], filled: [] }]);
  assert.equal(h.state.intake.ntlAdded, true, 'kept with the intake (session storage), not only in memory');
});

// Codex on PR #21: on Add Vehicle (one vehicle at a time, the same field keys for each) an agent
// correction on the first vehicle must not leave the next vehicle's box unfilled.
test('agent edits are protected per vehicle on vehicle pages and per page elsewhere', async () => {
  const carrier = { vehiclePages: ['MostCommonVehicles', 'AddVehicle'], driverPage: 'AddDriver' };
  const state = { tab: { id: 1, url: 'AddVehicle', carrier }, active: { vehicles: 0, drivers: 0 }, agentKeys: new Map(), filling: false };
  const fills = [];
  const context = { state, persistAgentKeys: async () => {}, pageOf: (url) => url, fillPage: async () => fills.push(1), settleNeed() {} };
  vm.runInNewContext(extractFunction('markDone'), context);
  await context.markDone({}, '2091', 1, 'AddVehicle');
  assert.deepEqual([...state.agentKeys.keys()], ['AddVehicle|v0']);
  assert.equal(context.editScope('AddVehicle'), 'AddVehicle|v0');
  state.active.vehicles = 1;
  assert.equal(state.agentKeys.get(context.editScope('AddVehicle')), undefined, 'the next vehicle starts unprotected');
  assert.equal(context.editScope('CoveragesRates'), 'CoveragesRates', 'other pages keep their page key');
  state.tab.url = 'AddDriver';
  assert.equal(context.editScope('AddDriver'), 'AddDriver|d0');
});

// Codex on PR #21: a retired AI pick's protected key is removed from the vehicle it was made on.
test('a retired AI pick is unprotected in its own vehicle scope, not the active one', async () => {
  const carrier = { vehiclePages: ['MostCommonVehicles', 'AddVehicle'], driverPage: 'AddDriver' };
  const sig = '1\nAddVehicle\ngpt-6-luna\npolicy\ncontext\nitem\nquote-a';
  const pick = { key: '2CA7', done: 'auto', quoteHash: 'quote-a', editScope: 'AddVehicle|v0' };
  const state = { tab: { id: 1, url: 'https://rater.test/a', carrier }, intake: {}, active: { vehicles: 1, drivers: 0 },
    aiCache: new Map([[sig, pick]]), agentKeys: new Map([['AddVehicle|v0', new Set(['2CA7'])], ['AddVehicle|v1', new Set(['2CA7'])]]) };
  const context = { state, aiFingerprint: () => 'quote-b', aiOriginRecord: () => null, aiRetiredSignatures: new Set(),
    persistAiPending: async () => {}, persistAgentKeys: async () => {}, runKit: async () => [] };
  vm.runInNewContext(extractFunction('retireAiOrigins'), context);
  assert.equal(await context.retireAiOrigins({ tabId: 1, tabUrl: state.tab.url, intake: state.intake, carrier }), true);
  assert.deepEqual([...state.agentKeys.get('AddVehicle|v0')], [], 'removed where the pick was made');
  assert.deepEqual([...state.agentKeys.get('AddVehicle|v1')], ['2CA7'], 'the active vehicle\'s own protection is untouched');
});

// The layout recorder with stubs around it: `controls()` is what the page shows when captured.
function layoutHarness(controls, { session = 'quote-1' } = {}) {
  const logged = [];
  const record = { garaging: { state: 'FL' }, operations: { businessClass: 'Expediter' }, vehicles: [{ type: 'Cargo Van' }], trailers: [], drivers: [{}], coverage: {} };
  const context = {
    state: { tab: { id: 1, url: 'Vehicles', carrier: { id: 'progressive', layoutUrl: /./ } }, intake: { record }, active: {}, filling: false, intakeRevision: 0, layoutGeneration: 0, layoutHold: false, layoutReadyTabs: new Set(), layoutNewTabs: new Set(), layoutLatest: null, viewTabs: new Map(),
      lastLayouts: new Map(), layoutChain: Promise.resolve(), layoutTimer: null, layoutPending: null, layoutErrors: 0, layoutErrorsLogged: new Set(), stopScreens: new Map() },
    stopScreen, fillEvents, renderSite: () => { context.rendered = (context.rendered ?? 0) + 1; },
    // These carriers declare no quote-state control (the state warning has its own test).
    quoteStatePick: () => undefined, showStateNote: () => {},
    sha256Hex, buildPlan: () => [], redactionTerms: () => [], editScope: (page) => page, pageOf: (url) => url, onQuotePage: () => true,
    busy: false, runs: [],
    runKit: async (tabId, carrier, func) => {
      const source = String(func);
      context.runs.push(source.includes('busy') ? 'busy' : 'capture');
      if (source.includes('busy')) {
        if (context.busyError) throw context.busyError;
        return [{ result: context.busy }];
      }
      // The page as the page itself names it (pagekit's capture), normally the tab's.
      return [{ result: { controls: controls(), buttons: context.buttons ?? ['Continue'], isTopFrame: true, page: context.domPage ?? context.state.tab.url, step: context.domStep ?? '', messages: context.messages ?? [] } }];
    },
    sessionId: session,
    usage: { currentSession: () => (context.sessionId ? { id: context.sessionId } : null), log: (e) => logged.push(e) },
    store: { saved: {}, set(k, v) { this.saved[k] = v; return Promise.resolve(); } },
    LAYOUT_DELAY_MS: 0, setTimeout: (fn) => { context.pending = fn; return 1; }, clearTimeout: () => { context.pending = null; }, knownStep,
    // The premium hook (src/premium.js), noted here: its own tests are test/premium.test.mjs.
    premiumsSeen: new Map(), premiumCalls: [], notePremium: (o) => context.premiumCalls.push(o), premiumHere: () => true,
  };
  vm.runInNewContext(['viewOf', 'saveViews', 'resetViews', 'stepScope', 'recordLayout', 'layoutJob', 'jobCurrent', 'intakeEdited', 'sameLayoutScope', 'superseded', 'holdLayouts', 'captureLayout', 'noteStopScreen', 'waitForFill', 'layoutFailed', 'layoutErrorKind', 'scheduleLayout', 'cancelLayouts', 'layoutWhenQuiet']
    .map(extractFunction).join('\n'), context);
  return { context, logged };
}

test('a page layout is logged again when only its choices or required questions change', async () => {
  let controls;
  const { context, logged } = layoutHarness(() => controls);
  const distance = (options, extra = {}) => ({ q: '2B9D', kind: 'select', label: 'Farthest distance', required: false, options, ...extra });
  controls = [distance(['50 miles', '200 miles'])];
  await context.recordLayout('Vehicles');
  await context.recordLayout('Vehicles');
  // The same first choices, but the list grew past what a capture keeps.
  controls = [distance(['50 miles', '200 miles'], { optionsTruncated: true })];
  await context.recordLayout('Vehicles');
  controls = [distance(['50 miles', '200 miles', 'Unlimited'], { optionsTruncated: true })];
  await context.recordLayout('Vehicles');
  controls = [distance(['50 miles', '200 miles', 'Unlimited'], { optionsTruncated: true, required: true })];
  await context.recordLayout('Vehicles');
  // Codex on PR #43: the same number under another data-model name is a carrier rename.
  controls = [distance(['50 miles', '200 miles', 'Unlimited'], { optionsTruncated: true, required: true, ref: 'RiskInput.RadiusRenamed' })];
  await context.recordLayout('Vehicles');
  assert.equal(logged.length, 5, 'an unchanged layout once; a change of choices, cut, required or data-model name again');
  logged.pop();
  assert.deepEqual(logged.map((e) => [e.fields[0].options.length, !!e.fields[0].required, !!e.fields[0].optionsTruncated]),
    [[2, false, false], [2, false, true], [3, false, true], [3, true, true]]);
});

test('Yes, No, Yes on a question with a follow-up logs three layouts, with the picks and no staff names', async () => {
  let controls;
  const { context, logged } = layoutHarness(() => controls);
  const hazmat = (selected) => ({ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected });
  const placards = { q: '2A2', kind: 'text', label: 'Placards carried', pageHasValue: false };
  const producer = { q: '396', kind: 'select', label: 'Producer', options: [], selected: 'JANE DOE-1' };
  context.state.tab.url = 'Operations';
  for (const [answer, followUp] of [['Yes', true], ['No', false], ['Yes', true]]) {
    controls = [hazmat(answer), ...(followUp ? [placards] : []), producer];
    await context.recordLayout('Operations', 'changed');
  }
  assert.equal(logged.length, 3);
  assert.deepEqual(logged.map((e) => e.fields.map((f) => f.q)), [['2A1', '2A2', '396'], ['2A1', '396'], ['2A1', '2A2', '396']]);
  assert.deepEqual(logged.map((e) => e.fields[0].selected), ['Yes', 'No', 'Yes']);
  assert.ok(logged.every((e) => e.reason === 'changed' && e.fields.at(-1).selected === undefined));
  assert.equal(logged[0].fields[1].pageHasValue, false);
  // Picking another answer that changes nothing else logs nothing: the pick is in the change event.
  controls = [hazmat('No'), placards, producer];
  await context.recordLayout('Operations', 'changed');
  assert.equal(logged.length, 3);
});

test('layouts are taken as the page changes, without any fill, once the page is quiet', async () => {
  let controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  const fire = async () => { const fn = context.pending; context.pending = null; await fn?.(); await context.state.layoutChain; };
  // Changes close together make one capture with all their reasons.
  context.scheduleLayout('Vehicles', 'changed');
  context.scheduleLayout('Vehicles', 'appeared');
  await fire();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].reason, 'appeared+changed');

  // Still loading: asked again, then captured once quiet.
  controls = [...controls, { q: '2A2', kind: 'text', label: 'Placards carried' }];
  context.busy = true;
  context.scheduleLayout('Vehicles', 'removed');
  await fire();
  assert.equal(logged.length, 1);
  context.busy = false;
  await fire();
  assert.equal(logged.length, 2);
  assert.equal(logged[1].reason, 'removed');

  // A fill under way (here or in another tab, and it may fail without a layout): the capture
  // waits for it instead of being dropped.
  controls = [controls[0]];
  context.state.filling = true;
  context.scheduleLayout('Vehicles', 'changed');
  context.runs.length = 0;
  await fire();
  assert.deepEqual(context.runs, [], 'nothing read while the fill runs');
  assert.ok(context.pending, 'asked again later');
  await fire();
  assert.equal(logged.length, 2);
  context.state.filling = false;
  await fire();
  assert.deepEqual(logged.map((e) => e.reason), ['appeared+changed', 'removed', 'changed']);
  // A practice page: nothing scheduled.
  context.state.tab.carrier.practice = true;
  context.scheduleLayout('Vehicles', 'changed');
  assert.equal(context.pending, null);
});

test('a layout that cannot be read is counted and logged once per page and error', async () => {
  const { context, logged } = layoutHarness(() => { throw new Error('Frame with ID 0 was removed.'); });
  context.state.tab.url = 'Rates';
  await context.recordLayout('Rates', 'arrived');
  await context.recordLayout('Rates', 'changed');
  assert.equal(context.state.layoutErrors, 2);
  assert.deepEqual(logged.map((e) => [e.type, e.page, e.reason, e.error]), [['layout_error', 'Rates', 'arrived', 'frame gone']]);
});

test('with no fill at all, Yes, No, Yes on the page logs each change and the three layouts in order', async () => {
  let controls;
  const { context, logged } = layoutHarness(() => controls);
  Object.assign(context, {
    samePage: (p) => p, redactor: () => (s) => s, scheduleAutoFill: () => {},
    fieldChangeEvent: (c) => ({ type: 'field_change', q: c.q, from: c.before, to: c.after, by: 'page' }), knownStep,
  });
  Object.assign(context.state, { filled: new Map(), labels: new Map() });
  context.state.tab.url = 'Operations';
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  const sender = { tab: { id: 1 } };
  const fire = async () => { const fn = context.pending; context.pending = null; await fn?.(); await context.state.layoutChain; };
  const hazmat = (selected) => ({ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected });
  const placards = { q: '2A2', kind: 'text', label: 'Placards carried', pageHasValue: false };
  for (const [from, to, event] of [['', 'Yes', 'new_fields'], ['Yes', 'No', 'removed_fields'], ['No', 'Yes', 'new_fields']]) {
    controls = [hazmat(to), ...(event === 'new_fields' ? [placards] : [])];
    context.onRecorderMessage({ ra: 'usage', event: 'field_changes', page: 'Operations', changes: [{ key: '2A1', q: '2A1', before: from, after: to, agent: false }] }, sender);
    context.onRecorderMessage({ ra: 'usage', event, page: 'Operations', keys: ['2A2'] }, sender);
    await fire();
  }
  assert.deepEqual(logged.map((e) => e.type === 'page_layout' ? `layout:${e.fields.map((f) => f.q).join('+')}:${e.reason}` : `change:${e.to}`), [
    'change:Yes', 'layout:2A1+2A2:appeared+changed',
    'change:No', 'layout:2A1:changed+removed',
    'change:Yes', 'layout:2A1+2A2:appeared+changed',
  ]);
});

test('layout work for one quote is dropped once another intake is loaded or the client cleared', async () => {
  let controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  const fire = async () => { const fn = context.pending; context.pending = null; await fn?.(); await context.state.layoutChain; };
  // Waiting for the page to be quiet when the next intake loads.
  context.scheduleLayout('Vehicles', 'changed');
  const waiting = context.pending;
  context.cancelLayouts();
  context.sessionId = 'quote-2';
  await waiting();
  assert.equal(logged.length, 0);
  // Already capturing when the client is cleared: what comes back isn't logged.
  const job = context.layoutJob('Vehicles');
  context.runKit = async () => { context.sessionId = null; return [{ result: { controls, buttons: [] } }]; };
  await context.recordLayout('Vehicles', 'fill', job);
  // Queued under the old quote, run after the switch.
  context.sessionId = 'quote-3';
  await context.recordLayout('Vehicles', 'fill', job);
  assert.equal(logged.length, 0);
  assert.equal(context.state.layoutErrors, 0);
  await fire();
});

test('a page that cannot be asked whether it is quiet is counted like an unreadable layout', async () => {
  const { context, logged } = layoutHarness(() => []);
  context.busyError = new Error('Cannot access contents of the page.');
  context.scheduleLayout('Vehicles', 'arrived');
  await context.pending();
  assert.equal(context.state.layoutErrors, 1);
  assert.deepEqual(logged.map((e) => [e.type, e.reason, e.error]), [['layout_error', 'arrived', 'page not accessible']]);
  // The tab moved on meanwhile: nothing to report.
  context.runKit = async () => { context.state.tab.url = 'Drivers'; throw new Error('Frame was removed.'); };
  context.scheduleLayout('Vehicles', 'changed');
  await context.pending();
  assert.equal(context.state.layoutErrors, 1);
});

test('a layout keeps a pick only when it is one of the captured choices', async () => {
  const { context, logged } = layoutHarness(() => [
    { q: '2B1', kind: 'select', label: 'Make', options: ['FORD', 'ISUZU'], selected: 'FORD' },
    // An editable dropdown with text typed into it: not a choice from its list.
    { q: '2B2', kind: 'select', label: 'Model', options: ['NPR', 'NQR'], selected: 'Transit 250 typed' },
    { q: '2B3', kind: 'checkbox', label: 'Same as mailing', options: [], selected: 'checked' },
  ]);
  await context.recordLayout('Vehicles', 'changed');
  assert.deepEqual(logged[0].fields.map((f) => f.selected), ['FORD', undefined, 'checked']);
});

test('a queued capture is dropped when the tab, page or active vehicle changed before or while it reads', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  const kit = context.runKit;
  // Asked on Vehicles; the agent is on Drivers by the time the queue gets to it.
  const queued = context.layoutJob('Vehicles');
  context.state.tab.url = 'Drivers';
  await context.recordLayout('Vehicles', 'changed', queued);
  // Reading Vehicles when the panel switches to the second vehicle, or another tab.
  context.state.tab.url = 'Vehicles';
  context.runKit = async (...args) => { context.state.active = { vehicles: 1 }; return kit(...args); };
  await context.recordLayout('Vehicles', 'changed');
  context.state.active = {};
  context.runKit = async (...args) => { context.state.tab = { ...context.state.tab, id: 2 }; return kit(...args); };
  await context.recordLayout('Vehicles', 'changed');
  assert.deepEqual(logged, [], 'never logged under the page, vehicle or tab it was asked for');
});

test('reasons belong to the capture they were given to', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  const kit = context.runKit;
  // A capture for Vehicles is asking whether the page is quiet when the agent opens Drivers.
  context.scheduleLayout('Vehicles', 'changed');
  const vehicles = context.pending;
  context.runKit = async (...args) => {
    context.runKit = kit;
    context.state.tab.url = 'Drivers';
    context.scheduleLayout('Drivers', 'arrived');
    return kit(...args);
  };
  await vehicles();
  const drivers = context.pending;
  await drivers();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => [e.page, e.reason]), [['Drivers', 'arrived']], 'the old capture neither logs nor takes the new one\'s reasons');
  assert.equal(context.state.layoutPending, null);
});

test('a change in a child frame schedules the layout of the quote page around it', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  Object.assign(context, { samePage: (p) => p, redactor: () => (s) => s, scheduleAutoFill: () => {}, fieldChangeEvent: () => ({ type: 'field_change' }), knownStep });
  Object.assign(context.state, { filled: new Map(), labels: new Map() });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  context.onRecorderMessage({ ra: 'usage', event: 'new_fields', page: '/widgets/address-frame', keys: ['x'] }, { tab: { id: 1 }, frameId: 3 });
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => [e.type, e.page, e.reason]), [['page_layout', 'Vehicles', 'appeared']]);
});

// W44-11 (2026-10-26): GEICO's first step arrived before it drew its questions (6 of 8 quotes; the
// arrival read 0 fields), so "Fill each new page as soon as it opens" filled nothing until the agent
// clicked Fill (3–127 s). Such an arrival is filled when its questions show (new_fields), once; an
// arrival with fields is filled at once, as before, and with the setting off nothing is.
test('an arrival before its questions drew is filled when they show, once, with "Fill each new page" on', () => {
  const { context } = layoutHarness(() => []);
  const fills = [];
  let autoPages = true;
  Object.assign(context, { samePage: (p) => p, $: (id) => ({ checked: id === 'auto-pages' ? autoPages : false }), redactor: () => (s) => s,
    scheduleAutoFill: () => {}, fieldChangeEvent: () => ({ type: 'field_change' }), knownStep, stopNoteFor: () => null, scheduleLayout: () => {},
    fillPage: (o) => fills.push(o), setTimeout: (fn) => fn(), currentReportKey: () => 'k' });
  context.state.tab = { id: 1, url: '/quote', carrier: { ...geico, layoutUrl: /./ } };
  Object.assign(context.state, { visitedPages: new Set(), autoPages: new Set(), filled: new Map(), labels: new Map(), reports: new Map(), drawPending: null });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  const sender = { tab: { id: 1 } };
  const arrive = (page, fields = 0) => context.onRecorderMessage({ ra: 'usage', event: 'page_view', page, from: '/', fields }, sender);
  const drawn = (page = '/quote') => context.onRecorderMessage({ ra: 'usage', event: 'new_fields', page, keys: ['x'] }, sender);
  arrive('/quote');
  assert.equal(fills.length, 0, 'nothing to fill yet');
  drawn();
  assert.deepEqual(fills.map((o) => o.auto), ['page'], 'filled as on arriving');
  drawn();
  assert.equal(fills.length, 1, 'once: questions drawn later are the follow-ups\'');
  // Another page in between: that wait is over.
  arrive('/quote');
  context.state.tab.url = '/elsewhere';
  arrive('/elsewhere');
  context.state.tab.url = '/quote';
  drawn();
  assert.equal(fills.length, 1);
  // An arrival with its questions: filled at once, nothing waits.
  arrive('/quote', 7);
  assert.equal(fills.length, 2);
  drawn();
  assert.equal(fills.length, 2);
  // With the setting off: neither.
  autoPages = false;
  arrive('/quote');
  drawn();
  assert.equal(fills.length, 2);
});

test('layout errors are logged by kind, never with their message', () => {
  const { context } = layoutHarness(() => []);
  const kinds = ['Frame with ID 0 was removed.', 'No tab with id: 12.', 'Cannot access contents of url "https://example.test/quote?id=55501".',
    'globalThis.__raterKit is undefined', 'Unexpected value 1FTBR3X87MKA12345'].map((m) => context.layoutErrorKind(new Error(m)));
  assert.deepEqual(kinds, ['frame gone', 'tab gone', 'page not accessible', 'kit missing', 'other Error']);
  assert.equal(context.layoutErrorKind(new TypeError('x')), 'other TypeError');
  assert.equal(context.layoutErrorKind('a string with a VIN 1FTBR3X87MKA12345'), 'other');
});

test('a capture whose quote, page or vehicle changes while its layout is being compared is dropped', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  context.sha256Hex = async (text) => { context.state.active = { vehicles: 1 }; return sha256Hex(text); };
  await context.recordLayout('Vehicles', 'changed');
  context.state.active = {};
  context.sha256Hex = async (text) => { context.sessionId = 'quote-2'; return sha256Hex(text); };
  await context.recordLayout('Vehicles', 'changed');
  assert.deepEqual(logged, []);
});

test('a page still busy after the retries is counted, not silently dropped', async () => {
  const { context, logged } = layoutHarness(() => []);
  context.busy = true;
  context.scheduleLayout('Vehicles', 'changed');
  for (let i = 0; i < 6; i++) await context.pending();
  assert.equal(context.state.layoutErrors, 0, 'still waiting');
  await context.pending();
  assert.equal(context.state.layoutErrors, 1);
  assert.deepEqual(logged.map((e) => [e.type, e.reason, e.error]), [['layout_error', 'changed', 'page busy']]);
  assert.equal(context.state.layoutPending, null);
});

test('an arrival is captured even when the top frame has no fields of its own', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  Object.assign(context, { samePage: (p) => p, $: () => ({ checked: false }) });
  Object.assign(context.state, { visitedPages: new Set(), autoPages: new Set() });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  // The form is in child frames: the top frame reports the arrival with no fields.
  context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: 'Vehicles', from: 'Drivers', fields: 0 }, { tab: { id: 1 } });
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.filter((e) => e.type === 'page_layout').map((e) => [e.page, e.reason]), [['Vehicles', 'arrived']]);
});

test('picking another vehicle replaces a capture waiting for the previous one', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  context.scheduleLayout('Vehicles', 'arrived');
  context.state.active = { vehicles: 1 };
  context.scheduleLayout('Vehicles', 'picked');
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => e.reason), ['picked']);
  assert.match(SIDEPANEL, /state\.active\[list\] = i;[\s\S]{0,300}scheduleLayout\(pageOf\(state\.tab\?\.url\), 'picked'\)/, 'the vehicle/driver picker asks for the layout');
});

test('layouts are taken by themselves only on the carrier\'s named quote pages', () => {
  const { context } = layoutHarness(() => []);
  const scheduled = () => { const fn = context.pending; context.pending = null; return !!fn; };
  // A carrier with no quote-page address: its portal, account and search pages are never
  // captured on their own; fills still record theirs.
  context.state.tab.carrier = { id: 'portal-only' };
  context.scheduleLayout('Vehicles', 'arrived');
  assert.equal(scheduled(), false);
  context.state.tab.carrier = { id: 'progressive', autoFillUrl: /\/Express\/Default\.aspx/ };
  context.state.tab.url = 'https://portal.example/Home/Search';
  context.scheduleLayout('Vehicles', 'arrived');
  assert.equal(scheduled(), false, 'a page outside the quote');
  context.state.tab.url = 'https://portal.example/Express/Default.aspx?pageName=Vehicles';
  context.scheduleLayout('Vehicles', 'arrived');
  assert.equal(scheduled(), true);
  // GEICO: the quote at sales.geico.com/quote, never the agent gateway or the dashboard (portal
  // pages, whose text the intake's redaction may not cover).
  context.state.tab.carrier = geico;
  for (const [url, quote] of [['https://sales.geico.com/quote', true], ['https://sales.geico.com/quote?step=2', true], ['https://sales.geico.com/quotes', false],
    ['https://sales.geico.com/dashboard', false], ['https://gateway2.geico.com/', false], ['https://gateway2.geico.com/quote', false]]) {
    context.state.tab.url = url;
    context.scheduleLayout('/quote', 'arrived');
    assert.equal(scheduled(), quote, url);
  }
});

test('two quote tabs keep their own last layout', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  await context.recordLayout('Vehicles', 'arrived');
  context.state.tab = { ...context.state.tab, id: 2 };
  await context.recordLayout('Vehicles', 'arrived');
  assert.deepEqual(logged.length, 2, 'the same page in the second tab is its own first layout');
});

test('an intake correction redoes a waiting capture and drops one already reading the page', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  const kit = context.runKit;
  context.scheduleLayout('Vehicles', 'arrived');
  const stale = context.pending;
  context.intakeEdited();
  await stale();
  assert.equal(logged.length, 0, 'the old request does nothing');
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => e.reason), ['arrived'], 'asked again for the corrected intake');
  // A correction while the page is being read: that capture is dropped.
  context.runKit = async (...args) => { context.intakeEdited(); return kit(...args); };
  controls.push({ q: '2A2', kind: 'text', label: 'Placards carried' });
  await context.recordLayout('Vehicles', 'changed');
  assert.equal(logged.length, 1);
});

test('after an intake is loaded, a tab gives layouts only once it shows a new page or is filled', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  Object.assign(context, { samePage: (p) => p, $: () => ({ checked: false }), redactor: () => (s) => s, scheduleAutoFill: () => {},
    fieldChangeEvent: () => ({ type: 'field_change' }), knownStep });
  Object.assign(context.state, { visitedPages: new Set(), autoPages: new Set(), filled: new Map(), labels: new Map() });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  const sender = { tab: { id: 1 } };
  // The previous client's quote is still in the tab when the next PDF is loaded.
  context.holdLayouts();
  context.onRecorderMessage({ ra: 'usage', event: 'new_fields', page: 'Vehicles', keys: ['x'] }, sender);
  context.scheduleLayout('Vehicles', 'arrived');
  assert.equal(context.pending, undefined, 'nothing asked from the old quote');
  // A reload of the same page isn't a new page either.
  context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: 'Vehicles', from: 'Vehicles', fields: 3 }, sender);
  assert.equal(context.pending, undefined);
  // The agent opens another page of the quote (or fills it with this intake): layouts again.
  context.state.tab.url = 'Drivers';
  context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: 'Drivers', from: 'Vehicles', fields: 3 }, sender);
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.filter((e) => e.type === 'page_layout').map((e) => [e.page, e.reason]), [['Drivers', 'arrived']]);
  // Fills ready their tab once they went through (tested with autoFill below; fillPage the same).
  // (After the stale check: a fill whose intake changed meanwhile proves nothing for the new one;
  // nor does one whose page had moved on, which filled nothing.)
  assert.equal((extractFunction('fillPage').match(/__raterKit\?\.fill\(p, o\), \[plan, options\]\);\s+\/\/[^\n]*\n\s+if \(staleFill\(ctx\)\) \{ noteStaleFill\(ctx\); return; \}\s+if \(results\.some\(\(r\) => r\.result\?\.pageMoved\)\) \{ moved = true; notePageMoved\(ctx\); return; \}\s+\/\/[^\n]*\n\s+state\.layoutReadyTabs\.add\(tabId\);/g) ?? []).length, 1);
});

test('a queued capture is dropped for a later change on its page, which gets its reasons', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  // Another capture is still running, so this one waits in the queue.
  let release;
  context.state.layoutChain = new Promise((resolve) => { release = resolve; });
  context.scheduleLayout('Vehicles', 'changed');
  const queued = context.pending();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state.layoutPending, null, 'past the quiet check, waiting in the queue');
  // Another answer changes before it starts.
  controls.push({ q: '2A2', kind: 'text', label: 'Placards carried' });
  context.scheduleLayout('Vehicles', 'appeared');
  release();
  await queued;
  await context.state.layoutChain;
  assert.equal(logged.length, 0, 'the first would log the page after the second answer');
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => [e.reason, e.fields.length]), [['appeared+changed', 2]]);
});

test('layout errors are logged once per quote tab, not once for all tabs', async () => {
  const { context, logged } = layoutHarness(() => { throw new Error('Frame with ID 0 was removed.'); });
  await context.recordLayout('Vehicles', 'arrived');
  context.state.tab = { ...context.state.tab, id: 2 };
  await context.recordLayout('Vehicles', 'arrived');
  assert.deepEqual(logged.map((e) => e.type), ['layout_error', 'layout_error']);
});

test('attaching to a tab asks for its layout, since a recorder already there does not announce the page', () => {
  const body = extractFunction('refreshTab');
  assert.equal((body.match(/scheduleLayout\(pageOf\(state\.tab\??\.url\), 'arrived'\)/g) ?? []).length, 2, 'both when following the quote tab in the background and after switching');
});

test('a capture is logged only when the page read is the page it was asked for', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  // The panel still has the old address while the tab has already moved on to Drivers.
  context.domPage = 'Drivers';
  await context.recordLayout('Vehicles', 'arrived');
  assert.deepEqual(logged, []);
  context.domPage = undefined;
  await context.recordLayout('Vehicles', 'arrived');
  assert.equal(logged.length, 1);
});

test('a change while a capture is asking whether the page is quiet starts a new wait with both reasons', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  const kit = context.runKit;
  context.scheduleLayout('Vehicles', 'changed');
  const first = context.pending;
  // The page changes again while the first capture is asking.
  context.runKit = async (...args) => {
    context.runKit = kit;
    controls.push({ q: '2A2', kind: 'text', label: 'Placards carried' });
    context.scheduleLayout('Vehicles', 'appeared');
    return kit(...args);
  };
  await first();
  await context.state.layoutChain;
  assert.deepEqual(logged, [], 'the first stops: the page changed after it was asked');
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => [e.reason, e.fields.length]), [['appeared+changed', 2]]);
});

test('of two queued captures for one page, the later logs with both reasons', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  let release;
  context.state.layoutChain = new Promise((resolve) => { release = resolve; });
  context.scheduleLayout('Vehicles', 'changed');
  const a = context.pending();
  await new Promise((resolve) => setImmediate(resolve));
  controls.push({ q: '2A2', kind: 'text', label: 'Placards carried' });
  context.scheduleLayout('Vehicles', 'appeared');
  const b = context.pending();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.state.layoutPending, null, 'both are queued');
  release();
  await Promise.all([a, b]);
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => e.reason), ['appeared+changed']);
});

test('after an intake is loaded, only a tab opened since may give its first page without a new page or fill', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  Object.assign(context, { samePage: (p) => p, $: () => ({ checked: false }) });
  Object.assign(context.state, { visitedPages: new Set(), autoPages: new Set() });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  context.holdLayouts();
  // A tab that was already open gets a recorder for the first time: it may show the old quote.
  context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: 'Vehicles', from: null, fields: 3 }, { tab: { id: 1 } });
  assert.equal(context.pending, undefined);
  // The quote Progressive opens in a new tab.
  context.state.layoutNewTabs.add(2);
  context.state.tab = { ...context.state.tab, id: 2 };
  context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: 'Vehicles', from: null, fields: 3 }, { tab: { id: 2 } });
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.filter((e) => e.type === 'page_layout').map((e) => e.reason), ['arrived']);
  assert.match(SIDEPANEL, /chrome\.tabs\.onCreated\.addListener\(\(tab\) => \{ if \(state\.layoutHold\) state\.layoutNewTabs\.add\(tab\.id\); inheritQuoteState\(tab\); \}\)/);
});

test('after Luna\'s picks go in (with the recorder paused), the page\'s layout is asked for', () => {
  const body = extractFunction('applyAi');
  assert.match(body, /await tellRecorder\('resume', ctx\.tabId\);\s+state\.filling = false;[\s\S]{0,400}if \(dispatched && state\.tab\?\.id === ctx\.tabId\) scheduleLayout\(ctx\.page, 'changed'\);/);
});

test('a queued page-change capture waits again when a fill starts before it reads the page', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  let release;
  context.state.layoutChain = new Promise((resolve) => { release = resolve; });
  context.scheduleLayout('Vehicles', 'changed');
  const queued = context.pending();
  await new Promise((resolve) => setImmediate(resolve));
  // The agent clicks Fill this page before the queue gets to it.
  context.state.filling = true;
  release();
  await queued;
  await context.state.layoutChain;
  assert.deepEqual(logged, [], 'never read half filled');
  assert.ok(context.state.layoutPending, 'waiting again');
  context.state.filling = false;
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => e.reason), ['changed']);
});

test('an automatic fill readies its tab for layouts only when it went through', async () => {
  const run = async (runKit) => {
    const state = { tab: { id: 1, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, active: {}, agentKeys: new Map(), autoPaused: false, filling: false, layoutReadyTabs: new Set() };
    const context = { watchFill: () => () => {},
      state, Date, crypto, rulesVersion: null, pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options,
      runKit, rememberFill: () => {}, renderReport: () => {}, recordLayout: () => {}, fillEvents: () => [],
      redactionTerms: () => [], redactor: () => (s) => s, usage: { log: () => {}, currentSession: () => null },
      runAssist: () => {}, pickListItem: async () => {}, noteMissingUnit: () => {}, retireAiOrigins: async () => {}, afterFill: () => {}, runPendingPage: () => {},
      $: () => ({ checked: false, append() {} }), h: () => ({}), viewOf: () => 't1', fillProblem() {}, reportShown: () => true,
    };
    context.reportKey = () => 'k'; state.reports = new Map([['k', {}]]);
  context.renderSteps ??= () => {};
  vm.runInNewContext(extractFunction('assistAfterFill') + extractFunction('autoFill'), context);
    await context.autoFill('Rates');
    return state.layoutReadyTabs.has(1);
  };
  assert.equal(await run(async () => { throw new Error('Frame with ID 0 was removed.'); }), false, 'a failed fill proves nothing about the page');
  assert.equal(await run(async () => [{ result: { fields: 1, filled: [], actions: [], unknown: [] } }]), true);
});

test('Luna\'s picks ask for a layout only while their tab is still the one followed', () => {
  assert.match(extractFunction('applyAi'), /if \(dispatched && state\.tab\?\.id === ctx\.tabId\) scheduleLayout\(ctx\.page, 'changed'\);/);
});

test('an intake restored when the panel opens holds layouts like a newly loaded one', () => {
  assert.match(extractFunction('init'), /wire\(\);[\s\S]{0,500}holdLayouts\(\);[\s\S]{0,80}state\.intake = \(await store\.get\('intake'\)\)/);
});

test('an intake opens on its checks while one is open, else on the page, loaded or restored', () => {
  const firstView = vm.runInNewContext(`${extractFunction('checkShown')}\n${extractFunction('firstView')}; firstView`, { state: { tab: null }, quotedCarrierPolicy });
  const warnings = [{ level: 'info' }, { level: 'check' }];
  assert.equal(firstView({ warnings, done: [] }), 'check');
  assert.equal(firstView({ warnings, done: [1] }), 'page', 'every check looked at');
  assert.equal(firstView({ warnings: [{ level: 'info' }], done: [] }), 'page', 'cleanup notes alone');
  assert.match(extractFunction('loadFile'), /state\.view = firstView\(state\.intake\);/);
  // The panel reopened on a saved intake: its checks again only while one is open.
  assert.match(extractFunction('init'), /state\.intake = \(await store\.get\('intake'\)\) \?\? null;\s+if \(state\.intake\) state\.view = firstView\(state\.intake\);/);
});

// TNI, 2026-10-21: the first driver's name showed on Progressive's business page, as if the page
// were about them, and AmWINS (every driver and vehicle on one page) showed only the first. The
// pickers show only where a page or step is about one unit, or adds the next one.
test('the unit pickers show only on pages and steps about one driver, vehicle or trailer', () => {
  const context = { state: { tab: null }, pageOf: (u) => u, tabStep: () => undefined };
  vm.runInNewContext(extractFunction('unitListsHere'), context);
  const here = (carrier, page, step) => [...context.unitListsHere(carrier, page, step)].sort();
  const [, , vehicles, drivers] = geico.layoutSteps;
  assert.deepEqual(here(progressive, 'BusinessOwnerInfo'), []);
  assert.deepEqual(here(progressive, 'AddDriver'), ['drivers']);
  assert.deepEqual(here(progressive, 'DriverSummary'), ['drivers'], 'the list where the next driver is added');
  assert.deepEqual(here(progressive, 'AddVehicle'), ['vehicles']);
  assert.deepEqual(here(progressive, 'VehicleSummary'), ['trailers', 'vehicles']);
  assert.deepEqual(here(progressive, 'AddTrailer'), ['trailers']);
  for (const step of amwins.layoutSteps) assert.deepEqual(here(amwins, '/application', step), [], `AmWINS ${step}: every unit on one page`);
  assert.deepEqual(here(geico, '/quote', drivers), ['drivers']);
  assert.deepEqual(here(geico, '/quote', vehicles), ['trailers', 'vehicles']);
  assert.deepEqual(here(geico, '/quote', geico.layoutSteps[1]), []);
  assert.deepEqual(here(null, 'AddDriver'), [], 'not a rater');
  assert.match(extractFunction('renderPickers'), /here\.includes\(list\) && \(record\[list\] \?\? \[\]\)\.length > 1/);
  assert.match(extractFunction('renderSteps'), /renderPickers\(\);/, 'they follow the page in front');
});

// TNI, 2026-10-21: an earlier page's answers (the business page, once on Vehicles) could only be
// checked on the rater. The answers' page menu lists the tab's other filled pages by name, in the
// order filled, and shows one read-only.
test('the page menu lists the other pages filled on this tab, by name, and shows one read-only', () => {
  const entry = (key, extra = {}) => ({ key, tabId: Number(key.split('|')[0]), fields: 3, nodes: [], ...extra });
  const reports = new Map(['1|BusinessOwnerInfo||', '1|AddDriver|d1|', '1|AddVehicle|v0|', '2|BusinessOwnerInfo||', '7|/application||Insured Info']
    .map((key) => [key, entry(key)]));
  reports.set('1|PortalHome||', entry('1|PortalHome||', { fields: 0 }));
  const context = { state: { tab: { id: 1 }, reports, pastKey: null }, currentReportKey: () => '1|AddVehicle|v0|', renderSteps() {}, announce() {} };
  vm.runInNewContext(['earlierReports', 'reportTitle', 'showPast'].map(extractFunction).join('\n'), context);
  assert.deepEqual([...context.earlierReports()].map((e) => context.reportTitle(e)), ['Business Owner Info', 'Add Driver · Driver 2'],
    'in the order filled; never the page in front, another tab\'s, or a page with no answers');
  assert.equal(context.reportTitle(reports.get('7|/application||Insured Info')), 'Insured Info', 'a one-address application: its step');
  context.showPast('2|BusinessOwnerInfo||');
  assert.equal(context.state.pastKey, null, 'another tab\'s page is not shown here');
  context.showPast('1|AddDriver|d1|');
  assert.equal(context.state.pastKey, '1|AddDriver|d1|');
  context.showPast(null);
  assert.equal(context.state.pastKey, null);
  assert.match(extractFunction('renderSteps'), /const earlier = onRater && !filling \? earlierReports\(\) : \[\];/, 'never while a fill runs');
  assert.match(extractFunction('setView'), /state\.pastKey = null;/, 'a step button goes back to the page in front');
  // Read-only: what changes an answer works only on the page in front, so it isn't offered there.
  const css = fs.readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');
  const start = css.indexOf('.past .change');
  const rule = css.slice(start, css.indexOf('}', start) + 1);
  for (const cls of ['change', 'mark-done', 'show-on-page', 'opts', 'opt-select', 'change-slot', 'ai-slot', 'ai-holder', 'ai-orphan']) assert.ok(rule.includes(`.past .${cls}`), cls);
  assert.match(rule, /\{ display: none; \}$/);
});

// All client details opens in a drawer from the right (TNI, 2026-10-21: the collapsed list was hard
// to read): focus goes into it, Escape or Close closes it, and focus goes back where it was.
test('client details open in a drawer that takes focus and gives it back', () => {
  const nodes = {};
  const context = { state: { intake: {}, detailsOpen: false, detailsReturn: null }, document: { activeElement: null },
    render() {}, showScreen() {} };
  const el = (id) => (nodes[id] ??= { id, isConnected: true, focus() { context.document.activeElement = this; }, contains: (n) => n === nodes['details-close'] });
  context.$ = el;
  vm.runInNewContext(['openDetails', 'closeDetails'].map(extractFunction).join('\n'), context);
  const opener = el('details-row');
  opener.focus();
  context.openDetails();
  assert.equal(context.state.detailsOpen, true);
  assert.equal(context.document.activeElement, el('details-close'));
  context.closeDetails();
  assert.equal(context.state.detailsOpen, false);
  assert.equal(context.document.activeElement, opener, 'focus back on the row that opened it');
  assert.match(extractFunction('jumpTo'), /openDetails\(\);/, 'Show in client details opens it at the field');
  assert.match(extractFunction('wire'), /e\.key === 'Escape' && state\.detailsOpen[^\n]*closeDetails\(\)/);
  assert.match(extractFunction('wire'), /state\.detailsOpen && !\$\('details-view'\)\.hidden \? \$\('details-view'\)/, 'Tab stays inside it');
});

// The panel in a window of its own (TNI, 2026-10-22: keep it on another monitor while the quote
// tab has the screen): it follows the browser window the agent last used, and Dock puts it back.
test('the panel follows the active tab of its own browser window, or popped out, of the window the agent last used', async () => {
  const queries = [];
  let focused = { id: 7 };
  const chrome = {
    tabs: { query: async (q) => { queries.push({ ...q }); return [{ id: 10 + (q.windowId ?? 1), windowId: q.windowId ?? 1 }]; } },
    windows: { getLastFocused: async (o) => { assert.deepEqual([...o.windowTypes], ['normal'], 'never the panel\'s own window'); return focused; } },
  };
  const context = { chrome, popped: false };
  vm.runInNewContext(extractFunction('tabInView'), context);
  assert.equal((await context.tabInView()).id, 11);
  assert.deepEqual(queries.pop(), { active: true, currentWindow: true });
  context.popped = true;
  assert.equal((await context.tabInView()).id, 17);
  assert.deepEqual(queries.pop(), { active: true, windowId: 7 });
  focused = null;
  assert.equal(await context.tabInView(), undefined, 'no browser window open: no tab');
  assert.match(extractFunction('refreshTab'), /const tab = await tabInView\(\);/);
  assert.match(extractFunction('refreshTab'), /background: true, windowId: quote\.windowId/, 'a quote filled in the background: its own window');
});

test('Pop out opens the panel in a window of its own where the agent last left it, never while a fill runs', async () => {
  const created = [];
  const said = [];
  let saved;
  let fail = 0;
  const chrome = {
    runtime: { getURL: (path) => `chrome-extension://x/${path}` },
    storage: { local: { get: async (key) => ({ [key]: saved }) } },
    windows: { create: async (o) => { created.push({ ...o }); if (fail-- > 0) throw new Error('off every screen'); return { id: 9 }; } },
  };
  const context = { chrome, inExtension: true, popped: false, state: { filling: false }, windowProblem: (m) => { if (m) said.push(m); } };
  vm.runInNewContext(extractFunction('popOut'), context);
  const popup = { url: 'chrome-extension://x/sidepanel/sidepanel.html?window=popup', type: 'popup', focused: true };
  await context.popOut();
  assert.deepEqual(created.pop(), { ...popup, width: 420, height: 860 }, 'the first time: Chrome places it');
  saved = { left: 1930, top: 40, width: 380, height: 700 };
  await context.popOut();
  assert.deepEqual(created.pop(), { ...popup, ...saved }, 'where the agent left it');
  saved = { left: 1930, top: 40, width: 100, height: 90 };
  await context.popOut();
  assert.deepEqual(created.pop(), { ...popup, left: 1930, top: 40, width: 420, height: 860 }, 'never too small to use');
  fail = 1;
  await context.popOut();
  assert.deepEqual(created.splice(0), [{ ...popup, left: 1930, top: 40, width: 420, height: 860 }, { ...popup, width: 420, height: 860 }], 'a place no screen shows: Chrome places it');
  fail = 2;
  await context.popOut();
  assert.equal(created.splice(0).length, 2);
  assert.deepEqual(said, ['The panel couldn’t open in its own window.']);
  for (const [key, value] of [['inExtension', false], ['popped', true]]) {
    context[key] = value;
    await context.popOut();
    context[key] = !value;
  }
  context.state.filling = true;
  await context.popOut();
  assert.equal(created.length, 0, 'not while a fill runs, already popped out, or outside the extension');
  assert.equal(said.at(-1), 'Wait for the answers going in to finish, then try again.', 'an answer going in: said, not a silent no');
  assert.match(extractFunction('wire'), /\$\('pop-out'\)\.addEventListener\('click', popOut\);/);
  assert.match(extractFunction('renderSteps'), /\$\('pop-out'\)\.hidden = !inExtension \|\| popped;\s+\$\('dock-back'\)\.hidden = !popped;\s+\$\('pop-out'\)\.disabled = \$\('dock-back'\)\.disabled = !!state\.filling;/);
  assert.match(extractFunction('init'), /if \(inExtension && popped\) keepPlace\(\);/, 'its place is kept for the next time');
});

test('Dock opens Chrome\'s side panel in the quote\'s window within the click, then the panel\'s window closes', async () => {
  const opened = [];
  const said = [];
  let closed = 0;
  let refuse = false;
  const chrome = { sidePanel: { open: (o) => { opened.push({ ...o }); return refuse ? Promise.reject(new Error('no gesture')) : Promise.resolve(); } } };
  const context = { chrome, popped: true, state: { filling: false, closing: false, tab: { id: 4, windowId: 2 }, browserWindow: 3 },
    closeSelf: () => { closed++; }, windowProblem: (m) => said.push(m), setTimeout: (fn) => fn() };
  vm.runInNewContext(extractFunction('dock'), context);
  context.dock();
  assert.deepEqual(opened.splice(0), [{ windowId: 2 }], 'opened before anything is awaited: the click\'s gesture');
  await new Promise(setImmediate);
  assert.equal(closed, 1);
  context.state.tab = null;
  context.dock();
  assert.deepEqual(opened.splice(0), [{ windowId: 3 }], 'no tab in view: the browser window last used');
  await new Promise(setImmediate);
  refuse = true;
  context.dock();
  await new Promise(setImmediate);
  assert.equal(closed, 2, 'the side panel did not open: the window stays');
  assert.match(said.pop(), /extension’s icon in the toolbar/);
  opened.length = 0;
  context.state.filling = true;
  context.dock();
  context.state.filling = false;
  context.popped = false;
  context.dock();
  context.popped = true;
  context.state.browserWindow = null;
  context.dock();
  assert.equal(opened.length, 0, 'not while a fill runs, as a side panel, or with no browser window');
  assert.deepEqual(said.slice(-2), ['Wait for the answers going in to finish, then try again.', 'Click into the quote’s Chrome window, then try again.'], 'said why');
  // The side panel took over meanwhile (giveWay closes this window): not closed twice.
  refuse = false;
  context.state.browserWindow = 3;
  context.state.closing = true;
  context.dock();
  await new Promise(setImmediate);
  assert.deepEqual([opened.length, closed], [1, 2]);
  assert.doesNotMatch(extractFunction('dock'), /await/);
  assert.match(extractFunction('wire'), /\$\('dock-back'\)\.addEventListener\('click', dock\);/);
});

test('with the panel in its own window only the newest copy stays, and one filling stops before it closes', async () => {
  const sent = [];
  const steps = [];
  let rendered = 0;
  const context = {
    inExtension: true, popped: false, panelCopy: { id: 'b', at: 100 },
    state: { closing: false, fillingFor: null, tabSteps: new Map([[4, 'Vehicles']]), stopScreens: new Map([[4, { name: 'USDOT', page: '/q' }]]), quoteStates: new Map(), layoutReadyTabs: new Set([4]) },
    chrome: { runtime: { sendMessage: (m) => { sent.push({ ...m }); return Promise.resolve(); } } },
    usage: { currentSession: () => ({ intakeId: 'i1' }) }, renderSite: () => { rendered++; }, setTimeout: (fn) => fn(),
    stopFill: async () => { steps.push('stop'); context.state.fillingFor.stopping = true; },
    closeSelf: () => steps.push('close'),
  };
  vm.runInNewContext(['announceCopy', 'onPanelMessage', 'giveWay', 'handOver', 'takeOver'].map(extractFunction).join('\n'), context);
  context.announceCopy();
  assert.deepEqual(sent.splice(0), [{ ra: 'panel', event: 'opened', id: 'b', at: 100, popped: false }]);
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'c', at: 200, popped: false });
  assert.deepEqual([sent.length, steps.length], [0, 0], 'side panels of two browser windows each stay, as before');
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'b', at: 100, popped: true });
  context.onPanelMessage({ ra: 'usage', event: 'opened', id: 'c', at: 200, popped: true });
  assert.deepEqual([sent.length, steps.length], [0, 0], 'its own message, and others, are not about copies');
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'a', at: 50, popped: true });
  assert.deepEqual([sent.length, steps.length], [1, 0], 'an older copy hears from this one again, and this one stays');
  sent.length = 0;
  context.state.fillingFor = { stopping: false };
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'c', at: 200, popped: true });
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'd', at: 300, popped: true });
  await new Promise(setImmediate);
  assert.deepEqual(steps.splice(0), ['stop', 'close'], 'a newer copy in its own window: the fill stops, then this copy closes, once');
  // Before it closes, it hands over what only its memory holds about the tabs.
  const handoff = JSON.parse(JSON.stringify(sent.find((m) => m.event === 'handoff')));
  assert.deepEqual(handoff, { ra: 'panel', event: 'handoff', id: 'b', to: 'c', intakeId: 'i1', tabSteps: [[4, 'Vehicles']],
    stopScreens: [[4, { name: 'USDOT', page: '/q' }]], quoteStates: [], layoutReadyTabs: [4] });
  // The copy taking over keeps what it learned itself, and takes the rest for its own intake only.
  Object.assign(context.state, { tabSteps: new Map([[4, 'Drivers']]), stopScreens: new Map(), layoutReadyTabs: new Set(), tab: { id: 4 } });
  context.onPanelMessage({ ...handoff, id: 'c', to: 'x' });
  context.onPanelMessage({ ...handoff, id: 'c', to: 'b', intakeId: 'another' });
  assert.deepEqual([context.state.stopScreens.size, rendered], [0, 0], 'not for this copy, or another intake\'s');
  context.onPanelMessage({ ...handoff, id: 'c', to: 'b' });
  assert.deepEqual([[...context.state.tabSteps], [...context.state.stopScreens.keys()], [...context.state.layoutReadyTabs], rendered],
    [[[4, 'Drivers']], [4], [4], 1]);
  Object.assign(context, { popped: true });
  Object.assign(context.state, { closing: false, fillingFor: null });
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'a', at: 100, popped: false });
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'c', at: 100, popped: false });
  await new Promise(setImmediate);
  assert.deepEqual(steps, ['close'], 'popped out: a side panel opened since (the toolbar icon, Dock) takes over; the same moment, by id');
  // An answer still going in (a pick from a row) finishes first, then the copy closes.
  steps.length = 0;
  Object.assign(context.state, { closing: false, filling: true });
  let waits = 0;
  context.setTimeout = (fn) => { if (++waits === 3) context.state.filling = false; fn(); };
  context.onPanelMessage({ ra: 'panel', event: 'opened', id: 'e', at: 400, popped: false });
  await new Promise(setImmediate);
  assert.deepEqual([waits, steps], [3, ['close']]);
  for (const name of ['fillPage', 'autoFill', 'agentAnswer', 'applyAi']) assert.match(extractFunction(name), /state\.closing/, `${name}: nothing new starts while it closes`);
  assert.match(extractFunction('wire'), /chrome\.runtime\.onMessage\.addListener\(onPanelMessage\);/);
  assert.match(extractFunction('init'), /wire\(\);[\s\S]*usage\.restoreSession\([\s\S]{0,400}announceCopy\(\);/, 'it says so once it listens and its intake is known');
});

// Review 2026-10-22: a maximized window's bounds became the next Pop out's size.
test('popped out, only a normal window\'s place and size are kept', async () => {
  const kept = [];
  let onBounds = null;
  const chrome = {
    windows: { getCurrent: async () => ({ id: 7 }), onBoundsChanged: { addListener: (fn) => { onBounds = fn; } } },
    storage: { local: { set: async (v) => { kept.push(JSON.parse(JSON.stringify(v))); } } },
  };
  const context = { chrome };
  vm.runInNewContext(extractFunction('keepPlace'), context);
  await context.keepPlace();
  const bounds = { left: 10, top: 20, width: 400, height: 800 };
  onBounds({ id: 7, state: 'normal', ...bounds });
  for (const state of ['maximized', 'minimized', 'fullscreen']) onBounds({ id: 7, state, left: 0, top: 0, width: 1920, height: 1040 });
  onBounds({ id: 8, state: 'normal', ...bounds, width: 999 });
  assert.deepEqual(kept, [{ panelWindow: bounds }]);
});

test('a copy that gives way closes its own window, its tab, or Chrome\'s side panel', async () => {
  const closed = [];
  let tab = null;
  let sidePanelClose = (o) => { closed.push(['side panel', o.windowId]); return Promise.resolve(); };
  const chrome = {
    windows: { getCurrent: async () => ({ id: 5 }), remove: async (id) => { closed.push(['window', id]); } },
    tabs: { getCurrent: async () => tab, remove: async (id) => { closed.push(['tab', id]); } },
    get sidePanel() { return { close: sidePanelClose }; },
  };
  const context = { chrome, popped: true, window: { close: () => closed.push(['page']) } };
  vm.runInNewContext(extractFunction('closeSelf'), context);
  const close = async () => { await context.closeSelf(); await new Promise(setImmediate); return closed.splice(0).map((c) => [...c]); };
  assert.deepEqual(await close(), [['window', 5]]);
  context.popped = false;
  tab = { id: 8 };
  assert.deepEqual(await close(), [['tab', 8]], 'a harness opened it as a page');
  tab = undefined;
  assert.deepEqual(await close(), [['side panel', 5]]);
  sidePanelClose = () => Promise.reject(new Error('no side panel open'));
  assert.deepEqual(await close(), [['page']]);
  sidePanelClose = undefined;
  assert.deepEqual(await close(), [['page']], 'before Chrome 141 the side panel closes itself');
});

test('popped out, the capture shortcut captures from the panel\'s only copy, wherever focus is', async () => {
  let captured = 0;
  const context = { popped: true, capturePage: () => { captured++; },
    chrome: { windows: { getCurrent: async () => ({ id: 1 }), getLastFocused: async () => ({ id: 2 }) } } };
  vm.runInNewContext(extractFunction('captureFromShortcut'), context);
  await context.captureFromShortcut();
  assert.equal(captured, 1);
  context.popped = false;
  await context.captureFromShortcut();
  assert.equal(captured, 1, 'a side panel in another window than the focused one leaves it to that one');
});

test('a capture overtaken by a later change does not report its failure, and hands its reasons on', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  context.scheduleLayout('Vehicles', 'changed');
  const first = context.pending;
  const kit = context.runKit;
  context.runKit = async (tabId, carrier, func) => {
    if (String(func).includes('busy')) return kit(tabId, carrier, func);
    // The page redraws for a second answer while the first capture reads it.
    context.runKit = kit;
    context.scheduleLayout('Vehicles', 'appeared');
    throw new Error('Frame with ID 0 was removed.');
  };
  await first();
  await context.state.layoutChain;
  assert.equal(context.state.layoutErrors, 0);
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => [e.type, e.reason]), [['page_layout', 'appeared+changed']]);
});

test('a page whose last question goes away logs its empty layout, so the question coming back does too', async () => {
  let controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  await context.recordLayout('Vehicles', 'arrived');
  const shown = controls;
  controls = [];
  await context.recordLayout('Vehicles', 'removed');
  controls = shown;
  await context.recordLayout('Vehicles', 'appeared');
  assert.deepEqual(logged.map((e) => [e.reason, e.fields.length]), [['arrived', 1], ['removed', 0], ['appeared', 1]]);
});

// 2026-10-05: Progressive showed DeclinationNotice after Business Owner Info (the client already
// has a commercial auto policy with Progressive). The quote stops there: nothing filled, nothing
// clicked, Luna not asked, and the agent is told why.
function stopHarness(page = 'DeclinationNotice') {
  const node = (tag, props = {}, ...children) => ({ tag, props, children: children.flat() });
  const box = () => ({ hidden: false, className: '', children: [], replaceChildren(...next) { this.children = next; } });
  const ui = { report: box(), 'stop-note': box(), 'auto-followups': { checked: true }, 'auto-pages': { checked: true }, 'auto-advance': { checked: true } };
  const carrier = { id: 'progressive', name: 'Progressive', stopPages: { DeclinationNotice: 'Progressive says this client already has a commercial auto policy with Progressive.' } };
  const record = { applicant: { name: 'Synthetic Client LLC' } };
  const url = (p) => `https://clpolicy.foragentsonly.com/Express/Default.aspx?pageName=${p}`;
  const state = {
    intake: { record }, tab: { id: 4, url: url(page), carrier },
    autoPages: new Set(['DeclinationNotice', 'BusinessOwnerInfo']), autoPaused: false, filling: false, autoTimer: null, autoPending: false,
    pagePending: null, agentKeys: new Map(), aiCache: new Map(), active: {}, visitedPages: new Set(),
    layoutHold: false, layoutReadyTabs: new Set(), layoutNewTabs: new Set(), viewTabs: new Map(),
  };
  const logged = [], kits = [], timers = [];
  const context = {
    state, URL, h: node, $: (id) => ui[id], onQuotePage: () => true, fillEvents,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    usage: { log: (...events) => logged.push(...events), currentSession: () => ({ id: 'quote-1' }) },
    runKit: async (...args) => { kits.push(args); return []; }, tellRecorder: async () => {}, ensureRecorder: async () => {},
    pickListItem: async () => {}, noteMissingUnit: () => {}, retireAiOrigins: async () => {}, buildPlan: () => [], fillOptions: () => ({}),
    scheduleLayout: () => {}, store: { set: async () => {} },
  };
  vm.runInNewContext(`${PAGE_HELPERS}\n${['showStopPage', 'stopPageIsOurs', 'fillPage', 'scheduleAutoFill', 'autoFill', 'aiActionCurrent', 'onRecorderMessage', 'viewOf', 'saveViews', 'stepScope'].map(extractFunction).join('\n')}`, context);
  // The recorder announcing a page (a new document has no `from`).
  const arrive = (to, from = null) => {
    state.tab = { ...state.tab, url: url(to) };
    context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: to, from, fields: 0 }, { tab: { id: 4 }, frameId: 0 });
  };
  return { state, context, ui, logged, kits, timers, carrier, arrive, stops: () => logged.filter((e) => e.type === 'fill_run') };
}

test('on a carrier stop page nothing is filled, clicked or scheduled, manual or automatic, and Luna is not asked', async () => {
  const t = stopHarness();
  await t.context.fillPage({ auto: 'page' });
  await t.context.fillPage();
  t.context.scheduleAutoFill('DeclinationNotice');
  await t.context.autoFill('DeclinationNotice');
  assert.deepEqual(t.kits, [], 'the page kit is never run on the stop page');
  assert.deepEqual(t.timers, [], 'no follow-up fill is scheduled');
  assert.equal(t.state.filling, false);
  assert.equal(t.state.pagePending, null);
  // A fill already running when the page opens doesn't queue the stop page for afterwards.
  t.state.filling = true;
  await t.context.fillPage({ auto: 'page' });
  assert.equal(t.state.pagePending, null);
  t.state.filling = false;
  // Luna's suggestions (asking or applying) are never current on the stop page.
  const ctx = { intake: t.state.intake, tabId: 4, tabUrl: t.state.tab.url, page: 'DeclinationNotice' };
  assert.equal(t.context.aiActionCurrent(ctx, []), false);
  // The panel says why, prominently, outside the fill report (Clear marks empties that).
  const note = t.ui['stop-note'];
  assert.equal(note.hidden, false);
  const text = JSON.stringify(note.children);
  assert.match(text, /Progressive stopped this quote/);
  assert.match(text, /already has a commercial auto policy with Progressive/);
  assert.match(text, /"role":"alert"/);
  t.ui.report.replaceChildren();
  assert.match(JSON.stringify(note.children), /already has a commercial auto policy/);
});

test('each arrival at a stop page, reloads included, is logged as a fill_run blocker without client data', () => {
  const t = stopHarness('BusinessOwnerInfo');
  t.arrive('DeclinationNotice', 'BusinessOwnerInfo');
  // Progressive's "-Reload" re-render is the same arrival; a reloaded document is a new one.
  t.arrive('DeclinationNotice-Reload', 'DeclinationNotice');
  t.arrive('DeclinationNotice');
  const stops = JSON.parse(JSON.stringify(t.stops()));
  assert.equal(stops.length, 2);
  // Every counter the usage summary adds up is there (zero), so its totals stay numbers.
  for (const k of ['filled', 'failed', 'noData', 'kept', 'leftRequired', 'unknown', 'ms', 'fields']) assert.equal(stops[0][k], 0, k);
  assert.deepEqual([stops[0].blockers, stops[0].blockerList, stops[0].auto, stops[0].page, stops[0].advanced], [1, ['stop: DeclinationNotice'], 'stop', 'DeclinationNotice', null]);
  assert.doesNotMatch(JSON.stringify(t.logged), /Synthetic Client/);
  // The agent goes back: the note goes.
  t.arrive('BusinessOwnerInfo', 'DeclinationNotice');
  t.context.showStopPage();
  assert.equal(t.ui['stop-note'].hidden, true);
  assert.deepEqual(t.ui['stop-note'].children, []);
  // Practice pages are never logged.
  const practice = stopHarness('BusinessOwnerInfo');
  practice.carrier.practice = true;
  practice.arrive('DeclinationNotice', 'BusinessOwnerInfo');
  assert.deepEqual(practice.stops(), []);
});

test('a stop page the tab showed before this client was loaded is not said of this client or logged', () => {
  const t = stopHarness();
  t.state.layoutHold = true;
  t.arrive('DeclinationNotice');
  assert.deepEqual(t.stops(), []);
  const text = JSON.stringify(t.ui['stop-note'].children);
  assert.doesNotMatch(text, /already has a commercial auto policy/);
  assert.match(text, /may be another client's quote/);
  assert.match(text, /Nothing on this page is filled or clicked/);
  // Moving on to it from another page of the quote is the evidence.
  t.arrive('BusinessOwnerInfo', 'DeclinationNotice');
  t.arrive('DeclinationNotice', 'BusinessOwnerInfo');
  assert.equal(t.stops().length, 1);
  assert.match(JSON.stringify(t.ui['stop-note'].children), /already has a commercial auto policy with Progressive/);
});

test('pages that are not stop pages are still filled and followed up', async () => {
  const t = stopHarness('BusinessOwnerInfo');
  t.context.scheduleAutoFill('BusinessOwnerInfo');
  assert.equal(t.timers.length, 1, 'a follow-up fill is scheduled as before');
  const ctx = { intake: t.state.intake, tabId: 4, tabUrl: t.state.tab.url, page: 'BusinessOwnerInfo' };
  assert.equal(t.context.aiActionCurrent(ctx, []), true);
  t.context.showStopPage();
  assert.equal(t.ui['stop-note'].hidden, true);
  assert.deepEqual(t.stops(), []);
});

test('the fill options hand the carrier\'s stop pages to the page kit', () => {
  const start = SIDEPANEL.indexOf('const fillOptions =');
  const body = SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start));
  assert.match(body, /stopPages: Object\.keys\(carrier\.stopPages \?\? \{\}\)/);
});

test('an empty page is logged only when questions went away, never from a fill or an arrival', async () => {
  let controls = [];
  const { context, logged } = layoutHarness(() => controls);
  // A fill that ran before the page drew its questions, or an arrival on a page still loading.
  await context.recordLayout('Vehicles', 'fill');
  await context.recordLayout('Vehicles', 'arrived');
  assert.deepEqual(logged, []);
  controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  await context.recordLayout('Vehicles', 'arrived');
  controls = [];
  await context.recordLayout('Vehicles', 'changed+removed');
  assert.deepEqual(logged.map((e) => [e.reason, e.fields.length]), [['arrived', 1], ['changed+removed', 0]]);
});

test('a one-address application names the step of each layout, and steps are compared apart', async () => {
  let controls = [{ label: 'VIN', kind: 'text' }];
  const { context, logged } = layoutHarness(() => controls);
  context.state.tab.carrier = { id: 'amwins', layoutUrl: /./, layoutSteps: amwins.layoutSteps };
  context.domStep = 'Vehicles';
  await context.recordLayout('Vehicles', 'arrived');
  // The visible headings, as one of the carrier's step names (knownStep).
  context.domStep = 'Draft Application Saved! / coverages';
  controls = [{ label: 'Exclude Collision Coverage', kind: 'radio', options: ['Yes', 'No'] }];
  await context.recordLayout('Vehicles', 'changed');
  // Back on the Vehicles step, unchanged: already logged for that step.
  context.domStep = 'Vehicles';
  controls = [{ label: 'VIN', kind: 'text' }];
  await context.recordLayout('Vehicles', 'changed');
  assert.deepEqual(logged.map((e) => [e.step, e.fields[0].label]), [['Vehicles', 'VIN'], ['Coverages', 'Exclude Collision Coverage']]);
  // A heading that is none of the step names (it can name the insured, maybe the previous
  // client's): the layout carries no step.
  context.domStep = 'Old Client Trucking LLC';
  controls = [{ label: 'Business name', kind: 'text' }];
  await context.recordLayout('Vehicles', 'changed');
  assert.equal(logged.at(-1).fields[0].label, 'Business name');
  assert.equal(logged.at(-1).step, undefined);
  assert.ok(!JSON.stringify(logged.at(-1)).includes('Old Client'));
  // Other carriers' layouts carry no step (their pages have their own names).
  context.state.tab.carrier = { id: 'progressive', layoutUrl: /./ };
  controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'] }];
  await context.recordLayout('Vehicles', 'arrived');
  assert.equal('step' in logged.at(-1) && logged.at(-1).step !== undefined, false);
});

test('a row key is settled by its own edit, or by the plain name an older build saved for any row', () => {
  const state = { tab: { carrier: { id: 'amwins' } }, active: {}, agentKeys: new Map() };
  const context = { state };
  vm.runInNewContext(`${extractFunction('agentEdited')}\n${extractFunction('stepScope')}`, context);
  const edited = (keys, key) => { state.agentKeys = new Map([['/application/businessauto', new Set(keys)]]); return context.agentEdited('/application/businessauto', key); };
  assert.equal(edited(['medicalPaymentExclude#2'], 'medicalPaymentExclude#2'), true);
  assert.equal(edited(['medicalPaymentExclude#2'], 'medicalPaymentExclude#3'), false, 'one vehicle\'s edit leaves the others');
  assert.equal(edited(['medicalPaymentExclude'], 'medicalPaymentExclude#3'), true, 'a legacy shared-name edit covers every row');
  assert.equal(edited(['2C1A'], '2C1A@2'), false, 'Progressive rows are unchanged');
});

test('events name their view: the tab\'s order in the quote and the vehicle or driver, never ids', async () => {
  const controls = [{ q: '2A1', kind: 'radio', label: 'Hauls hazmat?', options: ['Yes', 'No'], selected: 'Yes' }];
  const { context, logged } = layoutHarness(() => controls);
  const carrier = { id: 'progressive', layoutUrl: /./, vehiclePages: ['AddVehicle'], driverPage: 'AddDriver' };
  context.state.tab = { id: 917, url: 'Vehicles', carrier };
  assert.equal(context.viewOf(917, 'Vehicles', carrier), 't1');
  assert.equal(context.viewOf(402, 'Vehicles', carrier), 't2', 'another tab of the quote');
  context.state.active = { vehicles: 1, drivers: 0 };
  assert.equal(context.viewOf(917, 'AddVehicle', carrier), 't1:v1');
  assert.equal(context.viewOf(402, 'AddDriver', carrier), 't2:d0');
  await context.recordLayout('Vehicles', 'arrived');
  assert.equal(logged.at(-1).view, 't1');
  // Field changes and arrivals from the recorder carry it too.
  Object.assign(context, { samePage: (p) => p, $: () => ({ checked: false }), redactor: () => (s) => s, scheduleAutoFill: () => {},
    fieldChangeEvent: () => ({ type: 'field_change' }), knownStep, unitArrival: () => {} });
  Object.assign(context.state, { visitedPages: new Set(), autoPages: new Set(), filled: new Map(), labels: new Map() });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  context.onRecorderMessage({ ra: 'usage', event: 'field_changes', page: 'AddVehicle', changes: [{ key: 'x', before: '', after: 'Yes' }] }, { tab: { id: 917 } });
  context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: 'AddDriver', from: 'AddVehicle', fields: 3 }, { tab: { id: 917 } });
  assert.deepEqual(logged.slice(-2).map((e) => [e.type, e.view]), [['field_change', 't1:v1'], ['page_view', 't1:d0']]);
  // Kept with the quote's session for a panel opened again; a new quote numbers its tabs again.
  assert.deepEqual(JSON.parse(JSON.stringify(context.store.saved.views)), { session: 'quote-1', tabs: [[917, 1], [402, 2]] });
  context.holdLayouts();
  assert.equal(context.viewOf(402, 'Vehicles', carrier), 't2', 'holding layouts keeps the numbers');
  context.resetViews();
  assert.equal(context.viewOf(402, 'Vehicles', carrier), 't1');
});

test('fills take their view before waiting, stop pages log theirs, and a reopened panel keeps the quote\'s views', () => {
  for (const name of ['fillPage', 'autoFill']) {
    const body = extractFunction(name);
    assert.ok(body.indexOf('const ctx = fillContext(') < body.indexOf('await pickListItem('), `${name} takes its context (with the view) before any waiting`);
    assert.match(body, /logFill\(ctx, frames, results, started\)/, `${name} logs that view`);
  }
  assert.match(extractFunction('fillContext'), /view: viewOf\(tabId, page, carrier\)/);
  assert.match(extractFunction('logFill'), /fillEvents\(ctx\.listNote \? \[\.\.\.frames, \{ blockers: \[ctx\.listNote\] \}\] : frames, \{[^}]*\bview: ctx\.view\b/);
  assert.match(extractFunction('onRecorderMessage'), /auto: 'stop'/);
  assert.match(extractFunction('onRecorderMessage'), /page: stopPage, view: viewOf\(sender\.tab\.id, stopPage\)/);
  assert.match(extractFunction('init'), /usage\.restoreSession\([\s\S]{0,80}\);\s+const views = await store\.get\('views'\);\s+if \(views\?\.session && views\.session === usage\.currentSession\(\)\?\.id\) state\.viewTabs = new Map\(views\.tabs\);/);
});

test('a manual capture is numbered in its scenario, keeps a redacted note and scenario, and is only downloaded', async () => {
  const downloads = [], blobs = [];
  let settings = {};
  const ui = { 'capture-scenario': { value: ' Jordan Avery van ' }, 'capture-note': { value: 'set hazmat for Jordan Avery to Yes' }, 'capture-status': {},
    report: { replaceChildren() { throw new Error('a capture never writes over the fill report'); } } };
  const context = {
    state: { tab: { id: 3, url: 'Operations', carrier: { id: 'progressive' } }, intake: { record: { garaging: {}, operations: {}, vehicles: [], trailers: [], coverage: {} } }, active: {}, intakeRevision: 0 },
    $: (id) => ui[id], h: (tag, props, text) => ({ text, click: () => downloads.push(props.download) }),
    redactor: () => (s) => s.split('Jordan Avery').join('[client]'), redactionTerms: () => [], buildPlan: () => [],
    pageOf: (u) => u, viewOf: () => 't1',
    runKit: async () => [{ result: { isTopFrame: true, page: context.domPage ?? 'Operations', step: 'Business Owner Info', controls: [{ q: '2A1' }], openLists: [] } },
      // A child frame with no questions but a message: kept as evidence.
      { result: { isTopFrame: false, controls: [], messages: ['Enter a valid ZIP'], openLists: [] } }, { result: { isTopFrame: false, controls: [], messages: [], openLists: [] } }],
    usage: { currentSession: () => ({ id: 'quote-1' }) },
    captureCountsStore: { get: async () => settings.captureCounts, set: async (v) => { settings = { ...settings, captureCounts: v }; } },
    Blob: class { constructor(parts) { blobs.push(JSON.parse(parts[0])); } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, setTimeout: () => 0, JSON, String,
  };
  vm.runInNewContext(['nextCaptureNumber', 'captureSaid', 'capturePage'].map(extractFunction).join('\n'), context);
  await context.capturePage();
  await context.capturePage();
  assert.deepEqual(downloads, ['capture-progressive-client-van-quot-001-Operations.json', 'capture-progressive-client-van-quot-002-Operations.json']);
  assert.deepEqual([blobs[0].kind, blobs[0].version, blobs[0].scenario, blobs[0].quote, blobs[0].n, blobs[0].note, blobs[0].view], ['page-capture', 2, '[client] van', 'quote-1', 1, 'set hazmat for [client] to Yes', 't1']);
  assert.equal(blobs[1].note, null, 'a note belongs to the capture it was written for');
  assert.equal(blobs[0].step, null, 'Progressive pages name themselves; their headings are no step');
  assert.equal(blobs[0].frames.length, 2, 'the frame with a message is kept, the empty one not');
  assert.deepEqual(JSON.parse(JSON.stringify(settings.captureCounts)), { 'quote-1|[client] van': 2 }, 'counted per quote and scenario, kept across browser restarts');
  // A note typed for the next step while this capture runs is kept.
  const kit = context.runKit;
  context.runKit = async (...args) => { ui['capture-note'].value = 'next: hazmat No'; return kit(...args); };
  await context.capturePage();
  assert.equal(ui['capture-note'].value, 'next: hazmat No');
  context.runKit = kit;
  // The page moved on while it was read: nothing saved.
  context.domPage = 'Drivers';
  await context.capturePage();
  assert.equal(downloads.length, 3);
  // No intake loaded: nothing to redact client details with, so no capture.
  context.domPage = undefined;
  context.state.intake = null;
  await context.capturePage();
  assert.equal(downloads.length, 3);
  assert.match(SIDEPANEL, /chrome\.commands\?\.onCommand\.addListener\(\(command\) => \{ if \(command === 'capture-page'\) captureFromShortcut\(\); \}\)/);
  assert.match(extractFunction('captureFromShortcut'), /mine\.id !== focused\.id\) return;/, 'only the focused window\'s panel captures');
});

// 2026-10-08 live run: a Florida intake, Utah picked on Progressive's home page; the intake was
// then cleared and loaded again, and nothing said the quote was for another state until Progressive
// refused the Florida ZIP on Add Vehicle. The panel warns as soon as they disagree.
async function stateNoteHarness() {
  const { quoteStatePick, stateCode, stateMismatch } = await import('../src/quote-state.js');
  const { progressive } = await import('../src/carriers/progressive.js');
  const { amwins } = await import('../src/carriers/amwins.js');
  const node = (tag, props = {}, ...children) => ({ tag, props, children: children.flat() });
  const box = () => ({ hidden: true, children: [], replaceChildren(...next) { this.children = next; } });
  const ui = { 'state-note': box(), 'auto-followups': { checked: false }, 'auto-pages': { checked: false }, 'auto-advance': { checked: false } };
  const session = { current: { id: 's1', intakeId: 'fl-intake' } };
  const record = (st) => ({ applicant: { name: 'Synthetic Client LLC' }, garaging: { state: st } });
  const state = {
    intake: { record: record('FL') }, tab: { id: 7, url: 'https://www.foragentsonly.com/home/', carrier: progressive },
    quoteStates: new Map(), tabSessions: new Map(), filled: new Map(), labels: new Map(), choices: new Map(), agentKeys: new Map(), doneActions: new Set(),
    viewTabs: new Map(), layoutReadyTabs: new Set(), layoutNewTabs: new Set(), visitedPages: new Set(), active: {},
    intakeRevision: 0, layoutPending: null,
  };
  const logged = [];
  const page = { shown: null };
  const context = {
    state, URL, h: node, $: (id) => ui[id], quoteStatePick, stateCode, stateMismatch, inExtension: false,
    usage: { log: (...e) => logged.push(...e), currentSession: () => session.current },
    fieldChangeEvent: (c) => ({ type: 'field_change', key: c.key }), knownStep, redactor: () => (x) => x, redactionTerms: () => [],
    scheduleLayout: () => {}, persistAgentKeys: () => {}, persistDoneActions: () => {}, save: () => {}, settleRejectedAi: async () => false,
    scheduleAutoFill: () => {}, syncAiBanner: () => {}, showStopPage: () => {}, fillEvents, store: { set: async () => {} },
    unitArrival: () => {}, onQuotePage: () => false, fillPage: async () => {}, setTimeout: () => 0, answeredOnPage() {},
    renderSteps() {}, sourcePlace: () => null, pdfPageSaid: () => '', openPdf() {},
    // The page's quote-state control as the page shows it (chrome.scripting in the extension).
    readQuoteState: async () => page.shown,
  };
  vm.runInNewContext(`${PAGE_HELPERS}\n${['onRecorderMessage', 'showStateNote', 'stateIssue', 'dismissState', 'noteQuoteState', 'seedQuoteState', 'inheritQuoteState', 'rememberFill', 'quoteFinished', 'intakeEdited', 'viewOf', 'saveViews', 'stepScope', 'editScope'].map(extractFunction).join('\n')}`, context);
  const pick = (after, key = 'QuoteStateList', at = '/home/', tabId = 7) =>
    context.onRecorderMessage({ ra: 'usage', event: 'field_changes', page: at, changes: [{ key, after, agent: true }] }, { tab: { id: tabId }, frameId: 0 });
  const arrive = async (at, from = null, tabId = 7) => {
    context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: at, from, fields: 6 }, { tab: { id: tabId }, frameId: 0 });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const note = () => ui['state-note'];
  return {
    context, state, ui, logged, page, session, record, progressive, amwins, pick, arrive, note,
    text: () => JSON.stringify(note().children),
    // The card's "<state> is right" (dismissState).
    button: () => nodesIn(note().children).find((c) => c.tag === 'button' && / is right$/.test(c.children[0])),
  };
}

test('the panel warns when the quote state picked on the carrier page is not the intake\'s, across a reload', async () => {
  const t = await stateNoteHarness();
  t.pick('Utah');
  assert.equal(t.note().hidden, false);
  assert.match(t.text(), /This Progressive quote is for Utah\. The intake says Florida\./);
  assert.match(t.text(), /A Utah quote won’t take Florida ZIP codes or rules/);
  assert.equal(t.button().children[0], 'Utah is right');
  assert.match(t.text(), /"role":"alert"/);
  assert.doesNotMatch(t.text(), /Synthetic Client/);
  // Cleared, then the same intake loaded again: the tab's quote is still Utah's.
  t.state.intake = null;
  t.context.showStateNote();
  assert.equal(t.note().hidden, true);
  t.state.intake = { record: t.record('FL') };
  t.session.current = { id: 's2', intakeId: 'fl-intake' };
  t.context.showStateNote();
  assert.equal(t.note().hidden, false);
  assert.match(t.text(), /started in Utah before this intake was loaded/);
  // "Utah is right": hidden for this intake, also when loaded again; another intake hears it.
  t.button().props.onclick();
  assert.equal(t.note().hidden, true);
  t.session.current = { id: 's3', intakeId: 'fl-intake' };
  t.context.showStateNote();
  assert.equal(t.note().hidden, true);
  t.session.current = { id: 's4', intakeId: 'other-fl-intake' };
  t.context.showStateNote();
  assert.equal(t.note().hidden, false);
  // The intake's state picked: no note; back to the placeholder: forgotten.
  t.pick('Florida');
  assert.equal(t.note().hidden, true);
  assert.equal(t.state.quoteStates.get(7).code, 'FL');
  t.pick('');
  assert.equal(t.state.quoteStates.has(7), false);
  // An intake without a state (an address it couldn't split): nothing to compare.
  t.pick('Utah');
  t.state.intake = { record: t.record(null) };
  t.context.showStateNote();
  assert.equal(t.note().hidden, true);
  // AmWINS' risk state, changed by the agent; a tab that moves to another carrier forgets.
  t.state.intake = { record: t.record('FL') };
  t.state.tab = { id: 7, url: 'https://myagency.amwinsadmittedplacement.com/commerciallines', carrier: t.amwins };
  t.context.showStateNote();
  assert.equal(t.state.quoteStates.has(7), false, 'the tab moved to another carrier');
  t.pick('Florida', 'riskState', '/commerciallines');
  assert.equal(t.note().hidden, true);
  t.pick('Virginia', 'riskState', '/commerciallines');
  assert.match(t.text(), /This AmWINS quote is for Virginia. The intake says Florida./);
  assert.equal(t.logged.filter((e) => e.type === 'field_change').length, 6, 'every change is still logged');
});

// Codex on PR #60, and the run's own tabs: Progressive opened the quote in a new tab (t2 → t3).
test('the quote state comes from the page as it is, the fill, the tab the quote opened from; intake edits recheck it', async () => {
  const t = await stateNoteHarness();
  // Already Utah when the recorder sees the home page (restored, defaulted, picked before it attached).
  t.page.shown = 'Utah';
  await t.arrive('/home/');
  assert.equal(t.state.quoteStates.get(7)?.code, 'UT');
  assert.equal(t.note().hidden, false);
  // Another page of the same tab isn't read; the home page with no state forgets it.
  t.page.shown = 'Florida';
  await t.arrive('BusinessOwnerInfo', '/home/');
  assert.equal(t.state.quoteStates.get(7)?.code, 'UT');
  // Read again unchanged: still the pick made before (its "before this intake" wording, its dismissal).
  t.session.current = { id: 's2', intakeId: 'fl-intake' };
  t.page.shown = 'Utah';
  await t.arrive('/home/');
  assert.match(t.text(), /before this intake was loaded/);
  // The quote opens in a new tab from the home page: it inherits the pick.
  t.context.inheritQuoteState({ id: 8, openerTabId: 7 });
  t.context.inheritQuoteState({ id: 9, openerTabId: 99 });
  t.state.tab = { id: 8, url: 'https://clpolicy.foragentsonly.com/Express/Default.aspx?pageName=BusinessOwnerInfo', carrier: t.progressive };
  t.context.showStateNote();
  assert.equal(t.note().hidden, false, 'the quote tab says it too');
  assert.equal(t.state.quoteStates.has(9), false, 'a tab opened from elsewhere inherits nothing');
  // Codex on PR #60 (ed1e23e): with no intake the home page isn't watched, so its pick may be stale.
  const loaded = t.state.intake;
  t.state.intake = null;
  t.context.inheritQuoteState({ id: 20, openerTabId: 7 });
  assert.equal(t.state.quoteStates.has(20), false, 'no intake: nothing inherited');
  t.state.intake = loaded;
  // The intake's garaging state edited to Utah: the note goes at once; back to Florida: it comes back.
  t.state.intake.record.garaging.state = 'UT';
  t.context.intakeEdited();
  assert.equal(t.note().hidden, true);
  t.state.intake.record.garaging.state = 'FL';
  t.context.intakeEdited();
  assert.equal(t.note().hidden, false);
  t.page.shown = '';
  t.state.tab = { id: 7, url: 'https://www.foragentsonly.com/home/', carrier: t.progressive };
  await t.arrive('/home/');
  assert.equal(t.state.quoteStates.has(7), false, 'the home page with no state: a new quote');
  // AmWINS: the risk state the fill picked (the recorder is paused while filling).
  t.state.tab = { id: 10, url: 'https://myagency.amwinsadmittedplacement.com/commerciallines', carrier: t.amwins };
  t.page.shown = null;
  t.context.rememberFill([{ filled: [{ key: 'riskState', path: 'amwins.riskState', shown: 'Virginia' }] }]);
  assert.equal(t.state.quoteStates.get(10)?.code, 'VA');
  assert.match(t.text(), /This AmWINS quote is for Virginia. The intake says Florida./);
  t.context.rememberFill([{ filled: [{ key: 'mailingState', path: 'garaging.state', shown: 'Utah' }] }]);
  assert.equal(t.state.quoteStates.get(10)?.code, 'VA', 'the mailing state is an address, not the quote');
  // A pick made while the page is being read is newer than what the read returns.
  t.state.tab = { id: 7, url: 'https://www.foragentsonly.com/home/', carrier: t.progressive };
  let release;
  t.context.readQuoteState = () => new Promise((resolve) => { release = resolve; });
  t.context.onRecorderMessage({ ra: 'usage', event: 'page_view', page: '/home/', from: null, fields: 6 }, { tab: { id: 7 }, frameId: 0 });
  t.pick('Florida');
  release('Utah');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.state.quoteStates.get(7)?.code, 'FL');
  // Codex on PR #60 (ef5d7d1): the panel reopened on the home page, its recorder still there and
  // silent: the tab's page is read when the panel finds the tab.
  assert.match(extractFunction('refreshTab'), /seedQuoteState\(state\.tab\.id, state\.tab\.carrier, pageOf\(state\.tab\.url\)\)/);
  t.state.quoteStates.clear();
  t.context.readQuoteState = async () => 'Utah';
  t.context.seedQuoteState(7, t.progressive, '/home/');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.state.quoteStates.get(7)?.code, 'UT');
  t.state.intake = null;
  t.context.seedQuoteState(8, t.progressive, '/home/');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.state.quoteStates.has(8), false, 'no intake: the tab isn\'t watched');
  t.state.intake = { record: t.record('FL') };
  // A fill's risk state goes to the fill's tab, also when the agent is on another tab by then.
  t.state.tab = { id: 11, url: 'https://myagency.amwinsadmittedplacement.com/commerciallines', carrier: t.amwins };
  t.context.rememberFill([{ filled: [{ key: 'riskState', path: 'amwins.riskState', shown: 'Ohio' }] }], { tabId: 12, carrier: t.amwins });
  assert.equal(t.state.quoteStates.get(12)?.code, 'OH');
  assert.equal(t.state.quoteStates.has(11), false);
  assert.match(SIDEPANEL, /rememberFill\(frames, ctx\);[\s\S]*rememberFill\(frames, ctx\);/, 'both fills say whose tab');
});

// ---------------------------------------------------------------------------------------------
// Audit 2026-10-08, finding 5 (PR claude/run-identity): a fill's context is taken before it waits,
// and its results are checked against it before anything is remembered.

// A fill that waits on the carrier while the panel moves on, as the Codex reproduction modelled it.
function fillHarness({ carrier = { id: 'amwins', practice: false, layoutSteps: amwins.layoutSteps }, rules = 'abcdef012345' } = {}) {
  let release, reject, markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pending = new Promise((resolve, fail) => { release = resolve; reject = fail; });
  const intakeA = { id: 'intake-A', record: { client: 'A' } };
  const state = {
    intake: intakeA, intakeRevision: 0, active: { drivers: 0, vehicles: 0, trailers: 0 },
    tab: { id: 7, url: 'https://carrier.test/quote-A', carrier }, tabSessions: new Map(),
    filled: new Map(), labels: new Map(), choices: new Map(), agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(), autoPages: new Set(), doneSteps: new Set(),
    layoutReadyTabs: new Set(), autoPaused: false, autoPending: false, pagePending: null, filling: false, autoTimer: null,
    // A follow-up fill runs on a page that already has its report (else autoFill hands it to fillPage).
    reports: new Map([['7|report', {}]]),
  };
  const ui = {
    overwrite: { checked: false }, 'auto-advance': { checked: true }, 'auto-followups': { checked: true }, 'auto-pages': { checked: false },
    fill: { disabled: false, textContent: '' }, report: { children: [], replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); } },
    'fill-stop': {},
  };
  const seen = { plan: null, logged: [], rendered: 0, reportTabs: [], problems: [], layouts: 0, persistedKeys: [], persistedActions: [], afterFill: [], options: null };
  const context = {
    state, URL, crypto, Date, rulesVersion: rules, $: (id) => ui[id], pageOf: (url) => new URL(url).pathname, onQuotePage: () => true, showStopPage() {},
    clearTimeout() {}, setTimeout: () => 1, pickListItem: async () => {}, noteMissingUnit: () => {},
    buildPlan: (record, c, active) => { seen.plan = { client: record.client, active: { ...active } }; return []; },
    fillOptions: () => ({}), pendingAi: () => [], ensureRecorder: async () => {}, tellRecorder: async () => {}, retireAiOrigins: async () => {},
    runKit: async (tabId, carrier, func, args) => { seen.options = args[1]; markStarted(); return pending; }, afterFill: (frames, ctx) => { seen.afterFill.push(ctx); return false; }, recordLayout: () => { seen.layouts++; },
    fillEvents, knownStep, advanceFor, redactionTerms: () => ['A value'], redactor: (terms) => (text) => terms.reduce((acc, t) => acc.split(t).join('[client]'), String(text)),
    renderReport: (frames, ctx) => { seen.rendered++; seen.reportTabs.push(ctx?.tabId); }, renderSite() {}, renderSteps() {}, runPendingPage() {}, remarkAi: async () => {}, assistAfterFill() {},
    reportKey: (tabId) => `${tabId}|report`, watchFill: () => () => {}, showFinish() {}, reportShown: () => true,
    fillProblem: (ctx, text) => { seen.problems.push({ tabId: ctx.tabId, text }); },
    viewOf: () => 't1', usage: { currentSession: () => ({ id: `session-${state.intake.id}`, intakeId: state.intake.id, keySalt: 'salt' }), log: (...events) => seen.logged.push(...events) },
    h: (tag, props, text) => ({ tag, text }), save: async () => {},
    persistAgentKeys: (tabId, keys) => { seen.persistedKeys.push([tabId, keys]); }, persistDoneActions: (tabId, ids) => { seen.persistedActions.push([tabId, ids]); },
    stateCode: () => null, noteQuoteState() {},
  };
  vm.createContext(context);
  vm.runInContext(['rememberFill', 'fillPage', 'autoFill'].map(extractFunction).join('\n'), context);
  const results = [{ frameId: 0, result: {
    fields: 1, filled: [{ key: 'old-field', path: 'clientA.field', shown: 'A value', controlKind: 'select' }], actions: [{ id: 'old-helper' }], protectedKeys: ['old-manual-edit'],
    labels: [['old-field', 'Old field']], choices: [['old-choice', ['A']]], invalidatedActions: [], halted: false, stepKey: 'Vehicles / A value',
  } }];
  return { state, ui, seen, context, intakeA, started, release, reject, results };
}

// Codex reproduction (stale-fill-reproduction.mjs): a fill's results came back after the agent had
// loaded another intake and moved to its tab, and were remembered and logged as that intake's.
test('a fill whose intake changed while the carrier worked is dropped: the new intake and tab are untouched', async () => {
  const t = fillHarness();
  const run = t.context.fillPage();
  await t.started;
  assert.equal(t.state.filling, true);
  assert.deepEqual(t.seen.plan, { client: 'A', active: { drivers: 0, vehicles: 0, trailers: 0 } });
  // Another intake is loaded and its quote tab comes to the front while the carrier works.
  t.state.intake = { id: 'intake-B', record: { client: 'B' } };
  t.state.tab = { id: 8, url: 'https://carrier.test/quote-B', carrier: t.state.tab.carrier };
  t.state.active = { drivers: 1, vehicles: 1, trailers: 0 };
  Object.assign(t.state, { filled: new Map(), labels: new Map(), choices: new Map(), agentKeys: new Map(), doneActions: new Set(), autoPages: new Set() });
  t.release(t.results);
  await run;
  assert.equal(t.state.filling, false);
  assert.deepEqual([t.state.filled.size, t.state.labels.size, t.state.choices.size, t.state.agentKeys.size, t.state.doneActions.size, t.state.autoPages.size], [0, 0, 0, 0, 0, 0], "intake B's state is untouched");
  assert.equal(t.state.tabSessions.size, 0, 'nor is tab 7 given the earlier intake\'s results');
  assert.equal(t.state.layoutReadyTabs.has(7), false, 'tab 7 holds intake A\'s answers: no layouts for B from it');
  assert.deepEqual([t.seen.rendered, t.seen.layouts, t.seen.persistedKeys.length, t.seen.persistedActions.length, t.seen.afterFill.length], [0, 0, 0, 0, 0]);
  assert.deepEqual(t.seen.logged.map((e) => [e.type, e.carrier, e.page, e.auto, e.error]), [['fill_error', 'amwins', '/quote-A', false, 'stale: intake changed during the fill']]);
  assert.match(t.seen.logged[0].run, /^[\w-]{8,64}$/);
  // Codex on PR #65 (f8d6215): logged after B was loaded, the event is still A's quote and intake.
  assert.deepEqual([t.seen.logged[0].session, t.seen.logged[0].intakeId], ['session-intake-A', 'intake-A']);
  assert.deepEqual(t.seen.problems.map((p) => p.tabId), [7], 'said in the report of the page it filled');
  assert.match(t.seen.problems[0].text, /intake changed during the fill/);
  assert.doesNotMatch(JSON.stringify(t.seen.logged), /A value|clientA/, 'no client data in the error');
});

// FL live run 6, 2026-10-21 (the maintainer: "give back, then Recalculate"): GEICO put its own
// coverage choices back over the fill's, and the agent picked each one again by hand. The agent's
// Fill this page gives such an answer again (no `takenBack`); an automatic fill and Looks right keep
// what the page shows (the carrier's `takenBack`, as fillOptions builds it).
test('only the agent\'s Fill this page gives back an answer the page took back', async () => {
  const runs = [];
  for (const args of [[], [{ auto: 'page' }], [{ confirmed: 'receipt' }]]) {
    const t = fillHarness();
    t.context.fillOptions = (carrier, extra) => ({ takenBack: { steps: ['Quote & Coverages'], keys: {} }, ...extra });
    const run = t.context.fillPage(...args);
    await t.started;
    t.release(t.results);
    await run;
    runs.push(t.seen.options.takenBack);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(runs)), [null, { steps: ['Quote & Coverages'], keys: {} }, { steps: ['Quote & Coverages'], keys: {} }]);
});

test('an intake correction during a fill makes its results stale too, for automatic fills as well', async () => {
  const t = fillHarness();
  const run = t.context.autoFill('/quote-A');
  await t.started;
  t.state.intakeRevision++;
  t.release(t.results);
  await run;
  assert.deepEqual([t.state.filled.size, t.state.doneActions.size, t.seen.afterFill.length, t.state.layoutReadyTabs.size], [0, 0, 0, 0]);
  assert.deepEqual(t.seen.logged.map((e) => [e.type, e.auto, e.error]), [['fill_error', true, 'stale: intake changed during the fill']]);
  assert.equal(t.state.filling, false);
});

test('a fill that stays current is remembered for its tab, and its events share a run with the rules, settings and step', async () => {
  const t = fillHarness();
  const run = t.context.fillPage();
  await t.started;
  // The agent looks at another quote tab meanwhile: the results still belong to tab 7.
  t.state.tab = { id: 8, url: 'https://carrier.test/quote-B', carrier: t.state.tab.carrier };
  t.release(t.results);
  await run;
  assert.equal(t.state.filled.size, 0, 'tab 8 gets nothing');
  const tab7 = t.state.tabSessions.get(7);
  assert.deepEqual([[...tab7.doneActions], tab7.filled.get('old-field').path, [...tab7.agentKeys.get('/quote-A')], tab7.labels.get('old-field')], [['old-helper'], 'clientA.field', ['old-manual-edit'], 'Old field']);
  assert.deepEqual(t.seen.persistedKeys.map(([id]) => id), [7], 'persisted as tab 7\'s');
  assert.deepEqual(t.seen.persistedActions.map(([id]) => id), [7]);
  assert.equal(t.state.layoutReadyTabs.has(7), true);
  assert.equal(t.seen.afterFill[0].run, t.seen.logged[0].run, 'the step watcher knows the run');
  const [fillRun, ...fields] = t.seen.logged;
  assert.equal(fillRun.type, 'fill_run');
  assert.match(fillRun.run, /^[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(JSON.stringify([fillRun.rules, fillRun.settings, fillRun.step, fillRun.view, fillRun.overwrite, fillRun.auto])), ['abcdef012345', { autoAdvance: true, autoFollowUps: true, autoPages: false, overwrite: false }, 'Vehicles', 't1', false, false]);
  assert.ok(fields.length && fields.every((e) => e.type === 'fill_field' && e.run === fillRun.run && e.step === 'Vehicles'), 'every field event shares the run and step, as the step\'s own name');
  assert.doesNotMatch(JSON.stringify(t.seen.logged), /A value/);
});

// Codex on PR #65 (f8d6215): an automatic fill never overwrites, whatever the checkbox says, and
// its run's settings say what it used.
test('a run\'s settings name the overwrite the fill used: never for an automatic fill, the checkbox for a manual one', async () => {
  for (const [auto, expected] of [[true, false], [false, true]]) {
    const t = fillHarness();
    t.ui.overwrite.checked = true;
    const run = auto ? t.context.autoFill('/quote-A') : t.context.fillPage();
    await t.started;
    t.release(t.results);
    await run;
    const fillRun = t.seen.logged.find((e) => e.type === 'fill_run');
    assert.deepEqual([fillRun.auto, fillRun.overwrite, fillRun.settings.overwrite], [auto, expected, expected]);
  }
});

test('without a rules fingerprint the run carries none, and a carrier with page names carries no step', async () => {
  const t = fillHarness({ carrier: { id: 'progressive', practice: false }, rules: null });
  const run = t.context.fillPage();
  await t.started;
  t.release(t.results);
  await run;
  const [fillRun] = t.seen.logged;
  assert.equal('rules' in fillRun, false);
  assert.equal('step' in fillRun, false);
  assert.equal(t.state.filled.get('old-field').path, 'clientA.field', 'remembered on the tab in front');
});

test('a fill error is logged redacted, with its run, and not from a practice page', async () => {
  for (const practice of [false, true]) {
    const t = fillHarness({ carrier: { id: 'progressive', practice } });
    t.context.runKit = async () => { throw new Error('A value could not be put in Business Name'); };
    await t.context.fillPage();
    assert.equal(t.state.autoPaused, true);
    if (practice) { assert.deepEqual(t.seen.logged, []); continue; }
    assert.deepEqual(t.seen.logged.map((e) => [e.type, e.error]), [['fill_error', '[client] could not be put in Business Name']]);
    assert.match(t.seen.logged[0].run, /^[0-9a-f-]{36}$/);
  }
});

test('a fill\'s bookkeeping lands on the tab it filled when the agent has moved to another, and follows a switch back', async () => {
  const h = harness();
  const carrier = { id: 'progressive' };
  h.state.tab = { ...quoteTab(1), carrier };
  h.setActiveTab(quoteTab(2, 'Drivers'));
  await h.refreshTab();
  h.rememberFill([{ fields: 1, filled: [{ key: 'k', path: 'p', shown: 'v' }], actions: [{ id: 'lookupVin:0' }], protectedKeys: ['pk'], labels: [['k', 'Key']], choices: [['c', ['A']]], halted: true }],
    { tabId: 1, carrier, page: 'AddVehicle', scope: 'AddVehicle|v0' });
  assert.deepEqual([h.state.filled.size, h.state.doneActions.size, h.state.agentKeys.size, h.state.autoPaused], [0, 0, 0, false], 'the tab in front gets nothing');
  const saved = h.state.tabSessions.get(1);
  assert.deepEqual([[...saved.doneActions], saved.filled.get('k').path, [...saved.agentKeys.get('AddVehicle|v0')], saved.labels.get('k'), [...saved.choices.get('c')], saved.autoPaused],
    [['lookupVin:0'], 'p', ['pk'], 'Key', ['A'], true]);
  h.setActiveTab(quoteTab(1));
  await h.refreshTab();
  assert.deepEqual([[...h.state.doneActions], h.state.autoPaused], [['lookupVin:0'], true]);
  // A tab the panel has no session for yet (its sessions were cleared) gets one of its own.
  h.rememberFill([{ filled: [], actions: [{ id: 'x' }] }], { tabId: 9, carrier, page: 'P', scope: 'P' });
  assert.deepEqual([...h.state.tabSessions.get(9).doneActions], ['x']);
  assert.equal(h.state.doneActions.has('x'), false);
});

// Audit 2026-10-08, finding 5: loading a PDF wiped every intake's edit keys and helper records,
// so coming back to a client whose quote was still open added its vehicles again.
test('loading another intake keeps the first intake\'s edit keys and helper records; Clear forgets only the current one', async () => {
  const memory = {};
  const records = { keys: [], seen: {} };
  const context = {
    Promise, Set, Date, state: { agentKeysEpochs: new Map() }, agentKeysQueue: Promise.resolve(), doneActionsQueue: Promise.resolve(), KEEP_INTAKES: 20, KEEP_INTAKE_DAYS: 30,
    agentKeysStore: { get: async () => records.keys, set: async (v) => { records.keys = v; } },
    doneActionsStore: {
      clear: async (scope) => { for (const k of Object.keys(memory)) if (k.startsWith(`doneActions:${scope}:`)) delete memory[k]; },
      scopes: async () => Object.keys(memory).filter((k) => k.startsWith('doneActions:')).map((k) => k.split(':')[1]),
    },
    // The unit forms (GEICO) are kept and let go with the helper records.
    unitFormsStore: {
      clear: async (scope) => { for (const k of Object.keys(memory)) if (k.startsWith(`unitForms:${scope}:`)) delete memory[k]; },
      scopes: async () => Object.keys(memory).filter((k) => k.startsWith('unitForms:')).map((k) => k.split(':')[1]),
    },
    intakesSeenStore: { get: async () => records.seen, set: async (v) => { records.seen = v; } },
  };
  vm.runInNewContext(['clearAgentKeys', 'pruneAgentRecords'].map(extractFunction).join('\n'), context);
  const day = 86_400_000;
  const seed = () => { records.keys = [{ scope: 'A', tabId: 7, page: 'Quote', keys: ['k'] }]; memory['doneActions:A:7'] = ['addVehicle:0']; memory['unitForms:A:7'] = { vehicles: { form1: 0 } }; };
  seed();
  assert.deepEqual(JSON.parse(JSON.stringify(await context.pruneAgentRecords('A', 1000 * day))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.pruneAgentRecords('B', 1001 * day))), [], 'loading B keeps A');
  assert.deepEqual([records.keys.length, memory['doneActions:A:7'], memory['unitForms:A:7']], [1, ['addVehicle:0'], { vehicles: { form1: 0 } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.pruneAgentRecords('A', 1002 * day))), [], 'A again (the same PDF): its records are still there');
  await context.clearAgentKeys('B');
  assert.deepEqual([records.keys.length, memory['doneActions:A:7']], [1, ['addVehicle:0']], 'Clear on B leaves A');
  await context.clearAgentKeys(null);
  assert.equal(records.keys.length, 1, 'nothing is cleared without an intake');
  await context.clearAgentKeys('A');
  assert.deepEqual([records.keys.length, Object.keys(memory)], [0, []]);
  // A unit-form record alone still dates its intake, so it is let go in time.
  const seenBefore = records.seen;
  memory['unitForms:old:3'] = { drivers: { form2: 1 } };
  records.seen = {};
  await context.pruneAgentRecords('A', 1000 * day);
  assert.equal(records.seen.old, new Date(1000 * day).toISOString());
  delete memory['unitForms:old:3'];
  records.seen = seenBefore;
  // Another intake's records go after 30 days without being loaded...
  seed();
  await context.pruneAgentRecords('A', 1000 * day);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.pruneAgentRecords('B', 1031 * day))), ['A']);
  assert.deepEqual([records.keys.length, Object.keys(memory), Object.keys(records.seen)], [0, [], ['B']]);
  // ...or once more than 20 intakes have records (the ones loaded longest ago go first); a record
  // from before intakes were stamped counts from now.
  records.seen = {};
  for (let i = 1; i <= 21; i++) await context.pruneAgentRecords(`C${i}`, (2000 + i) * day);
  records.keys = [{ scope: 'old', tabId: 1, page: 'P', keys: ['k'] }];
  assert.deepEqual(JSON.parse(JSON.stringify(await context.pruneAgentRecords('D', 2030 * day))), ['C3', 'C2'], 'C1 already went when the 21st was loaded');
  assert.deepEqual(records.keys.map((x) => x.scope), ['old']);
  assert.equal(records.seen.old, new Date(2030 * day).toISOString());
  // The panel: on load, this intake's records may be restored again and the others are pruned;
  // Clear takes the intake before the session is dropped; nothing clears every intake any more.
  assert.match(extractFunction('loadFile'), /doneRestored\.clear\(\);/);
  assert.match(extractFunction('loadFile'), /await pruneAgentRecords\(summary\.intakeId\);/);
  assert.doesNotMatch(SIDEPANEL, /clearAgentKeys\(\)/);
  assert.match(extractFunction('clearClient'), /^async function clearClient\(\) \{\s+const scope = usage\.currentSession\(\)\?\.intakeId;[\s\S]{0,600}usage\.restoreSession\(null\);[\s\S]{0,300}await clearAgentKeys\(scope\);/);
  assert.match(SIDEPANEL, /if \(what === 'clear'\) clearClient\(\);/, 'Clear runs once the agent confirms it');
});

// Codex on PR #65 (2c8eeb9): Clear was done once the edit keys were gone, while the helper records'
// removal could still be queued; the same PDF loaded right after got the cleared helper ids back.
test('Clear is done only once the helper records are gone, and a restore waits for it', async () => {
  let releaseClear;
  const memory = { 'doneActions:A:7': ['addVehicle:0'] };
  const context = {
    Promise, Number, Array, Set, agentKeysQueue: Promise.resolve(), doneActionsQueue: Promise.resolve(),
    agentKeysStore: { get: async () => [], set: async () => {} },
    doneActionsStore: {
      clear: (scope) => new Promise((resolve) => { releaseClear = () => { delete memory[`doneActions:${scope}:7`]; resolve(); }; }),
      get: async (scope, tabId) => memory[`doneActions:${scope}:${tabId}`] ?? [],
    },
    unitFormsStore: { clear: async () => {}, get: async () => null },
    usage: { currentSession: () => ({ intakeId: 'A' }) }, state: { tab: { id: 7 }, doneActions: new Set() },
  };
  vm.runInNewContext(`${SIDEPANEL.match(/const doneRestored = new Set\(\);/)[0]}\n${['clearAgentKeys', 'restoreDoneActions'].map(extractFunction).join('\n')}`, context);
  let cleared = false;
  const clear = context.clearAgentKeys('A').then(() => { cleared = true; });
  const restore = context.restoreDoneActions(7);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(cleared, false, 'still removing the helper records');
  releaseClear();
  await Promise.all([clear, restore]);
  assert.equal(cleared, true);
  assert.deepEqual([...context.state.doneActions], [], 'the cleared ids are not restored');
});

// Codex on PR #65 (2c8eeb9): listing helper records read the whole of extension storage, with the
// usage queue (up to 20,000 events), on every PDF load.
test('helper records are listed by key, without reading the stored values where Chrome can', async () => {
  const context = { Object };
  vm.runInNewContext(extractFunction('storedKeys'), context);
  const values = { 'doneActions:A:7': ['x'], usageLog: new Array(3).fill({}) };
  const modern = { getKeys: async () => Object.keys(values), get: async (k) => { if (k === null) throw new Error('read everything'); return {}; } };
  assert.deepEqual(await context.storedKeys(modern), ['doneActions:A:7', 'usageLog']);
  const older = { get: async (k) => (k === null ? values : {}) }; // Chrome before 130
  assert.deepEqual(await context.storedKeys(older), ['doneActions:A:7', 'usageLog']);
  assert.doesNotMatch(SIDEPANEL, /storage\.local\.get\(null\)/);
});

// Audit 2026-10-08, finding 5: a recorder paused by a fill the panel never finished (closed
// mid-fill) stayed paused, blind until the page reloaded.
test('a recorder already in the page is told to resume, unless a fill or AI apply is under way', async () => {
  const sent = [];
  const state = { intake: {}, tab: { id: 4, carrier: { id: 'progressive' } }, filling: false };
  const context = { state, inExtension: true, chrome: { scripting: { executeScript: async () => {} } }, tellRecorder: async (cmd, tabId) => sent.push([cmd, tabId]) };
  vm.runInNewContext(extractFunction('ensureRecorder'), context);
  await context.ensureRecorder();
  assert.deepEqual(sent, [['resume', 4]]);
  state.filling = true;
  await context.ensureRecorder();
  assert.equal(sent.length, 1, 'a fill (or applyAi) paused it on purpose');
  state.filling = false;
  context.chrome.scripting.executeScript = async () => { throw new Error('no access'); };
  await context.ensureRecorder();
  assert.equal(sent.length, 1, 'no recorder in the page: nothing to resume');
  assert.match(extractFunction('fillPage'), /await ensureRecorder\(\);\s+await tellRecorder\('pause', tabId\);/, 'a fill pauses right after, with filling already set');
});

// Audit 2026-10-08, finding 6: a Continue that didn't take went unreported after the silent retry.
test('a Continue that did not take after its retry pauses automatic filling, tells the agent and is logged', async () => {
  const logged = [], appended = [];
  let fills = 0;
  const state = { tab: { id: 1, url: 'Step' }, intake: {}, filling: false, pagePending: null, autoPaused: false, advanceRetried: new Set(), doneSteps: new Set(['Step||Vehicles']) };
  const context = { state, pageOf: (u) => u, $: () => ({ checked: true }), setTimeout: (fn) => fn(), fillProblem: (ctx, text) => appended.push(text),
    runKit: async () => [{ frameId: 0, result: 'same' }], fillPage: () => { fills++; }, usage: { log: (e) => logged.push(e) } };
  vm.runInNewContext(extractFunction('watchNextStep'), context);
  const carrier = { id: 'amwins', practice: false };
  await context.watchNextStep(carrier, 'Step', 'same', 'Step||Vehicles', 'run-1');
  assert.equal(fills, 1, 'the lost Continue is clicked once more, silently');
  assert.deepEqual([[...state.advanceRetried], state.doneSteps.has('Step||Vehicles'), state.autoPaused, logged], [['Step||Vehicles'], false, false, []]);
  // The retried fill clicked Continue again and watches again; the step still doesn't change.
  await context.watchNextStep(carrier, 'Step', 'same', 'Step||Vehicles', 'run-2');
  assert.equal(fills, 1, 'not clicked a third time');
  assert.equal(state.autoPaused, true);
  assert.match(appended[0], /Continue didn't take: click it yourself\./);
  assert.deepEqual(JSON.parse(JSON.stringify(logged)), [{ type: 'fill_error', carrier: 'amwins', page: 'Step', run: 'run-2', auto: 'page', error: 'continue did not take' }]);
  // A practice page says it but logs nothing; a step that does change is filled as before.
  state.autoPaused = false;
  await context.watchNextStep({ id: 'amwins', practice: true }, 'Step', 'same', 'Step||Vehicles');
  assert.deepEqual([state.autoPaused, logged.length, appended.length], [true, 1, 2]);
  let reads = 0;
  context.runKit = async () => [{ frameId: 0, result: ++reads > 2 ? 'next' : 'same' }];
  await context.watchNextStep(carrier, 'Step', 'same', 'Step||Other');
  assert.equal(fills, 2);
  assert.match(extractFunction('afterFill'), /watchNextStep\(carrier, page, advanced\.signatureBefore, doneKey, run, ctx\)/);
});

// FL live run 4, 2026-10-21 (W43-13): GEICO hadn't moved 6 s after the fill's Next, and the retry
// clicked Next again on top of the agent's own (three Nexts in 8 s). A carrier without the retry
// (`continueRetry: false`) is never clicked again: it is waited for longer, then the agent is told.
test('a Continue on a carrier without the retry is never clicked again: waited for, then the agent is told', async () => {
  const logged = [], appended = [];
  let fills = 0, reads = 0;
  const state = { tab: { id: 1, url: 'Step' }, intake: {}, filling: false, pagePending: null, autoPaused: false, advanceRetried: new Set(), doneSteps: new Set(['Step||Vehicles']) };
  const context = { state, pageOf: (u) => u, $: () => ({ checked: true }), setTimeout: (fn) => fn(), fillProblem: (ctx, text) => appended.push(text),
    runKit: async () => { reads++; return [{ frameId: 0, result: 'same' }]; }, fillPage: () => { fills++; }, usage: { log: (e) => logged.push(e) } };
  vm.runInNewContext(extractFunction('watchNextStep'), context);
  const geico = { id: 'geico', continueRetry: false };
  await context.watchNextStep(geico, 'Step', 'same', 'Step||Vehicles', 'run-1');
  assert.equal(fills, 0, 'never clicked again');
  // Read every 150 ms: the retry's 6 s is 40 reads.
  assert.ok(reads > 40, `waited longer than the retry's 6 s (${reads} reads)`);
  assert.equal(state.autoPaused, true);
  assert.equal(state.doneSteps.has('Step||Vehicles'), true, 'its Continue stays done');
  assert.match(appended[0], /Continue didn't take: click it yourself\./);
  assert.deepEqual(JSON.parse(JSON.stringify(logged)), [{ type: 'fill_error', carrier: 'geico', page: 'Step', run: 'run-1', auto: 'page', error: 'continue did not take' }]);
  // While GEICO's page loads, nothing counts: the next step is filled when it comes, up to a minute.
  state.autoPaused = false;
  reads = 0;
  context.runKit = async () => [{ frameId: 0, result: ++reads < 300 ? null : 'next' }];
  await context.watchNextStep(geico, 'Step', 'same', 'Step||Other');
  assert.equal(fills, 1, 'the next step, after 45 s of loading');
  assert.equal(state.autoPaused, false);
});

// Audit 2026-10-08, finding 11: a problem report waited for the next minute's upload, which the
// panel was often closed before.
test('a problem report is uploaded as soon as it is logged', () => {
  assert.match(extractFunction('wireUsage'), /type: 'problem_report'[\s\S]{0,400}\$\('usage-note'\)\.textContent = 'Thanks — saved with the usage log\.';\s+\/\/[^\n]*\n\s+uploadNow\(\);/);
});

// Contract 1 (audit 2026-10-08): a field change on a one-address application names its step.
test('field changes carry the step the recorder read, only for one-address applications', () => {
  const logged = [];
  const state = { intake: { record: {} }, tab: { id: 1, url: 'https://x.test/application/businessauto', carrier: { id: 'amwins', layoutSteps: amwins.layoutSteps } }, filled: new Map(), labels: new Map(), choices: new Map(),
    agentKeys: new Map(), visitedPages: new Set(), autoPages: new Set(), layoutReadyTabs: new Set(), layoutNewTabs: new Set(), quoteStates: new Map() };
  const context = { state, URL, $: () => ({ checked: false }), usage: { log: (...e) => logged.push(...e), currentSession: () => ({ keySalt: 's' }) }, redactor: () => (s) => s, redactionTerms: () => [],
    fieldChangeEvent: (c, ctx) => ({ type: 'field_change', key: c.key, step: ctx.step }), knownStep, viewOf: () => 't1', scheduleLayout() {}, scheduleAutoFill() {}, quoteStatePick: () => undefined, persistAgentKeys() {}, settleRejectedAi: async () => false, answeredOnPage() {} };
  vm.runInNewContext(`${PAGE_HELPERS}\n${extractFunction('onRecorderMessage')}`, context);
  const change = (step = 'Vehicles ') => context.onRecorderMessage({ ra: 'usage', event: 'field_changes', page: '/application/businessauto', step, changes: [{ key: 'vin', before: '', after: 'x', agent: true }] }, { tab: { id: 1 }, frameId: 0 });
  change();
  assert.equal(logged.at(-1).step, 'Vehicles');
  // Codex on PR #65 (2c8eeb9): only a known step name is sent. The tab may still show the previous
  // client's quote, whose names the loaded intake's redaction doesn't know.
  change('Draft Application Saved! / Coverages');
  assert.equal(logged.at(-1).step, 'Coverages', 'a dialog heading beside the step: the step');
  change('Jordan Avery Trucking LLC');
  assert.equal(logged.at(-1).step, undefined, 'a heading that is no step name: nothing');
  state.tab.carrier = { id: 'progressive' };
  change();
  assert.equal(logged.at(-1).step, undefined, 'a carrier with page names: no step');
});

// PR #65 round 3: retained results do not authorize work on the tab now in front.
test('fills finishing on another tab keep origin markers and never start its helpers, watcher, report or AI', async () => {
  for (const auto of [false, true]) {
    const t = fillHarness({ carrier: { id: 'progressive', vehiclePages: ['/quote-A'] } });
    const timers = [], watched = [];
    t.context.setTimeout = (fn) => { timers.push(fn); return 1; };
    t.context.watchNextStep = (...args) => watched.push(args);
    vm.runInContext(extractFunction('afterFill'), t.context);
    Object.assign(t.results[0].result, { advanced: 'Continue', signatureBefore: 'old', stepKey: 'Vehicles' });
    const run = auto ? t.context.autoFill('/quote-A') : t.context.fillPage();
    await t.started;
    t.state.tab = { id: 8, url: 'https://carrier.test/quote-A', carrier: t.state.tab.carrier };
    t.state.active = { drivers: 2, vehicles: 2, trailers: 2 };
    t.ui.report.replaceChildren({ text: 'Tab B report' });
    t.release(t.results);
    await run;
    const origin = t.state.tabSessions.get(7);
    assert.equal(origin.autoPages.has('/quote-A'), !auto, 'manual origin marker stays with tab 7');
    assert.deepEqual([...origin.doneSteps], ['/quote-A|v0|Vehicles'], 'Continue uses the origin entity');
    assert.deepEqual([t.state.autoPages.size, t.state.doneSteps.size, t.seen.layouts, timers.length, watched.length], [0, 0, 0, 0, 0]);
    // A manual fill's report is kept for tab 7 (putReport shows it only when tab 7 is in front);
    // an automatic one's isn't made at all.
    assert.deepEqual(t.seen.reportTabs, auto ? [] : [7]);
    assert.deepEqual(t.ui.report.children, [{ text: 'Tab B report' }]);
  }
});

test('helper follow-ups and pending-page timers discard a switched tab or changed intake', () => {
  for (const change of ['tab', 'replacement', 'correction']) {
    const t = fillHarness();
    const timers = [], scheduled = [];
    t.context.setTimeout = (fn) => { timers.push(fn); return 1; };
    t.context.scheduleAutoFill = () => scheduled.push('follow-up');
    t.context.fillPage = () => scheduled.push('pending page');
    vm.runInContext(['afterFill', 'runPendingPage'].map(extractFunction).join('\n'), t.context);
    const ctx = t.context.fillContext({ tabId: 7, carrier: t.state.tab.carrier, page: '/quote-A' });
    t.context.afterFill([{ actions: [{ id: 'helper' }] }], ctx);
    t.state.pagePending = '/quote-A';
    t.context.runPendingPage(ctx);
    assert.equal(timers.length, 2);
    if (change === 'tab') t.state.tab = { ...t.state.tab, id: 8 };
    if (change === 'replacement') t.state.intake = { record: {} };
    if (change === 'correction') t.state.intakeRevision++;
    timers.forEach((fn) => fn());
    assert.deepEqual(scheduled, [], change);
  }
});

test('list verification discards driver and trailer reads after intake replacement or correction before writing helpers', async () => {
  for (const list of ['drivers', 'trailers']) for (const change of ['replacement', 'correction']) {
    const carrier = { driverList: 'Drivers', trailerList: 'Vehicles' };
    const record = { vehicles: [{ vin: '1XPWD40X1DD000001' }], trailers: [{ vin: '1W1MAFZB0KA000002' }], drivers: [{ first: 'Jordan', last: 'Sample' }] };
    const state = { tab: { id: 7 }, intake: { record }, intakeRevision: 0, active: { drivers: 0, trailers: 0, vehicles: 0 }, doneActions: new Set(['trailerEntered:0']) };
    let release, started;
    const ready = new Promise((resolve) => { started = resolve; });
    const pending = new Promise((resolve) => { release = resolve; });
    const writes = [];
    const context = { state, runKit: async () => { started(); return pending; }, persistDoneActions: () => writes.push('persist'), save: async () => writes.push('save'), renderPickers: () => writes.push('render') };
    vm.runInNewContext(['verifyDrivers', 'verifyListed', 'formScoped', 'pickUnitForm', 'pickUnitToAdd', 'pickListItem'].map(extractFunction).join('\n'), context);
    const run = context.pickListItem(carrier, list === 'drivers' ? 'Drivers' : 'Vehicles');
    await ready;
    if (change === 'replacement') state.intake = { record: { ...record } };
    else state.intakeRevision++;
    state.doneActions = new Set(['replacement-helper', 'trailerEntered:0']);
    release([{ result: list === 'drivers' ? [true] : [true, false] }]);
    await run;
    assert.deepEqual([...state.doneActions], ['replacement-helper', 'trailerEntered:0'], `${list}: no add or deletion from the old read`);
    assert.deepEqual(writes, [], `${list}: no storage or picker writes`);
    assert.deepEqual(state.active, { drivers: 0, trailers: 0, vehicles: 0 });
  }
});

test('manual and automatic fill rejections after intake replacement or correction use only the stale warning', async () => {
  for (const auto of [false, true]) for (const change of ['replacement', 'correction']) {
    const t = fillHarness();
    const run = auto ? t.context.autoFill('/quote-A') : t.context.fillPage();
    await t.started;
    if (change === 'replacement') t.state.intake = { id: 'intake-B', record: { client: 'B' } };
    else t.state.intakeRevision++;
    t.ui.report.replaceChildren();
    t.reject(new Error('Old carrier error with A value'));
    await run;
    assert.equal(t.state.autoPaused, false, 'a rejected old request does not pause the current intake');
    assert.equal(t.state.tabSessions.size, 0);
    assert.deepEqual(t.seen.logged.map((e) => [e.error, e.session, e.intakeId]), [['stale: intake changed during the fill', 'session-intake-A', 'intake-A']]);
    assert.equal(t.seen.problems.length, 1);
    assert.match(t.seen.problems[0].text, /intake changed during the fill/);
    assert.doesNotMatch(JSON.stringify([t.seen.problems, t.seen.logged]), /Old carrier error|A value/);
  }
});

test('Continue watchers recheck their tab and intake after each awaited page read', async () => {
  for (const change of ['tab', 'replacement', 'correction']) {
    const state = { tab: { id: 7, url: 'Step' }, intake: {}, intakeRevision: 0, filling: false, doneSteps: new Set(), advanceRetried: new Set(), autoPaused: false };
    let reads = 0;
    const writes = [];
    const context = { state, pageOf: (url) => url, $: () => ({ checked: true }), setTimeout: (fn) => fn(), fillPage: () => writes.push('fill'),
      runKit: async (tabId) => {
        assert.equal(tabId, 7);
        if (++reads === 2) {
          if (change === 'tab') state.tab = { id: 8, url: 'Step' };
          if (change === 'replacement') state.intake = {};
          if (change === 'correction') state.intakeRevision++;
        }
        return [{ frameId: 0, result: 'next' }];
      } };
    vm.runInNewContext(extractFunction('watchNextStep'), context);
    await context.watchNextStep({}, 'Step', 'old', 'done');
    assert.equal(reads, 2);
    assert.deepEqual(writes, [], change);
    assert.deepEqual([state.autoPaused, state.doneSteps.size, state.advanceRetried.size], [false, 0, 0]);
  }
});

test('a scheduled automatic fill keeps its tab and intake through the final timer', () => {
  for (const change of ['tab', 'replacement', 'correction']) {
    const t = fillHarness();
    const timers = [], fills = [];
    t.state.autoPages.add('/quote-A');
    t.context.autoFill = () => fills.push('fill');
    t.context.setTimeout = (fn) => { timers.push(fn); return 1; };
    vm.runInContext(extractFunction('scheduleAutoFill'), t.context);
    t.context.scheduleAutoFill('/quote-A');
    assert.equal(timers.length, 1);
    if (change === 'tab') t.state.tab = { ...t.state.tab, id: 8 };
    if (change === 'replacement') t.state.intake = { record: {} };
    if (change === 'correction') t.state.intakeRevision++;
    timers[0]();
    assert.deepEqual(fills, [], change);
  }
});

// PR #65 round 4: local tab ids are scoped to one browser/extension session. Evaluate the
// actual store declarations as well as persistence functions so every read/write path is gated.
function tabRecordsHarness(localData = {}, sessionData = {}, locks) {
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const area = (data) => ({
    get: async (key) => clone(key == null ? data : Object.fromEntries((Array.isArray(key) ? key : [key]).map((k) => [k, data[k]]))),
    set: async (values) => Object.assign(data, clone(values)),
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    getKeys: async () => Object.keys(data),
  });
  if (!locks) {
    let queue = Promise.resolve();
    locks = { request: (name, task) => { const result = queue.then(task); queue = result.catch(() => {}); return result; } };
  }
  const state = { tab: { id: 7 }, agentKeys: new Map(), doneActions: new Set() };
  let intakeId = 'A';
  const context = { state, inExtension: true, memory: {}, chrome: { storage: { local: area(localData), session: area(sessionData) } },
    navigator: { locks }, crypto, usage: { currentSession: () => ({ intakeId }) } };
  vm.createContext(context);
  vm.runInContext(SIDEPANEL.slice(SIDEPANEL.includes('const TAB_RECORDS_SESSION_KEY') ? SIDEPANEL.indexOf('const TAB_RECORDS_SESSION_KEY') : SIDEPANEL.indexOf('const AGENT_KEYS_KEY'), SIDEPANEL.indexOf('const FNV_OFFSET'))
    + '\nconst doneRestored = new Set();\n'
    + ['persistAgentKeys', 'persistGuardedEdits', 'restoreAgentKeys', 'persistDoneActions', 'persistUnitForms', 'restoreDoneActions', 'clearAgentKeys', 'pruneAgentRecords'].map(extractFunction).join('\n')
    + '\nglobalThis.stores = { agentKeysStore, doneActionsStore, unitFormsStore };', context);
  return { context, state, localData, sessionData, locks, setIntake: (id) => { intakeId = id; } };
}

test('reused numeric tab ids never restore edit or helper records from a fresh browser session or unmarked legacy records', async () => {
  for (const marked of [false, true]) {
    const local = { agentEditedKeys: [{ scope: 'A', tabId: 7, page: 'Quote', keys: ['old-edit'] }], 'doneActions:A:7': ['lookupVin:0'], settings: { keep: true } };
    if (marked) local.tabRecordsSession = 'earlier-browser';
    const t = tabRecordsHarness(local);
    await Promise.all([t.context.restoreAgentKeys(7), t.context.restoreDoneActions(7)]);
    assert.deepEqual([t.state.agentKeys.size, t.state.doneActions.size], [0, 0], 'neither edit nor helper records may cross the browser session');
    assert.deepEqual(local.agentEditedKeys, []);
    assert.equal(local['doneActions:A:7'], undefined);
    assert.deepEqual(local.settings, { keep: true }, 'only tab-scoped edit/helper records expire');
    assert.equal(local.tabRecordsSession, t.sessionData.tabRecordsSession);
    assert.notEqual(local.tabRecordsSession, 'earlier-browser');
  }
});

test('the same browser session preserves records across panel reloads and intake switching, and Clear stays intake-scoped', async () => {
  const first = tabRecordsHarness();
  first.state.agentKeys.set('Quote', new Set(['edit-A']));
  first.state.doneActions.add('lookupVin:0');
  await Promise.all([first.context.persistAgentKeys(), first.context.persistDoneActions()]);
  const reload = tabRecordsHarness(first.localData, first.sessionData, first.locks);
  await Promise.all([reload.context.restoreAgentKeys(7), reload.context.restoreDoneActions(7)]);
  assert.deepEqual([...reload.state.agentKeys.get('Quote')], ['edit-A']);
  assert.deepEqual([...reload.state.doneActions], ['lookupVin:0']);
  reload.setIntake('B');
  reload.state.agentKeys = new Map([['Quote', new Set(['edit-B'])]]);
  reload.state.doneActions = new Set(['driverEntered:0']);
  await Promise.all([reload.context.persistAgentKeys(), reload.context.persistDoneActions()]);
  await reload.context.clearAgentKeys('B');
  const back = tabRecordsHarness(first.localData, first.sessionData, first.locks);
  await Promise.all([back.context.restoreAgentKeys(7), back.context.restoreDoneActions(7)]);
  assert.deepEqual([...back.state.agentKeys.get('Quote')], ['edit-A']);
  assert.deepEqual([...back.state.doneActions], ['lookupVin:0']);
  await back.context.clearAgentKeys('A');
  const cleared = tabRecordsHarness(first.localData, first.sessionData, first.locks);
  await Promise.all([cleared.context.restoreAgentKeys(7), cleared.context.restoreDoneActions(7)]);
  assert.equal(cleared.state.agentKeys.size, 0);
  assert.equal(cleared.state.doneActions.size, 0);
});

test('simultaneous panels share one session initialization before writing edit/helper records', async () => {
  const first = tabRecordsHarness({ tabRecordsSession: 'old-browser', 'doneActions:A:7': ['old'] });
  const second = tabRecordsHarness(first.localData, first.sessionData, first.locks);
  await Promise.all([
    first.context.stores.agentKeysStore.set([{ scope: 'A', tabId: 7, page: 'Quote', keys: ['new-edit'] }]),
    second.context.stores.doneActionsStore.set('A', 7, ['new-helper']),
  ]);
  assert.deepEqual(first.localData.agentEditedKeys, [{ scope: 'A', tabId: 7, page: 'Quote', keys: ['new-edit'] }]);
  assert.deepEqual(first.localData['doneActions:A:7'], ['new-helper'], 'a second initialization never deletes the first panel\'s write');
  assert.equal(first.localData.tabRecordsSession, first.sessionData.tabRecordsSession);
});

test('failed session expiry blocks reads and writes and retries initialization safely', async () => {
  const t = tabRecordsHarness({ tabRecordsSession: 'old-browser', 'doneActions:A:7': ['old'] });
  const remove = t.context.chrome.storage.local.remove;
  t.context.chrome.storage.local.remove = async () => { throw new Error('temporary storage failure'); };
  await assert.rejects(t.context.stores.doneActionsStore.get('A', 7), /temporary storage failure/);
  assert.equal(t.localData.tabRecordsSession, 'old-browser');
  assert.deepEqual(t.localData['doneActions:A:7'], ['old']);
  t.context.chrome.storage.local.remove = remove;
  assert.deepEqual(Array.from(await t.context.stores.doneActionsStore.get('A', 7)), []);
  assert.equal(t.localData.tabRecordsSession, t.sessionData.tabRecordsSession);
});

// The last Auto-advance choice before kit execution is the effective switch, including a
// change while list verification or AI retirement was pending. AI approval remains a hold.
test('manual and automatic fills log the Auto-advance switch used after async preparation', async () => {
  for (const auto of [false, true]) for (const waitAt of ['pickListItem', 'retireAiOrigins']) for (const enabled of [false, true]) {
    const t = fillHarness({ carrier: { id: 'amwins', advance: /Continue/, layoutSteps: amwins.layoutSteps } });
    const start = SIDEPANEL.indexOf('const fillOptions =');
    vm.runInContext(SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start) + 4) + `\n${extractFunction('unitNameFor')}\nglobalThis.fillOptions = fillOptions;`, t.context);
    t.ui['auto-advance'].checked = !enabled;
    t.context[waitAt] = async () => { await Promise.resolve(); t.ui['auto-advance'].checked = enabled; };
    const run = auto ? t.context.autoFill('/quote-A') : t.context.fillPage();
    await t.started;
    assert.equal(!!t.seen.options.advance, enabled, `${auto}/${waitAt}: latest setting controls the kit`);
    t.release(t.results);
    await run;
    assert.equal(t.seen.logged.find((e) => e.type === 'fill_run').settings.autoAdvance, enabled);
  }
  const t = fillHarness({ carrier: { id: 'amwins', advance: /Continue/ } });
  const start = SIDEPANEL.indexOf('const fillOptions =');
  vm.runInContext(SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start) + 4) + `\n${extractFunction('unitNameFor')}\nglobalThis.fillOptions = fillOptions;`, t.context);
  t.context.pendingAi = () => [{ approved: false }];
  const run = t.context.fillPage();
  await t.started;
  assert.equal(t.seen.options.advance, null, 'the enabled switch cannot bypass the pending AI approval hold');
  t.release(t.results);
  await run;
  assert.equal(t.seen.logged.find((e) => e.type === 'fill_run').settings.autoAdvance, true, 'telemetry records the switch; approval still gates continuation');
});

// Check answers before Continue: the switch reaches the kit as `hold`, Looks right's receipt as
// `confirmed` (with nothing replaced), and the switch is never in the usage log (the server takes
// exactly the four filling switches).
test('Check answers before Continue reaches the kit as hold and is never logged', async () => {
  const t = fillHarness({ carrier: { id: 'amwins', advance: /Continue/ } });
  const start = SIDEPANEL.indexOf('const fillOptions =');
  vm.runInContext(SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start) + 4) + `\n${extractFunction('unitNameFor')}\nglobalThis.fillOptions = fillOptions;`, t.context);
  t.ui['check-continue'] = { checked: true };
  t.ui.overwrite.checked = true;
  let run = t.context.fillPage();
  await t.started;
  assert.equal(t.seen.options.hold, true);
  assert.equal(t.seen.options.confirmed, null);
  assert.equal(t.seen.options.overwrite, true, 'a plain manual fill keeps the overwrite switch');
  t.release(t.results);
  await run;
  const run1 = t.seen.logged.find((e) => e.type === 'fill_run');
  assert.deepEqual(Object.keys(run1.settings).sort(), ['autoAdvance', 'autoFollowUps', 'autoPages', 'overwrite']);
  // Looks right.
  run = t.context.fillPage({ confirmed: 'r1-seen' });
  await run;
  assert.equal(t.seen.options.confirmed, 'r1-seen');
  assert.equal(t.seen.options.overwrite, false, 'Looks right replaces nothing');
  assert.equal(t.seen.options.hold, true);
});

// Review 2026-10-22: Stop pressed after the kit was done (Continue clicked) still called the page
// stopped, and the dock offered to fill the rest. Only a frame that halted makes it stopped.
test('a Stop that comes after the kit was done does not mark the page stopped', async () => {
  for (const [halted, want] of [[false, false], [true, true]]) {
    const t = fillHarness({ carrier: { id: 'amwins', advance: /Continue/ } });
    const stopped = [];
    t.context.renderReport = (frames, ctx) => stopped.push(ctx.stopped);
    const run = t.context.fillPage();
    await t.started;
    t.state.fillingFor.stopping = true;
    t.release([{ frameId: 0, result: { ...t.results[0].result, halted } }]);
    await run;
    assert.deepEqual(stopped, [want], halted ? 'halted by the Stop' : 'done before the Stop reached it');
  }
});

// Review 2026-10-22: each half second every frame sent its whole list, and the live list was drawn
// again whole. The panel asks each frame for the rows after those it has, by list, and keeps those.
test('while a fill runs the panel asks each frame only for new rows and keeps those it has', async () => {
  let tick = null;
  let reply = [];
  let renders = 0;
  const asked = [];
  const state = { fillingFor: { run: 'r1', filled: 0, rows: [] } };
  const context = {
    inExtension: true, state, worldFor: () => 'MAIN', renderSteps: () => { renders++; },
    setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {},
    chrome: { scripting: { executeScript: async (o) => { asked.push(JSON.parse(JSON.stringify(o.args[0]))); return reply; } } },
  };
  vm.runInNewContext(extractFunction('watchFill'), context);
  context.watchFill({ run: 'r1', tabId: 3, carrier: {} });
  const row = (label, extra = {}) => ({ label, shown: 'x', ...extra });
  const labels = () => Array.from(state.fillingFor.rows, (x) => x.label);
  reply = [{ result: { frame: 'f', list: 'f:1', since: 0, rows: [row('A'), row('B')] } }, { result: null }];
  await tick();
  const [a, b] = state.fillingFor.rows;
  reply = [{ result: { frame: 'f', list: 'f:1', since: 2, rows: [row('C'), row('Hidden', { otherStep: true })] } }];
  await tick();
  assert.deepEqual(asked, [{}, { 'f:1': 2 }]);
  assert.deepEqual(labels(), ['A', 'B', 'C'], 'another step\'s field filled again is not this step\'s');
  assert.ok(state.fillingFor.rows[0] === a && state.fillingFor.rows[1] === b, 'the rows it had stay as they were');
  // The frame rewrote its list (an answer given again): taken whole, in place of the old one.
  reply = [{ result: { frame: 'f', list: 'f:2', since: 0, rows: [row('A2')] } }];
  await tick();
  assert.deepEqual(asked.at(-1), { 'f:1': 4 });
  assert.deepEqual([labels(), state.fillingFor.filled, renders], [['A2'], 1, 3]);
  // Nothing new: nothing drawn again.
  reply = [{ result: { frame: 'f', list: 'f:2', since: 1, rows: [] } }];
  await tick();
  assert.equal(renders, 3);
});

// AdGuard and browser-harness comparison (2026-10-22): a message box on the page (alert, confirm,
// beforeunload) holds its scripts, and the dock said "Working…" with no word why. A reading the
// page hasn't answered for 5 s is said; nothing is done to the page, and the word goes once it answers.
test('a fill whose page stops answering is said in the dock, and the word goes when it answers', async () => {
  let tick = null;
  let clock = 0;
  let answer = null;
  let renders = 0;
  const state = { fillingFor: { run: 'r1', filled: 0, rows: [] } };
  const context = {
    inExtension: true, state, worldFor: () => 'MAIN', renderSteps: () => { renders++; }, UNANSWERED_MS: 5000,
    Date: { now: () => clock }, setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {},
    chrome: { scripting: { executeScript: () => new Promise((resolve) => { answer = resolve; }) } },
  };
  vm.runInNewContext(extractFunction('watchFill'), context);
  context.watchFill({ run: 'r1', tabId: 3, carrier: {} });
  const reading = tick();
  clock = 4999;
  await tick();
  assert.deepEqual([state.fillingFor.unanswered, renders], [undefined, 0], 'not yet');
  clock = 5000;
  await tick();
  assert.deepEqual([state.fillingFor.unanswered, renders], [true, 1]);
  await tick();
  assert.equal(renders, 1, 'said once, and no second reading meanwhile');
  answer([{ result: { frame: 'f', list: 'f:1', since: 0, rows: [] } }]);
  await reading;
  assert.deepEqual([state.fillingFor.unanswered, renders], [false, 2], 'it answered: the word goes');
  // The dock says so, with Stop as ever.
  const d = dockHarness({ carrier: { name: 'Progressive', advance: { text: 'Continue' } } });
  Object.assign(d.state, { filling: true, fillingFor: { tabId: 7, filled: 3, rows: [], unanswered: true } });
  const word = d.dock();
  assert.deepEqual([word.phase, word.tone, word.title, word.sub, word.button, word.label],
    ['filling', 'warn', 'The page isn’t answering', 'If it shows a message box, answer it there. The fill goes on after.', 'fill-stop', 'Stop']);
  assert.match(extractFunction('renderLive'), /f\.unanswered \? \['Waiting for the page'/);
});

// Bitwarden comparison (2026-10-22): a fill went on with the page it was asked for while the panel
// prepared (the list pick, the recorder, the AI retirement), whatever the tab showed by then. The
// tab's page is read again just before the kit is asked, and the kit checks it as it starts.
test('a fill whose page moved on before it began fills nothing, and only the agent\'s own says so', async () => {
  for (const auto of [false, 'page']) {
    const t = fillHarness();
    let kitCalls = 0;
    t.context.runKit = async () => { kitCalls++; return []; };
    t.context.chrome = { tabs: { get: async (id) => ({ id, url: 'https://carrier.test/quote-B' }) } };
    // The page in front, waiting while this fill ran (state.pagePending): its fill once this one is over.
    const pending = [];
    t.context.runPendingPage = () => pending.push(t.state.filling);
    await t.context.fillPage({ auto });
    assert.equal(kitCalls, 0, 'the kit is not asked to fill');
    assert.deepEqual(t.seen.problems.map((p) => p.text), auto ? [] : ['The page changed before the fill began. Nothing was filled or clicked; fill the page in front.']);
    // Logged only for the agent's own fill: an automatic one's is routine (a Continue just left the page).
    assert.deepEqual(t.seen.logged.filter((e) => e.type === 'fill_error').map((e) => e.error), auto ? [] : ['page moved before the fill began']);
    assert.deepEqual([t.state.filling, t.state.layoutReadyTabs.size, t.state.autoPaused], [false, 0, false], 'automatic filling goes on for the page in front');
    assert.deepEqual(pending, [false], 'the waiting page is filled, after this fill');
  }
  // The kit found another page as it began (pagekit `pageMoved`): nothing is remembered from it.
  const u = fillHarness();
  const start = SIDEPANEL.indexOf('const fillOptions =');
  vm.runInContext(SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start) + 4) + `\n${extractFunction('unitNameFor')}\nglobalThis.fillOptions = fillOptions;`, u.context);
  u.context.chrome = { tabs: { get: async (id) => ({ id, url: 'https://carrier.test/quote-A' }) } };
  const run = u.context.fillPage();
  await u.started;
  assert.equal(u.seen.options.expectPage, '/quote-A', 'the kit is told the page');
  u.release([{ frameId: 0, result: { ...u.results[0].result, pageMoved: '/quote-B' } }]);
  await run;
  assert.deepEqual([u.seen.rendered, u.state.layoutReadyTabs.size, u.seen.problems.length], [0, 0, 1]);
  assert.match(extractFunction('autoFill'), /if \(await pageMoved\(ctx\)\) \{ moved = true; notePageMoved\(ctx\); return; \}[\s\S]{0,400}expectPage: ctx\.page[\s\S]{0,800}if \(results\.some\(\(r\) => r\.result\?\.pageMoved\)\) \{ moved = true; notePageMoved\(ctx\); return; \}/);
  // autoFill too: once it is over, the page in front gets its stop card or its own fill.
  assert.match(extractFunction('autoFill'), /finally \{[\s\S]{0,400}if \(moved && fillCurrent\(ctx\)\) \{\s+if \(stopNoteFor\([^\n]*\) showStopPage\(\);\s+runPendingPage\(ctx\);/);
});

// Review 2026-10-22: rows a follow-up fill added had no source or group, so a worked-out answer or
// one from the agent's correction showed as the intake's, and grouped boxes as one row each.
test('a follow-up fill lists its answers with their sources and groups, as the report does', () => {
  const context = { state: { intake: { agentEdited: ['owner.first'] } } };
  vm.runInNewContext(['answerSources', 'groupRows'].map(extractFunction).join('\n'), context);
  const plan = [{ id: 's1', from: ['owner.first', 'owner.last'] }, { id: 'g1', group: 'Symbols', value: true }, { id: 'g2', group: 'Symbols', value: false }, { id: 'p1' }];
  const { fromOf, groupOf, ticks, editedBy } = context.answerSources(plan);
  assert.deepEqual([[...fromOf.keys()], [...groupOf.keys()], [...ticks]], [['s1'], ['g1', 'g2'], ['g1']]);
  assert.deepEqual([editedBy('x.y', fromOf.get('s1')), editedBy('x.y'), editedBy('owner.first')], [true, false, true]);
  const rows = context.groupRows([{ label: 'Name', answer: true }, { label: '1', group: 'Symbols', stepId: 'g1', answer: true, standard: true }, { label: '2', group: 'Symbols', stepId: 'g2', answer: false, standard: true }], ticks);
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{ label: 'Name', answer: true },
    { label: 'Symbols', grouped: 'Symbols', ticked: ['1'], standard: true, answer: true, value: '1' }]);
  assert.match(extractFunction('autoFill'), /answerSources\(plan\)[\s\S]{0,600}groupRows\(added\.map[\s\S]{0,600}answerRow\(\{ \.\.\.row, fresh: true \}/);
  assert.match(extractFunction('renderReport'), /answerSources\(ctx\.plan\)[\s\S]{0,40}const doneRows = groupRows\(\[/);
});

// Audit 2026-10-10: Stop while the panel still prepared (recorder, AI retirement) was lost and the
// fill ran. The kit isn't asked to fill, the pause holds, and the report says so.
test('Stop pressed before the kit is asked to fill means no fill at all', async () => {
  const t = fillHarness({ carrier: { id: 'amwins', advance: /Continue/ } });
  let kitCalls = 0;
  t.context.runKit = async () => { kitCalls++; return []; };
  t.context.retireAiOrigins = async () => { t.state.fillingFor.stopping = true; };
  await t.context.fillPage();
  assert.equal(kitCalls, 0);
  assert.equal(t.state.autoPaused, true, "automatic filling stays paused");
  assert.deepEqual(t.seen.problems.map((p) => p.text), ['You stopped the fill. Nothing was filled or clicked.']);
  assert.equal(t.state.filling, false);
  // The fill's run id goes to the kit, so a Stop that reaches a frame first still counts.
  const u = fillHarness({ carrier: { id: 'amwins', advance: /Continue/ } });
  const start = SIDEPANEL.indexOf('const fillOptions =');
  vm.runInContext(SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start) + 4) + `\n${extractFunction('unitNameFor')}\nglobalThis.fillOptions = fillOptions;`, u.context);
  const run = u.context.fillPage();
  await u.started;
  assert.match(u.seen.options.run, /^[0-9a-f-]{36}$/);
  u.release(u.results);
  await run;
});

test('an automatic fill held for the agent\'s check shows its report', async () => {
  const t = fillHarness({ carrier: { id: 'progressive', advance: /Continue/ } });
  t.state.reportFor = { filled: 0 };
  const run = t.context.autoFill('/quote-A');
  await t.started;
  t.release([{ frameId: 0, result: { ...t.results[0].result, held: 'check' } }]);
  await run;
  assert.equal(t.seen.rendered, 1, 'Looks right is in the report, not behind a follow-up note');
});

// The dock's word on a page the fill went through (continueSaid): its phase, its one button and the
// alternative beside it. `switches`: the panel's settings.
function continueHarness(switches = {}) {
  const ui = { 'auto-advance': { checked: true }, 'check-continue': { checked: false }, 'auto-followups': { checked: true }, ...switches };
  const state = { tab: { id: 7, url: 'Quote' }, tabSteps: new Map() };
  const context = { state, $: (id) => ui[id] };
  vm.runInNewContext(extractFunction('continueSaid'), context);
  const carrier = { advance: { text: 'Continue' } };
  const said = (entry, c = carrier) => {
    const d = context.continueSaid({ page: 'Quote', tabId: 7, left: 0, waiting: 0, ...entry }, c);
    return { phase: d.phase, title: d.title, sub: d.sub, button: d.button ?? null, label: d.label ?? null, go: d.go ?? null, alt: d.alt ?? null, altLabel: d.altLabel ?? null };
  };
  return { said, ui, state, carrier };
}

test('Continue\'s word asks for Looks right while Continue waits for the agent\'s check', () => {
  const { said, ui } = continueHarness({ 'check-continue': { checked: true } });
  const held = said({ held: 'check' });
  assert.deepEqual([held.phase, held.title, held.button, held.label, held.alt], ['check', 'Look over the answers, then continue', 'look-right', 'Looks right, continue', null]);
  const changed = said({ held: 'changed' });
  assert.deepEqual([changed.phase, changed.title, changed.button], ['check', 'Check the answers again', 'look-right']);
  // Items left: nothing to approve yet; the dock shows the next one, and says Looks right comes after.
  const left = said({ left: 2, filled: 5 });
  assert.deepEqual([left.phase, left.title, left.button, left.label], ['needs', 'Answer 2 questions', 'dock-next', 'Show the next one']);
  assert.equal(left.sub, 'Then check the answers and click Looks right. Never Bind or Submit.');
  const settled = said({ settled: true });
  assert.deepEqual([settled.phase, settled.button, settled.label], ['check', 'look-right', 'Looks right, continue']);
  const advanced = said({ advanced: 'Continue', held: null });
  // A page gone back to, or a report made again in a panel opened again, can be filled again (W43-39).
  assert.deepEqual([advanced.phase, advanced.title, advanced.button, advanced.alt, advanced.altLabel], ['done', 'Continue clicked', null, 'fill-again', 'Fill this page again']);
  assert.match(advanced.sub, /^Clicked “Continue” for you\. Nothing is submitted or bound\.$/);
  // Switch off, what was left settled by the agent (on the page or here): Continue, the same fill
  // that replaces nothing as below (it read "Fill again and continue": the maintainer, 2026-10-23).
  ui['check-continue'].checked = false;
  const off = said({ settled: true });
  assert.deepEqual([off.phase, off.title, off.button, off.label, off.go], ['ready-continue', 'Ready for Continue', 'fill', 'Continue', 'continue']);
  // Nothing left and the page not moved on: the main button continues, replacing nothing (W43-40).
  const nothing = said({});
  assert.deepEqual([nothing.phase, nothing.button, nothing.label, nothing.go, nothing.alt, nothing.altLabel], ['ready-continue', 'fill', 'Continue', 'continue', 'fill-again', 'Fill this page again']);
});

// Coordinator on the v5 dock: a word that can tell the agent to "Fill this page again to continue"
// has the button for it beside its own (`fill-again`), also while questions or buttons are left.
test('Continue\'s word offers Fill this page again wherever it may tell the agent to fill again', () => {
  const { said, ui } = continueHarness({ 'auto-followups': { checked: false } });
  const needs = said({ left: 1, filled: 3 });
  assert.deepEqual([needs.phase, needs.title, needs.button, needs.alt, needs.altLabel], ['needs', 'Answer the last question', 'dock-next', 'fill-again', 'Fill this page again']);
  assert.equal(needs.sub, 'Then Fill this page again to continue. Never Bind or Submit.');
  // Only buttons left: the main button is the fill that clicks them in turn (nothing clicks them by
  // itself; it read "The fill clicks the rest in turn" with no button: the maintainer, 2026-10-23).
  const waiting = said({ waiting: 2, filled: 3 });
  assert.deepEqual([waiting.phase, waiting.title, waiting.button, waiting.label, waiting.go, waiting.alt, waiting.altLabel], ['waiting', 'Buttons left to click', 'fill', 'Continue', 'continue', 'fill-again', 'Fill this page again']);
  assert.equal(waiting.sub, 'Continue clicks the ones it can in turn, and the page’s Continue once none is left. Never Bind or Submit.');
  // Where the panel may not click Continue, the button only clicks the buttons.
  ui['auto-advance'].checked = false;
  const own = said({ waiting: 2, filled: 3 });
  assert.deepEqual([own.button, own.label, own.sub], ['fill', 'Click them for me', 'Then click Continue yourself, and Fill this page on the next one.']);
  ui['auto-advance'].checked = true;
  // With follow-ups on, the panel continues by itself; the alternative stays.
  ui['auto-followups'].checked = true;
  assert.equal(said({ left: 1 }).sub, 'Then the panel continues to the next page. Never Bind or Submit.');
  assert.equal(said({ waiting: 1 }).alt, 'fill-again');
});

// Continue is the panel's to click only with the setting on, a carrier advance pattern, and a page
// or step it may click on; otherwise the word says it's the agent's, and never offers it.
test('Continue\'s word leaves Continue to the agent where the panel may not click it', () => {
  const { said, ui, state } = continueHarness();
  const pageOff = said({}, { advance: { text: 'Continue', exceptPages: ['Quote'] } });
  assert.deepEqual([pageOff.phase, pageOff.button, pageOff.alt], ['ready-continue', null, 'fill-again']);
  assert.equal(pageOff.sub, 'Click Continue on this page yourself. Nothing is submitted or bound.');
  assert.equal(said({ left: 1 }, { advance: { text: 'Continue', exceptPages: ['Quote'] } }).sub, 'Then click Continue on this page yourself. Nothing is submitted or bound.');
  // GEICO's Quote & Coverages: its Next is never clicked (advance `steps`).
  const geico = { layoutSteps: ['Vehicles', 'Quote & Coverages'], advance: { text: 'Next', steps: ['Vehicles'] } };
  state.tabSteps.set(7, 'Quote & Coverages');
  const off = said({}, geico);
  assert.deepEqual([off.phase, off.title, off.button, off.alt], ['yours', 'Moving on is yours', null, 'fill-again']);
  assert.equal(said({ left: 2 }, geico).sub, 'Then moving on is yours: nothing on this step is clicked for you.');
  assert.equal(said({ settled: true }, geico).button, null, 'not even once all is settled');
  state.tabSteps.set(7, 'Vehicles');
  assert.equal(said({ settled: true }, geico).button, 'fill');
  // The setting off, or no advance pattern: the agent clicks Continue.
  ui['auto-advance'].checked = false;
  for (const c of [{ advance: { text: 'Continue' } }, {}]) {
    const own = said({ settled: true }, c);
    assert.deepEqual([own.phase, own.button, own.alt], ['ready-continue', null, 'fill-again']);
    assert.equal(own.sub, 'Click Continue yourself, then Fill this page on the next one.');
    assert.equal(said({ left: 1 }, c).sub, 'Then click Continue yourself, and Fill this page on the next one.');
  }
  // With "Let me look" on but the panel not clicking Continue, there is nothing to approve.
  ui['check-continue'].checked = true;
  assert.equal(said({ held: null, settled: true }).button, null);
});

// The dock before a fill: what the fill will and won't do here. Continue is said to be clicked for
// the agent only while that setting is on and the carrier has an advance pattern.
function dockHarness({ carrier, switches = {}, background = false, issue = null, url = 'Quote', step = null, extra = {} } = {}) {
  const ui = { 'auto-advance': { checked: true }, 'check-continue': { checked: false }, 'auto-followups': { checked: true }, report: { querySelector: () => null }, ...switches };
  const state = { intake: { warnings: [], done: [] }, view: 'page', tab: { id: 7, url, carrier, background }, tabSteps: new Map(step ? [[7, step]] : []), autoPages: new Set(), aiDocks: new Map(), filling: false, fillingFor: null };
  const context = { state, $: (id) => ui[id], inExtension: true, pageOf: (u) => u, onQuotePage: () => true, showReport: () => null, quoteProgress: () => null,
    stateIssue: () => issue, pendingAi: () => [], ...extra };
  vm.runInNewContext(['dockFor', 'continueSaid'].map(extractFunction).join('\n'), context);
  return { dock: () => context.dockFor(), ui, state };
}

test('the fill hint says Continue is clicked for the agent only while that setting is on and the carrier has an advance pattern', () => {
  const geico = { name: 'GEICO', advance: { text: 'Next' }, unitLists: {} };
  const prog = { name: 'Progressive', advance: { text: 'Continue' } };
  const plain = { name: 'Plain' };
  const sub = (o) => dockHarness(o).dock().sub;
  assert.equal(sub({ carrier: geico }), 'Adds the intake’s vehicles, trailers and drivers not on the quote yet, and clicks Next once nothing is left for you, up to Quote & Coverages. Never submits or binds.');
  assert.equal(sub({ carrier: prog }), 'Clicks Continue once nothing is left for you. Never submits or binds.');
  for (const carrier of [geico, prog]) assert.equal(sub({ carrier, switches: { 'auto-advance': { checked: false } } }), 'Nothing is submitted. Review, then click Next yourself.');
  assert.equal(sub({ carrier: plain }), 'Nothing is submitted. Review, then click Next yourself.');
  assert.equal(sub({ carrier: prog, background: true }), 'Fills the quote tab in the background. Go back to it to review.');
  const ready = dockHarness({ carrier: prog }).dock();
  assert.deepEqual([ready.phase, ready.button, ready.label], ['ready', 'fill', 'Fill this page']);
  // The hint follows the switch: renderSite redraws the steps, and with them the dock.
  assert.match(extractFunction('wireUsage'), /\$\('auto-advance'\)\.addEventListener\('change', async \(e\) => \{ const saving = usage\.saveSettings\(\{ autoAdvance: e\.target\.checked \}\); renderSite\(\); await saving; logSettings\('changed', 'autoAdvance'\); \}\);/, 'the hint follows the switch');
  assert.match(extractFunction('renderSite').split('\nfunction ')[0], /renderSteps\(\);\s*\}$/);
  assert.match(extractFunction('renderSteps').split('\nfunction ')[0], /renderDock\(\);\s*\}$/);
});

test('Looks right sends the top frame\'s receipt with a fill, only for the page in front', async () => {
  const calls = [];
  const said = [];
  let frames = [{ frameId: 3, result: 'r1-frame' }, { frameId: 0, result: 'r1-top' }];
  const context = {
    state: { tab: { id: 7, url: 'Quote' }, filling: false }, pageOf: (url) => url, announce: (t) => said.push(t),
    runKit: async (...a) => { calls.push(['runKit', a[0]]); return frames; },
    fillPage: async (o) => { calls.push(['fillPage', o]); },
  };
  vm.runInNewContext(extractFunction('lookRight'), context);
  const button = { disabled: true };
  await context.lookRight(7, 'Quote', {}, button);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['runKit', 7], ['fillPage', { confirmed: 'r1-top' }]]);
  // The page couldn't be read: the button is back and nothing is filled.
  calls.length = 0;
  frames = [{ frameId: 0, result: null }];
  await context.lookRight(7, 'Quote', {}, button);
  assert.deepEqual(calls.map((c) => c[0]), ['runKit']);
  assert.equal(button.disabled, false);
  assert.equal(said.length, 1);
  // Another page in front, or a fill running: nothing read or filled.
  calls.length = 0;
  await context.lookRight(7, 'Drivers', {}, button);
  context.state.filling = true;
  await context.lookRight(7, 'Quote', {}, button);
  assert.deepEqual(calls, []);
});

test('failed manual and automatic fills retain bounded run metadata without a result event or client text', async () => {
  for (const auto of [false, true]) for (const operation of ['runKit', 'retireAiOrigins', 'recorder']) {
    const t = fillHarness();
    t.context[operation === 'recorder' ? (auto ? 'tellRecorder' : 'ensureRecorder') : operation] = async (cmd) => {
      if (cmd === 'resume') return;
      throw new Error('A value could not be filled');
    };
    await (auto ? t.context.autoFill('/quote-A') : t.context.fillPage());
    assert.equal(t.state.filling, false);
    assert.equal(t.seen.logged.length, 1, `${auto}/${operation}: rejected invocation has one diagnostic event`);
    const [error] = t.seen.logged;
    assert.deepEqual(JSON.parse(JSON.stringify({ type: error.type, rules: error.rules, settings: error.settings, auto: error.auto, error: error.error })), {
      type: 'fill_error', rules: 'abcdef012345', settings: { autoAdvance: true, autoFollowUps: true, autoPages: false, overwrite: false }, auto, error: '[client] could not be filled',
    });
    assert.match(error.run, /^[0-9a-f-]{36}$/);
    assert.deepEqual([error.session, error.intakeId], ['session-intake-A', 'intake-A']);
    assert.doesNotMatch(JSON.stringify(error), /A value/);
  }
  const t = fillHarness({ rules: null });
  t.context.runKit = async () => { throw new Error('A value failed'); };
  await t.context.fillPage();
  assert.equal(t.seen.logged[0].rules, undefined, 'unknown rule fingerprint is never fabricated');
});

// Audit 2026-10-08: a panel edit set one field and only bumped the capture revision, so the
// radius typed as "Unlimited" kept its old 100 miles. The derived value follows the edit, its
// row on screen shows it, and both happen before the capture revision moves on.
test('editing a source field in the panel recomputes what derives from it and refreshes that row', async () => {
  const { get, set } = await import('../src/util.js');
  const { parseEdit, rederive } = await import('../src/normalize.js');
  const record = { operations: { radius: '100', radiusMiles: 100 }, applicant: {} };
  const calls = [];
  const inputs = [];
  const fake = (tag) => {
    const el = { tag, listeners: {}, value: '', addEventListener: (type, fn) => { el.listeners[type] = fn; }, removeAttribute() {}, append() {}, closest: () => null };
    inputs.push(el);
    return el;
  };
  const milesRow = { classList: { remove: (cls) => calls.push(['remove', cls]) } };
  const milesInput = { value: '100', closest: () => milesRow };
  const yearsInput = { value: '', closest: () => milesRow };
  const sandbox = {
    state: { intake: { record, warnings: [] } },
    get, set, parseEdit, rederive, h: fake, fieldInfo,
    document: { getElementById: (id) => ({ 'f-operations_radiusMiles': milesInput, 'f-applicant_yearsInBusiness': yearsInput })[id] ?? null },
    intakeEdited: () => calls.push(['intakeEdited', record.operations.radiusMiles]),
    usage: { log: (e) => calls.push(['log', e.type, e.path]) },
    save: async () => { calls.push(['save']); stored = structuredClone(sandbox.state.intake); },
    claimsTextEdited: () => {}, reviewClaimsBox: () => {}, reviewDriverGender: () => {}, profileLater() {},
  };
  let stored = null;
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('fieldRow') + extractFunction('agentEdit'), sandbox);
  sandbox.fieldRow('operations.radius', 'Radius (as written)', 'text', false);
  const radius = inputs.find((el) => el.tag === 'input');
  radius.value = 'Unlimited';
  await radius.listeners.change();
  assert.equal(record.operations.radius, 'Unlimited');
  assert.equal(record.operations.radiusMiles, null, 'the miles follow the edit');
  assert.equal(milesInput.value, '', 'the miles row on screen shows it');
  assert.deepEqual(calls, [['intakeEdited', null], ['log', 'intake_edit', 'operations.radius'], ['save']], 'recomputed before the revision moves on; one edit logged');
  // The agent's own miles are theirs: nothing else is recomputed from them.
  calls.length = 0;
  sandbox.fieldRow('operations.radiusMiles', 'Radius (miles)', 'int', false);
  const miles = inputs.filter((el) => el.tag === 'input').at(-1);
  miles.value = '77';
  await miles.listeners.change();
  assert.equal(record.operations.radiusMiles, 77);
  assert.equal(record.operations.radius, 'Unlimited');
  assert.deepEqual(calls, [['intakeEdited', 77], ['log', 'intake_edit', 'operations.radiusMiles'], ['save']]);
  // Codex review on a7ee49e: the agent's miles stay theirs when the radius text is edited later.
  calls.length = 0;
  milesInput.value = '77';
  radius.value = '100-500 miles';
  await radius.listeners.change();
  assert.equal(record.operations.radius, '100-500 miles');
  assert.equal(record.operations.radiusMiles, 77, 'the corrected miles are not recomputed');
  assert.equal(milesInput.value, '77');
  assert.deepEqual(calls, [['intakeEdited', 77], ['log', 'intake_edit', 'operations.radius'], ['save']]);
  // Same for years in business corrected directly, then a year established edit.
  sandbox.fieldRow('applicant.yearsInBusiness', 'Years in business', 'int', false);
  const years = inputs.filter((el) => el.tag === 'input').at(-1);
  years.value = '12';
  await years.listeners.change();
  sandbox.fieldRow('applicant.yearEstablished', 'Year established', 'int', false);
  const established = inputs.filter((el) => el.tag === 'input').at(-1);
  established.value = '2020';
  await established.listeners.change();
  assert.equal(record.applicant.yearEstablished, 2020);
  assert.equal(record.applicant.yearsInBusiness, 12, 'the corrected years are not recomputed');
  // Codex review on f49a270: the panel restarts (init() reads the saved intake back); the edits
  // were saved with it, so a later source edit still leaves the agent's miles alone.
  sandbox.state.intake = structuredClone(stored);
  sandbox.fieldRow('operations.radius', 'Radius (as written)', 'text', false);
  const reopened = inputs.filter((el) => el.tag === 'input').at(-1);
  reopened.value = '300 miles';
  await reopened.listeners.change();
  assert.equal(sandbox.state.intake.record.operations.radius, '300 miles');
  assert.equal(sandbox.state.intake.record.operations.radiusMiles, 77, 'after a restart the corrected miles are still kept');
  assert.equal(stored.record.operations.radiusMiles, 77, 'and saved that way');
  sandbox.state.intake = { record, warnings: [] };
  // A new intake starts clean: its derived values follow their source again.
  assert.match(SIDEPANEL, /state\.intake = \{ \.\.\.result, fileName: file\.name, done: \[\], agentEdited: \[\], places, test \};/, 'a loaded intake starts with no edits');
  radius.value = '250';
  await radius.listeners.change();
  assert.equal(record.operations.radiusMiles, 250, 'another intake: the miles follow the edit');
  assert.equal(milesInput.value, 250);
});

for (const switchTo of ['tab', 'intake', 'entity', 'clear']) for (const transport of ['complete', 'failure']) {
  test(`guarded edits keep origin scope after ${switchTo} switch (${transport})`, async () => {
    const h = harness(), { state, context } = h;
    const originRecord = { applicant: { name: 'PRIVATE_CLIENT_TEXT' }, vehicles: [{}, {}] };
    const intake = { record: originRecord };
    const carrier = { id: 'progressive', practice: true, vehiclePages: ['AddVehicle'] };
    const originTab = { ...quoteTab(1), carrier };
    state.tab = originTab; state.intake = intake; state.active = { vehicles: 0 };
    state.agentKeys = new Map([['AddVehicle|v0', new Set(['existing-key'])]]);
    const originKeys = state.agentKeys;
    const choice = { key: 'planned-choice', label: 'Choice', controlKind: 'select', choice: 'No', autoOk: true };
    state.aiCache = new Map([['1\nAddVehicle', choice]]);
    let scope = 'origin-fingerprint';
    let records = [
      { scope, tabId: 1, page: 'AddVehicle|v0', keys: ['existing-key'] },
      { scope, tabId: 1, page: 'OtherPage', keys: ['other-page-key'] },
      { scope: 'other-fingerprint', tabId: 2, page: 'AddVehicle|v0', keys: ['other-client-key'] },
    ];
    let answerStarted, resolveAnswer, rejectAnswer, edited = false;
    const entered = new Promise(resolve => { answerStarted = resolve; });
    const pending = new Promise((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
    const frame = { frameId: 0, documentId: 'origin-document', result: JSON.stringify([originTab.url,
      [{ key: choice.key, label: choice.label, current: '' }]]) };
    const protectedItem = { key: 'agent-correction', label: 'PRIVATE_CARRIER_VALUE', ok: false, protected: true };
    const resultFrames = items => [{ ...frame, result: items }];
    let nextRecord = { applicant: {}, vehicles: [] }, nextFingerprint = 'replacement-fingerprint';
    h.ui['load-error'] = {};
    Object.assign(context, {
      crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, aiSafeText: String, doneRestored: new Set(),
      usage: { currentSession: () => scope ? { intakeId: scope } : null, log() {},
        startSession: fingerprint => { scope = fingerprint; return { intakeId: fingerprint }; } },
      agentKeysQueue: Promise.resolve(), agentKeysStore: { get: async () => structuredClone(records),
        set: async value => { records = structuredClone(value); } },
      doneActionsQueue: Promise.resolve(), doneActionsStore: { clear: async () => {} },
      tellRecorder: async () => {}, persistAiPending: async () => {}, restoreAiPending: async () => {},
      aiRetiredSignatures: new Set(),
      runKit: async (tabId, c, func, args = []) => {
        assert.equal(tabId, 1, 'the apply continues observing its originating tab');
        if (/answerEdits/.test(String(func))) return resultFrames(edited ? [protectedItem] : []);
        if (/\.answer\(/.test(String(func))) { answerStarted(); return pending; }
        return [frame];
      },
      pruneAgentRecords: async () => [], testIntakes: { get: async () => [] }, logSettings: async () => {}, platformOf: () => ({ os: null, chrome: null }),
      profileTimer: null, logProfile: () => false,
      readIntakeFields: async () => ({ synthetic: true }), readIntakePlaces: async () => null, keepPdf: async () => {}, normalizeIntake: () => ({ record: nextRecord, warnings: [] }),
      intakeSummary: async () => ({ intakeId: nextFingerprint }), pdfjs: {},
      cancelLayouts() {}, holdLayouts() {}, resetViews() {}, discardAiSuggestions() {}, uploadNow() {},
      store: { set: async () => {} }, render() {}, reviewClaimsBox() {}, reviewIntake() {}, refreshTab() {},
    });
    const functions = ['aiActionCurrent', 'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots',
      'snapshotsEqual', 'snapshotFingerprint', 'snapshotHashMatches', 'aiSnapshotFields', 'aiSnapshotFieldMatches',
      'aiQuestionHash', 'aiLiveFieldHash', 'aiOriginRecord', 'aiAnswerOrigin', 'aiCurrentAnswerPresent', 'applyAi',
      'persistAgentKeys', 'restoreAgentKeys', 'clearAgentKeys', 'firstView', 'loadFile'];
    vm.runInNewContext(functions.map(extractFunction).join('\n') + LAYOUT_STUB, context);
    const ctx = { tabId: 1, page: 'AddVehicle', tabUrl: originTab.url, intake, carrier,
      contextKey: assistContextKey(originRecord, state.active), snapshots: [frame] };
    const apply = context.applyAi([choice], ctx, 'auto');
    await entered;
    if (switchTo === 'tab') {
      context.carrierForUrl = () => carrier;
      h.setActiveTab(quoteTab(2));
      await h.refreshTab();
      assert.equal(state.tabSessions.get(1).agentKeys, originKeys, 'the original tab was snapshotted before the edit arrived');
    } else if (switchTo === 'intake') {
      await context.loadFile({ name: 'synthetic.pdf', arrayBuffer: async () => new ArrayBuffer(0) });
    } else if (switchTo === 'entity') state.active = { vehicles: 1 };
    else { state.intake = null; scope = null; await context.clearAgentKeys('origin-fingerprint'); }
    edited = true;
    if (transport === 'failure') rejectAnswer(new Error('Answer transport unavailable'));
    else resolveAnswer(resultFrames([{ key: choice.key, label: choice.label, ok: true, shown: 'No' }, protectedItem]));
    await apply;
    await context.agentKeysQueue;
    if (switchTo === 'clear') {
      assert.deepEqual(records, [{ scope: 'other-fingerprint', tabId: 2, page: 'AddVehicle|v0', keys: ['other-client-key'] }], 'Clear deletes only the origin and prevents its late apply from recreating records');
      assert.equal(originKeys.get('AddVehicle|v0').has('agent-correction'), false);
      return;
    }
    const saved = records.find(x => x.scope === 'origin-fingerprint' && x.tabId === 1 && x.page === 'AddVehicle|v0');
    assert.ok(saved?.keys.includes('agent-correction'), 'the trusted key is durable in its originating intake/tab/entity');
    assert.ok(saved.keys.includes('existing-key'), 'a late edit merges with earlier origin protection');
    assert.ok(records.some(x => x.page === 'OtherPage' && x.keys.includes('other-page-key')), 'other origin pages survive');
    assert.ok(records.some(x => x.scope === 'other-fingerprint' && x.keys.includes('other-client-key')), 'another intake is untouched');
    assert.equal(JSON.stringify(records).includes('PRIVATE'), false, 'durable records contain keys, never labels, values or client text');
    if (switchTo === 'tab') {
      assert.equal(state.agentKeys.get('AddVehicle|v0')?.has('agent-correction') ?? false, false, 'the newly followed tab is untouched');
      h.setActiveTab(quoteTab(1)); await h.refreshTab();
      assert.ok(state.agentKeys.get('AddVehicle|v0').has('agent-correction'), 'returning to the origin restores its late edit');
    } else if (switchTo === 'entity') {
      assert.equal(state.agentKeys.has('AddVehicle|v1'), false, 'the next vehicle never inherits the correction');
    } else assert.equal(state.agentKeys.size, 0, 'the replacement intake stays untouched');
    if (switchTo === 'intake') {
      nextRecord = originRecord; nextFingerprint = 'origin-fingerprint';
      await context.loadFile({ name: 'origin.pdf', arrayBuffer: async () => new ArrayBuffer(0) });
    }
    // A panel reload can recover the protection using only its original opaque scope.
    scope = 'origin-fingerprint'; state.tab = originTab; state.active = { vehicles: 0 }; state.agentKeys = new Map();
    await context.restoreAgentKeys(1);
    assert.deepEqual([...state.agentKeys.get('AddVehicle|v0')].sort(), ['agent-correction', 'existing-key']);
    assert.deepEqual(Object.keys(saved).sort(), ['keys', 'page', 'scope', 'tabId']);
  });
}

test('Clear also cancels an origin edit write already waiting on local storage', async () => {
  let releaseRead, readStarted;
  const entered = new Promise(resolve => { readStarted = resolve; });
  const reading = new Promise(resolve => { releaseRead = resolve; });
  let records = [{ scope: 'origin', tabId: 1, page: 'Quote', keys: ['earlier'] }];
  const state = { agentKeysEpochs: new Map(), tab: { id: 1 }, agentKeys: new Map() };
  const context = { state, usage: { currentSession: () => ({ intakeId: 'origin' }) }, agentKeysQueue: Promise.resolve(),
    agentKeysStore: { get: () => { readStarted(); return reading; }, set: async value => { records = structuredClone(value); } },
    doneActionsQueue: Promise.resolve(), doneActionsStore: { clear: async () => {} }, unitFormsStore: { clear: async () => {} } };
  vm.runInNewContext(['persistGuardedEdits', 'clearAgentKeys'].map(extractFunction).join('\n'), context);
  const writing = context.persistGuardedEdits({ scope: 'origin', tabId: 1, page: 'Quote', keys: state.agentKeys, epoch: 0 }, ['late-key']);
  await entered;
  const clearing = context.clearAgentKeys('origin');
  releaseRead(records);
  await Promise.all([writing, clearing]);
  assert.deepEqual(records, [], 'the queued pre-Clear write cannot recreate deleted protection');
});


// The same panel replaces its live sets, but must reread each fingerprint's durable helpers.
test('completed helpers survive actual intake A to B to A loading and panel reload', async () => {
  const memory = new Map();
  const forms = new Map();
  const make = () => {
    const h = harness(), { context, state } = h;
    let scope = 'A', loading = 'A', refreshed;
    h.setActiveTab(quoteTab(7));
    Object.assign(context, {
      usage: { currentSession: () => ({ intakeId: scope }), startSession: id => { scope = id; return { intakeId: id }; }, log() {} },
      doneActionsQueue: Promise.resolve(), doneRestored: new Set(),
      doneActionsStore: { get: async (id, tab) => memory.get(`${id}|${tab}`) ?? [],
        set: async (id, tab, ids) => { memory.set(`${id}|${tab}`, [...ids]); } },
      unitFormsStore: { get: async (id, tab) => forms.get(`${id}|${tab}`) ?? null,
        set: async (id, tab, value) => { forms.set(`${id}|${tab}`, structuredClone(value)); } },
      $: () => ({}), pdfjs: {}, readIntakeFields: async () => ({ synthetic: true }), readIntakePlaces: async () => null, keepPdf: async () => {}, pruneAgentRecords: async () => [], testIntakes: { get: async () => [] }, logSettings: async () => {}, platformOf: () => ({ os: null, chrome: null }),
      normalizeIntake: () => ({ record: {}, warnings: [] }), intakeSummary: async () => ({ intakeId: loading }),
      profileTimer: null, logProfile: () => false,
      store: { set: async () => {} }, cancelLayouts() {}, holdLayouts() {}, resetViews() {},
      discardAiSuggestions() {}, persistAiPending: async () => {}, restoreAiPending: async () => {},
      uploadNow() {}, render() {}, reviewClaimsBox() {}, reviewIntake() {},
      refreshTab: () => { refreshed = h.refreshTab(); return refreshed; },
    });
    vm.runInNewContext(['firstView', 'loadFile', 'persistDoneActions', 'persistUnitForms', 'restoreDoneActions'].map(extractFunction).join('\n'), context);
    return { h, context, state, load: async id => {
      loading = id;
      await context.loadFile({ name: 'synthetic.pdf', arrayBuffer: async () => new ArrayBuffer(1) });
      await refreshed;
    } };
  };
  const first = make();
  await first.load('A');
  first.state.doneActions.add('lookupVin:0'); first.state.doneActions.add('addDriver:0');
  await first.context.persistDoneActions();
  // GEICO's unit forms go and come back with them.
  first.state.unitForms.vehicles.Id_Marker_101 = 0;
  await first.context.persistUnitForms();
  await first.load('B');
  assert.equal(first.state.doneActions.size, 0, 'a different intake has no completed helpers');
  assert.deepEqual(JSON.parse(JSON.stringify(first.state.unitForms)), { vehicles: {}, drivers: {}, trailers: {} }, 'nor unit forms');
  await first.load('A');
  assert.deepEqual([...first.state.doneActions].sort(), ['addDriver:0', 'lookupVin:0'], 'A restores after replacement');
  assert.deepEqual(JSON.parse(JSON.stringify(first.state.unitForms.vehicles)), { Id_Marker_101: 0 });
  first.state.doneActions.delete('lookupVin:0');
  await first.h.refreshTab();
  assert.equal(first.state.doneActions.has('lookupVin:0'), false, 'ordinary arrivals still respect an intentional rerun');
  const reopened = make();
  await reopened.load('A');
  assert.deepEqual([...reopened.state.doneActions].sort(), ['addDriver:0', 'lookupVin:0'], 'the durable records also restore after panel reload');
  assert.deepEqual(JSON.parse(JSON.stringify(reopened.state.unitForms.vehicles)), { Id_Marker_101: 0 }, 'the unit forms too');
});

for (const failAt of ['first-guard-read', 'second-guard-read', 'answer-transport']) {
  test(`AI dispatch holds reflect actual sends on ${failAt} failure`, async () => {
    const record = {}, intake = { record }, url = 'https://example.test/quote';
    const choices = ['first', 'second'].map(key => ({ key, label: key, controlKind: 'radio', choice: 'No', autoOk: true }));
    const pre = [{ frameId: 0, documentId: 'doc', result: JSON.stringify(['Quote', choices.map(x => ({ key: x.key, label: x.label, current: '' }))]) }];
    const state = { filling: false, intake, active: {}, tab: { id: 1, url }, agentKeys: new Map(), filled: new Map(),
      aiCache: new Map(choices.map(x => [[1, '/quote', DEFAULT_MODEL, POLICY_VERSION, 'context', x.key, JSON.stringify(url)].join('\n'), x])) };
    const ctx = { tabId: 1, page: '/quote', tabUrl: url, intake, carrier: { practice: true },
      contextKey: assistContextKey(record, state.active), snapshots: pre };
    let stored = [], sends = 0, reads = 0, sawPrepared = false;
    const context = { state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, aiSafeText: String,
      DEFAULT_MODEL, POLICY_VERSION, pageOf: value => new URL(value).pathname,
      usage: { currentSession: () => ({ intakeId: 'A' }) }, aiPersistQueue: Promise.resolve(), aiRetiredSignatures: new Set(),
      aiPendingStore: { get: async () => stored, set: async value => { stored = value; } }, tellRecorder: async () => {},
      runKit: async (tabId, carrier, func, args) => {
        if (/answerEdits/.test(String(func))) {
          if (args[0] === 'read') {
            reads++; sawPrepared = stored.length === 2;
            if (reads === (failAt === 'first-guard-read' ? 1 : 2)) throw new Error('Guard transport unavailable');
          }
          return pre.map(frame => ({ ...frame, result: [] }));
        }
        if (/\.answer\(/.test(String(func))) {
          sends++;
          if (failAt === 'answer-transport') throw new Error('Answer transport unavailable');
          return [{ ...pre[0], result: [{ key: 'first', label: 'first', ok: true, shown: 'No' }] }];
        }
        return pre;
      } };
    vm.runInNewContext(DISPATCH_HELPERS, context);
    assert.equal(await context.applyAi(choices, ctx, 'auto'), false);
    assert.equal(sawPrepared, true, 'conservative holds exist before the guard read');
    assert.equal(sends, failAt === 'first-guard-read' ? 0 : 1);
    const count = failAt === 'first-guard-read' ? 0 : 2;
    assert.equal(stored.length, count, 'unsent preparation clears; ambiguous partial dispatch stays held');
    assert.equal(context.pendingAi(1, '/quote').length, count);
    assert.match(choices[0].error, failAt === 'first-guard-read' ? /couldn't reach/ : /sent but could not be confirmed/);
    state.aiCache.clear();
    await context.restoreAiPending();
    assert.equal(context.pendingAi(1, '/quote').length, count, 'reload preserves only actual-dispatch holds');
  });
}

// PR63 origin writes and PR65 scoped Clear share the nonce-gated production stores. A Clear
// while a write awaits storage must invalidate only the cleared intake, including later edits.
for (const clearedScope of ['A', 'B']) test(`Clear ${clearedScope} ${clearedScope === 'A' ? 'cancels' : 'preserves'} an in-flight guarded edit for intake A`, async () => {
  const t = tabRecordsHarness({ tabRecordsSession: 'browser-session', agentEditedKeys: [
    { scope: 'A', tabId: 7, page: 'Quote|v0', keys: ['earlier-A'] },
    { scope: 'B', tabId: 7, page: 'Quote|v0', keys: ['earlier-B'] },
  ], 'doneActions:A:7': ['lookupVin:0'], 'doneActions:B:7': ['lookupVin:1'] }, { tabRecordsSession: 'browser-session' });
  const originKeys = new Map([['Quote|v0', new Set(['earlier-A'])]]);
  t.state.agentKeys = originKeys;
  const origin = { scope: 'A', tabId: 7, page: 'Quote|v0', keys: originKeys, epoch: 0 };
  let readStarted, releaseRead, first = true;
  const entered = new Promise(resolve => { readStarted = resolve; });
  const waiting = new Promise(resolve => { releaseRead = resolve; });
  const get = t.context.chrome.storage.local.get;
  t.context.chrome.storage.local.get = async key => {
    if (key === 'agentEditedKeys' && first) { first = false; readStarted(); await waiting; }
    return get(key);
  };
  const writing = t.context.persistGuardedEdits(origin, ['trusted-A']);
  await entered;
  t.setIntake(clearedScope);
  t.state.agentKeys = new Map();
  const clearing = t.context.clearAgentKeys(clearedScope);
  releaseRead();
  await Promise.all([writing, clearing]);
  const remaining = clearedScope === 'A' ? 'B' : 'A';
  assert.deepEqual(t.localData.agentEditedKeys.map(record => record.scope), [remaining]);
  assert.equal(t.localData[`doneActions:${clearedScope}:7`], undefined);
  assert.ok(t.localData[`doneActions:${remaining}:7`], 'another intake keeps its helper records');
  if (clearedScope === 'B') assert.deepEqual(t.localData.agentEditedKeys[0].keys.sort(), ['earlier-A', 'trusted-A']);
  await t.context.persistGuardedEdits(origin, ['even-later-A']);
  if (clearedScope === 'A') assert.equal(t.localData.agentEditedKeys.some(record => record.scope === 'A'), false, 'late guard results cannot recreate cleared A');
  else assert.deepEqual(t.localData.agentEditedKeys[0].keys.sort(), ['earlier-A', 'even-later-A', 'trusted-A'], 'Clear B never invalidates A\'s captured origin');
  assert.equal(t.localData.tabRecordsSession, 'browser-session', 'integration keeps the shared browser-session marker');
});

test('a panel crash is logged once per message, at most 20, never on a practice page', () => {
  const logged = [];
  const state = { tab: { carrier: { id: 'progressive' }, url: 'https://x.test/q?pageName=AddVehicle' }, intake: null };
  const sandbox = { state, loggedCrashes: new Set(), usage: { log: (e) => logged.push(e) }, redactor: () => (x) => x, redactionTerms: () => [],
    pageOf: () => 'AddVehicle', clientErrorEvent: (err, { where }) => ({ type: 'client_error', where, error: String(err?.message ?? err) }) };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('logCrash'), sandbox);
  sandbox.logCrash(new Error('boom'));
  sandbox.logCrash(new Error('boom'));
  assert.deepEqual(JSON.parse(JSON.stringify(logged)), [{ type: 'client_error', where: 'panel', error: 'boom', carrier: 'progressive', page: 'AddVehicle' }]);
  for (let i = 0; i < 30; i++) sandbox.logCrash(new Error(`e${i}`));
  assert.equal(logged.length, 20);
  state.tab.carrier.practice = true;
  sandbox.loggedCrashes.clear();
  sandbox.logCrash(new Error('practice'));
  assert.equal(logged.length, 20, 'practice pages log nothing');
  sandbox.usage.log = () => { throw new Error('storage full'); };
  state.tab.carrier.practice = false;
  assert.doesNotThrow(() => sandbox.logCrash(new Error('again')), 'logging a crash never throws');
});

test('a layout carries the page\'s messages, and a new message logs the page again', async () => {
  const controls = [{ q: '2B9D', kind: 'select', label: 'Farthest distance', options: ['50 miles'] }];
  const { context, logged } = layoutHarness(() => controls);
  await context.recordLayout('Vehicles');
  assert.equal(logged[0].messages, undefined, 'no messages, no field');
  await context.recordLayout('Vehicles', 'messages');
  assert.equal(logged.length, 1, 'nothing new on the page');
  context.messages = ['This field is required'];
  await context.recordLayout('Vehicles', 'messages');
  assert.equal(logged.length, 2);
  assert.deepEqual([...logged[1].messages], ['This field is required']);
  assert.equal(logged[1].reason, 'messages');
});

test('marking a test run remembers the PDF on this computer and logs it once per change', async () => {
  const logged = [];
  let list = ['other-pdf'];
  const sandbox = { state: { intake: { record: {}, test: false } }, usage: { currentSession: () => ({ intakeId: 'this-pdf' }), log: (e) => logged.push(e) },
    testIntakes: { get: async () => list, set: async (v) => { list = v; } }, save: async () => {} };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('markTestRun'), sandbox);
  await sandbox.markTestRun(true);
  await sandbox.markTestRun(true);
  assert.deepEqual([...list], ['other-pdf', 'this-pdf']);
  assert.equal(sandbox.state.intake.test, true);
  await sandbox.markTestRun(false);
  assert.deepEqual([...list], ['other-pdf']);
  assert.deepEqual(JSON.parse(JSON.stringify(logged)), [{ type: 'intake_marked', test: true }, { type: 'intake_marked', test: false }]);
  // A test PDF loaded again carries the mark on intake_loaded.
  assert.match(SIDEPANEL, /const test = \(await testIntakes\.get\(\)\)\.includes\(summary\.intakeId\);/);
  assert.match(SIDEPANEL, /usage\.log\(\{ type: 'intake_loaded', \.\.\.summary, \.\.\.\(test \? \{ test: true \} : \{\}\), platform: platformOf\(\) \}\);/);
});

test('the agent\'s settings are logged whole: on load, on opening, and on each change', () => {
  assert.match(extractFunction('loadFile'), /usage\.log\(\{ type: 'intake_loaded'[^\n]*\n\s+await logSettings\('intake'\);/);
  const wiring = extractFunction('wireUsage');
  for (const [id, name] of [['auto-followups', 'autoFollowUps'], ['auto-pages', 'autoPages'], ['auto-advance', 'autoAdvance'], ['overwrite', 'overwrite']]) {
    assert.match(wiring, new RegExp(`\\$\\('${id}'\\)\\.addEventListener\\('change'[^\\n]*logSettings\\('changed', '${name}'\\)`), `${id} logs its change`);
  }
  assert.match(extractFunction('wireAi'), /await usage\.saveSettings\(patch\);\s+logSettings\('changed'/);
  assert.match(SIDEPANEL, /if \(state\.intake && usage\.currentSession\(\)\) logSettings\('opened'\);/);
});

test('marking a needs-you item done logs which question and why, keyed like fill events', async () => {
  const logged = [];
  const state = { filling: false, tab: { id: 7, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, agentKeys: new Map() };
  const sandbox = { state, usage: { log: (e) => logged.push(e), currentSession: () => ({ keySalt: 's' }) }, pageOf: (u) => u, editScope: (p) => p,
    persistAgentKeys: async () => {}, settleNeed: () => {}, undoMarkDone: () => {}, redactor: () => (v) => v, redactionTerms: () => [], viewOf: () => 't1',
    checkDismissedEvent: (x) => ({ type: 'check_dismissed', q: x.q, key: x.key, label: x.label, mark: x.mark }) };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('markDone'), sandbox);
  await sandbox.markDone({}, '1D97', 7, 'Rates', { key: '1D97', q: '1D97', label: 'Liability', mark: 'check' });
  assert.deepEqual(JSON.parse(JSON.stringify(logged)), [{ type: 'check_dismissed', q: '1D97', key: '1D97', label: 'Liability', mark: 'check', carrier: 'progressive', page: 'Rates', view: 't1' }]);
  assert.ok(state.agentKeys.get('Rates').has('1D97'), 'and the question is still the agent\'s, as before');
  state.tab.carrier.practice = true;
  await sandbox.markDone({}, '2B9D', 7, 'Rates', { key: '2B9D', label: 'Distance', mark: 'needs' });
  assert.equal(logged.length, 1, 'practice pages log nothing');
});

test('a problem report names the fill it is about: view, run, step and what held Continue', () => {
  let now = 1_000_000;
  const state = { intake: { record: {} }, lastRuns: new Map([['7|Rates', { run: 'run-1234-abcd', at: now - 90_000, step: undefined, blockers: ['button: recalculate'] }]]) };
  const sandbox = { state, viewOf: () => 't1', Date: { now: () => now }, Math };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('problemContext'), sandbox);
  const tab = { id: 7, carrier: { id: 'progressive' } };
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.problemContext(tab, 'Rates'))), { view: 't1', run: 'run-1234-abcd', blockerList: ['button: recalculate'], since: 90 });
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.problemContext(tab, 'AddVehicle'))), { view: 't1' }, 'no fill on that page: only where');
  now += 31 * 60 * 1000;
  assert.equal(sandbox.problemContext(tab, 'Rates').run, undefined, 'a fill half an hour old is not what the report is about');
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.problemContext(tab, 'Rates'))), { view: 't1' });
  state.intake = null;
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.problemContext(tab, 'Rates'))), {});
  assert.match(extractFunction('wireUsage'), /type: 'problem_report'[^\n]*\.\.\.problemContext\(state\.tab, page\)/);
});

test('the agent\'s own button clicks are logged redacted, with a known step only', () => {
  const body = extractFunction('onRecorderMessage');
  assert.match(body, /if \(msg\.event === 'agent_click'\) \{[\s\S]{0,400}log\(\{ type: 'agent_click', carrier, page, view: viewOf\(sender\.tab\.id, page\), \.\.\.\(step \? \{ step \} : \{\}\), text: redactor\(redactionTerms\(state\.intake\.record\)\)/);
  assert.match(body, /knownStep\(state\.tab\.carrier, msg\.step\)/);
});

test('a new intake does not inherit the previous client\'s fill in problem reports', () => {
  const now = 1_000_000;
  const state = { intake: { record: { id: 'A' } }, lastLayouts: new Map(), lastRuns: new Map([['7|Rates', { run: 'run-1234-abcd', at: now - 60_000, blockers: ['button: recalculate'] }]]) };
  const sandbox = { state, viewOf: () => 't1', Date: { now: () => now }, Math, Set, Map };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('problemContext'), sandbox);
  vm.runInContext(extractFunction('holdLayouts'), sandbox);
  const tab = { id: 7, carrier: { id: 'progressive' } };
  assert.equal(sandbox.problemContext(tab, 'Rates').run, 'run-1234-abcd');
  state.intake = { record: { id: 'B' } };
  sandbox.holdLayouts();
  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.problemContext(tab, 'Rates'))), { view: 't1' }, 'client B has no fill yet on that page');
});

test('a settings change is logged only with an intake and session open, and a failure stays inside', async () => {
  const logged = [];
  let session = null;
  let failing = false;
  const sandbox = {
    state: { intake: null }, $: () => null,
    usage: { currentSession: () => session, settings: async () => { if (failing) throw new Error('storage'); return {}; }, log: (e) => logged.push(e), DEFAULT_SERVER: 'https://example.test' },
    agentSettingsEvent: (saved, opts) => ({ type: 'agent_settings', reason: opts.reason, changed: opts.changed }),
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('logSettings'), sandbox);
  await sandbox.logSettings('changed', 'autoPages');
  assert.equal(logged.length, 0, 'no intake, no session');
  sandbox.state.intake = {};
  await sandbox.logSettings('changed', 'autoPages');
  assert.equal(logged.length, 0, 'an intake without a session');
  session = { intakeId: 'x' };
  await sandbox.logSettings('changed', 'autoPages');
  assert.deepEqual(logged.map((e) => e.reason), ['changed']);
  failing = true;
  await assert.doesNotReject(sandbox.logSettings('changed', 'autoPages'));
  await assert.doesNotReject(sandbox.logSettings('intake'));
  assert.equal(logged.length, 1, 'a failure logs nothing and throws nothing');
});

test('an empty page is logged for a combined reason that includes messages, and skipped when the reason lacks it', async () => {
  const { context, logged } = layoutHarness(() => []);
  context.messages = ['This field is required'];
  await context.recordLayout('Vehicles', 'changed');
  assert.equal(logged.length, 0, 'messages on an empty page do not count without the messages reason');
  await context.recordLayout('Vehicles', 'arrived+changed');
  assert.equal(logged.length, 0, 'a combined reason without messages is skipped too');
  await context.recordLayout('Vehicles', 'changed+messages');
  assert.equal(logged.length, 1, 'messages merged with another reason is logged');
  assert.equal(logged[0].reason, 'changed+messages');
  assert.deepEqual([...logged[0].messages], ['This field is required']);
  assert.equal(logged[0].fields.length, 0);
  context.messages = [];
  await context.recordLayout('Rates', 'changed+messages');
  assert.equal(logged.length, 1, 'the messages reason with no message on an empty page is still skipped');
});

test('a panel crash is still logged when the intake has no record, and never unredacted if the redactor fails', () => {
  const logged = [];
  const state = { tab: { carrier: { id: 'progressive' }, url: 'https://x.test/q?pageName=AddVehicle' }, intake: {} };
  const sandbox = { state, loggedCrashes: new Set(), usage: { log: (e) => logged.push(e) },
    redactor: () => (x) => x, redactionTerms: (record) => { if (!record) throw new TypeError("Cannot read properties of null (reading 'record')"); return []; },
    pageOf: () => 'AddVehicle', clientErrorEvent: (err, { where, redact }) => ({ type: 'client_error', where, error: redact(String(err?.message ?? err)) }) };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('logCrash'), sandbox);
  sandbox.logCrash(new Error('no record'));
  state.intake = { record: null };
  sandbox.logCrash(new Error('null record'));
  assert.deepEqual(logged.map((e) => e.error), ['no record', 'null record'], 'an intake without a record still logs the crash');
  state.intake = { record: { name: 'Ada' } };
  sandbox.redactionTerms = () => { throw new Error('terms failed'); };
  sandbox.logCrash(new Error('Ada Lovelace typed this'));
  assert.equal(logged.length, 3, 'the event is still logged when the redactor cannot be built');
  assert.equal(logged[2].error, '', 'with the message dropped, never unredacted');
});

// Maintainer 2026-10-10: Luna's driver-name check, beside the claims-box review. Gender is filled
// MALE (TNI standard); a likely_female first name becomes a check item; with the assistant off
// nothing is sent and nothing changes.
function namesHarness() {
  const logs = [], requests = [], gates = [];
  const t = { logs, requests, reply: 'ok' };
  const state = { intake: null, namesAsking: null, namesRetry: null };
  class AssistError extends Error {}
  const context = {
    state, AssistError, Date, get: (obj, path) => path.split(/[.[\]]+/).filter(Boolean).reduce((o, k) => o?.[k], obj),
    firstNameOf: (v) => String(v ?? '').trim().split(/\s+/)[0] || null,
    aiSettings: async () => ({ on: !state.offline, apiKey: state.noKey ? '' : 'k', ready: !state.noKey, model: 'gpt-6-luna' }),
    reviewDriverNames: async (record, cfg) => {
      requests.push({ record: structuredClone(record), cfg });
      const reply = t.reply;
      await new Promise((resolve) => gates.push(resolve));
      if (reply === 'fail') throw new AssistError('Luna returned an invalid driver-name review.');
      return { warnings: [{ code: 'ai.driver-gender', path: 'drivers[0].gender', level: 'check', msg: 'x', choices: [] }], names: 2, flagged: 1, modelCalls: 1, tokensIn: 5, tokensOut: 1, reasoningTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
    },
    usage: { log: (e) => logs.push(e) }, save: async () => {}, render: () => {},
  };
  vm.runInNewContext(extractFunction('driverNamesContext') + extractFunction('supersedeGenderItems') + extractFunction('reviewDriverGender'), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  t.answer = async () => { await settle(); gates.shift()(); for (let i = 0; i < 5; i++) await settle(); };
  return Object.assign(t, { state, review: context.reviewDriverGender, settle });
}
const namesIntake = () => ({ record: { drivers: [{ first: 'Maria', last: 'Sample' }, { first: 'John', last: 'Sample' }], coverage: {} }, warnings: [{ code: 'other', level: 'check' }], done: [] });

test('Luna checks driver first names once per intake, never with the assistant off, and fails to an info note', async () => {
  // Off, or no key: nothing is sent, nothing changes (gender stays the TNI standard).
  for (const flag of ['offline', 'noKey']) {
    const t = namesHarness();
    const intake = namesIntake();
    t.state.intake = intake;
    t.state[flag] = true;
    await t.review({ retry: true });
    assert.equal(t.requests.length, 0, flag);
    assert.deepEqual(intake.warnings.map((w) => w.code), ['other'], flag);
    assert.equal(intake.namesReview, undefined, flag);
  }
  const t = namesHarness();
  const intake = namesIntake();
  t.state.intake = intake;
  t.review();
  await t.answer();
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.driver-gender', 'check']]);
  assert.equal(intake.namesReview.done, true);
  assert.deepEqual(Object.keys(t.logs[0]).sort(), ['cacheWriteTokens', 'cachedTokens', 'items', 'leave', 'model', 'modelCalls', 'ms', 'page', 'reasoningTokens', 'suggested', 'tokensIn', 'tokensOut', 'type'], 'counts only, never a name');
  assert.equal(t.logs[0].page, 'DriverNames');
  await t.review({ retry: true });
  assert.equal(t.requests.length, 1, 'once per intake');
  // The agent set the gender meanwhile: that isn't a change to what Luna read.
  intake.record.drivers[0].gender = 'MALE';
  await t.review({ retry: true });
  assert.equal(t.requests.length, 1);
  // A first name edited afterwards: the old item is retired in place and the names are read again;
  // the new answer adds none for a driver whose gender is set.
  intake.record.drivers[0].first = 'Mario';
  t.review({ retry: true });
  await t.answer();
  assert.equal(t.requests.length, 2);
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.driver-gender-superseded', 'info']]);

  // A failure: an info note (the TNI standard stands), retried on a settings change.
  const f = namesHarness();
  const failing = namesIntake();
  f.state.intake = failing;
  f.reply = 'fail';
  f.review();
  await f.answer();
  assert.deepEqual(failing.warnings.map((w) => [w.code, w.level]), [['other', 'check'], ['ai.driver-names-failed', 'info']]);
  assert.match(failing.warnings[1].msg, /Gender is filled Male \(TNI standard\)/);
  await f.review();
  assert.equal(f.requests.length, 1, 'not retried on every panel reload');
  f.reply = 'ok';
  f.review({ retry: true });
  await f.answer();
  assert.deepEqual(failing.warnings.map((w) => w.code), ['other', 'ai.driver-names-reviewed', 'ai.driver-gender']);
});

test('Luna\'s GL and driver-gender check cards set the record as the agent\'s edit, or dismiss', async () => {
  const { get, set } = await import('../src/util.js');
  const { rederive } = await import('../src/normalize.js');
  const { GL_CHOICES, genderChoices } = await import('../src/ai/luna.js');
  const el = (tag, props = {}, ...children) => ({ tag, props, children: children.flat().filter((c) => c != null && c !== false) });
  const nodes = {};
  const $ = (id) => (nodes[id] ??= { id, hidden: false, textContent: '', replaceChildren(...kids) { this.kids = kids; }, focus() {} });
  const record = { coverage: { gl: null, hasGl: null }, drivers: [{ first: 'Maria' }, { first: 'John' }] };
  const intake = { record, agentEdited: [], done: [], warnings: [
    { code: 'other', level: 'check', path: 'applicant.name', msg: 'other' },
    { code: 'ai.gl', level: 'check', path: 'coverage.hasGl', msg: 'Luna: the claims box mentions general liability: "Has GL".', choices: GL_CHOICES.map((c) => ({ ...c })) },
    { code: 'ai.driver-gender', level: 'check', path: 'drivers[0].gender', msg: 'Gender is filled Male.', choices: genderChoices(0) },
    { code: 'ai.driver-gender', level: 'check', path: 'drivers[1].gender', msg: 'Gender is filled Male.', choices: genderChoices(1) },
  ] };
  const calls = [];
  const sandbox = {
    state: { intake, view: 'check' }, h: el, $, get, set, rederive, fieldInfo: (p) => ({ label: p }), sourcePlace: () => null, pdfPageSaid: () => '',
    document: { getElementById: () => null, querySelector: () => null },
    renderSteps() {}, renderSections: () => calls.push(['renderSections', get(record, 'drivers[0].gender') ?? null]), fieldRow() {}, jumpTo() {}, openPdf() {},
    intakeEdited: () => calls.push(['intakeEdited']), usage: { log: (e) => calls.push(['log', e.type, e.path, e.code ?? null]) },
    save: async () => calls.push(['save']), claimsTextEdited() {}, reviewClaimsBox: () => calls.push(['reviewClaimsBox']), reviewDriverGender: () => calls.push(['reviewDriverGender']),
    profileLater() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(['checkShown', 'renderWarnings', 'toggleDone', 'agentEdit', 'applyCheckChoice'].map(extractFunction).join('\n') + `\nconst CHOICE_FIELDS = ${SIDEPANEL.match(/const CHOICE_FIELDS = (.*);/)[1]};`, sandbox);
  sandbox.renderWarnings();
  assert.equal(nodes['check-title'].textContent, '4 things to look at on the intake');
  // The open items' cards (a checked one is a row with Undo), and their buttons.
  const cards = () => nodes.warnings.kids.filter((c) => c.props?.class === 'check');
  const buttons = (card) => nodesIn(card).filter((c) => c.tag === 'button');
  assert.deepEqual(buttons(cards()[0]).map((b) => b.children[0]), ['Looks right now', 'Show in client details'], 'other cards unchanged');
  assert.deepEqual(buttons(cards()[1]).map((b) => b.children[0]), ['Client has GL', 'Not GL']);
  assert.deepEqual(buttons(cards()[2]).map((b) => b.children[0]), ['Use Female', 'Keep Male']);

  await buttons(cards()[2])[0].props.onclick();
  assert.equal(record.drivers[0].gender, 'FEMALE');
  assert.deepEqual([...intake.agentEdited], ['drivers[0].gender'], 'the agent\'s edit, kept with the intake');
  assert.deepEqual([...intake.done], [2], 'the item is checked');
  assert.deepEqual(calls.slice(0, 4), [['intakeEdited'], ['log', 'intake_edit', 'drivers[0].gender', null], ['save'], ['renderSections', 'FEMALE']], 'set and saved, logged without the value');
  assert.ok(calls.some((c) => c[1] === 'warning_checked' && c[3] === 'ai.driver-gender'));
  assert.ok(!calls.some((c) => c[0] === 'reviewClaimsBox' || c[0] === 'reviewDriverGender'), 'setting a gender reads nothing again');

  sandbox.renderWarnings();
  await buttons(cards()[2])[1].props.onclick();
  assert.equal(record.drivers[1].gender, 'MALE', 'Keep Male sets it too: the agent decided');

  calls.length = 0;
  sandbox.renderWarnings();
  await buttons(cards()[1])[1].props.onclick();
  assert.equal(record.coverage.hasGl, null, 'Not GL leaves the record alone');
  assert.deepEqual([...intake.done].sort(), [1, 2, 3]);
  intake.done = intake.done.filter((d) => d !== 1);
  await sandbox.applyCheckChoice(1, intake.warnings[1].choices[0]);
  assert.equal(record.coverage.hasGl, true, 'Client has GL sets coverage.hasGl');
  assert.equal(record.coverage.gl, null, 'and asks for no GL quote (audit 2026-10-10)');
  assert.ok(intake.agentEdited.includes('coverage.hasGl'));
  assert.ok(!calls.some((c) => c[0] === 'reviewClaimsBox'), 'GL is not form coverage Luna compares with: no re-read');

  // Stored items are data: a choice not on the item, another field or another value does nothing.
  const before = JSON.stringify(record);
  intake.done = [];
  await sandbox.applyCheckChoice(2, { label: 'Use Female', path: 'drivers[1].gender', value: 'FEMALE' });
  intake.warnings.push({ code: 'ai.gl', level: 'check', path: 'coverage.hasGl', msg: 'x', choices: [{ label: 'Set', path: 'applicant.name', value: 'X' }, { label: 'Bad', path: 'coverage.hasGl', value: 'yes' }, { label: 'Request', path: 'coverage.gl', value: true }] });
  await sandbox.applyCheckChoice(4, intake.warnings[4].choices[0]);
  await sandbox.applyCheckChoice(4, intake.warnings[4].choices[1]);
  await sandbox.applyCheckChoice(4, intake.warnings[4].choices[2]);
  assert.equal(JSON.stringify(record), before);
  assert.deepEqual([...intake.done], []);
});

// TNI, 2026-10-26 (answer to PR #189's question 9): the current carrier being one the panel quotes
// is said in red on the intake check screen, before any carrier page, first among the checks. It is
// a check like the others (its field, Looks right now), no stop (question 19).
test('an alert intake check is red and first on the check screen, with its field and Looks right now', () => {
  const el = (tag, props = {}, ...children) => ({ tag, props, children: children.flat().filter((c) => c != null && c !== false) });
  const nodes = {};
  const $ = (id) => (nodes[id] ??= { id, hidden: false, textContent: '', replaceChildren(...kids) { this.kids = kids; } });
  const intake = { record: { priorInsurance: [{ type: 'Commercial Auto', carrier: 'GEICO' }] }, agentEdited: [], done: [], warnings: [
    { code: 'other', level: 'check', path: 'applicant.name', msg: 'other' },
    { code: 'prior.carrier-is-quoted', level: 'check', path: 'priorInsurance[0].carrier', alert: true, msg: 'Current insurance is with GEICO: a GEICO quote may be declined or routed.' },
  ] };
  const rows = [];
  const sandbox = { state: { intake, view: 'check', tab: { carrier: geico } }, h: el, $, fieldInfo: (p) => ({ label: `Field ${p}`, kind: 'text' }), sourcePlace: () => null, pdfPageSaid: () => '',
    renderSteps() {}, fieldRow: (path) => { rows.push(path); return el('input', { path }); }, jumpTo() {}, openPdf() {}, quotedCarrierPolicy };
  vm.createContext(sandbox);
  vm.runInContext(extractFunction('checkShown'), sandbox);
  vm.runInContext(extractFunction('renderWarnings'), sandbox);
  sandbox.renderWarnings();
  assert.equal(nodes['check-title'].textContent, '2 things to look at on the intake');
  const [first, second] = nodes.warnings.kids;
  assert.deepEqual([first.props.class, first.props.role, first.props.dataset.check], ['check alert', 'alert', '1'], 'red, said at once, first');
  assert.deepEqual([second.props.class, second.props.role ?? null], ['check', null], 'the others as before');
  assert.ok(JSON.stringify(first).includes('Looks right now'));
  assert.deepEqual(rows, ['priorInsurance[0].carrier', 'applicant.name']);
  // Checked, it is a row like any other.
  intake.done = [1];
  sandbox.renderWarnings();
  assert.equal(nodes.warnings.kids[0].props.class, 'checked-row');
  const css = fs.readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.check\.alert\s*\{[^}]*border-color:\s*var\(--signal-line\)/);
  // Only on that carrier's site (TNI, 2026-10-27): on another carrier's, or before any carrier page,
  // it isn't shown or counted.
  intake.done = [];
  for (const tab of [{ carrier: progressive }, null]) {
    sandbox.state.tab = tab;
    rows.length = 0;
    sandbox.renderWarnings();
    assert.equal(nodes['check-title'].textContent, '1 thing to look at on the intake', tab?.carrier.id ?? 'no carrier');
    assert.deepEqual(rows, ['applicant.name']);
  }
});

// ---------------------------------------------------------------------------------------------
// GEICO (survey 2026-10-20): every step of the quote is one address (sales.geico.com/quote), the
// Vehicles and Drivers & Incidents steps draw one unit's form at a time, and Final Quote Details,
// MVR & CLUE and Payment Information are the agent's (src/carriers/geico.js).

test('a stop is the carrier\'s stop page or, on a one-address application, a step that is the agent\'s', () => {
  const state = { tab: { id: 3 }, tabSteps: new Map([[3, 'MVR & CLUE']]) };
  const context = { state };
  vm.runInNewContext(extractFunction('stopNoteFor'), context);
  const progressive = { stopPages: { DeclinationNotice: 'Declined.' } };
  assert.equal(context.stopNoteFor(progressive, 'DeclinationNotice'), 'Declined.');
  assert.equal(context.stopNoteFor(progressive, 'Rates'), null);
  // The step the tab is on (noteStep), or the one the caller has from the page.
  assert.equal(context.stopNoteFor(geico, '/quote'), geico.stopSteps['MVR & CLUE']);
  assert.equal(context.stopNoteFor(geico, '/quote', 'Payment Information'), geico.stopSteps['Payment Information']);
  assert.equal(context.stopNoteFor(geico, '/quote', 'Quote & Coverages'), null);
  state.tabSteps.set(3, 'Vehicles');
  assert.equal(context.stopNoteFor(geico, '/quote'), null);
  state.tabSteps.delete(3);
  assert.equal(context.stopNoteFor(geico, '/quote'), null, 'a step not read yet is no stop here (the kit reads it on the page)');
  // Step names count only for a carrier with steps; no steps known, or no carrier: no stop.
  state.tabSteps.set(3, 'MVR & CLUE');
  assert.equal(context.stopNoteFor({ stopSteps: geico.stopSteps }, '/quote'), null);
  delete state.tabSteps;
  assert.equal(context.stopNoteFor(geico, '/quote'), null);
  assert.equal(context.stopNoteFor(undefined, '/quote'), null);
  // Every other check goes through it: only its own lookup, the stop page's arrival log and the
  // wording of the stop page's card and of the dock (once stopNoteFor said it's a stop; the dock's
  // with a stop screen marked `stopped`, W44-04) read stopPages.
  assert.equal((SIDEPANEL.match(/stopPages\?\.\[/g) ?? []).length, 4);
  assert.match(extractFunction('dockFor'), /if \(stopNoteFor\(carrier, page, step\)\) \{\s+const screen = [^;]+;\s+if \(carrier\.stopPages\?\.\[page\] \|\| carrier\.stopButtons\?\.\[screen\]\?\.stopped\)/);
});

// The stop harness on GEICO's quote: the tab on `step` (as noteStep heard it).
function stopStepHarness(step = 'Quote & Coverages') {
  const t = stopHarness();
  Object.assign(t.state, { tab: { id: 4, url: 'https://sales.geico.com/quote', carrier: geico }, tabSteps: new Map([[4, step]]), autoPages: new Set(['/quote']), reports: new Map() });
  Object.assign(t.context, { knownStep, renderSite: () => t.context.showStopPage() });
  vm.runInContext(extractFunction('noteStep'), t.context);
  const show = (to, event = 'step_shown', extra = {}) => t.context.noteStep({ ra: 'usage', event, page: '/quote', step: to, ...extra }, { tab: { id: 4 }, frameId: 0 });
  return { ...t, show };
}

test('on a stop step nothing is filled, clicked or scheduled, manual or automatic, and Luna is not asked', async () => {
  for (const step of Object.keys(geico.stopSteps)) {
    const t = stopStepHarness(step);
    await t.context.fillPage({ auto: 'page' });
    await t.context.fillPage();
    t.context.scheduleAutoFill('/quote');
    await t.context.autoFill('/quote');
    assert.deepEqual([t.kits, t.timers, t.state.filling], [[], [], false], step);
    const ctx = { intake: t.state.intake, tabId: 4, tabUrl: t.state.tab.url, page: '/quote' };
    assert.equal(t.context.aiActionCurrent(ctx, []), false, step);
    // Said as the step's own, about no client (no "GEICO stopped this quote"), in a quiet card: the
    // step is the agent's, nothing went wrong.
    const note = t.ui['stop-note'];
    assert.equal(note.hidden, false);
    const text = JSON.stringify(note.children);
    assert.ok(text.includes(`${step}: yours`) && text.includes(geico.stopSteps[step]), step);
    assert.match(text, /Nothing on this step is filled or clicked/);
    assert.match(text, /"class":"issue quiet","role":"status"/);
    assert.doesNotMatch(text, /stopped this quote|another client/);
  }
  // The step before them is filled as before, with its own note: the quote stops there.
  const t = stopStepHarness('Quote & Coverages');
  t.context.scheduleAutoFill('/quote');
  assert.equal(t.timers.length, 1);
  assert.equal(t.context.aiActionCurrent({ intake: t.state.intake, tabId: 4, tabUrl: t.state.tab.url, page: '/quote' }, []), true);
  t.context.showStopPage();
  assertStepNote(t, 'Quote & Coverages');
});

// GEICO's Quote & Coverages note (carrier stepNotes): said, not a stop.
function assertStepNote(t, step) {
  const note = t.ui['stop-note'];
  assert.equal(note.hidden, false, step);
  const text = JSON.stringify(note.children);
  assert.ok(text.includes(geico.stepNotes[step]), step);
  assert.match(text, /"role":"status"/);
  assert.doesNotMatch(text, /: yours|Nothing on this step is filled/);
}

test('each arrival at a stop step is logged once as a fill_run blocker, with the step\'s name only', () => {
  const t = stopStepHarness('Quote & Coverages');
  t.show('Final Quote Details');
  // Shown again, new questions on it, changes on it: the same arrival.
  t.show('Final Quote Details');
  t.show('Final Quote Details', 'new_fields');
  t.show('Final Quote Details', 'field_changes', { changes: [] });
  assert.equal(t.stops().length, 1);
  // A reloaded document on it is a new one, as for a stop page.
  t.show('Final Quote Details', 'page_view', { from: null, fields: 3 });
  t.show('MVR & CLUE');
  const stops = JSON.parse(JSON.stringify(t.stops()));
  assert.deepEqual(stops.map((e) => [e.blockerList, e.step, e.auto, e.page, e.advanced]), [
    [['stop: Final Quote Details'], 'Final Quote Details', 'stop', '/quote', null],
    [['stop: Final Quote Details'], 'Final Quote Details', 'stop', '/quote', null],
    [['stop: MVR & CLUE'], 'MVR & CLUE', 'stop', '/quote', null],
  ]);
  for (const k of ['filled', 'failed', 'noData', 'kept', 'leftRequired', 'unknown', 'ms', 'fields']) assert.equal(stops[0][k], 0, k);
  assert.doesNotMatch(JSON.stringify(t.logged), /Synthetic Client/);
  assert.equal(t.ui['stop-note'].hidden, false);
  // Back on a step that is not the agent's: nothing logged, the note goes. A heading that is no
  // step name changes nothing.
  t.show('Quote & Coverages');
  t.show('Jordan Avery Trucking LLC');
  assert.equal(t.stops().length, 3);
  assertStepNote(t, 'Quote & Coverages');
  // Practice copies log nothing; nor does a tab that showed it before this client was loaded,
  // though the step's note (about no client) is said all the same.
  const practice = stopStepHarness();
  practice.state.tab.carrier = { ...geico, practice: true };
  practice.show('MVR & CLUE');
  assert.deepEqual(practice.stops(), []);
  const before = stopStepHarness();
  before.state.layoutHold = true;
  before.show('Payment Information');
  assert.deepEqual(before.stops(), []);
  assert.equal(before.ui['stop-note'].hidden, false);
});

// W43-27 (TNI, 2026-10-21): after Business & Owner Info GEICO showed a screen with only Add USDOT
// Number and Skip (SC, PA; the kit reads no step there), and the panel said nothing. Its layout
// names it (`stopButtons`): a red stop, logged as a fill run that stopped; nothing filled, clicked or
// asked; Add or Skip is the agent's; the next step ends it.
test('GEICO\'s Add USDOT Number screen: read from its layout\'s buttons, logged once as a stop, ended by a layout without it', async () => {
  const { context, logged } = layoutHarness(() => []);
  context.state.tab = { id: 1, url: '/quote', carrier: { ...geico, layoutUrl: /./ } };
  context.knownStep = knownStep;
  context.buttons = ['Menu', 'Add USDOT Number', 'Skip'];
  await context.recordLayout('/quote', 'arrived+removed');
  assert.deepEqual({ ...context.state.stopScreens.get(1) }, { name: 'USDOT Number', page: '/quote' });
  const stops = () => JSON.parse(JSON.stringify(logged.filter((e) => e.type === 'fill_run')));
  assert.deepEqual(stops().map((e) => [e.blockerList, e.auto, e.page, e.fields]), [[['stop: USDOT Number'], 'stop', '/quote', 0]]);
  // The page's layout is logged as before, with the button the next review looks for.
  assert.ok(logged.some((e) => e.type === 'page_layout' && e.buttons.includes('Add USDOT Number')));
  assert.equal(context.rendered, 1);
  // Read again on the same screen: logged once.
  await context.recordLayout('/quote', 'changed');
  assert.equal(stops().length, 1);
  // Another page's layout without the button (Skip led on): over.
  context.buttons = ['Menu', 'Next'];
  await context.recordLayout('/quote', 'arrived');
  assert.equal(context.state.stopScreens.has(1), false);
  assert.equal(stops().length, 1);
  // No such screen for a carrier without stopButtons.
  const other = layoutHarness(() => []);
  other.context.buttons = ['Add USDOT Number'];
  await other.context.recordLayout('Vehicles', 'arrived');
  assert.equal(other.context.state.stopScreens.size, 0);
  assert.equal(stopScreen(geico, ['  Add   USDOT Number ']), 'USDOT Number');
  assert.equal(stopScreen(geico, ['Add USDOT Number later', 'Skip']), null);
});

// W44-04, GEICO IL (TNI, 2026-10-26): after Additional Business Info GEICO showed a page with no step
// and no questions, only Menu, GEICO's phone number and "Return to GEICO Gateway" (GEICO won't quote
// the business online), and the panel said nothing. Its layout names it (`stopButtons`, `stopped`):
// GEICO's stop, said in red in the dock and above the answers as a stop page's, logged once as a
// stop; nothing filled, clicked or asked there. Not the quiet card of the USDOT screen (W43-27).
test('GEICO\'s referral page: read from its layout\'s buttons, logged once, said as GEICO\'s red stop', async () => {
  const { context, logged } = layoutHarness(() => []);
  context.state.tab = { id: 1, url: '/quote', carrier: { ...geico, layoutUrl: /./ } };
  context.knownStep = knownStep;
  context.buttons = ['Menu', '(800) 624-2513', 'Return to GEICO Gateway'];
  await context.recordLayout('/quote', 'arrived+removed');
  assert.deepEqual({ ...context.state.stopScreens.get(1) }, { name: 'GEICO referral', page: '/quote' });
  const stops = () => JSON.parse(JSON.stringify(logged.filter((e) => e.type === 'fill_run')));
  assert.deepEqual(stops().map((e) => [e.blockerList, e.auto, e.page, e.fields]), [[['stop: GEICO referral'], 'stop', '/quote', 0]]);
  assert.ok(logged.some((e) => e.type === 'page_layout' && e.buttons.includes('Return to GEICO Gateway')));
  await context.recordLayout('/quote', 'changed');
  assert.equal(stops().length, 1);
  // Only that button's words; the USDOT screen stays its own.
  assert.equal(stopScreen(geico, ['Menu', 'Return to GEICO Gateway later']), null);
  assert.equal(stopScreen(geico, ['Menu', 'Add USDOT Number', 'Skip']), 'USDOT Number');
  // Nothing filled, clicked, scheduled or asked there.
  const t = stopStepHarness('Additional Business Info');
  t.state.stopScreens = new Map([[4, { name: 'GEICO referral', page: '/quote' }]]);
  await t.context.fillPage({ auto: 'page' });
  await t.context.fillPage();
  t.context.scheduleAutoFill('/quote');
  await t.context.autoFill('/quote');
  assert.deepEqual([t.kits, t.timers, t.state.filling], [[], [], false]);
  assert.equal(t.context.aiActionCurrent({ intake: t.state.intake, tabId: 4, tabUrl: t.state.tab.url, page: '/quote' }, []), false);
  // Above the answers: red, with role alert, as a stop page's.
  t.context.showStopPage();
  const text = JSON.stringify(t.ui['stop-note'].children);
  assert.equal(t.ui['stop-note'].hidden, false);
  assert.match(text, /"class":"issue","role":"alert"/);
  assert.match(text, /GEICO stopped this quote/);
  assert.match(text, /GEICO won't quote this business online/);
  assert.match(text, /Nothing on this page is filled or clicked/);
  assert.doesNotMatch(text, /issue quiet|GEICO referral: yours|Additional Business Info: yours/);
  // The dock: GEICO's stop, no fill offered.
  const dock = dockHarness({ carrier: geico, url: '/quote', step: 'Additional Business Info', extra: {} });
  dock.state.stopScreens = new Map([[7, { name: 'GEICO referral', page: '/quote' }]]);
  const d = dock.dock();
  assert.deepEqual([d.phase, d.tone, d.eyebrow, d.button], ['stopped', 'bad', 'Stopped by GEICO', undefined]);
});

// W44-14 (TNI, 2026-10-26; W43-49): Progressive's NoHit page should get more attention: its note is a
// yellow warning box (`warnPages`), above the answers; other agent pages' notes stay a line of text.
test('Progressive\'s NoHit note is a yellow warning box; other agent pages\' notes stay lines', () => {
  const render = (page) => {
    const { context, box } = reportHarness({ tab: { id: 1, url: page, carrier: progressive }, intake: { record: {} } }, { pageOf: () => page });
    context.renderReport([{ fields: 1, filled: [{ label: 'Owner first name', shown: 'Synthetic' }], kept: [], failed: [], noData: [], leftRequired: [], actions: [] }]);
    return box.children.filter(Boolean);
  };
  const noHit = render('NoHit');
  assert.deepEqual([noHit[0].tag, noHit[0].props.class, noHit[0].props.role], ['div', 'issue warn', 'status']);
  const said = JSON.stringify(noHit[0]);
  assert.match(said, /"Owner not verified"/);
  assert.ok(said.includes(JSON.stringify(progressive.agentPages.NoHit)), 'the page\'s note, as it was');
  assert.ok(!noHit.some((n) => n.props?.class === 'note-line agent-page'));
  const print = render('PrintEmailFax');
  assert.deepEqual([print[0].tag, print[0].props.class, print[0].children], ['p', 'note-line agent-page', [progressive.agentPages.PrintEmailFax]]);
  assert.deepEqual(progressive.warnPages, { NoHit: 'Owner not verified' });
});

test('on GEICO\'s Add USDOT Number screen the panel says so, and nothing is filled, clicked, scheduled or asked until the next step', async () => {
  const t = stopStepHarness('Business & Owner Info');
  t.state.stopScreens = new Map([[4, { name: 'USDOT Number', page: '/quote' }]]);
  await t.context.fillPage({ auto: 'page' });
  await t.context.fillPage();
  t.context.scheduleAutoFill('/quote');
  await t.context.autoFill('/quote');
  assert.deepEqual([t.kits, t.timers, t.state.filling], [[], [], false]);
  const ctx = { intake: t.state.intake, tabId: 4, tabUrl: t.state.tab.url, page: '/quote' };
  assert.equal(t.context.aiActionCurrent(ctx, []), false);
  t.context.showStopPage();
  let text = JSON.stringify(t.ui['stop-note'].children);
  assert.equal(t.ui['stop-note'].hidden, false);
  assert.match(text, /USDOT Number: yours/);
  assert.match(text, /GEICO asks for a USDOT number, and the intake has none\. Add USDOT Number or Skip is yours\./);
  assert.match(text, /Nothing on this screen is filled or clicked/);
  // v5: the agent's screen, said in the quiet card a stop step has (only the carrier's stop page and
  // a quote state that differs are red).
  assert.match(text, /"class":"issue quiet","role":"status"/);
  assert.doesNotMatch(text, /Business & Owner Info: yours/);
  // The dock offers no fill there, and names the screen.
  const screenDock = dockHarness({ carrier: geico, url: '/quote', step: 'Business & Owner Info', extra: {} });
  screenDock.state.stopScreens = new Map([[7, { name: 'USDOT Number', page: '/quote' }]]);
  assert.deepEqual([screenDock.dock().phase, screenDock.dock().button, screenDock.dock().title, screenDock.dock().sub],
    ['yours', undefined, 'Finish USDOT Number yourself', 'Nothing on this screen is filled or clicked.']);
  // An intake with a USDOT number: the note names it.
  t.state.intake = { record: { applicant: { name: 'Synthetic Client LLC', dot: '1234567' } } };
  t.context.showStopPage();
  assert.match(JSON.stringify(t.ui['stop-note'].children), /the intake's is \\"1234567\\"/);
  // Another page of the tab (the gateway): not that screen.
  assert.equal(t.context.stopNoteFor(geico, '/'), null);
  // Skip led to Vehicles: over, and the step is filled again.
  t.show('Vehicles');
  assert.equal(t.state.stopScreens.has(4), false);
  text = JSON.stringify(t.ui['stop-note'].children);
  assert.doesNotMatch(text, /USDOT/);
  t.context.scheduleAutoFill('/quote');
  assert.equal(t.timers.length, 1);
  // A question or list GEICO draws while the screen shows doesn't end it (review of #141); a new
  // document does.
  const again = stopStepHarness('Business & Owner Info');
  again.state.stopScreens = new Map([[4, { name: 'USDOT Number', page: '/quote' }]]);
  for (const event of ['new_fields', 'list_shown', 'field_changes', 'step_shown']) {
    again.show('Business & Owner Info', event);
    assert.equal(again.state.stopScreens.has(4), true, event);
  }
  again.context.scheduleAutoFill('/quote');
  assert.equal(again.timers.length, 0);
  again.show('Business & Owner Info', 'page_view');
  assert.equal(again.state.stopScreens.has(4), false);
  // Two GEICO quote tabs (review of #141): the screen is the tab's that shows it. Tab 7 shows it,
  // tab 4 is filled: tab 4's fills and follow-ups go on, tab 7's are refused.
  const two = stopStepHarness('Business & Owner Info');
  two.state.stopScreens = new Map([[7, { name: 'USDOT Number', page: '/quote' }]]);
  assert.equal(two.context.stopNoteFor(geico, '/quote'), null);
  assert.match(two.context.stopNoteFor(geico, '/quote', undefined, 7), /Add USDOT Number or Skip is yours/);
  two.context.scheduleAutoFill('/quote', { tabId: 7, intake: two.state.intake, revision: two.state.intakeRevision });
  assert.equal(two.timers.length, 0, 'tab 7: refused');
  two.context.scheduleAutoFill('/quote');
  assert.equal(two.timers.length, 1, 'tab 4: scheduled');
  assert.equal(two.context.aiActionCurrent({ intake: two.state.intake, tabId: 4, tabUrl: two.state.tab.url, page: '/quote' }, []), true);
});

// The site strip and Fill button as renderSite draws them, for a tab on `step`.
function siteHarness(carrier, step) {
  const el = () => ({ hidden: false, textContent: '', disabled: false, className: '', title: '', alt: '', children: [], isConnected: true,
    classList: { toggle() {} }, replaceChildren(...c) { this.children = c; }, getAttribute: () => null, removeAttribute() {}, cloneNode: () => el(), replaceWith() {} });
  const ui = {};
  const state = { tab: { id: 4, url: 'https://sales.geico.com/quote', carrier }, intake: { record: {} }, filling: false, reports: new Map(), autoPages: new Set(), tabSteps: new Map(step ? [[4, step]] : []) };
  const context = { state, URL, inExtension: true, $: (id) => (ui[id] ??= el()), h: (tag, props) => ({ tag, props }), quoteProgress,
    reportShown: () => false, currentReportKey: () => '4|/quote', showCarrierNote() {}, showStopPage() {}, showStateNote() {}, showReviewMode() {}, renderSteps() {}, renderWarnings() {} };
  vm.runInNewContext(`${PAGE_HELPERS}\n${extractFunction('renderSite')}`, context);
  context.renderSite();
  return ui;
}

test('on a stop step the panel offers no fill; on the other steps it names the step', () => {
  // The dock: on a stop step no button at all, and why; elsewhere Fill, named after the step.
  const dock = (step) => dockHarness({ carrier: geico, url: 'https://sales.geico.com/quote', step, switches: { 'auto-advance': { checked: false } }, extra: { quoteProgress } }).dock();
  const stoppedDock = dock('MVR & CLUE');
  assert.deepEqual([stoppedDock.phase, stoppedDock.button, stoppedDock.alt], ['yours', undefined, undefined]);
  assert.deepEqual([stoppedDock.title, stoppedDock.sub], ['Finish MVR & CLUE yourself', 'Nothing on this step is filled or clicked.']);
  const stopped = siteHarness(geico, 'MVR & CLUE');
  assert.deepEqual([stopped['site-step'].textContent, stopped['site-count'].textContent], ['MVR & CLUE page', 'Step 8 of 9']);
  const vehiclesDock = dock('Vehicles');
  assert.deepEqual([vehiclesDock.phase, vehiclesDock.button, vehiclesDock.label, vehiclesDock.title], ['ready', 'fill', 'Fill this page', 'Fill the Vehicles page']);
  assert.equal(vehiclesDock.sub, 'Nothing is submitted. Review, then click Next yourself.');
  const vehicles = siteHarness(geico, 'Vehicles');
  assert.deepEqual([vehicles['site-step'].textContent, vehicles['site-count'].textContent], ['Vehicles page', 'Step 3 of 9']);
  // A step not read yet: no stop in the panel (the kit still reads the page), no place in the strip.
  const unreadDock = dock(null);
  assert.deepEqual([unreadDock.phase, unreadDock.button], ['ready', 'fill']);
  const unread = siteHarness(geico, null);
  assert.equal(unread['site-step'].hidden, true);
});

// TNI, 2026-10-26, W44-27: the intake's current insurance is with the carrier the tab is on (GEICO or
// Progressive, spelling variants included, util.js sameCarrier): a red card at the top of the page's
// cards from arrival, before any fill, while the tab is on that carrier. It is no stop: nothing that
// fills, clicks or asks the AI reads it.
test('a red card says the client\'s current insurance is with the carrier the tab is on, and stops nothing', async () => {
  const { sameCarrier, noPriorInsurance, quotedCarrierPolicy } = await import('../src/util.js');
  const node = (tag, props = {}, ...children) => ({ tag, props, children: children.flat() });
  const box = { hidden: true, children: [], replaceChildren(...next) { this.children = next; } };
  const state = { tab: { id: 4, url: 'https://sales.geico.com/quote', carrier: geico }, intake: null };
  const context = { state, h: node, $: (id) => (id === 'carrier-note' ? box : null), sameCarrier, noPriorInsurance, quotedCarrierPolicy };
  vm.runInNewContext(extractFunction('showCarrierNote'), context);
  // `prior`: the intake's current-insurance row; null: a blank section; undefined: no intake.
  const show = (carrier, prior) => {
    state.tab = carrier ? { id: 4, url: 'https://example.test/quote', carrier } : null;
    state.intake = prior === undefined ? null : { record: { priorInsurance: prior ? [prior] : [] } };
    context.showCarrierNote();
    return box.hidden ? null : JSON.stringify(box.children);
  };
  const policy = (carrier, more = {}) => ({ type: 'Commercial Auto', carrier, limit: '$1M CSL', expiration: '12/31/2026', ...more });
  for (const name of ['GEICO', 'Gieco', 'GICO', 'Geico Commercial']) {
    const card = show(geico, policy(name));
    assert.ok(card, name);
    assert.match(card, /The client's current insurance is with GEICO/);
    assert.match(card, /GEICO may decline or route this quote\. Check with the client before going on\./);
    assert.match(card, /"role":"alert"/);
    assert.match(card, /"class":"issue"/, 'red: a card with no tone');
    assert.match(card, /Filling goes on as usual/, 'it says it is no stop');
  }
  assert.match(show(progressive, policy('Progresive')), /The client's current insurance is with Progressive/);
  assert.match(show(progressive, policy('Progressive Commercial')), /Progressive may decline or route this quote/);
  // None: the tab on another carrier, another insurer with a similar name, no prior insurance, a
  // blank section, no intake, no carrier page, and AmWINS (a wholesaler, never the current carrier).
  assert.equal(show(progressive, policy('GEICO')), null);
  assert.equal(show(geico, policy('Progressive')), null);
  assert.equal(show(geico, policy('Gainsco')), null);
  assert.equal(show(progressive, policy('Protective')), null);
  assert.equal(show(geico, { type: null, carrier: 'No GEICO', limit: null, expiration: null }), null, 'no prior insurance');
  assert.equal(show(geico, null), null, 'a blank current-insurance section');
  assert.equal(show(geico, undefined), null, 'no intake');
  assert.equal(show(null, policy('GEICO')), null, 'not a rater page');
  assert.equal(show(amwins, policy('AmWINS')), null, 'a wholesaler');
  // TNI, 2026-10-26 (answer to PR question 18): only a commercial auto policy with the carrier. A
  // personal auto, GL-only, cargo or other policy with GEICO says nothing; one of no type is said
  // (only a warning), and so is an expired or undated one, as before.
  for (const type of ['Personal Auto', 'General Liability', 'Cargo', 'Other']) assert.equal(show(geico, policy('GEICO', { type })), null, type);
  assert.equal(show(progressive, policy('Progressive', { type: 'Personal Auto' })), null, 'Progressive personal auto');
  for (const more of [{ type: null }, { expiration: '01/31/2026' }, { expiration: null }]) assert.ok(show(geico, policy('GEICO', more)), JSON.stringify(more));
  // Shown on arrival with the other cards (renderSite runs as the tab reaches a carrier page and as
  // the intake loads or changes), first among them.
  assert.match(extractFunction('renderSite').split('\nfunction ')[0], /showCarrierNote\(\);[\s\S]{0,400}?renderWarnings\(\); \}\s*showStopPage\(\);/);
  const html = fs.readFileSync(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="issues" class="issues">\s*<div id="carrier-note" hidden><\/div>/);
  // No stop: the fill, follow-ups, the dock, the stop checks and the AI never read it, and
  // Progressive's DeclinationNotice stays its stop page.
  for (const fn of ['fillPage', 'scheduleAutoFill', 'dockFor', 'stopNoteFor', 'showStopPage', 'aiActionCurrent', 'stateIssue']) {
    assert.doesNotMatch(extractFunction(fn), /showCarrierNote|carrier-note|sameCarrier|quotedCarrierPolicy|carrier-is-quoted|\.alert\b/, fn);
  }
  assert.ok(progressive.stopPages?.DeclinationNotice, 'Progressive\'s stop page stays');
});

test('a one-address step about one vehicle or driver is scoped like Progressive\'s vehicle and driver pages', () => {
  const state = { tab: { id: 1, carrier: geico }, active: { vehicles: 1, drivers: 2, trailers: 0 }, tabSteps: new Map([[1, 'Vehicles']]), viewTabs: new Map([[1, 1]]) };
  const context = { state };
  vm.runInNewContext(['reportKey', 'editScope', 'viewOf'].map(extractFunction).join('\n'), context);
  assert.equal(context.reportKey(1, '/quote', geico, { vehicles: 1 }, 'Vehicles'), '1|/quote|v1|Vehicles');
  assert.equal(context.reportKey(1, '/quote', geico, { drivers: 2 }, 'Drivers & Incidents'), '1|/quote|d2|Drivers & Incidents');
  assert.equal(context.reportKey(1, '/quote', geico, { vehicles: 1 }, 'Quote & Coverages'), '1|/quote||Quote & Coverages', 'other steps are quote-wide');
  // With no step given: the tab's, and the vehicle the panel's picker is on.
  assert.equal(context.reportKey(1, '/quote', geico), '1|/quote|v1|Vehicles');
  assert.equal(context.viewOf(1, '/quote', geico), 't1:v1');
  assert.equal(context.editScope('/quote', geico), '/quote|v1');
  // The step the page named wins over the tab's, which can lag it by a message.
  state.tabSteps.set(1, 'Business & Owner Info');
  assert.equal(context.editScope('/quote', geico), '/quote|s:Business & Owner Info');
  assert.equal(context.editScope('/quote', geico, 'Vehicles'), '/quote|v1');
  assert.equal(context.editScope('/quote', geico, 'Drivers & Incidents'), '/quote|d2');
  assert.equal(context.reportKey(1, '/quote', geico, state.active, 'Vehicles'), '1|/quote|v1|Vehicles');
  // Another tab's report is never scoped by the step of the tab in front.
  assert.equal(context.reportKey(2, '/quote', geico), '2|/quote||');
  // AmWINS (no unit steps) and Progressive (page names) as before.
  assert.equal(context.reportKey(1, '/application/businessauto', amwins, { vehicles: 1 }, 'Vehicles'), '1|/application/businessauto||Vehicles');
  const progressive = { vehiclePages: ['AddVehicle'], driverPage: 'AddDriver' };
  assert.equal(context.reportKey(1, 'AddVehicle', progressive, { vehicles: 1 }), '1|AddVehicle|v1|');
  assert.equal(context.reportKey(1, 'Rates', progressive, { vehicles: 1 }), '1|Rates||');
  assert.equal(context.viewOf(1, 'AddDriver', progressive), 't1:d2');
});

// GEICO asks one field name on several steps and forms at one address (the owner's and each
// driver's name, the business's and each vehicle's ZIP, a vehicle's and a trailer's year): an
// owner's name corrected on Business & Owner Info left every driver's name unfilled, a vehicle
// edit the trailer form's answers (review 2026-10-20). An edit is kept to its step and form.
test('an agent edit on GEICO is scoped by its step, and on a unit step by its form; other carriers as before', () => {
  const state = { tab: { id: 1, carrier: geico }, active: { vehicles: 1, drivers: 2, trailers: 0 }, tabSteps: new Map([[1, 'Business & Owner Info']]), unitShown: null };
  const context = { state };
  vm.runInNewContext(extractFunction('editScope'), context);
  const scope = (step, shown = null) => { state.unitShown = shown; return context.editScope('/quote', geico, step); };
  assert.equal(scope('Business & Owner Info'), '/quote|s:Business & Owner Info', 'a step about no unit');
  assert.equal(scope('Quote & Coverages'), '/quote|s:Quote & Coverages');
  // No unit form seen on the step yet: the picker's unit, as before.
  assert.equal(scope('Vehicles'), '/quote|v1');
  assert.equal(scope('Drivers & Incidents'), '/quote|d2');
  // The form the tab's latest fill ended on there: its unit, or the form itself while held.
  assert.equal(scope('Vehicles', { step: 'Vehicles', list: 'vehicles', id: 'Id_V', held: false }), '/quote|v1');
  assert.equal(scope('Vehicles', { step: 'Vehicles', list: 'trailers', id: 'Id_T', held: false }), '/quote|tr0', 'the trailer form is the trailer\'s');
  assert.equal(scope('Vehicles', { step: 'Vehicles', list: 'vehicles', id: 'Id_H', held: true }), '/quote|f:Id_H', 'a held form is its own');
  assert.equal(scope('Drivers & Incidents', { step: 'Drivers & Incidents', list: 'drivers', id: 'Id_D', held: true }), '/quote|f:Id_D');
  // A form seen on another step says nothing about this one.
  assert.equal(scope('Drivers & Incidents', { step: 'Vehicles', list: 'vehicles', id: 'Id_H', held: true }), '/quote|d2');
  assert.equal(scope('Business & Owner Info', { step: 'Vehicles', list: 'vehicles', id: 'Id_H', held: true }), '/quote|s:Business & Owner Info');
  // A step not known: the page. None given: the tab's.
  assert.equal(scope(null), '/quote');
  assert.equal(scope(undefined), '/quote|s:Business & Owner Info');
  state.tabSteps.delete(1);
  assert.equal(scope(undefined), '/quote');
  // Another tab's units and form (rememberFill), not the tab in front's.
  state.unitShown = { step: 'Vehicles', list: 'vehicles', id: 'Id_H', held: true };
  assert.equal(context.editScope('/quote', geico, 'Vehicles', { active: { vehicles: 0 }, shown: { step: 'Vehicles', list: 'vehicles', id: 'Id_V', held: false } }), '/quote|v0');
  assert.equal(context.editScope('/quote', geico, 'Vehicles', { active: { vehicles: 0 }, shown: null }), '/quote|v0');
  // Progressive and AmWINS as before, whatever the tab's shown form.
  state.tabSteps.set(1, 'Vehicles');
  const progressive = { vehiclePages: ['AddVehicle'], trailerPages: ['AddTrailer'], driverPage: 'AddDriver' };
  assert.deepEqual(['AddVehicle', 'AddTrailer', 'AddDriver', 'Rates'].map((p) => context.editScope(p, progressive)), ['AddVehicle|v1', 'AddTrailer|tr0', 'AddDriver|d2', 'Rates']);
  assert.deepEqual(['Vehicles', 'Drivers', null, undefined].map((s) => context.editScope('/application/businessauto', amwins, s)), Array(4).fill('/application/businessauto'));
});

test('a GEICO fill always leaves the page\'s own edits alone, and the kit gets the rest by step, unit and form', () => {
  const context = { state: { active: { vehicles: 0, drivers: 0, trailers: 0 } } };
  vm.runInNewContext(`${extractFunction('fillSkip')}\n${extractFunction('fillSkipBy')}`, context);
  const keys = new Map([
    ['/quote', new Set(['ref:GiveNote'])],
    ['/quote|s:Business & Owner Info', new Set(['ref:GiveLastName', 'ref:GiveZip'])],
    ['/quote|v1', new Set(['ref:GiveYear'])], ['/quote|v0', new Set(['ref:GiveVin'])], ['/quote|tr0', new Set(['ref:GiveOtherVehicleType'])],
    ['/quote|d1', new Set(['ref:GiveFirstName'])], ['/quote|f:Id_H', new Set(['ref:GiveCostNew'])],
    ['/other', new Set(['a'])], ['/other|s:Vehicles', new Set(['b'])], ['/other|f:Id_X', new Set(['c'])],
  ]);
  assert.deepEqual([...context.fillSkip(keys, '/quote|v1', '/quote', geico)], ['ref:GiveNote'], 'only the edits made where no step was read');
  assert.deepEqual(JSON.parse(JSON.stringify(context.fillSkipBy(keys, '/quote', geico, { vehicles: 1, drivers: 1, trailers: 0 }))), {
    steps: { 'Business & Owner Info': ['ref:GiveLastName', 'ref:GiveZip'] },
    units: { vehicles: ['ref:GiveYear'], trailers: ['ref:GiveOtherVehicleType'], drivers: ['ref:GiveFirstName'] },
    forms: { Id_H: ['ref:GiveCostNew'] },
    stepUnits: { Vehicles: 'vehicles', 'Drivers & Incidents': 'drivers' },
  });
  assert.deepEqual([...context.fillSkipBy(keys, '/quote', geico).units.vehicles], ['ref:GiveVin'], 'the picker\'s units when none are given');
  assert.deepEqual(JSON.parse(JSON.stringify(context.fillSkipBy(new Map(), '/quote', geico))), {
    steps: {}, units: { vehicles: [], trailers: [], drivers: [] }, forms: {}, stepUnits: { Vehicles: 'vehicles', 'Drivers & Incidents': 'drivers' } });
  // Other carriers: the fill's own scope, as before, and nothing by step.
  const progressive = { id: 'progressive', vehiclePages: ['AddVehicle'] };
  const prog = new Map([['AddVehicle|v1', new Set(['a'])], ['AddVehicle', new Set(['b'])]]);
  assert.deepEqual([...context.fillSkip(prog, 'AddVehicle|v1', 'AddVehicle', progressive)], ['a']);
  assert.deepEqual([...context.fillSkip(prog, 'AddVehicle|v0', 'AddVehicle', progressive)], []);
  assert.equal(context.fillSkipBy(prog, 'AddVehicle', progressive), null);
  const amw = new Map([['/application/businessauto', new Set(['c'])]]);
  assert.deepEqual([...context.fillSkip(amw, '/application/businessauto', '/application/businessauto', amwins)], ['c']);
  assert.equal(context.fillSkipBy(amw, '/application/businessauto', amwins), null);
});

test('both fills hand GEICO\'s kit its skip and skipBy for the plan\'s units; other carriers no skipBy', async () => {
  for (const [carrier, which] of [[geico, 'fillPage'], [geico, 'autoFill'], [undefined, 'fillPage'], [undefined, 'autoFill']]) {
    const t = fillHarness(carrier ? { carrier } : {});
    t.context.fillOptions = (c, extra) => extra;
    t.state.agentKeys = new Map([['/quote-A', new Set(['ref:GiveNote'])], ['/quote-A|s:Business & Owner Info', new Set(['ref:GiveLastName'])], ['/quote-A|v1', new Set(['ref:GiveYear'])]]);
    t.state.active = { drivers: 0, vehicles: 1, trailers: 0 };
    const run = which === 'fillPage' ? t.context.fillPage() : t.context.autoFill('/quote-A');
    await t.started;
    assert.deepEqual([...t.seen.options.skip], ['ref:GiveNote'], `${which}: the page's own`);
    if (carrier) {
      assert.deepEqual(JSON.parse(JSON.stringify(t.seen.options.skipBy)).steps, { 'Business & Owner Info': ['ref:GiveLastName'] });
      assert.deepEqual([...t.seen.options.skipBy.units.vehicles], ['ref:GiveYear'], `${which}: the plan's vehicle`);
    } else assert.equal('skipBy' in t.seen.options, false, `${which}: AmWINS' options as before`);
    t.release(t.results);
    await run;
  }
});

test('a continued GEICO step is remembered per vehicle by the step the kit read, not the tab\'s', () => {
  const state = { active: { vehicles: 0, drivers: 0 }, doneSteps: new Set(), autoPaused: false, tab: { id: 1, carrier: geico }, tabSteps: new Map([[1, 'Business & Owner Info']]) };
  const context = { state, knownStep, $: () => ({ checked: false }), scheduleAutoFill: () => {}, setTimeout: () => {}, watchNextStep: () => {}, persistDoneActions: () => {} };
  vm.runInNewContext(['stepScope', 'afterFill'].map(extractFunction).join('\n'), context);
  context.afterFill([{ advanced: 'Next', signatureBefore: 'before', stepKey: 'Vehicles' }], { carrier: geico, page: '/quote' });
  context.afterFill([{ advanced: 'Next', signatureBefore: 'before', stepKey: 'Business Class & USDOT' }], { carrier: geico, page: '/quote' });
  assert.deepEqual([...state.doneSteps], ['/quote|v0|Vehicles', '/quote||Business Class & USDOT']);
});

// FL live run 3, 2026-10-21: with "Click Continue when its done" on, GEICO's Next should be clicked.
// A step with forms and lists is continued per form and button (the kit's advanceKey): Vehicles is
// left by each unit's Next, then Looks Good.
test('a GEICO Continue is remembered per form and button, by the key the kit gave', () => {
  const state = { active: { vehicles: 1, drivers: 0 }, doneSteps: new Set(), autoPaused: false, tab: { id: 1, carrier: geico }, tabSteps: new Map([[1, 'Vehicles']]) };
  const context = { state, knownStep, $: () => ({ checked: false }), scheduleAutoFill: () => {}, setTimeout: () => {}, watchNextStep: () => {}, persistDoneActions: () => {} };
  vm.runInNewContext(['stepScope', 'afterFill'].map(extractFunction).join('\n'), context);
  context.afterFill([{ advanced: 'Next', signatureBefore: 'before', stepKey: 'Vehicles', advanceKey: 'Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_63452' }], { carrier: geico, page: '/quote', active: state.active });
  context.afterFill([{ advanced: 'Looks Good', signatureBefore: 'before', stepKey: 'Vehicles', advanceKey: 'Vehicles@looks good' }], { carrier: geico, page: '/quote', active: state.active });
  assert.deepEqual([...state.doneSteps], ['/quote|v1|Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_63452', '/quote|v1|Vehicles@looks good']);
  // They reach the kit as they were given, by their own step and the plan's vehicle.
  const base = { agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(), intake: { record: {} }, tab: { id: 1, url: 'https://sales.geico.com/quote', carrier: geico } };
  const done = (active) => [...fillOptionsOf({ ...state, ...base, active }, geico, active).doneSteps];
  assert.deepEqual(done({ vehicles: 1, drivers: 0, trailers: 0 }), ['Vehicles@next@Id_YesNoPreQuoteHaveFullVinActivity_63452', 'Vehicles@looks good']);
  assert.deepEqual(done({ vehicles: 2, drivers: 0, trailers: 0 }), []);
});

test('GEICO\'s Continue reaches the kit with the switch on: Looks Good only once every intake unit is on the list', () => {
  const state = { tab: { id: 1, url: 'https://sales.geico.com/quote', carrier: geico }, active: { vehicles: 0, drivers: 0, trailers: 0 }, agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(), doneSteps: new Set(), tabSteps: new Map(), intake: { record: {} } };
  const { listed, ...rest } = geico.advance;
  assert.equal(fillOptionsOf(state, geico, undefined, { autoAdvance: false }).advance, null);
  assert.deepEqual(JSON.parse(JSON.stringify(fillOptionsOf(state, geico, undefined, { autoAdvance: true }).advance)), rest);
  assert.equal(fillOptionsOf(state, geico, undefined, { autoAdvance: true, unitsListed: true }).advance.text, `(?:${rest.text})|(?:${listed})`);
  // Another carrier's, as it is.
  assert.equal(fillOptionsOf(state, amwins, undefined, { autoAdvance: true, unitsListed: true }).advance, amwins.advance);
});

// FL live run 3, 2026-10-21: the agent's Next on vehicle 1's form drew the list, which has no
// question, and nothing ran until the agent clicked "+" ("you should click + and add the vehicle").
test('on a GEICO unit list step, a form that went away gets a follow-up fill with the switch on', () => {
  const { context } = layoutHarness(() => []);
  const followUps = [];
  let on = true;
  Object.assign(context, { samePage: (p) => p, knownStep, pageOf: (url) => new URL(url).pathname, $: (id) => ({ checked: id === 'auto-advance' ? on : true }),
    scheduleAutoFill: (page) => followUps.push(page) });
  Object.assign(context.state.tab, { carrier: geico, url: 'https://sales.geico.com/quote' });
  context.state.tabSteps = new Map([[context.state.tab.id, 'Vehicles']]);
  vm.runInContext(['tabStep', 'onRecorderMessage'].map(extractFunction).join('\n'), context);
  const removed = () => context.onRecorderMessage({ ra: 'usage', event: 'removed_fields', page: '/quote', keys: ['ref:GiveYear'] }, { tab: { id: context.state.tab.id } });
  removed();
  context.state.tabSteps.set(context.state.tab.id, 'Drivers & Incidents');
  removed();
  assert.deepEqual(followUps, ['/quote', '/quote']);
  // Another step, the switch off, or a carrier without unit lists: only the layout, as before.
  context.state.tabSteps.set(context.state.tab.id, 'Additional Business Info');
  removed();
  context.state.tabSteps.set(context.state.tab.id, 'Vehicles');
  on = false;
  removed();
  on = true;
  context.state.tab.carrier = { ...amwins };
  removed();
  assert.equal(followUps.length, 2);
});

// FL live run 6, 2026-10-21: GEICO drew the vehicle list 5–7 s after the agent's Next on a vehicle
// form, after the follow-up for the form that went away had run, and nothing ran on the list. The
// recorder says when a unit list is drawn (list_shown), by the step it read with it.
test('a GEICO unit list drawn gets a follow-up fill with either switch on', () => {
  const { context } = layoutHarness(() => []);
  const followUps = [];
  const on = { 'auto-advance': false, 'auto-pages': true };
  Object.assign(context, { samePage: (p) => p, knownStep, pageOf: (url) => new URL(url).pathname, $: (id) => ({ checked: on[id] ?? true }),
    scheduleAutoFill: (page) => followUps.push(page) });
  Object.assign(context.state.tab, { carrier: geico, url: 'https://sales.geico.com/quote' });
  context.state.tabSteps = new Map([[context.state.tab.id, 'Additional Business Info']]);
  vm.runInContext(['tabStep', 'onRecorderMessage'].map(extractFunction).join('\n'), context);
  const drawn = (step) => context.onRecorderMessage({ ra: 'usage', event: 'list_shown', page: '/quote', step }, { tab: { id: context.state.tab.id } });
  // The step it came with counts, though the panel's word on the tab's step lags.
  drawn('Vehicles');
  on['auto-pages'] = false;
  on['auto-advance'] = true;
  drawn('Drivers & Incidents');
  assert.deepEqual(followUps, ['/quote', '/quote']);
  // Both off (the agent's Fill this page adds it then), a step without a list, or a carrier without
  // unit lists: nothing.
  on['auto-advance'] = false;
  drawn('Vehicles');
  on['auto-advance'] = true;
  drawn('Quote & Coverages');
  context.state.tab.carrier = { ...amwins };
  drawn('Vehicles');
  assert.equal(followUps.length, 2);
});

// The fill options as the panel builds them: the declaration itself, with its scope helpers.
function fillOptionsOf(state, carrier, active, { autoAdvance = false, unitsListed = false } = {}) {
  const start = SIDEPANEL.indexOf('const fillOptions =');
  const context = { state, URL, knownStep, advanceFor, $: () => ({ checked: false }), pageOf: (url) => new URL(url).pathname, pendingAi: () => [] };
  vm.runInNewContext(`${extractFunction('editScope')}\n${SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start) + 4)}\n${extractFunction('unitNameFor')}\nglobalThis.fillOptions = fillOptions;`, context);
  return context.fillOptions(carrier, {}, autoAdvance, active, unitsListed);
}

// The panel's word on the tab's step lags the page by a message (the recorder's step comes after
// the questions), and GEICO's Vehicles is continued once per vehicle.
test('steps already continued reach the kit by their own step: per vehicle on GEICO, as before elsewhere', () => {
  const base = { active: { vehicles: 0, drivers: 0, trailers: 0 }, agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(), intake: { record: {} } };
  const quote = { ...base, tab: { id: 1, url: 'https://sales.geico.com/quote', carrier: geico }, tabSteps: new Map([[1, 'Business & Owner Info']]),
    doneSteps: new Set(['/quote||Business Class & USDOT', '/quote|v0|Vehicles', '/quote|d0|Drivers & Incidents', '/other|v0|Vehicles']) };
  const done = (state, carrier, active) => [...fillOptionsOf(state, carrier, active).doneSteps];
  // The tab still said Business & Owner Info as the fill on Vehicles began.
  assert.deepEqual(done(quote, geico), ['Business Class & USDOT', 'Vehicles', 'Drivers & Incidents']);
  assert.deepEqual(done(quote, geico, { vehicles: 1, drivers: 0, trailers: 0 }), ['Business Class & USDOT', 'Drivers & Incidents'], 'the next vehicle\'s Vehicles is a new step');
  assert.deepEqual(done(quote, geico, { vehicles: 0, drivers: 1, trailers: 0 }), ['Business Class & USDOT', 'Vehicles'], 'and the next driver\'s Drivers & Incidents');
  quote.tabSteps.set(1, 'Vehicles');
  quote.active = { vehicles: 1, drivers: 0, trailers: 0 };
  assert.deepEqual(done(quote, geico, { vehicles: 0, drivers: 0, trailers: 0 }), ['Business Class & USDOT', 'Vehicles', 'Drivers & Incidents'], 'the plan\'s vehicle, not the picker\'s');
  // AmWINS: its raw headings (not always step names) pass as before, whatever the tab's step and row.
  const amw = { ...base, tab: { id: 1, url: 'https://x.test/application/businessauto', carrier: amwins }, tabSteps: new Map([[1, 'Vehicles']]),
    doneSteps: new Set(['/application/businessauto||Draft Application Saved! / Vehicles', '/application/businessauto||Drivers', '/other||Drivers']) };
  assert.deepEqual(done(amw, amwins, { vehicles: 1, drivers: 1, trailers: 0 }), ['Draft Application Saved! / Vehicles', 'Drivers']);
  // Progressive: per vehicle on its vehicle pages, by the page alone.
  const progressive = { id: 'progressive', vehiclePages: ['/AddVehicle'] };
  const prog = { ...base, tab: { id: 1, url: 'https://x.test/AddVehicle', carrier: progressive }, tabSteps: new Map(),
    doneSteps: new Set(['/AddVehicle|v0|Vehicle Information', '/AddVehicle|v1|Vehicle Information / Common Questions', '/Rates||Rates']) };
  assert.deepEqual(done(prog, progressive, { vehicles: 1 }), ['Vehicle Information / Common Questions']);
});

test('the kit is told the stop steps by name, and the plan\'s units with the forms they were filled on', () => {
  const state = { tab: { id: 1, url: 'https://sales.geico.com/quote', carrier: geico }, active: { vehicles: 0, drivers: 0, trailers: 0 }, agentKeys: new Map(), doneActions: new Set(), visitedPages: new Set(), doneSteps: new Set(), tabSteps: new Map(),
    intake: { record: { vehicles: [{}, {}], drivers: [{}, {}], trailers: [{}] } }, unitForms: { vehicles: { Id_Marker_101: 0 }, drivers: {}, trailers: {} } };
  const options = fillOptionsOf(state, geico, { vehicles: 1, drivers: 1, trailers: 0 });
  assert.deepEqual([...options.stopSteps], ['Final Quote Details', 'MVR & CLUE', 'Payment Information']);
  assert.deepEqual(JSON.parse(JSON.stringify(options.units)), {
    active: { vehicles: 1, drivers: 1, trailers: 0 }, count: { vehicles: 2, drivers: 2, trailers: 1 }, bound: { vehicles: { Id_Marker_101: 0 }, drivers: {}, trailers: {} } });
  options.units.bound.vehicles.Id_Marker_202 = 1;
  assert.deepEqual(Object.keys(state.unitForms.vehicles), ['Id_Marker_101'], 'a copy: nothing the kit does writes the panel\'s record');
  // Other carriers: no stop steps, nothing bound, the plan's units all the same.
  const plain = fillOptionsOf({ ...state, unitForms: undefined, intake: { record: {} } }, { id: 'progressive' });
  assert.deepEqual(JSON.parse(JSON.stringify([plain.stopSteps, plain.units])), [[], {
    active: { vehicles: 0, drivers: 0, trailers: 0 }, count: { vehicles: 0, drivers: 0, trailers: 0 }, bound: { vehicles: {}, drivers: {}, trailers: {} } }]);
  // Both fills hand over the units their plan was built for.
  // and whether the unit list on screen holds every intake unit (GEICO's Looks Good: advanceFor).
  assert.equal((SIDEPANEL.match(/ctx\.settings\.autoAdvance, ctx\.active, ctx\.unitsListed\);/g) ?? []).length, 2);
  const start = SIDEPANEL.indexOf('const fillOptions =');
  assert.match(SIDEPANEL.slice(start, SIDEPANEL.indexOf('\n});', start)), /stopSteps: Object\.keys\(carrier\.stopSteps \?\? \{\}\)/);
});

// Survey 2026-10-20: once a vehicle is saved, GEICO draws the next vehicle's form at the same
// address, and the automatic follow-up fill would type the saved vehicle's VIN and year into it.
// The form a fill answered is bound to the unit its plan was for; the agent's pick lets it go.
test('the unit form a fill answered is bound to the unit its plan was for, on the fill\'s own tab', async () => {
  const h = harness();
  const persisted = [];
  h.context.persistUnitForms = (tabId, forms) => persisted.push([tabId, JSON.parse(JSON.stringify(forms))]);
  h.state.tab = { id: 7, url: 'https://sales.geico.com/quote', carrier: geico };
  h.state.unitForms = { vehicles: {}, drivers: {}, trailers: {} };
  const fill = (frames, active, tabId = 7) => h.rememberFill(frames, { tabId, carrier: geico, page: '/quote', scope: '/quote', active });
  fill([{ filled: [], unitForm: { list: 'vehicles', id: 'Id_YesNoPreQuoteHaveFullVinActivity_85493' } }], { vehicles: 0, drivers: 0, trailers: 0 });
  // The next form, filled once the agent picked vehicle 2, and an Add Driver form.
  fill([{ filled: [], unitForm: { list: 'vehicles', id: 'Id_YesNoPreQuoteHaveFullVinActivity_37768' } }, { filled: [], unitForm: { list: 'drivers', id: 'Id_GiveDriverRelationshipToBusiness_83448' } }], { vehicles: 1, drivers: 1, trailers: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.unitForms)), {
    vehicles: { Id_YesNoPreQuoteHaveFullVinActivity_85493: 0, Id_YesNoPreQuoteHaveFullVinActivity_37768: 1 }, drivers: { Id_GiveDriverRelationshipToBusiness_83448: 1 }, trailers: {} });
  assert.deepEqual(persisted.map(([id]) => id), [7, 7], 'kept for a panel reload');
  // A fill without a unit form, or with one the kit named oddly, binds nothing.
  fill([{ filled: [] }, { filled: [], unitForm: { list: 'pets', id: 'x' } }, { filled: [], unitForm: { list: 'vehicles', id: '' } }], { vehicles: 0 });
  assert.equal(persisted.length, 2);
  // A fill finishing while another tab is in front binds on its own tab.
  h.state.tab = { id: 8, url: 'https://sales.geico.com/quote', carrier: geico };
  fill([{ filled: [], unitForm: { list: 'trailers', id: 'Id_GiveOtherVehicleType_55555' } }], { vehicles: 0, drivers: 0, trailers: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.tabSessions.get(7).unitForms.trailers)), { Id_GiveOtherVehicleType_55555: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.unitForms.trailers)), {});
  // Each quote tab keeps its own forms when the agent switches tabs.
  const geicoTab = (id) => ({ id, url: 'https://sales.geico.com/quote' });
  h.context.carrierForUrl = () => geico;
  h.state.tab = { ...geicoTab(1), carrier: geico };
  h.state.unitForms = { vehicles: { Id_Marker_1: 0 }, drivers: {}, trailers: {} };
  h.setActiveTab(geicoTab(2));
  await h.refreshTab();
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.unitForms)), { vehicles: {}, drivers: {}, trailers: {} });
  h.setActiveTab(geicoTab(1));
  await h.refreshTab();
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.unitForms.vehicles)), { Id_Marker_1: 0 });
  // Never in the usage log: a fill's events carry no unit form.
  const frame = { fields: 1, filled: [], unitForm: { list: 'vehicles', id: 'Id_Marker_1' }, unitHeld: { list: 'vehicles', id: 'Id_Marker_2' } };
  assert.doesNotMatch(JSON.stringify(fillEvents([frame], { carrier: 'geico', page: '/quote', redact: (x) => x })), /Id_Marker/);
});

test('a GEICO fill notes the unit form it ended on, and files the agent\'s edits during it by that form', async () => {
  const h = harness();
  h.context.persistUnitForms = () => {};
  h.state.tab = { id: 7, url: 'https://sales.geico.com/quote', carrier: geico };
  h.state.unitForms = { vehicles: {}, drivers: {}, trailers: {} };
  h.state.unitShown = null;
  const active = { vehicles: 1, drivers: 0, trailers: 0 };
  // `scope`: what the fill began with, which GEICO's bookkeeping no longer uses.
  const fill = (frames, tabId = 7) => h.rememberFill(frames.map((f) => ({ filled: [], ...f })), { tabId, carrier: geico, page: '/quote', scope: '/quote|v0', active });
  const edited = (maps = h.state) => Object.fromEntries([...maps.agentKeys].filter(([, k]) => k.size).map(([s, k]) => [s, [...k]]));
  const shown = (maps = h.state) => JSON.parse(JSON.stringify(maps.unitShown));
  fill([{ stepKey: 'Vehicles', unitForm: { list: 'vehicles', id: 'Id_V2' }, protectedKeys: ['ref:GiveYear'] }]);
  assert.deepEqual(shown(), { step: 'Vehicles', list: 'vehicles', id: 'Id_V2', held: false });
  // The trailer form, filled after it.
  fill([{ stepKey: 'Vehicles', unitForm: { list: 'trailers', id: 'Id_T1' }, protectedKeys: ['ref:GiveCostExcludingPermanentlyAttachedEquipment'] }]);
  assert.deepEqual(shown(), { step: 'Vehicles', list: 'trailers', id: 'Id_T1', held: false });
  // A held form wins over a filled one: it is the one the agent looks at.
  fill([{ stepKey: 'Vehicles', unitForm: { list: 'vehicles', id: 'Id_V2' }, unitHeld: { list: 'vehicles', id: 'Id_V3' }, protectedKeys: ['ref:GiveOtherVehicleType'] }]);
  assert.deepEqual(shown(), { step: 'Vehicles', list: 'vehicles', id: 'Id_V3', held: true });
  fill([{ stepKey: 'Vehicles', unitHeld: { list: 'vehicles', id: 'Id_V3' } }, { unitForm: { list: 'vehicles', id: 'Id_V2' } }]);
  assert.equal(shown().id, 'Id_V3', 'in any frame');
  // A step about no unit leaves the form as it was; a step the kit couldn't read too, and its edits
  // go to the page, left alone by every fill.
  fill([{ stepKey: 'Business & Owner Info', protectedKeys: ['ref:GiveLastName'] }]);
  fill([{ stepKey: '', protectedKeys: ['ref:GiveDescription'] }]);
  assert.equal(shown().id, 'Id_V3');
  // A fill on a unit step that read nothing (the page never settled, Stop): the form may still be
  // there, and an edit on it is still its own (verifier D5).
  fill([{ stepKey: 'Vehicles', fields: 0, halted: true, reason: 'The page is still waiting on its server. Review and retry.' }]);
  assert.deepEqual(shown(), { step: 'Vehicles', list: 'vehicles', id: 'Id_V3', held: true });
  // A unit step that shows no form, read (its form closed, the owner's own driver form): noted with
  // no form, and an edit there is the step's, never the picked driver's (verifier round 2, D3).
  fill([{ stepKey: 'Drivers & Incidents', fields: 4, protectedKeys: ['ref:GiveFirstName'] }]);
  assert.deepEqual(shown(), { step: 'Drivers & Incidents', list: null, id: null, held: false });
  assert.deepEqual(edited(), {
    '/quote|v1': ['ref:GiveYear'], '/quote|tr0': ['ref:GiveCostExcludingPermanentlyAttachedEquipment'], '/quote|f:Id_V3': ['ref:GiveOtherVehicleType'],
    '/quote|s:Business & Owner Info': ['ref:GiveLastName'], '/quote': ['ref:GiveDescription'], '/quote|s:Drivers & Incidents': ['ref:GiveFirstName'],
  });
  // A fill finishing while another tab is in front: its own tab's form and keys.
  h.state.unitShown = { step: 'Vehicles', list: 'vehicles', id: 'Id_V3', held: true };
  fill([{ stepKey: 'Vehicles', unitForm: { list: 'vehicles', id: 'Id_V9' }, protectedKeys: ['ref:GiveZip'] }], 8);
  const other = h.state.tabSessions.get(8);
  assert.deepEqual([shown(other), edited(other)], [{ step: 'Vehicles', list: 'vehicles', id: 'Id_V9', held: false }, { '/quote|v1': ['ref:GiveZip'] }]);
  assert.equal(shown().id, 'Id_V3', 'the tab in front keeps its own');
  // A new tab starts with none; the tab's own comes back with it.
  h.context.carrierForUrl = () => geico;
  h.setActiveTab({ id: 9, url: 'https://sales.geico.com/quote' });
  await h.refreshTab();
  assert.equal(h.state.unitShown, null);
  h.setActiveTab({ id: 7, url: 'https://sales.geico.com/quote' });
  await h.refreshTab();
  assert.equal(shown().id, 'Id_V3');
  // Progressive: the scope the fill began with, as before, and no form noted.
  const p = harness();
  p.context.persistUnitForms = () => {};
  p.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  p.rememberFill([{ filled: [], stepKey: 'Vehicles', unitForm: { list: 'vehicles', id: 'Id_V2' }, protectedKeys: ['k'] }], { tabId: 1, carrier: { id: 'progressive', vehiclePages: ['AddVehicle'] }, page: 'AddVehicle', scope: 'AddVehicle|v0', active });
  assert.deepEqual([edited(p.state), p.state.unitShown ?? null], [{ 'AddVehicle|v0': ['k'] }, null]);
});

test('picking a unit in the panel lets go of the forms bound to it, and only those', () => {
  const persisted = [];
  const state = { tab: { id: 7 }, unitForms: { vehicles: { A: 0, B: 1, C: 1 }, drivers: { D: 1 }, trailers: {} } };
  const context = { state, persistUnitForms: (tabId, forms) => persisted.push([tabId, JSON.parse(JSON.stringify(forms))]) };
  vm.runInNewContext(extractFunction('releaseUnitForms'), context);
  context.releaseUnitForms('vehicles', 1);
  assert.deepEqual(JSON.parse(JSON.stringify(state.unitForms)), { vehicles: { A: 0 }, drivers: { D: 1 }, trailers: {} });
  assert.deepEqual(persisted, [[7, { vehicles: { A: 0 }, drivers: { D: 1 }, trailers: {} }]]);
  context.releaseUnitForms('vehicles', 3);
  context.releaseUnitForms('trailers', 0);
  assert.equal(persisted.length, 1, 'nothing let go: nothing written');
  state.unitForms = undefined;
  context.releaseUnitForms('vehicles', 0);
  assert.equal(persisted.length, 1, 'a tab with no unit forms');
  // The form on the page is no exception: picking the next vehicle before saving this one's form
  // must not let the next fill type the next vehicle into it (review 2026-10-20).
  state.unitForms = { vehicles: { A: 0, B: 1 }, drivers: {}, trailers: {} };
  state.unitShown = { step: 'Vehicles', list: 'vehicles', id: 'A', held: false };
  context.releaseUnitForms('vehicles', 1);
  assert.deepEqual(JSON.parse(JSON.stringify(state.unitForms.vehicles)), { A: 0 });
  assert.doesNotMatch(extractFunction('releaseUnitForms'), /unitShown/);
  // The picker does it before the unit changes, before anything waits.
  assert.match(extractFunction('renderPickers'), /releaseUnitForms\(list, i\);\s+state\.active\[list\] = i;\s+await save\(\);/);
});

test('unit forms are kept like helper records: across a panel reload, per intake and tab, gone with Clear or a new browser session', async () => {
  const first = tabRecordsHarness();
  first.state.unitForms = { vehicles: { Id_Marker_101: 0 }, drivers: { Id_Driver_202: 1 }, trailers: {} };
  await first.context.persistUnitForms();
  assert.deepEqual(first.localData['unitForms:A:7'], { vehicles: { Id_Marker_101: 0 }, drivers: { Id_Driver_202: 1 }, trailers: {} });
  // The reloaded panel bound a form since it opened: its own binding stays.
  const reload = tabRecordsHarness(first.localData, first.sessionData, first.locks);
  reload.state.unitForms = { vehicles: { Id_Marker_303: 1 }, drivers: { Id_Driver_202: 0 }, trailers: {} };
  await reload.context.restoreDoneActions(7);
  assert.deepEqual(JSON.parse(JSON.stringify(reload.state.unitForms)), { vehicles: { Id_Marker_303: 1, Id_Marker_101: 0 }, drivers: { Id_Driver_202: 0 }, trailers: {} });
  // Nothing bound: no record. Clear: gone with the intake's other records.
  reload.state.unitForms = { vehicles: {}, drivers: {}, trailers: {} };
  await reload.context.persistUnitForms();
  assert.equal('unitForms:A:7' in first.localData, false);
  reload.state.unitForms = { vehicles: { Id_Marker_404: 0 }, drivers: {}, trailers: {} };
  await reload.context.persistUnitForms();
  await reload.context.clearAgentKeys('A');
  assert.equal('unitForms:A:7' in first.localData, false);
  // Another intake's tab record is its own; a fresh browser session expires every one (tab ids
  // are reused across restarts).
  reload.setIntake('B');
  await reload.context.persistUnitForms();
  assert.ok(first.localData['unitForms:B:7']);
  const restarted = tabRecordsHarness({ ...first.localData, tabRecordsSession: 'earlier-browser' });
  restarted.setIntake('B');
  await restarted.context.restoreDoneActions(7);
  assert.deepEqual(JSON.parse(JSON.stringify(restarted.state.unitForms)), { vehicles: {}, drivers: {}, trailers: {} });
  assert.equal(Object.keys(restarted.localData).some((k) => k.startsWith('unitForms:')), false);
  // A damaged record restores only what it can.
  const odd = tabRecordsHarness({ tabRecordsSession: 'same', 'unitForms:A:7': { vehicles: { Y: 'one', Z: -1, W: 2 }, drivers: 'x' } }, { tabRecordsSession: 'same' });
  await odd.context.restoreDoneActions(7);
  assert.deepEqual(JSON.parse(JSON.stringify(odd.state.unitForms)), { vehicles: { W: 2 }, drivers: {}, trailers: {} });
});

test('an automatic fill that holds a form as maybe another unit\'s shows its report', async () => {
  for (const unitHeld of [null, { list: 'vehicles', id: 'Id_Marker_37768' }]) {
    const t = fillHarness({ carrier: geico });
    t.state.reportFor = { filled: 0 };
    const run = t.context.autoFill('/quote-A');
    await t.started;
    t.release([{ frameId: 0, result: { ...t.results[0].result, stepKey: 'Vehicles', unitHeld } }]);
    await run;
    assert.equal(t.seen.rendered, unitHeld ? 1 : 0, 'the hold\'s item is in the report, not behind the last form\'s');
  }
});

// GEICO's progress bar and title can disagree while a step is drawn: the kit halts and reads nothing
// there (pagekit), and a fill on Vehicles once offered the pay plan and coverage lists to Luna.
test('an automatic GEICO fill that halted on a step it couldn\'t read doesn\'t ask Luna; other halts as before', async () => {
  const UNREAD = 'The step on screen could not be read (the progress bar and the page title disagree): fill again once the page settles.';
  for (const [carrier, stepKey, asked] of [[geico, '', false], [geico, 'Not a step', false], [geico, 'Vehicles', true], [undefined, '', true], [undefined, 'Vehicles / A value', true]]) {
    const t = fillHarness(carrier ? { carrier } : {});
    let assisted = 0;
    t.context.assistAfterFill = () => { assisted++; };
    t.state.reportFor = { filled: 0 };
    const run = t.context.autoFill('/quote-A');
    await t.started;
    t.release([{ frameId: 0, result: { ...t.results[0].result, stepKey, halted: true, reason: UNREAD } }]);
    await run;
    assert.equal(assisted, asked ? 1 : 0, `${carrier?.id ?? 'amwins'} on "${stepKey}"`);
  }
});

test('an agent edit on GEICO is protected per vehicle or driver by the step it came with', () => {
  const state = { intake: { record: {} }, tab: { id: 1, url: 'https://sales.geico.com/quote', carrier: geico }, filled: new Map(), labels: new Map(), choices: new Map(),
    agentKeys: new Map(), visitedPages: new Set(), autoPages: new Set(), layoutReadyTabs: new Set(), layoutNewTabs: new Set(), quoteStates: new Map(),
    active: { vehicles: 1, drivers: 0, trailers: 0 }, tabSteps: new Map([[1, 'Business & Owner Info']]) };
  const context = { state, URL, $: () => ({ checked: false }), usage: { log() {}, currentSession: () => ({ keySalt: 's' }) }, redactor: () => (s) => s, redactionTerms: () => [],
    fieldChangeEvent: (c) => ({ type: 'field_change', key: c.key }), knownStep, viewOf: () => 't1', scheduleLayout() {}, scheduleAutoFill() {}, quoteStatePick: () => undefined,
    persistAgentKeys() {}, settleRejectedAi: async () => false, answeredOnPage() {} };
  vm.runInNewContext(`${PAGE_HELPERS}\n${extractFunction('onRecorderMessage')}`, context);
  const change = (step, key) => context.onRecorderMessage({ ra: 'usage', event: 'field_changes', page: '/quote', step, changes: [{ key, before: '', after: 'x', agent: true }] }, { tab: { id: 1 }, frameId: 0 });
  // The tab still says Business & Owner Info: the change's own step decides.
  change('Vehicles', 'ref:GiveZip');
  change('Business & Owner Info', 'ref:GiveBusinessName');
  change('Drivers & Incidents', 'ref:GiveFirstName');
  assert.deepEqual([...state.agentKeys].map(([scope, keys]) => [scope, [...keys]]), [['/quote|v1', ['ref:GiveZip']], ['/quote|s:Business & Owner Info', ['ref:GiveBusinessName']], ['/quote|d0', ['ref:GiveFirstName']]]);
  // On the trailer form the latest fill ended on: the trailer's. On a form held as maybe another
  // unit's: that form's. A step the recorder couldn't name: the tab's.
  state.agentKeys.clear();
  state.unitShown = { step: 'Vehicles', list: 'trailers', id: 'Id_GiveOtherVehicleType_55555', held: false };
  change('Vehicles', 'ref:GiveYear');
  state.unitShown = { step: 'Vehicles', list: 'vehicles', id: 'Id_YesNoPreQuoteHaveFullVinActivity_37768', held: true };
  change('Vehicles', 'ref:GiveOtherVehicleType');
  change('Somewhere else', 'ref:GiveDescription');
  assert.deepEqual([...state.agentKeys].map(([scope, keys]) => [scope, [...keys]]), [['/quote|tr0', ['ref:GiveYear']], ['/quote|f:Id_YesNoPreQuoteHaveFullVinActivity_37768', ['ref:GiveOtherVehicleType']],
    ['/quote|s:Business & Owner Info', ['ref:GiveDescription']]]);
  // The panel hears the step before the same message is scoped.
  assert.match(extractFunction('wire'), /addListener\(noteStep\);\s+chrome\.runtime\.onMessage\.addListener\(onRecorderMessage\);/);
});

// Verifier, round 2 (D1, D3, D4): an edit on a unit form no fill had read yet (the trailer form just
// opened, a form the kit would hold) was filed under the picker's vehicle, then typed over by the
// next fill; one on GEICO's owner check (identity questions under the Vehicles title, no unit form)
// under vehicle 1. The recorder now says which unit forms are on screen (pagekit unitFormsNow).
test('a GEICO edit on a unit step is filed by the unit forms on screen with it; other carriers as before', () => {
  const state = { tab: { id: 1, carrier: geico }, active: { vehicles: 1, drivers: 2, trailers: 0 }, tabSteps: new Map([[1, 'Vehicles']]),
    unitShown: { step: 'Vehicles', list: 'vehicles', id: 'Id_V1', held: false }, unitForms: { vehicles: { Id_V1: 1 }, drivers: {}, trailers: {} } };
  const context = { state };
  vm.runInNewContext(extractFunction('changeScopes'), context);
  const scopes = (step, forms, carrier = geico, page = '/quote') => [...context.changeScopes(page, carrier, step, forms)];
  // A step about no unit: the step's, whatever is on screen. No step known: the page's; none given: the tab's.
  assert.deepEqual(scopes('Business & Owner Info', [{ list: 'vehicles', id: 'Id_V1' }]), ['/quote|s:Business & Owner Info']);
  assert.deepEqual(scopes('Quote & Coverages', null), ['/quote|s:Quote & Coverages']);
  assert.deepEqual(scopes(null, []), ['/quote']);
  assert.deepEqual(scopes(undefined, []), ['/quote|s:Vehicles']);
  // A unit step with no unit form on screen (the owner check, a list): the step's.
  assert.deepEqual(scopes('Vehicles', []), ['/quote|s:Vehicles']);
  assert.deepEqual(scopes('Drivers & Incidents', []), ['/quote|s:Drivers & Incidents']);
  // The trailer form just opened, while the tab's latest fill ended on the vehicle's: the trailer's.
  assert.deepEqual(scopes('Vehicles', [{ list: 'trailers', id: 'Id_T1' }]), ['/quote|f:Id_T1', '/quote|tr0']);
  // The active vehicle's form: its own and the vehicle's.
  assert.deepEqual(scopes('Vehicles', [{ list: 'vehicles', id: 'Id_V1' }]), ['/quote|f:Id_V1', '/quote|v1']);
  // A form the kit holds (new while the active vehicle was filled on another, or filled for
  // another vehicle): its own only, before any fill has held it.
  assert.deepEqual(scopes('Vehicles', [{ list: 'vehicles', id: 'Id_V2' }]), ['/quote|f:Id_V2']);
  state.unitForms.vehicles = { Id_V0: 0 };
  assert.deepEqual(scopes('Vehicles', [{ list: 'vehicles', id: 'Id_V0' }]), ['/quote|f:Id_V0']);
  // No form filled for the active vehicle yet: a new one is its.
  assert.deepEqual(scopes('Vehicles', [{ list: 'vehicles', id: 'Id_V2' }]), ['/quote|f:Id_V2', '/quote|v1']);
  // Two forms on screen; a driver's form; odd entries skipped.
  assert.deepEqual(scopes('Vehicles', [{ list: 'vehicles', id: 'Id_V2' }, { list: 'trailers', id: 'Id_T1' }, { list: 'vehicles', id: 'Id_V2' }]), ['/quote|f:Id_V2', '/quote|v1', '/quote|f:Id_T1', '/quote|tr0']);
  assert.deepEqual(scopes('Drivers & Incidents', [{ list: 'drivers', id: 'Id_D1' }]), ['/quote|f:Id_D1', '/quote|d2']);
  assert.deepEqual(scopes('Vehicles', [{ list: 'pets', id: 'x' }, { list: 'vehicles', id: '' }, null]), ['/quote|s:Vehicles']);
  // No forms known (no fill in that document named its markers): the tab's latest form, as before.
  assert.deepEqual(scopes('Vehicles', null), ['/quote|v1']);
  assert.deepEqual(scopes('Vehicles', undefined), ['/quote|v1']);
  state.unitShown = { step: 'Vehicles', list: 'vehicles', id: 'Id_H', held: true };
  assert.deepEqual(scopes('Vehicles', null), ['/quote|f:Id_H']);
  // The units and forms given, not the panel's.
  assert.deepEqual([...context.changeScopes('/quote', geico, 'Vehicles', [{ list: 'vehicles', id: 'Id_V0' }], { active: { vehicles: 0 }, bound: { vehicles: { Id_V0: 0 } } })], ['/quote|f:Id_V0', '/quote|v0']);
  // Progressive and AmWINS: editScope's one scope, whatever the recorder says is on screen.
  const progressive = { vehiclePages: ['AddVehicle'], trailerPages: ['AddTrailer'], driverPage: 'AddDriver' };
  const forms = [{ list: 'vehicles', id: 'Id_V1' }];
  for (const f of [forms, [], null]) {
    assert.deepEqual(['AddVehicle', 'AddTrailer', 'AddDriver', 'Rates'].map((p) => scopes(undefined, f, progressive, p)), [['AddVehicle|v1'], ['AddTrailer|tr0'], ['AddDriver|d2'], ['Rates']]);
    assert.deepEqual(['Vehicles', 'Drivers', null, undefined].map((s) => scopes(s, f, amwins, '/application/businessauto')), Array(4).fill(['/application/businessauto']));
  }
});

test('the recorder\'s field_changes file a GEICO edit under each scope its forms give, the tab\'s latest form when it names none', () => {
  const state = { intake: { record: {} }, tab: { id: 1, url: 'https://sales.geico.com/quote', carrier: geico }, filled: new Map(), labels: new Map(), choices: new Map(),
    agentKeys: new Map(), visitedPages: new Set(), autoPages: new Set(), layoutReadyTabs: new Set(), layoutNewTabs: new Set(), quoteStates: new Map(),
    active: { vehicles: 1, drivers: 0, trailers: 0 }, tabSteps: new Map([[1, 'Vehicles']]),
    unitShown: { step: 'Vehicles', list: 'vehicles', id: 'Id_V1', held: false }, unitForms: { vehicles: { Id_V1: 1 }, drivers: {}, trailers: {} } };
  let persisted = 0;
  const context = { state, URL, $: () => ({ checked: false }), usage: { log() {}, currentSession: () => ({ keySalt: 's' }) }, redactor: () => (s) => s, redactionTerms: () => [],
    fieldChangeEvent: (c) => ({ type: 'field_change', key: c.key }), knownStep, viewOf: () => 't1', scheduleLayout() {}, scheduleAutoFill() {}, quoteStatePick: () => undefined,
    persistAgentKeys() { persisted++; }, settleRejectedAi: async () => false, answeredOnPage() {} };
  vm.runInNewContext(`${PAGE_HELPERS}\n${extractFunction('onRecorderMessage')}`, context);
  const change = (key, forms, page = '/quote', step = 'Vehicles') => context.onRecorderMessage({ ra: 'usage', event: 'field_changes', page, step, ...(forms === undefined ? {} : { forms }),
    changes: [{ key, before: '', after: 'x', agent: true }] }, { tab: { id: 1 }, frameId: 0 });
  const edited = () => [...state.agentKeys].map(([scope, keys]) => [scope, [...keys]]);
  change('ref:GiveYear', [{ list: 'trailers', id: 'Id_T1' }]);
  change('ref:GiveLastName', []);
  change('ref:GiveOtherVehicleType', [{ list: 'vehicles', id: 'Id_V2' }]);
  change('ref:GiveVin', undefined);
  assert.deepEqual(edited(), [['/quote|f:Id_T1', ['ref:GiveYear']], ['/quote|tr0', ['ref:GiveYear']], ['/quote|s:Vehicles', ['ref:GiveLastName']],
    ['/quote|f:Id_V2', ['ref:GiveOtherVehicleType']], ['/quote|v1', ['ref:GiveVin']]]);
  assert.equal(persisted, 4, 'kept once per batch');
  // Progressive: its page's scope as before, whatever the message carries.
  state.agentKeys.clear();
  state.tab = { id: 1, url: 'https://x.test/AddVehicle', carrier: { id: 'progressive', vehiclePages: ['AddVehicle'] } };
  change('k', [{ list: 'trailers', id: 'Id_T1' }], 'AddVehicle', undefined);
  change('r', [], 'Rates', undefined);
  assert.deepEqual(edited(), [['AddVehicle|v1', ['k']], ['Rates', ['r']]]);
});

test('a GEICO form bound to its unit takes the edits filed under it to that unit, for the unit\'s next form', () => {
  const h = harness();
  const persisted = [];
  h.context.persistUnitForms = () => {};
  h.context.persistAgentKeys = (tabId) => persisted.push(tabId);
  h.state.tab = { id: 7, url: 'https://sales.geico.com/quote', carrier: geico };
  h.state.unitForms = { vehicles: { Id_V1: 0 }, drivers: {}, trailers: {} };
  h.state.unitShown = { step: 'Vehicles', list: 'vehicles', id: 'Id_V2', held: true };
  h.state.agentKeys = new Map([['/quote|f:Id_V2', new Set(['ref:GiveOtherVehicleType'])], ['/quote|v1', new Set(['ref:GiveVin'])], ['/quote|f:Id_X', new Set(['ref:GiveYear'])]]);
  const edited = (maps = h.state) => Object.fromEntries([...maps.agentKeys].filter(([, k]) => k.size).map(([s, k]) => [s, [...k]]));
  const fill = (unitForm, active, tabId = 7) => h.rememberFill([{ fields: 9, filled: [], stepKey: 'Vehicles', unitForm }], { tabId, carrier: geico, page: '/quote', scope: '/quote', active });
  // The agent edited the held form, picked vehicle 2, and the next fill answered the form for it.
  fill({ list: 'vehicles', id: 'Id_V2' }, { vehicles: 1, drivers: 0, trailers: 0 });
  assert.deepEqual(edited(), { '/quote|f:Id_V2': ['ref:GiveOtherVehicleType'], '/quote|v1': ['ref:GiveVin', 'ref:GiveOtherVehicleType'], '/quote|f:Id_X': ['ref:GiveYear'] });
  assert.deepEqual(persisted, [7, 7], 'the fill\'s edits, then the copy');
  // A form with nothing filed under it: nothing copied.
  fill({ list: 'trailers', id: 'Id_T1' }, { vehicles: 1, drivers: 0, trailers: 0 });
  assert.deepEqual(persisted, [7, 7, 7]);
  assert.equal(edited()['/quote|tr0'], undefined);
  // A fill finishing while another tab is in front: that tab's keys.
  h.context.tabMaps(8).agentKeys.set('/quote|f:Id_V5', new Set(['ref:GiveYear']));
  fill({ list: 'vehicles', id: 'Id_V5' }, { vehicles: 0, drivers: 0, trailers: 0 }, 8);
  assert.deepEqual(edited(h.state.tabSessions.get(8)), { '/quote|f:Id_V5': ['ref:GiveYear'], '/quote|v0': ['ref:GiveYear'] });
  assert.equal(edited()['/quote|v0'], undefined);
  // Progressive: nothing of the kind.
  const p = harness();
  p.context.persistUnitForms = () => {};
  p.state.tab = { ...quoteTab(1), carrier: { id: 'progressive' } };
  p.state.agentKeys = new Map([['AddVehicle|f:Id_V2', new Set(['k'])]]);
  p.rememberFill([{ fields: 3, filled: [], unitForm: { list: 'vehicles', id: 'Id_V2' } }], { tabId: 1, carrier: { id: 'progressive', vehiclePages: ['AddVehicle'] }, page: 'AddVehicle', scope: 'AddVehicle|v0', active: { vehicles: 0 } });
  assert.deepEqual(edited(p.state), { 'AddVehicle|f:Id_V2': ['k'] });
});

// Verifier, round 2 (L1): the undo recomputed the scope, and after Next or a pick took the field
// back from another step's or unit's edits.
test('undoing Mark done takes the field back from where it was marked, though the step or form moved on', async () => {
  const state = { tab: { id: 1, url: 'https://sales.geico.com/quote', carrier: geico }, active: { vehicles: 1, drivers: 0, trailers: 0 }, tabSteps: new Map([[1, 'Vehicles']]),
    unitShown: { step: 'Vehicles', list: 'vehicles', id: 'Id_H', held: true }, agentKeys: new Map([['/quote|v1', new Set(['ref:GiveYear'])]]), filling: false };
  const node = () => ({ hidden: true, children: [], focus() {}, replaceChildren(...c) { this.children = c; } });
  const itemOf = () => {
    const parts = { '.mark-done': node(), '.need-note': node() };
    return { dataset: {}, classList: { remove() {} }, querySelector: (sel) => parts[sel] };
  };
  const undos = [];
  const context = { state, URL, persistAgentKeys: async () => {}, pageOf: (url) => new URL(url).pathname, recount() {},
    settleNeed: (item, how, undo) => { item.dataset.settled = how; undos.push(undo); } };
  vm.runInNewContext(`${extractFunction('markDone')}\n${extractFunction('undoMarkDone')}`, context);
  const keys = (scope) => [...(state.agentKeys.get(scope) ?? [])];
  // Marked on a held form; the agent then picks its vehicle and a fill binds it.
  await context.markDone(itemOf(), 'ref:GiveYear', 1, '/quote');
  assert.deepEqual(keys('/quote|f:Id_H'), ['ref:GiveYear']);
  state.unitShown = { step: 'Vehicles', list: 'vehicles', id: 'Id_H', held: false };
  await undos[0]();
  assert.deepEqual([keys('/quote|f:Id_H'), keys('/quote|v1')], [[], ['ref:GiveYear']], 'the vehicle\'s own edit stays');
  // Marked on Business & Owner Info; the agent then clicks Next.
  state.tabSteps.set(1, 'Business & Owner Info');
  await context.markDone(itemOf(), 'ref:GiveLastName', 1, '/quote');
  state.tabSteps.set(1, 'Drivers & Incidents');
  state.agentKeys.set('/quote|d0', new Set(['ref:GiveLastName']));
  await undos[1]();
  assert.deepEqual([keys('/quote|s:Business & Owner Info'), keys('/quote|d0')], [[], ['ref:GiveLastName']]);
  // Mark done hands its own scope to the undo.
  assert.match(extractFunction('markDone'), /undoMarkDone\(item, key, tabId, page, scope\)/);
});

// Verifier, round 2 (L3): GEICO's progress bar and title disagree for a moment right after Next;
// the kit halts there reading nothing (pagekit stepUnread), and that paused every automatic fill
// on the quote until the agent clicked Fill.
test('a step the kit couldn\'t read pauses nothing, and an automatic fill there is tried once more until a fill reads a step', () => {
  const UNREAD = 'The step on screen could not be read (the progress bar and the page title disagree): fill again once the page settles.';
  const h = harness();
  h.context.persistUnitForms = () => {};
  const retries = [];
  h.context.scheduleAutoFill = (page) => retries.push(page);
  const quote = { id: 7, url: 'https://sales.geico.com/quote', carrier: geico };
  h.state.tab = quote;
  h.state.unitShown = null;
  const unread = { fields: 0, filled: [], halted: true, reason: UNREAD, stepUnread: true, stepKey: '' };
  const read = { fields: 6, filled: [], stepKey: 'Vehicles' };
  const fill = (frames, auto = false) => h.rememberFill(frames, { tabId: 7, carrier: geico, page: '/quote', active: { vehicles: 0, drivers: 0, trailers: 0 }, auto });
  const retryTimers = () => h.scheduled.filter((s) => s.ms === 1500);
  h.state.autoPending = true;
  fill([unread], true);
  assert.deepEqual([h.state.autoPaused, h.state.autoPending, h.state.unreadRetried, h.cleared.length], [false, true, true, 0], 'no pause, pending work kept');
  assert.equal(retryTimers().length, 1);
  retryTimers()[0].fn();
  assert.deepEqual(retries, ['/quote']);
  // Unread again (the retry, or the page's own automatic fill): no second retry.
  fill([unread], 'page');
  assert.equal(retryTimers().length, 1, 'one retry');
  assert.equal(h.state.autoPaused, false);
  // A fill that reads a step: the next unread step gets its retry.
  fill([read], true);
  assert.equal(h.state.unreadRetried, false);
  fill([unread], 'page');
  assert.equal(retryTimers().length, 2);
  // Read since the retry was set, or the tab is on another page: no retry.
  fill([read]);
  retryTimers()[1].fn();
  fill([unread], true);
  h.state.tab = { ...quote, url: 'https://sales.geico.com/dashboard' };
  retryTimers()[2].fn();
  h.state.tab = quote;
  assert.deepEqual(retries, ['/quote']);
  // A fill the agent asked for is not retried, nor paused.
  fill([read]);
  fill([unread]);
  assert.deepEqual([retryTimers().length, h.state.autoPaused, h.state.unreadRetried], [3, false, false]);
  // Any other halt pauses as before, an unread frame beside it or not.
  fill([unread, { fields: 2, filled: [], halted: true, reason: 'You changed a field during the fill.' }], true);
  assert.equal(h.state.autoPaused, true);
  // Kept per tab, reset with a new intake.
  assert.match(extractFunction('refreshTab'), /'autoPaused', 'unreadRetried',/);
  assert.match(SIDEPANEL, /state\.unitShown = null;\n\s+state\.unreadRetried = false;/);
});

test('both fills tell their bookkeeping whether they were automatic: only an automatic one is retried on a step the kit couldn\'t read', async () => {
  const UNREAD = 'The step on screen could not be read (the progress bar and the page title disagree): fill again once the page settles.';
  for (const [which, retried] of [['autoFill', true], ['fillPage', false], ['fillPage auto', true]]) {
    const t = fillHarness({ carrier: geico });
    const timers = [];
    t.context.setTimeout = (fn, ms) => { timers.push(ms); return 1; };
    t.state.reportFor = { filled: 0 };
    const run = which === 'autoFill' ? t.context.autoFill('/quote-A') : t.context.fillPage(which === 'fillPage auto' ? { auto: 'page' } : {});
    await t.started;
    t.release([{ frameId: 0, result: { ...t.results[0].result, fields: 0, filled: [], protectedKeys: [], actions: [], stepKey: '', halted: true, reason: UNREAD, stepUnread: true } }]);
    await run;
    assert.deepEqual([t.state.autoPaused, timers.includes(1500)], [false, retried], which);
  }
});

test('the report of a step the kit couldn\'t read doesn\'t say automatic filling paused; another halt\'s still does', () => {
  const UNREAD = 'The step on screen could not be read (the progress bar and the page title disagree): fill again once the page settles.';
  const state = { tab: { id: 7, url: 'Quote' } };
  const { context } = reportHarness(state);
  const empty = { fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [] };
  context.renderReport([{ ...empty, halted: true, reason: UNREAD, stepUnread: true }]);
  assert.equal(state.reportFor.error, UNREAD);
  context.renderReport([{ ...empty, halted: true, reason: 'The page is still waiting on its server. Review and retry.' }]);
  assert.equal(state.reportFor.error, 'Automatic filling and helpers paused. The page is still waiting on its server. Review and retry.');
  context.renderReport([{ ...empty, halted: true, reason: UNREAD, stepUnread: true }, { ...empty, halted: true, reason: 'You stopped the fill.' }]);
  assert.equal(state.reportFor.error, 'Automatic filling and helpers paused. You stopped the fill.', 'the frame that paused is the one said');
});

// FL live run, 2026-10-21: each follow-up fill on Quote & Coverages set a coverage again, GEICO
// requoted and the agent's choices went. The step is filled when it opens and on Fill this page only.
test('GEICO Quote & Coverages: once filled, an automatic fill runs there only for questions it draws', async () => {
  const t = stopStepHarness('Quote & Coverages');
  vm.runInContext(['reportKey', 'currentReportKey', 'tabStep'].map(extractFunction).join('\n'), t.context);
  t.state.reports.set(t.context.currentReportKey(), { fields: 24 });
  // After an answer or a redraw (no new question): nothing.
  await t.context.autoFill('/quote');
  await t.context.fillPage({ auto: 'page' });
  await t.context.fillPage({ auto: true });
  assert.deepEqual([t.kits, t.state.filling], [[], false]);
  // New questions drawn there (FL live run 2: the cargo section's): followed up, once.
  let ran = 0;
  t.context.fillContext = () => { ran++; throw new Error('past the gate'); };
  t.context.scheduleAutoFill('/quote', undefined, true);
  assert.equal(t.state.autoDrawn, '/quote');
  await assert.rejects(t.context.autoFill('/quote'), /past the gate/);
  assert.deepEqual([ran, t.state.autoDrawn], [1, null], 'followed up, the new questions used by that fill');
  await t.context.autoFill('/quote');
  assert.equal(ran, 1, 'the next follow-up without new questions: nothing');
  // New questions whose follow-up never ran (the agent's Fill this page cancelled it): a later
  // follow-up, after an answer, isn't one for them.
  t.context.scheduleAutoFill('/quote', undefined, true);
  vm.runInContext(extractFunction('fillPage'), t.context);
  await t.context.fillPage().catch(() => {});
  assert.equal(t.state.autoDrawn, null, 'Fill this page used the drawn questions');
  t.state.filling = false;
  await t.context.autoFill('/quote');
  assert.equal(ran, 1, 'a follow-up after an answer there: nothing');
  // Another step is followed up as before (the kit runs).
  const v = stopStepHarness('Vehicles');
  vm.runInContext(['reportKey', 'currentReportKey', 'tabStep'].map(extractFunction).join('\n'), v.context);
  v.state.reports.set(v.context.currentReportKey(), { fields: 10 });
  await v.context.autoFill('/quote').catch(() => {});
  assert.ok(v.kits.length > 0 || v.state.filling === false);
});


// FL live run, 2026-10-21: the second vehicle's and second driver's Add forms waited for a pick, and
// the panel's driver was the owner GEICO already lists.
test('a new, blank GEICO unit form is the next intake unit no form was filled for; never the owner GEICO lists', async () => {
  const run = async ({ forms, active = {}, unitForms = {}, record, listedDriver = () => -1, omittedDriver = () => -1 }) => {
    const intake = { record };
    const state = { tab: { id: 4 }, intake, intakeRevision: 1, active: { vehicles: 0, drivers: 0, trailers: 0, ...active }, unitForms: { vehicles: {}, drivers: {}, trailers: {}, ...unitForms } };
    const calls = { saved: 0, rendered: 0 };
    const context = {
      state,
      runKit: async () => [{ result: forms }],
      save: async () => { calls.saved++; },
      renderPickers: () => { calls.rendered++; },
    };
    vm.runInNewContext(['formScoped', 'pickUnitForm'].map(extractFunction).join('\n'), context);
    await context.pickUnitForm({ ...geico, listedDriver, omittedDriver }, { tabId: 4, intake, revision: 1 });
    return { active: { ...state.active }, ...calls };
  };
  const record = { vehicles: [{}, {}, {}], drivers: [{}, {}, {}], trailers: [] };

  // The second vehicle's form opens while vehicle 1 is bound to the first form.
  let out = await run({ forms: [{ list: 'vehicles', id: 'B', blank: true }], unitForms: { vehicles: { A: 0 } }, record });
  assert.equal(out.active.vehicles, 1);
  assert.deepEqual([out.saved, out.rendered], [1, 1]);

  // GEICO lists the owner (driver 1) itself: the first Add Driver form is driver 2.
  out = await run({ forms: [{ list: 'drivers', id: 'D', blank: true }], record, listedDriver: () => 0 });
  assert.equal(out.active.drivers, 1);

  // Owner listed and driver 2 bound: the next form is driver 3.
  out = await run({ forms: [{ list: 'drivers', id: 'E', blank: true }], unitForms: { drivers: { D: 1 } }, active: { drivers: 1 }, record, listedDriver: () => 0 });
  assert.equal(out.active.drivers, 2);

  // The owner who doesn't drive, whose row GEICO's quote leaves out (TNI, 2026-10-26: answer to PR
  // question, T1): an Add Driver form is never theirs either.
  out = await run({ forms: [{ list: 'drivers', id: 'D', blank: true }], record, omittedDriver: () => 0 });
  assert.equal(out.active.drivers, 1);
  out = await run({ forms: [{ list: 'drivers', id: 'E', blank: true }], unitForms: { drivers: { D: 0 } }, record, omittedDriver: () => 1 });
  assert.equal(out.active.drivers, 2);

  // An answered form (a saved unit opened again), a form already bound, or a free active unit: no change.
  for (const args of [
    { forms: [{ list: 'vehicles', id: 'B', blank: false }], unitForms: { vehicles: { A: 0 } }, record },
    { forms: [{ list: 'vehicles', id: 'A', blank: true }], unitForms: { vehicles: { A: 0 } }, record },
    { forms: [{ list: 'vehicles', id: 'B', blank: true }], unitForms: { vehicles: { A: 0 } }, active: { vehicles: 2 }, record },
    { forms: [{ list: 'vehicles', id: 'C', blank: true }], unitForms: { vehicles: { A: 0, B: 1, X: 2 } }, record },
  ]) {
    out = await run(args);
    assert.deepEqual([out.active.vehicles, out.saved, out.rendered], [args.active?.vehicles ?? 0, 0, 0]);
  }
});

// FL live run 2, 2026-10-21: GEICO's Start New Quote window opened over Recent Policies and Quotes, a
// page already drawn (no fields on arrival), and its ZIP was never filled.
test('GEICO: questions drawn over a gateway page no fill answered anything on get its first fill; a page filled before, a follow-up', () => {
  const { context } = layoutHarness(() => []);
  const fills = [], followUps = [];
  const GATEWAY_URL = 'https://gateway2.geico.com/recent-policy-and-quotes';
  Object.assign(context, { samePage: (p) => p, redactor: () => (x) => x, fieldChangeEvent: () => ({ type: 'field_change' }), knownStep, currentReportKey: () => 'report', pageOf: (url) => new URL(url).pathname,
    $: () => ({ checked: true }), stopNoteFor: () => null, fillPage: (o) => fills.push(o), scheduleAutoFill: (page, ctx, drawn) => followUps.push([page, drawn]), setTimeout: (fn) => fn() });
  Object.assign(context.state, { filled: new Map(), labels: new Map(), autoPages: new Set(), reports: new Map() });
  Object.assign(context.state.tab, { carrier: geico, url: GATEWAY_URL });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  const drawn = () => context.onRecorderMessage({ ra: 'usage', event: 'new_fields', page: '/recent-policy-and-quotes', keys: ['zip'] }, { tab: { id: 1 } });
  drawn();
  assert.deepEqual([fills.map((o) => o.auto), followUps], [['page'], []]);
  // That fill answered nothing (a gateway control drawn before the window, ignored): the window's
  // questions still get a first fill, whether or not follow-ups are on.
  context.state.autoPages.add('/recent-policy-and-quotes');
  context.state.reports.set('report', { fields: 3, filled: 0 });
  drawn();
  assert.deepEqual([fills.length, followUps], [2, []]);
  // A fill answered something there: a follow-up, for questions drawn.
  context.state.reports.set('report', { fields: 3, filled: 1 });
  drawn();
  assert.deepEqual([fills.length, followUps], [2, [['/recent-policy-and-quotes', true]]]);
  // On the quote itself questions are drawn with their step: a follow-up as before.
  followUps.length = 0;
  context.state.autoPages.clear();
  context.state.tab.url = 'https://sales.geico.com/quote';
  drawn();
  assert.deepEqual([fills.length, followUps.length], [2, 1]);
  context.state.tab.url = GATEWAY_URL;
  // "Fill each new page" off: no first fill.
  context.state.autoPages.clear();
  context.$ = () => ({ checked: false });
  drawn();
  assert.equal(fills.length, 2);
  // A carrier whose pages draw with their questions (Progressive): a follow-up as before.
  context.$ = () => ({ checked: true });
  context.state.tab.carrier = { id: 'progressive', layoutUrl: /./ };
  drawn();
  assert.equal(fills.length, 2);
});

// FL live run, 2026-10-21: "click + and add the new vehicle", "click Next after choosing Vehicle or
// Trailer". On GEICO's unit lists the panel names the unit the fill adds (ctx.adding), by the intake's
// order, from what the list shows and the forms fills answered, and moves the picker to it.
test('GEICO: the next intake unit not on the quote is the one added; never one listed, filled, or past the intake\'s count', async () => {
  const run = async ({ step = 'Vehicles', forms = [], lists, active = {}, unitForms = {}, done = [], record, autoAdvance = true, autoPages = false, asked = false }) => {
    const intake = { record };
    const state = { tab: { id: 4 }, intake, intakeRevision: 1, active: { vehicles: 0, drivers: 0, trailers: 0, ...active },
      unitForms: { vehicles: {}, drivers: {}, trailers: {}, ...unitForms }, doneActions: new Set(done) };
    const calls = { saved: 0, rendered: 0, persisted: 0, asked: null };
    const context = {
      state, knownStep,
      runKit: async (tabId, carrier, fn, args) => { calls.asked = args[0]; return [{ result: { step, forms, lists } }]; },
      fillCurrent: () => true,
      persistDoneActions: () => { calls.persisted++; },
      save: async () => { calls.saved++; },
      renderPickers: () => { calls.rendered++; },
      unitToAdd, unitListSpecs, unitMissing, buildPlan,
    };
    vm.runInNewContext(extractFunction('pickUnitToAdd'), context);
    const ctx = { tabId: 4, intake, revision: 1, asked, settings: { autoAdvance, autoPages } };
    await context.pickUnitToAdd(geico, ctx);
    return JSON.parse(JSON.stringify({ adding: ctx.adding, listed: ctx.unitsListed, active: { ...state.active }, done: [...state.doneActions].sort(), ...calls }));
  };
  const VIN1 = '1FTBR3X80MKA12345';
  const record = {
    applicant: { ownerDrives: true, owner1: 'Sample Driver' },
    vehicles: [{ vin: VIN1 }, { vin: null }], trailers: [{ vin: null }],
    drivers: [{ first: 'Sample', last: 'Driver' }, { first: 'Casey', last: 'Example' }],
  };
  // The vehicle list after vehicle 1's form (filled on form A): vehicle 2 is next, and the picker moves to it.
  let out = await run({ lists: [{ rows: 1, shown: [true, false, false] }, null], unitForms: { vehicles: { A: 0 } }, record });
  assert.deepEqual([out.adding, out.listed], [{ list: 'vehicles', index: 1, click: true }, false]);
  assert.deepEqual([out.active.vehicles, out.saved, out.rendered], [1, 1, 1]);
  assert.deepEqual(out.done, ['vehicleEntered:0']);
  // Only the VINs, names and the selectors go to the page.
  assert.deepEqual(out.asked, [{ selector: '#summaryPage-AddCommercialVehicle', items: [VIN1, '', ''] }, { selector: '#summaryPage-AddDriver', items: [['Sample', 'Driver'], ['Casey', 'Example']] }]);
  // Both vehicles in (vehicle 2 filled on form B): the trailer, Trailer on the chooser.
  out = await run({ lists: [{ rows: 2, shown: [true, false, false] }, null], unitForms: { vehicles: { A: 0, B: 1 } }, active: { vehicles: 1 }, record });
  assert.deepEqual(out.adding, { list: 'trailers', index: 0, click: true });
  // The plan clicks the "+" and the chooser's Next for it (`click`) with "Fill the pages" or "Click
  // Continue" on (W43-20, TNI, FL live run 5, 2026-10-21), and on the agent's own Fill this page with
  // both off (FL live run 6, 2026-10-21: Fill this page on the vehicle list did nothing); an automatic
  // fill with both off has the same unit, and only answers the chooser.
  const both = { lists: [{ rows: 2, shown: [true, false, false] }, null], unitForms: { vehicles: { A: 0, B: 1 } }, active: { vehicles: 1 }, record };
  out = await run({ ...both, autoAdvance: false, autoPages: true });
  assert.deepEqual(out.adding, { list: 'trailers', index: 0, click: true });
  out = await run({ ...both, autoAdvance: false });
  assert.deepEqual(out.adding, { list: 'trailers', index: 0, click: false });
  out = await run({ ...both, autoAdvance: false, asked: true });
  assert.deepEqual(out.adding, { list: 'trailers', index: 0, click: true });
  // As many units listed as the intake has (one added by hand, with no fill): nothing is added.
  out = await run({ lists: [{ rows: 3, shown: [true, false, false] }, null], unitForms: { vehicles: { A: 0 } }, record });
  assert.equal(out.adding, null);
  // Every intake unit on the list: its Looks Good may be clicked (FL live run 3, 2026-10-21).
  assert.equal(out.listed, true);
  // The chooser (no list, no form on screen): the unit from what was recorded, the picker moved.
  out = await run({ lists: [null, null], done: ['vehicleEntered:0'], record });
  assert.deepEqual([out.adding, out.active.vehicles, out.persisted, out.listed], [{ list: 'vehicles', index: 1, click: true }, 1, 0, false]);
  // A unit form on screen: the unit is named, the picker left to pickUnitForm.
  out = await run({ lists: [null, null], forms: [{ list: 'vehicles', id: 'B', blank: true }], done: ['vehicleEntered:0'], record });
  assert.deepEqual([out.adding?.index, out.active.vehicles, out.saved], [1, 0, 0]);
  // Drivers: the owner GEICO lists (driver 1) is never added; driver 2 is, until the list shows them.
  out = await run({ step: 'Drivers & Incidents', lists: [null, { rows: 1, shown: [true, false] }], record });
  assert.deepEqual([out.adding, out.active.drivers], [{ list: 'drivers', index: 1, click: true }, 1]);
  out = await run({ step: 'Drivers & Incidents', lists: [null, { rows: 1, shown: [true, true] }], record });
  assert.equal(out.adding, null);
  assert.deepEqual(out.done, ['driverEntered:0', 'driverEntered:1']);
  // A row the panel can't account for (one added by hand) while the next unit can't be read on the
  // list (no VIN): it may be that row, so it is left to the agent, never added twice.
  const noVin = { ...record, trailers: [{ vin: null }, { vin: null }] };
  out = await run({ lists: [{ rows: 3, shown: [true, false, false, false] }, null], unitForms: { vehicles: { A: 0, B: 1 } }, active: { vehicles: 1 }, record: noVin });
  assert.deepEqual([out.adding, out.done, out.persisted], [null, ['trailerEntered:0', 'trailerEntered:1', 'vehicleEntered:0', 'vehicleEntered:1'], 1]);
  // Another step, or a carrier without unit lists: nothing.
  for (const args of [{ step: 'Additional Business Info', lists: [null, null], record }]) assert.equal((await run(args)).adding, null);
});


// ---------------------------------------------------------------------------------------------
// v5: the agent's own pick, put in from the panel (agentPickable, agentAnswer), and the quote-state
// hold (stateIssue, dismissState).

// The panel offers its choices only for a question it may answer for the agent: a radio, a list or
// a box the page offers choices for, never a typed answer, one TNI leaves to the agent on the page
// (neverReason), a lookup identity they verify there (reviewOnly), or anything on a stop.
test('the panel offers to put in the agent\'s pick only for a choice it may answer, never on a stop', () => {
  const state = { tab: { id: 1, url: 'Quote' }, tabSteps: new Map() };
  const context = { state, neverReason, pageOf: (u) => u };
  vm.runInNewContext(extractFunction('agentPickable'), context);
  const carrier = { id: 'progressive', stopPages: { DeclinationNotice: 'Declined.' } };
  const ok = (x, page = 'Quote') => context.agentPickable(x, carrier, page);
  const radio = { key: 'k', label: 'Hauls hazardous materials', controlKind: 'radio', options: ['Yes', 'No'] };
  assert.equal(ok(radio), true);
  assert.equal(ok({ ...radio, controlKind: 'select' }), true);
  assert.equal(ok({ key: 'b', label: 'Owner operator', controlKind: 'checkbox' }), true, 'a box: checked or unchecked');
  assert.equal(ok({ ...radio, controlKind: 'text' }), false, 'a typed answer is never put in for the agent');
  assert.equal(ok({ ...radio, controlKind: undefined }), false);
  assert.equal(ok({ ...radio, key: null }), false, 'no field to put it in');
  assert.equal(ok({ ...radio, options: [] }), false, 'no choices offered');
  for (const label of ['Signature of applicant', 'Order MVR reports now?', 'Payment plan', 'Pay in full', 'Exclude this driver?', 'I agree to the terms']) {
    assert.equal(ok({ ...radio, label }), false, label);
  }
  assert.equal(ok({ ...radio, label: 'Choice', section: 'Payment Information' }), false, 'by its section too');
  assert.equal(ok({ ...radio, label: 'Medical payments' }), true, 'Medical Payments is coverage, not a payment');
  assert.equal(ok({ ...radio, reviewOnly: true }), false, 'a lookup identity the agent verifies on the page');
  assert.equal(ok(radio, 'DeclinationNotice'), false, 'a carrier stop page');
  // A stop step (GEICO's MVR & CLUE), and a stop screen on the tab: nothing.
  state.tab.carrier = geico;
  state.tabSteps.set(1, 'MVR & CLUE');
  assert.equal(context.agentPickable(radio, geico, '/quote'), false, 'a stop step');
  state.tabSteps.set(1, 'Vehicles');
  assert.equal(context.agentPickable(radio, geico, '/quote'), true);
  state.stopScreens = new Map([[1, { name: 'USDOT Number', page: '/quote' }]]);
  assert.equal(context.agentPickable(radio, geico, '/quote'), false, 'a stop screen');
  // Without a pick allowed, the item says to answer it on the page, and offers no choice.
  const { context: report, box } = reportHarness({ tab: { id: 1, url: 'Quote', carrier } }, { neverReason });
  report.renderReport([{ fields: 2, filled: [], kept: [], failed: [], leftRequired: [], actions: [],
    noData: [{ ...radio, order: 0 }, { ...radio, key: 'p', label: 'Payment plan', order: 1 }] }]);
  const [pickable, payment] = rowsOf(box);
  assert.deepEqual(nodesIn(pickable).filter((n) => n.props?.class === 'opt-btn').map((n) => n.props.dataset.choice), ['Yes', 'No']);
  assert.equal(nodesIn(payment).some((n) => n.props?.class === 'opt-btn'), false);
  assert.ok(nodesIn(payment).some((n) => n.props?.class === 'row-say'));
});

// The agent's pick from a row goes in through the same guarded path as an AI answer: only while
// the page shows the question and the choice as the row read them, `by: 'agent'`, never on a stop
// step; the field is the agent's then (agentKeys) and the change is logged as theirs.
function agentAnswerHarness({ carrier = { id: 'progressive', stopSteps: { 'Payment Information': 'Yours.' } }, extra = {} } = {}) {
  const field = { key: 'k1', label: 'Hauls hazardous materials', kind: 'radio', options: ['Yes', 'No'], current: 'Yes', section: 'Operations' };
  const frame = (fields, frameId = 0) => ({ frameId, documentId: `doc-${frameId}`, result: JSON.stringify(['Operations', fields]) });
  const t = {
    field, frame, frames: [frame([field])], kit: [], logged: [], settled: [], scheduled: [], said: null,
    answer: (items) => [{ frameId: 0, result: [{ key: items[0].key, ok: true, shown: items[0].value }] }],
  };
  const state = { tab: { id: 1, url: 'Quote', carrier }, intake: { record: {} }, intakeRevision: 0, filling: false, agentKeys: new Map(), aiCache: new Map(),
    active: {}, tabSteps: new Map(), filled: new Map(), labels: new Map(), choices: new Map(), tabSessions: new Map() };
  const note = { hidden: true, classList: { add() {}, remove() {} }, replaceChildren(...c) { t.said = c.join(''); } };
  t.item = { classList: { contains: (c) => c === 'need' }, querySelector: (sel) => (sel === '.need-note' ? note : null), querySelectorAll: () => [] };
  t.x = { key: 'k1', label: 'Hauls hazardous materials', controlKind: 'radio', options: ['Yes', 'No'], q: 'q-hazmat' };
  const context = {
    state, crypto, neverReason, knownStep, pageOf: (u) => u,
    usage: { currentSession: () => ({ intakeId: 'intake-1', keySalt: 'salt' }), log: (e) => t.logged.push(e) },
    tellRecorder: async () => {}, scheduleLayout() {}, scheduleAutoFill: (p) => t.scheduled.push(p),
    agentKeysQueue: Promise.resolve(), agentKeysStore: { get: async () => t.stored ?? [], set: async (v) => { t.stored = JSON.parse(JSON.stringify(v)); } },
    redactor: () => (s) => s, redactionTerms: () => [], viewOf: () => 't1', fieldChangeEvent: (c) => ({ type: 'field_change', ...c }),
    settleNeed: (item, how, undo, shown) => t.settled.push([how, shown]),
    runKit: async (tabId, c, fn, args = [], frameIds) => {
      const src = String(fn);
      if (src.includes('answerEdits')) { t.kit.push(['answerEdits', src.includes("'begin'") ? 'begin' : 'end']); return [{ frameId: 0, result: [] }]; }
      if (src.includes('decisionSnapshot')) { t.kit.push(['snapshot']); return t.frames; }
      t.kit.push(['answer', JSON.parse(JSON.stringify(args)), frameIds]);
      return t.answer(args[0]);
    },
    ...extra,
  };
  vm.runInNewContext(['agentAnswer', 'agentPickable', 'choiceSaid', 'aiSnapshotFieldMatches', 'aiSnapshotFields'].map(extractFunction).join('\n'), context);
  t.state = state;
  t.carrier = carrier;
  t.pick = (choice, where = {}) => context.agentAnswer(t.item, t.x, choice, { tabId: 1, page: 'Quote', carrier, ...where });
  t.keys = () => [...(state.agentKeys.get('Quote') ?? [])];
  return t;
}

test('the agent\'s pick from a row is refused while filling, on another tab or page, and on a question it may not answer', async () => {
  const t = agentAnswerHarness();
  t.state.filling = true;
  await t.pick('No');
  t.state.filling = false;
  await t.pick('No', { tabId: 2 });
  await t.pick('No', { page: 'Drivers' });
  t.state.tab.url = 'Drivers';
  await t.pick('No');
  t.state.tab.url = 'Quote';
  // A typed answer, or one TNI leaves to the agent: never put in.
  t.x = { ...t.x, controlKind: 'text' };
  await t.pick('No');
  t.x = { ...t.x, controlKind: 'radio', label: 'Signature of applicant' };
  await t.pick('No');
  assert.deepEqual(t.kit, [], 'nothing asked of the page');
  assert.deepEqual([t.keys(), t.logged, t.settled, t.scheduled], [[], [], [], []]);
});

test('the agent\'s pick is refused when the page no longer shows its question once, or the choice', async () => {
  for (const [label, frames] of [['gone', (t) => [t.frame([])]], ['twice', (t) => [t.frame([t.field]), t.frame([t.field], 3)]],
    ['not offered now', (t) => [t.frame([{ ...t.field, options: ['Yes'] }])]]]) {
    const t = agentAnswerHarness();
    t.frames = frames(t);
    await t.pick('No');
    assert.deepEqual(t.kit, [['answerEdits', 'begin'], ['snapshot'], ['answerEdits', 'end']], `${label}: read, never answered; the guard is let go`);
    assert.equal(t.said, label === 'not offered now' ? 'The page doesn’t offer that answer now: answer it on the page.' : 'The page changed: answer it on the page.', label);
    assert.deepEqual([t.keys(), t.logged, t.settled, t.scheduled, t.state.filling], [[], [], [], [], false], label);
  }
  // On a page where it became a question TNI leaves to the agent: refused as well.
  const t = agentAnswerHarness();
  t.frames = [t.frame([{ ...t.field, section: 'Payment Information' }])];
  await t.pick('No');
  assert.equal(t.kit.some((k) => k[0] === 'answer'), false);
});

test('the agent\'s pick goes in as theirs: by the agent, never on a stop step, logged, their field after', async () => {
  const t = agentAnswerHarness();
  await t.pick('No');
  const answer = t.kit.find((k) => k[0] === 'answer');
  const [items, token, options] = answer[1];
  assert.deepEqual(items, [{ key: 'k1', label: 'Hauls hazardous materials', value: 'No', expected: { kind: 'radio', section: 'Operations', options: ['Yes', 'No'], current: 'Yes' } }]);
  assert.deepEqual(options, { stopSteps: ['Payment Information'], by: 'agent' });
  assert.deepEqual([...answer[2]], [0], 'only in the frame that shows the question');
  assert.deepEqual(t.kit.map((k) => k[0] === 'answerEdits' ? k[1] : k[0]), ['begin', 'snapshot', 'answer', 'end']);
  assert.equal(typeof token, 'string');
  assert.deepEqual(t.keys(), ['k1'], 'the field is the agent\'s on this page now');
  assert.deepEqual(t.logged.map((e) => [e.type, e.key, e.q, e.before, e.after, e.agent]), [['field_change', 'k1', 'q-hazmat', 'Yes', 'No', true]]);
  assert.deepEqual(t.settled, [['picked', 'No']]);
  assert.deepEqual(t.scheduled, ['Quote'], 'questions it revealed are filled as after an edit');
  assert.equal(t.state.filling, false);
  // The page didn't take it: not the agent's, nothing logged, said on the row.
  const refused = agentAnswerHarness();
  refused.answer = () => [{ frameId: 0, result: [{ key: 'k1', ok: false, reason: 'the option is disabled' }] }];
  await refused.pick('No');
  assert.deepEqual([refused.keys(), refused.logged, refused.settled], [[], [], []]);
  assert.equal(refused.said, 'The page didn’t take it (the option is disabled). Answer it on the page.');
  // The kit couldn't be reached: the same.
  const lost = agentAnswerHarness();
  lost.answer = () => { throw new Error('Frame was removed'); };
  await lost.pick('No');
  assert.deepEqual([lost.keys(), lost.logged, lost.state.filling], [[], [], false]);
  assert.equal(lost.said, 'Couldn’t reach the page. Answer it on the page.');
  // A practice carrier: the field is the agent's, and nothing is logged.
  const practice = agentAnswerHarness({ carrier: { id: 'synthetic', practice: true } });
  await practice.pick('No');
  assert.deepEqual(practice.kit.find((k) => k[0] === 'answer')[1][2], { stopSteps: [], by: 'agent' });
  assert.deepEqual([practice.keys(), practice.logged], [['k1'], []]);
  assert.deepEqual(t.stored, [{ scope: 'intake-1', tabId: 1, page: 'Quote', keys: ['k1'] }], 'kept for the panel opened again');
});

// Review 2026-10-22: the agent moved to another tab while their pick went in. The page holds it, so
// it is theirs where it went in (no fill puts the intake value back) and logged; their row there
// isn't touched from the other tab.
test('the agent\'s pick stays theirs when they move to another tab before it is in', async () => {
  const t = agentAnswerHarness();
  const theirs = t.state.agentKeys;
  const answerIn = t.answer;
  t.answer = (items) => { Object.assign(t.state, { tab: { id: 2, url: 'Drivers', carrier: t.carrier }, agentKeys: new Map() }); return answerIn(items); };
  await t.pick('No');
  assert.deepEqual([...(theirs.get('Quote') ?? [])], ['k1'], 'the quote tab\'s keys');
  assert.deepEqual(t.keys(), [], 'not the tab in front\'s');
  assert.deepEqual(t.stored, [{ scope: 'intake-1', tabId: 1, page: 'Quote', keys: ['k1'] }]);
  assert.deepEqual(t.logged.map((e) => [e.type, e.key, e.after, e.agent]), [['field_change', 'k1', 'No', true]]);
  assert.deepEqual([t.settled, t.scheduled, t.said], [[], [], null]);
  assert.equal(t.state.filling, false);
});

// The tab's quote is for another state than the intake's: nothing is filled, on request or
// automatically, until the agent says the state is right (or Fill anyway, which says so).
test('no fill, follow-up or scheduled fill while the quote state differs from the intake\'s', async () => {
  const issue = { picked: 'Utah', intake: 'Florida' };
  const t = fillHarness({ carrier: { id: 'progressive', advance: /Continue/ } });
  let notes = 0;
  t.context.showStateNote = () => { notes++; };
  t.context.stateIssue = () => issue;
  await t.context.fillPage();
  await t.context.fillPage({ auto: 'page' });
  await t.context.autoFill('/quote-A');
  assert.equal(t.seen.options, null, 'the kit is never asked to fill');
  assert.deepEqual([t.state.filling, t.seen.rendered, notes], [false, 0, 2], 'Fill this page says why, above the page');
  // The agent said the state is right: the fill runs.
  t.context.stateIssue = () => null;
  const run = t.context.fillPage();
  await t.started;
  t.release(t.results);
  await run;
  assert.equal(t.seen.rendered, 1);
  // A follow-up isn't scheduled either.
  const timers = [];
  const state = { autoPaused: false, autoPages: new Set(['Quote']), tab: { id: 1, url: 'Quote', carrier: { id: 'progressive' } }, filling: false, intake: {}, tabSteps: new Map() };
  const context = { state, $: () => ({ checked: true }), onQuotePage: () => true, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {}, pageOf: (u) => u, stateIssue: () => issue };
  vm.runInNewContext(extractFunction('scheduleAutoFill'), context);
  context.scheduleAutoFill('Quote');
  assert.equal(timers.length, 0);
  context.stateIssue = () => null;
  context.scheduleAutoFill('Quote');
  assert.equal(timers.length, 1);
  // The dock holds Fill this page, and offers Fill anyway, which says the state is right first.
  const held = dockHarness({ carrier: { id: 'progressive', name: 'Progressive' }, issue }).dock();
  assert.deepEqual([held.phase, held.button, held.disabled, held.alt, held.altLabel], ['hold', 'fill', true, 'fill-anyway', 'Fill anyway']);
  assert.match(SIDEPANEL, /\$\('dock-alt'\)\.addEventListener\('click', \(\) => \{\s+if \(\$\('dock-alt'\)\.dataset\.go === 'fill-anyway'\) dismissState\(\);\s+fillPage\(\);\s+\}\);/);
});

test('"<state> is right" lets the quote state stand for this intake only, and for this pick', async () => {
  const { stateMismatch } = await import('../src/quote-state.js');
  const session = { intakeId: 'intake-1' };
  const pick = { carrier: 'progressive', code: 'UT', dismissed: null };
  const state = { tab: { id: 7, carrier: { id: 'progressive' } }, intake: { record: { garaging: { state: 'FL' } } }, quoteStates: new Map([[7, pick]]) };
  let drawn = 0;
  const context = { state, stateMismatch, usage: { currentSession: () => session }, showStateNote() { drawn++; }, renderSteps() { drawn++; } };
  vm.runInNewContext(['stateIssue', 'dismissState'].map(extractFunction).join('\n'), context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.stateIssue())), { picked: 'Utah', intake: 'Florida', pick: { carrier: 'progressive', code: 'UT', dismissed: null }, intakeId: 'intake-1' });
  context.dismissState();
  assert.equal(pick.dismissed, 'intake-1|UT');
  assert.equal(context.stateIssue(), null);
  assert.equal(drawn, 2, 'the note and the steps (and the dock) are drawn again');
  // Nothing to dismiss: nothing changes.
  context.dismissState();
  assert.deepEqual([pick.dismissed, drawn], ['intake-1|UT', 2]);
  // Another intake hears it again; so does this one, for another pick.
  session.intakeId = 'intake-2';
  assert.equal(context.stateIssue()?.picked, 'Utah');
  session.intakeId = 'intake-1';
  pick.code = 'VA';
  assert.equal(context.stateIssue()?.picked, 'Virginia');
});

// W43-40 (a list page with nothing left and no Continue to click yet) and W43-42 (Progressive's
// Business Owner Info filled before it drew its questions, "No questions found on this page."):
// the page is filled once more in a moment, once per page and step, and its report says nothing
// until then.
test('a page still drawing, or done with no Continue to click yet, is filled once more and said nothing of until then', () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'VehicleSummary'), carrier: { id: 'progressive' } };
  h.state.intake = { record: {} };
  h.state.autoPages.add('VehicleSummary');
  const opts = { page: 'VehicleSummary', auto: 'page', intake: h.state.intake, revision: undefined };
  assert.equal(h.rememberFill([{ fields: 0, filled: [], advanceDue: 'none' }], opts), true);
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].ms, 1500);
  // Due again on the same page: not tried a third time.
  assert.equal(h.rememberFill([{ fields: 0, filled: [], advanceDue: 'none' }], opts), false);
  assert.equal(h.scheduled.length, 1);
  // A fill there that found neither lets a later one try again.
  assert.equal(h.rememberFill([{ fields: 0, filled: [] }], opts), false);
  assert.equal(h.rememberFill([{ fields: 0, filled: [], notDrawn: true }], opts), true);
  // Halted or continued: never.
  assert.equal(h.rememberFill([{ fields: 0, filled: [] }], opts), false);
  assert.equal(h.rememberFill([{ fields: 0, filled: [], notDrawn: true, halted: true, reason: 'x' }], opts), false);
  assert.equal(h.rememberFill([{ fields: 0, filled: [], advanceDue: 'none', advanced: 'Continue' }], opts), false);

  // The report: nothing while it is tried again; a page still empty after that says so.
  const state = { tab: { id: 7, url: 'BusinessOwnerInfo' } };
  const { context } = reportHarness(state);
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [], notDrawn: true }], { retrying: true });
  assert.equal(state.reportFor, undefined);
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [], notDrawn: true }], { retrying: false });
  assert.match(state.reportFor.notice, /No questions found on this page/);
});

test('a page with nothing to fill and nothing left offers Continue, a fill that replaces nothing', () => {
  const dock = extractFunction('dockFor');
  assert.match(dock, /if \(report\?\.empty\) return continueSaid\(\{ \.\.\.report, tabId: state\.tab\.id \}, carrier\);/);
  assert.ok(dock.indexOf('report?.empty') < dock.indexOf('if (report?.fields)'), 'before the page-with-questions word');
  assert.match(SIDEPANEL, /\$\('fill'\)\.addEventListener\('click', \(\) => fillPage\(\{ continuing: \$\('fill'\)\.dataset\.go === 'continue' \}\)\);/);
  assert.match(extractFunction('fillPage'), /const overwrite = auto \|\| confirmed \|\| continuing \? false : \$\('overwrite'\)\.checked;/);
  assert.match(extractFunction('renderDock'), /\$\('fill'\)\.dataset\.go = d\.go \?\? '';/);
});

// W43-40: GEICO's Looks Good was never clicked on a list that needed a VIN or name read; the log
// says, in counts, what the list showed when it isn't read as complete.
test('a unit list not read as complete is said in counts in the usage log', async () => {
  const run = async (lists, unitForms = {}) => {
    const record = { vehicles: [{ vin: '1FTBR3X80MKA12341' }, { vin: '1FTBR3X80MKA12342' }], trailers: [], drivers: [] };
    const state = { tab: { id: 4 }, intake: { record }, intakeRevision: 1, active: { vehicles: 1, drivers: 0, trailers: 0 },
      unitForms: { vehicles: {}, drivers: {}, trailers: {}, ...unitForms }, doneActions: new Set() };
    const context = { state, knownStep, runKit: async () => [{ result: { step: 'Vehicles', forms: [], lists } }], fillCurrent: () => true,
      persistDoneActions: () => {}, save: async () => {}, renderPickers: () => {}, unitToAdd, unitListSpecs, unitMissing, buildPlan };
    vm.runInNewContext(extractFunction('pickUnitToAdd'), context);
    const ctx = { tabId: 4, intake: state.intake, revision: 1, settings: { autoAdvance: true } };
    await context.pickUnitToAdd(geico, ctx);
    return [ctx.unitsListed, ctx.listNote];
  };
  assert.deepEqual(await run([{ rows: 2, shown: [true, false] }, null]), [false, 'list: 2 rows for 2 units, 1 shown, 0 saved by a fill']);
  assert.deepEqual(await run([{ rows: 2, shown: [true, false] }, null], { vehicles: { B: 1 } }), [true, null], 'vehicle 2 saved by a fill');
  assert.deepEqual(await run([{ rows: 1, shown: [true, false] }, null]), [false, null], 'a unit still to add: no word');
  // Logged with the fill's own blockers, nothing else added.
  const logged = [];
  const context = { usage: { log: (...e) => logged.push(...e), currentSession: () => null }, state: {}, redactor: () => (t) => t, redactionTerms: () => [], rulesVersion: null, fillEvents, knownStep };
  vm.runInNewContext(extractFunction('logFill'), context);
  context.logFill({ carrier: { id: 'geico' }, intake: { record: {} }, page: '/quote', view: 't1', run: 'r', settings: {}, listNote: 'list: 2 rows for 2 units, 1 shown, 0 saved by a fill' },
    [{ fields: 0, filled: [], blockers: [], advanceDue: 'none' }], [{ frameId: 0, result: { stepKey: 'Vehicles' } }], Date.now());
  const run_ = logged.find((e) => e.type === 'fill_run');
  assert.deepEqual([...run_.blockerList], ['list: 2 rows for 2 units, 1 shown, 0 saved by a fill', 'continue: none to click']);
  assert.equal(run_.blockers, 1);
  assert.equal(run_.fields, 0);
});

// W43-42 (Progressive, 2026-10-22): a 29-second automatic follow-up fill showed no rows until it
// ended. An automatic fill is watched as the agent's is; its rows show from the first answer in.
test('an automatic fill lists its answers as they go in, from the first one', async () => {
  const t = fillHarness();
  let watched = null;
  t.context.watchFill = (ctx) => { watched = ctx.run; return () => { watched = `${watched}:stopped`; }; };
  const run = t.context.autoFill('/quote-A');
  await t.started;
  const f = t.state.fillingFor;
  assert.deepEqual([f?.auto, f?.tabId, watched === f?.run], [true, 7, true]);
  t.release(t.results);
  await run;
  assert.equal(t.state.fillingFor, null);
  assert.match(watched, /:stopped$/);
  // Shown once a row is in, never for a follow-up that has answered nothing yet.
  const ui = { live: { hidden: true, dataset: {}, replaceChildren() {}, drawn: [] } };
  const state = { filling: true, tab: { id: 7 }, fillingFor: { auto: true, tabId: 7, rows: [] } };
  const context = { state, $: (id) => ui[id] };
  vm.runInNewContext(extractFunction('renderLive'), context);
  context.renderLive();
  assert.equal(ui.live.hidden, true);
  assert.match(extractFunction('renderLive'), /const on = !!f && state\.filling && f\.tabId === state\.tab\?\.id && \(!f\.auto \|\| !!f\.rows\?\.length\);/);
  assert.match(extractFunction('dockFor'), /if \(state\.filling && f\?\.tabId === state\.tab\.id && \(!f\.auto \|\| !!f\.rows\?\.length\)\) \{/);
});

test('the business profile is logged on load, after a correction settles, and on opening, only when it changed', async () => {
  const { intakeProfile, redactor } = await import('../src/usage.js');
  const { redactionTerms } = await import('../src/plan.js');
  const logged = [];
  const timers = [];
  const record = { applicant: { name: 'Sample Co' }, garaging: { state: 'TX' }, operations: { businessClass: 'Freight Hauler' }, drivers: [], vehicles: [], trailers: [], coverage: {} };
  const sandbox = {
    state: { intake: { record } }, PROFILE_DELAY: 15_000, profileTimer: null, intakeProfile, redactor, redactionTerms,
    usage: { currentSession: () => ({ id: 's1' }), log: (e) => logged.push(e) },
    save: async () => logged.push('save'),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(['logProfile', 'profileLater'].map(extractFunction).join('\n'), sandbox);
  assert.equal(sandbox.logProfile(), true);
  assert.equal(logged[0].type, 'intake_profile');
  assert.equal(logged[0].business.state, 'TX');
  assert.equal(sandbox.logProfile(), false, 'the same profile again is not logged');
  record.garaging.state = 'OK';
  sandbox.profileLater();
  assert.equal(timers.at(-1).ms, 15_000, 'a correction waits for the agent to finish');
  timers.at(-1).fn();
  await Promise.resolve();
  assert.deepEqual([logged.length, logged[1].business.state, logged[2]], [3, 'OK', 'save'], 'the corrected profile, then saved with the intake');
  sandbox.usage.currentSession = () => null;
  record.garaging.state = 'KS';
  assert.equal(sandbox.logProfile(), false, 'no quote session, nothing logged');

  // One still waiting stays with its own quote: logged before the intake is replaced or cleared.
  assert.match(extractFunction('loadFile'), /if \(profileTimer\) logProfile\(\);\n\s+if \(state\.intake\) usage\.log\(\{ type: 'intake_closed', reason: reset \? 'reset' : 'replaced' \}\);/);
  assert.match(extractFunction('loadFile'), /await logSettings\('intake'\);\n\s+logProfile\(\);/);
  assert.match(extractFunction('clearClient'), /if \(profileTimer\) logProfile\(\);\n\s+usage\.log\(\{ type: 'intake_closed', reason: 'cleared' \}\);/);
  assert.match(extractFunction('agentEdit'), /usage\.log\(\{ type: 'intake_edit'[^\n]*\n\s+profileLater\(\);/);
  assert.match(extractFunction('init'), /logSettings\('opened'\);\n[^\n]*\n\s+if \(logProfile\(\)\) save\(\);/);
});

// Review of PR #149: the wiring above was checked by its order only. Here loadFile runs, with timers
// that really cancel: a correction's profile still waiting when another intake is loaded is logged
// under its own quote, before that quote is closed, and no timer outlives the switch.
test('a profile still waiting when another intake is loaded goes to its own quote, and its timer is gone', async () => {
  const { intakeProfile, redactor } = await import('../src/usage.js');
  const { redactionTerms } = await import('../src/plan.js');
  const records = { a: { garaging: { state: 'TX' }, drivers: [], vehicles: [], trailers: [] }, b: { garaging: { state: 'FL' }, drivers: [], vehicles: [], trailers: [] } };
  let loading = 'a', session = null, n = 0;
  const logged = [];
  const timers = new Map();
  const state = { intake: null, tabSessions: new Map(), layoutPending: null, aiCache: new Map() };
  const context = { state, doneRestored: new Set(), DEFAULT_MODEL: 'gpt-6-luna', POLICY_VERSION: 'policy',
    aiFingerprint: JSON.stringify, aiSafeText: String, aiPersistQueue: Promise.resolve(), aiRetiredSignatures: new Set(),
    aiPendingStore: { get: async () => [], set: async () => {} },
    usage: { currentSession: () => session, startSession: (intakeId) => (session = { id: `s${++n}`, intakeId }), log: (e) => logged.push({ ...e, session: session?.id }) },
    $: () => ({}), pdfjs: {}, readIntakeFields: async () => ({ synthetic: true }), readIntakePlaces: async () => null, keepPdf: async () => {},
    normalizeIntake: () => ({ record: records[loading], warnings: [] }), intakeSummary: async () => ({ intakeId: loading }),
    store: { set: async () => {} }, pruneAgentRecords: async () => [], testIntakes: { get: async () => [] }, logSettings: async () => {}, platformOf: () => ({ os: null, chrome: null }), uploadNow() {},
    save: async () => {}, render() {}, refreshTab() {}, reviewClaimsBox() {}, reviewIntake() {}, dropReports() {}, clientNote() {},
    PROFILE_DELAY: 15_000, profileTimer: null, intakeProfile, redactor, redactionTerms,
    setTimeout: (fn) => { timers.set(timers.size + 1, fn); return timers.size; }, clearTimeout: (id) => timers.delete(id) };
  vm.runInNewContext(['aiOriginRecord', 'aiCacheSignature', 'aiPendingRecord', 'aiDecisionBlocks', 'persistAiPending', 'restoreAiPending',
    'discardAiSuggestions', 'cancelLayouts', 'holdLayouts', 'resetViews', 'saveViews', 'loadFile', 'keepWork', 'workSaid', 'logProfile', 'profileLater', 'firstView'].map(extractFunction).join('\n'), context);
  const pdf = { name: 'synthetic.pdf', arrayBuffer: async () => new ArrayBuffer(1) };
  await context.loadFile(pdf);
  records.a.garaging.state = 'OK';
  context.profileLater();
  assert.equal(timers.size, 1, 'the corrected profile waits');
  loading = 'b';
  await context.loadFile(pdf);
  const seen = logged.filter((e) => ['intake_loaded', 'intake_profile', 'intake_closed'].includes(e.type)).map((e) => [e.type, e.session, e.business?.state ?? null]);
  assert.deepEqual(seen, [
    ['intake_loaded', 's1', null], ['intake_profile', 's1', 'TX'],
    ['intake_profile', 's1', 'OK'], ['intake_closed', 's1', null],
    ['intake_loaded', 's2', null], ['intake_profile', 's2', 'FL'],
  ]);
  assert.equal(timers.size, 0, 'no timer outlives the switch');
});

// Developer recording (docs/developer-recording.md): the trace goes into the recorded tab only, with
// the recorder whose readers it uses, and not once the recording is stopping.
test('the developer recording\'s trace is injected with the recorder, into the recorded tab only', async () => {
  const injected = [];
  const state = { intake: {}, tab: { id: 4, carrier: { id: 'geico' } }, filling: false, recording: null };
  const context = { state, inExtension: true, tellRecorder: async () => {},
    chrome: { scripting: { executeScript: async ({ target, files }) => { injected.push([target.tabId, files.map((f) => f.split('/').pop())]); } } } };
  vm.runInNewContext(extractFunction('ensureRecorder'), context);
  await context.ensureRecorder();
  state.recording = { tabId: 4, stopping: false };
  await context.ensureRecorder();
  state.tab = { id: 5, carrier: { id: 'geico' } };
  await context.ensureRecorder();
  state.tab = { id: 4, carrier: { id: 'geico' } };
  state.recording.stopping = true;
  await context.ensureRecorder();
  assert.deepEqual(JSON.parse(JSON.stringify(injected)), [
    [4, ['field-key.js', 'recorder.js']],
    [4, ['field-key.js', 'recorder.js', 'trace.js']],
    [5, ['field-key.js', 'recorder.js']],
    [4, ['field-key.js', 'recorder.js']],
  ]);
});

test('the panel keeps only the recorded tab\'s trace events, redacted with their frame and a fill by their time, and says it took them', () => {
  const kept = [];
  const state = { filling: false, recording: null };
  const steps = [];
  const context = { state, knownStep: (carrier, s) => { steps.push([carrier.id, s]); return null; },
    stampEvents: (events, opts) => events.map((e) => ({ ...e, frame: opts.frame, filling: opts.fillingAt(e.t), step: opts.stepName(e.step ?? ''), label: opts.redact(e.label) })) };
  vm.runInNewContext(extractFunction('onTraceMessage'), context);
  const replies = [];
  const send = (msg, tabId, frameId = 0) => context.onTraceMessage(msg, { tab: { id: tabId }, frameId }, (r) => replies.push(r));
  send({ ra: 'trace', events: [{ kind: 'click', t: 1, label: 'x' }] }, 4);
  // A fill ran from 3 to 5: the panel gets the batch afterwards, and still dates each event.
  state.recording = { tabId: 4, carrier: { id: 'progressive' }, fills: [{ start: 3, end: 5 }], redact: (s) => s.replace('Sam', '[client]'), store: { add: (events) => kept.push(...events) } };
  send({ ra: 'trace', events: [{ kind: 'click', t: 2, label: 'Sam' }] }, 5);
  send({ ra: 'usage', events: [{ kind: 'click', t: 3, label: 'Sam' }] }, 4);
  send({ ra: 'trace', events: [{ kind: 'click', t: 4, label: 'Sam', step: 'About Sam' }, { kind: 'click', t: 6, label: 'x' }], dropped: 3 }, 4, 2);
  assert.deepEqual(kept.map((e) => [e.kind, e.t < 10 ? e.t : 'now', e.frame, e.filling ?? null, e.label ?? null, e.dropped ?? null]), [
    ['click', 4, 2, true, '[client]', null], ['click', 6, 2, false, 'x', null], ['gap', 'now', 2, null, null, 3],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(steps.filter(([, s]) => s))), [['progressive', 'About Sam']], 'steps go through the carrier\'s step names');
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ ok: true }], 'only the batch it kept is answered');
  const html = fs.readFileSync(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="devrec" class="devrec" hidden>/, 'hidden until the panel sees a build that may record');
  assert.match(SIDEPANEL, /\$\('devrec'\)\.hidden = !inExtension \|\| !canRecord\(usage\.build\(\)\.channel\);/);
});

// Review of PR #166: the developer recording ends with its client and its panel, and starts clean.
test('a panel that pops out or docks stops and saves its recording first', async () => {
  const done = [];
  const state = { closing: false, fillingFor: null, filling: false, recording: { tabId: 4 } };
  const context = { state, stopFill: async () => {}, stopRecording: async (why) => { done.push(['stop', why]); state.recording = null; },
    handOver: async () => done.push(['handOver']), closeSelf: () => done.push(['close']), Date, setTimeout };
  vm.runInNewContext(extractFunction('giveWay'), context);
  await context.giveWay('window');
  assert.deepEqual(done.map(([what]) => what), ['stop', 'handOver', 'close']);
  assert.match(done[0][1], /recording stopped/);
});

test('a new recording first stops a trace a closed panel left in the tab', async () => {
  const done = [];
  const state = { recording: null, tab: { id: 4, carrier: { id: 'progressive' } }, intake: { record: {}, test: false }, filling: false };
  const context = { state, $: () => ({ value: '' }), redactor: () => (s) => s, redactionTerms: () => [], recordingId: () => 'progressive-x', newManifest: (m) => m,
    usage: { build: () => ({}), currentSession: () => null }, RecordingStore: { start: async () => { done.push('store'); return {}; } },
    setInterval: () => 1, renderDevrec() {}, devrecSaid() {}, ensureRecorder: async () => { done.push('inject'); },
    chrome: { tabs: { sendMessage: async (tabId, msg) => { done.push(`${msg.ra}:${msg.cmd}:${tabId}`); } } } };
  vm.runInNewContext(extractFunction('startRecording'), context);
  await context.startRecording();
  assert.deepEqual(done, ['trace:stop:4', 'store', 'inject']);
});

test('a recording kept in memory only that could not be saved is said to be lost, not kept', async () => {
  const said = [];
  const store = { durable: false, manifest: { id: 'progressive-x' }, zip: async () => { throw new Error('no space'); } };
  const context = { devrecSaid: (s) => said.push(s), renderUnfinished: async () => {} };
  vm.runInNewContext(extractFunction('saveRecording'), context);
  await context.saveRecording(store);
  assert.doesNotMatch(said[0], /stays in the browser/);
  assert.match(said[0], /lost/);
});

test('loading another client\'s intake stops and saves the recording, redacted with the first client\'s', async () => {
  const { redactor } = await import('../src/usage.js');
  const { redactionTerms } = await import('../src/plan.js');
  const records = { a: { garaging: { state: 'TX' }, drivers: [], vehicles: [], trailers: [] }, b: { garaging: { state: 'FL' }, drivers: [], vehicles: [], trailers: [] } };
  let loading = 'a', session = null, n = 0;
  const stopped = [];
  const state = { intake: null, tabSessions: new Map(), layoutPending: null, aiCache: new Map(), recording: null };
  const context = { state, doneRestored: new Set(), DEFAULT_MODEL: 'gpt-6-luna', POLICY_VERSION: 'policy',
    aiFingerprint: JSON.stringify, aiSafeText: String, aiPersistQueue: Promise.resolve(), aiRetiredSignatures: new Set(),
    aiPendingStore: { get: async () => [], set: async () => {} },
    usage: { currentSession: () => session, startSession: (intakeId) => (session = { id: `s${++n}`, intakeId }), log() {} },
    $: () => ({}), pdfjs: {}, readIntakeFields: async () => ({ synthetic: true }), readIntakePlaces: async () => null, keepPdf: async () => {},
    normalizeIntake: () => ({ record: records[loading], warnings: [] }), intakeSummary: async () => ({ intakeId: loading }),
    store: { set: async () => {} }, pruneAgentRecords: async () => [], testIntakes: { get: async () => [] }, logSettings: async () => {}, platformOf: () => ({ os: null, chrome: null }), uploadNow() {},
    save: async () => {}, render() {}, refreshTab() {}, reviewClaimsBox() {}, reviewIntake() {}, dropReports() {}, clientNote() {},
    PROFILE_DELAY: 15_000, profileTimer: null, intakeProfile: () => null, redactor, redactionTerms, logProfile() {}, profileLater() {},
    stopRecording: async (why) => { stopped.push([why, state.intake?.record.garaging.state]); state.recording = null; },
    setTimeout: () => 1, clearTimeout() {} };
  vm.runInNewContext(['aiOriginRecord', 'aiCacheSignature', 'aiPendingRecord', 'aiDecisionBlocks', 'persistAiPending', 'restoreAiPending',
    'discardAiSuggestions', 'cancelLayouts', 'holdLayouts', 'resetViews', 'saveViews', 'loadFile', 'keepWork', 'workSaid', 'firstView'].map(extractFunction).join('\n'), context);
  const pdf = { name: 'synthetic.pdf', arrayBuffer: async () => new ArrayBuffer(1) };
  await context.loadFile(pdf);
  state.recording = { tabId: 4 };
  // The same PDF again keeps the recording: the same client.
  await context.loadFile(pdf);
  assert.deepEqual(stopped, []);
  loading = 'b';
  await context.loadFile(pdf);
  assert.equal(stopped.length, 1);
  assert.match(stopped[0][0], /recording stopped/);
  assert.equal(stopped[0][1], 'TX', 'stopped while the first client was still the intake');
});

// Live recording, 2026-10-23 (Progressive): the agent clicked View bill plan options themselves, the
// panel only logged it, and back on Rates the fill clicked it again: the payment plan page twice.
test('a quote-wide helper the agent clicks themselves is done, as if the fill had clicked it', () => {
  const plan = progressive.actions.map((a) => ({ kind: 'action', action: a.scope ? `${a.id}:0` : a.id, baseAction: a.id, pages: [].concat(a.page ?? []),
    steps: a.steps ?? null, text: typeof a.text === 'function' ? null : a.text ?? null, near: a.near ?? null, token: a.token ?? null, within: a.within ?? null,
    opener: a.opener ?? null, unique: !!a.unique, needsRecalculation: !!a.needsRecalculation }));
  const run = (page, text) => {
    const state = { intake: { record: {} }, active: { vehicles: 0, drivers: 0, trailers: 0 }, doneActions: new Set() };
    let saved = 0;
    const context = { state, buildPlan: () => plan, persistDoneActions: () => { saved++; } };
    vm.runInNewContext(extractFunction('agentHelperDone'), context);
    context.agentHelperDone(progressive, page, undefined, text);
    return [[...state.doneActions], saved];
  };
  // The words of the live run's buttons.
  assert.deepEqual(run('CoveragesRates', 'View bill plan options'), [['billPlan'], 1]);
  assert.deepEqual(run('CoveragesRates', 'Print, Email, Fax'), [['print'], 1]);
  // Recalculate is due by the rates on the page; "+" and Done with this coverage are cargo's or general
  // liability's; Add Vehicle
  // may be another vehicle's; another page's button reading the same is not this one.
  for (const [page, text] of [['CoveragesRates', 'Recalculate'], ['CoveragesRates', '+'], ['CoveragesRates', 'Done with this coverage'], ['VehicleSummary', 'Add Vehicle'], ['ChangePaymentPlan', 'View bill plan options'], ['CoveragesRates', 'Continue']]) {
    assert.deepEqual(run(page, text), [[], 0], `${page}: ${text}`);
  }
});

// A cargo-only quote has one Done with this coverage in its plan (general liability's isn't asked
// for): the agent's click of another coverage's Done, or one Progressive refused, isn't cargo closed.
// The fill's own click counts only once its check (`verify: cargoClosed`) passes.
test('a helper the fill checks after its click is not done by the agent clicking its words', () => {
  // (Nor an NTL quote's Done, doneNtl: not in a cargo quote's plan.)
  const plan = progressive.actions.filter((a) => !['openGl', 'doneGl', 'doneNtl'].includes(a.id)).map((a) => ({ kind: 'action', action: a.id, baseAction: a.id,
    pages: [].concat(a.page ?? []), steps: null, text: typeof a.text === 'function' ? null : a.text ?? null, near: a.near ?? null, token: a.token ?? null,
    within: a.within ?? null, opener: a.opener ?? null, unique: !!a.unique, needsRecalculation: !!a.needsRecalculation, verify: a.verify ?? null }));
  const state = { intake: { record: {} }, active: { vehicles: 0, drivers: 0, trailers: 0 }, doneActions: new Set() };
  const context = { state, buildPlan: () => plan, persistDoneActions: () => {} };
  vm.runInNewContext(extractFunction('agentHelperDone'), context);
  context.agentHelperDone(progressive, 'CoveragesRates', undefined, 'Done with this coverage');
  assert.deepEqual([...state.doneActions], []);
  context.agentHelperDone(progressive, 'CoveragesRates', undefined, 'View bill plan options');
  assert.deepEqual([...state.doneActions], ['billPlan']);
});

// The maintainer, 2026-10-23: on GEICO's last steps, in a short popped-out window, the header and the
// client strip went out of view, and the panel began at the answers. A hidden overflow is still a
// scroll container, and a focus() or scrollIntoView() scrolled the body once the header, the client
// strip and the dock outgrew the window. The body is clipped, so nothing can scroll it; the dock
// gives way (and scrolls) instead, and the middle keeps a minimum.
test('nothing scrolls the panel\'s body: it is clipped, and the dock shrinks before the header goes', () => {
  const css = fs.readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');
  const start = css.indexOf('\nbody {');
  const body = css.slice(start, css.indexOf('\n}', start));
  assert.match(body, /overflow: clip;/);
  assert.doesNotMatch(body, /overflow: hidden/);
  assert.match(css, /\.foot \{ flex: 0 1 auto; min-height: 0; overflow-y: auto;/);
  assert.match(css, /\.view \{ position: relative; flex: 1; min-height: 96px;/);
  // W44-10 (AmWINS' declaration, 2026-10-26): body's overflow passes to the viewport, where clip is
  // hidden, which code still scrolls; html is clipped too. The middle is positioned, so the
  // screen-reader text in its rows (absolutely placed) doesn't make the document taller than the
  // window (npm run e2e:extension fails if the panel's document scrolls).
  assert.match(css, /\nhtml \{[^}]*overflow: clip;/);
  // The PDF sheet is a column: its hint row comes and goes with a marked item, and with fixed grid
  // rows the whole-PDF view (no hint) had the footer over the page controls (zoom unreachable).
  assert.match(css, /\.sheet-panel \{[^}]*display: flex; flex-direction: column;/);
  assert.doesNotMatch(css, /grid-template-rows: auto auto minmax\(0, 1fr\) auto auto/);
  assert.match(css, /\.pdf-scroll \{ flex: 1 1 auto; min-height: 0; overflow: auto;/);
});

// The intake PDF opened at 200%, and at a side panel's width the agent scrolled sideways to find
// anything (the maintainer, 2026-10-23). It opens at the panel's width; a marked item still at 200%;
// the page drags with the mouse and zooms with Ctrl + wheel.
test('the PDF opens at the panel\'s width, a marked item at 200%, and drags or zooms with the wheel', () => {
  assert.match(SIDEPANEL, /const PDF_OPEN_ZOOM = 1;/);
  assert.match(SIDEPANEL, /const PDF_FOCUS_ZOOM = 2;/);
  const pan = extractFunction('pdfPan');
  assert.match(pan, /addEventListener\('pointerdown'/);
  assert.match(pan, /scroll\.scrollLeft = drag\.left - \(e\.clientX - drag\.x\);/);
  assert.match(pan, /addEventListener\('wheel', \(e\) => \{\s+if \(!\(e\.ctrlKey \|\| e\.metaKey\) \|\| !state\.pdf\) return;\s+e\.preventDefault\(\);/);
  assert.match(extractFunction('wire'), /pdfPan\(\$\('pdf-scroll'\)\);/);
});

// The client strip (the maintainer, 2026-10-23): Change file and Clear were behind a ⋯ menu (three
// clicks to start the next client); the name card opens the client details, and the file tools are
// buttons in view, with New quote with this intake beside them. The steps name the intake, then the
// page in front filled and reviewed: "Confirm" read as the quote's end on every page.
test('the client strip: the name opens client details, and Change file, New quote and Clear are buttons in view, no menu', () => {
  const html = fs.readFileSync(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /<button type="button" id="client-card" class="client-title" aria-controls="details-view"/);
  assert.match(html, /<span id="client-name" class="client-name"><\/span>\s+<span id="client-meta" class="client-meta"><\/span>\s+<\/button>/, 'phrasing content in the button, not a heading');
  const toolsAt = html.indexOf('<div class="client-tools">');
  const tools = html.slice(toolsAt, html.indexOf('</div>', toolsAt));
  for (const id of ['open-pdf', 'replace', 'new-quote', 'clear-client']) assert.match(tools, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /file-menu-btn|details-btn|⋯/);
  assert.match(extractFunction('wire'), /\$\('client-card'\)\.addEventListener\('click', \(\) => \(state\.detailsOpen \? closeDetails\(\) : openDetails\(\)\)\);/);
  assert.match(extractFunction('showScreen'), /\['client-card', 'details-row'\]/);
  assert.match(extractFunction('askFile'), /state\.fileConfirmFrom = from;/, 'Cancel gives focus back to the button that asked');
  assert.match(extractFunction('renderSteps'), /\$\('new-quote'\)\.disabled = !!state\.filling;/);
  assert.match(html, /<span class="step-label">Intake<\/span>[\s\S]*<span class="step-label">Fill page<\/span>[\s\S]*<span class="step-label">Review page<\/span>/);
});

// New quote with this intake: the agent quotes the same client on the next carrier, or again, and
// this quote's fills, marks and clicks must not carry over (a report "from the fill at 10:12" on a
// page reached again in the same tab, a vehicle taken as already added), while the intake and their
// corrections stay. The kept PDF is loaded again as the same file (loadFile keeps the work on the
// same intake), after the page's marks and this intake's per-tab records go.
test('New quote with this intake loads the kept PDF again as the same file, after the page marks and this intake\'s tab records go', async () => {
  const calls = [];
  const state = { intake: { fileName: 'client.pdf', ntlAdded: true }, filling: false, tab: { id: 4, carrier: { id: 'geico' } }, tabSessions: new Map() };
  const context = { state, inExtension: true, File: class { constructor(parts, name, opts) { Object.assign(this, { parts, name, type: opts?.type }); } },
    intakePdfBytes: async () => new Uint8Array([1, 2]), usage: { currentSession: () => ({ intakeId: 'abc' }) },
    runKit: async (tabId) => { calls.push(['clear', tabId]); return []; }, clearAgentKeys: async (scope) => { calls.push(['keys', scope]); },
    loadFile: async (file, opts) => { calls.push(['load', file.name, file.type, opts]); }, clientNote: (t) => calls.push(['note', t]) };
  vm.runInNewContext(extractFunction('newQuote'), context);
  await context.newQuote();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['clear', 4], ['keys', 'abc'], ['load', 'client.pdf', 'application/pdf', { reset: true }]]);
  assert.equal(state.intake.ntlAdded, false, 'NTL is added again on the new quote');
  // While answers go in, or without the PDF kept: said, nothing done.
  calls.length = 0;
  state.filling = true;
  await context.newQuote();
  state.filling = false;
  context.intakePdfBytes = async () => null;
  await context.newQuote();
  assert.deepEqual(calls.map((c) => c[0]), ['note', 'note']);
  // Asked first, under the client's name; loadFile says what stays and logs the reset.
  assert.match(extractFunction('wire'), /\$\('new-quote'\)\.addEventListener\('click', \(\) => \{\s+if \(state\.filling\) return;\s+askFile\('new-quote'/);
  assert.match(extractFunction('wire'), /if \(what === 'new-quote'\) newQuote\(\);/);
  assert.match(extractFunction('loadFile'), /reset \? 'New quote with the same intake' : 'Same intake'/);
});

// Client details: 96 fields on the sample intake, 44 px each, a third of them blank; the drawer was
// too long to scroll (the maintainer, 2026-10-23). Dense rows, sections that fold, and the blank
// fields hidden unless flagged, behind "Show N empty fields"; Show in client details brings one out.
test('client details hide the fields the intake leaves blank unless flagged, fold by section, and a jump brings a hidden field out', () => {
  const css = fs.readFileSync(new URL('../sidepanel/sidepanel.css', import.meta.url), 'utf8');
  assert.match(css, /\.drawer\[data-empty="hidden"\] \.field\.empty:not\(\.flagged\) \{ display: none; \}/);
  assert.match(css, /\.field \{[^}]*min-height: 30px;/);
  const sections = extractFunction('renderSections');
  assert.match(sections, /h\('details', \{ class: `section\$\{allEmpty \? ' all-empty' : ''\}`, open: !state\.detailsClosed\.has\(section\.id\)/);
  assert.match(sections, /\$\('details-view'\)\.dataset\.empty = state\.showEmpty \? 'shown' : 'hidden';/);
  assert.match(sections, /`Show \$\{hidden\} empty field\$\{hidden === 1 \? '' : 's'\}`/);
  assert.match(extractFunction('jumpTo'), /if \(!state\.showEmpty && row\.classList\.contains\('empty'\) && !row\.classList\.contains\('flagged'\)\) \{\s+state\.showEmpty = true;\s+renderSections\(\);/);
  assert.match(extractFunction('jumpTo'), /if \(section instanceof HTMLDetailsElement\) section\.open = true;/);
});

// The end of a GEICO quote read like every other page: "Ready", "Moving on is yours" (the maintainer,
// 2026-10-23). Where TNI stops on a rater (the carrier's `finishedBy` action clicked on its step, nothing
// left for the agent), the dock and the strip say the quote is done.
test('the quote is done where TNI stops on the rater: the finishing action clicked on its step, nothing left', () => {
  const geicoLike = { name: 'GEICO', finishedBy: 'printProposal', actions: [{ id: 'printProposal', steps: ['Quote & Coverages'] }], advance: { text: 'Next', steps: ['Vehicles'] }, layoutSteps: ['Vehicles', 'Quote & Coverages'] };
  const done = new Set(['recalculate', 'printProposal']);
  // extractFunction brings the panel's own tabStep along: the step comes from state.tabSteps.
  const context = { state: { tab: { id: 7, url: 'quote' }, doneActions: done, tabSteps: new Map([[7, 'Quote & Coverages']]) }, pageOf: (u) => u };
  vm.runInNewContext(extractFunction('quoteFinished'), context);
  const report = { fields: 12, filled: 12, left: 0, waiting: 0 };
  assert.equal(context.quoteFinished(geicoLike, report), true);
  assert.equal(context.quoteFinished(geicoLike, { ...report, left: 1 }), false, 'something left for the agent');
  assert.equal(context.quoteFinished(geicoLike, { ...report, waiting: 1 }), false, 'a button left to click');
  assert.equal(context.quoteFinished(geicoLike, report, 'quote', 'Vehicles'), false, 'another step\'s report');
  assert.equal(context.quoteFinished(geicoLike, report, 'quote', 'Quote & Coverages', new Set(['recalculate'])), false, 'not printed yet');
  assert.equal(context.quoteFinished({ name: 'Progressive', actions: [] }, report), false, 'no finishing action on this rater');
  const prog = { name: 'Progressive', finishedBy: 'print', actions: [{ id: 'print', page: 'CoveragesRates' }] };
  assert.equal(context.quoteFinished(prog, report, 'CoveragesRates', undefined, new Set(['print'])), true);
  assert.equal(context.quoteFinished(prog, report, 'Drivers', undefined, new Set(['print'])), false, 'another page\'s report');
  // The dock says so, with Fill this page again beside it; the strip's Review page says Quote done.
  const d = dockHarness({ carrier: geicoLike, step: 'Quote & Coverages', extra: { showReport: () => report, quoteFinished: context.quoteFinished } });
  d.state.doneActions = done;
  const word = d.dock();
  assert.deepEqual([word.phase, word.eyebrow, word.title, word.button ?? null, word.alt], ['finished', 'Quote done', 'The quote proposal is printed', null, 'fill-again']);
  assert.equal(word.sub, 'This is where TNI stops on GEICO. Nothing is submitted or bound.');
  // (quoteFinished reads the done actions of the state it was extracted with: the same Set.)
  done.delete('printProposal');
  assert.equal(d.dock().phase, 'yours', 'not printed: moving on is the agent\'s, as before');
  assert.match(extractFunction('renderSteps'), /const finished = filled && quoteFinished\(carrier, report, page\) && !pendingAi\(state\.tab\.id, page\)\.length;[\s\S]*note: !filled \? 'After the fill' : finished \? 'Quote done'/);
  assert.equal(geico.finishedBy, 'printProposal');
  assert.ok(geico.actions.some((a) => a.id === 'printProposal' && a.steps.includes('Quote & Coverages')));
});

// A fill waiting on GEICO's Recalculate, the premium or a quiet page read as stuck on "Working…"
// (the maintainer, 2026-10-23). The kit says what it waits on (`phase`), the live list's last row
// says it, and the dock names the long waits.
test('the live list and the dock say what the kit waits on (its phase), and a phase alone redraws them', async () => {
  const context = {};
  vm.runInNewContext(extractFunction('phaseSaid'), context);
  const said = (phase, n) => [...context.phaseSaid(phase, n)];
  assert.deepEqual(said(null, 0), ['Reading the page', 'Working…']);
  assert.deepEqual(said(null, 3), ['Next answer', 'Working…']);
  assert.deepEqual(said({ name: 'premium' }), ['Waiting for the premium', 'The rater is rating the quote…']);
  assert.equal(context.phaseSaid({ name: 'helper', what: 'Recalculate' })[0], 'Clicked: Recalculate');
  assert.equal(context.phaseSaid({ name: 'waiting' })[0], 'Waiting for the page');
  assert.equal(context.phaseSaid({ name: 'continue' })[0], 'Clicking Continue');
  // watchFill keeps the phase with the rows, and a changed phase alone is a change.
  let tick = null;
  let reply = [];
  let renders = 0;
  const state = { fillingFor: { run: 'r1', filled: 0, rows: [] } };
  const wctx = { inExtension: true, state, worldFor: () => 'MAIN', renderSteps: () => { renders++; }, setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {},
    chrome: { scripting: { executeScript: async () => reply } } };
  vm.runInNewContext(extractFunction('watchFill'), wctx);
  wctx.watchFill({ run: 'r1', tabId: 3, carrier: {} });
  reply = [{ result: { frame: 'f', list: 'f:1', since: 0, rows: [], phase: { name: 'reading', what: null } } }];
  await tick();
  assert.deepEqual([JSON.parse(JSON.stringify(state.fillingFor.phase)), renders], [{ name: 'reading', what: null }, 1]);
  await tick();
  assert.equal(renders, 1, 'the same phase: nothing redrawn');
  reply = [{ result: { frame: 'f', list: 'f:1', since: 0, rows: [], phase: { name: 'premium', what: null } } }];
  await tick();
  assert.deepEqual([state.fillingFor.phase.name, renders], ['premium', 2]);
  // The dock names the long waits; the wait after each answer keeps "Just filled" (no flicker).
  assert.match(SIDEPANEL, /const DOCK_PHASES = new Set\(\['reading', 'helper', 'premium', 'continue'\]\);/);
  const d = dockHarness({ carrier: { name: 'GEICO', advance: { text: 'Next' } }, extra: { phaseSaid: context.phaseSaid, DOCK_PHASES: new Set(['reading', 'helper', 'premium', 'continue']) } });
  Object.assign(d.state, { filling: true, fillingFor: { tabId: 7, filled: 3, rows: [{ label: 'Liability' }], phase: { name: 'premium' } } });
  assert.equal(d.dock().title, 'Waiting for the premium…');
  d.state.fillingFor.phase = { name: 'waiting' };
  assert.equal(d.dock().title, 'Just filled: Liability');
  // The live list follows its last row only while the agent is at its end.
  assert.match(extractFunction('renderLive'), /const follow = !\(live\.drawn \?\? \[\]\)\.length \|\| view\.scrollHeight - view\.scrollTop - view\.clientHeight < 80;/);
  assert.match(extractFunction('renderLive'), /if \(follow\) live\.lastElementChild\?\.scrollIntoView\?\.\(\{ block: 'nearest' \}\);/);
});

// Review of PR #170: "Quote done" stayed after the agent changed the quote on the page once the
// proposal was printed (GEICO's Recalculate is clicked once a quote, so no fill re-rates or
// re-prints), and a fill the agent stopped after the print read as done too. The agent's change
// on the finishing step is marked with the done actions (`printProposal:changed`), until a fill
// clicks the action again.
test('an agent change on the finishing step after the print, or a stopped fill, is not "Quote done"', () => {
  const geicoLike = { name: 'GEICO', finishedBy: 'printProposal', actions: [{ id: 'printProposal', steps: ['Quote & Coverages'] }], layoutSteps: ['Vehicles', 'Quote & Coverages'] };
  const persisted = [];
  const state = { tab: { id: 7, url: 'quote' }, doneActions: new Set(['printProposal']), tabSteps: new Map([[7, 'Quote & Coverages']]) };
  const context = { state, pageOf: (u) => u, persistDoneActions: (tabId) => persisted.push(tabId) };
  vm.runInNewContext(['quoteFinished', 'noteChangedAfterDone'].map(extractFunction).join('\n'), context);
  const report = { fields: 12, filled: 12, left: 0, waiting: 0 };
  assert.equal(context.quoteFinished(geicoLike, report), true);
  assert.equal(context.quoteFinished(geicoLike, { ...report, stopped: true }), false, 'a fill the agent stopped');
  // A change on another step, or on a rater without a finishing action, marks nothing.
  assert.equal(context.noteChangedAfterDone(geicoLike, 'quote', 'Vehicles', 7), false);
  assert.equal(context.noteChangedAfterDone({ name: 'Progressive', actions: [] }, 'quote', 'Quote & Coverages', 7), false);
  assert.deepEqual([...state.doneActions], ['printProposal']);
  assert.equal(persisted.length, 0);
  // The agent changed a limit on Quote & Coverages after the print: marked, kept, not done.
  assert.equal(context.noteChangedAfterDone(geicoLike, 'quote', 'Quote & Coverages', 7), true);
  assert.deepEqual([...state.doneActions], ['printProposal', 'printProposal:changed']);
  assert.deepEqual(persisted, [7]);
  assert.equal(context.quoteFinished(geicoLike, report), false, 'the printed proposal is no longer the quote on the page');
  assert.equal(context.noteChangedAfterDone(geicoLike, 'quote', 'Quote & Coverages', 7), false, 'marked once');
  // Before the print, a change marks nothing.
  state.doneActions = new Set();
  assert.equal(context.noteChangedAfterDone(geicoLike, 'quote', 'Quote & Coverages', 7), false);
  // Wired: the recorder's field_changes by the agent on the tab in front; a fill that clicks the
  // action again lifts the mark; the strip asks about pending AI picks as the dock does.
  assert.match(SIDEPANEL, /const byAgent = msg\.changes\.filter\(\(c\) => c\.agent\);\s+if \(byAgent\.length\) \{\s+const page = samePage\(msg\.page\);\s+if \(noteChangedAfterDone\(state\.tab\.carrier, page, step, sender\.tab\.id\)\) renderSteps\(\);/);
  assert.match(SIDEPANEL, /for \(const a of frames\.flatMap\(\(f\) => f\.actions \?\? \[\]\)\) \{ maps\.doneActions\.add\(a\.id\); maps\.doneActions\.delete\(`\$\{a\.id\}:changed`\); \}/);
  assert.match(extractFunction('renderSteps'), /const finished = filled && quoteFinished\(carrier, report, page\) && !pendingAi\(state\.tab\.id, page\)\.length;/);
});

// Review of PR #170: a field the agent emptied in the drawer went with the blank ones (hidden at the
// next render, its focus with it), and a derived row vanished as the agent typed. The agent's own
// fields are never hidden, and a derived row that empties waits for the next render.
test('client details never hide a field the agent edited, and a derived row that empties stays until the next render', () => {
  const made = [];
  const fake = (tag, props = {}, ...children) => { const el = { tag, props, children, addEventListener() {}, removeAttribute() {}, setAttribute() {} }; made.push(el); return el; };
  const context = { state: { intake: { record: { x: { a: null, b: null, c: 'kept' } }, agentEdited: ['x.a'] } }, get: (o, p) => p.split('.').reduce((v, k) => v?.[k], o), h: fake, agentEdit() {}, parseEdit: (k, v) => v, fieldInfo };
  vm.runInNewContext(extractFunction('fieldRow'), context);
  const row = (path) => context.fieldRow(path, path, 'text', false).props.class;
  assert.equal(row('x.a'), 'field', 'emptied by the agent: shown');
  assert.equal(row('x.b'), 'field empty', 'blank on the intake: hidden unless flagged');
  assert.equal(row('x.c'), 'field');
  assert.match(extractFunction('agentEdit'), /if \(value != null\) row\.closest\('\.field'\)\?\.classList\.remove\('empty'\);/);
});

// TNI, 2026-10-27: the intake's dropdowns (business class, vehicle type, limits …) were plain text
// boxes in client details. They are the form's dropdown, a value off the list kept as written.
test('client details offer the intake form\'s dropdown options, and keep a value off the list', () => {
  const fake = (tag, props = {}, ...children) => ({ tag, props, children: children.flat(), addEventListener() {}, removeAttribute() {}, setAttribute() {} });
  const record = { operations: { businessClass: 'Expediter' }, vehicles: [{ type: 'Cargo Van' }], coverage: { autoLiabLimit: null }, drivers: [{ licenseState: 'TX' }], applicant: { name: 'X' } };
  const context = { state: { intake: { record, agentEdited: [] } }, get: (o, p) => p.split(/[.[\]]+/).filter(Boolean).reduce((v, k) => v?.[k], o), h: fake, agentEdit() {}, parseEdit: (k, v) => v, fieldInfo, STATES: { TX: 'Texas', MD: 'Maryland' } };
  vm.runInNewContext(extractFunction('fieldRow'), context);
  const input = (path) => { const { kind } = fieldInfo(path); return context.fieldRow(path, path, kind, false).children[1]; };
  const options = (el) => el.children.map((o) => [o.props.value, !!o.props.selected]);
  const cls = input('operations.businessClass');
  assert.equal(cls.tag, 'select');
  assert.deepEqual(options(cls).slice(0, 3), [['', false], ['Expediter', true], ['Freight Hauler', false]]);
  assert.deepEqual(options(input('vehicles[0].type')).slice(0, 3), [['', false], ['Cargo Van', true], ['Van', false]], 'off the list: kept, first');
  assert.deepEqual(options(input('coverage.autoLiabLimit')).filter(([, on]) => on), [], 'blank: nothing picked');
  assert.deepEqual(options(input('drivers[0].licenseState')), [['', false], ['TX', true], ['MD', false]]);
  assert.equal(input('applicant.name').tag, 'input', 'a text box stays one');
  // Every choice field has its list.
  for (const s of SECTIONS) for (const [path, , kind] of s.fields) if (kind === 'choice') assert.ok(fieldInfo(path).options?.length, path);
});

// Review of PR #170: a drag whose pointerup the panel never heard (the button went up on the
// scrollbar, or in another window) left the page panning under a free mouse. The next move with
// no button held ends it, as does losing the pointer capture.
test('a PDF drag ends when the button is no longer held, or the capture is lost', () => {
  const listeners = {};
  const cls = new Set();
  const scroll = { addEventListener: (type, fn) => { listeners[type] = fn; }, setPointerCapture() {}, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) }, scrollLeft: 100, scrollTop: 100 };
  const zooms = [];
  const context = { state: { pdf: { zoom: 1 } }, PDF_ZOOMS: [1, 1.5, 2], pdfZoom: (z) => zooms.push(z), Date };
  vm.runInNewContext(extractFunction('pdfPan'), context);
  context.pdfPan(scroll);
  listeners.pointerdown({ button: 0, pointerId: 1, clientX: 50, clientY: 50 });
  listeners.pointermove({ pointerId: 1, clientX: 40, clientY: 45, buttons: 1 });
  assert.deepEqual([scroll.scrollLeft, scroll.scrollTop, cls.has('panning')], [110, 105, true]);
  listeners.pointermove({ pointerId: 1, clientX: 0, clientY: 0, buttons: 0 });
  assert.deepEqual([scroll.scrollLeft, scroll.scrollTop, cls.has('panning')], [110, 105, false], 'the button is up: the drag is over');
  listeners.pointermove({ pointerId: 1, clientX: 0, clientY: 0, buttons: 1 });
  assert.equal(scroll.scrollLeft, 110, 'and stays over');
  listeners.pointerdown({ button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  assert.equal(cls.has('panning'), true);
  listeners.lostpointercapture({ pointerId: 2 });
  assert.equal(cls.has('panning'), false);
  // The right button, or no PDF, starts nothing; Ctrl + wheel zooms a step, once per gesture.
  listeners.pointerdown({ button: 2, pointerId: 3, clientX: 0, clientY: 0 });
  assert.equal(cls.has('panning'), false);
  const prevented = [];
  listeners.wheel({ ctrlKey: true, deltaY: -100, preventDefault: () => prevented.push(1) });
  listeners.wheel({ ctrlKey: true, deltaY: -100, preventDefault: () => prevented.push(1) });
  listeners.wheel({ ctrlKey: false, deltaY: -100, preventDefault: () => prevented.push(1) });
  assert.deepEqual([zooms, prevented.length], [[1.5], 2]);
});

// Live recording, 2026-10-24 (Progressive, Let me look before Continue on, one vehicle): on the vehicle
// list with the vehicle on it, the top frame held Continue for the agent's check, and a hidden frame
// that found none of the page's questions said the page wasn't drawn yet. The panel said "No questions
// found on this page", offered only Fill this page again, and filled the page once more; the agent had
// to turn the switch off. A frame with no question doesn't speak for a page the top frame has judged:
// Continue held, clicked or due.
test('a frame with no question doesn\'t override the top frame\'s Continue: held stays held, and no fill again', () => {
  const h = harness();
  h.state.tab = { ...quoteTab(1, 'VehicleSummary'), carrier: { id: 'progressive' } };
  h.state.intake = { record: {} };
  h.state.autoPages.add('VehicleSummary');
  const opts = { page: 'VehicleSummary', auto: 'page', intake: h.state.intake, revision: undefined };
  assert.equal(h.rememberFill([{ fields: 0, filled: [], held: 'check' }, { fields: 0, filled: [], notDrawn: true }], opts), false, 'held: not filled again');
  assert.equal(h.scheduled.length, 0);
  assert.equal(h.rememberFill([{ fields: 0, filled: [], notDrawn: true }], opts), true, 'the top frame itself still drawing: filled again, as before');

  const state = { tab: { id: 7, url: 'VehicleSummary', carrier: { name: 'Progressive', advance: { text: 'Continue' } } } };
  const { context } = reportHarness(state);
  const empty = { fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [] };
  context.renderReport([{ ...empty, held: 'check' }, { ...empty, notDrawn: true }]);
  assert.deepEqual([state.reportFor.empty, state.reportFor.held, state.reportFor.notice], [true, 'check', 'Nothing to fill on this page.']);
  const dock = dockHarness({ carrier: state.tab.carrier, switches: { 'check-continue': { checked: true } }, url: 'VehicleSummary', extra: { showReport: () => state.reportFor, quoteFinished: () => false } });
  dock.state.autoPages.add('VehicleSummary');
  const d = dock.dock();
  assert.deepEqual([d.phase, d.button, d.label], ['check', 'look-right', 'Looks right, continue']);
  context.renderReport([{ ...empty, advanced: 'Continue' }, { ...empty, notDrawn: true }]);
  assert.deepEqual([state.reportFor.empty, state.reportFor.advanced], [true, 'Continue']);
  context.renderReport([{ ...empty, advanceDue: 'none' }, { ...empty, notDrawn: true }], { retrying: false });
  assert.equal(state.reportFor.empty, true, 'Continue due: the page is drawn, with no Continue to click yet');
});

// Review of PR #170 (Cursor and Claude): with only buttons left to click and Let me look before Continue
// on, the dock said Continue would click them and then the page's Continue, though the fill holds
// Continue for Looks right; and that a button it can't click says why in its row, a row the report
// never draws (buttons waiting on others aren't listed). It says what the fill does.
test('Buttons left to click says Looks right comes after with Let me look on, and promises no row the report lacks', () => {
  const { said, ui } = continueHarness({ 'check-continue': { checked: true } });
  const held = said({ waiting: 2, filled: 3 });
  assert.deepEqual([held.phase, held.title, held.button, held.label, held.go, held.alt], ['waiting', 'Buttons left to click', 'fill', 'Click them for me', 'continue', 'fill-again']);
  assert.equal(held.sub, 'Then check the answers and click Looks right. Never Bind or Submit.');
  ui['check-continue'].checked = false;
  const goes = said({ waiting: 2, filled: 3 });
  assert.deepEqual([goes.button, goes.label, goes.go], ['fill', 'Continue', 'continue']);
  assert.equal(goes.sub, 'Continue clicks the ones it can in turn, and the page’s Continue once none is left. Never Bind or Submit.');
});

// Review of PR #170 (Claude): "Quote done" over a fill that halted (its list says "Filling stopped"),
// and over a report that found no questions, where the strip said "After the fill"; and the finishing
// action's `page` or `steps` read as one name only (CarrierAction: a name or a list).
test('a halted fill, or a report without questions, is not "Quote done"; the action\'s page or steps may be a name or a list', () => {
  const geicoLike = { name: 'GEICO', finishedBy: 'printProposal', actions: [{ id: 'printProposal', steps: ['Quote & Coverages'] }], layoutSteps: ['Vehicles', 'Quote & Coverages'] };
  const context = { state: { tab: { id: 7, url: 'quote' }, doneActions: new Set(['printProposal']), tabSteps: new Map([[7, 'Quote & Coverages']]) }, pageOf: (u) => u };
  vm.runInNewContext(extractFunction('quoteFinished'), context);
  const report = { fields: 12, filled: 12, left: 0, waiting: 0 };
  assert.equal(context.quoteFinished(geicoLike, report), true);
  assert.equal(context.quoteFinished(geicoLike, { ...report, halted: true }), false, 'the fill halted');
  assert.equal(context.quoteFinished(geicoLike, { notice: 'No questions found on this page.' }), false, 'no questions found');
  const done = new Set(['print']);
  const pages = { finishedBy: 'print', actions: [{ id: 'print', page: ['CoveragesRates', 'Rates'] }] };
  assert.equal(context.quoteFinished(pages, report, 'Rates', undefined, done), true, 'one of its pages');
  assert.equal(context.quoteFinished(pages, report, 'Drivers', undefined, done), false);
  const named = { finishedBy: 'print', actions: [{ id: 'print', steps: 'Quote & Coverages' }], layoutSteps: ['Quote', 'Quote & Coverages'] };
  assert.equal(context.quoteFinished(named, report, 'quote', 'Quote & Coverages', done), true, 'its step, named alone');
  assert.equal(context.quoteFinished(named, report, 'quote', 'Quote', done), false, 'a step whose name is part of its name is another');
  // The report says the fill halted (renderReport).
  const state = { tab: { id: 7, url: 'quote', carrier: geicoLike } };
  const { context: r } = reportHarness(state);
  const frame = { fields: 3, filled: [{ key: 'k1', label: 'Liability', shown: '$1M', path: 'coverage.liability' }], kept: [], failed: [], leftRequired: [], actions: [], noData: [] };
  r.renderReport([{ ...frame, halted: true, reason: 'the agent interrupted filling' }]);
  assert.equal(state.reportFor.halted, true);
  r.renderReport([frame]);
  assert.equal(state.reportFor.halted, false);
});

// Review of PR #170 (Claude): after the print, Fill this page again on Quote & Coverages that put an
// answer in (a limit the agent corrected in client details; GEICO's replaceChoices) clicked neither
// Recalculate (once a quote) nor Print Quote Proposal again, and the dock said the printed proposal was
// the quote. A fill on the finishing step that puts an answer in, or keeps an edit the agent made during
// it, without clicking the action, marks it changed; the fill that clicks it lifts the mark.
test('a fill that changes the finishing step after the print marks the quote changed; the fill that prints lifts it', () => {
  const h = harness();
  vm.runInContext(extractFunction('noteChangedAfterDone'), h.context);
  const geicoLike = { id: 'geico', name: 'GEICO', finishedBy: 'printProposal', actions: [{ id: 'printProposal', steps: ['Quote & Coverages'] }], layoutSteps: ['Vehicles', 'Quote & Coverages'] };
  h.state.tab = { id: 1, url: 'https://gateway.example/quote', carrier: geicoLike };
  h.state.intake = { record: {} };
  const opts = { page: 'quote', intake: h.state.intake, revision: undefined };
  const fill = (extra = {}) => ({ fields: 12, filled: [], kept: [], actions: [], stepKey: 'Quote & Coverages', ...extra });
  const answer = { key: 'k1', path: 'coverage.liability', shown: '$1M' };
  h.state.doneActions = new Set(['recalculate', 'printProposal']);
  h.rememberFill([fill()], opts);
  assert.deepEqual([...h.state.doneActions], ['recalculate', 'printProposal'], 'nothing put in: the printed quote stands');
  h.rememberFill([fill({ filled: [answer], stepKey: 'Vehicles' })], opts);
  assert.deepEqual([...h.state.doneActions], ['recalculate', 'printProposal'], 'another step');
  h.rememberFill([fill({ filled: [answer] })], opts);
  assert.ok(h.state.doneActions.has('printProposal:changed'), 'an answer put in after the print');
  h.rememberFill([fill({ filled: [answer], actions: [{ id: 'printProposal' }] })], opts);
  assert.equal(h.state.doneActions.has('printProposal:changed'), false, 'printed again: lifted');
  h.rememberFill([fill({ protectedKeys: ['k2'] })], opts);
  assert.ok(h.state.doneActions.has('printProposal:changed'), 'the agent\'s edit during the fill');
});

// Review of PR #170 (Claude): the agent's pick from the panel (Change answer, an item's choices) goes in
// with the recorder paused, so no field_changes came and "Quote done" outlived a limit changed after the
// print. A pick that went in marks the finishing step changed, as the agent's change on the page does.
test('the agent\'s pick from the panel marks the quote changed after its finishing action, as a change on the page does', async () => {
  const marks = [];
  const note = (...args) => { marks.push(args); return true; };
  const t = agentAnswerHarness({ extra: { noteChangedAfterDone: note, renderSteps: () => marks.push('steps') } });
  await t.pick('No');
  assert.equal(marks.length, 2);
  assert.equal(marks[0][0], t.carrier);
  assert.deepEqual(marks[0].slice(1), ['Quote', undefined, 1]);
  assert.equal(marks[1], 'steps');
  // One the page didn't take changes nothing.
  marks.length = 0;
  const refused = agentAnswerHarness({ extra: { noteChangedAfterDone: note, renderSteps: () => marks.push('steps') } });
  refused.answer = (items) => [{ frameId: 0, result: [{ key: items[0].key, ok: false, reason: 'the page did not keep the answer' }] }];
  await refused.pick('No');
  assert.deepEqual(marks, []);
});

// The same for an AI pick put in on the page (applyAi): it is on the page, approved or not.
test('an AI pick put in on the page marks the quote changed after its finishing action', async () => {
  const record = {}, intake = { record };
  const x = { key: 'choice', label: 'Choice', controlKind: 'radio', choice: 'No', autoOk: true };
  const field = { key: x.key, label: x.label, current: '' };
  const pre = [{ frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [field]]) }];
  const post = [{ ...pre[0], result: JSON.stringify(['Quote', [{ ...field, current: 'No' }]]) }];
  const responses = [pre, [{ frameId: 0, documentId: 'doc-0', result: [{ key: x.key, label: x.label, ok: true, shown: 'No' }] }], post];
  const state = { filling: false, intake, active: {}, tab: { id: 1, url: 'https://example.test/quote' },
    aiCache: new Map([['1\n/quote', x]]), agentKeys: new Map(), filled: new Map() };
  const ctx = { tabId: 1, page: '/quote', tabUrl: state.tab.url, intake, carrier: { practice: true },
    contextKey: assistContextKey(record, state.active), snapshots: pre };
  const marks = [];
  const context = { state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, pageOf: url => new URL(url).pathname,
    runKit: async (tabId, carrier, func) => /answerEdits/.test(String(func)) ? pre.map(frame => ({ ...frame, result: [] })) : responses.shift(), tellRecorder: async () => {}, persistAiPending: async () => {},
    usage: { currentSession: () => ({ intakeId: 'scope' }) }, aiSafeText: String, aiRetiredSignatures: new Set(),
    noteChangedAfterDone: (...args) => { marks.push(args); return false; } };
  vm.runInNewContext(['aiActionCurrent', 'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots',
    'snapshotsEqual', 'snapshotFingerprint', 'snapshotHashMatches', 'aiSnapshotFields', 'aiSnapshotFieldMatches',
    'aiQuestionHash', 'aiLiveFieldHash', 'aiOriginRecord', 'aiAnswerOrigin', 'aiCurrentAnswerPresent',
    'applyAi'].map(extractFunction).join('\n') + LAYOUT_STUB, context);
  assert.equal(await context.applyAi([x], ctx, 'auto'), true);
  assert.equal(marks.length, 1);
  assert.equal(marks[0][0], ctx.carrier);
  assert.deepEqual(marks[0].slice(1), ['/quote', undefined, 1]);
});

// Review of PR #170 (Claude): once marked changed, "Quote done" never came back on GEICO: the fill never
// clicks Print Quote Proposal again (done once a quote), and the agent's own click of it, after their
// Recalculate, left the mark. The agent's click of the finishing action lifts it, as a fill's does.
test('the agent\'s own click of the finishing action lifts the changed mark', () => {
  const plan = geico.actions.map((a) => ({ kind: 'action', action: a.id, baseAction: a.id, pages: [].concat(a.page ?? []), steps: a.steps ?? null,
    text: typeof a.text === 'function' ? null : a.text ?? null, near: a.near ?? null, token: a.token ?? null, within: a.within ?? null,
    opener: a.opener ?? null, unique: !!a.unique, needsRecalculation: !!a.needsRecalculation, verify: a.verify ?? null }));
  const state = { intake: { record: {} }, active: { vehicles: 0, drivers: 0, trailers: 0 }, doneActions: new Set(['recalculate', 'printProposal', 'printProposal:changed']) };
  let steps = 0;
  const chimes = [];
  const context = { state, buildPlan: () => plan, persistDoneActions: () => {}, renderSteps: () => { steps++; }, noteQuoteDone: (tabId) => chimes.push(tabId ?? null) };
  vm.runInNewContext(extractFunction('agentHelperDone'), context);
  context.agentHelperDone(geico, 'quote', 'Quote & Coverages', 'Print Quote Proposal');
  assert.deepEqual([[...state.doneActions], steps], [['recalculate', 'printProposal'], 1], 'lifted, and the strip and the dock say so');
  // The agent's own click of the finishing action is the quote done: the chime (noteQuoteDone).
  assert.deepEqual(chimes, [null]);
  state.doneActions.delete('recalculate');
  context.agentHelperDone(geico, 'quote', 'Quote & Coverages', 'Recalculate');
  assert.deepEqual(chimes, [null], 'another helper of the agent\'s: no chime');
});

// Review of PR #170 (Claude): New quote cleared this intake's stored records, but the panel's own sets
// (the tab's helpers clicked, the agent's edits on the page, unit forms) only went later, after the PDF
// was read again: anything that saved them meanwhile (an edit on the page, a unit arrival) wrote the old
// quote's back, and the new quote took vehicles as already added. They go first now. Nothing starts a
// fill while it is under way, and a confirmed New quote while answers go in says so.
test('New quote lets go of the panel\'s own records before the stored ones, starts no fill meanwhile, and says why it waits', async () => {
  const seen = [];
  const state = { intake: { fileName: 'client.pdf' }, filling: false, tab: { id: 4, carrier: { id: 'geico' } },
    doneActions: new Set(['addVehicle:0', 'printProposal']), agentKeys: new Map([['quote|s:Drivers', new Set(['k1'])]]),
    unitForms: { vehicles: { form1: 0 }, drivers: {}, trailers: {} }, tabSessions: new Map([[5, { doneActions: new Set(['addVehicle:1']) }]]) };
  const snapshot = (what) => seen.push([what, [...state.doneActions], state.agentKeys.size, Object.keys(state.unitForms.vehicles).length, state.tabSessions.size, !!state.resetting]);
  const notes = [];
  const context = { state, inExtension: true, File: class { constructor(parts, name, opts) { Object.assign(this, { parts, name, type: opts?.type }); } },
    intakePdfBytes: async () => new Uint8Array([1, 2]), usage: { currentSession: () => ({ intakeId: 'abc' }) },
    runKit: async () => [], clearAgentKeys: async () => snapshot('keys'), loadFile: async () => snapshot('load'), clientNote: (t) => notes.push(t) };
  vm.runInNewContext(extractFunction('newQuote'), context);
  await context.newQuote();
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), [['keys', [], 0, 0, 0, true], ['load', [], 0, 0, 0, true]]);
  assert.equal(!!state.resetting, false, 'over');
  // fillPage and autoFill start nothing while it is under way.
  for (const name of ['fillPage', 'autoFill']) assert.match(extractFunction(name), /state\.resetting/, name);
  // Over even when the PDF couldn't be read again.
  context.loadFile = async () => { throw new Error('unreadable'); };
  await assert.rejects(context.newQuote());
  assert.equal(!!state.resetting, false);
  // Confirmed while answers go in: said, nothing done.
  state.filling = true;
  seen.length = 0;
  await context.newQuote();
  assert.deepEqual([seen, notes], [[], ['Wait for the answers going in to finish, then start the new quote.']]);
});

// Review of PR #170 (Cursor and Claude): the live list took the first frame's phase that said one, so
// Progressive's hidden frame reading its old page spoke over the top frame answering (null). The top
// frame's word goes while its fill runs; another frame's once it is over there.
test('the live list takes the top frame\'s phase while its fill runs', async () => {
  let tick = null;
  let reply = [];
  const state = { fillingFor: { run: 'r1', filled: 0, rows: [] } };
  const context = { inExtension: true, state, worldFor: () => 'MAIN', renderSteps: () => {}, setInterval: (fn) => { tick = fn; return 1; }, clearInterval() {},
    chrome: { scripting: { executeScript: async () => reply } } };
  vm.runInNewContext(extractFunction('watchFill'), context);
  context.watchFill({ run: 'r1', tabId: 3, carrier: {} });
  const progress = (frame, phase) => ({ frame, list: `${frame}:1`, since: 0, rows: [], phase });
  reply = [{ frameId: 0, result: progress('top', { name: 'premium', what: null }) }, { frameId: 5, result: progress('hidden', { name: 'reading', what: null }) }];
  await tick();
  assert.equal(state.fillingFor.phase.name, 'premium');
  reply = [{ frameId: 5, result: progress('hidden', { name: 'reading', what: null }) }, { frameId: 0, result: progress('top', null) }];
  await tick();
  assert.equal(state.fillingFor.phase, null, 'the top frame answering');
  reply = [{ frameId: 0, result: null }, { frameId: 5, result: progress('hidden', { name: 'waiting', what: null }) }];
  await tick();
  assert.equal(state.fillingFor.phase?.name, 'waiting', 'the top frame\'s fill is over: the other\'s word');
});

// Review of PR #170 (Claude): a report made again on reopen judged the page without the frame's
// Continue due (advanceDue wasn't kept), so a page the live report read "Nothing to fill" with
// Continue on read "No questions found" once the panel opened again. It is kept with the other parts.
test('a kept report keeps a frame\'s Continue due, which judges the page as it did live', async () => {
  const memory = {};
  const { context } = keptReportsHarness(memory);
  context.keepReport(7, { key: '7|VehicleSummary', page: 'VehicleSummary', active: {}, at: 100, stopped: false, frames: [{ fields: 0, advanceDue: 'none' }, { fields: 0, notDrawn: true }] });
  await context.kept();
  assert.deepEqual(memory['reports:7'].entries[0].frames, [{ fields: 0, advanceDue: 'none' }, { fields: 0, notDrawn: true }]);
});


/// The maintainer, 2026-10-25: "a ding when we finish the quote, not just one page". Their notification
// sound (sidepanel/sounds/quote-done.mp3) when the quote's finishing action is clicked (noteQuoteDone:
// the fill's click, rememberFill, or the agent's own, agentHelperDone; once a print, by the tab's done
// actions: the tests after the review of PR #171 below). Never with Sound when the quote is done off
// (Settings → Filling, `finish-sound`, saved as `finishSound`).
test('the quote-done chime plays the maintainer\'s sound from the start, never with the switch off, and silently fails', () => {
  const played = [];
  let made = 0;
  class FakeAudio {
    constructor(src) { made++; this.src = src; this.currentTime = 0; this.preload = ''; }
    play() { played.push([this.src, this.currentTime]); this.currentTime = 2; return Promise.reject(new Error('NotAllowedError')); }
  }
  const ui = { 'finish-sound': { checked: true } };
  const state = { tab: { id: 7 }, audio: null };
  const context = { state, $: (id) => ui[id], Audio: FakeAudio };
  vm.runInNewContext(['noteQuoteDone', 'playChime', 'unlockAudio'].map(extractFunction).join('\n'), context);
  // Refused (no click in the panel yet): the rejected play is caught, nothing thrown.
  assert.equal(context.noteQuoteDone(), true);
  assert.deepEqual(played, [['sounds/quote-done.mp3', 0]], 'the maintainer\'s sound, from the start');
  assert.equal(state.audio.preload, 'auto');
  assert.ok(fs.existsSync(new URL('../sidepanel/sounds/quote-done.mp3', import.meta.url)), 'the sound is in the panel\'s folder, so it is packaged');
  assert.equal(context.noteQuoteDone(), true);
  assert.deepEqual(played[1], ['sounds/quote-done.mp3', 0], 'rewound before playing again');
  assert.equal(made, 1, 'one audio element, kept');
  // The switch off: silent.
  ui['finish-sound'].checked = false;
  assert.equal(context.noteQuoteDone(), false);
  assert.equal(played.length, 2);
  // No audio here (a preview outside Chrome): nothing thrown.
  ui['finish-sound'].checked = true;
  context.Audio = undefined;
  state.audio = null;
  assert.equal(context.noteQuoteDone(), false);
});

test('the fill\'s click of the finishing action is the quote done: the chime, once', () => {
  const h = harness();
  const chimes = [];
  h.context.noteQuoteDone = () => chimes.push(1);
  h.state.tab = { ...quoteTab(3, 'CoveragesRates'), carrier: { id: 'progressive', finishedBy: 'print' } };
  h.state.intake = { record: {} };
  const opts = { page: 'CoveragesRates', auto: 'page', intake: h.state.intake, revision: undefined };
  h.rememberFill([{ fields: 11, filled: [], actions: [{ id: 'recalculate', text: 'Recalculate' }] }], opts);
  assert.deepEqual(chimes, [], 'another helper: not the end');
  h.rememberFill([{ fields: 11, filled: [], actions: [{ id: 'billPlan', text: 'View bill plan options' }, { id: 'print', text: 'Print, Email, Fax' }] }], opts);
  assert.deepEqual(chimes, [1]);
  h.rememberFill([{ fields: 11, filled: [], actions: [{ id: 'print', text: 'already shown on the page', alreadyShown: true }] }], opts);
  assert.deepEqual(chimes, [1], 'found done already: no click, no chime');
  // Without a finishing action on the rater (AmWINS): never.
  h.state.tab.carrier = { id: 'amwins' };
  h.state.doneActions.clear();
  h.rememberFill([{ fields: 11, filled: [], actions: [{ id: 'print', text: 'Print' }] }], opts);
  assert.deepEqual(chimes, [1]);
});

// Progressive's quote ends, for the fill, at Print, Email, Fax on Rates (its `print` helper, clicked
// after the bill plan): the print page it opens is the agent's. Review page says Quote done there, and
// the dock says what was clicked (`finishedSaid`), not GEICO's printed proposal.
test('Progressive\'s quote is done at Print, Email, Fax, and the dock says so in its own words', () => {
  assert.equal(progressive.finishedBy, 'print');
  assert.ok(progressive.actions.some((a) => a.id === 'print' && a.page === 'CoveragesRates'), 'the helper on Rates');
  // Clicked by the fill or by the agent (agentHelperDone): the words say neither (the review of PR #171).
  assert.equal(progressive.finishedSaid, 'Print, Email, Fax was clicked');
  const report = { fields: 12, filled: 12, left: 0, waiting: 0 };
  const prog = { name: 'Progressive', finishedBy: 'print', finishedSaid: 'Print, Email, Fax was clicked', actions: [{ id: 'print', page: 'CoveragesRates' }] };
  const d = dockHarness({ carrier: prog, url: 'CoveragesRates', extra: { showReport: () => report, quoteFinished: () => true } });
  const word = d.dock();
  assert.deepEqual([word.phase, word.eyebrow, word.title, word.sub], ['finished', 'Quote done', 'Print, Email, Fax was clicked', 'This is where TNI stops on Progressive. Nothing is submitted or bound.']);
  const g = dockHarness({ carrier: { name: 'GEICO', finishedBy: 'printProposal', actions: [] }, extra: { showReport: () => report, quoteFinished: () => true } });
  assert.equal(g.dock().title, 'The quote proposal is printed', 'GEICO as before');
});

test('Sound when the quote is done is a Filling switch, on by default, kept on this computer and never logged', () => {
  const html = fs.readFileSync(new URL('../sidepanel/sidepanel.html', import.meta.url), 'utf8');
  assert.match(html, /<label class="opt"><span class="opt-text"><b>Sound when the quote is done<\/b><span>A short sound when the quote reaches its end\.<\/span><\/span><input type="checkbox" role="switch" class="switch" id="finish-sound" checked><\/label>/);
  assert.match(extractFunction('wireUsage'), /\$\('finish-sound'\)\.addEventListener\('change', \(e\) => \{ usage\.saveSettings\(\{ finishSound: e\.target\.checked \}\); \}\);/);
  assert.match(extractFunction('wireUsage'), /document\.addEventListener\('pointerdown', unlockAudio, \{ once: true, capture: true \}\);/, 'the audio is unlocked by the agent\'s first click in the panel');
  assert.match(extractFunction('init'), /\$\('finish-sound'\)\.checked = saved\.finishSound \?\? true;/);
  assert.doesNotMatch(extractFunction('wireUsage'), /logSettings\('changed', 'finishSound'\)/, 'not in the usage log');
});

// Review of PR #171 (Claude, Cursor): the chime kept a record of its own (`chimed`, by tab and the
// intake's PDF) beside the tab's done actions, and missed what they follow. It follows them now: a
// click of the finishing action chimes where the action wasn't done, or was changed or re-armed since.
// The panel's own chime functions here, on the fill bookkeeping's harness.
function chimeHarness() {
  const h = harness();
  const played = [];
  h.context.Audio = class { constructor(src) { this.src = src; this.currentTime = 0; } play() { played.push(this.src); return Promise.resolve(); } };
  h.ui['finish-sound'] = { checked: true };
  vm.runInContext(['noteQuoteDone', 'playChime', 'unlockAudio', 'noteChangedAfterDone'].map(extractFunction).join('\n'), h.context);
  h.state.tab = { ...quoteTab(3, 'CoveragesRates'), carrier: { id: 'progressive', name: 'Progressive', finishedBy: 'print', actions: [{ id: 'print', page: 'CoveragesRates' }] } };
  h.state.intake = { record: {} };
  const opts = { page: 'CoveragesRates', auto: 'page', intake: h.state.intake, revision: undefined };
  return { h, played, fill: (frame) => h.rememberFill([{ fields: 11, filled: [], actions: [], ...frame }], opts) };
}
const PRINT = { id: 'print', text: 'Print, Email, Fax' };
const LIMIT = { key: 'limit', label: 'Liability limit', shown: '$1,000,000' };

test('a fill\'s answer on Rates re-arms Print, Email, Fax: printed again, the quote chimes again', () => {
  const { played, fill } = chimeHarness();
  fill({ actions: [PRINT] });
  assert.equal(played.length, 1, 'the fill printed the quote');
  // The agent corrects the limit and a follow-up fill puts it in on Rates: pagekit re-arms Recalculate
  // and Print, Email, Fax (invalidatedActions), and a later fill clicks it again.
  fill({ filled: [LIMIT], invalidatedActions: ['recalculate', 'print'] });
  fill({ actions: [PRINT] });
  assert.equal(played.length, 2, 'the changed quote printed again');
  // Re-armed and clicked again in the same fill: printed again too.
  fill({ filled: [LIMIT], invalidatedActions: ['recalculate', 'print'], actions: [PRINT] });
  assert.equal(played.length, 3);
});

test('New quote with this intake on the same tab: its print chimes', () => {
  const { h, played, fill } = chimeHarness();
  fill({ actions: [PRINT] });
  assert.equal(played.length, 1);
  // New quote with this intake (newQuote): the tab's done actions go, the same PDF (the same intake) stays.
  h.state.doneActions = new Set();
  fill({ actions: [PRINT] });
  assert.equal(played.length, 2, 'the new quote\'s print');
});

test('a fill that prints with something left for the agent, or stopped short, is not the quote done: no chime', () => {
  for (const left of [{ checks: [{ key: 'c', note: 'Check it' }] }, { noData: [{ key: 'n', note: 'Not on the intake.' }] }, { failed: [{ key: 'f', reason: 'not kept' }] },
    { unknown: [{ key: 'u', label: 'New question' }] }, { blocked: [{ id: 'doneGl', why: 'waits' }] }, { halted: true, reason: 'You stopped the fill.' }]) {
    const { played, fill } = chimeHarness();
    fill({ actions: [PRINT], ...left });
    assert.equal(played.length, 0, JSON.stringify(left));
  }
});

test('the agent\'s own click of a finishing action already done and unchanged chimes no more, as in a panel opened again', () => {
  const plan = geico.actions.map((a) => ({ kind: 'action', action: a.id, baseAction: a.id, pages: [].concat(a.page ?? []), steps: a.steps ?? null,
    text: typeof a.text === 'function' ? null : a.text ?? null, near: a.near ?? null, token: a.token ?? null, within: a.within ?? null,
    opener: a.opener ?? null, unique: !!a.unique, needsRecalculation: !!a.needsRecalculation, verify: a.verify ?? null }));
  // The panel opened again (or moved into its own window): the tab's done actions are restored, the
  // quote printed and nothing changed since.
  const state = { intake: { record: {} }, active: { vehicles: 0, drivers: 0, trailers: 0 }, doneActions: new Set(['recalculate', 'printProposal']) };
  const chimes = [];
  const context = { state, buildPlan: () => plan, persistDoneActions: () => {}, renderSteps: () => {}, noteQuoteDone: () => chimes.push(1) };
  vm.runInNewContext(extractFunction('agentHelperDone'), context);
  context.agentHelperDone(geico, 'quote', 'Quote & Coverages', 'Print Quote Proposal');
  assert.deepEqual(chimes, [], 'the same quote printed again');
  state.doneActions.add('printProposal:changed');
  context.agentHelperDone(geico, 'quote', 'Quote & Coverages', 'Print Quote Proposal');
  assert.deepEqual(chimes, [1], 'changed since: the new quote printed');
});


// The maintainer, 2026-10-25: on AmWINS the quote is done at the declaration ("I declare …") at the
// end of Underwriting; the agent ticks it and clicks Submit. No button ends it for the fill, so its
// end is a step (`finishedAt`): a fill there that leaves the agent nothing but the declaration. Then
// the strip says Quote done, the dock says the declaration and Submit are the agent's, and the quote
// chimes once. The declaration stays unticked and Submit unclicked.
const DECLARATION = { name: 'Declaration', key: 'accept', label: 'I declare that the information provided is true', source: 'attestation', note: 'The declaration is yours to confirm; never ticked. Then Submit (yours too).' };
test('AmWINS\'s quote is done at the declaration: Underwriting with nothing else left', () => {
  assert.equal(amwins.finishedBy, undefined, 'no button ends it');
  assert.deepEqual(JSON.parse(JSON.stringify(amwins.finishedAt)), { id: 'declaration', steps: ['Underwriting'], left: ['Declaration'],
    said: 'Tick the declaration, then click Submit', sub: 'Both are yours on AmWINS. Nothing is ticked, submitted or bound for you.' });
  assert.ok(amwins.rules.some((r) => r.selector === '#accept' && r.name === 'Declaration' && r.source === 'attestation' && !('value' in r)), 'the declaration is still never filled');
  const context = { state: { tab: { id: 7, url: 'app' }, doneActions: new Set(), tabSteps: new Map([[7, 'Underwriting']]) }, pageOf: (u) => u };
  vm.runInNewContext(extractFunction('quoteFinished'), context);
  const report = { fields: 30, filled: 29, left: 1, otherLeft: 0, waiting: 0 };
  assert.equal(context.quoteFinished(amwins, report), true, 'only the declaration left');
  assert.equal(context.quoteFinished(amwins, { ...report, left: 0 }), true, 'the agent ticked it: still done');
  assert.equal(context.quoteFinished(amwins, { ...report, left: 2, otherLeft: 1 }), false, 'another question left for the agent');
  assert.equal(context.quoteFinished(amwins, { ...report, waiting: 1 }), false, 'a button left to click');
  assert.equal(context.quoteFinished(amwins, { ...report, halted: true }), false, 'a fill stopped short');
  assert.equal(context.quoteFinished(amwins, { ...report, fields: 0 }), false, 'no questions found');
  assert.equal(context.quoteFinished(amwins, report, 'app', 'Coverages'), false, 'another step');
  // The dock: the declaration and Submit are the agent's.
  const d = dockHarness({ carrier: amwins, step: 'Underwriting', extra: { showReport: () => report, quoteFinished: context.quoteFinished } });
  const word = d.dock();
  assert.deepEqual([word.phase, word.eyebrow, word.title, word.sub, word.button ?? null, word.alt],
    ['finished', 'Quote done', 'Tick the declaration, then click Submit', 'Both are yours on AmWINS. Nothing is ticked, submitted or bound for you.', null, 'fill-again']);
});

test('the AmWINS fill that reaches the declaration chimes once; one that leaves more doesn\'t', () => {
  const h = harness();
  const played = [];
  h.context.Audio = class { constructor(src) { this.src = src; this.currentTime = 0; } play() { played.push(this.src); return Promise.resolve(); } };
  h.ui['finish-sound'] = { checked: true };
  vm.runInContext(['noteQuoteDone', 'playChime', 'unlockAudio'].map(extractFunction).join('\n'), h.context);
  h.state.tab = { ...quoteTab(5, 'app'), carrier: amwins };
  h.state.intake = { record: {} };
  const opts = { page: 'app', auto: 'page', intake: h.state.intake, revision: undefined };
  const fill = (frame) => h.rememberFill([{ fields: 30, filled: [], actions: [], noData: [], ...frame }], opts);
  fill({ stepKey: 'Coverages' });
  assert.equal(played.length, 0, 'another step');
  fill({ stepKey: 'Underwriting', noData: [DECLARATION, { name: 'Disclosure details', key: 'disclosure', note: null }] });
  assert.equal(played.length, 0, 'something else left for the agent');
  fill({ stepKey: 'Underwriting', noData: [DECLARATION], halted: true });
  assert.equal(played.length, 0, 'stopped short');
  fill({ stepKey: 'Underwriting', noData: [DECLARATION] });
  assert.deepEqual([played.length, h.state.doneActions.has('declaration')], [1, true], 'the declaration is next: the chime, and the quote marked done');
  fill({ stepKey: 'Underwriting', noData: [DECLARATION] });
  assert.equal(played.length, 1, 'once a quote');
  // New quote or Clear empties the tab's done actions: the next quote chimes.
  h.state.doneActions.clear();
  fill({ stepKey: 'Underwriting', noData: [DECLARATION] });
  assert.equal(played.length, 2);
});

test('what is left besides the declaration is counted with the report, and again as the agent answers', () => {
  // renderReport keeps the count of items other than the finishing step's own (otherLeft), and
  // needRow marks the declaration's row so recount keeps that count as the agent answers.
  assert.match(extractFunction('renderReport'), /otherLeft: needs\.filter\(\(x\) => !finishLeftOk\(carrier, x\)\)\.length/);
  assert.match(extractFunction('needRow'), /finish: finishLeftOk\(carrier, x\) \? '1' : ''/);
  assert.match(extractFunction('recount'), /entry\.otherLeft = items\.filter\(\(n\) => !n\.classList\.contains\('resolved'\) && n\.dataset\?\.finish !== '1'\)\.length;/);
  const context = {};
  vm.runInNewContext(extractFunction('finishLeftOk'), context);
  assert.equal(context.finishLeftOk(amwins, DECLARATION), true);
  assert.equal(context.finishLeftOk(amwins, { name: 'Marital status' }), false);
  assert.equal(context.finishLeftOk(geico, DECLARATION), false, 'only where the carrier names it');
});

// The review of PR #173: the tab's step is the last one it saw (tabSteps), so on the start page of
// the next quote in the same tab it still reads Underwriting. Only a report whose own fill read
// Underwriting is the quote done, as for the chime (rememberFill).
test('AmWINS\'s quote is done on a fill of Underwriting, not on the start page with the tab\'s step left there', () => {
  const state = { tab: { id: 7, url: '/commerciallines', carrier: amwins }, active: {}, tabSteps: new Map([[7, 'Underwriting']]) };
  const { context } = reportHarness(state, { keepReport() {} });
  vm.runInContext(extractFunction('quoteFinished'), context);
  const start = { fields: 2, filled: [{ label: 'Risk state', shown: 'NE' }], kept: [], failed: [], noData: [], leftRequired: [], actions: [{ id: 'openApplication', text: 'Open New Application' }] };
  context.renderReport([start], { tabId: 7, page: '/commerciallines', carrier: amwins });
  assert.equal(context.quoteFinished(amwins, state.reportFor, '/commerciallines', 'Underwriting'), false, 'the start page: its fill read no step');
  context.renderReport([{ ...start, actions: [], stepKey: 'Underwriting', noData: [DECLARATION] }], { tabId: 7, page: '/application/businessauto', carrier: amwins });
  assert.equal(context.quoteFinished(amwins, state.reportFor, '/application/businessauto', 'Underwriting'), true, 'Underwriting with only the declaration left');
});


// The maintainer, 2026-10-26: Non-Trucking on the form's auto liability is NTL asked for. An edit
// of the claims box or notes that names NTL then asks nothing: NTL is already Yes.
test('a notes edit naming NTL asks nothing when the form already asked for NTL', () => {
  const run = (coverage) => {
    const intake = { record: { coverage, claims: { text: 'No' }, notes: { text: 'Needs non-trucking liability' } }, warnings: [], done: [] };
    const context = { save() {}, render() {}, ntlMention: (t) => (/non-trucking/i.test(t) ? 'Needs non-trucking liability' : null), ntlCheckMessage: (l) => `ask: ${l}`,
      intakeNotes: (r) => [r.claims?.text, r.notes?.text].filter(Boolean).join('\n'), nonTruckingAnswer: (v) => /^non[\s-]*trucking$/i.test(String(v ?? '')) };
    vm.runInNewContext(`${extractFunction('claimsTextEdited')}\n${extractFunction('ntlNotesItem')}`, context);
    context.claimsTextEdited(intake);
    return intake.warnings.map((w) => w.code);
  };
  assert.deepEqual(run({ autoLiability: 'Non-Trucking', ntl: true }), []);
  assert.deepEqual(run({ autoLiability: 'Yes', ntl: null }), ['coverage.ntl'], 'not asked on the form: the notes ask the agent, as before');
});

// The NTL-with-cargo check follows the agent's edits in the panel (NTL, cargo, auto liability):
// asked when both are Yes, asked again after a change, retired to a note when no longer so.
test('the NTL-with-cargo check follows the agent\'s edits', () => {
  const intake = { record: { coverage: { ntl: true, cargo: true } }, warnings: [], done: [] };
  const context = { ntlWithCargo: (r) => r.coverage.ntl === true && r.coverage.cargo === true, NTL_CARGO_MESSAGE: 'ntl and cargo' };
  vm.runInNewContext(extractFunction('ntlCargoEdited'), context);
  context.ntlCargoEdited(intake);
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level, w.path]), [['coverage.ntl-cargo', 'check', 'coverage.cargo']]);
  intake.done = [0];
  intake.record.coverage.cargo = false;
  context.ntlCargoEdited(intake);
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['coverage.ntl-cargo', 'info']], 'retired');
  intake.record.coverage.cargo = true;
  context.ntlCargoEdited(intake);
  assert.deepEqual([intake.warnings.map((w) => [w.code, w.level]), intake.done], [[['coverage.ntl-cargo', 'check']], []], 'asked again, not checked');
  assert.match(extractFunction('agentEdit'), /if \(\['coverage\.ntl', 'coverage\.cargo', 'coverage\.autoLiability'\]\.includes\(path\)\) \{ ntlCargoEdited\(state\.intake\); await save\(\); render\(\); \}/);
});

// (TNI, 2026-10-26: answer to PR question, #192) NTL and primary auto liability both asked for is
// an intake check naming the conflict. Today's form can't ask for both (Non-Trucking is its auto
// liability answer): the agent's NTL Yes with auto liability Yes does, so the check follows the
// agent's edits of NTL or auto liability, as the NTL-with-cargo check does.
test('the NTL-with-primary-liability check follows the agent\'s edits', () => {
  const intake = { record: { coverage: { ntl: true, autoLiability: 'Yes' } }, warnings: [], done: [] };
  const context = { ntlWithPrimary: (r) => r.coverage.ntl === true && r.coverage.autoLiability === 'Yes', NTL_PRIMARY_MESSAGE: 'ntl and primary' };
  vm.runInNewContext(extractFunction('ntlPrimaryEdited'), context);
  context.ntlPrimaryEdited(intake);
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level, w.path, w.msg]), [['coverage.ntl-primary', 'check', 'coverage.autoLiability', 'ntl and primary']]);
  intake.done = [0];
  intake.record.coverage.ntl = false;
  context.ntlPrimaryEdited(intake);
  assert.deepEqual(intake.warnings.map((w) => [w.code, w.level]), [['coverage.ntl-primary', 'info']], 'retired');
  intake.record.coverage.ntl = true;
  context.ntlPrimaryEdited(intake);
  assert.deepEqual([intake.warnings.map((w) => [w.code, w.level]), intake.done], [[['coverage.ntl-primary', 'check']], []], 'asked again, not checked');
  // Never asked while they aren't both asked for.
  const other = { record: { coverage: { ntl: true, autoLiability: 'Non-Trucking' } }, warnings: [], done: [] };
  context.ntlPrimaryEdited(other);
  assert.deepEqual(other.warnings, []);
  assert.match(extractFunction('agentEdit'), /if \(\['coverage\.ntl', 'coverage\.autoLiability'\]\.includes\(path\)\) ntlPrimaryEdited\(state\.intake\);/);
});

// The review of PR #176: auto liability edited away from Non-Trucking left "NTL is set to Yes" on
// the intake (NTL was unset) and asked nothing about an NTL mention in the notes, the only warning
// AmWINS gives; edited to Non-Trucking, the notes' question stayed, asking to set what is set.
test('an edit of auto liability or NTL keeps the intake\'s NTL items in step', () => {
  const context = { ntlMention: (t) => (/NTL/.test(t) ? 'Needs NTL' : null), ntlCheckMessage: (l) => `ask: ${l}`, NTL_FORM_MESSAGE: 'form says NTL',
    intakeNotes: (r) => [r.claims?.text, r.notes?.text].filter(Boolean).join('\n'), nonTruckingAnswer: (v) => /^non[\s-]*trucking$/i.test(String(v ?? '')) };
  vm.runInNewContext(`${extractFunction('ntlNotesItem')}\n${extractFunction('ntlAnswerEdited')}`, context);
  const intake = { record: { coverage: { autoLiability: 'Non-Trucking', ntl: true }, claims: { text: 'No' }, notes: { text: 'Needs NTL' } },
    warnings: [{ code: 'coverage.ntl-form', path: 'coverage.ntl', level: 'info', msg: 'form says NTL' }], done: [0] };
  const items = () => intake.warnings.map((w) => [w.code, w.level, w.msg === 'form says NTL' || /^ask/.test(w.msg)]);
  // Yes (rederive unset NTL): the form's note retired, the notes asked about.
  intake.record.coverage = { autoLiability: 'Yes', ntl: null };
  context.ntlAnswerEdited(intake, 'coverage.autoLiability');
  assert.deepEqual(items(), [['coverage.ntl-form', 'info', false], ['coverage.ntl', 'check', true]]);
  // Non-Trucking again: the form's note back, the notes' question retired.
  intake.record.coverage = { autoLiability: 'Non-Trucking', ntl: true };
  context.ntlAnswerEdited(intake, 'coverage.autoLiability');
  assert.deepEqual(items(), [['coverage.ntl-form', 'info', true], ['coverage.ntl', 'info', false]]);
  // NTL set to No by the agent: the form's note follows; the notes aren't asked about again.
  intake.record.coverage = { autoLiability: 'Non-Trucking', ntl: false };
  context.ntlAnswerEdited(intake, 'coverage.ntl');
  assert.deepEqual(items(), [['coverage.ntl-form', 'info', false], ['coverage.ntl', 'info', false]]);
  assert.match(extractFunction('agentEdit'), /if \(\['coverage\.ntl', 'coverage\.autoLiability'\]\.includes\(path\)\) ntlAnswerEdited\(state\.intake, path\);/);
  assert.match(extractFunction('claimsTextEdited'), /ntlNotesItem\(intake\);/);
});


// The maintainer, 2026-10-26, live run: Progressive's Rates on an NTL quote showed a "Non-trucking
// liability" item asking to be marked done, with no Mark done (a helper's reminder has no field). Its
// Mark done marks the helper done for the tab, as a click of the fill's would, and can be undone.
test('a helper\'s reminder has a Mark done that marks the helper done for the tab', async () => {
  const src = extractFunction('needRow');
  // The review of PR #176: only a reminder the fill marks as markable (`action`, the helper's own
  // scoped id), never one parsed from its path (ntlStillAdded's hold, a vehicle tile's `:0`).
  assert.match(src, /const actionId = x\.key \? null : x\.action \?\? null;/);
  assert.doesNotMatch(src, /x\.path\.slice\('action\.'/);
  assert.match(src, /onclick: \(\) => markActionDone\(item, actionId, tabId, page, x\) \}, 'Mark done'\)/);
  const state = { tab: { id: 4, url: 'CoveragesRates' }, filling: false, doneActions: new Set(), intake: null };
  const persisted = [];
  let settled = null;
  const node = { hidden: true, textContent: '', replaceChildren() {}, remove() {}, append() {}, querySelector: (sel) => (sel === '.row-head' ? null : node) };
  const item = { dataset: {}, classList: { remove() {} }, querySelector: (sel) => node.querySelector(sel) };
  const context = { state, pageOf: (u) => u, persistDoneActions: async (tabId) => { persisted.push([tabId, [...state.doneActions]]); },
    settleNeed: (it, how, undo) => { settled = { how, undo }; it.dataset.settled = how; }, setRowHead() {}, recount() {}, usage: { log() {} } };
  vm.runInNewContext(extractFunction('markActionDone'), context);
  await context.markActionDone(item, 'ntlRates', 4, 'CoveragesRates');
  assert.deepEqual([[...state.doneActions], settled.how, persisted.at(-1)], [['ntlRates'], 'marked', [4, ['ntlRates']]]);
  await settled.undo();
  assert.deepEqual([...state.doneActions], [], 'undone');
  // Another tab or page in front, or a fill running: nothing.
  await context.markActionDone(item, 'ntlRates', 5, 'CoveragesRates');
  state.filling = true;
  await context.markActionDone(item, 'ntlRates', 4, 'CoveragesRates');
  assert.deepEqual([...state.doneActions], []);
});


// The maintainer, 2026-10-26: "Save the unfinished recording" said "Couldn't open it: A requested
// file or directory could not be found", and the button stayed. Its recording was gone from the
// browser (saved by another panel). Said in words, and the button drawn again.
test('an unfinished recording already gone is said so, and the button is drawn again', async () => {
  const said = [];
  let redrawn = 0;
  const gone = Object.assign(new Error('A requested file or directory could not be found at the time an operation was processed.'), { name: 'NotFoundError' });
  const context = { $: () => ({ dataset: { id: 'geico-x' } }), devrecSaid: (s) => said.push(s), renderUnfinished: async () => { redrawn++; },
    saveRecording: async () => {}, RecordingStore: { reopen: async () => { throw gone; } } };
  vm.runInNewContext(extractFunction('recoverRecording'), context);
  await context.recoverRecording();
  assert.deepEqual([said, redrawn], [['That recording is no longer in this browser: another panel already saved it.'], 1]);
  context.RecordingStore.reopen = async () => { throw new Error('disk full'); };
  await context.recoverRecording();
  assert.deepEqual([said[1], redrawn], ['Couldn\'t open it: disk full', 2]);
});

// Review of PR 179: with no key of the agent's own, Assistant said the intake goes to OpenAI
// "through TNI's server, with TNI's key" whatever the Server setting: also with a test server set
// under Advanced (whose key it is), and with no server at all, when nothing can be sent.
test('Assistant names where Luna\'s requests go: the agent\'s key, TNI\'s server, another server, or nowhere yet', async () => {
  const central = 'https://central.example';
  const said = async (cfg) => {
    const els = new Map();
    const el = (id) => {
      if (!els.has(id)) els.set(id, { id, hidden: id === 'key-form', checked: false, disabled: false, textContent: '', className: '', title: '', dataset: {}, classList: { toggle() {} } });
      return els.get(id);
    };
    const context = { $: el, URL, usage: { DEFAULT_SERVER: central }, renderUsage() {},
      PROVIDERS: { luna: { name: 'Luna', company: 'OpenAI', keyLabel: 'OpenAI API key', automatic: true } },
      aiSettings: async () => ({ provider: 'luna', on: true, auto: false, model: 'gpt-6-luna', apiKey: '', proxy: null, ready: false, ...cfg }) };
    vm.createContext(context);
    vm.runInContext(extractFunction('renderAiSettings'), context);
    await context.renderAiSettings();
    return { privacy: el('ai-privacy').textContent, key: el('key-status').textContent };
  };
  const own = await said({ apiKey: 'sk-own', ready: true });
  assert.match(own.privacy, /^Sent to OpenAI with your key:/);
  const tni = await said({ proxy: { url: `${central}/v1/luna`, token: 'upload' }, ready: true });
  assert.match(tni.privacy, /^Sent to OpenAI through TNI's server, with TNI's key:/);
  assert.match(tni.key, /TNI's server provides it/);
  const other = await said({ proxy: { url: 'http://localhost:8787/v1/luna', token: '' }, ready: true });
  assert.match(other.privacy, /^Sent to OpenAI through the usage server set under Advanced, with that server's key:/);
  assert.doesNotMatch(other.privacy, /TNI's server|TNI's key/);
  assert.doesNotMatch(other.key, /TNI's/);
  const none = await said({});
  assert.match(none.privacy, /^Sent to OpenAI with your key, once you add one:/);
  assert.doesNotMatch(none.privacy, /TNI's server|TNI's key/);
});

// A frame that swaps its document between the panel's injection of the kit and its snapshot read (a
// hidden chat frame still loading: the AmWINS mock's Intercom frame) has no kit when the read runs.
// The read threw there ("Cannot read properties of undefined (reading 'decisionSnapshot')", the Luna
// mock, 2026-10-26, 3 of 11 runs on the speed branch, 0 of 6 on main). It now gives that frame null,
// which differs from any snapshot taken before, so the decision is refused as on a changed page,
// as the panel's callers already did when the read failed.
test('every snapshot read gives a frame without the kit null instead of throwing', () => {
  const reads = SIDEPANEL.match(/\(\) => \(?globalThis\.__raterKit[^\n]*?decisionSnapshot\(\)[^\n]*?\)(?=[),;])/g) ?? [];
  assert.ok(reads.length >= 9, `snapshot reads found: ${reads.length}`);
  for (const source of reads) {
    assert.equal(vm.runInNewContext(`(${source})()`, {}), null, `no kit: ${source}`);
    assert.equal(vm.runInNewContext(`(${source})()`, { __raterKit: { decisionSnapshot: () => 'snapshot' } }), 'snapshot', `the kit's: ${source}`);
  }
  assert.doesNotMatch(SIDEPANEL, /\(\) => globalThis\.__raterKit\.decisionSnapshot\(\)/, 'no read that throws without the kit');
});

// Review of PR 178: the next-step watch's read (busy, then the step's signature) still threw in a
// frame without the kit, the frame the snapshot reads above now read as null. Chrome then gives that
// frame null and reports the error on its page (Chromium 153, 2026-10-26), as it did for the snapshot
// reads that failed the Luna mock; the watch, reading every 150 ms now, did that twice as often.
test('the next-step watch reads a frame without the kit as nothing, without throwing there', async () => {
  let fills = 0, reads = 0;
  const thrown = [];
  const state = { tab: { id: 1, url: 'Step' }, intake: {}, filling: false, pagePending: null, autoPaused: false, advanceRetried: new Set(), doneSteps: new Set() };
  const context = { state, pageOf: (u) => u, $: () => ({ checked: true }), setTimeout: (fn) => fn(), fillProblem() {}, fillPage: () => { fills++; }, usage: { log() {} } };
  // Frame 0 has the kit and shows the next step from the third read; frame 3's document was replaced
  // after the kit was injected, so it has none.
  context.runKit = async (tabId, carrier, func) => {
    reads++;
    const run = (globals) => { try { return vm.runInNewContext(`(${func})()`, globals); } catch (e) { thrown.push(e.message); return null; } };
    return [{ frameId: 0, result: run({ __raterKit: { busy: () => false, signature: () => (reads > 2 ? 'next' : 'same') } }) }, { frameId: 3, result: run({}) }];
  };
  vm.runInNewContext(extractFunction('watchNextStep'), context);
  await context.watchNextStep({ id: 'amwins' }, 'Step', 'same', 'Step||Vehicles');
  assert.deepEqual(thrown, []);
  assert.equal(fills, 1, 'the next step is filled');
});

// The other kit calls had the same gap: the AI banner's call threw "Cannot read properties of
// undefined (reading 'aiBanner')" on the mock's page when the tab moved to a new document between
// the kit's injection and the call (Luna mock, 2026-10-28: PR 216, the 0.9.27 release PR, 1 run in
// 61 on PR 225). Chrome gives a throwing frame no result, as `?.` does, so callers see the same.
test('no kit call throws in a frame without the kit', () => {
  // A line calling the kit with `.` checks first that it is there (the snapshot reads, the watch).
  const unguarded = SIDEPANEL.split('\n').filter((line) => /globalThis\.__raterKit\.\w+\(/.test(line)
    && !/globalThis\.__raterKit \? |!globalThis\.__raterKit \|\| /.test(line));
  assert.deepEqual(unguarded, []);
  const calls = SIDEPANEL.match(/globalThis\.__raterKit\?\.\w+\(/g) ?? [];
  assert.ok(calls.length >= 16, `optional kit calls found: ${calls.length}`);
  assert.equal(vm.runInNewContext('((l) => globalThis.__raterKit?.aiBanner(l))([])', {}), undefined);
});

// W44-05, GEICO PA (2026-10-26): the agent left Vehicles during the van's form and confirmed "Yes,
// Discard Changes"; the van's form kept the van bound (unitForms), so back on Vehicles the next blank
// form was filled as the box truck, and the van was never added. A discarded form lets go of its unit.
test('a unit form the agent discards no longer holds its unit; other forms and clicks change nothing', () => {
  const persisted = [];
  const state = { tab: { id: 4 }, unitForms: { vehicles: { VAN: 0, OTHER: 1 }, drivers: { D: 0 }, trailers: {} } };
  const context = { state, persistUnitForms: (tabId, forms) => persisted.push([tabId, JSON.parse(JSON.stringify(forms))]) };
  vm.createContext(context);
  vm.runInContext(extractFunction('releaseDiscardedForms'), context);
  context.releaseDiscardedForms([{ list: 'vehicles', id: 'VAN', blank: false }]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.unitForms)), { vehicles: { OTHER: 1 }, drivers: { D: 0 }, trailers: {} });
  assert.equal(persisted.length, 1);
  // A form no fill bound, or none on screen: nothing to let go, nothing saved.
  context.releaseDiscardedForms([{ list: 'vehicles', id: 'NEW', blank: true }]);
  context.releaseDiscardedForms([]);
  assert.equal(persisted.length, 1);
});

// W44-05: only the agent's Yes to GEICO's discard question lets go of the forms on screen. "Discard
// Changes" only opens the question, and "No, please don't discard." keeps the form and its answers: let
// go there, the form the agent kept would be filled as the next unit picked (the mock's #action-modal).
test('only a confirmed discard, with the forms on screen, lets go of their units', () => {
  const state = { intake: { record: {} }, tab: { id: 4, carrier: { id: 'geico' } }, unitForms: { vehicles: { VAN: 0 }, drivers: {}, trailers: {} } };
  const context = { state, usage: { log() {} }, pageOf: (u) => u, samePage: (p) => p, viewOf: () => 't1', knownStep: () => undefined,
    redactor: () => (s) => s, redactionTerms: () => [], agentHelperDone() {}, persistUnitForms() {} };
  vm.createContext(context);
  vm.runInContext(['releaseDiscardedForms', 'onRecorderMessage'].map(extractFunction).join('\n'), context);
  const click = (text, forms = [{ list: 'vehicles', id: 'VAN', blank: false }]) => context.onRecorderMessage({ ra: 'usage', event: 'agent_click', page: '/quote', text, forms }, { tab: { id: 4 }, frameId: 0 });
  for (const text of ['Discard Changes', 'No, please don\'t discard.', 'Save and Continue']) {
    click(text);
    assert.deepEqual(Object.keys(state.unitForms.vehicles), ['VAN'], text);
  }
  click('Yes, please discard.', null);
  assert.deepEqual(Object.keys(state.unitForms.vehicles), ['VAN'], 'no forms sent');
  click('Yes, please discard.');
  assert.deepEqual(Object.keys(state.unitForms.vehicles), [], 'the confirm lets go');
  state.unitForms.vehicles.VAN = 0;
  click('Yes, Discard Changes');
  assert.deepEqual(Object.keys(state.unitForms.vehicles), [], 'the live run\'s words');
});

// W44-01: the unit pickUnitToAdd found missing from the list with nothing to add it is an item the top
// frame's report leaves for the agent, holding its Continue; nothing for another frame, a halted fill,
// or when nothing is missing.
test('a unit missing from the list with no helper for it is left for the agent in the top frame\'s report', () => {
  const context = { unitMissingItem };
  vm.createContext(context);
  vm.runInContext(extractFunction('noteMissingUnit'), context);
  const record = { applicant: { ownerDrives: null }, drivers: [{ first: 'Pat', last: 'Owner' }, { first: 'Sam', last: 'Second' }] };
  const ctx = { carrier: geico, intake: { record }, unitMissing: { list: 'drivers', index: 1 } };
  const results = [{ frameId: 3, result: { noData: [], blockers: [] } }, { frameId: 0, result: { noData: [], blockers: ['continue: none to click'] } }];
  context.noteMissingUnit(results, ctx);
  assert.deepEqual(results[0].result, { noData: [], blockers: [] });
  const top = results[1].result;
  assert.deepEqual(JSON.parse(JSON.stringify([top.noData.map((x) => [x.label, x.path]), top.blockers])), [[['Add Driver', 'drivers[1]']], ['continue: none to click', 'needs you: Add Driver']]);
  assert.match(top.noData[0].note, /^Sam Second \(driver 2 of the intake\)/);
  const halted = [{ frameId: 0, result: { halted: true, noData: [], blockers: [] } }];
  context.noteMissingUnit(halted, ctx);
  assert.equal(halted[0].result.noData.length, 0);
  const none = [{ frameId: 0, result: { noData: [], blockers: [] } }];
  context.noteMissingUnit(none, { ...ctx, unitMissing: null });
  assert.equal(none[0].result.noData.length, 0);
});
