// @ts-check
// Control matching, value application orchestration, driver registry, and agreement checks.

import { oneLine, squash, humanize, loose, multiValue, isPlaceholderOption, STATE_NAMES } from './text.js';
import { adapter, withAdapter, stepKey, stepIs, currentPage, settle, setAdapterHooks, pause, waitsStopped, INTERRUPTED, noteOwnAction } from './adapter.js';
import { deepQueryAll, optionsOf, selectedText, hasValue, optionOn, setNativeValue, textFor, safeMatches, shownControl, hasOptions, labelFor } from './dom.js';
import { unitFormsOf } from './units.js';
import { createLocator } from './locator.js';
import { createAddressDriver } from './drivers/address.js';
import { createSelect2Drivers } from './drivers/select2.js';
import { typingElsewhere, focusedControl, activeNow } from './guard.js';

/** @import { PageControl } from './dom.js' */
/** @import { FailCode, PlanStep, WriteResult } from '../../types.js' */

export const extraRowKeys = new Map();
export const waitedOut = new WeakSet();
export const unpicked = new WeakMap();
export const waitedOutUndrawn = new WeakMap();

export const WAIT_MS = 8000;
export const WAIT_ROUND_MS = 400;
export const AFTER_WAIT_QUIET_MS = 800;
export const LOAD_MS = 60000;
export const LOAD_RESULT_MS = 20000;
export const LOAD_QUIET_MS = 1000;
export const LOAD_HALT = 'The page was still loading after a minute: wait for it, then fill again.';
export const KEPT_WATCH_MS = 15000;
// How long one fill may run in all (audit 2026-11-07, ENG-12): its waits are bounded one by one, but
// a fill making its way through many of them had no end but Stop. Past it the fill stops as on Stop.
export const FILL_BUDGET_MS = 5 * 60 * 1000;
export const BUDGET_HALT = 'The fill ran for 5 minutes and stopped there: check the page, then fill again.';
export const ONCE_UNVERIFIED = 'it was clicked, but the page showed no current premium afterwards. Check the page and click Recalculate yourself: the fill clicks it once a quote.';
export const NOTHING_LEFT = 'nothing left for you on the page';
export const AGENT_PRESSED = 'you clicked a button during the fill: Continue is yours';
// The page stayed after the fill's Continue, quiet: it refused it (its own message says why).
export const CONTINUE_REFUSED = 'the page did not accept Continue: check its message';
export const RESET_QUIET_MS = 1000;

/**
 * Returns a standardized noMatch report object.
 * @param {any} step
 * @param {any[]} options
 * @returns {{ ok: false, code: FailCode, reason: string, options: string[] }}
 */
export const noMatch = (step, options) => ({
  ok: false,
  code: /** @type {FailCode} */ ('option.no-match'),
  reason: `no option matches "${step.value}"`,
  options: options.filter((o) => !isPlaceholderOption(o.text)).map((o) => o.text).slice(0, 25),
});

/**
 * Checks whether summary witness text is visible on the page after a server redraw.
 * @param {any} step
 * @param {PageControl[]} controls
 * @returns {boolean}
 */
export function summaryAccepted(step, controls) {
  if (!step.summaryAfter || !controls.some((c) => c.text === squash(step.summaryAfter))) return false;
  return (document.body.innerText ?? '').split(/\r?\n/).some((line) => {
    const text = squash(line).replace(/^business(?: type)? /, '').replace(/ edit$/, '');
    return [step.value, ...(step.choiceAliases ?? [])].some((value) => text === squash(value));
  });
}

export const {
  assign,
  matchOption,
  matchHow,
  holdingCondition,
  moneyTokens,
  businessNameKey,
  uniqueBusinessNames,
  heldFormNote,
  unitName,
  unitNoun,
  unmatchedRowNote,
  witnessName,
} = createLocator({
  squash,
  humanize,
  STATE_NAMES,
  isPlaceholderOption,
  optionsOf,
  safeMatches,
  shownControl,
  unitFormsOf,
  stepIs,
  stepKey: () => stepKey(),
  currentPage: () => currentPage(),
  extraRowKeys,
});

// Configure adapter create() hooks
setAdapterHooks({ matchOption, noMatch, textFor, hasOptions, labelFor });

// `sleep` ends early once the running fill stops (`halted`): a driver checks it before it writes.
// `halted` also holds the stop of the write running now (apply's `stopped`): an agent's edit while
// a list waits for its options (a plain one, or select2) stops it before the pick (CodeRabbit on #435).
let callerStop = () => false;
const stoppedNow = () => waitsStopped() || callerStop();
const interrupted = () => ({ ok: /** @type {false} */ (false), code: /** @type {FailCode} */ ('fill.interrupted'), reason: INTERRUPTED });
const driverKit = { adapter, withAdapter, deepQueryAll, oneLine, squash, sleep: pause, halted: stoppedNow, interrupted, settle, hasValue, unpicked, optionsOf, matchOption, noMatch, selectedText, multiValue };
const { select2, searchSelect } = createSelect2Drivers(driverKit);

