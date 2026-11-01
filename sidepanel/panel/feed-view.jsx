// The page view's list of answers in React, around the lists themselves: its title, the menu of pages
// filled earlier on this tab, the filters with their counts, what the tags and the rater page's marks
// mean, which earlier page is shown, how old a kept report is, what an empty list says, and Clear the
// marks. Drawn from what renderSteps (coordinator.js) says of it (state.feed); what its controls do
// is the panel's (`act`, wired in sidepanel.js).
// The lists are not drawn here: #live-root holds the live list (live-view.jsx), #report the report in
// front and #past an earlier one, whose nodes the panel moves in and out (showReport, renderSteps).
// React draws those three empty and never draws into them.
// One part of the panel; sidepanel.js mounts it (mountFeed).
import { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// The filters: all of the report, what needs the agent, what was filled.
const FILTERS = [
  { filter: 'all', label: 'All' },
  { filter: 'needs', label: 'Need you' },
  { filter: 'done', label: 'Filled' },
];

// What the row tags and the rater page's marks (pagekit.js COLORS, the same colors: --mark-*) mean.
function AnswerKey({ open }) {
  return (
    <div id="answer-key" className="answer-key" hidden={!open}>
      <div className="key-line">
        <span className="key-title">Tags:</span>
        <span className="key-plain">none = from the intake</span>
        <span className="tag derived">Worked out</span>
        <span className="tag standard">TNI standard</span>
        <span className="tag ai">AI</span>
        <span className="tag you">You</span>
        <span className="tag page">On the page</span>
      </div>
      <div className="key-line legend">
        <span className="key-title">Marks on the rater page:</span>
        <span><span className="mark filled" />Filled</span>
        <span><span className="mark standard" />TNI standard</span>
        <span><span className="mark needs" />Needs you</span>
        <span><span className="mark failed" />Couldn’t fill</span>
        <span><span className="mark ai" />AI answer</span>
        <span><span className="mark agent" />Your pick</span>
      </div>
    </div>
  );
}

// The answers of the page in front, or of one filled earlier on this tab, read-only. `feed`
// (renderSteps): `shown`; `title`; `pages`, the earlier pages ({ key, title }) and `pastKey`, the one
// shown, with `pastWhen`; `report`, whether the page in front's report shows; `filter` and `counts`
// (null: no filters); `empty`, what an empty list says (null: nothing); `keyOpen` (null: no key
// here); `unmark`; `age`, a kept report's (null: none). Before the panel says anything, as the page
// loads, the list is drawn as the page had it.
function Feed({ act }) {
  const f = useStore(panelStore, (s) => s.feed) ?? { shown: true, title: 'Answers on this page', pages: [], filter: 'all' };
  const menu = useRef(null);
  // The menu shows the page shown as it changes, as the panel set it on each draw.
  useLayoutEffect(() => { if (menu.current) menu.current.value = f.pastKey ?? ''; });
  const past = !!f.pastKey;
  return (
    <div id="feed" className="feed" hidden={!f.shown}>
      <div className="feed-head">
        <div className="feed-title">
          <span id="feed-title" className="eyebrow">{f.title}</span>
          <select id="page-menu" ref={menu} className="page-menu" aria-label="Show the answers of" hidden={!f.pages.length}
            onChange={(e) => act.showPast(e.target.value || null)}>
            {f.pages.length ? <option value="">This page</option> : null}
            {f.pages.map((p) => <option key={p.key} value={p.key}>{p.title}</option>)}
          </select>
          <button type="button" id="key-btn" className="key-btn" aria-label="What the tags and marks mean" title="What the tags and marks mean"
            aria-expanded={String(!!f.keyOpen)} aria-controls="answer-key" hidden={f.keyOpen == null} onClick={() => act.toggleKey()}>i</button>
        </div>
        <div id="filters" className="filters" role="group" aria-label="Show answers" hidden={!f.counts}>
          {FILTERS.map(({ filter, label }) => (
            <button key={filter} type="button" data-filter={filter} aria-pressed={String(filter === f.filter)} onClick={() => act.setFilter(filter)}>
              {label} <span>{f.counts ? String(f.counts[filter] ?? 0) : ''}</span>
            </button>
          ))}
        </div>
      </div>
      <AnswerKey open={!!f.keyOpen} />
      <div id="past-head" className="past-head" hidden={!past}>
        <button type="button" id="past-back" className="link small" onClick={() => { act.showPast(null); menu.current?.focus(); }}>‹ This page</button>
        <span id="past-when" className="small muted">{f.pastWhen ?? ''}</span>
      </div>
      <p id="report-age" className="report-age" hidden={!f.age}>{f.age ?? ''}</p>
      <div id="live-root" />
      <div id="report" className="report" data-filter={f.filter} hidden={!f.report} />
      <div id="past" className="report past" hidden={!past} />
      <p id="feed-empty" className="feed-empty" hidden={f.empty == null}>{f.empty ?? ''}</p>
      <button type="button" id="unmark" className="link small subtle unmark" hidden={!f.unmark} onClick={() => act.clearMarks()}>Clear the marks on the page</button>
    </div>
  );
}

// Draws the list into its place in the page view (#feed-root), before it returns, so the panel finds
// #live-root, #report and #past to fill.
function mountFeed(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Feed act={act} />));
}

export { Feed, mountFeed };
