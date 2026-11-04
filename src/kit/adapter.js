// @ts-check
// Carrier page adapter (__raterAdapter), page identity, lifecycle, AJAX/request monitoring, and settling.

import { oneLine, squash, sleep } from './text.js';
import { RATES_STALE } from '../rates.js';
import { kitTrace, isTracing } from './trace.js';
import { deepQueryAll, isVisible } from './dom.js';

/** @import { PageAdapter, PageAdapterKit, PageAdapterShared } from '../../types.js' */

/**
 * A page without an adapter is plain HTML: every hook has its default here.
 * @type {PageAdapter & PageAdapterShared}
 */
export const NO_ADAPTER = {
  widget: () => null,
  radioGroup: () => null,
  groupKey: () => null,
  choices: () => null,
  label: () => null,
  optionText: () => '',
  question: () => null,
  row: () => null,
  required: () => false,
  value: (widget, el) => /** @type {any} */ (el)?.value ?? null,
  shown: () => null,
  holds: () => false,
  invalid: () => false,
  groupOf: () => null,
  setText: () => {},
  changed: () => {},
  apply: async () => ({ ok: false, reason: 'no page adapter for this widget' }),
  reselect: () => {},
  highlight: () => null,
  typeName: () => null,
  busy: () => false,
  selectors: {},
  changeAttributes: [],
  page: () => null,
  rearm: () => [],
  serverBacked: () => false,
  onRequest: () => {},
  offRequest: () => {},
  listOwner: () => null,
  components: null,
};

let adapterSource = null;
/** @type {PageAdapter & PageAdapterShared} */
let adapterNow = NO_ADAPTER;

/** @type {PageAdapterKit} */
let adapterHooks = {
  oneLine,
  sleep,
  matchOption: () => null,
  noMatch: () => ({ ok: false, reason: 'no match' }),
  textFor: () => '',
  hasOptions: () => false,
  labelFor: () => null,
};

/**
 * Updates the helper hooks passed to the adapter's create() function.
 * @param {Partial<PageAdapterKit>} hooks
 */
export function setAdapterHooks(hooks) {
  Object.assign(adapterHooks, hooks);
  adapterSource = null; // force re-creation with new hooks
}

/**
 * Returns the active carrier page adapter, re-created if globalThis.__raterAdapter has changed.
 * @returns {PageAdapter & PageAdapterShared}
 */
export function adapter() {
  const source = globalThis.__raterAdapter ?? null;
  if (source !== adapterSource) {
    adapterSource = source;
    adapterNow = {
      ...NO_ADAPTER,
      ...(source?.shared ?? {}),
      ...(source?.create?.(adapterHooks) ?? {}),
    };
  }
  return adapterNow;
}

/**
 * A selector list with the carrier's own selectors for one role added.
 * @param {string} base
 * @param {string} role
 * @returns {string}
 */
export const withAdapter = (base, role) => [base, ...(adapter().selectors?.[role] ?? [])].filter(Boolean).join(', ');

/**
 * The nearest of the carrier's own elements for one role around el, or null.
 * @param {Element | null} el
 * @param {string} role
 * @returns {Element | null}
 */
export const closestOwn = (el, role) => {
  const own = adapter().selectors?.[role] ?? [];
  return own.length ? el?.closest?.(own.join(', ')) ?? null : null;
};

/**
 * The field's name in the carrier's data model, as its adapter names it.
 * @param {Element} el
 * @returns {string | null}
 */
export const fieldRef = (el) => globalThis.__raterFieldKey?.ref?.(el) ?? null;

/**
 * GEICO's data-model name of a field: Id_GiveYear_81515 is GiveYear, whatever its render number.
 * @param {Element} el
 * @returns {string | null}
 */
export const dataName = (el) => globalThis.__raterFieldKey?.dataName?.(el) ?? null;

/**
 * The page is waiting on its server or re-drawing after an answer.
 * @returns {boolean}
 */
export function pageBusy() {
  const a = adapter();
  if (a.busy()) return true;
  // A loading mask or message on screen, or one of the carrier's own.
  return [...document.querySelectorAll(withAdapter('[class*="loading-mask"], [class*="LoadingMessage"]', 'busy'))]
    .some((m) => /** @type {HTMLElement} */ (m).getClientRects().length && getComputedStyle(m).visibility !== 'hidden');
}

