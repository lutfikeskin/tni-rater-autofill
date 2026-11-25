import { afterEach, beforeEach, expect, test } from 'vitest';
import { carrierForUrl } from '../../src/carriers.js';
import { geico } from '../../src/carriers/geico.js';
import { geicoPa } from '../../src/carriers/geico-pa.js';
import { fillEvents } from '../../src/usage.js';
import { keepReport, state, store } from '../../sidepanel/panel/core.js';
import { fillOptions } from '../../sidepanel/panel/coordinator.js';
import { afterFill, openFillDocument } from '../../sidepanel/panel/fill.js';
import { safeDocumentUrl } from '../../sidepanel/panel/fill-checks.js';

let chromeBefore;

beforeEach(() => {
  chromeBefore = globalThis.chrome;
  state.intake = { intakeId: 'test-intake', record: { product: 'personal-auto', drivers: [], vehicles: [], trailers: [] }, warnings: [], done: [], agentEdited: [] };
  state.tab = { id: 12, url: 'https://sales.geico.com/quote', carrier: geicoPa, background: false, windowId: 1 };
});

afterEach(() => {
  globalThis.chrome = chromeBefore;
  state.intake = null;
  state.tab = null;
});

test('safeDocumentUrl allows https same-origin carrier URLs and loopback http practice URLs only', () => {
  const quoteUrl = 'https://sales.geico.com/quote';
  expect(safeDocumentUrl('https://sales.geico.com/PrintQuote?conversationId=abc123', geicoPa, quoteUrl))
    .toBe('https://sales.geico.com/PrintQuote?conversationId=abc123');

  // Local practice mock: http://127.0.0.1:<port> matching exact tab origin is allowed.
  const practiceUrl = 'http://127.0.0.1:4321/test/fixtures/geico-pa/quote.html';
  const practiceCarrier = carrierForUrl(practiceUrl, { product: 'personal-auto' });
  expect(practiceCarrier?.practice).toBe(true);
  expect(safeDocumentUrl('http://127.0.0.1:4321/PrintQuote?quote=mock', practiceCarrier, practiceUrl))
    .toBe('http://127.0.0.1:4321/PrintQuote?quote=mock');

  // Rejected cases: protocol downgrade, non-practice http, cross-origin, port mismatch, non-http(s), malformed.
  expect(safeDocumentUrl('http://sales.geico.com/PrintQuote?quote=1', geicoPa, quoteUrl)).toBeNull();
  expect(safeDocumentUrl('http://sales.geico.com/PrintQuote?quote=1', geicoPa, 'http://sales.geico.com/quote')).toBeNull();
  expect(safeDocumentUrl('https://evil.example/PrintQuote', geicoPa, quoteUrl)).toBeNull();
  expect(safeDocumentUrl('https://gateway2.geico.com/PrintQuote', geicoPa, quoteUrl)).toBeNull();
  expect(safeDocumentUrl('http://127.0.0.1:9999/PrintQuote?quote=mock', practiceCarrier, practiceUrl)).toBeNull();
  expect(safeDocumentUrl('javascript:alert(1)', geicoPa, quoteUrl)).toBeNull();
  expect(safeDocumentUrl('chrome://settings', geicoPa, quoteUrl)).toBeNull();
  expect(safeDocumentUrl('file:///etc/passwd', geicoPa, quoteUrl)).toBeNull();
  expect(safeDocumentUrl('not-a-url', geicoPa, quoteUrl)).toBeNull();
  expect(safeDocumentUrl(null, geicoPa, quoteUrl)).toBeNull();
});