export const drivers = [
  createAddressDriver(driverKit),
  searchSelect,
  { name: 'adapter', writes: (step, c) => !!(c.widget || c.options?.some((o) => o.widget)), write: (step, c) => adapter().apply(step, c) },
  { name: 'read-only', writes: (step, c) => !!c.el.readOnly, write: () => ({ ok: false, code: 'field.read-only', reason: 'the field is read-only (usually a date picker or lookup) — set it by hand' }) },
  select2,
];

/**
 * Applies a plan step value to control c using the matching driver.
 * @param {any} step
 * @param {PageControl} c
 * @param {() => boolean} [stopped]  the caller's own stop, besides the fill's (waitsStopped): the
 *   panel's answers stop at the agent's edit of a question on the page (pagekit `answer`)
 * @returns {Promise<WriteResult>}
 */
export async function apply(step, c, stopped = () => false) {
  const halted = () => waitsStopped() || stopped();
  // Stopped (the agent's Stop, or their edit): nothing more is written.
  if (halted()) return interrupted();
  // The agent typing in another field (audit 2026-11-07, ENG-18): the write waits until they pause
  // (at most TYPING_WAIT_MS), and their field has its focus back after it, which the write's own
  // focus and blur took. An edit of theirs while it waits stops it there (CodeRabbit on #435).
  for (const end = Date.now() + TYPING_WAIT_MS; typingElsewhere(c.el) && Date.now() < end && !halted();) await pause(TYPING_POLL_MS);
  if (halted()) return interrupted();
  const theirs = focusedControl();
  const before = callerStop;
  callerStop = stopped;
  // A wait after it counts its quiet from the write's end at the earliest (settle's `since`).
  noteOwnAction();
  try {
    return await write(step, c);
  } finally {
    noteOwnAction();
    callerStop = before;
    // Only where the write left the focus (on its field, in its widget, or on nothing): a field the
    // agent moved to meanwhile keeps it (CodeRabbit on #435).
    const now = activeNow();
    const writes = !now || now === c.el || !!c.el.contains?.(now) || !!c.widget?.contains?.(now);
    if (theirs && theirs !== c.el && theirs.isConnected !== false && now !== theirs && writes) {
      try { theirs.focus({ preventScroll: true }); } catch { /* gone */ }
    }
  }
}

// How long a write waits for the agent to stop typing in another field, and how often it looks.
export const TYPING_WAIT_MS = 10000;
const TYPING_POLL_MS = 250;

/**
 * Writes a plan step's value into control c with the driver that writes it, or the plain controls' own way.
 * @param {any} step
 * @param {PageControl} c
 * @returns {Promise<WriteResult>}
 */
async function write(step, c) {
  const driver = drivers.find((d) => d.writes(step, c));
  if (driver) return driver.write(step, c);

  if (c.kind === 'select' && /** @type {HTMLSelectElement} */ (c.el).multiple) {
    const options = optionsOf(c);
    const wanted = multiValue(step.value, options);
    const picks = wanted.map((w) => options.find((o) => !o.el.disabled && o.text.toLowerCase() === w.toLowerCase()));
    if (!wanted.length || picks.some((o) => !o)) return noMatch({ ...step, value: wanted.filter((w, i) => !picks[i]).join('; ') || step.value }, options);
    for (const o of options) o.el.selected = picks.includes(o);
    c.el.dispatchEvent(new Event('input', { bubbles: true }));
    c.el.dispatchEvent(new Event('change', { bubbles: true }));
    if (!options.every((o) => o.el.selected === picks.includes(o))) return { ok: false, code: 'answer.not-kept', reason: 'the page did not keep these picks' };
    return { ok: true, shown: picks.map((o) => o.text).join('; ') };
  }

  if (c.kind === 'text') {
    const text = textFor(step, c);
    const hEl = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (c.el);
    if ('maxLength' in hEl && hEl.maxLength > 0 && text.length > hEl.maxLength) return { ok: false, code: 'answer.too-long', reason: `value is longer than the field allows (${hEl.maxLength})` };
    setNativeValue(c.el, text);
    if (hEl.value === '') return { ok: false, code: 'answer.cleared', reason: 'the page cleared the value (it may need a different format)' };
    return { ok: true, shown: hEl.value };
  }

  if (c.kind === 'checkbox') {
    if (typeof step.value !== 'boolean') return { ok: false, code: 'answer.invalid', reason: 'checkbox needs a yes/no answer' };
    const hEl = /** @type {HTMLInputElement} */ (c.el);
    if (hEl.checked !== step.value) hEl.click();
    return { ok: true, shown: step.value ? 'checked' : 'unchecked' };
  }

  let options = optionsOf(c);
  let opt = matchOption(options, step);
  const loading = () => new Set(options.map((o) => oneLine(o.text)).filter(Boolean)).size <= 1;
  for (const start = Date.now(); !opt && c.kind === 'select' && loading() && Date.now() - start < 6000 && !stoppedNow();) {
    await pause(250);
    options = optionsOf(c);
    opt = matchOption(options, step);
  }
  if (stoppedNow()) return interrupted();
  if (!opt) return noMatch(step, options);
  if (c.kind === 'select') setNativeValue(c.el, opt.value);
  else if (!optionOn(opt)) {
    if (opt.host && opt.el.checked) opt.el.checked = false;
    opt.el.click();
  }
  return { ok: true, shown: opt.text };
}

