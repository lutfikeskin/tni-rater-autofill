// The panel's notes and cards in React, besides those at the top of the page view (cards-view.jsx):
// a usage log that can't be saved (#notices) and a Pop out or Dock that didn't work (#window-note),
// from what renderHealth and windowProblem say (state.notes); a PDF that couldn't be read
// (#load-error, from showLoadError's state.loadError); and what a fill's report says above its list,
// drawn into the report as renderReport (fill.js) builds it.
// One part of the panel; sidepanel.js mounts the notes (mountNote, mountLoadError), renderReport a
// report's head (headHost).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { IssueCard } from './cards-view.jsx';

// `name`'s card in state.notes, as issueSaid (coordinator.js) puts it: nothing while it is null.
function Note({ name }) {
  const card = useStore(panelStore, (s) => s.notes?.[name] ?? null);
  return card ? <IssueCard {...card} /> : null;
}

// Why the PDF couldn't be read ({ title, text }), in #load-error, whose `hidden` the panel sets.
function LoadError() {
  const said = useStore(panelStore, (s) => s.loadError);
  return said ? <><b>{said.title}</b><span className="small">{said.text}</span></> : null;
}

// What a report says above its list, in its order (renderReport): `card`, a card as issueSaid puts it
// (a warn page's, what wasn't clicked, the fill stopped, the page changed); `line`, the page's note
// ('agent-page') or an answer picked in place of one the page doesn't offer ('said'), with its
// `text`; `done`, what This page is done says. A report's head never changes: a fill makes a report
// anew.
function ReportHead({ items }) {
  return items.map((item, i) => {
    if (item.card) return <IssueCard key={i} {...item.card} />;
    if (item.done != null) {
      return (
        <div key={i} className="done-card">
          <span className="tick" aria-hidden="true">✓</span>
          <b>This page is done</b>
          <span>{item.done}</span>
        </div>
      );
    }
    return <p key={i} className={`note-line ${item.line}`}>{item.text}</p>;
  });
}

// Draws `name`'s note (state.notes) into `host`, before it returns.
function mountNote(host, name) {
  const root = createRoot(host);
  flushSync(() => root.render(<Note name={name} />));
}

// Draws why the PDF couldn't be read into #load-error, before it returns.
function mountLoadError(host) {
  const root = createRoot(host);
  flushSync(() => root.render(<LoadError />));
}

// Draws a report's head into `host` before it returns (the panel then puts the host in the report,
// or keeps it with the report's other nodes, and moves it with them: React's root goes along).
// Returns what takes it down.
function mountReportHead(host, items) {
  const root = createRoot(host);
  flushSync(() => root.render(<ReportHead items={items} />));
  return () => root.unmount();
}

export { LoadError, Note, ReportHead, mountLoadError, mountNote, mountReportHead };
