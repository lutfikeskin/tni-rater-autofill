// @ts-check
// The page view's list of answers in React, around the lists themselves: its title, the menu of pages
// filled earlier on this tab, the filters with their counts, what the tags and the rater page's marks
// mean, which earlier page is shown, how old a kept report is, what an empty list says, and Clear the
// marks. Drawn from what renderSteps (coordinator.js) says of it (state.feed); what its controls do
// is the panel's (`act`, wired in sidepanel.js).
// The lists are not drawn here: #live-root holds the live list (live-view.jsx), #report the report in
// front and #past an earlier one, whose nodes the panel moves in and out (showReport, renderSteps).
// React draws those three empty and never draws into them.
// One part of the panel; sidepanel.js mounts it (mountFeed).

/** @import { PanelState } from '../../types.js' */

import { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { HelpLink } from './help-link.jsx';
import { FEED } from './messages.js';

/**
 * What the row tags and the rater page's marks (pagekit.js COLORS, the same colors: --mark-*) mean.
 * @param {{ open: boolean }} props
 */
function AnswerKey({ open }) {
  // agent defaults: its tag and mark only where the feature is on (store.js loadDefaults).
  const own = useStore(panelStore, (/** @type {PanelState} */ s) => !!s.defaultsOn);
  return (
    <div id="answer-key" className="answer-key" hidden={!open}>
      <div className="key-line">
        <span className="key-title">{FEED.tagsTitle}</span>
        <span className="key-plain">{FEED.tagsIntake}</span>
        <span className="tag derived">{FEED.tagDerived}</span>
        <span className="tag standard">{FEED.tagStandard}</span>
        {own ? <span className="tag own">{FEED.tagOwn}</span> : null}
        <span className="tag ai">{FEED.tagAi}</span>
        <span className="tag you">{FEED.tagYou}</span>
        <span className="tag page">{FEED.tagPage}</span>
      </div>
      <div className="key-line legend">
        <span className="key-title">{FEED.marksTitle}</span>
        <span><span className="mark filled" />{FEED.markFilled}</span>
        <span><span className="mark standard" />{FEED.tagStandard}</span>
        {own ? <span><span className="mark own" />{FEED.tagOwn}</span> : null}
        <span><span className="mark needs" />{FEED.markNeeds}</span>
        <span><span className="mark failed" />{FEED.markFailed}</span>
        <span><span className="mark ai" />{FEED.tagAi}</span>
        <span><span className="mark agent" />{FEED.tagYou}</span>
      </div>
    </div>
  );
}

/**
 * The answers of the page in front, or of one filled earlier on this tab, read-only.
 * @param {{
 *   act?: {
 *     setFilter?: (filter: string) => void,
 *     showPast?: (key: string | null) => void,
 *     toggleKey?: () => void,
 *     clearMarks?: () => void,
 *   },
 * }} props
 */
function Feed({ act }) {
  const f = useStore(panelStore, (/** @type {PanelState} */ s) => s.feed) ?? {
    shown: true,
    title: FEED.defaultTitle,
    pages: [],
    pastKey: null,
    pastWhen: '',
    report: false,
    filter: 'all',
    counts: null,
    empty: null,
    keyOpen: null,
    unmark: false,
    age: null,
  };
  const hasReport = useStore(
    panelStore,
    (/** @type {PanelState} */ s) => Boolean(s.reportFor && Array.isArray(s.reportFor.list) && !s.filling),
  );
  const inAll = useStore(
    panelStore,
    (/** @type {PanelState} */ s) => Boolean(s.allAnswers && (!s.allAnswersFor || s.allAnswersFor === s.reportFor)),
  );
  const focusNeed = useStore(panelStore, (/** @type {PanelState} */ s) => {
    void s.rowsDrawn;
    void s.rowsAll;
    const entry = s.reportFor;
    if (!entry || !Array.isArray(entry.list) || s.filling) return false;
    if (s.allAnswers && (!s.allAnswersFor || s.allAnswersFor === entry)) return false;
    const list = /** @type {Array<Record<string, any>>} */ (entry.list);
    if (!list.some((r) => r.type === 'need' && !r.gone && r.open)) return false;
    return list.some((r) => r.type === 'need' && !r.gone && (!r.settled || r.pending));
  });
  /** @type {import('react').RefObject<HTMLSelectElement | null>} */
  const menu = useRef(null);
  // The menu shows the page shown as it changes, as the panel set it on each draw.
  useLayoutEffect(() => {
    if (menu.current) menu.current.value = f.pastKey ?? '';
  });
  const past = !!f.pastKey;
  const pages = /** @type {Array<{ key: string, title: string }>} */ (f.pages ?? []);
  const grouped = hasReport && !past && !inAll;
  const allOpen = hasReport && !past && inAll;
  const showFocus = focusNeed && !past && !!f.report;

  return (
    <div
      id="feed"
      className="feed"
      data-grouped={grouped ? 'true' : undefined}
      data-all={allOpen ? 'true' : undefined}
      hidden={!f.shown}
    >
      <div className="feed-head">
        <div className="feed-title">
          <span id="feed-title" className="eyebrow">{f.title}</span>
          <select
            id="page-menu"
            ref={menu}
            className="page-menu"
            aria-label={FEED.pageMenuLabel}
            hidden={!pages.length}
            onChange={(e) => act.showPast(e.target.value || null)}
          >
            {pages.length ? <option value="">{FEED.thisPage}</option> : null}
            {pages.map((p) => <option key={p.key} value={p.key}>{p.title}</option>)}
          </select>
          <button
            type="button"
            id="key-btn"
            className="key-btn"
            aria-label={FEED.keyLabel}
            title={FEED.keyLabel}
            aria-expanded={f.keyOpen ? 'true' : 'false'}
            aria-controls="answer-key"
            hidden={f.keyOpen == null}
            onClick={() => act?.toggleKey?.()}
          >
            i
          </button>
          <HelpLink topic="page" />
        </div>
        <div id="filters" className="filters" data-filter={f.filter} role="group" aria-label={FEED.filtersLabel} hidden={!f.counts}>
          {FEED.filters.map(({ filter, label }) => (
            <button
              key={filter}
              type="button"
              data-filter={filter}
              aria-pressed={filter === f.filter ? 'true' : 'false'}
              onClick={() => act?.setFilter?.(filter)}
            >
              {label} <span>{f.counts ? String(f.counts[filter] ?? 0) : ''}</span>
            </button>
          ))}
        </div>
      </div>
      <AnswerKey open={!!f.keyOpen} />
      <div id="past-head" className="past-head" hidden={!past}>
        <button
          type="button"
          id="past-back"
          className="link small"
          onClick={() => {
            act.showPast(null);
            menu.current?.focus();
          }}
        >
          {FEED.pastBack}
        </button>
        <span id="past-when" className="small muted">{f.pastWhen ?? ''}</span>
      </div>
      <p id="report-age" className="report-age" hidden={!f.age}>{f.age ?? ''}</p>
      <div id="live-root" />
      <div id="report" className="report" data-filter={f.filter} data-focus={showFocus ? 'need' : undefined} hidden={!f.report} />
      <div id="past" className="report past" hidden={!past} />
      <p id="feed-empty" className="feed-empty" hidden={f.empty == null}>{f.empty ?? ''}</p>
      <button type="button" id="unmark" className="link small subtle unmark" hidden={!f.unmark} onClick={() => act?.clearMarks?.()}>
        {FEED.clearMarks}
      </button>
    </div>
  );
}

/**
 * Draws the list's frame before it returns: sidepanel.js mounts the live list into #live-root and
 * the panel puts the report's nodes into #report right after.
 * @param {HTMLElement} host
 * @param {{
 *   setFilter: (filter: string) => void,
 *   showPast: (key: string | null) => void,
 *   toggleKey: () => void,
 *   clearMarks: () => void,
 * }} act
 */
function mountFeed(host, act) {
  flushSync(() => createRoot(host).render(<Feed act={act} />));
}

export { Feed, mountFeed };