/**
 * Checks whether control c currently reflects the answer given in step.
 * @param {any} step
 * @param {PageControl} c
 * @returns {boolean}
 */
export function agreesWith(step, c) {
  for (const d of drivers) {
    const agrees = d.agrees?.(step, c);
    if (agrees !== undefined) return agrees;
  }
  if (c.kind === 'checkbox') return typeof step.value === 'boolean' && (c.widget ? !!adapter().value(c.widget, c.el) : /** @type {HTMLInputElement} */ (c.el).checked) === step.value;
  if (step.kind === 'selected-option') return /^selected\b/i.test(selectedText(c) ?? '');
  if (c.kind === 'text') {
    const val = /** @type {HTMLInputElement} */ (c.el).value;
    if (loose(val) === loose(textFor(step, c))) return true;
    if (/zip/i.test(step.path ?? '') && /^\d{5}(?:-?\d{4})?$/.test(String(step.value).trim())) {
      const five = (v) => String(v ?? '').replace(/\D/g, '').slice(0, 5);
      return five(val).length === 5 && five(val) === five(step.value);
    }
    if (step.kind === 'money') {
      const amount = (v) => /^\$?\s*\d[\d,]*(?:\.\d{1,2})?\s*$/.test(String(v)) ? Number(String(v).replace(/[$,\s]/g, '')) : null;
      const actual = amount(val), wanted = amount(step.value);
      return actual != null && wanted != null && actual === wanted;
    }
    return oneLine(val) === oneLine(textFor(step, c));
  }
  if (c.kind === 'select' && /** @type {HTMLSelectElement} */ (c.el).multiple) {
    const options = optionsOf(c);
    const set = (texts) => texts.map((t) => t.toLowerCase()).sort().join('\n');
    const picked = set(options.filter((o) => o.el.selected).map((o) => o.text));
    return picked !== '' && picked === set(multiValue(step.value, options));
  }
  const current = selectedText(c);
  const opt = matchOption(optionsOf(c), step);
  return !!opt && oneLine(opt.text) === oneLine(current ?? '');
}

/**
 * The choice control c holds the answer only by a fallback the engine isn't sure of: the one option
 * beginning with the answer's words (`prefix`) or having them (`contains`), none reading exactly so
 * (nor as an alias). What it holds and how, for a check item; else null (an exact answer, another
 * answer, or a text box). The maintainer, 2026-11-07: such an answer is written, and the agent checks it.
 * @param {any} step
 * @param {PageControl} c
 * @returns {{ matched: 'prefix' | 'contains', shown: string } | null}
 */
export function looseMatch(step, c) {
  const current = oneLine(selectedText(c) ?? '');
  if (!current) return null;
  // A type-ahead list's pick: the one result having the answer's words (applySearchSelect).
  if (step.kind === 'search-select') return squash(current) !== squash(step.value) && agreesWith(step, c) ? { matched: 'contains', shown: current } : null;
  if ((c.kind !== 'select' && c.kind !== 'radio') || /** @type {HTMLSelectElement} */ (c.el).multiple) return null;
  const m = matchHow(optionsOf(c), step);
  if (!m || (m.how !== 'prefix' && m.how !== 'contains') || oneLine(m.option.text) !== current) return null;
  return { matched: m.how, shown: current };
}

/**
 * A loose match's check note: the option chosen (or, `kept`, the one the page already had) and how it matched.
 * @param {any} step
 * @param {{ matched: 'prefix' | 'contains', shown: string }} loose
 * @param {boolean} [kept]
 * @returns {string}
 */
export const looseNote = (step, loose, kept = false) => `${step.name}: no option reads exactly "${step.value}", so ${kept ? `the page's "${loose.shown}" was kept` : `"${loose.shown}" was chosen`}, the only one ${loose.matched === 'prefix' ? 'beginning with' : 'containing'} ${step.choiceAliases?.length ? 'it or an alias' : 'it'}. Check it.`;
