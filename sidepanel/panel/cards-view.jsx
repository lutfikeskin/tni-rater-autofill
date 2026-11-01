// The cards at the top of the page view in React: the rater to open while the tab in front is none,
// then what's wrong or different about this tab's quote, above its answers: the client's current
// insurance with this carrier (showCarrierNote), the quote's state against the intake's
// (showStateNote), the carrier's stop or the agent's step (showStopPage), review mode
// (showReviewMode) and the last fill that didn't finish (renderSteps). Drawn from what those say
// (state.cards, each card as issueSaid in coordinator.js puts it).
// One part of the panel; sidepanel.js mounts it (mountCards).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import progressiveLogo from '../assets/raters/progressive.svg';
import geicoLogo from '../assets/raters/geico.gif';
import amwinsLogo from '../assets/raters/amwins.svg';

// A card: its tone ('' red, 'warn', 'info', 'quiet'), title, what it says, its notes, what it
// compares side by side, and its buttons. The panel's other cards are drawn with it too (notes-view.jsx).
function IssueCard({ tone, title, text, notes, compare, actions, role }) {
  return (
    <div className={`issue${tone ? ` ${tone}` : ''}`} role={role}>
      <div className="issue-head">
        <span className="bang" aria-hidden="true">{tone === 'info' ? 'i' : '!'}</span>
        <div className="issue-text">
          <span className="issue-title">{title}</span>
          {text ? <span>{text}</span> : null}
          {notes.map((note, i) => <span key={i} className="small-note">{note}</span>)}
        </div>
      </div>
      {compare.length ? <div className="compare">{compare.map(([k, v], i) => <span key={i}><span className="k">{`${k}:`}</span>{` ${v}`}</span>)}</div> : null}
      {actions.length ? (
        <div className="issue-actions">
          {actions.map((a, i) => <button key={i} type="button" className={a.className} onClick={a.onClick}>{a.label}</button>)}
        </div>
      ) : null}
    </div>
  );
}

// The cards above the answers, in this order, each in its place (`id`), hidden while it says nothing.
const NOTES = [
  { name: 'carrier', id: 'carrier-note' },
  { name: 'state', id: 'state-note' },
  { name: 'stop', id: 'stop-note' },
  { name: 'review', id: 'review-note' },
  { name: 'fill', id: 'fill-error' },
];

// `cards.waiting`: why there is nothing to fill here (no rater in front), or null.
function Cards() {
  const cards = useStore(panelStore, (s) => s.cards) ?? {};
  return (
    <>
      <div id="fill-waiting" className="pane waiting" hidden={cards.waiting == null}>
        <p id="fill-waiting-text" className="muted">{cards.waiting ?? ''}</p>
        <div className="rater-logos">
          <img src={progressiveLogo} alt="Progressive" />
          <img src={geicoLogo} alt="GEICO" />
          <img src={amwinsLogo} alt="AmWINS" />
        </div>
      </div>
      <div id="issues" className="issues">
        {NOTES.map(({ name, id }) => (
          <div key={id} id={id} hidden={!cards[name]}>{cards[name] ? <IssueCard {...cards[name]} /> : null}</div>
        ))}
      </div>
    </>
  );
}

// Draws the cards into their place at the top of the page view (#cards-root), before it returns.
function mountCards(host) {
  const root = createRoot(host);
  flushSync(() => root.render(<Cards />));
}

export { Cards, IssueCard, mountCards };
