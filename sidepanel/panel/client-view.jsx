// The client's header in React: their name (a button to every answer on the intake) and what the
// quote is about, the intake PDF and the file tools always in view (no menu to open first), the file
// tools' question before the agent's work would go, and the line about the file just loaded. Drawn
// from what render() says (state.client), clientNote (state.clientNote) and renderSteps
// (state.newQuoteOff). What its buttons do is the panel's (`act`, wired in sidepanel.js).
// One part of the panel; sidepanel.js mounts it (mountClient).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// `act`: details (the name: client details open or closed), pdf, replace, newQuote, clear, and the
// question's yes and cancel.
function ClientHead({ act }) {
  const client = useStore(panelStore, (s) => s.client);
  const detailsOpen = useStore(panelStore, (s) => !!s.detailsOpen);
  const newQuoteOff = useStore(panelStore, (s) => !!s.newQuoteOff);
  const note = useStore(panelStore, (s) => s.clientNote);
  const ask = client?.ask;
  return (
    <>
      <div className="client-head">
        <button type="button" id="client-card" className="client-title" aria-controls="details-view" aria-expanded={detailsOpen}
          title="Client details: every answer on the intake, to read or correct" onClick={() => act.details()}>
          <span id="client-name" className="client-name" title={client?.title}>{client?.name ?? ''}</span>
          <span id="client-meta" className="client-meta">{client?.meta ?? ''}</span>
        </button>
        <div className="client-tools">
          <button type="button" id="open-pdf" className="ghost intake-btn" title="Show the intake PDF" hidden={!client?.pdf} onClick={() => act.pdf()}><span className="pdf-icon" aria-hidden="true">PDF</span>Intake</button>
          <button type="button" id="replace" className="ghost tool-btn" aria-label="Change file" title="Change file: load another intake PDF" onClick={() => act.replace()}><svg aria-hidden="true"><use href="#file-in" /></svg></button>
          <button type="button" id="new-quote" className="ghost tool-btn" aria-label="New quote with this intake" title="New quote with this intake: forgets this quote’s fills, marks and clicks; keeps the intake, your corrections and checks"
            disabled={newQuoteOff} onClick={() => act.newQuote()}><svg aria-hidden="true"><use href="#restart" /></svg></button>
          <button type="button" id="clear-client" className="ghost tool-btn danger" aria-label="Clear this client" title="Clear this client" onClick={() => act.clear()}><svg aria-hidden="true"><use href="#trash" /></svg></button>
        </div>
      </div>
      {/* Asked before work the agent did on this intake would go (askFile). */}
      <div id="file-confirm" className="file-confirm" role="group" aria-labelledby="file-confirm-text" hidden={!ask}>
        <p id="file-confirm-text" className="small">{ask?.text ?? ''}</p>
        <div className="actions">
          <button type="button" id="file-confirm-yes" className="ghost danger" onClick={() => act.yes()}>{ask?.yes ?? ''}</button>
          <button type="button" id="file-confirm-no" className="ghost" onClick={() => act.cancel()}>Cancel</button>
        </div>
      </div>
      <p id="client-note" className="client-note small" role="status" hidden={!note}>{note ?? ''}</p>
    </>
  );
}

// Draws the client's header into #client-root, before it returns.
function mountClient(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<ClientHead act={act} />));
}

export { ClientHead, mountClient };
