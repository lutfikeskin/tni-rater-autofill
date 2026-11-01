// Luna's cards in React: on a question's row, what the AI suggests, picked or left (with Use this
// answer / No thanks, Approve / Reject, or Confirm the current page answer), or what happened to it;
// above the list, the assistant's line (asking, a failure, a missing key), Use all and the cards of
// suggestions without a row. Drawn from what renderAi and runAssist (assistant.js) say: a row's card
// from its record (`aiCard`, report-view.jsx draws it in the row's slot), the rest into the report's
// holder (aiHolder). What each button does is the panel's (applyAi and the approval in renderAi).
// One part of the panel.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

// A button that puts the AI's answers in (`put`): while they go in it says so and can't be clicked
// again. `put` returns null when nothing was started (a fill is running: it says so itself).
function PutButton({ className, label, put }) {
  const [busy, setBusy] = useState(false);
  const click = () => {
    const putting = put();
    if (!putting) return;
    setBusy(true);
    const done = () => setBusy(false);
    putting.then(done, done);
  };
  return <button type="button" className={className} disabled={busy} onClick={click}>{busy ? 'Putting it in…' : label}</button>;
}

// One suggestion's card (`card.kind`, as renderAi says it):
// - 'mine': the agent changed the answer on the page;
// - 'rejected': rejected (`text`), with Confirm the current page answer while it holds Continue (`confirm`);
// - 'error': the page didn't take it (`text`);
// - 'picked': put in by the AI, waiting for Approve / Reject (`choice`, `tip`, `notes`);
// - 'done': put in (`text`);
// - 'tip': left to the agent, or a tip only (`says`, `tip`, `next`: Luna's recommendation);
// - 'suggest': an answer to put in (`choice`, `tip`, `why`, `checks`), Use this answer / No thanks.
function AiCard({ card }) {
  switch (card.kind) {
    case 'mine':
      return (
        <div className="ai-done mine"><b>✓</b><span className="grow">You changed this answer on the page.</span><span className="note">Won’t be refilled</span></div>
      );
    case 'rejected':
      return (
        <div className="ai-done bad">
          <span className="grow">{card.text}</span>
          {card.confirm ? <button type="button" className="link small ai-reject" onClick={() => card.confirm()}>Confirm the current page answer</button> : null}
        </div>
      );
    case 'error':
      return <div className="ai-done bad">{card.text}</div>;
    case 'picked':
      return (
        <div className="ai-box">
          <div className="ai-says">{'Picked by the AI: '}<b>{card.choice}</b></div>
          {card.tip ? <div className="ai-tip">{card.tip}</div> : null}
          {card.notes.map((note, i) => <div key={i} className="ai-tip">{note}</div>)}
          <div className="ai-why">Continue waits for your answer.</div>
          <div className="ai-actions">
            <button type="button" className="primary accept" onClick={() => card.approve()}>Approve</button>
            <button type="button" className="ghost ai-reject" onClick={() => card.reject()}>Reject</button>
          </div>
        </div>
      );
    case 'done':
      return <div className="ai-done"><b>✓</b><span className="grow">{card.text}</span></div>;
    case 'tip':
      return (
        <div className="ai-box">
          <div className="ai-says">{card.says}</div>
          {card.tip ? <div className="ai-tip">{card.tip}</div> : null}
          {card.next ? <div className="ai-tip ai-next"><b>{'Luna recommends: '}</b>{card.next}</div> : null}
        </div>
      );
    case 'suggest':
      return (
        <div className="ai-box">
          <div className="ai-says">{'AI suggests '}<b>{card.choice}</b></div>
          {card.tip ? <div className="ai-tip">{card.tip}</div> : null}
          <div className="ai-why">{card.why}</div>
          {card.checks.map((check, i) => <div key={i} className="ai-check">{`Checked by the extension: ${check}`}</div>)}
          <div className="ai-actions">
            <PutButton className="primary accept" label="Use this answer" put={card.use} />
            <button type="button" className="ghost" onClick={() => card.noThanks()}>No thanks</button>
          </div>
        </div>
      );
    default:
      return null;
  }
}

// Above the list (the report's `.ai-holder`): one line while Luna is asked, failed or has no key,
// else Use all and the suggestions without a row of their own.
function AiHolder({ said }) {
  if (said.wait) return <p className="ai-wait">{said.wait}</p>;
  if (said.bad) return <p className="card bad small">{said.bad}</p>;
  if (said.needsKey) {
    return <p className="note-line">{said.needsKey.text}<button type="button" className="link small" onClick={() => said.needsKey.add()}>Add the key</button></p>;
  }
  return (
    <>
      {said.useAll ? <div className="ai-actions"><PutButton className="ghost" label={said.useAll.label} put={said.useAll.put} /></div> : null}
      {(said.orphans ?? []).map((orphan) => <div key={orphan.id} className="ai-orphan"><b>{orphan.label}</b><AiCard card={orphan.card} /></div>)}
    </>
  );
}

// A report's holder for Luna's word above its list (runAssist places `node`): `say` draws what it
// says, before it returns; `remove` takes it down. `isConnected`: still in a report on screen.
function aiHolder() {
  const node = document.createElement('div');
  node.className = 'ai-holder';
  const root = createRoot(node);
  return {
    node,
    get isConnected() { return node.isConnected; },
    say(said) { flushSync(() => root.render(<AiHolder said={said} />)); },
    remove() { root.unmount(); node.remove(); },
  };
}

export { AiCard, AiHolder, aiHolder };
