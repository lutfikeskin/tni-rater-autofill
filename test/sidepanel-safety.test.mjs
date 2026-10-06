import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { assistContextKey } from '../src/ai/common.js';
import { DEFAULT_MODEL, POLICY_VERSION } from '../src/ai/luna.js';
import { fillEvents, sha256Hex } from '../src/usage.js';


const SIDEPANEL = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');
// Layout scheduling has its own tests (layoutHarness); others only need it to exist.
const LAYOUT_STUB = '\nfunction scheduleLayout() {}';

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
        // Agent-edit scoping is shared by many functions: bring its helpers along.
        if (name !== 'agentEdited' && /\bagentEdited\(/.test(source)) source += `\n${extractFunction('agentEdited')}`;
        return name !== 'editScope' && /\beditScope\(/.test(source) ? `${source}\n${extractFunction('editScope')}` : name !== 'stepScope' && /\bstepScope\(/.test(source) && name === 'editScope' ? `${source}\n${extractFunction('stepScope')}` : source;
      }
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const HELPERS_START = SIDEPANEL.indexOf('const samePage =');
const HELPERS_END = SIDEPANEL.indexOf('\n\n// Watch the rater tab', HELPERS_START);
const PAGE_HELPERS = SIDEPANEL.slice(HELPERS_START, HELPERS_END);
const FUNCTIONS = ['rememberFill', 'scheduleAutoFill', 'refreshTab'].map(extractFunction).join('\n') + LAYOUT_STUB;

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
    ensureRecorder: async () => {}, retireAiOrigins: async () => {}, restoreAgentKeys: async () => {}, persistAgentKeys: async () => {},
    carrierForUrl: (url) => (/foragentsonly/.test(url) ? { id: 'progressive', practice: false } : null),
    chrome: {
      scripting: {},
      tabs: { query: async () => [activeTab], get: async (id) => (openTabs.get(id) ?? Promise.reject(new Error('No tab'))) },
    },
  };
  vm.runInNewContext(`${PAGE_HELPERS}\n${FUNCTIONS}`, context, { filename: 'sidepanel/sidepanel.js' });

  return {
    state,
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


test('fill report omits absent sections without rendering null text', () => {
  const box = { className: '', children: [], replaceChildren(...children) { this.children = children; } };
  const context = {
    $: () => box,
    state: { tab: { id: 1, url: 'https://example.test/?pageName=AddVehicle' } },
    pageOf: () => 'AddVehicle',
    h: (tag, props, ...children) => ({ tag, props, children }),
  };
  vm.runInNewContext(extractFunction('renderReport'), context);
  context.renderReport([{ fields: 1, filled: [{ label: 'Zip Code', shown: '21000' }], kept: [], failed: [], noData: [], leftRequired: [], actions: [] }]);
  assert.ok(box.children.length > 0);
  assert.ok(box.children.every((child) => child != null && child !== false), 'DOM replaceChildren must receive only actual report nodes');
});

test('ignore button skips only the chosen field on the current page and resumes filling', async () => {
  const state = { tab: { id: 1, url: 'Rates' }, agentKeys: new Map(), filling: false, autoPaused: true };
  const calls = [];
  const context = { state, persistAgentKeys: async () => {}, pageOf: (url) => url, fillPage: async () => calls.push([...state.agentKeys.get('Rates')]) };
  vm.runInNewContext(extractFunction('ignoreReview'), context);
  await context.ignoreReview('200F', 1, 'Rates');
  assert.deepEqual(calls, [['200F']]);
  await context.ignoreReview('other', 2, 'Rates');
  await context.ignoreReview('other', 1, 'OldPage');
  state.filling = true;
  await context.ignoreReview('other', 1, 'Rates');
  assert.equal(calls.length, 1);
  assert.deepEqual([...state.agentKeys.get('Rates')], ['200F']);
});

test('warning rows render accessible dismiss buttons bound to their field and page', () => {
  const box = { replaceChildren(...children) { this.children = children; } };
  const clicks = [];
  const context = {
    $: () => box,
    state: { tab: { id: 7, url: 'Rates' } }, pageOf: (url) => url,
    h: (tag, props, ...children) => ({ tag, props, children }),
    ignoreReview: (...args) => clicks.push(args),
  };
  vm.runInNewContext(extractFunction('renderReport'), context);
  context.renderReport([{ fields: 3, halted: true, unknown: [{ key: '200F', label: 'Vehicle field' }], failed: [{ key: 'failed', label: 'Rejected', reason: 'invalid' }], noData: [{ key: 'missing', label: 'Missing' }] }]);
  const buttons = [];
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.tag === 'button') buttons.push(node);
    visit(node.children);
  };
  visit(box.children);
  assert.equal(buttons.length, 3);
  assert.ok(buttons.every((button) => button.props['aria-label'].includes('Ignore')));
  buttons.forEach((button) => button.props.onclick());
  assert.deepEqual(clicks, [['200F', 7, 'Rates'], ['failed', 7, 'Rates'], ['missing', 7, 'Rates']]);
});

