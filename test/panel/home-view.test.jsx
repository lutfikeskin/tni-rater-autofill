import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { SetupCard } from '../../sidepanel/panel/home-view.jsx';

// Home's setup checklist (audit 2026-11-07, UX-12a): what renderHealth's checks say is left
// (state.health.checklist, tested in sidepanel-safety), drawn on Home with a tick for each item done
// and Set up for each left, which opens Settings at its box; nothing once all is done.

let state;
beforeEach(() => { state = storeState({ health: null }); });
afterEach(cleanup);

const items = (done) => [
  { id: 'initials', label: 'Add your initials, so your quotes count as yours', done: done.includes('initials'), focus: 'agent' },
  { id: 'ai', label: 'Turn the AI assistant on with its key, or leave it off', done: done.includes('ai'), focus: 'ai-on' },
  { id: 'server', label: 'Set the usage server, so TNI gets your runs', done: done.includes('server'), focus: 'server-url' },
];

test('the checklist ticks what is done, opens Settings at what is left, and goes once all is done', () => {
  const opened = [];
  const { container } = render(<div id="setup-root"><SetupCard act={{ open: (focus) => opened.push(focus) }} /></div>);
  const root = container.querySelector('#setup-root');
  expect(root.childNodes.length).toBe(0);
  act(() => { state.health = { checklist: items(['ai', 'server']) }; });
  const rows = () => [...root.querySelectorAll('.setup-list li')].map((li) => [li.getAttribute('data-item'), li.className, li.querySelector('.tick').textContent, li.querySelector('.setup-label').textContent, !!li.querySelector('button')]);
  expect(root.querySelector('h3').textContent).toBe('Finish setting up');
  expect(root.querySelector('.setup-card > p').textContent).toBe('One thing left, then you’re ready to quote.');
  expect(rows()).toEqual([
    ['initials', '', '', 'Add your initials, so your quotes count as yours (to do)', true],
    ['ai', 'done', '✓', 'Turn the AI assistant on with its key, or leave it off (done)', false],
    ['server', 'done', '✓', 'Set the usage server, so TNI gets your runs (done)', false],
  ]);
  fireEvent.click(root.querySelector('li[data-item="initials"] button'));
  expect(opened).toEqual(['agent']);
  act(() => { state.health = { checklist: items([]) }; });
  expect(root.querySelector('.setup-card > p').textContent).toBe('3 things left, then you’re ready to quote.');
  act(() => { state.health = { checklist: null }; });
  expect(root.childNodes.length).toBe(0);
});
