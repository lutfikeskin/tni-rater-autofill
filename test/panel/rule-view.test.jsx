import { afterEach, beforeEach, expect, test } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { storeState } from '../../sidepanel/panel/state-store.js';
import { SiteRule, mountSiteRule } from '../../sidepanel/panel/rule-view.jsx';

// The header's 2px progress rule in React (rule-view.jsx): decorative width from state.siteTrack
// (done and here-filled marks over total count), aria-hidden because the context line above carries
// the stage words.

let state;
beforeEach(() => { state = storeState({ siteTrack: [] }); });
afterEach(cleanup);

const bar = (container) => {
  const rule = container.querySelector('.rule');
  const fill = rule.querySelector('span');
  return { hidden: rule.getAttribute('aria-hidden'), width: fill.style.width, cls: fill.getAttribute('class') };
};

test('the 2px rule computes its width from siteTrack, turns green when all steps are done, and is aria-hidden', () => {
  const { container } = render(<div id="site-rule"><SiteRule /></div>);
  expect(bar(container)).toEqual({ hidden: 'true', width: '0%', cls: null });

  act(() => {
    state.siteTrack = [
      { name: 'Insured Info', at: 'here' },
      { name: 'Drivers', at: null },
      { name: 'Vehicles', at: null },
      { name: 'Coverages', at: null },
      { name: 'Summary', at: null },
    ];
  });
  expect(bar(container)).toEqual({ hidden: 'true', width: '0%', cls: null });

  act(() => {
    state.siteTrack = [
      { name: 'Insured Info', at: 'done' },
      { name: 'Drivers', at: 'here filled' },
      { name: 'Vehicles', at: null },
      { name: 'Coverages', at: null },
      { name: 'Summary', at: null },
    ];
  });
  expect(bar(container)).toEqual({ hidden: 'true', width: '40%', cls: null });

  act(() => {
    state.siteTrack = [
      { name: 'Insured Info', at: 'done' },
      { name: 'Drivers', at: 'done' },
      { name: 'Summary', at: 'here filled' },
    ];
  });
  expect(bar(container)).toEqual({ hidden: 'true', width: '100%', cls: 'done' });
});

test('mountSiteRule draws before it returns', () => {
  state.siteTrack = [{ name: 'Insured Info', at: 'done' }, { name: 'Vehicles', at: 'here' }];
  const host = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'site-rule' }));
  act(() => {
    mountSiteRule(host);
    expect(bar(host)).toEqual({ hidden: 'true', width: '50%', cls: null });
  });
  host.remove();
});
