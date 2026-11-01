import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { SiteTrack, mountSiteTrack } from '../../sidepanel/panel/site-view.jsx';

// The header's strip of the quote's steps in React (2026-11-01): what renderSite drew with h(), drawn
// from what it says now (state.siteTrack; the safety test 'on a stop step the panel offers no fill…'
// checks what it says). Here, one mark per step, titled with its name, with the class the CSS reads.

let state;
beforeEach(() => { state = storeState({ siteTrack: [] }); });
afterEach(cleanup);

const marks = (container) => [...container.querySelectorAll('#site-track > span')].map((s) => [s.title, s.getAttribute('class')]);

test('the strip draws a mark per step: done, here (filled once its page has a report), and to come', () => {
  const { container } = render(<div id="site-track"><SiteTrack /></div>);
  expect(marks(container)).toEqual([]);
  act(() => { state.siteTrack = [{ name: 'Business Info', at: 'done' }, { name: 'Vehicles', at: 'here' }, { name: 'Drivers', at: null }]; });
  expect(marks(container)).toEqual([['Business Info', 'done'], ['Vehicles', 'here'], ['Drivers', null]]);
  act(() => { state.siteTrack = [{ name: 'Business Info', at: 'done' }, { name: 'Vehicles', at: 'here filled' }, { name: 'Drivers', at: null }]; });
  expect(marks(container)).toEqual([['Business Info', 'done'], ['Vehicles', 'here filled'], ['Drivers', null]]);
  act(() => { state.siteTrack = []; });
  expect(container.querySelector('#site-track').childNodes.length).toBe(0);
});

test('mountSiteTrack draws before it returns', () => {
  state.siteTrack = [{ name: 'Quote', at: 'here' }];
  const host = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'site-track' }));
  act(() => {
    mountSiteTrack(host);
    expect(marks(document.body)).toEqual([['Quote', 'here']]);
  });
  host.remove();
});
