// @ts-check
// Shadow-DOM traversal, form control harvesting, label resolution, geometry, and native DOM getters/setters.

import { oneLine, squash, humanize, isPlaceholderOption } from './text.js';
import { adapter, closestOwn, withAdapter, fieldRef, dataName } from './adapter.js';

/**
 * @typedef {object} PageControlOption
 * @property {Element} [el]
 * @property {string} text
 * @property {string} [value]
 * @property {any} [widget]
 * @property {Element | null} [host]
 */

/**
 * @typedef {object} PageControl
 * @property {'text' | 'checkbox' | 'radio' | 'select'} kind
 * @property {HTMLElement} el
 * @property {string} type
 * @property {any} [widget]
 * @property {string | null} [label]
 * @property {boolean} [nameOnly]
 * @property {number | string | null} [q]
 * @property {string | null} [ref]
 * @property {string | null} [row]
 * @property {string} [text]
 * @property {string} [hint]
 * @property {boolean} [required]
 * @property {string | null} [vehicle]
 * @property {HTMLInputElement[]} [radios]
 * @property {PageControlOption[]} [options]
 */

export const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'file', 'password', 'search']);
export const ADDRESS_SEARCH = 'input[type=search][aria-autocomplete=list][aria-controls]:not(.select2-search__field)';
export const REVIEW_LISTS = ['unknown', 'failed', 'noData', 'leftRequired', 'checks'];
export const VEHICLE_LABEL = /^(?:19|20)\d{2}\s+\S/;

export const CONTROL_SELECTOR = 'input:not([type=hidden]), select, textarea';

/**
 * Up the page as it is drawn: a slotted element to its slot, a shadow root's top to its host.
 * @param {Node} n
 * @returns {Element | null}
 */
export const drawnParent = (n) => /** @type {any} */ (n).assignedSlot ?? /** @type {any} */ (n).parentElement ?? /** @type {any} */ (n).getRootNode?.()?.host ?? null;

/**
 * Recursively queries elements including through open shadow roots.
 * @param {Document | Element | any} root
 * @param {string} selector
 * @param {Element[]} [out]
 * @returns {Element[]}
 */
export function deepQueryAll(root, selector, out = []) {
  for (const el of root.querySelectorAll('*')) {
    if (el.matches(selector)) out.push(el);
    if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
  }
  return out;
}

/**
 * Returns a design-system radio host element if r is enclosed in its own shadow root.
 * @param {HTMLInputElement} r
 * @returns {Element | null}
 */
export function radioHost(r) {
  const root = /** @type {any} */ (r?.getRootNode?.());
  const host = root && root !== document ? root.host : null;
  if (!host || host.getAttribute?.('name') !== r.name) return null;
  return root.querySelectorAll?.('input[type=radio]').length === 1 ? host : null;
}

/**
 * The words of a host's light-DOM part for one of its slots ([slot=label], [slot=legend]), without
 * its tooltip's.
 * @param {Element | null} host
 * @param {string} name
 * @returns {string}
 */
export function slotText(host, name) {
  const part = [...(host?.children ?? [])].find((n) => n.getAttribute?.('slot') === name);
  if (!part) return '';
  let text = part.textContent ?? '';
  for (const tip of part.querySelectorAll(withAdapter('[role=tooltip]', 'tooltips'))) if (tip.textContent) text = text.replace(tip.textContent, ' ');
  return oneLine(text);
}

/**
 * A button's words as drawn: its own text; else what its slots show; else its host's.
 * @param {Element} el
 * @returns {string}
 */
export function buttonText(el) {
  const own = oneLine(/** @type {HTMLInputElement} */ (el).value || el.textContent);
  if (own) return own;
  const slotted = oneLine([...(el.querySelectorAll?.('slot') ?? [])].flatMap((s) => s.assignedNodes?.({ flatten: true }) ?? []).map((n) => n.textContent).join(' '));
  if (slotted) return slotted;
  const root = el.getRootNode?.();
  const host = root && root !== document ? /** @type {any} */ (root).host : null;
  return host && (/(^|-)button$/i.test(host.tagName ?? '') || host.getAttribute?.('role') === 'button') ? oneLine(host.textContent) : '';
}

/**
 * Disabled on its shadow host as well (<gds-button disabled>).
 * @param {Element} el
 * @returns {boolean}
 */
