import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { assistContextKey } from '../src/ai/common.js';
import { DEFAULT_MODEL, POLICY_VERSION } from '../src/ai/luna.js';


const SIDEPANEL = fs.readFileSync(new URL('../sidepanel/sidepanel.js', import.meta.url), 'utf8');

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
      if (!depth) return SIDEPANEL.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const HELPERS_START = SIDEPANEL.indexOf('const samePage =');
const HELPERS_END = SIDEPANEL.indexOf('\n\n// Watch the rater tab', HELPERS_START);
const PAGE_HELPERS = SIDEPANEL.slice(HELPERS_START, HELPERS_END);
const FUNCTIONS = ['rememberFill', 'scheduleAutoFill', 'refreshTab'].map(extractFunction).join('\n');

function harness() {
  const state = {
    tab: null,
    filled: new Map(),
    labels: new Map(),
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
    renderSite: () => rendered.push(state.tab?.id ?? null),
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
  const state = { tab: { id: 1, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, active: {}, agentKeys: new Map(), autoPaused: false, filling: false };
  const context = {
    state, Date, pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options,
    runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {},
    renderReport: (result) => rendered.push(result), recordLayout: (page) => layouts.push(page),
    fillEvents: () => [{ type: 'fill_field', result: 'unfamiliar' }],
    redactionTerms: () => [], redactor: () => (s) => s, usage: { log: (...events) => logged.push(...events) },
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
      'snapshotsEqual', 'aiSnapshotFields', 'aiSnapshotFieldMatches', 'applyAi'].map(extractFunction).join('\n'), context);
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
    'applyAi'].map(extractFunction).join('\n'), context);
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
  'discardAiSuggestions', 'pendingAi', 'applyAi'].map(extractFunction).join('\n');

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
  const state = { intake: { record }, tabSessions: new Map(), aiCache: new Map([[manualSig, manual], [pendingSig, pending]]) };
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
    'persistAiPending', 'restoreAiPending', 'discardAiSuggestions', 'loadFile'].map(extractFunction).join('\n'), context);
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
test('a continued step is remembered per vehicle and driver on carriers that add them one at a time', () => {
  const progressive = { vehicleList: 'VehicleSummary', driverList: 'DriverSummary' };
  const state = { active: { vehicles: 0, drivers: 0 }, doneSteps: new Set(), autoPaused: false, tab: { carrier: progressive } };
  const watched = [];
  const context = { state, $: () => ({ checked: false }), scheduleAutoFill: () => {}, setTimeout: () => {}, watchNextStep: (...args) => watched.push(args) };
  vm.runInNewContext(extractFunction('stepScope') + extractFunction('afterFill'), context);
  context.afterFill([{ advanced: 'Continue', signatureBefore: 'before', stepKey: 'Vehicle Information / Common Questions' }], { carrier: progressive, page: 'AddVehicle' });
  assert.deepEqual([...state.doneSteps], ['AddVehicle|v0d0|Vehicle Information / Common Questions']);
  assert.equal(watched[0][3], 'AddVehicle|v0d0|Vehicle Information / Common Questions', 'the lost-Continue retry uses the same entry');
  const remembered = (carrier) => [...state.doneSteps].filter((s) => s.startsWith(context.stepScope('AddVehicle', carrier)));
  assert.equal(remembered(progressive).length, 1, 'back on the first vehicle: not continued again');
  state.active.vehicles = 1;
  assert.equal(remembered(progressive).length, 0, 'the next vehicle is a new step');
  // One-address applications (AmWINS) keep one entry per page and step, whatever the active row.
  assert.equal(context.stepScope('Step', {}), 'Step||');
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
  const state = { assistPage: null };
  const context = { state, runAssist: (frames, ctx) => asked.push(ctx.page) };
  vm.runInNewContext(extractFunction('assistAfterFill'), context);
  context.assistAfterFill([{ actions: [{ id: 'openCargo' }] }], { page: 'CoveragesRates' }, true);
  assert.deepEqual(asked, []);
  assert.equal(state.assistPage, 'CoveragesRates', 'held for the follow-up fill');
  context.assistAfterFill([{ navigatedTo: 'ChangePaymentPlan' }], { page: 'CoveragesRates' }, false);
  assert.deepEqual(asked, [], 'the bill plan opened: nothing to ask about this page');
  assert.equal(state.assistPage, null);
  context.assistAfterFill([{}], { page: 'CoveragesRates' }, false);
  assert.deepEqual(asked, ['CoveragesRates']);
});

