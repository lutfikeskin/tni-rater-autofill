import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { PANEL_SOURCE } from './panel-source.mjs';
import { assistContextKey } from '../src/ai/common.js';
import { DOCK } from '../sidepanel/panel/messages.js';

function extractFunction(name) {
  const re = new RegExp(`(?:async )?function ${name}\\s*\\(`);
  const m = re.exec(PANEL_SOURCE);
  if (!m) throw new Error(`missing function ${name}`);
  let i = PANEL_SOURCE.indexOf(') {', m.index) + 2;
  let depth = 0;
  for (; i < PANEL_SOURCE.length; i++) {
    if (PANEL_SOURCE[i] === '{') depth++;
    else if (PANEL_SOURCE[i] === '}' && --depth === 0) break;
  }
  return PANEL_SOURCE.slice(m.index, i + 1);
}

const HARNESS_FNS = [
  'aiOriginRecord', 'aiSnapshotFields', 'aiSnapshotFieldMatches', 'aiQuestionHash',
  'aiLiveFieldHash', 'aiAnswerOrigin', 'aiCurrentAnswerPresent', 'aiActionCurrent', 'aiCacheSignature',
  'aiDecisionBlocks', 'canonicalSnapshotMetadata', 'canonicalSnapshotFrame', 'canonicalSnapshots',
  'snapshotsEqual', 'snapshotFingerprint', 'snapshotHashMatches', 'aiPendingRecord', 'persistAiPending',
  'restoreAiPending', 'pendingAi', 'unlogged', 'applyAi', 'renderAi',
];

function makeHarness({ failAt, decision, practice = true }) {
  const record = {}, intake = { record }, url = 'https://example.test/quote';
  const x = { key: 'choice', label: 'Choice', controlKind: 'radio', choice: 'No', autoOk: true };
  const quoteHash = JSON.stringify(url);
  const sig = ['1', '/quote', 'gpt-6-luna', 'policy', 'context', 'item', quoteHash].join('\n');
  const field = { key: x.key, label: x.label, current: '' };
  const pre = [{ frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [field]]) }];
  const withAnswer = [{ frameId: 0, documentId: 'doc-0', result: JSON.stringify(['Quote', [{ ...field, current: 'No' }]]) }];
  const row = { type: 'need', x: { key: x.key, label: x.label }, settled: null };
  const state = {
    filling: false, intake, active: {}, tab: { id: 1, url, carrier: { practice } },
    aiCache: new Map([[sig, x]]), agentKeys: new Map(), filled: new Map(),
    aiDocks: new Map(), reportFor: { list: [row] }, rowsDrawn: 0,
  };
  const ctx = {
    tabId: 1, page: '/quote', tabUrl: url, intake, carrier: { practice },
    contextKey: assistContextKey(record, state.active), snapshots: pre,
  };
  let stored = [], snapCalls = 0, nextSnapshot = pre;
  const markedNeeds = [], logged = [];
  const context = {
    state, crypto: { randomUUID }, assistContextKey, aiFingerprint: JSON.stringify, aiSafeText: String,
    DEFAULT_MODEL: 'gpt-6-luna', POLICY_VERSION: 'policy', pageOf: v => new URL(v).pathname,
    usage: { currentSession: () => ({ intakeId: 'scope' }), log(e) { logged.push(e); } },
    aiDecisionEvent: (item, c, d) => ({ type: 'ai_decision', decision: d }),
    aiPersistQueue: Promise.resolve(), aiRetiredSignatures: new Set(),
    aiPendingStore: { get: async () => stored, set: async v => { stored = v; } },
    tellRecorder: async () => {}, traced: () => false, editScope: p => p, noteChangedAfterDone: () => {},
    tabStep: () => null, resumeHeldFill: () => {}, scheduleLayout: () => {}, scheduleAutoFill: () => {},
    switchOn: () => false, needId: r => `${r.x.key}|${r.x.label}`, setHead: (r, h) => { r.head = h; },
    drawRow: r => { r.v = (r.v ?? 0) + 1; state.rowsDrawn++; }, recount: () => {}, renderSteps: () => {},
    syncAiBanner: async () => {}, fillPage: () => {}, announce: () => {},
    persistGuardedEdits: async () => {}, agentEdited: () => false, stopNoteFor: () => null,
    DOCK,
    runKit: async (tabId, carrier, func, args = []) => {
      const s = String(func);
      if (/answerEdits/.test(s)) {
        if (args[0] === 'end' && failAt === 'readEditsEnd') throw new Error('end guard transport lost');
        return pre.map(f => ({ ...f, result: [] }));
      }
      if (/decisionSnapshot/.test(s)) {
        snapCalls++;
        if (snapCalls === 2 && failAt === 'finalSnapshot') throw new Error('final snapshot transport lost');
        return nextSnapshot;
      }
      if (/markKey/.test(s)) {
        markedNeeds.push(args);
        return [];
      }
      return [{ frameId: 0, documentId: 'doc-0', result: [{ key: x.key, label: x.label, ok: true, shown: 'No' }] }];
    },
  };
  vm.runInNewContext(HARNESS_FNS.map(extractFunction).join('\n'), context);
  const holder = { isConnected: true, say(s) { this.said = s; } };
  return {
    x, ctx, row, state, context, holder, pre, withAnswer, markedNeeds, logged,
    stored: () => stored,
    setNextSnapshot: (s) => { nextSnapshot = s; },
    run: () => context.applyAi([x], ctx, decision),
  };
}

