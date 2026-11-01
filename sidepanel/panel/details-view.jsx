// All client details in React: every answer on the intake, to read or correct, one section each
// (it folds), in a drawer from the right over the panel. Fields the intake leaves blank are hidden
// unless flagged or the agent's own, behind the button in its head. Drawn from what renderSections
// says (state.details); what its buttons do is the panel's (`act`, wired in sidepanel.js).
// One part of the panel; sidepanel.js mounts it (mountDetails).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// A field's box (fieldSaid in record.js). Its edit is made as the box's own change event says it: a
// text box's when the agent leaves it or presses Enter, not each key. The record's value is shown
// again when it changes (a derived value following an edit, a check card's edit) in the same box, so
// the agent's focus and what they are typing elsewhere stay.
function FieldBox({ field }) {
  const ref = useRef(null);
  const { id, control, value, options, edit, maxLength } = field;
  useEffect(() => {
    const box = ref.current;
    const changed = () => edit(box.value);
    box.addEventListener('change', changed);
    return () => box.removeEventListener('change', changed);
  }, [edit]);
  useLayoutEffect(() => {
    if (ref.current.value !== value) ref.current.value = value;
  }, [value]);
  if (control === 'select') {
    return <select ref={ref} id={id} defaultValue={value}>{options.map(([v, text], n) => <option key={n} value={v}>{text}</option>)}</select>;
  }
  if (control === 'textarea') return <textarea ref={ref} id={id} rows={4} defaultValue={value} />;
  return <input ref={ref} id={id} type="text" placeholder="not on form" maxLength={maxLength} defaultValue={value} />;
}

// One section: its title, how many of its fields a check flags and how many it hides; then its
// fields, under each item's title for a list (Vehicle 1, Vehicle 2…). `fold(id, open)` keeps it
// folded or open when the drawer is said again.
function Section({ section, fold }) {
  return (
    <details className={`section${section.allEmpty ? ' all-empty' : ''}`} open={section.open} data-id={section.id} aria-label={section.title}
      onToggle={(e) => fold(section.id, e.currentTarget.open)}>
      <summary className="section-title">
        <span className="title">{section.title}</span>
        {section.flags ? <span className="flag">{`${section.flags} to check`}</span> : null}
        {section.hiddenSaid ? <span className="hidden-count">{section.hiddenSaid}</span> : null}
      </summary>
      <div className="section-body">
        {section.rows.map((row, n) => (row.path
          ? (
            <div key={row.path} className={`field${row.flagged ? ' flagged' : ''}${row.empty ? ' empty' : ''}`} data-path={row.path}>
              <label htmlFor={row.id}>{row.label}</label>
              <FieldBox field={row} />
            </div>
          )
          : <p key={`item-${n}`} className="item-title">{row.item}</p>))}
      </div>
    </details>
  );
}

// The drawer's scrim and panel (#details-view shows or hides it: showScreen). `act`: close, showEmpty.
function Details({ act }) {
  const details = useStore(panelStore, (s) => s.details);
  const showEmpty = !!details?.showEmpty;
  return (
    <>
      <div id="details-scrim" className="drawer-scrim" onClick={() => act.close()} />
      <section className="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="details-title" aria-describedby="details-sub" data-empty={showEmpty ? 'shown' : 'hidden'}>
        <div className="sheet-head">
          <div className="grow"><h2 id="details-title">Client details</h2><p id="details-sub" className="sheet-sub">Your edits are what gets filled.</p></div>
          {/* Fields the intake leaves blank are hidden unless flagged, to keep the list short (showEmpty). */}
          <button type="button" id="details-empty" className="link small subtle" aria-pressed={showEmpty} hidden={!details?.toggle} onClick={() => act.showEmpty()}>{details?.toggle ?? ''}</button>
          <button type="button" id="details-close" className="icon-btn" aria-label="Close client details" onClick={() => act.close()}><svg aria-hidden="true"><use href="#close" /></svg></button>
        </div>
        <div id="sections" className="drawer-body">
          {(details?.sections ?? []).map((section) => <Section key={section.id} section={section} fold={details.fold} />)}
        </div>
      </section>
    </>
  );
}

// Draws client details into #details-view, before it returns.
function mountDetails(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Details act={act} />));
}

export { Details, mountDetails };
