import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { ANNOUNCE_MS, announce, useAnnounce } from '../../sidepanel/panel/announce.js';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { ClientHead } from '../../sidepanel/panel/client-view.jsx';
import { Dock } from '../../sidepanel/panel/steps-view.jsx';

// The panel's one live region (#announce, always on the page) and the notes that show and hide,
// which have no live role of their own and say their words there as they show them: a region shown,
// or put on the page, as its words go in is often not read by a screen reader at all.

let live;
beforeEach(() => {
  vi.useFakeTimers();
  live = document.createElement('div');
  live.id = 'announce';
  live.setAttribute('role', 'status');
  document.body.append(live);
});
afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  live.remove();
});

const heard = () => { act(() => { vi.advanceTimersByTime(ANNOUNCE_MS); }); return live.textContent; };

test('words are said after the region is emptied, so the same words said again are read again', () => {
  live.textContent = 'Filled 3 answers.';
  announce('Filled 3 answers.');
  expect(live.textContent).toBe('');
  expect(heard()).toBe('Filled 3 answers.');
  announce('Filled 3 answers.');
  expect(live.textContent).toBe('');
  expect(heard()).toBe('Filled 3 answers.');
});

test('words said in the same moment are read together, in order, each once; nothing is said for none', () => {
  announce('Filled 3 answers. Nothing is left for you.');
  announce('');
  announce('Thanks — saved with the usage log.');
  announce('Filled 3 answers. Nothing is left for you.');
  expect(heard()).toBe('Filled 3 answers. Nothing is left for you. Thanks — saved with the usage log.');
  announce('Nothing is left for you on this page.');
  expect(heard()).toBe('Nothing is left for you on this page.');
});

function Note({ text, hidden }) {
  const line = useRef(null);
  useAnnounce(text, line);
  return <section hidden={hidden}><p ref={line} hidden={!text}>{text}</p></section>;
}

test('a note is said each time it changes to words, not when drawn again with the same words, nor while its part of the panel is hidden', () => {
  const { rerender } = render(<Note text="" hidden={false} />);
  expect(heard()).toBe('');
  rerender(<Note text="Capture saved to Downloads." hidden={false} />);
  expect(heard()).toBe('Capture saved to Downloads.');
  live.textContent = '';
  rerender(<Note text="Capture saved to Downloads." hidden={false} />);
  expect(heard()).toBe('');
  rerender(<Note text="" hidden={false} />);
  rerender(<Note text="Capture saved to Downloads." hidden={false} />);
  expect(heard()).toBe('Capture saved to Downloads.');
  live.textContent = '';
  rerender(<Note text="Answers are going in." hidden />);
  expect(heard()).toBe('');
});

test('the client note and the dock\'s paused line are said as they show', () => {
  const state = storeState({ client: { name: 'Acme', meta: '', pdf: false, ask: null }, clientNote: null, newQuoteOff: false, detailsOpen: false, dock: null });
  const acts = new Proxy({}, { get: () => () => {} });
  render(<><ClientHead act={acts} /><Dock act={acts} /></>);
  act(() => { state.clientNote = 'Same intake: you corrected 2 answers, and that stays.'; });
  expect(heard()).toBe('Same intake: you corrected 2 answers, and that stays.');
  act(() => { state.dock = { phase: 'ready', title: 'Fill the Vehicles page', button: 'fill', label: 'Fill this page', hidden: false, paused: 'Automatic filling is paused on this tab. Your next Fill turns it back on.' }; });
  expect(heard()).toBe('Automatic filling is paused on this tab. Your next Fill turns it back on.');
});
