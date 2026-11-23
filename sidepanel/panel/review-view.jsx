// @ts-check
// Post-fill grouped Review (canvas screen 10) and All answers header (canvas screen 11).
// Draws "Needs you" (uncapped) and "Worth a look" above #feed, with "See all N answers
// (M straight from the intake)" switching to All answers and "‹ Back to summary" returning.
// Opening a row delegates through `act.openRow(rec)` so the panel's own ReportRows row opens.
// One part of the panel; sidepanel.js mounts it (mountReview).

/** @import { PanelState } from '../../types.js' */

import { createRoot } from 'react-dom/client';
import { useEffect, useId, useRef } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useStore } from 'zustand';
import { panelStore } from './state-store.js';
import { screenFor } from './screen.js';
import { reviewGroups, reviewRowHead } from './review-groups.js';
import { REVIEW, SOURCE } from './messages.js';
import { HelpLink } from './help-link.jsx';
import { AnswerBody, Note } from './report-view.jsx';

/**
 * Formats the report's human-readable page or step name from `entry.step`, `entry.page` or `entry.key`.
 * @param {Record<string, any>} entry
 * @returns {string}
 */
function pageName(entry) {
  const [, rawPage = '', unit = '', keyStep = ''] = String(entry?.key ?? '').split('|');
  const raw = String(entry?.step || keyStep || entry?.page || rawPage || '').replace(/^\/+/, '');
  if (!raw) return REVIEW.fallbackPage;
  const spaced = raw.includes(' ')
    ? raw
    : raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
  const which = /^(v|tr|d)(\d+)$/.exec(unit);
  if (!which) return spaced;
  const kind = REVIEW.unitWord[/** @type {'v' | 'tr' | 'd'} */ (which[1])];
  return `${spaced} \u00b7 ${kind} ${Number(which[2]) + 1}`;
}

/**
 * @param {{
 *   rec: Record<string, any>,
 *   group: 'needs' | 'worth' | 'rest',
 *   ctx?: Record<string, any>,
 *   rowActs?: Record<string, any>,
 *   onOpen?: (rec: Record<string, any>) => void,
 *   onToggle?: (rec: Record<string, any>) => void,
 * }} props
 */