test('fillOptions enables openDownloadInPanel only for MAIN-world carriers when chrome.tabs.create is available', () => {
  globalThis.chrome = { ...chromeBefore, tabs: { ...chromeBefore?.tabs, create: async () => ({ id: 99 }) } };
  const paOpts = fillOptions(geicoPa, {}, false, {}, false, { tabId: 12, tabUrl: 'https://sales.geico.com/quote', intake: state.intake });
  const comOpts = fillOptions(geico, {}, false, {}, false, { tabId: 12, tabUrl: 'https://sales.geico.com/quote', intake: state.intake });
  expect(paOpts.openDownloadInPanel).toBe(true);
  expect(comOpts.openDownloadInPanel).toBeUndefined();

  globalThis.chrome = undefined;
  const previewOpts = fillOptions(geicoPa, {}, false, {}, false, { tabId: 12, tabUrl: 'https://sales.geico.com/quote', intake: state.intake });
  expect(previewOpts.openDownloadInPanel).toBeUndefined();
});

test('openFillDocument and afterFill open validated openDocumentUrl via chrome.tabs.create and always strip it', () => {
  const created = [];
  globalThis.chrome = {
    ...chromeBefore,
    tabs: { ...chromeBefore?.tabs, create: async ({ url }) => { created.push(url); return { id: 50, url }; } },
  };

  // Valid URL via afterFill -> opens tab once and deletes openDocumentUrl from frame.
  /** @type {any} */
  const frame = {
    fields: 1, filled: [], kept: [], failed: [], noData: [], leftRequired: [], unknown: [], checks: [],
    actions: [{ id: 'printProposal', text: 'Print Quote Proposal' }], blocked: [],
    documentPending: true, openDocumentUrl: 'https://sales.geico.com/PrintQuote?quote=mock',
  };
  afterFill([frame], {
    tabId: 12, carrier: geicoPa, page: '/quote', tabUrl: 'https://sales.geico.com/quote',
    intake: state.intake, revision: state.intakeRevision, active: state.active,
  });
  expect(created).toEqual(['https://sales.geico.com/PrintQuote?quote=mock']);
  expect('openDocumentUrl' in frame).toBe(false);

  // Halted fill -> never opens tab, still strips openDocumentUrl.
  /** @type {any} */
  const haltedFrame = { halted: true, reason: 'stopped', openDocumentUrl: 'https://sales.geico.com/PrintQuote?quote=halted' };
  expect(openFillDocument([haltedFrame], { carrier: geicoPa, tabUrl: 'https://sales.geico.com/quote' })).toBeNull();
  expect(created).toHaveLength(1);
  expect('openDocumentUrl' in haltedFrame).toBe(false);

  // Untrusted cross-origin URL -> never opens tab, still strips openDocumentUrl.
  /** @type {any} */
  const badFrame = { halted: false, openDocumentUrl: 'https://evil.example/PrintQuote' };
  expect(openFillDocument([badFrame], { carrier: geicoPa, tabUrl: 'https://sales.geico.com/quote' })).toBeNull();
  expect(created).toHaveLength(1);
  expect('openDocumentUrl' in badFrame).toBe(false);
});

test('openDocumentUrl is never logged by fillEvents or persisted by keepReport', async () => {
  const secretUrl = 'https://sales.geico.com/PrintQuote?conversationId=secret-token-123';
  const frame = {
    fields: 1, rounds: 1, filled: [], kept: [], failed: [], noData: [], leftRequired: [], unknown: [], checks: [],
    actions: [{ id: 'printProposal', text: 'Print Quote Proposal' }], blockers: [],
    openDocumentUrl: secretUrl,
  };
  const events = fillEvents([frame], {
    carrier: 'geico-pa', page: '/quote', view: 't1', overwrite: false, ms: 50, redact: (s) => s,
  });
  expect(JSON.stringify(events)).not.toContain('openDocumentUrl');
  expect(JSON.stringify(events)).not.toContain('secret-token-123');

  keepReport(12, { key: '12|/quote|Quote Summary', page: '/quote', active: {}, at: Date.now(), frames: [frame] });
  await new Promise((r) => setTimeout(r, 20));
  const saved = await store.get('reports:12');
  expect(JSON.stringify(saved ?? {})).not.toContain('openDocumentUrl');
  expect(JSON.stringify(saved ?? {})).not.toContain('secret-token-123');
});