test('the follow-up fill a Luna request waited for asks it, even with nothing unfamiliar left', async () => {
  const run = async (followUp) => {
    const frames = [{ fields: 2, filled: [], actions: [], unknown: [], noData: [{ key: 'k', label: 'Cargo limit' }], halted: false }];
    const rendered = [], assisted = [];
    const state = { tab: { id: 1, url: 'Rates', carrier: { id: 'progressive' } }, intake: { record: {} }, active: {}, agentKeys: new Map(),
      autoPaused: false, filling: false, assistPage: 'Rates' };
    const context = {
      state, Date, pageOf: (url) => url, tellRecorder: async () => {}, buildPlan: () => [], fillOptions: (_, options) => options,
      runKit: async () => frames.map((result) => ({ result })), rememberFill: () => {}, renderReport: (result) => rendered.push(result),
      recordLayout: () => {}, fillEvents: () => [], redactionTerms: () => [], redactor: () => (s) => s, usage: { log: () => {} },
      runAssist: (result, ctx) => assisted.push(ctx.page), pickListItem: async () => {}, retireAiOrigins: async () => {},
      afterFill: () => followUp, runPendingPage: () => {},
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
test('Luna reads the claims box once per intake, visibly fails, and retries on a settings change', async () => {
  const logs = [], requests = [];
  let settingsGate, reply = 'ok';
  const flagged = [{ code: 'ai.ntl', level: 'check', path: 'coverage.ntl', msg: 'x' }];
  const intake = { record: { claims: { text: 'Leased on, needs coverage off dispatch' }, coverage: {} }, warnings: [{ code: 'other', level: 'check' }], done: [] };
  const state = { intake, notesAsking: null };
  class AssistError extends Error {}
  const context = {
    state, AssistError, Date, redactor: () => (s) => s, redactionTerms: () => [],
    aiSettings: () => new Promise((resolve) => { settingsGate = () => resolve({ on: true, apiKey: 'k', model: 'gpt-6-luna' }); }),
    reviewNotes: async (record, cfg, opts) => {
      requests.push({ record, opts });
      if (reply === 'fail') throw new AssistError('Luna took too long. Nothing was applied.');
      return { warnings: flagged, lines: 1, tokensIn: 5, tokensOut: 1, modelCalls: 1, reasoningTokens: 0 };
    },
    usage: { log: (e) => logs.push(e) }, save: async () => {}, render: () => {},
  };
  vm.runInNewContext(extractFunction('reviewClaimsBox'), context);
  const first = context.reviewClaimsBox();
  await context.reviewClaimsBox();
  assert.equal(state.notesAsking, intake, 'taken before the settings were read');
  settingsGate();
  await first;
  assert.equal(requests.length, 1, 'two triggers close together ask once');
  assert.equal(typeof requests[0].opts.redact, 'function', 'names are redacted before the request');
  assert.deepEqual(intake.warnings.map((w) => w.code), ['other', 'ai.ntl']);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['items', 'leave', 'model', 'modelCalls', 'ms', 'page', 'reasoningTokens', 'suggested', 'tokensIn', 'tokensOut', 'type'], 'counts only, never the text');
  await context.reviewClaimsBox({ retry: true });
  assert.equal(requests.length, 1, 'once per intake');

  // A failure is a Check intake item, not silence; a plain reload doesn't ask again.
  const failing = { record: { claims: { text: 'Needs physical damage' }, coverage: {} }, warnings: [{ code: 'a', level: 'check' }], done: [0] };
  state.intake = failing;
  reply = 'fail';
  const pending = context.reviewClaimsBox();
  settingsGate();
  await pending;
  assert.deepEqual(failing.warnings.map((w) => [w.code, w.level]), [['a', 'check'], ['ai.claims-review-failed', 'check']]);
  assert.match(failing.warnings[1].msg, /Read it yourself/);
  assert.equal(logs.at(-1).error, 'Luna took too long. Nothing was applied.');
  await context.reviewClaimsBox();
  assert.equal(requests.length, 2, 'not retried on every panel reload');
  // A settings change tries again; the failure item is replaced in place (checked marks are by position).
  reply = 'ok';
  const retried = context.reviewClaimsBox({ retry: true });
  settingsGate();
  await retried;
  assert.deepEqual(failing.warnings.map((w) => [w.code, w.level]), [['a', 'check'], ['ai.claims-reviewed', 'info'], ['ai.ntl', 'check']]);
  assert.deepEqual(failing.done, [0]);

  // A result for a replaced intake is dropped.
  const old = { record: { claims: { text: 'NTL please' }, coverage: {} }, warnings: [], done: [] };
  state.intake = old;
  const late = context.reviewClaimsBox();
  state.intake = { record: { claims: { text: '' }, coverage: {} }, warnings: [], done: [] };
  settingsGate();
  await late;
  assert.deepEqual(old.warnings, []);
  assert.equal(old.notesReview, undefined);
});
