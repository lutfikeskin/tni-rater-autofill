// The client's header in React: their name (a button to every answer on the intake), the intake
// half of the context line when no rater is in front, the intake PDF and the file tools always in
// view (no menu to open first), the file tools' question before the agent's work would go, and the
// line about the file just loaded. Drawn from what render() says (state.client), state.tab,
// clientNote (state.clientNote) and renderSteps (state.newQuoteOff). What its buttons do is the
// panel's (`act`, wired in sidepanel.js).
// One part of the panel; sidepanel.js mounts it (mountClient).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { useAnnounce } from './announce.js';
// agent defaults: the quote's defaults, once answered, as a pill among the tools.
import { DefaultsChip } from './agent-defaults/view.jsx';

// A count on the context line: an icon and the number, its words for a screen reader.
function Count({ icon, n, one }) {
  const said = `${n} ${one}${n === 1 ? '' : 's'}`;
  return (
    <span className="meta-count" title={said}>
      <svg aria-hidden="true"><use href={`#${icon}`} /></svg>
      <span aria-hidden="true">{n}</span>
      <span className="sr-only">{said}</span>
    </span>
  );
}

// The file tools' question as a popover under the button that asked (askFile's `fileConfirmFrom`):
// its arrow points at that button. Escape or a click outside it is Cancel.
const ASK_TITLES = { replace: 'Change file?', 'new-quote': 'Start a new quote?', 'clear-client': 'Clear this client?' };
function usePopover(open, from, cancel) {
  /** @type {import('react').RefObject<HTMLDivElement | null>} */
  const box = useRef(null);
  // Placed on the element itself: its left edge, and where its arrow points (--arrow-x).
  useLayoutEffect(() => {
    const pop = box.current;
    if (!open || !pop) return;
    const host = pop.offsetParent;
    const button = from ? document.getElementById(from) : null;
    if (!host || !button) return;
    const h = host.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    const center = b.left - h.left + b.width / 2;
    const left = Math.max(8, Math.min(center - width / 2, h.width - width - 8));
    pop.style.left = `${left}px`;
    pop.style.setProperty('--arrow-x', `${Math.max(14, Math.min(center - left, width - 14))}px`);
  }, [open, from]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => {
      if (box.current?.contains(e.target) || (from && document.getElementById(from)?.contains(e.target))) return;
      cancel();
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open, from, cancel]);
  return box;
}

// `act`: details (the name: client details open or closed), pdf, summary (the quote summary), replace,
// newQuote, clear, and the question's yes and cancel.
function ClientHead({ act }) {
  const client = useStore(panelStore, (s) => s.client);
  const onRater = useStore(panelStore, (s) => !!s.tab?.carrier);
  const detailsOpen = useStore(panelStore, (s) => !!s.detailsOpen);
  const newQuoteOff = useStore(panelStore, (s) => !!s.newQuoteOff);
  const note = useStore(panelStore, (s) => s.clientNote);
  const ask = client?.ask;
  const askFrom = useStore(panelStore, (s) => s.fileConfirmFrom);
  const popover = usePopover(!!ask, askFrom, act.cancel);
  const noteLine = useRef(null);
  useAnnounce(note, noteLine);
  return (
    <>
      <div className="client-head">
        <button type="button" id="client-card" className="client-title" aria-controls="details-view" aria-expanded={detailsOpen}
          title="Client details: every answer on the intake, to read or correct" onClick={() => act.details()}>
          <span id="client-name" className="client-name" title={client?.title}>{client?.name ?? ''}</span>
        </button>
        <p id="client-meta" className="client-meta" hidden={onRater || !client?.meta}>
          {client?.counts ? (
            <>
              {client.counts.state ? <span>{client.counts.state}</span> : null}
              <Count icon="driver" n={client.counts.drivers} one="driver" />
              <Count icon="truck" n={client.counts.vehicles} one="vehicle" />
              {client.counts.trailers ? <Count icon="trailer" n={client.counts.trailers} one="trailer" /> : null}
            </>
          ) : (client?.meta ?? '')}
        </p>
        <div className="client-tools">
          <DefaultsChip />
          {/* One joined group (canvas: a button group): icon and word, the word hidden on a narrow panel
              where the button's own name still says it. */}
          <div className="btn-group" role="group" aria-label="Client tools">
            <button type="button" id="open-pdf" className="ghost intake-btn" title="Show the intake PDF" hidden={!client?.pdf} onClick={() => act.pdf()}><span className="pdf-icon" aria-hidden="true">PDF</span>Intake</button>
            <button type="button" id="quote-summary" className="ghost tool-btn" aria-label="Quote summary" title="Quote summary: every answer of this quote, with where it came from" onClick={() => act.summary()}><svg aria-hidden="true"><use href="#list" /></svg><span className="tool-word" aria-hidden="true">Summary</span></button>
            <button type="button" id="replace" className="ghost tool-btn" aria-label="Change file" title="Change file: load another intake PDF" onClick={() => act.replace()}><svg aria-hidden="true"><use href="#file-in" /></svg><span className="tool-word" aria-hidden="true">Change file</span></button>
            <button type="button" id="new-quote" className="ghost tool-btn" aria-label="New quote with this intake" title="New quote with this intake: forgets this quote’s fills, marks and clicks; keeps the intake, your corrections and checks"
              disabled={newQuoteOff} onClick={() => act.newQuote()}><svg aria-hidden="true"><use href="#restart" /></svg><span className="tool-word" aria-hidden="true">New quote</span></button>
            <button type="button" id="clear-client" className="ghost tool-btn danger" aria-label="Clear this client" title="Clear this client" onClick={() => act.clear()}><svg aria-hidden="true"><use href="#trash" /></svg><span className="tool-word" aria-hidden="true">Clear</span></button>
          </div>
          {/* Asked before work the agent did on this intake would go (askFile): a popover under the
              button that asked. */}
          <div id="file-confirm" ref={popover} className="file-confirm popover" role="group" aria-labelledby="file-confirm-title" aria-describedby="file-confirm-text" hidden={!ask}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); act.cancel(); } }}>
            <p id="file-confirm-title" className="popover-title">{ASK_TITLES[askFrom] ?? 'Are you sure?'}</p>
            <p id="file-confirm-text" className="popover-text">{ask?.text ?? ''}</p>
            <div className="popover-actions">
              <button type="button" id="file-confirm-no" className="ghost" onClick={() => act.cancel()}>Cancel</button>
              <button type="button" id="file-confirm-yes" className={askFrom === 'clear-client' ? 'danger-solid' : 'primary'} onClick={() => act.yes()}>{ask?.yes ?? ''}</button>
            </div>
          </div>
        </div>
      </div>
      <p id="client-note" ref={noteLine} className="client-note small" hidden={!note}>{note ?? ''}</p>
    </>
  );
}

// Draws the client's header into #client-root, before it returns.
function mountClient(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<ClientHead act={act} />));
}

export { ClientHead, mountClient };