function ReviewRow({ rec, group, ctx, rowActs, onOpen, onToggle }) {
  const bodyId = useId();
  const label = (rec.type === 'need' ? (rec.x?.label || rec.x?.name) : rec.label) || REVIEW.fallbackLabel;
  const head = reviewRowHead(rec);
  const isMarked = rec.type === 'need' && rec.settled === 'marked';
  const aiKind = rec.aiCard?.kind;
  const aiTone = group === 'needs' && aiKind !== 'error' && Boolean(rec.pending || rec.aiPick || ['picked', 'unconfirmed', 'suggest', 'rejected'].includes(aiKind));

  let sub = '';
  let shownVal = '';

  if (group === 'needs') {
    if (aiKind === 'unconfirmed') {
      sub = REVIEW.aiUnconfirmedSub;
    } else if (rec.pending || aiKind === 'picked') {
      sub = REVIEW.aiPickSub;
    } else if (aiKind === 'rejected') {
      sub = REVIEW.aiRejectedSub;
    } else if ((rec.aiPick && aiKind !== 'error') || aiKind === 'suggest') {
      sub = REVIEW.aiSuggestSub;
    } else {
      sub = rec.x?.why ?? '';
    }
    if (aiTone && aiKind !== 'rejected') {
      shownVal = rec.pending ? ((rec.settled === 'marked' ? rec.aiCard?.choice : null) || head.value || '') : (rec.aiPick || rec.aiCard?.choice || '');
    }
  } else if (isMarked) {
    shownVal = REVIEW.markedValue;
    sub = REVIEW.markedSub;
  } else {
    const isStandard = rec.kind === 'standard' || head.tag?.text === SOURCE.tag.standard.text;
    const isIntake = rec.type === 'answer' && rec.kind === 'intake' && !rec.changed;
    shownVal = head.value ?? '';
    sub = rec.changed || (isStandard || isIntake ? '' : head.tag?.text) || '';
  }

  if (group === 'worth' || group === 'rest') {
    const open = Boolean(rec.open);
    return (
      <div className={`review-item${open ? ' open' : ''}`}>
        <button
          type="button"
          className="review-row"
          data-group={group}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => (onToggle ? onToggle(rec) : onOpen?.(rec))}
        >
          <span className="review-row-main">
            <span className="review-row-label">{label}</span>
            {sub ? <span className="review-row-sub">{sub}</span> : null}
          </span>
          {shownVal ? <span className="review-row-val">{shownVal}</span> : null}
          <span className="review-chev" aria-hidden="true">{open ? '\u25be' : '\u25b8'}</span>
        </button>
        <div id={bodyId} className="review-row-body" hidden={!open}>
          {rec.type === 'answer' ? (
            <AnswerBody rec={rec} ctx={ctx} act={rowActs} />
          ) : (
            <>
              {rec.x?.why ? <p className="row-say">{rec.x.why}</p> : null}
              {rec.x?.key ? (
                <div className="row-actions">
                  <button type="button" className="ghost show-on-page" title="Scroll the carrier page to this question and flash its mark"
                    aria-label={`Show on page: ${label}`} onClick={() => rowActs?.showRow?.(rec, ctx)}>Show on page</button>
                </div>
              ) : null}
              {rec.x?.key ? <span className="need-where" hidden={!rec.where}>{rec.where ?? ''}</span> : null}
              <Note note={rec.note} />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="review-row"
      data-group={group}
      data-tone={aiTone ? 'ai' : group === 'needs' ? 'amber' : undefined}
      onClick={() => onOpen?.(rec)}
    >
      <span className="review-row-main">
        <span className="review-row-label">{label}</span>
        {sub ? <span className="review-row-sub">{sub}</span> : null}
      </span>
      {shownVal ? <span className="review-row-val">{shownVal}</span> : null}
    </button>
  );
}

/**
 * @param {{
 *   host?: HTMLElement,
 *   act?: {
 *     openRow?: (rec: Record<string, any>) => void,
 *     toggleWorth?: (rec: Record<string, any>) => void,
 *     rowActs?: Record<string, any>,
 *     showAll?: () => void,
 *     showReview?: () => void,
 *   },
 * }} [props]
 */
function Review({ act = {}, host } = {}) {
  const entry = useStore(panelStore, (/** @type {PanelState} */ s) => s.reportFor);
  const tab = useStore(panelStore, (/** @type {PanelState} */ s) => s.tab);
  const filling = useStore(panelStore, (/** @type {PanelState} */ s) => Boolean(s.filling));
  const pastOpen = useStore(panelStore, (/** @type {PanelState} */ s) => Boolean(s.feed?.pastKey || s.pastKey));
  const inAll = useStore(
    panelStore,
    (/** @type {PanelState} */ s) => Boolean(s.allAnswers && (!s.allAnswersFor || s.allAnswersFor === s.reportFor)),
  );
  const dock = useStore(panelStore, (/** @type {PanelState} */ s) => s.dock);
  const screen = useStore(panelStore, screenFor);
  // Subscribe to row redraws so settling, marking, or AI updates refresh the groups immediately.
  useStore(panelStore, (/** @type {PanelState} */ s) => `${s.reportFor?.drawn ?? 0}|${s.rowsDrawn ?? 0}|${s.rowsAll ?? 0}`);
  const focusNextRef = useRef(/** @type {string | null} */ (null));
  useEffect(() => {
    const id = focusNextRef.current;
    if (!id) return;
    focusNextRef.current = null;
    (document.getElementById(id) ?? document.getElementById('review-title'))?.focus();
  }, [inAll]);

  if (!entry || !Array.isArray(entry.list) || filling || pastOpen) return null;

  const { needs, worth, rest, intakeCount, all } = reviewGroups(entry.list);
  const focusNeed = entry.list.some((r) => r.type === 'need' && !r.gone && r.open && (!r.settled || r.pending));
  const hasStandard = worth.some((r) => !r.changed && (r.kind === 'standard' || reviewRowHead(r).tag?.text === SOURCE.tag.standard.text));
  const rowCtx = entry.ctx ?? { tabId: tab?.id ?? null, page: entry.page ?? '', carrier: tab?.carrier ?? null };
  const ownHead = !dock || screen === 'review' || screen === 'ai';
  const filled = typeof entry.filled === 'number' ? entry.filled : 0;
  // The dock's phases that leave nothing before Continue (continueSaid in coordinator.js).
  const clear = !dock || ['ready-continue', 'yours', 'finished', 'done'].includes(dock.phase);

  const showAll = () => {
    focusNextRef.current = 'back-to-review';
    act.showAll?.();
  };
  const showReview = () => {
    focusNextRef.current = 'see-all-answers';
    act.showReview?.();
  };

  if (inAll) {
    const allHead = (
      <div id="review" className="review review-all-head">
        <button type="button" id="back-to-review" className="link small review-back" onClick={showReview}>
          {REVIEW.backToReview}
        </button>
        {ownHead ? (
          <div className="pane-head">
            <h2 id="review-title" tabIndex={-1}>{REVIEW.allTitle(all.length)}</h2>
            <p id="review-lead" className="pane-sub">{REVIEW.allLead(needs.length, clear)}</p>
          </div>
        ) : null}
      </div>
    );
    const allRoot = host
      ? (host.isConnected ? host.parentElement?.querySelector('#review-all-root') : null)
      : (typeof document !== 'undefined' ? document.getElementById('review-all-root') : null);
    return allRoot ? createPortal(allHead, allRoot) : allHead;
  }

  return (
    <div id="review" className="review">
      {ownHead ? (
        <div className="pane-head">
          <HelpLink topic="page" />
          <h2 id="review-title" tabIndex={-1}>{REVIEW.title(pageName(entry))}</h2>
          <p id="review-lead" className="pane-sub">{REVIEW.lead(filled, needs.length, clear)}</p>
        </div>
      ) : null}
      {needs.length > 0 ? (
        <section className="review-group" id="review-needs" aria-labelledby="review-needs-head">
          <div className="primary-card-head">
            <h3 id="review-needs-head" className="review-group-head">{REVIEW.needsGroup}</h3>
            <span className="card-count">{needs.length}</span>
          </div>
          <div className="review-rows">
            {needs.map((rec, i) => (
              <ReviewRow key={rec.id ?? i} rec={rec} group="needs" onOpen={act.openRow} />
            ))}
          </div>
        </section>
      ) : null}
      {worth.length > 0 ? (
        <section className="review-group reference-card" id="review-worth" aria-labelledby="review-worth-head">
          <div className="reference-head">
            <h3 id="review-worth-head" className="review-group-head">{REVIEW.worthGroup}</h3>
            {hasStandard ? <span className="reference-badge">{SOURCE.tag.standard.text}</span> : null}
          </div>
          <div className="review-rows">
            {worth.map((rec, i) => (
              <ReviewRow
                key={rec.id ?? i}
                rec={rec}
                group="worth"
                ctx={rowCtx}
                rowActs={act.rowActs}
                onOpen={act.openRow}
                onToggle={act.toggleWorth}
              />
            ))}
          </div>
        </section>
      ) : null}
      {rest.length > 0 ? (
        <section className="review-group reference-card" id="review-answers" aria-labelledby="review-answers-head">
          <div className="reference-head">
            <h3 id="review-answers-head" className="review-group-head">{worth.length > 0 ? REVIEW.restGroup : REVIEW.answersGroup}</h3>
            <span className="reference-count">{rest.length}</span>
          </div>
          <div className="review-rows">
            {rest.map((rec, i) => (
              <ReviewRow
                key={rec.id ?? i}
                rec={rec}
                group="rest"
                ctx={rowCtx}
                rowActs={act.rowActs}
                onOpen={act.openRow}
                onToggle={act.toggleWorth}
              />
            ))}
          </div>
        </section>
      ) : null}
      {focusNeed && all.length > 0 ? (
        <div className="review-tools">
          <button type="button" id="see-all-answers" className="link review-see-all" onClick={showAll}>
            {REVIEW.seeAll(all.length, intakeCount)}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Mounts Review into `host` synchronously.
 * @param {HTMLElement} host
 * @param {{
 *   openRow?: (rec: Record<string, any>) => void,
 *   toggleWorth?: (rec: Record<string, any>) => void,
 *   rowActs?: Record<string, any>,
 *   showAll?: () => void,
 *   showReview?: () => void,
 * }} [act]
 */
/** @type {{ root: import('react-dom/client').Root, host: HTMLElement } | null} */
let mountedReview = null;
function mountReview(host, act) {
  if (mountedReview && (!mountedReview.host.isConnected || mountedReview.host === host)) {
    mountedReview.root.unmount();
  }
  const root = createRoot(host);
  mountedReview = { root, host };
  flushSync(() => root.render(<Review act={act} host={host} />));
}

export { Review, mountReview };
