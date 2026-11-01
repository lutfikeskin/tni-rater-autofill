import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { LoadError, Note, ReportHead, mountLoadError, mountNote, mountReportHead } from '../../sidepanel/panel/notes-view.jsx';
import { dropReports, putReport, showReport } from '../../sidepanel/panel/coordinator.js';

// The panel's other notes and a report's head in React (2026-11-01): what windowProblem,
// renderHealth and showLoadError wrote on the page, and the cards and lines renderReport put above a
// report's list, with issueCard and h(). What each says is checked by the safety tests (the fill that
// stopped, the page changed, what wasn't clicked, a warn page's note, the window's and the PDF's
// notes); here, that the page shows it as issueCard drew it, in its order, and that a report kept
// while another page is in front shows its cards again when its page is back.

let state;
beforeEach(() => { state = storeState({ notes: { usage: null, window: null }, loadError: null }); });
afterEach(() => { cleanup(); document.body.replaceChildren(); });

// A card as issueSaid (coordinator.js) puts it.
const card = (more) => ({ tone: '', text: null, notes: [], compare: [], actions: [], role: 'status', ...more });
// A card as the agent reads it: its class, role, bang, title and what it says.
const cardSaid = (node) => [node.className, node.getAttribute('role'), node.querySelector('.bang').textContent,
  ...[...node.querySelectorAll('.issue-text > span')].map((s) => s.textContent)];

test('a note is nothing until it is said, then a card, and nothing again once cleared', () => {
  const { container } = render(<><div id="notices"><Note name="usage" /></div><div id="window-note"><Note name="window" /></div></>);
  const notices = container.querySelector('#notices');
  const windowNote = container.querySelector('#window-note');
  // Empty: `.notices:empty` takes no room.
  expect([notices.childNodes.length, windowNote.childNodes.length]).toEqual([0, 0]);
  act(() => {
    state.notes = { ...state.notes, usage: card({ tone: 'warn', role: 'alert', title: "Usage log can't be saved on this computer",
      text: 'Nothing is recorded now (QUOTA_BYTES quota exceeded). Export the log (Settings, Advanced) and tell TNI.' }) };
  });
  expect(cardSaid(notices.firstElementChild)).toEqual(['issue warn', 'alert', '!', "Usage log can't be saved on this computer",
    'Nothing is recorded now (QUOTA_BYTES quota exceeded). Export the log (Settings, Advanced) and tell TNI.']);
  expect(windowNote.childNodes.length).toBe(0);
  act(() => { state.notes = { ...state.notes, window: card({ tone: 'warn', role: 'alert', title: 'The panel couldn’t open in its own window.' }) }; });
  expect(cardSaid(windowNote.firstElementChild)).toEqual(['issue warn', 'alert', '!', 'The panel couldn’t open in its own window.']);
  act(() => { state.notes = { usage: null, window: null }; });
  expect([notices.childNodes.length, windowNote.childNodes.length]).toEqual([0, 0]);
});

test('a PDF that couldn\'t be read is said by its name, under the drop zone', () => {
  const { container } = render(<div id="load-error"><LoadError /></div>);
  const box = container.querySelector('#load-error');
  expect(box.childNodes.length).toBe(0);
  act(() => { state.loadError = { title: 'Couldn\'t read scan.pdf', text: 'No fillable fields: it looks like a scan or printed copy. Ask for the fillable TNI application.' }; });
  expect([...box.children].map((n) => [n.tagName, n.className, n.textContent])).toEqual([
    ['B', '', 'Couldn\'t read scan.pdf'], ['SPAN', 'small', 'No fillable fields: it looks like a scan or printed copy. Ask for the fillable TNI application.']]);
});

// renderReport's head: each card as issueCard drew it, the page's note and a picked answer's line, and
// This page is done, in the order said.
test('a report\'s head draws its cards, lines and This page is done in their order', () => {
  const { container } = render(<div className="report-head"><ReportHead items={[
    { card: card({ tone: 'warn', title: 'Owner not verified', text: 'Progressive couldn\'t verify the business owner.' }) },
    { line: 'agent-page', text: 'Click Print/Send yourself.' },
    { line: 'said', text: 'The page doesn\'t offer "11 Payments" here: the fill picked "9 Payments".' },
    { card: card({ tone: 'warn', title: 'Continue wasn’t clicked', text: 'Close what is open over it, then fill again.' }) },
    { card: card({ title: 'Filling stopped', text: 'The page is still waiting on its server. Check the page, then fill again.', role: 'alert' }) },
    { card: card({ tone: 'quiet', title: 'You stopped the fill', text: 'Nothing more was filled or clicked. What went in stays.' }) },
    { card: card({ title: 'This page seems to have changed', text: 'Progressive seems to have changed this page.', role: 'alert' }) },
    { done: '3 answers in. Clicked “Continue” for you.' },
  ]} /></div>);
  const nodes = [...container.querySelector('.report-head').children];
  expect(nodes.map((n) => [n.tagName, n.className])).toEqual([['DIV', 'issue warn'], ['P', 'note-line agent-page'], ['P', 'note-line said'], ['DIV', 'issue warn'],
    ['DIV', 'issue'], ['DIV', 'issue quiet'], ['DIV', 'issue'], ['DIV', 'done-card']]);
  expect(cardSaid(nodes[0])).toEqual(['issue warn', 'status', '!', 'Owner not verified', 'Progressive couldn\'t verify the business owner.']);
  expect([nodes[1].textContent, nodes[2].textContent]).toEqual(['Click Print/Send yourself.', 'The page doesn\'t offer "11 Payments" here: the fill picked "9 Payments".']);
  // The review signals: red and said at once.
  expect(cardSaid(nodes[4])).toEqual(['issue', 'alert', '!', 'Filling stopped', 'The page is still waiting on its server. Check the page, then fill again.']);
  expect(cardSaid(nodes[5])).toEqual(['issue quiet', 'status', '!', 'You stopped the fill', 'Nothing more was filled or clicked. What went in stays.']);
  expect(cardSaid(nodes[6])).toEqual(['issue', 'alert', '!', 'This page seems to have changed', 'Progressive seems to have changed this page.']);
  expect(nodes[4].querySelector('.bang').getAttribute('aria-hidden')).toBe('true');
  const done = nodes[7];
  expect([...done.children].map((n) => [n.tagName, n.className, n.textContent, n.getAttribute('aria-hidden')])).toEqual([
    ['SPAN', 'tick', '✓', 'true'], ['B', '', 'This page is done', null], ['SPAN', '', '3 answers in. Clicked “Continue” for you.', null]]);
});

