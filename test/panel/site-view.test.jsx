import fs from 'node:fs';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { SiteTrack, mountSiteTrack } from '../../sidepanel/panel/site-view.jsx';

// The header's step marks in React (#site-track, hidden visually in favour of rule-view.jsx's 2px
// #site-rule while kept in DOM for renderSite and the safety tests) and the context line's elements
// in sidepanel.html (#carrier-line: #site-logo, #site, #site-step, #site-count, #site-caption).

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

test('sidepanel.html composes the context line, step marks, 2px rule and footer base line in order', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const carrierIds = [...doc.querySelectorAll('#carrier-line > [id]')].map((el) => el.id);
  expect(carrierIds).toEqual(['site-logo', 'site', 'site-step', 'site-count', 'site-caption']);
  expect(doc.querySelector('#site-logo').className).toBe('carrier-logo');
  expect(doc.querySelector('.panel-head #site-rule')).not.toBeNull();
  const footIds = [...doc.querySelectorAll('.foot-row > [id]')].map((el) => el.id);
  expect(footIds).toEqual(['recording-root', 'report-problem', 'foot-version']);
});