export const hostDisabled = (el) => {
  const root = el.getRootNode?.();
  const host = root && root !== document ? /** @type {any} */ (root).host : null;
  return !!host && (host.hasAttribute?.('disabled') || host.getAttribute?.('aria-disabled') === 'true');
};

/**
 * Checks whether an element is visible on screen.
 * @param {Element} el
 * @returns {boolean}
 */
export function isVisible(el) {
  if (el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden') return true;
  // Styled radios/checkboxes often hide the real input and show the <label> instead.
  return [...(/** @type {HTMLInputElement} */ (el).labels ?? [])].some((l) => l.getClientRects().length);
}

/**
 * Text inside root, skipping the contents of form controls (so option lists don't leak in).
 * @param {Node} root
 * @returns {string}
 */
export function textOutsideControls(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || p.closest('select, option, textarea, button, script, style, noscript, [hidden], [aria-hidden="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let t = '';
  while (walker.nextNode()) t += ` ${walker.currentNode.nodeValue}`;
  return oneLine(t);
}

export const countControls = (el) => el.querySelectorAll(CONTROL_SELECTOR).length;

export function byId(el, id) {
  const root = /** @type {any} */ (el.getRootNode?.());
  return root?.getElementById ? root.getElementById(id) : document.getElementById(id);
}

export function withoutCalendar(text) {
  const t = oneLine(text);
  const cut = t.search(/\b(su mo tu we th fr sa|mo tu we th fr sa su)\b|[«»]/i);
  return (cut >= 0 ? t.slice(0, cut) : t).trim();
}

/**
 * Resolves the visual/accessible label for a control element.
 * @param {Element} el
 * @returns {string}
 */
export function labelFor(el) {
  const parts = [];
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) for (const id of labelledBy.split(/\s+/)) { const n = byId(el, id); if (n) parts.push(n.textContent); }
  for (const l of /** @type {HTMLInputElement} */ (el).labels ?? []) parts.push(textOutsideControls(l));
  // Without markup: GEICO writes some as HTML (<span …>Name</span>'s Driver License State) or with **…** marks.
  if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label').replace(/<[^>]*>/g, '').replace(/\*\*/g, ''));
  // No explicit label: the smallest wrapper that holds only this field, preferring its label element.
  if (!oneLine(parts.join(''))) {
    let p = el.parentElement;
    for (let i = 0; i < 5 && p && p !== document.body; i++, p = p.parentElement) {
      if (countControls(p) > 1) break;
      const own = p.querySelector?.('label, .control-label, .form-label');
      const t = withoutCalendar(own ? textOutsideControls(own) : textOutsideControls(p));
      if (t) { parts.push(t); break; }
    }
  }
  if (!oneLine(parts.join('')) && /** @type {HTMLInputElement} */ (el).placeholder) parts.push(/** @type {HTMLInputElement} */ (el).placeholder);
  // The tooltip our own marks put on a field is never its question.
  const title = /** @type {HTMLElement} */ (el).dataset?.raPrevTitle ?? (/^Rater Autofill:/.test(/** @type {HTMLElement} */ (el).title ?? '') ? '' : /** @type {HTMLElement} */ (el).title);
  if (!oneLine(parts.join('')) && title) parts.push(title);
  const text = oneLine(parts.join(' ')).slice(0, 160);
  const name = dataName(el);
  if (name && !/[a-z]/i.test(text)) return oneLine(humanize(name));
  return text || oneLine(humanize(/** @type {HTMLInputElement} */ (el).name || el.id));
}

/**
 * A design-system group: the nearest element above option hosts with words in its [slot=legend].
 * @param {HTMLInputElement[]} radios
 * @returns {Element | null}
 */
export function legendHolder(radios) {
  const hosts = (radios ?? []).map(radioHost);
  if (!hosts.length || !hosts.every(Boolean)) return null;
  for (let n = /** @type {Element | null} */ (hosts[0]?.parentElement ?? null), i = 0; n && i < 3; n = n.parentElement ?? /** @type {any} */ (n.getRootNode?.())?.host, i++) {
    if (hosts.every((h) => n.contains(h)) && slotText(n, 'legend')) return n;
  }
  return null;
}

const ownTooltipTag = (n) => (adapter().selectors?.tooltips ?? []).some((t) => t.toUpperCase() === String(n.tagName ?? '').toUpperCase());

export function legendWords(radios) {
  const part = [...(legendHolder(radios)?.children ?? [])].find((n) => n.getAttribute?.('slot') === 'legend');
  const words = (n) => {
    if (n.nodeType === 3) return n.nodeValue ?? n.textContent ?? '';
    if (n.matches?.(withAdapter('[role=tooltip]', 'tooltips')) || ownTooltipTag(n) || n.getAttribute?.('role') === 'tooltip') return '';
    const nodes = n.childNodes ? [...n.childNodes] : null;
    if (nodes) return nodes.map(words).join(' ');
    return n.children?.length ? [...n.children].map(words).join(' ') : (n.textContent ?? '');
  };
  return part ? oneLine(words(part)) : '';
}

export function radioGroupLabel(radios, optionTexts) {
  const first = radios[0];
  const holder = legendHolder(radios);
  if (holder) return slotText(holder, 'legend').slice(0, 160);
  const group = first.closest('[role=radiogroup]');
  if (group && (group.getAttribute('aria-label') || group.getAttribute('aria-labelledby'))) return labelFor(group);
  const fieldset = first.closest('fieldset');
  if (fieldset && radios.every((r) => fieldset.contains(r))) {
    const legend = fieldset.querySelector('legend');
    if (legend) return oneLine(legend.textContent);
  }
  let c = first.parentElement;
  while (c && !radios.every((r) => c.contains(r))) c = c.parentElement;
  for (let i = 0; c && i < 3; i++, c = c.parentElement) {
    let t = textOutsideControls(c);
    for (const o of optionTexts) if (o) t = t.replace(o, ' ');
    t = oneLine(t);
    if (t) return t.slice(0, 160);
    if (c.querySelectorAll(CONTROL_SELECTOR).length > radios.length) break;
  }
  return oneLine(humanize(dataName(first) || first.name));
}

export function isRequired(el, label) {
  return el.required || el.getAttribute('aria-required') === 'true' || el.getAttribute('app-valid-rq') === '1' || !!el.closest?.('table[app-valid-rq="1"]') || /\*/.test(label);
}

export function sectionOf(el) {
  for (let p = el.parentElement, i = 0; p && i < 8; p = p.parentElement, i++) {
    const heads = [...p.querySelectorAll('h1, h2, h3, h4, legend, [role=heading]')]
      .filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (heads.length) return oneLine(heads.at(-1).textContent).slice(0, 100);
  }
  return '';
}

/**
 * Returns the stable field key for control c.
 * @param {PageControl} c
 * @returns {string}
 */
export function fieldKey(c) {
  return globalThis.__raterFieldKey(c.el, { q: c.q });
}

export function safeMatches(el, selector) {
  try { return el.matches(selector); } catch { return false; }
}

export function shownControl(controls, cond) {
  const re = cond.label ? new RegExp(cond.label, 'i') : null;
  return controls.find((x) => x.ref === cond.field && (!re || re.test(x.text ?? ''))) ?? null;
}

export const otherStep = (el) => { const tab = closestOwn(el, 'otherStep'); return !!tab && !isVisible(tab); };

/** @type {string[]} */
let hiddenOk = [];
export const getHiddenOk = () => hiddenOk;
export const setHiddenOk = (val) => { hiddenOk = val ? [].concat(val) : []; };

let controlReads = 0;
export const getControlReads = () => controlReads;
export const resetControlReads = () => { controlReads = 0; };
export const incrementControlReads = () => ++controlReads;

const hiddenOf = new WeakMap();
const hiddenKeySets = new WeakMap();

/**
 * Harvests all interactive form controls currently rendered on screen.
 * @returns {PageControl[]}
 */
export function collectControls() {
  controlReads++;
  const a = adapter();
  /** @type {PageControl[]} */
  const out = [];
  /** @type {Map<string, PageControl>} */
  const groups = new Map();
  const hidden = [];
  for (const el of deepQueryAll(document, CONTROL_SELECTOR)) {
    const hEl = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (el);
    const type = hEl.tagName === 'INPUT' ? (hEl.type || 'text').toLowerCase() : hEl.tagName.toLowerCase();
    if (hEl.tagName === 'INPUT' && SKIP_INPUT_TYPES.has(type) && !(type === 'search' && safeMatches(hEl, ADDRESS_SEARCH))) continue;
    if (hEl.disabled || (!isVisible(hEl) && !hiddenOk.some((sel) => safeMatches(hEl, sel)))) { hidden.push(hEl); continue; }
    const widget = a.widget(hEl);
    if (type === 'radio') {
      const widgetGroup = a.radioGroup(widget);
      const key = widgetGroup ? a.groupKey(widgetGroup) : `${hEl.form ? 'f' : ''}:${globalThis.__raterFieldKey(hEl)}|${hEl.name ?? ''}`;
      let g = groups.get(key);
      if (!g) {
        g = { kind: 'radio', el: hEl, type, radios: [], widget: widgetGroup };
        groups.set(key, g);
        out.push(g);
      }
      g.radios.push(/** @type {HTMLInputElement} */ (hEl));
      continue;
    }
    /** @type {PageControl} */
    const c = { kind: hEl.tagName === 'SELECT' ? 'select' : type === 'checkbox' ? 'checkbox' : 'text', el: hEl, type, widget };
    const choices = a.choices(widget);
    if (choices) {
      c.kind = 'select';
      c.options = choices;
    }
    c.label = a.label(widget, c.kind) ?? labelFor(hEl);
    c.nameOnly = !!c.label && (c.label === oneLine(humanize(hEl.name || hEl.id)) || (!!dataName(hEl) && c.label === oneLine(humanize(dataName(hEl)))));
    c.q = a.question(widget, hEl);
    c.ref = fieldRef(hEl);
    out.push(c);
  }
  for (const g of groups.values()) {
    g.options = g.radios.map((r) => {
      const item = a.widget(r);
      const host = radioHost(r);
      return { el: r, widget: item, host, text: a.optionText(item) || oneLine([...(r.labels ?? [])].map(textOutsideControls).join(' ')) || slotText(host, 'label') || r.value, value: r.value };
    });
    g.label = a.label(g.widget, 'radio') ?? radioGroupLabel(g.radios, g.options.map((o) => o.text));
    g.q = a.question(g.widget, g.el) ?? (String(/** @type {HTMLInputElement} */ (g.el).name).match(/^[a-z]+_([0-9A-F]+)/)?.[1] ?? null);
    g.ref = g.radios.map(fieldRef).find(Boolean) ?? null;
  }
  for (const c of out) {
    c.text = squash(c.label);
    c.hint = humanize(dataName(c.el) || /** @type {HTMLInputElement} */ (c.el).name || c.el.id || '');
    c.required = a.required(c.widget) || isRequired(c.el, c.label);
  }
  const rowVehicle = new Map();
  for (const c of out) {
    c.row = a.row(c.widget, c.el);
    if (!c.row || !VEHICLE_LABEL.test(c.label ?? '')) continue;
    rowVehicle.set(c.row, rowVehicle.has(c.row) && rowVehicle.get(c.row) !== c.text ? null : c.text);
  }
  for (const c of out) c.vehicle = VEHICLE_LABEL.test(c.label ?? '') ? c.text : (c.row && rowVehicle.get(c.row)) || null;
  hiddenOf.set(out, hidden);
  return out;
}

export function hiddenKeys(controls) {
  let keys = hiddenKeySets.get(controls);
  if (!keys) {
    const a = adapter();
    keys = new Set((hiddenOf.get(controls) ?? []).map((el) => globalThis.__raterFieldKey(el, { q: a.question(a.widget(el), el) })));
    hiddenKeySets.set(controls, keys);
  }
  return keys;
}

const keyIndexes = new WeakMap();
export function keyIndex(controls) {
  let index = keyIndexes.get(controls);
  if (!index) {
    index = new Map();
    for (const c of controls) {
      const key = fieldKey(c);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(c);
    }
    keyIndexes.set(controls, index);
  }
  return index;
}

export function controlOf(index, key, label) {
  const same = index.get(key) ?? [];
  if (same.length < 2) return { c: same[0] ?? null, sure: true };
  const own = same.filter((x) => x.label === label);
  return { c: own[0] ?? same[0], sure: own.length === 1 };
}

export function optionsOf(c) {
  if (c.options) return c.options;
  if (c.kind === 'select') return [.../** @type {HTMLSelectElement} */ (c.el).options].map((o) => ({ el: o, text: oneLine(o.text), value: o.value }));
  return [];
}

export function describe(c) {
  const options = /agent|producer/i.test(c.label ?? '') ? []
    : [...new Set(optionsOf(c).map((o) => o.text).filter((t) => t && !isPlaceholderOption(t)))];
  return { options, section: sectionOf(c.el), current: c.kind === 'text' ? (textValue(c.el) ? 'has a value' : null) : selectedText(c) };
}

export const optionOn = (o) => (o.widget ? !!adapter().value(o.widget, o.el) : o.host ? o.host.hasAttribute('checked') : o.el.checked);

const MASK_ONLY = /^(?:[\s_\-/.()#*]|MM|DD|YYYY|YY)*$/i;
export const textValue = (el) => (MASK_ONLY.test(/** @type {HTMLInputElement} */ (el).value ?? '') ? '' : /** @type {HTMLInputElement} */ (el).value ?? '');

export function hasValue(c) {
  if (c.kind === 'radio') return c.options.some(optionOn);
  if (c.widget && c.kind === 'select') return adapter().holds(c.widget, c.el, isPlaceholderOption);
  if (c.kind === 'text') return textValue(c.el).trim() !== '';
  if (c.kind === 'checkbox') return /** @type {HTMLInputElement} */ (c.el).checked;
  const o = /** @type {HTMLSelectElement} */ (c.el).selectedOptions?.[0];
  return !!o && o.value !== '' && !isPlaceholderOption(o.text);
}

export function selectedText(c) {
  if (c.kind === 'checkbox') return /** @type {HTMLInputElement} */ (c.el).checked ? 'checked' : 'unchecked';
  if (c.kind === 'radio') return c.options.find(optionOn)?.text ?? null;
  if (c.widget) return adapter().shown(c.widget);
  if (c.kind === 'select' && /** @type {HTMLSelectElement} */ (c.el).multiple) {
    return [...(/** @type {HTMLSelectElement} */ (c.el).selectedOptions ?? [])].map((x) => oneLine(x.text)).filter((t) => t && !isPlaceholderOption(t)).join('; ') || null;
  }
  const o = /** @type {HTMLSelectElement} */ (c.el).selectedOptions?.[0];
  return o && !isPlaceholderOption(o.text) ? oneLine(o.text) : null;
}

export function invalidControl(c) {
  if (c.el.getAttribute('aria-invalid') === 'true' || /** @type {HTMLInputElement} */ (c.el).validity?.valid === false) return true;
  const widget = c.widget ?? adapter().groupOf(c.options?.[0]);
  return !!widget && adapter().invalid(widget);
}

export function shownNow(c) {
  if (c.kind === 'checkbox') return (c.widget ? !!adapter().value(c.widget, c.el) : /** @type {HTMLInputElement} */ (c.el).checked) ? 'checked' : 'unchecked';
  if (c.kind === 'text') return textValue(c.el) || (c.widget ? String(adapter().value(c.widget, c.el) ?? '') : '');
  return selectedText(c) ?? '';
}

export function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  /** @type {HTMLElement} */ (el).focus({ preventScroll: true });
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (el.classList?.contains('datepicker-input')) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
  /** @type {HTMLElement} */ (el).blur();
}

export function textFor(step, c) {
  const v = step.value;
  switch (step.kind) {
    case 'bool': return v ? 'Yes' : 'No';
    case 'date': {
      const m = String(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      return m && c.type === 'date' ? `${m[3]}-${m[1]}-${m[2]}` : String(v);
    }
    case 'phone': return c.el.maxLength > 0 && c.el.maxLength <= 10 ? String(v).replace(/\D/g, '') : String(v);
    default: return String(v);
  }
}

export const hasOptions = (options) => options.some((o) => !isPlaceholderOption(o.text));

export function cssPath(el) {
  const looksStable = (s) => s && !/\d{4,}|[a-f0-9]{8,}|^(mat|ng|react|ember|ext)-?/i.test(s);
  if (looksStable(el.id) && el.getRootNode().querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
  if (looksStable(el.name)) return `${el.tagName.toLowerCase()}[name="${el.name.replace(/"/g, '\\"')}"]`;
  const parts = [];
  for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = e.parentElement) {
    let part = e.tagName.toLowerCase();
    if (looksStable(e.id)) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
    const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
    if (same.length > 1) part += `:nth-of-type(${same.indexOf(e) + 1})`;
    parts.unshift(part);
  }
  return parts.join(' > ');
}