test('warning-only automatic follow-ups render and log unfamiliar fields without pausing', async () => {
  const frames = [{ fields: 1, filled: [], actions: [], unknown: [{ key: 'new', label: 'New question' }], halted: false }];
  const logged = [], rendered = [], layouts = [], assisted = [];
  const state = { tab: { id: 1, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, active: {}, agentKeys: new Map(), autoPaused: false, filling: false, layoutReadyTabs: new Set() };
  const context = {
    state, Date, pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options, viewOf: () => 't1',
    runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {},
    renderReport: (result) => rendered.push(result), recordLayout: (page) => layouts.push(page),
    fillEvents: () => [{ type: 'fill_field', result: 'unfamiliar' }],
    redactionTerms: () => [], redactor: () => (s) => s, usage: { log: (...events) => logged.push(...events), currentSession: () => null },
    runAssist: (result, ctx) => assisted.push({ result, ctx, filling: state.filling }),
    pickListItem: async () => {}, retireAiOrigins: async () => {},
    afterFill: () => {},
    runPendingPage: () => {},
  };
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
    const context = { state, assistContextKey, aiFingerprint: JSON.stringify, pageOf: url => new URL(url).pathname,
      runKit: () => { calls++; snapshotEntered(); return snapshot; }, tellRecorder: async () => {},
      persistAiPending: async () => { persisted++; } };
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
  const context = { state, assistContextKey, aiFingerprint: JSON.stringify, pageOf: url => new URL(url).pathname,
    runKit: async () => responses.shift(), tellRecorder: async () => {}, persistAiPending: async () => {},
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

function makeAiActionHarness({ rejected = false } = {}) {
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
    aiCache: new Map([[signature, x]]), agentKeys: new Map(), aiRun: 0,
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
  const phrase = rejected ? 'Confirm the current page answer' : 'Approve and continue';
  const button = () => aiActionButtons(holder.children)
    .find(candidate => aiActionTreeText(candidate.children) === phrase);
  assert.ok(button(), 'real renderAi ' + (rejected ? 'Confirm' : 'Approve') + ' button rendered');
  return {
    state, ctx, x, frame, holder, calls, fillCalls: () => fillCalls, button,
    snapshotStartedPromise, release: (snapshot = [frame]) => releaseSnapshot(snapshot),
  };
}

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
  for (const [label, mutate] of mutations) {
    const h = makeAiActionHarness();
    await awaitDeferredAction(h, mutate);
    assert.equal(h.x.approved, false, label + ': late approval did not mark the cached item');
    assert.equal(h.x.rejected, false, label + ': late approval did not rewrite the item as moved');
    assert.equal(h.fillCalls(), 0, label + ': late approval did not call fillPage');
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
  for (const [label, mutate] of mutations) {
    const h = makeAiActionHarness({ rejected: true });
    await awaitDeferredAction(h, mutate);
    assert.equal(h.x.confirmed, false, label + ': late confirmation did not settle the hold');
    assert.equal(h.fillCalls(), 0, label + ': late confirmation did not call fillPage');
  }
});

test('renderAi approval and confirmation allow an active-driver change when intake/page/cache remain current', async () => {
  const approved = makeAiActionHarness();
  const approval = approved.button().props.onclick();
  await approved.snapshotStartedPromise;
  approved.state.active = { drivers: 1, vehicles: 0 };
  approved.release();
  await approval;
  assert.equal(approved.x.approved, true, 'active-driver change does not invalidate approval');
  assert.equal(approved.fillCalls(), 1, 'current approval still continues the fill');

  const confirmed = makeAiActionHarness({ rejected: true });
  const confirmation = confirmed.button().props.onclick();
  await confirmed.snapshotStartedPromise;
  confirmed.state.active = { drivers: 1, vehicles: 0 };
  confirmed.release();
  await confirmation;
  assert.equal(confirmed.x.confirmed, true, 'active-driver change does not invalidate confirmation');
  assert.equal(confirmed.fillCalls(), 1, 'current confirmation still continues the fill');
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
    const context = { state, assistContextKey, aiFingerprint: JSON.stringify, aiSafeText: String,
      DEFAULT_MODEL: 'gpt-6-luna', POLICY_VERSION: 'policy', pageOf: value => new URL(value).pathname,
      usage: { currentSession: () => scope ? { intakeId: scope } : null },
      aiPersistQueue: Promise.resolve(), aiRetiredSignatures: new Set(),
      aiPendingStore: { get: async () => stored, set: async value => { stored = value; } },
      tellRecorder: async () => {},
      runKit: () => {
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
    $: () => ({}), clearTimeout() {}, pdfjs: {}, readIntakeFields: async () => ({ synthetic: true }),
    normalizeIntake: () => ({ record, warnings: [] }), intakeSummary: async () => ({ intakeId: scope }),
    store: { set: async () => {} }, clearAgentKeys: async () => {}, uploadNow() {},
    save: async () => {}, render() {}, refreshTab() {}, reviewClaimsBox() {} };
  vm.runInNewContext(['aiOriginRecord', 'aiCacheSignature', 'aiPendingRecord', 'aiDecisionBlocks',
    'persistAiPending', 'restoreAiPending', 'discardAiSuggestions', 'cancelLayouts', 'holdLayouts', 'resetViews', 'saveViews', 'loadFile'].map(extractFunction).join('\n'), context);
  await context.persistAiPending();
  assert.equal(stored.length, 2, 'the previous ledger contains the settled and unresolved decisions');
  await context.loadFile({ name: 'synthetic.pdf', arrayBuffer: async () => new ArrayBuffer(1) });
  assert.equal(state.aiCache.has(manualSig), false, 'the old manual decision cannot suppress a fresh unresolved question');
  assert.equal(state.aiCache.get(pendingSig), pending, 'the existing unresolved hold keeps its identity');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, 'pending');
});

// 2026-10-05 FL run: after the first vehicle's Add Vehicle was continued, the second and third
// vehicles' (same headings) were taken for the agent going back, and Continue wasn't clicked.
test('a continued step is remembered per vehicle on vehicle pages, per driver on the driver page, quote-wide elsewhere', () => {
  const progressive = { vehicleList: 'VehicleSummary', driverList: 'DriverSummary', vehiclePages: ['MostCommonVehicles', 'AddVehicle'], driverPage: 'AddDriver' };
  const state = { active: { vehicles: 0, drivers: 0 }, doneSteps: new Set(), autoPaused: false, tab: { carrier: progressive } };
  const watched = [];
  const context = { state, $: () => ({ checked: false }), scheduleAutoFill: () => {}, setTimeout: () => {}, watchNextStep: (...args) => watched.push(args) };
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
  const box = { replaceChildren(...children) { this.children = children; } };
  const context = {
    $: () => box, state: { tab: { id: 7, url: 'MostCommonVehicles' } }, pageOf: (url) => url,
    h: (tag, props, ...children) => ({ tag, props, children }), ignoreReview: () => {},
  };
  vm.runInNewContext(extractFunction('renderReport'), context);
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [],
    noData: [{ label: 'Vehicle type', key: null, note: 'Tanker isn\'t matched to a Progressive tile yet: pick the vehicle yourself.' }] }]);
  const text = JSON.stringify(box.children);
  assert.match(text, /Vehicle type/);
  assert.match(text, /pick the vehicle yourself/);
  assert.doesNotMatch(text, /No form fields found/);
  context.renderReport([{ fields: 0, filled: [], kept: [], failed: [], leftRequired: [], actions: [], noData: [] }]);
  assert.match(JSON.stringify(box.children), /No form fields found/, 'an empty page is still said to be empty');
});

