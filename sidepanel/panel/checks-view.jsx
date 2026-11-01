// Step 1's checks in React: what looked wrong or missing on the intake, one card each with its field
// to fix, Looks right and where it is on the PDF (a checked one is a row with Undo); the cleanup
// notes; and the All client details row. Drawn from what renderWarnings says (state.checks). Also the
// unit pickers above the page's answers, from what renderPickers says (state.pickers).
// One part of the panel; sidepanel.js mounts it (mountChecks, mountPickers).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// A check card's field (fieldSaid in record.js), named by the card above it. Its edit is made as the
// box's own change event says it, as in client details: a text box's when the agent leaves it or
// presses Enter, not each key. The box shows the record's value as it was said (a new value is
// another box: the card's key).
function CheckField({ field }) {
  const ref = useRef(null);
  const { control, value, options, label, edit, maxLength } = field;
  useEffect(() => {
    const box = ref.current;
    const changed = () => edit(box.value);
    box.addEventListener('change', changed);
    return () => box.removeEventListener('change', changed);
  }, [edit]);
  if (control === 'select') {
    return <select ref={ref} aria-label={label} defaultValue={value}>{options.map(([v, text], n) => <option key={n} value={v}>{text}</option>)}</select>;
  }
  if (control === 'textarea') return <textarea ref={ref} aria-label={label} rows={4} defaultValue={value} />;
  return <input ref={ref} aria-label={label} type="text" placeholder="not on form" maxLength={maxLength} defaultValue={value} />;
}

function CheckHead({ title, msg }) {
  return (
    <div className="issue-head">
      <span className="bang" aria-hidden="true">!</span>
      <div className="check-text">{title ? <b>{title}</b> : null}<span>{msg}</span></div>
    </div>
  );
}

// One item: checked (a row with Undo), Luna's choices, or its field with Looks right.
function CheckCard({ card }) {
  if (card.done) {
    return (
      <div className="checked-row" data-check={card.i}>
        <span className="tick" aria-hidden="true">✓</span>
        <span className="grow">{card.said}</span>
        <button type="button" className="link small" onClick={card.undo}>Undo</button>
      </div>
    );
  }
  const pdf = card.pdf ? <button type="button" className="ghost" onClick={card.pdf.onClick}>{card.pdf.label}</button> : null;
  if (card.choices) {
    return (
      <div className="check" data-check={card.i}>
        <CheckHead title={card.title} msg={card.msg} />
        <div className="check-body">
          <div className="check-actions">
            <div className="check-choices">{card.choices.map((c, n) => <button key={n} type="button" className="ghost" onClick={c.onClick}>{c.label}</button>)}</div>
            {pdf}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={card.alert ? 'check alert' : 'check'} role={card.alert ? 'alert' : undefined} data-check={card.i}>
      <CheckHead title={card.title} msg={card.msg} />
      <div className="check-body">
        {card.field ? <CheckField key={`${card.field.path}|${card.field.value}`} field={card.field} /> : null}
        <div className="check-actions">
          <button type="button" className="tinted" onClick={card.lookRight}>Looks right</button>
          {pdf ?? (card.details ? <button type="button" className="ghost" onClick={card.details}>Show details</button> : null)}
        </div>
      </div>
    </div>
  );
}

// Step 1's view (#check-view). `act.openDetails`: the All client details row.
function Checks({ act }) {
  const checks = useStore(panelStore, (s) => s.checks);
  const filled = useStore(panelStore, (s) => s.intake?.stats?.filled);
  const detailsOpen = useStore(panelStore, (s) => !!s.detailsOpen);
  const cleanup = checks?.cleanup ?? [];
  return (
    <>
      <div className="pane-head">
        <h2 id="check-title">{checks?.title ?? ''}</h2>
        <p id="check-sub" className="pane-sub">{checks?.sub ?? ''}</p>
      </div>
      <div id="warnings" className="checks">
        {(checks?.cards ?? []).map((card) => <CheckCard key={card.i} card={card} />)}
        {cleanup.length ? (
          <details className="fold cleanup">
            <summary className="list-row">
              <span className="grow">Cleanup notes</span>
              <span className="small muted">{`${cleanup.length} change${cleanup.length === 1 ? '' : 's'}`}</span>
              <span className="chev" aria-hidden="true">›</span>
            </summary>
            <div className="card">{cleanup.map((msg, n) => <p key={n}>{msg}</p>)}</div>
          </details>
        ) : null}
      </div>
      <button type="button" id="details-row" className="list-row" aria-controls="details-view" aria-expanded={detailsOpen} onClick={act.openDetails}>
        <span className="grow">All client details</span>
        <span id="details-count" className="small muted">{filled == null ? '' : `${filled} answers`}</span>
        <span className="chev" aria-hidden="true">›</span>
      </button>
    </>
  );
}

// The unit pickers (#pickers): nothing when the page is about no one of several. `act.pick(list, i)`.
function Pickers({ act }) {
  const pickers = useStore(panelStore, (s) => s.pickers) ?? [];
  return pickers.map(({ list, what, names, active }) => (
    <div key={list} className="picker">
      <label htmlFor={`pick-${list}`}>{what}</label>
      <select id={`pick-${list}`} value={String(active ?? 0)} onChange={(e) => act.pick(list, Number(e.target.value))}>
        {names.map((name, i) => <option key={i} value={String(i)}>{name}</option>)}
      </select>
    </div>
  ));
}

// Draws step 1's view into #check-view, before it returns.
function mountChecks(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Checks act={act} />));
}

// Draws the unit pickers into #pickers, before it returns.
function mountPickers(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Pickers act={act} />));
}

export { CheckCard, Checks, Pickers, mountChecks, mountPickers };
