// @ts-check
// The canvas screen head (#screen-head) at the top of the panel's middle (#view): the one next
// thing to do, moved out of the bottom dock so the dock holds only its button, alternative,
// progress bar and short status note. Also keeps the footer's top hairline on only while #view has
// content clipped below its scroll fold (.foot.line).
// One part of the panel; sidepanel.js mounts it (mountScreen).

/** @import { DockSnapshot, PanelScreen, PanelState } from '../../types.js' */

import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { screenFor } from './screen.js';
import { SCREEN } from './messages.js';

// Screens whose own view already draws its header (Intake checks and Settings).
/** @type {Set<string>} */
const OWN_HEAD_SCREENS = new Set(['check', 'settings']);

/**
 * Whether the shared screen head is shown for `s`: on Home and every page-view screen, and hidden
 * on Intake checks, Settings, or while a sheet or drawer covers the panel.
 * @param {PanelState} s
 * @returns {boolean}
 */
function headShown(s) {
  if (s.pdf || s.detailsOpen || s.summary) return false;
  return !OWN_HEAD_SCREENS.has(screenFor(s));
}

/**
 * What the screen head says for `screen`, from `state.dock` and `SCREEN` (messages.js).
 * @param {PanelScreen} screen
 * @param {DockSnapshot | null | undefined} d
 * @param {{ filled?: number } | null | undefined} fillingFor
 */
function screenSaid(screen, d, fillingFor) {
  if (screen === 'start') return { ...SCREEN.start, tone: '' };
  if (screen === 'filling' && d?.tone !== 'warn' && d?.eyebrow !== 'Stopping') {
    const filled = fillingFor?.filled
      ?? (typeof d?.eyebrow === 'string' ? Number(d.eyebrow.match(/(\d+)\s+in\b/)?.[1] ?? 0) : 0);
    const title = filled > 0 ? SCREEN.filling.count(filled) : (d?.title || SCREEN.filling.starting);
    const sub = filled > 0 && d?.title
      ? [d.title.replace(/\.$/, ''), d.sub].filter(Boolean).join('. ')
      : (d?.sub ?? '');
    return { eyebrow: SCREEN.filling.eyebrow, title, sub, tone: d?.tone || 'blue' };
  }
  return {
    eyebrow: d?.eyebrow ?? '',
    title: d?.title ?? '',
    sub: d?.sub ?? '',
    tone: d?.tone ?? '',
  };
}

function Screen() {
  const screen = useStore(panelStore, screenFor);
  const shown = useStore(panelStore, headShown);
  const d = useStore(panelStore, (s) => s.dock);
  const fillingFor = useStore(panelStore, (s) => s.fillingFor);
  const { eyebrow, title, sub, tone } = screenSaid(screen, d, fillingFor);
  /** @type {import('react').RefObject<HTMLHeadingElement | null>} */
  const titleRef = useRef(null);
  const prevScreen = useRef(screen);

  // Move focus to the new screen's title when the screen itself changes, unless Dock kept focus on
  // a dock button (UX-08), the agent is in a field or dialog, or Settings just closed (its close
  // gives focus back to #settings-btn). Live-fill count ticks keep `screen` at 'filling'.
  useEffect(() => {
    const prev = prevScreen.current;
    prevScreen.current = screen;
    if (prev === screen || !shown || prev === 'settings') return;
    const active = document.activeElement;
    if (document.getElementById('dock')?.contains(active)) return;
    if (active && active !== document.body && active.matches?.('input, select, textarea, [contenteditable="true"]')) return;
    if (active?.closest?.('[role="dialog"]')) return;
    titleRef.current?.focus({ preventScroll: true });
  }, [screen, shown]);

  // Show the footer's top border (.foot.line) only while #view has content clipped below the fold.
  useEffect(() => {
    const view = document.getElementById('view');
    const foot = document.querySelector('footer.foot');
    if (!view || !foot) return undefined;
    const sync = () => {
      const clipped = view.scrollHeight > view.clientHeight + 1
        && view.scrollTop + view.clientHeight < view.scrollHeight - 1;
      foot.classList.toggle('line', clipped);
    };
    sync();
    view.addEventListener('scroll', sync, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
    ro?.observe(view);
    for (const child of view.children) ro?.observe(child);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null;
    mo?.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    return () => {
      view.removeEventListener('scroll', sync);
      ro?.disconnect();
      mo?.disconnect();
      foot.classList.remove('line');
    };
  }, []);

  return (
    <>
      <header id="screen-head" className="screen-head" hidden={!shown} data-screen={screen}>
        <span id="screen-eyebrow" className="screen-eyebrow" data-tone={tone || undefined} hidden={!eyebrow}>{eyebrow}</span>
        {shown ? <h1 id="screen-title" ref={titleRef} tabIndex={-1}>{title}</h1> : null}
        <p id="screen-lead" className="screen-lead" hidden={!sub}>{sub}</p>
      </header>
      {!shown ? <h1 className="sr-only">TNI Rater Autofill</h1> : null}
    </>
  );
}

/**
 * Draws the screen head into #screen-root before returning, so initial layout and focus find it.
 * @param {HTMLElement} host
 */
function mountScreen(host) {
  const root = createRoot(host);
  flushSync(() => root.render(<Screen />));
}

export { Screen, headShown, mountScreen };