// showReport keeps the report it replaces with its nodes, and puts them back when its page is in front
// again (the page menu moves them into #past the same way): the head React drew goes with them, its
// cards still drawn. A report made again for the page, or dropped, takes its head down.
test('a report kept while another page is in front shows its cards again when its page is back', () => {
  document.body.innerHTML = '<div id="report" class="report"></div><div id="past" class="report past"></div>';
  const report = document.getElementById('report');
  const carrier = { id: 'progressive', name: 'Progressive' };
  const on = (page) => { state.tab = { id: 1, url: `https://rater.test/?pageName=${page}`, carrier }; };
  Object.assign(state, { active: { drivers: 0, vehicles: 0, trailers: 0 }, tabSteps: new Map(), reports: new Map(), reportFor: null });
  // A report's nodes as renderReport makes them: its head (headHost), the AI's place.
  const made = (page, title) => {
    const entry = { key: `1|${page}||`, tabId: 1, page, fields: 2 };
    const head = Object.assign(document.createElement('div'), { className: 'report-head' });
    act(() => { entry.unmountHead = mountReportHead(head, [{ card: card({ title, text: 'Check the page, then fill again.', role: 'alert' }) }]); });
    const ai = Object.assign(document.createElement('div'), { className: 'needs-head', hidden: true });
    return { entry, head, nodes: [head, ai] };
  };
  const titles = (host) => [...host.querySelectorAll('.issue')].map((n) => [n.getAttribute('role'), n.querySelector('.issue-title').textContent]);
  const same = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
  on('Drivers');
  const drivers = made('Drivers', 'Filling stopped');
  act(() => putReport(drivers.entry, drivers.nodes));
  expect(titles(report)).toEqual([['alert', 'Filling stopped']]);
  // The tab moves on, and that page is filled: the Drivers report is kept with its nodes.
  on('Vehicles');
  const vehicles = made('Vehicles', 'This page seems to have changed');
  act(() => putReport(vehicles.entry, vehicles.nodes));
  expect(titles(report)).toEqual([['alert', 'This page seems to have changed']]);
  expect(same(drivers.entry.nodes, drivers.nodes)).toBe(true);
  // Shown read-only from the page menu (renderSteps moves its nodes into #past), then back on its page.
  const past = document.getElementById('past');
  past.replaceChildren(...drivers.entry.nodes);
  expect(titles(past)).toEqual([['alert', 'Filling stopped']]);
  past.replaceChildren();
  on('Drivers');
  expect(showReport()).toBe(drivers.entry);
  expect(same([...report.childNodes], drivers.nodes)).toBe(true);
  expect(titles(report)).toEqual([['alert', 'Filling stopped']]);
  expect(drivers.entry.restored).toBe(true);
  // Filled again: the new report's head shows and the old one's is taken down.
  const again = made('Drivers', 'Continue wasn’t clicked');
  act(() => putReport(again.entry, again.nodes));
  expect(titles(report)).toEqual([['alert', 'Continue wasn’t clicked']]);
  expect(drivers.head.childNodes.length).toBe(0);
  // Dropped (a new client, a closed tab): taken down too.
  act(() => dropReports());
  expect([report.childNodes.length, again.head.childNodes.length, vehicles.head.childNodes.length]).toEqual([0, 0, 0]);
});

test('mountNote and mountLoadError draw before they return', () => {
  state.notes = { ...state.notes, window: card({ tone: 'warn', role: 'alert', title: 'Click into the quote’s Chrome window, then try again.' }) };
  state.loadError = { title: 'Couldn\'t read that file', text: 'That is not a PDF.' };
  const note = document.body.appendChild(document.createElement('div'));
  const error = document.body.appendChild(document.createElement('div'));
  act(() => {
    mountNote(note, 'window');
    mountLoadError(error);
    expect(note.querySelector('.issue-title').textContent).toBe('Click into the quote’s Chrome window, then try again.');
    expect(error.querySelector('b').textContent).toBe('Couldn\'t read that file');
  });
});
