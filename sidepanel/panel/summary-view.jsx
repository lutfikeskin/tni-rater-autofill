// The quote summary in React (audit 2026-11-07, UX-05): a read-only sheet over the panel with every
// page of the quote per carrier tab, each answer with its source, then the agent's overrides, the
// AI's decisions and what was marked done without an answer. Drawn from what openSummary made
// (state.summary, quote-summary.js); its buttons are the panel's (`act`, wired in sidepanel.js):
// close and save. Nothing here touches a carrier page.
// One part of the panel; sidepanel.js mounts it (mountSummary).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

/** @import { QuoteSummary } from '../../types.js' */

// Where a listed row is: its carrier tab and page.
const where = (r) => [r.carrier, r.page].filter(Boolean).join(' · ');

// One of the lists at the top (overrides, AI decisions, marked done), only when it has rows.
function Listed({ id, title, rows, line }) {
  if (!rows.length) return null;
  return (
    <section className="summary-list" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="summary-h">{`${title} (${rows.length})`}</h3>
      <ul id={id}>{rows.map((r, n) => <li key={n}>{line(r)}</li>)}</ul>
    </section>
  );
}

// A carrier tab's pages, each with its source counts and its answers.
function Carrier({ carrier }) {
  return (
    <section className="summary-carrier" aria-label={carrier.name}>
      <h3 className="summary-h">{carrier.name}{carrier.practice ? ' (practice page)' : ''}</h3>
      {carrier.pages.map((page, n) => (
        <details key={n} className="summary-page" open>
          <summary>
            <span className="title">{page.title}</span>
            <span className="summary-counts small muted">{page.counts.map((c) => `${c.sourceSaid} ${c.n}`).join(' · ')}</span>
          </summary>
          {page.said ? <p className="small summary-said">{page.said}</p> : null}
          <ul className="summary-rows">
            {page.rows.map((r, i) => (
              <li key={i} className={`summary-row ${r.source}`}>
                <span className="summary-q">{r.label}</span>
                <span className="summary-a">{r.value}</span>
                <span className={`tag summary-tag ${r.source}`}>{r.sourceSaid}</span>
                {r.note ? <span className="summary-note small muted">{r.note}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

// The sheet's scrim and panel (#summary-view shows or hides it: showScreen). `act`: close, save.
function Summary({ act }) {
  const open = useStore(panelStore, (s) => s.summary);
  /** @type {QuoteSummary | null} */
  const s = open?.summary ?? null;
  return (
    <>
      <div id="summary-scrim" className="sheet-scrim" onClick={() => act.close()} />
      <section className="sheet-panel summary-panel" role="dialog" aria-modal="true" aria-labelledby="summary-title" aria-describedby="summary-sub">
        <div className="sheet-head">
          <div className="grow">
            <h2 id="summary-title">Quote summary</h2>
            <p id="summary-sub" className="sheet-sub">{s ? `${s.client.name} · ${s.answers} answer${s.answers === 1 ? '' : 's'} in · ${s.open} left for you · read only` : ''}</p>
          </div>
          <button type="button" id="summary-close" className="icon-btn" aria-label="Close the quote summary" onClick={() => act.close()}><svg aria-hidden="true"><use href="#close" /></svg></button>
        </div>
        <div id="summary-body" className="drawer-body summary-body">
          {s ? (
            <>
              <Listed id="summary-overrides" title="Your overrides" rows={s.overrides}
                line={(r) => <>{where(r) ? <span className="muted">{`${where(r)}: `}</span> : null}<b>{r.label}</b>{`: ${r.value} `}<span className="muted">{`(${r.said})`}</span></>} />
              <Listed id="summary-ai" title="AI decisions" rows={s.ai}
                line={(r) => <><span className="muted">{`${where(r)}: `}</span><b>{r.label}</b>{`: ${r.value} `}<span className="muted">{`(${r.sourceSaid})`}</span></>} />
              <Listed id="summary-marked" title="Marked done without an answer" rows={s.marked}
                line={(r) => <><span className="muted">{`${where(r)}: `}</span><b>{r.label}</b>{r.note ? <span className="muted">{` (${r.note})`}</span> : null}</>} />
              {s.carriers.length ? s.carriers.map((c) => <Carrier key={c.tabId} carrier={c} />)
                : <p id="summary-empty" className="small muted">No page of this quote has been filled yet.</p>}
              <p className="small muted">Pages of quote tabs still open, as the panel has them now. Nothing here changes the carrier’s page.</p>
            </>
          ) : null}
        </div>
        <p id="summary-saved" className="small summary-saved" role="status" hidden={!open?.saved}>{open?.saved ?? ''}</p>
        <div className="sheet-foot">
          <button type="button" id="summary-save" className="ghost small-btn" disabled={!s} onClick={() => act.save()}>Save summary</button>
          <button type="button" id="summary-back" className="primary small-btn" onClick={() => act.close()}>Back</button>
        </div>
      </section>
    </>
  );
}

// Draws the quote summary into #summary-view, before it returns.
function mountSummary(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Summary act={act} />));
}

export { Summary, mountSummary };