const UNDEFINED_MS = 3000;
const undefinedSince = new WeakMap();
let componentPrefix = null;

export const getComponentPrefix = () => componentPrefix;
export const setComponentPrefix = (prefix) => { componentPrefix = prefix; };

/**
 * Checks whether custom carrier web-components are still undefined.
 * @returns {boolean}
 */
export function partsUndefined() {
  if (!componentPrefix) return false;
  let parts;
  try {
    parts = [...document.querySelectorAll(':not(:defined)')].filter((el) => el.localName.startsWith(componentPrefix));
  } catch {
    return false;
  }
  const now = Date.now();
  let waiting = false;
  for (const el of parts) {
    if (!undefinedSince.has(el)) undefinedSince.set(el, now);
    if (now - undefinedSince.get(el) < UNDEFINED_MS) waiting = true;
  }
  return waiting;
}

let requestWatch = null;
/** @type {Array<{ start: number, end: number, poll: boolean }>} */
export const recentRequests = [];
/** Whether this frame sees its requests (watchRequests started and the browser has PerformanceObserver). */
export const watchingRequests = () => !!requestWatch;
const lastRequestEnd = () => recentRequests.reduce((m, r) => (r.poll ? m : Math.max(m, r.end)), -Infinity);

const POLL_SLACK_MS = 40;
/** @type {Map<string, { starts: number[], period: number | null }>} */
const beats = new Map();

/**
 * Determines whether requests at an address represent a periodic background poll heartbeat.
 * @param {string} address
 * @param {number} start
 * @returns {boolean}
 */
export function isBeat(address, start) {
  const b = beats.get(address) ?? { starts: [], period: null };
  beats.set(address, b);
  const prev = b.starts.at(-1);
  b.starts = [...b.starts, start].slice(-4);
  if (b.period != null) return prev != null && start - prev >= b.period * 0.75;
  const gaps = b.starts.slice(1).map((s, i) => s - b.starts[i]);
  if (gaps.length < 3 || gaps[0] < 1500 || gaps.some((g) => Math.abs(g - gaps[0]) > POLL_SLACK_MS)) return false;
  b.period = (gaps[0] + gaps[1] + gaps[2]) / 3;
  return true;
}

export const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Starts observing this frame's network requests.
 */
export function watchRequests() {
  if (requestWatch !== null) return;
  try {
    requestWatch = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const res = /** @type {PerformanceResourceTiming} */ (e);
        if ((res.initiatorType === 'fetch' || res.initiatorType === 'xmlhttprequest') && String(res.name).startsWith(`${location.origin}/`)) {
          const start = res.startTime ?? res.responseEnd;
          recentRequests.push({ start, end: res.responseEnd, poll: isBeat(String(res.name).split(/[?#]/)[0], start) });
          if (recentRequests.length > 200) recentRequests.shift();
        }
      }
    });
    requestWatch.observe({ type: 'resource', buffered: true });
  } catch {
    requestWatch = false;
  }
}

const REQUESTS_MS = 30000;

/**
 * Wait until the page stops changing: not busy, every component it draws defined, and no new
 * nodes for quietMs.
 * @param {{ quietMs?: number, maxMs?: number, requests?: (() => boolean) | null, why?: string | null }} [options]
 * @returns {Promise<boolean>}
 */
export async function settle({ quietMs = 250, maxMs = 15000, requests = null, why = null } = {}) {
  let last = Date.now();
  const mo = new MutationObserver(() => { last = Date.now(); });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['checked', ...adapter().changeAttributes] });
  const start = Date.now();
  const told = (ended, more = {}) => {
    if (isTracing()) kitTrace('wait', { why, quietMs, maxMs, requests: !!requests, start, ms: Date.now() - start, ended, ...more });
  };
  try {
    const requested = () => !!requestWatch && !!requests?.() && Date.now() - start < REQUESTS_MS && perfNow() - lastRequestEnd() < quietMs;
    for (let now = Date.now(); now - start < maxMs; now = Date.now()) {
      if (mo.takeRecords?.().length) last = now;
      const quietFor = now - last;
      if (quietFor >= quietMs && !pageBusy() && !partsUndefined() && !requested()) { told('quiet'); return true; }
      await sleep(Math.max(1, Math.min(quietFor < quietMs ? quietMs - quietFor : 60, maxMs - (now - start))));
    }
    const settled = !pageBusy() && Date.now() - last >= quietMs;
    if (isTracing()) told('limit', { settled, held: { busy: pageBusy(), changing: Date.now() - last < quietMs, requests: requested() } });
    return settled;
  } finally {
    mo.disconnect();
  }
}

