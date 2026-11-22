// @ts-check
// The canvas screen head (#screen-head) at the top of the panel's middle (#view): the one next
// thing to do on the 17 screens without their own heading, while the dock keeps #dock-eyebrow and
// #dock-title aria-hidden whenever #screen-head is shown and reveals them visually when
// #screen-title scrolls out of #view (#dock[data-head-out]).
// One part of the panel; sidepanel.js mounts it (mountScreen).

/** @import { DockSnapshot, PanelScreen, PanelState } from '../../types.js' */

import { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { screenFor } from './screen.js';
import { FILLING, SCREEN } from './messages.js';
import { HelpLink } from './help-link.jsx';

// Screens where the view or the dock carries the heading: Intake checks, Settings, post-fill
// review, and AI review (Phase 4 decision e).
/** @type {Set<string>} */
const OWN_HEAD_SCREENS = new Set(['check', 'settings', 'review', 'ai']);

/**
 * Whether the shared screen head is shown for `s`: on Home and the 16 non-review page screens, and
 * hidden on `check`, `settings`, `review`, `ai`, or while a sheet or drawer covers the panel.
 * @param {PanelState} s
 * @returns {boolean}
 */
function headShown(s) {
  if (s.pdf || s.detailsOpen || s.summary) return false;
  return !OWN_HEAD_SCREENS.has(screenFor(s));
}

/**
 * What the screen head says for `screen`, from `state.dock`, `state.fillingFor` and `SCREEN` (messages.js).
 * @param {PanelScreen} screen
 * @param {DockSnapshot | null | undefined} d
 * @param {{ filled?: number } | null | undefined} fillingFor
 */
function screenSaid(screen, d, fillingFor) {
  if (screen === 'start') return { ...SCREEN.start, tone: '' };
  if (screen === 'filling' && d?.tone !== 'warn' && d?.eyebrow !== FILLING.stoppingEyebrow) {
    const filled = typeof fillingFor?.filled === 'number' ? fillingFor.filled : 0;
    const title = filled > 0 ? SCREEN.filling.count(filled) : (d?.title || SCREEN.filling.starting);
    return { eyebrow: SCREEN.filling.eyebrow, title, sub: d?.sub ?? '', tone: d?.tone || 'blue' };
  }
  return {
    eyebrow: d?.eyebrow ?? '',
    title: d?.title ?? '',
    sub: d?.sub ?? '',
    tone: d?.tone ?? '',
  };
}

/**
 * Quote done's facts, in the summary sheet's terms: answers in, left for the agent, marked done
 * without an answer (its own line, never counted as answered) and the agent's changes.
 * @param {{ answers: number, open: number, marked: unknown[], overrides: unknown[] } | null | undefined} s
 * @returns {Array<[string, string, number]>}
 */
function doneFacts(s) {
  if (!s) return [];
  const w = SCREEN.doneFacts;
  return [['answers', w.answers, s.answers], ['open', w.open, s.open], ['marked', w.marked, s.marked.length], ['overrides', w.overrides, s.overrides.length]];
}

/**
 * @typedef {{ answers: number, open: number, marked: unknown[], overrides: unknown[] }} DoneCounts
 * @param {{ scrollBehavior?: () => ScrollBehavior, summary?: () => DoneCounts | null }} [props]
 */
function Screen({ scrollBehavior, summary } = {}) {
  const screen = useStore(panelStore, screenFor);
  const shown = useStore(panelStore, headShown);
  const d = useStore(panelStore, (s) => s.dock);
  const fillingFor = useStore(panelStore, (s) => s.fillingFor);
  const hasOwnerCard = useStore(panelStore, (/** @type {PanelState} */ s) => Boolean(s.cards?.owner));
  const { eyebrow, title, sub, tone } = screenSaid(screen, d, fillingFor);
  // Read once each time the dock is drawn on Quote done, not on every store change.
  const facts = useMemo(() => (screen === 'finished' && summary ? doneFacts(summary()) : []), [screen, d, summary]);
  /** @type {import('react').RefObject<HTMLHeadingElement | null>} */
  const titleRef = useRef(null);
  const prevScreen = useRef(screen);

  // Move focus to the new screen's title when the screen itself changes and keyboard focus is
  // already inside the panel (never stealing from the rater page or document.body), unless Dock
  // kept focus on a dock button (UX-08), the agent is in a field or dialog, or Settings just closed
  // (its close gives focus back to #settings-btn). Live-fill count ticks keep `screen` at 'filling'.
  useEffect(() => {
    const prev = prevScreen.current;
    prevScreen.current = screen;
    if (prev === screen || !shown || prev === 'settings') return;
    if (!document.hasFocus()) return;
    const active = document.activeElement;
    if (!active || active === document.body) return;
    if (document.getElementById('dock')?.contains(active)) return;
    if (active.matches?.('input, select, textarea, [contenteditable="true"]')) return;
    if (active.closest?.('[role="dialog"]')) return;
    const h = titleRef.current;
    if (!h) return;
    h.focus({ preventScroll: true });
    h.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior ? scrollBehavior() : 'auto' });
  }, [screen, shown, scrollBehavior]);

  // When #view clips #screen-title out of full view, mark #dock[data-head-out] so the dock
  // surfaces #dock-eyebrow, #dock-title and #dock-sub visually until #screen-title returns.
  useEffect(() => {
    const heading = titleRef.current;
    if (!shown || !heading || screen === 'owner') {
      document.getElementById('dock')?.removeAttribute('data-head-out');
      return undefined;
    }
    if (typeof IntersectionObserver !== 'function') return undefined;
    const root = heading.closest('#view') ?? null;
    const io = new IntersectionObserver(([entry]) => {
      const targetDock = document.getElementById('dock');
      if (!targetDock || !entry) return;
      const out = !entry.isIntersecting || (typeof entry.intersectionRatio === 'number' && entry.intersectionRatio < 1);
      if (out) targetDock.setAttribute('data-head-out', '');
      else targetDock.removeAttribute('data-head-out');
    }, { root, threshold: 1 });
    io.observe(heading);
    return () => {
      io.disconnect();
      document.getElementById('dock')?.removeAttribute('data-head-out');
    };
  }, [shown, screen]);

  return (
    <div id="screen-head" className="screen-head" hidden={!shown} data-screen={screen}>
      {screen === 'owner' && hasOwnerCard ? null : <HelpLink topic={screen === 'start' ? 'home' : 'page'} />}
      <span id="screen-eyebrow" className="screen-eyebrow" data-tone={tone || undefined} hidden={!eyebrow}>{eyebrow}</span>
      <h2 id="screen-title" ref={titleRef} tabIndex={-1}>{title}</h2>
      <p id="screen-lead" className="screen-lead" hidden={!sub}>{sub}</p>
      {facts.length ? (
        <dl id="done-facts" className="done-facts">
          {facts.map(([key, label, n]) => (
            <div key={key} className="done-fact" data-fact={key} data-zero={n === 0 ? '' : undefined}>
              <dt>{label}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * Draws the screen head into #screen-root before returning, so initial layout and focus find it.
 * `summary` is the quote summary as the panel has it (quote-summary.js summaryNow), for Quote done.
 * @param {HTMLElement} host
 * @param {{ scrollBehavior?: () => ScrollBehavior, summary?: () => DoneCounts | null }} [opts]
 */
function mountScreen(host, { scrollBehavior, summary } = {}) {
  const root = createRoot(host);
  flushSync(() => root.render(<Screen scrollBehavior={scrollBehavior} summary={summary} />));
}

export { Screen, doneFacts, headShown, mountScreen };