test('applyAi post-dispatch failure keeps Continue blocked with Confirm/Reject on the card and across reload', async () => {
  for (const [label, failAt, decision] of [
    ['readEdits(end) throws on auto', 'readEditsEnd', 'auto'],
    ['final snapshot throws on auto', 'finalSnapshot', 'auto'],
    ['final snapshot throws on accepted', 'finalSnapshot', 'accepted'],
  ]) {
    const h = makeHarness({ failAt, decision });
    assert.equal(await h.run(), false, `${label}: applyAi reports failure`);

    // 1) Item state & Continue blocker immediately after post-dispatch failure
    assert.equal(h.x.done, 'auto', `${label}: stays a review hold (never silently unblocked)`);
    assert.equal(h.x.error, 'the answer was sent but could not be confirmed; review the page before continuing', `${label}: error recorded`);
    assert.equal(Boolean(h.x.rejected), false, `${label}: not rejected`);
    assert.equal(h.x.unconfirmed, true, `${label}: marked unconfirmed`);
    assert.equal(h.context.aiDecisionBlocks(h.x), true, `${label}: Continue remains blocked`);

    // 2) box(x) via renderAi keeps the possibly-written choice visible with Confirm and Reject
    h.context.renderAi(h.holder, [h.x], h.ctx);
    assert.equal(h.row.aiCard?.kind, 'unconfirmed', `${label}: renders unconfirmed card, not dead-end error`);
    assert.equal(h.row.aiCard?.choice, 'No', `${label}: possibly-written choice stays visible`);
    assert.match(h.row.aiCard?.text ?? '', /could not be confirmed/, `${label}: failure text shown`);
    assert.equal(typeof h.row.aiCard?.confirm, 'function', `${label}: Confirm action available`);
    assert.equal(typeof h.row.aiCard?.reject, 'function', `${label}: Reject action available`);

    // 3) Persisted pending record + restore across reload preserves the unconfirmed failure
    assert.equal(h.stored().length, 1, `${label}: persisted pending record`);
    assert.equal(h.stored()[0].done, 'auto');
    assert.equal(h.stored()[0].unconfirmed, true, `${label}: unconfirmed persisted`);
    assert.equal(h.stored()[0].rejected, false);
    assert.equal(Object.hasOwn(h.stored()[0], 'record'), false);

    h.state.aiCache.clear();
    await h.context.restoreAiPending();
    const restored = [...h.state.aiCache.values()][0];
    assert.ok(restored, `${label}: restored after reload`);
    assert.equal(restored.done, 'auto');
    assert.equal(restored.unconfirmed, true, `${label}: unconfirmed survives reload`);
    assert.match(restored.error ?? '', /could not be confirmed/, `${label}: failure warning survives reload`);
    assert.equal(restored.rejected, false);
    assert.equal(h.context.aiDecisionBlocks(restored), true, `${label}: Continue still blocked after reload`);

    const restoredRow = { type: 'need', x: { key: h.x.key, label: h.x.label }, settled: null };
    h.state.reportFor = { list: [restoredRow] };
    h.context.renderAi(h.holder, [restored], h.ctx);
    assert.equal(restoredRow.aiCard?.kind, 'unconfirmed', `${label}: reload does not hide the failure as picked`);
    assert.equal(restoredRow.aiCard?.choice, 'No');
    assert.equal(typeof restoredRow.aiCard?.confirm, 'function');
    assert.equal(typeof restoredRow.aiCard?.reject, 'function');

    // 4) Confirm verifies the page before unblocking; refuses when the page does not show the answer
    h.setNextSnapshot(h.pre); // page still blank
    await restoredRow.aiCard.confirm();
    assert.equal(h.context.aiDecisionBlocks(restored), true, `${label}: Confirm refuses to unblock when answer is absent on page`);
    assert.equal(restoredRow.aiCard?.kind, 'unconfirmed');
    assert.match(restoredRow.aiCard?.text ?? '', /changed|review/i);

    // 5) Confirm unblocks once the page actually shows the answer
    h.setNextSnapshot(h.withAnswer);
    await restoredRow.aiCard.confirm();
    assert.equal(restored.confirmed, true, `${label}: Confirm succeeds when page shows the answer`);
    assert.equal(restored.unconfirmed, false);
    assert.equal(restored.error, null);
    assert.equal(h.context.aiDecisionBlocks(restored), false, `${label}: Continue unblocked after explicit Confirm`);
    assert.equal(restoredRow.aiCard?.kind, 'done', `${label}: card settles to done after Confirm`);
  }
});

