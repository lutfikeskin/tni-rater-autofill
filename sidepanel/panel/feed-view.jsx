// @ts-check
// The page view's single unified tabbed sheet (Model 2):
// one header (page title or earlier-pages menu, summary line, i key, ? help),
// one white sheet with three tabs (Needs, Worth a look, All + inline search),
// #live-root / #report / #past inside, and an integrated footer (Clear page marks + field count).
// One part of the panel; sidepanel.js mounts it (mountFeed).

/** @import { PanelState } from '../../types.js' */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { HelpLink } from './help-link.jsx';
import { FEED } from './messages.js';
import { handleRovingKey } from './roving-focus.js';

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
 *   host?: HTMLElement,
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
    filledCount: 0,
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
  const reportFor = useStore(panelStore, (/** @type {PanelState} */ s) => s.reportFor);
  const rowsDrawn = useStore(panelStore, (/** @type {PanelState} */ s) => s.rowsDrawn);
  /** @type {import('react').RefObject<HTMLSelectElement | null>} */
  const menu = useRef(null);
  /** @type {import('react').RefObject<HTMLDivElement | null>} */
  const reportRef = useRef(null);
  const [filterStop, setFilterStop] = useState(/** @type {string | null} */ (null));
  const [query, setQuery] = useState('');
  const [searchEmpty, setSearchEmpty] = useState(false);

  const activeFilterStop = filterStop && FEED.filters.some((item) => item.filter === filterStop)
    ? filterStop
    : (FEED.filters.some((item) => item.filter === f.filter) ? f.filter : 'all');

  // The menu shows the page shown as it changes, as the panel set it on each draw.
  useLayoutEffect(() => {
    if (menu.current) menu.current.value = f.pastKey ?? '';
  });

  // Clear inline search whenever the tab or page report changes.
  useEffect(() => {
    setQuery('');
    setSearchEmpty(false);
  }, [f.filter, f.pastKey, reportFor]);

  // Apply live text filter across #report rows when the All tab's search box has text.
  useEffect(() => {
    const root = reportRef.current;
    if (!root) return;
    const q = f.filter === 'all' && !f.pastKey ? query.trim().toLowerCase() : '';
    const rows = /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('.rows > .row'));
    let visible = 0;
    for (const row of rows) {
      if (!q) {
        row.removeAttribute('data-search-hide');
        if (!row.hidden) visible += 1;
        continue;
      }
      const match = (row.textContent ?? '').toLowerCase().includes(q);
      if (match) {
        row.removeAttribute('data-search-hide');
        if (!row.hidden) visible += 1;
      } else {
        row.setAttribute('data-search-hide', '1');
      }
    }
    setSearchEmpty(Boolean(q) && visible === 0);
    return () => {
      for (const row of rows) row.removeAttribute('data-search-hide');
    };
  }, [query, f.filter, f.pastKey, reportFor, rowsDrawn]);

  const past = !!f.pastKey;
  const pages = /** @type {Array<{ key: string, title: string }>} */ (f.pages ?? []);
  const counts = f.counts;
  const filledCount = typeof f.filledCount === 'number' ? f.filledCount : (counts ? Math.max(0, (counts.all ?? 0) - (counts.needs ?? 0)) : 0);
  const needsCount = counts?.needs ?? 0;
  const showSearch = f.filter === 'all' && !!f.report && !past && (counts?.all ?? 0) > 6;
  const emptyText = searchEmpty ? FEED.emptySearch : f.empty;

  return (
    <div id="feed" className="feed" hidden={!f.shown}>
      <div className="feed-head">
        <div className="feed-head-main">
          <div className="feed-title">
            <h2 id="feed-title" className="eyebrow" hidden={pages.length > 0 && !f.report}>{f.title}</h2>
            <select
              id="page-menu"
              ref={menu}
              className="page-menu"
              aria-label={FEED.pageMenuLabel}
              hidden={!pages.length}
              onChange={(e) => act?.showPast?.(e.target.value || null)}
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
          {f.report && !past && counts ? (
            <p className="feed-sub">
              {`${filledCount} filled`}
              {' \u00b7 '}
              {needsCount > 0
                ? <strong className="feed-sub-needs">{`${needsCount} ${needsCount === 1 ? 'needs' : 'need'} you`}</strong>
                : 'all set'}
            </p>
          ) : null}
        </div>
      </div>

      <AnswerKey open={!!f.keyOpen} />

      <div className="feed-sheet">
        <div
          id="filters"
          className="filters"
          data-filter={f.filter}
          role="toolbar"
          aria-label={FEED.filtersLabel}
          hidden={!counts}
          onKeyDown={(e) => handleRovingKey(e, e.currentTarget, 'button', {
            onMove: (el) => setFilterStop(el.dataset.filter ?? null),
          })}
          onBlur={(e) => {
            if (!e.currentTarget.contains(/** @type {Node | null} */ (e.relatedTarget))) setFilterStop(null);
          }}
        >
          {FEED.filters.map(({ filter, label }) => {
            const count = counts ? (counts[filter] ?? 0) : 0;
            const pressed = filter === f.filter;
            return (
              <button
                key={filter}
                type="button"
                data-filter={filter}
                aria-pressed={pressed ? 'true' : 'false'}
                tabIndex={activeFilterStop === filter ? 0 : -1}
                onFocus={() => setFilterStop(filter)}
                onClick={() => act?.setFilter?.(filter)}
              >
                {filter === 'needs' && count > 0 ? <span className="group-dot amber" aria-hidden="true" /> : null}
                {label} <span className="tab-cnt">{counts ? String(count) : ''}</span>
              </button>
            );
          })}
        </div>

        {showSearch ? (
          <div className="feed-search">
            <input
              type="search"
              id="feed-search-input"
              aria-label={FEED.searchLabel}
              placeholder={FEED.searchPlaceholder(counts.all)}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        ) : null}

        <div id="past-head" className="past-head" hidden={!past}>
          <button
            type="button"
            id="past-back"
            className="link small"
            onClick={() => {
              act?.showPast?.(null);
              menu.current?.focus();
            }}
          >
            {FEED.pastBack}
          </button>
          <span id="past-when" className="small muted">{f.pastWhen ?? ''}</span>
        </div>

        <p id="report-age" className="report-age" hidden={!f.age}>{f.age ?? ''}</p>
        <div id="live-root" />
        <div id="report" ref={reportRef} className="report" data-filter={f.filter} hidden={!f.report} />
        <div id="past" className="report past" hidden={!past} />
        <p id="feed-empty" className="feed-empty" hidden={emptyText == null}>{emptyText ?? ''}</p>

        <div className="feed-tools" hidden={!f.unmark}>
          <button type="button" id="unmark" className="link small subtle unmark" hidden={!f.unmark} onClick={() => act?.clearMarks?.()}>
            {FEED.clearMarks}
          </button>
          {counts ? <span className="feed-total">{FEED.totalFields(counts.all)}</span> : null}
        </div>
      </div>
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
/** @type {{ root: import('react-dom/client').Root, host: HTMLElement } | null} */
let mountedFeed = null;
function mountFeed(host, act) {
  if (mountedFeed && (!mountedFeed.host.isConnected || mountedFeed.host === host)) {
    mountedFeed.root.unmount();
  }
  const root = createRoot(host);
  mountedFeed = { root, host };
  flushSync(() => root.render(<Feed act={act} host={host} />));
}

export { Feed, mountFeed };
