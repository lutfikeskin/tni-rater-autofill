import { afterEach, expect, test } from 'vitest';
import fs from 'node:fs';
import { cleanup, queryAllByRole, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { Settings } from '../../sidepanel/panel/settings-view.jsx';
import { ClientHead } from '../../sidepanel/panel/client-view.jsx';
import { Dock, Steps } from '../../sidepanel/panel/steps-view.jsx';
import { Feed } from '../../sidepanel/panel/feed-view.jsx';
import { Checks } from '../../sidepanel/panel/checks-view.jsx';
import { Summary } from '../../sidepanel/panel/summary-view.jsx';
import { PdfSheet } from '../../sidepanel/panel/pdf-sheet-view.jsx';
import { Details } from '../../sidepanel/panel/details-view.jsx';

// docs/panel-ui.md, "Names": every control a keyboard or screen-reader user can reach has an
// accessible name (its text, its label, or aria-label on an icon button), as Testing Library
// computes it. A control drawn hidden isn't asked.

afterEach(cleanup);

const ROLES = ['button', 'link', 'checkbox', 'switch', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton', 'slider', 'tab', 'menuitem'];
// Asked with every `title` taken away first: a tooltip is never a control's only name ("Tooltips").
const nameless = (root) => {
  for (const el of root.querySelectorAll('[title]')) el.removeAttribute('title');
  return ROLES.flatMap((role) => queryAllByRole(root, role, { name: '' }).map((el) => `${role} ${el.outerHTML.slice(0, 120)}`));
};
const quiet = new Proxy({}, { get: () => () => {} });

test('every control in the panel\'s page has a name', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  // Shown as they are with a quote open, so their controls are asked too.
  for (const id of ['quote', 'pop-out', 'problem-form']) document.getElementById(id).hidden = false;
  expect(nameless(document.body)).toEqual([]);
  document.body.innerHTML = '';
});

test('every control the panel\'s views draw has a name', () => {
  storeState({
    switches: { autoPages: true, autoFollowUps: true, autoAdvance: true, checkBeforeContinue: true, overwrite: false, finishSound: true, turnSound: true },
    ai: { on: true, auto: false, autoShown: true, names: false, keyEdit: 'Add key' }, keyFormOpen: true, usageCard: null, usageNote: '', health: null,
    testRun: null, captureOff: false, captureStatus: null, devrec: { on: false, status: null, unfinished: null }, recordingLine: false, intake: {},
    client: { name: 'Acme Hauling LLC', meta: 'Maryland · 2 drivers', pdf: true, ask: { text: 'Clear Acme?', yes: 'Clear this client' } }, clientNote: null, newQuoteOff: false, detailsOpen: false,
    steps: null, dock: { phase: 'ready', title: 'Fill the Vehicles page', button: 'fill', label: 'Fill this page', hidden: false, alt: 'fill-again', altLabel: 'Fill again', busy: false },
    feed: { shown: true, title: 'Answers on this page', pages: [], pastKey: null, pastWhen: '', report: true, filter: 'all', counts: { all: 2, needs: 1, done: 1 }, empty: null, keyOpen: true, unmark: true, age: null },
    checks: null, pickers: [], summary: null, pdfSheet: null, details: null,
  });
  const views = { Settings, ClientHead, Steps, Dock, Feed, Checks, Summary, PdfSheet, Details };
  const missing = Object.entries(views).flatMap(([name, View]) => {
    const { container } = render(<View act={quiet} />);
    const found = nameless(container).map((said) => `${name}: ${said}`);
    cleanup();
    return found;
  });
  expect(missing).toEqual([]);
});
