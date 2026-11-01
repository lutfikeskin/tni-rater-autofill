// The quote's three steps and the dock in React, drawn from what the panel says of them: the steps'
// tone, note and which one is shown (state.steps, renderSteps in coordinator.js), and the dock's one
// next thing to do and its button (state.dock, renderDock from dockFor). What their buttons do is the
// panel's (`act`, wired in sidepanel.js).
// One part of the panel; sidepanel.js mounts it (mountSteps, mountDock).
import { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';

// The intake, then the page in front: filled, then reviewed. `prefix`: the ids of its number and note.
const STEPS = [
  { id: 'check', prefix: 'check', number: '1', label: 'Intake', controls: 'check-view' },
  { id: 'fill', prefix: 'fill', number: '2', label: 'Fill page', controls: 'page-view' },
  { id: 'confirm', prefix: 'finish', number: '3', label: 'Review page', controls: 'page-view' },
];

// Each step: its bar, number (✓ once done) and note, toned by what it says ('done', 'active',
// 'warn', 'bad'); the one shown is the current step. Before the panel has said anything, as the
// page loads, each is drawn plain.
function Steps({ act }) {
  const said = useStore(panelStore, (s) => s.steps);
  return STEPS.map(({ id, prefix, number, label, controls }) => {
    const s = said?.[id] ?? {};
    return (
      <button key={id} type="button" id={`step-${id}`} className="step" aria-controls={controls} data-state={s.tone}
        aria-current={s.current ? 'step' : undefined} onClick={() => act[id]()}>
        <span className="step-bar" />
        <span className="step-line"><span id={`${prefix}-num`} className="step-num">{s.tone === 'done' ? '✓' : number}</span><span className="step-label">{label}</span></span>
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
];

// A dock button. Disabled as each word of the dock says, set on every draw: a click may disable it
// on the page until then (Looks right while it reads the page, Stop once pressed).
function DockButton({ id, className, label, shown, disabled, go, onClick }) {
  const button = useRef(null);
  useLayoutEffect(() => { if (button.current) button.current.disabled = disabled; });
  return (
    <button ref={button} type="button" id={id} className={className} hidden={!shown} data-go={go} onClick={(e) => onClick(e.currentTarget)}>{label}</button>
  );
}

// The dock: the one next thing to do, always in the same place under the panel, and its button.
// #dock[data-phase] names it, and data-report the fill it is about (the panel harness reads both).
// Hidden until the panel first says it, and while Settings is open.
function Dock({ act }) {
  const d = useStore(panelStore, (s) => s.dock);
  return (
    <div id="dock" className="dock" hidden={!d || d.hidden} data-phase={d?.phase} data-report={d?.report}>
      <div id="fill-progress" className="progress" hidden={!d?.progress}><span /></div>
      <div className="dock-body">
        <div className="dock-text">
          <span id="dock-eyebrow" className="dock-eyebrow" data-tone={d?.tone ?? ''}>{d?.eyebrow ?? ''}</span>
          <span id="dock-title" className="dock-title">{d?.title}</span>
          <span id="dock-sub" className="dock-sub" hidden={!d?.sub}>{d?.sub ?? ''}</span>
        </div>
        {DOCK_BUTTONS.map(({ id, className, text, act: does }) => {
          const shown = !!d && d.button === id;
          // The dock's Continue is a fill that replaces nothing (`go`: fillPage `continuing`).
          return <DockButton key={id} id={id} className={className} label={shown ? d.label : text} shown={shown}
            disabled={shown && (!!d.disabled || (id === 'fill' && d.busy))} go={id === 'fill' ? d?.go ?? '' : undefined}
            onClick={(button) => act[does](id === 'fill' ? d?.go ?? '' : button)} />;
        })}
        <button type="button" id="dock-alt" className="link small dock-alt" hidden={!d?.alt} data-go={d?.alt ?? ''} onClick={() => act.alt(d?.alt ?? '')}>{d?.altLabel ?? ''}</button>
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