test('Reject on an unconfirmed post-dispatch card marks the field needs and keeps Continue blocked', async () => {
  const h = makeHarness({ failAt: 'readEditsEnd', decision: 'auto' });
  assert.equal(await h.run(), false);
  h.context.renderAi(h.holder, [h.x], h.ctx);
  assert.equal(h.row.aiCard?.kind, 'unconfirmed');
  await h.row.aiCard.reject();
  assert.equal(h.x.rejected, true);
  assert.equal(h.x.unconfirmed, false);
  assert.equal(h.context.aiDecisionBlocks(h.x), true, 'Reject keeps Continue blocked');
  assert.equal(h.markedNeeds.length, 1, 'marks the field on the page for review');
  assert.equal(h.row.aiCard?.kind, 'rejected');
  assert.equal(typeof h.row.aiCard?.confirm, 'function');
});

// Claude's review of #578: an unconfirmed pick the agent confirms is the AI's answer accepted, so
// the reports count it with the approved ones, not as a rejection.
test('Confirm on an unconfirmed pick logs approved; on a rejected one, rejected_confirmed', async () => {
  const h = makeHarness({ failAt: 'finalSnapshot', decision: 'auto', practice: false });
  assert.equal(await h.run(), false);
  h.context.renderAi(h.holder, [h.x], h.ctx);
  h.setNextSnapshot(h.withAnswer);
  await h.row.aiCard.confirm();
  assert.equal(h.x.confirmed, true);
  assert.deepEqual(h.logged.filter((e) => e.type === 'ai_decision').map((e) => e.decision), ['auto', 'approved']);

  const r = makeHarness({ failAt: 'readEditsEnd', decision: 'auto', practice: false });
  assert.equal(await r.run(), false);
  r.context.renderAi(r.holder, [r.x], r.ctx);
  await r.row.aiCard.reject();
  r.setNextSnapshot(r.withAnswer);
  await r.row.aiCard.confirm();
  assert.deepEqual(r.logged.filter((e) => e.type === 'ai_decision').map((e) => e.decision), ['rejected', 'rejected_confirmed']);
});
