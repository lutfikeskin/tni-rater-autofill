// @ts-check
// Visual highlighting, marks (data-rater-autofill), scroll-reveal ring, and floating AI banner.

import { radioHost, isVisible, deepQueryAll, collectControls, fieldKey } from './dom.js';
import { adapter } from './adapter.js';

/** @import { PageControl } from './dom.js' */

export const MARK = 'data-rater-autofill';
// `own`: an agent's own default in place of TNI's standard (docs/agent-defaults-spec.md), teal.
export const COLORS = { filled: '#16a34a', standard: '#2f6fd6', own: '#0f766e', needs: '#d97706', failed: '#dc2626', ai: '#7c3aed', agent: '#475569' };
export const SOLID_MARKS = new Set(['filled', 'standard', 'own', 'ai', 'agent']);
export const BANNER_ID = 'rater-autofill-ai-banner';

/**
 * Returns the DOM elements to highlight for control c.
 * @param {PageControl} c
 * @returns {HTMLElement[]}
 */
export function highlightTargets(c) {
  if (c.kind !== 'radio') {
    const drawn = c.el.classList?.contains('select2-hidden-accessible') ? /** @type {HTMLElement | null} */ (c.el.nextElementSibling?.querySelector?.('.select2-selection')) ?? null : null;
    return drawn ? [drawn, c.el] : [/** @type {HTMLElement} */ (adapter().highlight(c.widget) ?? c.el)];
  }
  return (c.radios ?? []).map((r) => {
    const host = /** @type {HTMLElement} */ (radioHost(r));
    if (host?.getClientRects().length) return host;
    return isVisible(r) && r.getClientRects().length ? r : /** @type {HTMLElement} */ (r.labels?.[0] ?? r);
  });
}

/**
 * Applies an autofill status visual mark outline and tooltip to control c.
 * @param {PageControl} c
 * @param {'filled' | 'standard' | 'own' | 'needs' | 'failed' | 'ai' | 'agent' | string} status
 * @param {string} [note]
 */
export function mark(c, status, note) {
  for (const el of highlightTargets(c)) {
    if (!el.hasAttribute(MARK)) {
      el.dataset.raPrevOutline = el.style.outline;
      el.dataset.raPrevOffset = el.style.outlineOffset;
      el.dataset.raPrevTitle = el.getAttribute('title') ?? '';
    }
    el.setAttribute(MARK, status);
    el.style.outline = `2px ${SOLID_MARKS.has(status) ? 'solid' : 'dashed'} ${COLORS[status] ?? '#2563eb'}`;
    el.style.outlineOffset = '1px';
    if (note) el.setAttribute('title', `Rater Autofill: ${note}`);
  }
}

/**
 * Clears all autofill outlines and removes the AI banner.
 * @returns {number} count of cleared elements
 */
export function clear() {
  aiBanner([]);
  let n = 0;
  for (const el of deepQueryAll(document, `[${MARK}]`)) {
    const hEl = /** @type {HTMLElement} */ (el);
    hEl.style.outline = hEl.dataset.raPrevOutline ?? '';
    hEl.style.outlineOffset = hEl.dataset.raPrevOffset ?? '';
    if (hEl.dataset.raPrevTitle) hEl.setAttribute('title', hEl.dataset.raPrevTitle); else hEl.removeAttribute('title');
    for (const k of ['raPrevOutline', 'raPrevOffset', 'raPrevTitle']) delete hEl.dataset[k];
    hEl.removeAttribute(MARK);
    n++;
  }
  return n;
}

/**
 * Marks a control matching key and optional label.
 * @param {string} key
 * @param {string} [label]
 * @param {string} [status]
 * @param {string} [note]
 * @returns {boolean}
 */
export function markKey(key, label, status = 'filled', note = '') {
  const same = collectControls().filter((c) => fieldKey(c) === key);
  const c = same.length > 1 ? same.find((x) => x.label === label) : same[0];
  if (c) mark(c, status, note);
  return !!c;
}

/** @type {Map<HTMLElement, { prev: string, ring: string, timer: any }>} */
const ringed = new Map();

/**
 * Brings a field into view and displays a temporary pulsing ring.
 * @param {string} key
 * @param {string} [label]
 * @returns {boolean}
 */
export function reveal(key, label) {
  const same = collectControls().filter((c) => fieldKey(c) === key);
  const c = same.length > 1 ? same.find((x) => x.label === label) : same[0];
  if (!c) return false;
  const targets = highlightTargets(c);
  targets[0]?.scrollIntoView?.({ block: 'center' });
  for (const el of targets) {
    const was = ringed.get(el);
    if (was) clearTimeout(was.timer);
    const prev = was ? was.prev : el.style.boxShadow ?? '';
    el.style.boxShadow = `0 0 0 4px ${el.style.outlineColor || '#2563eb'}`;
    const ring = el.style.boxShadow;
    const timer = setTimeout(() => {
      ringed.delete(el);
      if (el.style.boxShadow === ring) el.style.boxShadow = prev;
    }, 1500);
    ringed.set(el, { prev, ring, timer });
  }
  return true;
}

/**
 * Renders or removes the in-page AI suggestion banner.
 * @param {string[]} lines
 */
export function aiBanner(lines) {
  if (window !== window.top) return;
  document.getElementById(BANNER_ID)?.remove();
  if (!lines?.length) return;
  const box = document.createElement('div');
  box.id = BANNER_ID;
  box.setAttribute('role', 'status');
  box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:10px 12px;'
    + 'background:#f5f1ff;border:2px solid #7c3aed;border-radius:8px;color:#2e1065;font:13px/1.4 system-ui,sans-serif;'
    + 'box-shadow:0 4px 14px rgba(0,0,0,.15)';
  const head = document.createElement('div');
  head.style.cssText = 'font-weight:700;margin-bottom:4px';
  head.textContent = `AI selected ${lines.length} answer${lines.length === 1 ? '' : 's'} on this page (purple). Approve in the side panel before Continue.`;
  const list = document.createElement('ul');
  list.style.cssText = 'margin:0;padding-left:18px';
  for (const line of lines.slice(0, 12)) {
    const li = document.createElement('li');
    li.textContent = line;
    list.append(li);
  }
  box.append(head, list);
  document.body.append(box);
}