function assistHarness({ suggest, cfg = {} } = {}) {
  const logged = [], rendered = [], applied = [];
  const node = (tag, props = {}, ...children) => ({ tag, props, children: children.flat(), isConnected: true,
    replaceChildren(...next) { this.children = next; }, remove() { this.isConnected = false; }, before() {} });
  const report = { append(child) { child.isConnected = true; this.children = [...(this.children ?? []), child]; }, querySelector: () => null };
  const record = { vehicles: [] };
  const state = { intake: { record }, active: { drivers: 0, vehicles: 0 }, tab: { id: 1, url: 'https://rater.test/Default.aspx?pageName=CoveragesRates' },
    aiRun: 0, aiCache: new Map(), agentKeys: new Map(), filling: false };
  const context = {
    state, assistContextKey, pageOf: (url) => new URL(url).searchParams.get('pageName'), h: node, $: () => report,
    aiSettings: async () => ({ on: true, apiKey: 'synthetic', model: 'gpt-6-luna', provider: 'luna', auto: false, ...cfg }),
    PROVIDERS: { luna: { name: 'Luna', policy: 'synthetic-policy' } },
    collectItems: () => ({ items: [{ key: '1FF9', label: '2016 FREIGHTLINER CASCADIA 125' }], blocked: [] }),
    aiSettledOnPage: () => false, aiFingerprint: (v) => JSON.stringify(v), aiItemFingerprint: (x) => `${x.key}|${x.label}`,
    aiCacheSignature: (x) => JSON.stringify(x), runKit: async () => [{ frameId: 0, result: 'snapshot' }],
    suggest, AssistError: class extends Error {}, usage: { log: (...events) => logged.push(...events) },
    renderAi: (...args) => rendered.push(args), applyAi: async (...args) => { applied.push(args); return false; },
    syncAiBanner: () => {}, pendingAi: () => [],
  };
  vm.runInNewContext(extractFunction('aiActionCurrent') + extractFunction('runAssist'), context);
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
    const context = {
      state, Date, pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options,
      runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {}, renderReport: (result) => rendered.push(result),
      recordLayout: () => {}, fillEvents: () => [], redactionTerms: () => [], redactor: () => (s) => s, usage: { log: () => {}, currentSession: () => null },
      runAssist: (result, ctx) => assisted.push(ctx.page), pickListItem: async () => {}, retireAiOrigins: async () => {},
      afterFill: () => followUp, runPendingPage: () => {}, viewOf: () => 't1',
    };
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
    state, AssistError, Date, redactor: () => (s) => s, redactionTerms: () => [], claimsTruncated: (text) => /LONG/.test(text ?? ''),
    aiSettings: async () => ({ on: !state.offline, apiKey: 'k', model: 'gpt-6-luna' }),
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
  assert.match(failing.warnings[1].msg, /Read it yourself/);
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
  const context = { ntlMention, ntlCheckMessage, save() {}, render() {} };
  vm.runInNewContext(extractFunction('claimsTextEdited'), context);
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
  const context = { state, persistAgentKeys: async () => {}, pageOf: (url) => url, fillPage: async () => fills.push(1) };
  vm.runInNewContext(extractFunction('ignoreReview'), context);
  await context.ignoreReview('2091', 1, 'AddVehicle');
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
      lastLayouts: new Map(), layoutChain: Promise.resolve(), layoutTimer: null, layoutPending: null, layoutErrors: 0, layoutErrorsLogged: new Set() },
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
      return [{ result: { controls: controls(), buttons: ['Continue'], isTopFrame: true, page: context.domPage ?? context.state.tab.url, step: context.domStep ?? '' } }];
    },
    sessionId: session,
    usage: { currentSession: () => (context.sessionId ? { id: context.sessionId } : null), log: (e) => logged.push(e) },
    store: { saved: {}, set(k, v) { this.saved[k] = v; return Promise.resolve(); } },
    LAYOUT_DELAY_MS: 0, setTimeout: (fn) => { context.pending = fn; return 1; }, clearTimeout: () => { context.pending = null; },
  };
  vm.runInNewContext(['viewOf', 'saveViews', 'resetViews', 'stepScope', 'recordLayout', 'layoutJob', 'jobCurrent', 'intakeEdited', 'sameLayoutScope', 'superseded', 'holdLayouts', 'captureLayout', 'waitForFill', 'layoutFailed', 'layoutErrorKind', 'scheduleLayout', 'cancelLayouts', 'layoutWhenQuiet']
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
  assert.equal(logged.length, 4, 'an unchanged layout once; a change of choices, cut or required again');
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
    fieldChangeEvent: (c) => ({ type: 'field_change', q: c.q, from: c.before, to: c.after, by: 'page' }),
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
  Object.assign(context, { samePage: (p) => p, redactor: () => (s) => s, scheduleAutoFill: () => {}, fieldChangeEvent: () => ({ type: 'field_change' }) });
  Object.assign(context.state, { filled: new Map(), labels: new Map() });
  vm.runInContext(extractFunction('onRecorderMessage'), context);
  context.onRecorderMessage({ ra: 'usage', event: 'new_fields', page: '/widgets/address-frame', keys: ['x'] }, { tab: { id: 1 }, frameId: 3 });
  await context.pending();
  await context.state.layoutChain;
  assert.deepEqual(logged.map((e) => [e.type, e.page, e.reason]), [['page_layout', 'Vehicles', 'appeared']]);
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
  // A carrier with no quote-page address (GEICO for now): its portal, account and search pages
  // are never captured on their own; fills still record theirs.
  context.state.tab.carrier = { id: 'geico' };
  context.scheduleLayout('Vehicles', 'arrived');
  assert.equal(scheduled(), false);
  context.state.tab.carrier = { id: 'progressive', autoFillUrl: /\/Express\/Default\.aspx/ };
  context.state.tab.url = 'https://portal.example/Home/Search';
  context.scheduleLayout('Vehicles', 'arrived');
  assert.equal(scheduled(), false, 'a page outside the quote');
  context.state.tab.url = 'https://portal.example/Express/Default.aspx?pageName=Vehicles';
  context.scheduleLayout('Vehicles', 'arrived');
  assert.equal(scheduled(), true);
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
    fieldChangeEvent: () => ({ type: 'field_change' }) });
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
  assert.equal((extractFunction('fillPage').match(/__raterKit\.fill\(p, o\), \[plan, fillOptions\(carrier, \{ overwrite \}\)\]\);\s+\/\/[^\n]*\n\s+state\.layoutReadyTabs\.add\(tabId\);/g) ?? []).length, 1);
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
  assert.match(SIDEPANEL, /chrome\.tabs\.onCreated\.addListener\(\(tab\) => \{ if \(state\.layoutHold\) state\.layoutNewTabs\.add\(tab\.id\); \}\)/);
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
    const context = {
      state, Date, pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options,
      runKit, rememberFill: () => {}, renderReport: () => {}, recordLayout: () => {}, fillEvents: () => [],
      redactionTerms: () => [], redactor: () => (s) => s, usage: { log: () => {}, currentSession: () => null },
      runAssist: () => {}, pickListItem: async () => {}, retireAiOrigins: async () => {}, afterFill: () => {}, runPendingPage: () => {},
      $: () => ({ append() {} }), h: () => ({}), viewOf: () => 't1',
    };
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
  assert.match(extractFunction('init'), /wire\(\);[\s\S]{0,300}holdLayouts\(\);[\s\S]{0,80}state\.intake = \(await store\.get\('intake'\)\)/);
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
    pickListItem: async () => {}, retireAiOrigins: async () => {}, buildPlan: () => [], fillOptions: () => ({}),
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
  context.state.tab.carrier = { id: 'amwins', layoutUrl: /./, layoutSteps: true };
  context.domStep = 'Vehicles';
  await context.recordLayout('Vehicles', 'arrived');
  context.domStep = 'Coverages';
  controls = [{ label: 'Exclude Collision Coverage', kind: 'radio', options: ['Yes', 'No'] }];
  await context.recordLayout('Vehicles', 'changed');
  // Back on the Vehicles step, unchanged: already logged for that step.
  context.domStep = 'Vehicles';
  controls = [{ label: 'VIN', kind: 'text' }];
  await context.recordLayout('Vehicles', 'changed');
  assert.deepEqual(logged.map((e) => [e.step, e.fields[0].label]), [['Vehicles', 'VIN'], ['Coverages', 'Exclude Collision Coverage']]);
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
    fieldChangeEvent: () => ({ type: 'field_change' }) });
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
    assert.ok(body.indexOf('const view = viewOf(tabId, page, carrier);') < body.indexOf('await pickListItem('), `${name} takes the view before any waiting`);
    assert.match(body, /fillEvents\(frames, \{[^}]*\bview\b/, `${name} logs that view`);
  }
  assert.match(extractFunction('onRecorderMessage'), /auto: 'stop'/);
  assert.match(extractFunction('onRecorderMessage'), /page: stopPage, view: viewOf\(sender\.tab\.id, stopPage\)/);
  assert.match(extractFunction('init'), /usage\.restoreSession\([\s\S]{0,80}\);\s+const views = await store\.get\('views'\);\s+if \(views\?\.session && views\.session === usage\.currentSession\(\)\?\.id\) state\.viewTabs = new Map\(views\.tabs\);/);
});

