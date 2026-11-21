import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { ClientHead, mountClient } from '../../sidepanel/panel/client-view.jsx';

// The client's header in React: the client's name in the top bar (#client-card, a disclosure button
// to client details), the intake half of the context line (#client-meta, shown only when no rater
// tab is in front), the file tools and their confirm prompt, the note under it (clientNote) and New
// quote off while answers go in (renderSteps).

let state;
beforeEach(() => { state = storeState({ client: null, tab: null, clientNote: null, newQuoteOff: false, detailsOpen: false }); });
afterEach(cleanup);

const $ = (container, sel) => container.querySelector(sel);
const acts = (calls) => Object.fromEntries(['details', 'pdf', 'summary', 'replace', 'newQuote', 'clear', 'yes', 'cancel'].map((name) => [name, () => calls.push(name)]));

test('the header: client name in the top-bar disclosure, context-line meta hidden when a rater is in front, and tools in order', () => {
  const calls = [];
  const { container } = render(<ClientHead act={acts(calls)} />);
  act(() => { state.client = { name: 'Acme Hauling LLC', title: 'acme.pdf · 61 answers', meta: 'Maryland · 2 drivers · 1 vehicle', pdf: true, ask: null }; });
  const card = $(container, '#client-card');
  const meta = $(container, '#client-meta');
  expect([card.tagName, card.className, card.getAttribute('aria-controls'), card.getAttribute('aria-expanded')]).toEqual(['BUTTON', 'client-title', 'details-view', 'false']);
  expect(card.querySelector('#client-meta')).toBeNull();
  expect([card.textContent, $(container, '#client-name').title, meta.textContent, meta.hidden])
    .toEqual(['Acme Hauling LLC', 'acme.pdf · 61 answers', 'Maryland · 2 drivers · 1 vehicle', false]);
  // With its counts, each is an icon and its number, its words for a screen reader.
  act(() => { state.client = { ...state.client, counts: { state: 'Maryland', drivers: 2, vehicles: 1, trailers: 0 } }; });
  expect([...meta.querySelectorAll('.meta-count')].map((c) => [c.querySelector('use').getAttribute('href'), c.querySelector('[aria-hidden="true"]:not(svg)').textContent, c.querySelector('.sr-only').textContent]))
    .toEqual([['#driver', '2', '2 drivers'], ['#truck', '1', '1 vehicle']]);
  expect(meta.firstElementChild.textContent).toBe('Maryland');
  // When a rater tab is in front, #carrier-line takes the context line and #client-meta hides.
  act(() => { state.tab = { id: 1, carrier: { id: 'amwins', name: 'AmWINS' } }; });
  expect(meta.hidden).toBe(true);
  act(() => { state.tab = { id: 2, carrier: null }; });
  expect(meta.hidden).toBe(false);
  fireEvent.click(card);
  expect(calls).toEqual(['details']);
  act(() => { state.detailsOpen = true; });
  expect(card.getAttribute('aria-expanded')).toBe('true');
  // The tools, in this order, each asking for its own thing.
  const tools = [...container.querySelectorAll('.client-tools .btn-group > button')];
  expect(tools.map((b) => b.id)).toEqual(['open-pdf', 'quote-summary', 'replace', 'new-quote', 'clear-client']);
  expect(tools.map((b) => b.getAttribute('aria-label'))).toEqual([null, 'Quote summary', 'Change file', 'New quote with this intake', 'Clear this client']);
  for (const b of tools) fireEvent.click(b);
  expect(calls.slice(1)).toEqual(['pdf', 'summary', 'replace', 'newQuote', 'clear']);
});

test('the PDF button only with the PDF kept; New quote off while answers go in; empty meta stays hidden', () => {
  const { container } = render(<ClientHead act={acts([])} />);
  act(() => { state.client = { name: 'Acme', title: '', meta: '', pdf: false, ask: null }; });
  expect($(container, '#open-pdf').hidden).toBe(true);
  expect($(container, '#client-meta').hidden).toBe(true);
  expect($(container, '#new-quote').disabled).toBe(false);
  act(() => { state.client = { ...state.client, pdf: true }; state.newQuoteOff = true; });
  expect($(container, '#open-pdf').hidden).toBe(false);
  expect($(container, '#new-quote').disabled).toBe(true);
});

test('the file tools\' question: hidden until asked, what it says and its two buttons; the note on the file just loaded', () => {
  const calls = [];
  const { container } = render(<ClientHead act={acts(calls)} />);
  const ask = $(container, '#file-confirm');
  // A popover under the button that asked: its title names the question, its text says what goes.
  expect([ask.hidden, ask.getAttribute('role'), ask.getAttribute('aria-labelledby'), ask.getAttribute('aria-describedby')]).toEqual([true, 'group', 'file-confirm-title', 'file-confirm-text']);
  act(() => { state.client = { name: 'Acme', title: '', meta: '', pdf: true, ask: { text: 'Clear Acme? Your corrections, checks and reports go.', yes: 'Clear this client' } }; });
  expect([ask.hidden, $(container, '#file-confirm-text').textContent, $(container, '#file-confirm-yes').textContent, $(container, '#file-confirm-no').textContent])
    .toEqual([false, 'Clear Acme? Your corrections, checks and reports go.', 'Clear this client', 'Cancel']);
  fireEvent.click($(container, '#file-confirm-yes'));
  fireEvent.click($(container, '#file-confirm-no'));
  expect(calls).toEqual(['yes', 'cancel']);
  // Escape in it is Cancel too.
  fireEvent.keyDown($(container, '#file-confirm-yes'), { key: 'Escape' });
  expect(calls).toEqual(['yes', 'cancel', 'cancel']);
  act(() => { state.client = { ...state.client, ask: null }; });
  expect(ask.hidden).toBe(true);
  // The note: hidden until it says something, and said through #announce (announce.js), not a live
  // role of its own.
  const note = $(container, '#client-note');
  expect([note.hidden, note.getAttribute('role')]).toEqual([true, null]);
  act(() => { state.clientNote = 'Same intake: you corrected 2 answers, and that stays.'; });
  expect([note.hidden, note.textContent]).toEqual([false, 'Same intake: you corrected 2 answers, and that stays.']);
  act(() => { state.clientNote = null; });
  expect(note.hidden).toBe(true);
});

test('mountClient draws before it returns', () => {
  const host = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountClient(host, acts([]));
    expect(['client-card', 'client-name', 'client-meta', 'open-pdf', 'replace', 'new-quote', 'clear-client', 'file-confirm', 'file-confirm-no', 'client-note'].map((id) => !!host.querySelector(`#${id}`))).toEqual(Array(10).fill(true));
  });
  host.remove();
});
