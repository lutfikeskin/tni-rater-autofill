// Step 1's checks in React: by default one open check at a time on the canvas (focus mode: canvas
// Check and CheckSerious), with quiet links to check the rest later or see the full list; in full-list
// mode (or once every check is done), one row/card per item with Undo, Cleanup notes, and a link back
// to focus mode while open checks remain; and the All client details row below. Drawn from what
// renderWarnings says (state.checks) plus state.checksAll (toggled through act.showAll / act.showOne).
// Also the unit pickers above the page's answers, from what renderPickers says (state.pickers).
// One part of the panel; sidepanel.js mounts it (mountChecks, mountPickers).
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { useAnnounce } from './announce.js';
import { CHECKS } from './messages.js';
import { HelpLink } from './help-link.jsx';

// A check card's field (fieldSaid in record.js), named by the card above it. Its edit is made as the
// box's own change event says it, as in client details: a text box's when the agent leaves it or
// presses Enter, not each key. The box shows the record's value as it was said (a new value is
// another box: the card's key; so is a value an edit saved otherwise than typed, `rev`: "No" in the
// USDOT box is saved empty).
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

// One item in the full list: checked (a row with Undo), Luna's choices, or its field with Looks right.
function CheckCard({ card }) {
  if (card.done) {
    return (
      <div className="checked-row" data-check={card.i}>
        <span className="tick" aria-hidden="true">{'\u2713'}</span>
        <span className="grow">{card.said}</span>
        <button type="button" className="icon-btn undo-btn" aria-label={`Undo: ${card.said}`} title="Undo" onClick={card.undo}><svg aria-hidden="true"><use href="#undo" /></svg></button>
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
        {card.field ? <CheckField key={`${card.field.path}|${card.field.value}|${card.field.rev ?? 0}`} field={card.field} /> : null}
        <div className="check-actions">
          <button type="button" className="tinted" onClick={card.lookRight}>{CHECKS.looksRight}</button>
          {pdf ?? (card.details ? <button type="button" className="ghost" onClick={card.details}>{CHECKS.showDetails}</button> : null)}
        </div>
      </div>
    </div>
  );
}

// One open check on the canvas (focus mode: canvas Check and CheckSerious): eyebrow ("Check the
// intake · i of n", or red "Serious · check i of n" with role="alert" on the eyebrow and the serious
// note announced once on arrival), 26px field title, full explanation, editable control or equal-weight
// choice buttons, primary Looks right + See intake / Show details, and Check the rest later (or on
// CheckSerious an outline "Decide later and fill" button + quote note) plus See all whenever more
// items or cleanup notes exist.
function FocusCheck({ card, at, total, later }) {
  const noteRef = useRef(null);
  useAnnounce(card.alert ? CHECKS.seriousNote : '', noteRef);
  const pdf = card.pdf ? <button type="button" className="ghost" onClick={card.pdf.onClick}>{card.pdf.label}</button> : null;
  return (
    <div className={card.alert ? 'check check-focus alert' : 'check check-focus'} data-check={card.i}>
      <div className="pane-head">
        <div className="check-card-head">
          <p className="check-eyebrow" role={card.alert ? 'alert' : undefined}>
            {card.alert
              ? <><b className="serious">{CHECKS.serious}</b>{CHECKS.seriousAt(at, total)}</>
              : CHECKS.eyebrow(at, total)}
          </p>
          <HelpLink topic="intake" />
        </div>
        <h2 id="check-title">{card.title || CHECKS.fallbackTitle}</h2>
        <p id="check-sub" className="pane-sub">{card.msg}</p>
      </div>
      <div className="check-focus-body">
        {card.field ? <CheckField key={`${card.field.path}|${card.field.value}|${card.field.rev ?? 0}`} field={card.field} /> : null}
        {card.choices ? (
          <div className="check-actions">
            <div className="check-choices">
              {card.choices.map((c, n) => (
                <button key={n} type="button" className="ghost" onClick={c.onClick}>{c.label}</button>
              ))}
            </div>
            {pdf}
          </div>
        ) : (
          <div className="check-actions">
            <button type="button" className={card.alert ? 'tinted' : 'primary'} onClick={card.lookRight}>{CHECKS.looksRight}</button>
            {pdf ?? (card.details ? <button type="button" className="ghost" onClick={card.details}>{CHECKS.showDetails}</button> : null)}
          </div>
        )}
        {card.alert ? (
          <>
            <button type="button" id="check-later" className="ghost check-decide-later" onClick={later}>
              {CHECKS.decideLater}
            </button>
            <p ref={noteRef} className="check-serious-note">{CHECKS.seriousNote}</p>
          </>
        ) : (
          <div className="check-foot">
            <button type="button" id="check-later" className="link subtle" onClick={later}>
              {CHECKS.later}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Step 1's view (#check-view). `act.openDetails`: the All client details row; `act.showAll` /
// `act.showOne`: toggle full-list mode vs one-check focus mode.
function Checks({ act }) {
  const checks = useStore(panelStore, (s) => s.checks);
  const checksAll = useStore(panelStore, (s) => !!s.checksAll);
  const filled = useStore(panelStore, (s) => s.intake?.stats?.filled);
  const detailsOpen = useStore(panelStore, (s) => !!s.detailsOpen);
  const cards = checks?.cards ?? [];
  const openCards = cards.filter((c) => !c.done);
  const open = openCards.length;
  const focusCard = !checksAll && open > 0 ? openCards[0] : null;
  const focusAt = focusCard ? cards.indexOf(focusCard) + 1 : 1;
  const cleanup = checks?.cleanup ?? [];
  const canSeeAll = cards.length > 1 || cleanup.length > 0;
  const showAll = () => {
    flushSync(() => act.showAll?.());
    document.getElementById('one-check-mode')?.focus();
  };
  const showOne = () => {
    flushSync(() => act.showOne?.());
    (document.getElementById('see-all-checks') ?? document.querySelector('#warnings :is(input, select, textarea, button)'))?.focus();
  };
  return (
    <>
      {focusCard ? (
        <div id="warnings" className="checks checks-focus">
          <FocusCheck key={focusCard.i} card={focusCard} at={focusAt} total={cards.length} later={checks?.later} />
        </div>
      ) : (
        <>
          <div className="pane-head">
            <h2 id="check-title">{checks?.title ?? ''}</h2>
            <HelpLink topic="intake" />
            <p id="check-sub" className="pane-sub">{checks?.sub ?? ''}</p>
            {open > 0 ? (
              <button type="button" id="one-check-mode" className="link subtle one-check-link" onClick={showOne}>
                {CHECKS.oneAtATime}
              </button>
            ) : null}
          </div>
          <div id="warnings" className="checks">
            {cards.map((card) => <CheckCard key={card.i} card={card} />)}
            {cleanup.length ? (
              <details className="fold cleanup">
                <summary className="list-row">
                  <span className="grow">Cleanup notes</span>
                  <span className="small muted">{`${cleanup.length} change${cleanup.length === 1 ? '' : 's'}`}</span>
                  <span className="chev" aria-hidden="true">{'\u203a'}</span>
                </summary>
                <div className="card">{cleanup.map((msg, n) => <p key={n}>{msg}</p>)}</div>
              </details>
            ) : null}
          </div>
        </>
      )}
      <section className="tools-card" aria-label="Page and view tools">
        {focusCard && canSeeAll ? (
          <button type="button" id="see-all-checks" className="tools-pill" onClick={showAll}>
            {CHECKS.seeAll}
          </button>
        ) : null}
        <button type="button" id="details-row" className="list-row" aria-controls="details-view" aria-expanded={detailsOpen} onClick={act.openDetails}>
          <span className="grow">All client details</span>
          <span id="details-count" className="small muted">{filled == null ? '' : `${filled} answers`}</span>
          <span className="chev" aria-hidden="true">{'\u203a'}</span>
        </button>
      </section>
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

export { CheckCard, Checks, FocusCheck, Pickers, mountChecks, mountPickers };
