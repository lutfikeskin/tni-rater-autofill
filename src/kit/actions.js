// @ts-check
// Advance button and carrier helper discovery, safety restrictions, and cross-world press event dispatching.

import { drawnParent, deepQueryAll, buttonText, hostDisabled } from './dom.js';
import { closestOwn, withAdapter } from './adapter.js';
import { BANNER_ID } from './marks.js';
import { kitTrace, isTracing } from './trace.js';
import { NEVER_ADVANCE, NEVER_CLICK } from '../restricted.js';

// The commit words a button never has when the fill clicks it: one list, src/restricted.js.
export { NEVER_ADVANCE, NEVER_CLICK };
export const COVERED = 'something on the page is open over Continue: close it, then fill again';
export const COVERED_HELPER = 'something on the page is open over it';

export const CLOSED_SECTIONS = {
  cargoClosed: { tag: 'cargo', words: /motor truck cargo[^\n]*(?:\n[^\n]*){0,2}/i },
  glClosed: { tag: 'gl', anyLimit: true },
  interchangeClosed: { tag: 'interchange', anyLimit: true },
};

/**
 * Checks whether something modal or floating covers element el at its center.
 * @param {Element} el
 * @returns {Element | null}
 */
export function coveredBy(el) {
  const drawnIn = (node, outer) => {
    for (let n = node; n; n = drawnParent(n)) if (n === outer) return true;
    return false;
  };
  const look = () => {
    const r = el.getBoundingClientRect?.();
    if (!r?.width || !r.height) return null;
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return 'off';
    const root = el.getRootNode?.();
    const top = (root && 'elementFromPoint' in root ? /** @type {Document} */ (root) : document).elementFromPoint?.(x, y);
    return !top || drawnIn(top, el) || drawnIn(el, top) || top.closest?.(`#${BANNER_ID}`) ? null : top;
  };
  if (!look()) return null;
  el.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' });
  const cover = look();
  return cover === 'off' ? null : /** @type {Element | null} */ (cover);
}

/**
 * Dispatches a button press event either via page-world bridge or directly.
 * @param {Element} el
 * @param {{ late?: (() => void) | null, kit?: boolean }} [options]
 * @returns {'page' | 'kit'}
 */
export function pressButton(el, { late = null, kit = false } = {}) {
  let taken = false;
  if (!kit) {
    try { taken = !el.dispatchEvent(new CustomEvent('rater-press', { bubbles: true, composed: true, cancelable: true })); } catch { /* no CustomEvent */ }
  }
  if (isTracing()) kitTrace('press', { button: { text: buttonText(el).slice(0, 60) }, how: taken ? 'page' : 'kit' });
  if (!taken) {
    /** @type {HTMLElement} */ (el).click();
    return 'kit';
  }
  if (late) el.addEventListener('rater-pressed-late', late, { once: true });
  return 'page';
}

/**
 * Determines whether element el or any drawn parent matches selector.
 * @param {Element} el
 * @param {string} selector
 * @returns {boolean}
 */
export const insideOf = (el, selector) => {
  for (let n = el; n; n = drawnParent(n)) if (n.matches?.(selector)) return true;
  return false;
};

/**
 * Finds the best Continue / Next advance button matching pattern.
 * @param {string} pattern
 * @param {{ notWithin?: string | null }} [options]
 * @returns {Element | null}
 */
export function findAdvanceButton(pattern, { notWithin = null } = {}) {
  const re = new RegExp(pattern, 'i');
  let best = null;
  for (const el of deepQueryAll(document, withAdapter('a, button, [role=button], input[type=button], input[type=submit]', 'buttons'))) {
    if (!el.getClientRects().length || /** @type {HTMLButtonElement} */ (el).disabled || el.getAttribute('aria-disabled') === 'true' || el.closest(withAdapter('[aria-disabled="true"]', 'disabled')) || hostDisabled(el) || closestOwn(el, 'stepLinks')) continue;
    if (notWithin && insideOf(el, notWithin)) continue;
    const text = buttonText(el);
    // Its words ("Save & Continue" read as Continue) and its aria-label and title, as for a helper.
    const committing = NEVER_ADVANCE.test(namesOf(el, text.replace(/^save\s*(?:&|and)\s*continue$/i, 'continue')));
    if (text.length > 40 || committing || !re.test(text)) continue;
    if (!best || best.contains(el)) best = el;
  }
  return best;
}

/**
 * A button's words and the name an icon button has instead (aria-label, title), checked against the
 * commit words: a button found by its `token` (id, href, onclick, data-*), or an advance whose words
 * read as Continue, is held to them too (audit 2026-11-07, CARR-13).
 * @param {Element} el
 * @param {string} text its words
 * @returns {string}
 */
function namesOf(el, text) {
  return [text, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ');
}

/**
 * Checks whether el is in a section mentioning near with no other such button.
 * @param {Element} el
 * @param {string} near
 * @param {RegExp | null} re
 * @returns {boolean}
 */
export function isNear(el, near, re) {
  const want = near.toLowerCase();
  for (let p = el.parentElement, i = 0; p && i < 10; p = p.parentElement, i++) {
    if (!p.textContent?.toLowerCase().includes(want)) continue;
    const alike = [...p.querySelectorAll(withAdapter('a, button, [role=button], [onclick]', 'buttons'))].filter((b) => re && re.test(buttonText(b)));
    return alike.filter((b) => !b.contains(el) && !el.contains(b)).length === 0;
  }
  return false;
}

/**
 * Finds a helper button for a carrier action step.
 * @param {any} step
 * @param {{ disabledToo?: boolean }} [options]
 * @returns {Element | null}
 */
export function findButton(step, { disabledToo = false } = {}) {
  const re = step.text ? new RegExp(step.text, 'i') : null;
  let best = null;
  const separate = [];
  for (const el of deepQueryAll(document, withAdapter('a, button, [role=button], [role=link], input[type=button], input[type=submit], [onclick], [data-testid][tabindex]:not([tabindex="-1"])', 'buttons'))) {
    if (!el.getClientRects().length || closestOwn(el, 'stepLinks')) continue;
    if (step.within && !insideOf(el, step.within)) continue;
    if (!disabledToo && (/** @type {HTMLButtonElement} */ (el).disabled || el.getAttribute('aria-disabled') === 'true' || el.closest(withAdapter('[aria-disabled="true"]', 'disabled')) || hostDisabled(el))) continue;
    const text = buttonText(el);
    const named = namesOf(el, text);
    if (step.moveOn && step.within ? NEVER_ADVANCE.test(named) : NEVER_CLICK.test(named)) continue;
    const attrs = [el.id, el.getAttribute('name'), el.getAttribute('href'), el.getAttribute('onclick'),
      ...[...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.value)].join(' ');
    const hit = (re && text.length <= 80 && re.test(text)) || (step.token && attrs.includes(step.token));
    if (!hit || (step.near && !isNear(el, step.near, re))) continue;
    if (!best || best.contains(el)) best = el;
    if (!separate.some((s) => s.contains(el) || el.contains(s))) separate.push(el);
  }
  return step.unique && separate.length > 1 ? null : best;
}

/**
 * Returns selectors for carrier buttons and actions the agent might click.
 * @returns {string}
 */
export const agentPress = () => withAdapter(withAdapter('button, input[type=submit], input[type=button], [data-testid=addIcon]', 'agentPress'), 'buttons');
