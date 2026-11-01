import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Cards, mountCards } from '../../sidepanel/panel/cards-view.jsx';

// The cards at the top of the page view in React (React PR 7, 2026-11-01): what showCarrierNote,
// showStateNote, showStopPage, showReviewMode and renderSteps wrote on the page with issueCard,
// drawn from what they say now (state.cards). What each says is checked by the safety tests (the
// stop, step and screen notes, the quote state, the carrier's current insurance, the fill's error);
// here, that the page shows it as issueCard did, in its place, and that a card's buttons do what
// they say.

let state;
beforeEach(() => { state = storeState({ cards: {} }); });
afterEach(cleanup);

// A card as issueSaid (coordinator.js) puts it.
const card = (more) => ({ tone: '', text: null, notes: [], compare: [], actions: [], role: 'status', ...more });
const $ = (container, id) => container.querySelector(`#${id}`);
const shown = (container) => [...$(container, 'issues').children].filter((c) => !c.hidden).map((c) => [c.id, c.querySelector('.issue-title').textContent]);

// From the safety test on the carrier's current insurance (#carrier-note first in #issues in the
// page's markup): each card in its place, in the same order, hidden while it says nothing.
test('the cards above the answers keep their places and order, each hidden while it says nothing', () => {
  const { container } = render(<Cards />);
  expect([...$(container, 'issues').children].map((c) => [c.id, c.hidden])).toEqual([
    ['carrier-note', true], ['state-note', true], ['stop-note', true], ['review-note', true], ['fill-error', true]]);
  expect($(container, 'fill-waiting').hidden).toBe(true);
  act(() => {
    state.cards = { fill: card({ title: 'Filling didn’t finish', text: 'The page stopped answering.', role: 'alert' }),
      carrier: card({ title: 'The client\'s current insurance is with GEICO', role: 'alert' }), review: null };
  });
  expect(shown(container)).toEqual([['carrier-note', 'The client\'s current insurance is with GEICO'], ['fill-error', 'Filling didn’t finish']]);
  act(() => { state.cards = { ...state.cards, carrier: null }; });
  expect(shown(container)).toEqual([['fill-error', 'Filling didn’t finish']]);
});

// issueCard's drawing: red with no tone, `i` on an info card, the title, what it says, its notes,
// what it compares, and its buttons.
test('a card is drawn as issueCard drew it, and its buttons do what they say', () => {
  const calls = [];
  const { container } = render(<Cards />);
  act(() => {
    state.cards = {
      state: card({ role: 'alert', title: 'This Progressive quote is for Utah. The intake says Florida.', text: 'Start the quote in Florida, or check the intake.',
        compare: [['Rater', 'Utah'], ['Intake page 1', '1 Main St, Tampa, FL 33601']],
        actions: [{ label: 'Utah is right', className: 'tinted', onClick: () => calls.push('dismiss') }, { label: 'See intake · p1', className: 'ghost', onClick: () => calls.push('pdf') }] }),
      stop: card({ tone: 'quiet', title: 'Final Quote Details: yours', text: 'Finish it on the page.', notes: ['Nothing on this step is filled or clicked.'] }),
      review: card({ tone: 'info', title: 'Quote & Coverages', text: 'The quote stops here.' }),
    };
  });
  const red = $(container, 'state-note').firstElementChild;
  expect([red.className, red.getAttribute('role'), red.querySelector('.bang').textContent, red.querySelector('.bang').getAttribute('aria-hidden')]).toEqual(['issue', 'alert', '!', 'true']);
  expect([...red.querySelectorAll('.issue-text > span')].map((s) => [s.className, s.textContent])).toEqual([
    ['issue-title', 'This Progressive quote is for Utah. The intake says Florida.'], ['', 'Start the quote in Florida, or check the intake.']]);
  expect([...red.querySelectorAll('.compare > span')].map((s) => [s.querySelector('.k').textContent, s.textContent])).toEqual([
    ['Rater:', 'Rater: Utah'], ['Intake page 1:', 'Intake page 1: 1 Main St, Tampa, FL 33601']]);
  const buttons = [...red.querySelectorAll('.issue-actions button')];
  expect(buttons.map((b) => [b.type, b.className, b.textContent])).toEqual([['button', 'tinted', 'Utah is right'], ['button', 'ghost', 'See intake · p1']]);
  for (const b of buttons) fireEvent.click(b);
  expect(calls).toEqual(['dismiss', 'pdf']);
  const quiet = $(container, 'stop-note').firstElementChild;
  expect([quiet.className, quiet.getAttribute('role'), quiet.querySelector('.small-note').textContent, quiet.querySelector('.compare'), quiet.querySelector('.issue-actions')])
    .toEqual(['issue quiet', 'status', 'Nothing on this step is filled or clicked.', null, null]);
  expect($(container, 'review-note').querySelector('.bang').textContent).toBe('i');
});

test('off a rater the page view says which to open, or why the page can\'t be read, with the raters\' logos', () => {
  const { container } = render(<Cards />);
  act(() => { state.cards = { waiting: 'Open the client’s quote on one of these raters.' }; });
  expect([$(container, 'fill-waiting').hidden, $(container, 'fill-waiting-text').textContent]).toEqual([false, 'Open the client’s quote on one of these raters.']);
  expect([...container.querySelectorAll('.rater-logos img')].map((i) => [i.alt, !!i.getAttribute('src')])).toEqual([['Progressive', true], ['GEICO', true], ['AmWINS', true]]);
  act(() => { state.cards = { waiting: null }; });
  expect($(container, 'fill-waiting').hidden).toBe(true);
});

test('mountCards draws before it returns', () => {
  const host = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountCards(host);
    expect(['fill-waiting', 'issues', 'carrier-note', 'fill-error'].map((id) => !!host.querySelector(`#${id}`))).toEqual([true, true, true, true]);
  });
  host.remove();
});
