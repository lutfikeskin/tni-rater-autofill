// @ts-check
// Home's setup checklist (audit 2026-11-07, UX-12a): what setting up the panel takes, each item
// ticked when its health check passes (setupItems, usage-panel.js), shown while anything is left
// and gone once all is done. An item left to do opens Settings at its box.
// One part of the panel; sidepanel.js mounts it in #setup-root (mountSetup), renderHealth says it
// (state.health.checklist).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

/** @typedef {{ id: string, label: string, done: boolean, focus: string }} SetupItem */

// `act.open(focus)`: open Settings at that box (openSettings).
/** @param {{ act: { open: (focus: string) => void } }} props */
function SetupCard({ act }) {
  /** @type {SetupItem[] | null} */
  const items = useStore(panelStore, (s) => s.health?.checklist ?? null);
  if (!items?.length) return null;
  const left = items.filter((x) => !x.done).length;
  // Initials are required before a quote (the maintainer, 2026-11-08, audit GAP-04): said first.
  const initials = items.find((x) => x.id === 'initials' && !x.done);
  return (
    <section id="setup-card" className="setup-card" aria-labelledby="setup-card-title">
      <h3 id="setup-card-title">Finish setting up</h3>
      {initials && (
        <div className="setup-gate" role="alert">
          <p><b>Add your initials to start a quote.</b> No intake loads until they are set: they mark your quotes as yours.</p>
          <button type="button" className="primary" onClick={() => act.open(initials.focus)}>Add your initials</button>
        </div>
      )}
      <p className="muted small">{left === 1 ? 'One thing left' : `${left} things left`}, then you’re ready to quote.</p>
      <ul className="setup-list">
        {items.map((x) => (
          <li key={x.id} className={x.done ? 'done' : undefined} data-item={x.id}>
            <span className="tick" aria-hidden="true">{x.done ? '✓' : ''}</span>
            <span className="setup-label">{x.label}<span className="sr-only">{x.done ? ' (done)' : ' (to do)'}</span></span>
            {!x.done && <button type="button" className="link small" onClick={() => act.open(x.focus)}>Set up</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Draws the checklist into `host`, before it returns.
/** @param {Element} host @param {{ open: (focus: string) => void }} act */
function mountSetup(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<SetupCard act={act} />));
}

export { SetupCard, mountSetup };
