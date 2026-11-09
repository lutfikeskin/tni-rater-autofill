import fs from 'node:fs';
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { HELP_TOPICS, HelpLink } from '../../sidepanel/panel/help-link.jsx';

// The '?' on each view (audit 2026-11-07, UX-12b): a link that opens the agent's guide in a new tab at
// the view's section. Each view's '?' names a section the guide has, and Home's, written in
// sidepanel.html, is the same link; the guide is built with the panel, so it is in the package.

afterEach(cleanup);
// From the repository's root, where npm test runs.
const read = (rel) => fs.readFileSync(rel, 'utf8');

test('each view has a ? that opens the guide at its own section in a new tab', () => {
  const guide = read('sidepanel/guide.html');
  for (const topic of /** @type {(keyof typeof HELP_TOPICS)[]} */ (Object.keys(HELP_TOPICS))) {
    const { container } = render(<HelpLink topic={topic} />);
    const a = container.querySelector('a.help-link');
    expect([a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel'), a.getAttribute('aria-label'), a.textContent])
      .toEqual([`guide.html#${topic}`, '_blank', 'noopener', HELP_TOPICS[topic], '?']);
    expect(guide, `the guide has a section for ${topic}`).toMatch(new RegExp(`<section id="${topic}">`));
    cleanup();
  }
  // Where each view draws its '?'.
  for (const [file, topic] of [['checks-view', 'intake'], ['feed-view', 'page'], ['settings-view', 'settings'], ['details-view', 'details']]) {
    expect(read(`sidepanel/panel/${file}.jsx`), file).toContain(`<HelpLink topic="${topic}" />`);
  }
  expect(read('sidepanel/sidepanel.html')).toContain('<h2>Start a quote</h2>\n        <a class="help-link" href="guide.html#home" target="_blank" rel="noopener" aria-label="Help: starting a quote"');
  // Built with the panel: the package carries it beside sidepanel.html.
  expect(read('vite.config.js')).toContain("guide: path.join(here, 'sidepanel/guide.html')");
  // A static page: nothing in it runs.
  expect(guide).not.toMatch(/<script/i);
});
