import { afterEach, beforeEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { overlayKey, tabStops } from '../../sidepanel/panel/overlay-keys.js';
import { Summary } from '../../sidepanel/panel/summary-view.jsx';

// The keyboard over what covers the panel (overlay-keys.js; docs/panel-ui.md, "Over the panel"):
// Escape closes the topmost layer open, and Tab stays in a sheet, wrapping at its ends. The layers
// are given as sidepanel.js gives them (the safety tests check that wiring); here the quote
// summary's real sheet is one of them.

beforeEach(() => { storeState({ summary: null }); });
afterEach(cleanup);

// A page like the panel's: a header button, Settings, and the summary sheet in its host.
function setup({ summary = true, settings = false } = {}) {
  const closed = [];
  const view = render(
    <>
      <button type="button" id="settings-btn">Settings</button>
      <section id="settings" hidden={!settings}><button type="button" id="settings-done">Done</button><input id="agent-initials" /></section>
      <div id="summary-view" hidden={!summary}><Summary act={{ close: () => closed.push('summary'), save: () => {} }} /></div>
    </>,
  );
  const $ = (id) => document.getElementById(id);
  const layers = () => [
    { el: $('summary-view'), open: summary, close: () => closed.push('summary'), modal: true },
    { el: $('settings'), open: settings, close: () => closed.push('settings') },
  ];
  const listener = (e) => overlayKey(e, layers());
  document.addEventListener('keydown', listener);
  view.unmount = ((unmount) => () => { document.removeEventListener('keydown', listener); unmount(); })(view.unmount);
  return { $, closed, view };
}

const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey });

test('Tab and Shift+Tab stay inside an open sheet, wrapping at its ends; disabled buttons are skipped', () => {
  const { $, view } = setup();
  const stops = tabStops($('summary-view')).map((n) => n.id);
  expect(stops).toEqual(['summary-close', 'summary-back']);
  // From outside it (the header), Tab goes to its first stop.
  $('settings-btn').focus();
  tab();
  expect(document.activeElement.id).toBe('summary-close');
  $('summary-back').focus();
  tab();
  expect(document.activeElement.id).toBe('summary-close');
  tab(true);
  expect(document.activeElement.id).toBe('summary-back');
  view.unmount();
});

test('Escape closes the topmost layer open, and only that one', () => {
  const both = setup({ summary: true, settings: true });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(both.closed).toEqual(['summary']);
  both.view.unmount();
  const settings = setup({ summary: false, settings: true });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(settings.closed).toEqual(['settings']);
  settings.view.unmount();
  const none = setup({ summary: false, settings: false });
  fireEvent.keyDown(document.body, { key: 'Escape' });
  expect(none.closed).toEqual([]);
  none.view.unmount();
});

test('Settings covers the view but is not modal: Tab leaves it as it would anywhere', () => {
  const { $, view } = setup({ summary: false, settings: true });
  $('agent-initials').focus();
  const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(e);
  expect([e.defaultPrevented, document.activeElement.id]).toEqual([false, 'agent-initials']);
  view.unmount();
});