/**
 * Normalizes a URL location to a canonical page path or adapter name.
 * @param {Location | URL} loc
 * @returns {string}
 */
export const pageAt = (loc) => (adapter().page(/** @type {Location} */ (loc)) || (loc.pathname + ((loc.hash ?? '').startsWith('#/') ? loc.hash.slice(1).split('?')[0] : '')).replace(/\/(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{3,})(?=\/|$)/gi, '/:id')).replace(/-Reload$/, '');

/**
 * Returns the current canonical page name.
 * @returns {string}
 */
export const currentPage = () => pageAt(location);

/**
 * The page says its rates are out of date.
 * @returns {boolean}
 */
export function ratesStale() {
  return RATES_STALE.test(document.body.innerText ?? '');
}

/**
 * Checks whether the page displays a ready, current premium.
 * @returns {boolean}
 */
export function premiumReady() {
  if (pageBusy() || ratesStale()) return false;
  const text = document.body.innerText ?? '';
  return /(?:total|annual|policy|estimated)\s+premium(?:\s+amount)?\s*:?\s*\$\s*[1-9][\d,]*(?:\.\d{2})?/i.test(text)
    || /\bquote\s+\$\s*[1-9][\d,]*\.\d{2}\s+due today\s+\$\s*[\d,]+\.\d{2}\s+total\b/i.test(text);
}

/**
 * Verifies whether a rating action has produced a verified premium.
 * @param {any} [a]
 * @returns {boolean}
 */
export function rated(a) {
  return premiumReady() && (!a?.ratedBy || deepQueryAll(document, a.ratedBy).some((el) => el.getClientRects().length));
}

/**
 * Returns step progress bar elements on screen.
 * @returns {Element[]}
 */
export const stepBars = () => {
  const own = adapter().selectors?.stepBar ?? [];
  return own.length ? [...(document.querySelectorAll?.(own.join(', ')) ?? [])] : [];
};

/**
 * The bar's one part under way (0 < value < 100), by its words; '' when none or several are.
 * @returns {string}
 */
export function barStep() {
  const now = stepBars().filter((b) => { const v = Number(b.getAttribute('value')); return v > 0 && v < 100; });
  return now.length === 1 ? oneLine(now[0].textContent) : '';
}

/**
 * Which step of a one-address application is on screen.
 * @returns {string}
 */
export function stepKey() {
  if (stepBars().length) {
    const bar = barStep();
    return squash(bar) && squash(document.title).includes(squash(bar)) ? bar : '';
  }
  return deepQueryAll(document, 'h1, h2, h3').filter(isVisible).map((h) => oneLine(h.textContent)).filter(Boolean).slice(0, 4).join(' / ');
}

/**
 * Whether the step on screen is one of names.
 * @param {string | string[]} names
 * @param {string} [key]
 * @returns {boolean}
 */
export function stepIs(names, key = stepKey()) {
  const parts = String(key ?? '').split(' / ').map(squash).filter(Boolean);
  return [].concat(names ?? []).some((n) => !!squash(n) && parts.includes(squash(n)));
}

/** @type {string[]} */
let knownStopSteps = [];

export const getKnownStopSteps = () => knownStopSteps;

/**
 * Adds stop steps to the known stop steps set.
 * @param {string[]} steps
 */
export function addStopSteps(steps) {
  if (steps?.length) knownStopSteps = [...new Set([...knownStopSteps, ...steps])];
}

/**
 * The step of stopSteps on screen, or ''.
 * @param {string[]} stopSteps
 * @returns {string}
 */
export function stopStepOn(stopSteps) {
  if (!stopSteps?.length) return '';
  const bar = barStep();
  const key = stepKey();
  const title = squash(document.title);
  return stopSteps.find((n) => stepIs([n], bar) || stepIs([n], key) || (!!squash(n) && title.includes(squash(n)))) ?? '';
}
