// The panel's two tabs (Intake, This page) and the dock in React, drawn from what the panel says of
// them: the tabs' tone, note and which one is shown (state.steps, renderSteps in coordinator.js), and the dock's one
// next thing to do and its button (state.dock, renderDock from dockFor). What their buttons do is the
// panel's (`act`, wired in sidepanel.js).
// One part of the panel; sidepanel.js mounts it (mountSteps, mountDock).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// Two tabs: the intake, and the page in front (its fill, then what is left on it for the agent).
// Not a wizard: the page tab is one view, and the header's "Stage n of m" is the quote's place (audit
// 2026-11-07, UX-04: three numbered steps, two of them the same view, beside the header's "Step n
// of m"). `prefix`: the id of its note (#check-summary, #fill-summary: the harnesses read them).
const TABS = [
  { id: 'check', prefix: 'check', label: 'Intake', controls: 'check-view' },
  { id: 'fill', prefix: 'fill', label: 'This page', controls: 'page-view' },
];

// Each tab: its bar, name and note, toned by what it says ('done', 'active', 'warn', 'bad'); the
// one shown is marked current. Before the panel has said anything, as the page loads, each is drawn
// plain. The page tab, once its page is filled (`review`), asks the panel to read the page again
// (act.confirm); before, it only shows the page (act.fill).
function Steps({ act }) {
  const said = useStore(panelStore, (s) => s.steps);
  return TABS.map(({ id, prefix, label, controls }) => {
    const s = said?.[id] ?? {};
    return (
      <button key={id} type="button" id={`step-${id}`} className="step" aria-controls={controls} data-state={s.tone}
        aria-current={s.current ? 'true' : undefined} onClick={() => act[s.review ? 'confirm' : id]()}>
        <span className="step-bar" />
        <span className="step-line"><span className="step-label">{label}</span></span>
        <span id={`${prefix}-summary`} className="step-note">{s.note ?? ''}</span>
      </button>
    );
  });
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
// Hidden until the panel first says it, and while Settings is open.
// Keyboard focus stays in the dock as its button changes (audit 2026-11-07, UX-08: Fill this page
// hid as Stop showed, and focus fell to the page, at the moment Stop mattered most): when the button
// that had it is hidden, or disabled, the button shown now takes it (its alternative when it has
// none). Only when focus was in the dock: the dock never takes it from elsewhere.
function Dock({ act }) {
  const d = useStore(panelStore, (s) => s.dock);
  const dock = useRef(null);
  const focused = useRef(false);
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
      <div id="fill-progress" className="progress" hidden={!d?.progress}><span /></div>
      <div className="dock-body">
        <div className="dock-text">
          <span id="dock-eyebrow" className="dock-eyebrow" data-tone={d?.tone ?? ''}>{d?.eyebrow ?? ''}</span>
          <span id="dock-title" className="dock-title">{d?.title}</span>
          <span id="dock-sub" className="dock-sub" hidden={!d?.sub}>{d?.sub ?? ''}</span>
          {/* Automatic filling paused on this tab (renderDock's `paused`). */}
          <span id="dock-paused" className="dock-paused" role="status" hidden={!d?.paused}>{d?.paused ?? ''}</span>
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