test('a manual capture is numbered in its scenario, keeps a redacted note and scenario, and is only downloaded', async () => {
  const downloads = [], blobs = [];
  let settings = {};
  const ui = { 'capture-scenario': { value: ' Jordan Avery van ' }, 'capture-note': { value: 'set hazmat for Jordan Avery to Yes' }, report: { replaceChildren(...x) { ui.reported = x; } } };
  const context = {
    state: { tab: { id: 3, url: 'Operations', carrier: { id: 'progressive' } }, intake: { record: { garaging: {}, operations: {}, vehicles: [], trailers: [], coverage: {} } }, active: {}, intakeRevision: 0 },
    $: (id) => ui[id], h: (tag, props, text) => ({ text, click: () => downloads.push(props.download) }),
    redactor: () => (s) => s.split('Jordan Avery').join('[client]'), redactionTerms: () => [], buildPlan: () => [],
    pageOf: (u) => u, viewOf: () => 't1',
    runKit: async () => [{ result: { isTopFrame: true, page: context.domPage ?? 'Operations', step: '', controls: [{ q: '2A1' }], openLists: [] } }],
    usage: { currentSession: () => ({ id: 'quote-1' }), settings: async () => settings, saveSettings: async (patch) => { settings = { ...settings, ...patch }; } },
    Blob: class { constructor(parts) { blobs.push(JSON.parse(parts[0])); } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, setTimeout: () => 0, JSON, String,
  };
  vm.runInNewContext(extractFunction('capturePage'), context);
  await context.capturePage();
  await context.capturePage();
  assert.deepEqual(downloads, ['capture-progressive-client-van-001-Operations.json', 'capture-progressive-client-van-002-Operations.json']);
  assert.deepEqual([blobs[0].kind, blobs[0].version, blobs[0].scenario, blobs[0].n, blobs[0].note, blobs[0].view], ['page-capture', 2, '[client] van', 1, 'set hazmat for [client] to Yes', 't1']);
  assert.equal(blobs[1].note, null, 'a note belongs to the capture it was written for');
  assert.deepEqual(JSON.parse(JSON.stringify(settings.captureCounts)), { '[client] van': 2 }, 'kept in the settings, across browser restarts');
  // The page moved on while it was read: nothing saved.
  context.domPage = 'Drivers';
  await context.capturePage();
  assert.equal(downloads.length, 2);
  assert.match(SIDEPANEL, /chrome\.commands\?\.onCommand\.addListener\(\(command\) => \{ if \(command === 'capture-page'\) capturePage\(\); \}\)/);
});
