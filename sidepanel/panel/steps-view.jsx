// The two view tabs in #steps and the dock in React, drawn from what the panel says of
// them: each tab's tone and note and which view is shown (state.steps, renderSteps in
// coordinator.js), and the dock's one next thing to do and its button (state.dock, renderDock from
// dockFor; #dock-eyebrow and #dock-title stay in the DOM with aria-hidden while #screen-head is
// shown, and lift sr-only when #screen-title scrolls out of #view).
// What their buttons do is the panel's (`act`, wired in sidepanel.js).
// One part of the panel; sidepanel.js mounts it (mountSteps, mountDock).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { useAnnounce } from './announce.js';
import { CHECKS } from './messages.js';
import { handleRovingKey } from './roving-focus.js';
import { headShown } from './screen-view.jsx';

// Both tabs always show in #steps (role="tablist"): #step-check ("Intake checks", its note
// #check-summary "N to check" in amber while checks are open) and #step-fill ("This page", its note
// #fill-summary); the tab in view wears aria-selected="true" and takes Tab (roving tabindex with
// ArrowLeft/ArrowRight/Home/End). Once the page is filled (`review`), #step-fill asks the panel to
// read the page again (act.confirm); before, it only shows the page (act.fill).
function Steps({ act }) {
  const said = useStore(panelStore, (s) => s.steps);
  const checksOpen = useStore(panelStore, (s) => s.checks?.open);
  const c = said?.check ?? {};
  const f = said?.fill ?? {};
  const onCheck = !!c.current;
  const open = checksOpen ?? c.open ?? 0;
  const activeId = onCheck ? 'step-check' : 'step-fill';
  const [focusedId, setFocusedId] = useState(/** @type {string | null} */ (null));
  useEffect(() => { setFocusedId(null); }, [activeId]);
  const stopId = focusedId ?? activeId;
  const onKeyDown = (e) => handleRovingKey(e, e.currentTarget.parentElement, '[role="tab"]', {
    wrap: true,
    onMove: (el) => setFocusedId(el.id),
  });
  const onBlur = (e) => {
    if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setFocusedId(null);
  };
  // Two tabs, both always shown, the one in view joined to the view under it (as a browser's tab).
  // The intake's note counts what is left to check as the checks say it now.
  return (
    <>
      <button type="button" id="step-check" className="step" role="tab" aria-controls="check-view" data-state={c.tone}
        aria-selected={onCheck ? 'true' : 'false'} tabIndex={stopId === 'step-check' ? 0 : -1}
        onKeyDown={onKeyDown} onBlur={onBlur} onFocus={() => setFocusedId('step-check')} onClick={() => act.check()}>
        <span className="step-label">{CHECKS.stepAll}</span>
        <span id="check-summary" className="step-note">{open > 0 ? CHECKS.stepLeft(open) : (c.note ?? '')}</span>
      </button>
      <button type="button" id="step-fill" className="step" role="tab" aria-controls="page-view" data-state={f.tone}
        aria-selected={onCheck ? 'false' : 'true'} tabIndex={stopId === 'step-fill' ? 0 : -1}
        onKeyDown={onKeyDown} onBlur={onBlur} onFocus={() => setFocusedId('step-fill')} onClick={() => act[f.review ? 'confirm' : 'fill']()}>
        <span className="step-label">{CHECKS.stepBack}</span>
        <span id="fill-summary" className="step-note">{f.note ?? ''}</span>
      </button>
    </>
  );
}

// The dock's buttons: the one dockFor names shows (`button`), the others stay hidden, as the page
// has them. `act` names what the panel does on a click.
const DOCK_BUTTONS = [
  { id: 'fill', className: 'primary big', text: 'Fill this page', act: 'fill' },
  { id: 'fill-stop', className: 'stop big', text: 'Stop', act: 'stop' },
  { id: 'dock-next', className: 'primary big', text: 'Show the next one', act: 'next' },
  { id: 'look-right', className: 'primary big', text: 'Looks right, continue', act: 'lookRight' },
  { id: 'ai-approve', className: 'primary big ai', text: '', act: 'approve' },
  // agent defaults: opens the quote's question (the page's answers) from the intake's checks.
  { id: 'dock-defaults', className: 'primary big', text: 'Show the question', act: 'defaults' },
  // The quote done: its summary, read only (summary-view.jsx).
  { id: 'dock-summary', className: 'primary big', text: 'Quote summary', act: 'summary' },
];

// A dock button. Disabled as each word of the dock says, set on every draw: a click may disable it
// on the page until then (Looks right while it reads the page, Stop once pressed). `why`: what it
// waits for, said on hover while it is held.
function DockButton({ id, className, label, shown, disabled, why, go, onClick }) {
  const button = useRef(null);
  useLayoutEffect(() => { if (button.current) button.current.disabled = disabled; });
  return (
    <button ref={button} type="button" id={id} className={className} hidden={!shown} data-go={go} title={why || undefined} onClick={(e) => onClick(e.currentTarget)}>{label}</button>
  );
}

// Focus the browser takes away itself, from a button that was disabled or hidden (Stop once
// pressed), not focus the agent moved elsewhere.
const lostBy = (el) => !!el && (el.disabled || el.hidden);
// While answers go in (`busy`: a quiet automatic fill too, before it is said as one), every dock
// button but Stop waits, and says why (audit 2026-11-07, FLOW-05: they did nothing, silently).
const BUSY = 'Wait for the answers going in to finish.';

