// @ts-check
// Form layout capture for developer recording/replay, client data redaction, receipt hashing, and review inspection.

import { oneLine } from './text.js';
import {
  deepQueryAll, collectControls, fieldKey, shownNow, hasValue, describe, optionsOf,
  labelFor, sectionOf, cssPath, selectedText, otherStep, getHiddenOk, setHiddenOk,
  keyIndex, controlOf, hiddenKeys, isVisible, buttonText,
} from './dom.js';
import { adapter, withAdapter, currentPage, stepKey } from './adapter.js';
import { redactionPattern } from '../redaction.js';
import { agreesWith, assign } from './apply.js';

/** @import { PageControl } from './dom.js' */
/** @import { PlanStep } from '../../types.js' */

export const CAPTURE_OPTIONS = 250;

/**
 * Strips typed text, long numbers, and VIN patterns out of a string.
 * @param {string} text
 * @param {PageControl[]} controls
 * @returns {string}
 */
export function withoutTyped(text, controls) {
  const boxes = [...controls.map((c) => c.el), ...deepQueryAll(document, 'input, textarea, [contenteditable=""], [contenteditable=true]')];
  const typed = [...new Set(boxes.filter((el) => el?.tagName === 'TEXTAREA' || el?.getAttribute?.('contenteditable') != null
    || (el?.tagName === 'INPUT' && !/^(radio|checkbox|button|submit|reset|image|file|hidden|password|range|color)$/i.test(/** @type {HTMLInputElement} */ (el).type ?? '')))
    .map((el) => oneLine(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? /** @type {HTMLInputElement} */ (el).value : el.textContent)))].filter((v) => v.length >= 3);
  const pattern = (v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
  let out = typed.reduce((acc, v) => acc.replace(pattern(v), '[typed]'), text);
  out = out.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[typed]').replace(/\d[\d\s().-]{4,}\d/g, '[number]');
  return out;
}

/**
 * Finds the question an open dropdown list belongs to.
 * @param {Element} list
 * @returns {{ label: string, fixed: boolean } | null}
 */
export function listOwner(list) {
  const fixedBox = (el) => !!el && (el.tagName !== 'INPUT' || el.readOnly || !String(el.value ?? '').trim());
  if (list.id) {
    const owner = deepQueryAll(document, 'input, [role=combobox]').find((el) =>
      `${el.getAttribute('aria-owns') ?? ''} ${el.getAttribute('aria-controls') ?? ''}`.split(/\s+/).includes(list.id));
    if (owner) return { label: labelFor(owner), fixed: fixedBox(owner) && owner.getAttribute('aria-autocomplete') !== 'list' };
    const owned = adapter().listOwner(list);
    if (owned) return owned;
  }
  const focused = /** @type {HTMLElement | null} */ (document.activeElement);
  return focused && focused !== document.body && /^(INPUT|SELECT)$/.test(focused.tagName ?? '')
    ? { label: labelFor(focused), fixed: focused.tagName === 'SELECT' || !!(/** @type {HTMLInputElement} */ (focused).readOnly) } : null;
}

/**
 * Extracts and formats option choices for a captured control.
 * @param {PageControl} c
 * @param {(s: any) => string} r
 * @returns {{ options: string[], optionsTruncated?: boolean }}
 */
export function captureOptions(c, r) {
  const all = /agent|producer/i.test(c.label ?? '') ? [] : optionsOf(c);
  return { options: all.slice(0, CAPTURE_OPTIONS).map((o) => r(o.text)), optionsTruncated: all.length > CAPTURE_OPTIONS || undefined };
}

/**
 * Captures form controls and page layout in standard page-capture format.
 * @param {PlanStep[]} [plan]
 * @param {string[]} [redact]
 * @returns {any}
 */
export function capture(plan, redact = []) {
  const patterns = redact.filter((t) => t && t.length >= 3).map(redactionPattern);
  const r = (s) => patterns.reduce((acc, re) => acc.replace(re, '[client]'), oneLine(s)).replace(/^.+?(?=\((?:USDOT|Primary Business|Mailing|Garaging) Address\))/i, '[client] ');
  const controls = collectControls();
  const matched = new Map(plan ? assign(controls, plan).map((p) => [p.control, p.step.path]) : []);
  const path = location.pathname.replace(/\d{5,}/g, ':id');
  const pageName = currentPage();
  return {
    frame: location.origin + path,
    page: pageName,
    step: r(stepKey()),
    isTopFrame: window === window.top,
    title: r(document.title),
    headings: deepQueryAll(document, 'h1, h2, h3, legend, [role=heading]').filter(isVisible).map((h) => r(h.textContent)).filter(Boolean).slice(0, 40),
    controls: controls.map((c) => ({
      q: c.q ?? undefined,
      ref: c.ref ?? undefined,
      row: c.row ?? undefined,
      kind: c.kind,
      type: adapter().typeName(c.widget) ?? c.type,
      label: r(c.label),
      name: /** @type {HTMLInputElement} */ (c.el).name || null,
      id: c.el.id || null,
      dataId: c.el.getAttribute('data-id') || null,
      selector: cssPath(c.el),
      required: c.required,
      section: r(sectionOf(c.el)),
      ...captureOptions(c, r),
      wouldFill: matched.get(c) ?? null,
      pageHasValue: hasValue(c),
      selected: c.kind === 'text' ? undefined : r(selectedText(c) ?? ''),
    })),
    buttons: [...new Set(deepQueryAll(document, withAdapter('a, button, [role=button], input[type=button], input[type=submit]', 'buttons'))
      .filter((el) => el.getClientRects().length).map((el) => r(buttonText(el)).slice(0, 60)).filter(Boolean))].slice(0, 80),
    customWidgets: deepQueryAll(document, '[role=combobox]:not(input):not(select), [role=listbox], [contenteditable=true]')
      .filter(isVisible).slice(0, 50).map((el) => ({ role: el.getAttribute('role') ?? 'contenteditable', label: r(labelFor(el)), selector: cssPath(el) })),
    messages: [...new Set(deepQueryAll(document, withAdapter('[role=alert], [class*="error-message"], [class*="validation-message"], [class*="help-block"]', 'errors'))
      .filter(isVisible).map((el) => withoutTyped(r(oneLine(el.textContent)), controls).slice(0, 200)).filter(Boolean))].slice(0, 40),
    openLists: deepQueryAll(document, withAdapter('[role=listbox]', 'lists')).filter(isVisible).slice(0, 10).map((list) => {
      const owner = listOwner(list);
      const label = owner?.label ?? null;
      const items = [...list.querySelectorAll(withAdapter('[role=option]', 'options'))].map((o) => withoutTyped(r(oneLine(o.textContent)), controls)).filter(Boolean);
      const kept = !!owner?.fixed && label !== null && !/agent|producer/i.test(label);
      return { label: label === null ? null : r(label), selector: cssPath(list), count: items.length, fixed: !!owner?.fixed,
        options: kept ? items.slice(0, CAPTURE_OPTIONS) : [], optionsTruncated: (kept && items.length > CAPTURE_OPTIONS) || undefined };
    }),
  };
}

/**
 * Computes a 53-bit cyrb53 fingerprint receipt of visible control states in the top frame.
 * @returns {string | null}
 */
export function receipt() {
  if (window !== window.top) return null;
  const fillHidden = getHiddenOk();
  let controls;
  try {
    setHiddenOk([]);
    controls = collectControls();
  } finally {
    setHiddenOk(fillHidden);
  }
  const text = controls.filter((c) => !otherStep(c.el)).map((c) => `${fieldKey(c)}\u0001${c.label ?? ''}\u0001${shownNow(c)}`).join('\u0002');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `r1-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * Reads back field values and agreement for a set of items.
 * @param {Array<{ key: string, label?: string, stepId?: string | null }>} items
 * @param {PlanStep[]} [steps]
 * @returns {Array<{ key: string, label?: string, shown: string, empty: boolean, agrees: boolean | null }>}
 */
export function readBack(items, steps = []) {
  const controls = collectControls();
  const out = [];
  for (const { key, label, stepId = null } of items ?? []) {
    const same = controls.filter((c) => fieldKey(c) === key);
    const c = same.length > 1 ? same.find((x) => x.label === label) : same[0];
    const step = stepId == null ? null : (steps ?? []).find((s) => String(s.id) === String(stepId));
    if (c) out.push({ key, label, shown: shownNow(c), empty: !hasValue(c), agrees: step ? !!agreesWith(step, c) : null });
  }
  return out;
}

/**
 * Reads which review items are currently present on the page and what they show.
 * @param {Array<{ key: string, label?: string, stepId?: string | null }>} items
 * @param {string[]} [hidden]
 * @param {PlanStep[]} [steps]
 * @returns {any[]}
 */
export function present(items, hidden = [], steps = []) {
  const fillHidden = getHiddenOk();
  let controls;
  try {
    setHiddenOk(hidden ?? []);
    controls = collectControls();
  } finally {
    setHiddenOk(fillHidden);
  }
  const index = keyIndex(controls);
  return (items ?? []).flatMap(({ key, label = null, stepId = null }) => {
    const { c, sure } = key == null ? { c: null, sure: false } : controlOf(index, key, label);
    if (!c) return key != null && hiddenKeys(controls).has(key) ? /** @type {any[]} */ ([{ key, label, hidden: true }]) : [];
    const step = stepId == null ? null : (steps ?? []).find((s) => String(s.id) === String(stepId));
    return /** @type {any[]} */ ([{
      key, label, controlKind: c.kind, ...describe(c), shown: shownNow(c), agrees: step ? !!agreesWith(step, c) : null,
      ...(sure ? {} : { current: null, shown: null, agrees: null, shared: true }),
    }]);
  });
}

/**
 * Builds a string signature of all visible controls on screen.
 * @returns {string}
 */
export function signature() {
  return collectControls().map((c) => `${fieldKey(c)}|${c.label}`).join('\n');
}

/**
 * Creates a JSON snapshot of current field choices for AI answer validation.
 * @returns {string}
 */
export function decisionSnapshot() {
  return JSON.stringify([location.href, collectControls().map((c) => ({
    key: fieldKey(c), label: c.label, kind: c.kind,
    ...describe(c), current: c.kind === 'text' ? /** @type {HTMLInputElement} */ (c.el).value : selectedText(c),
  }))]);
}
