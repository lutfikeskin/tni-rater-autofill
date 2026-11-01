import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { ClientHead, mountClient } from '../../sidepanel/panel/client-view.jsx';

// The client's header in React (React PR 9, 2026-11-01): what render() drew with $() into the
// page's header, drawn from what it says now (state.client), with the note under it (clientNote)
// and New quote off while answers go in (renderSteps). What each button does is the panel's (the
// safety tests: Clear always asks, Change file asks once the agent has done work…); here, that the
// header draws them as before and that each button asks the panel for its own thing.

let state;
beforeEach(() => { state = storeState({ client: null, clientNote: null, newQuoteOff: false, detailsOpen: false }); });
afterEach(cleanup);

const $ = (container, sel) => container.querySelector(sel);
const acts = (calls) => Object.fromEntries(['details', 'pdf', 'replace', 'newQuote', 'clear', 'yes', 'cancel'].map((name) => [name, () => calls.push(name)]));

test('the header: the client\'s name and what the quote is about, a button to client details that says whether they are open', () => {
  const calls = [];
  const { container } = render(<ClientHead act={acts(calls)} />);
  act(() => { state.client = { name: 'Acme Hauling LLC', title: 'acme.pdf · 61 answers', meta: 'Maryland · 2 drivers · 1 vehicle', pdf: true, ask: null }; });
  const card = $(container, '#client-card');
  expect([card.tagName, card.className, card.getAttribute('aria-controls'), card.getAttribute('aria-expanded')]).toEqual(['BUTTON', 'client-title', 'details-view', 'false']);
  expect([$(container, '#client-name').textContent, $(container, '#client-name').title, $(container, '#client-meta').textContent])
    .toEqual(['Acme Hauling LLC', 'acme.pdf · 61 answers', 'Maryland · 2 drivers · 1 vehicle']);
  fireEvent.click(card);
  expect(calls).toEqual(['details']);
  act(() => { state.detailsOpen = true; });
  expect(card.getAttribute('aria-expanded')).toBe('true');
  // The tools, in this order, each asking for its own thing.
  const tools = [...container.querySelectorAll('.client-tools > button')];
  expect(tools.map((b) => b.id)).toEqual(['open-pdf', 'replace', 'new-quote', 'clear-client']);
  expect(tools.map((b) => b.getAttribute('aria-label'))).toEqual([null, 'Change file', 'New quote with this intake', 'Clear this client']);
  for (const b of tools) fireEvent.click(b);
  expect(calls.slice(1)).toEqual(['pdf', 'replace', 'newQuote', 'clear']);
});

test('the PDF button only with the PDF kept; New quote off while answers go in', () => {
  const { container } = render(<ClientHead act={acts([])} />);
  act(() => { state.client = { name: 'Acme', title: '', meta: '', pdf: false, ask: null }; });
  expect($(container, '#open-pdf').hidden).toBe(true);
  expect($(container, '#new-quote').disabled).toBe(false);
  act(() => { state.client = { ...state.client, pdf: true }; state.newQuoteOff = true; });
  expect($(container, '#open-pdf').hidden).toBe(false);
  expect($(container, '#new-quote').disabled).toBe(true);
});

test('the file tools\' question: hidden until asked, what it says and its two buttons; the note on the file just loaded', () => {
  const calls = [];
  const { container } = render(<ClientHead act={acts(calls)} />);
  const ask = $(container, '#file-confirm');
  expect([ask.hidden, ask.getAttribute('role'), ask.getAttribute('aria-labelledby')]).toEqual([true, 'group', 'file-confirm-text']);
  act(() => { state.client = { name: 'Acme', title: '', meta: '', pdf: true, ask: { text: 'Clear Acme? Your corrections, checks and reports go.', yes: 'Clear this client' } }; });
  expect([ask.hidden, $(container, '#file-confirm-text').textContent, $(container, '#file-confirm-yes').textContent, $(container, '#file-confirm-no').textContent])
    .toEqual([false, 'Clear Acme? Your corrections, checks and reports go.', 'Clear this client', 'Cancel']);
  fireEvent.click($(container, '#file-confirm-yes'));
  fireEvent.click($(container, '#file-confirm-no'));
  expect(calls).toEqual(['yes', 'cancel']);
  act(() => { state.client = { ...state.client, ask: null }; });
  expect(ask.hidden).toBe(true);
  // The note: a status line, hidden until it says something.
  const note = $(container, '#client-note');
  expect([note.hidden, note.getAttribute('role')]).toEqual([true, 'status']);
  act(() => { state.clientNote = 'Same intake: you corrected 2 answers, and that stays.'; });
  expect([note.hidden, note.textContent]).toEqual([false, 'Same intake: you corrected 2 answers, and that stays.']);
  act(() => { state.clientNote = null; });
  expect(note.hidden).toBe(true);
});

test('mountClient draws before it returns', () => {
  const host = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountClient(host, acts([]));
    expect(['client-card', 'client-name', 'open-pdf', 'replace', 'new-quote', 'clear-client', 'file-confirm', 'file-confirm-no', 'client-note'].map((id) => !!host.querySelector(`#${id}`))).toEqual(Array(9).fill(true));
  });
  host.remove();
});