// The dock: the one next thing to do, always in the same place under the panel, and its button.
// #dock[data-phase] names it, and data-report the fill it is about (the panel harness reads both).
// Hidden until the panel first says it, and while Settings is open (unless Stop shows).
// While #screen-head is shown (`headOn`), #dock-eyebrow and #dock-title stay `aria-hidden` so the
// title appears once in the accessibility tree, and drop `sr-only` (with #dock-sub shown as
// `aria-hidden`) only when #screen-title scrolls out of #view (#dock[data-head-out]); on check,
// review and ai (`!headOn`), they show in the dock exposed to assistive tech.
// Keyboard focus stays in the dock as its button changes (audit 2026-11-07, UX-08: Fill this page
// hid as Stop showed, and focus fell to the page, at the moment Stop mattered most): when the button
// that had it is hidden, or disabled, the button shown now takes it (its alternative when it has
// none). Only when focus was in the dock: the dock never takes it from elsewhere.
function Dock({ act }) {
  const d = useStore(panelStore, (s) => s.dock);
  const headOn = useStore(panelStore, headShown);
  const [headOut, setHeadOut] = useState(false);
  const dock = useRef(null);
  const focused = useRef(false);
  const pausedLine = useRef(null);
  useAnnounce(d?.paused, pausedLine);
  useLayoutEffect(() => {
    const root = dock.current;
    if (!root) return undefined;
    const sync = () => setHeadOut(root.hasAttribute('data-head-out'));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ['data-head-out'] });
    return () => mo.disconnect();
  }, []);
  const inHead = headOn && !headOut;
  // Focus that went anywhere outside the dock (the agent's, after the browser dropped it from Stop
  // once pressed) is no longer the dock's (review of #390).
  useEffect(() => {
    const away = (e) => { if (!dock.current?.contains(e.target)) focused.current = false; };
    document.addEventListener('focusin', away);
    return () => document.removeEventListener('focusin', away);
  }, []);
  useLayoutEffect(() => {
    const root = dock.current;
    if (!root || !focused.current || root.hidden) return;
    const usable = (el) => !!el && root.contains(el) && !el.hidden && !el.disabled;
    if (usable(document.activeElement)) return;
    const next = [d?.button ? root.querySelector(`#${d.button}`) : null, root.querySelector('#dock-alt')].find(usable);
    next?.focus();
  });
  return (
    <div id="dock" ref={dock} className="dock" hidden={!d || d.hidden} data-phase={d?.phase} data-report={d?.report}
      onFocus={() => { focused.current = true; }} onBlur={(e) => { if (!dock.current?.contains(e.relatedTarget) && !lostBy(e.target)) focused.current = false; }}>
      {typeof d?.progress === 'number'
        ? <div id="fill-progress" className="progress measured" role="progressbar" aria-label={d.progressSaid} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(d.progress * 100)} title={d.progressSaid}><span style={{ width: `${Math.round(d.progress * 100)}%` }} /></div>
        : <div id="fill-progress" className="progress" hidden={!d?.progress}><span /></div>}
      <div className="dock-body">
        <div className="dock-text">
          <span id="dock-eyebrow" className={`dock-eyebrow${inHead ? ' sr-only' : ''}`} aria-hidden={headOn ? 'true' : undefined} data-tone={d?.tone ?? ''}>{d?.eyebrow ?? ''}</span>
          <span id="dock-title" className={`dock-title${inHead ? ' sr-only' : ''}`} aria-hidden={headOn ? 'true' : undefined}>{d?.title}</span>
          <span id="dock-sub" className="dock-sub" hidden={!d?.sub || inHead} aria-hidden={headOn && headOut ? 'true' : undefined}>{d?.sub ?? ''}</span>
          {/* Automatic filling paused on this tab (renderDock's `paused`). */}
          <span id="dock-paused" ref={pausedLine} className="dock-paused" hidden={!d?.paused}>{d?.paused ?? ''}</span>
        </div>
        {DOCK_BUTTONS.map(({ id, className, text, act: does }) => {
          const shown = !!d && d.button === id;
          // The dock's Continue is a fill that replaces nothing (`go`: fillPage `continuing`).
          const held = shown && id !== 'fill-stop' && !!d.busy;
          return <DockButton key={id} id={id} className={className} label={shown ? d.label : text} shown={shown}
            disabled={shown && (!!d.disabled || held)} why={held ? BUSY : ''} go={id === 'fill' ? d?.go ?? '' : undefined}
            onClick={(button) => act[does](id === 'fill' ? d?.go ?? '' : button)} />;
        })}
        <button type="button" id="dock-alt" className="link small dock-alt" hidden={!d?.alt} disabled={!!d?.busy} title={d?.busy ? BUSY : undefined} data-go={d?.alt ?? ''} onClick={() => act.alt(d?.alt ?? '')}>{d?.altLabel ?? ''}</button>
      </div>
    </div>
  );
}

// Draws the steps into their nav (#steps) and the dock into its place in the footer (#dock-root),
// before each returns, so the panel's wiring and focus find them.
function mountSteps(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Steps act={act} />));
}
function mountDock(host, act) {
  const root = createRoot(host);
  flushSync(() => root.render(<Dock act={act} />));
}

export { Dock, Steps, mountDock, mountSteps };
