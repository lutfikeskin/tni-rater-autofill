// @ts-check
// Unit form detection, unit list row counting/matching, unit group pager.

import { shownControl, collectControls, hasValue, fieldKey, deepQueryAll, buttonText } from './dom.js';
import { oneLine } from './text.js';
import { withAdapter } from './adapter.js';

/** @import { PageControl } from './dom.js' */
/** @import { PlanStep, UnitPager } from '../../types.js' */

/** @type {any} */
let knownUnitMarkers = null;
export const getKnownUnitMarkers = () => knownUnitMarkers;
export const setKnownUnitMarkers = (markers) => { knownUnitMarkers = markers; };

/** @type {string[]} */
const knownUnitLists = [];
export const getKnownUnitLists = () => knownUnitLists;

/** @type {any} */
let fillUnits = null;
export const getFillUnits = () => fillUnits;
export const setFillUnits = (units) => { fillUnits = units; };

/**
 * Identifies unit forms on screen for each unit list (vehicles, drivers, trailers).
 * @param {PageControl[]} controls
 * @param {PlanStep[]} steps
 * @returns {Array<{ list: string, id: string, marker: PageControl, active: number, count: number, held: boolean, boundTo: number | null }>}
 */
export function unitFormsOf(controls, steps) {
  const out = [];
  for (const step of steps) {
    const s = /** @type {any} */ (step);
    const list = s.whenShown?.unit;
    if (!list || out.some((u) => u.list === list)) continue;
    const marker = shownControl(controls, s.whenShown);
    const id = marker ? String(/** @type {HTMLInputElement} */ (marker.el).name || marker.el.id || '') : '';
    if (!id) continue;
    const bound = fillUnits?.bound?.[list] ?? {};
    const active = fillUnits?.active?.[list] ?? 0;
    const boundTo = Object.hasOwn(bound, id) ? bound[id] : null;
    const activeForm = Object.keys(bound).find((k) => bound[k] === active) ?? null;
    const held = (boundTo != null && boundTo !== active) || (boundTo == null && activeForm != null && activeForm !== id);
    out.push({ list, id, marker, active, count: fillUnits?.count?.[list] ?? 0, held, boundTo });
  }
  return out;
}

/**
 * The unit forms on screen now between fills.
 * @returns {Array<{ list: string, id: string, blank: boolean }> | null}
 */
export function unitFormsNow() {
  if (!knownUnitMarkers) return null;
  try {
    const controls = collectControls();
    const out = [];
    for (const m of knownUnitMarkers) {
      if (out.some((u) => u.list === m.unit)) continue;
      const marker = shownControl(controls, m);
      const id = marker ? String(/** @type {HTMLInputElement} */ (marker.el).name || marker.el.id || '') : '';
      if (id) out.push({ list: m.unit, id, blank: !hasValue(marker) });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Re-marks one field / unit check. Returns which of these items the page shows as whole runs.
 * @param {Array<string | string[]>} items
 * @returns {boolean[]}
 */
export function listed(items) {
  const text = String(document.body?.innerText ?? '').toUpperCase();
  const page = ` ${text.replace(/[^A-Z0-9]+/g, ' ')} `;
  const lines = text.split(/\n+/).map((l) => ` ${l.replace(/[^A-Z0-9]+/g, ' ')} `);
  const word = (w) => String(w ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (items ?? []).map((t) => {
    if (Array.isArray(t)) {
      const words = t.map(word).filter((w) => w.length >= 2);
      return words.length >= 2 && lines.some((l) => words.every((w) => l.includes(` ${w} `)));
    }
    const v = word(t);
    return v.length >= 11 && page.includes(` ${v} `);
  });
}

/**
 * Inspects a unit list table/container on screen by selector.
 * @param {string} selector
 * @param {Array<string | string[]>} items
 * @returns {{ rows: number, shown: boolean[] } | null}
 */
export function unitList(selector, items) {
  if (!knownUnitLists.includes(selector)) knownUnitLists.push(selector);
  const list = /** @type {HTMLElement | undefined} */ (deepQueryAll(document, selector).find((el) => el.getClientRects().length));
  if (!list) return null;
  const text = String(list.innerText ?? '').toUpperCase();
  const flat = ` ${text.replace(/[^A-Z0-9]+/g, ' ')} `;
  const lines = text.split(/\n+/).map((l) => ` ${l.replace(/[^A-Z0-9]+/g, ' ')} `);
  const word = (w) => String(w ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rows = [...list.children].filter((li) => li.tagName === 'LI' && !li.classList.contains('add-state')).length;
  const shown = (items ?? []).map((t) => {
    if (Array.isArray(t)) {
      const words = t.map(word).filter((w) => w.length >= 2);
      return words.length >= 2 && lines.some((l) => words.every((w) => l.includes(` ${w} `)));
    }
    const v = word(t);
    return v.length >= 11 && flat.includes(` ${v} `);
  });
  return { rows, shown };
}

/**
 * Reads all known unit list selectors currently visible on screen.
 * @returns {string}
 */
export function unitListsNow() {
  try {
    return knownUnitLists.map((selector) => {
      const list = [...document.querySelectorAll(selector)].find((el) => el.getClientRects().length);
      return list ? `${selector}:${[...list.children].filter((li) => li.tagName === 'LI' && !li.classList.contains('add-state')).length}` : '';
    }).filter(Boolean).join('|');
  } catch {
    return '';
  }
}

/**
 * Creates a pager helper for navigating grouped unit rows (e.g. Progressive Rates 1-3, 4-5).
 * @param {PlanStep[]} plan
 * @param {UnitPager | null} pager
 * @param {string} startPage
 */
export function makePager(plan, pager, startPage) {
  const on = !!pager?.text && (pager.pages ?? []).includes(startPage);
  const re = on ? new RegExp(pager.text, 'i') : null;
  const unitId = (s) => (s.unit ? `${s.unit.list}:${s.unit.index}` : null);
  const units = new Map(on ? (/** @type {any[]} */ (plan)).filter((s) => s.activeVehicle != null && s.vehicleHint && s.unit && s.pages?.includes(startPage)).map((s) => [unitId(s), s.unit]) : []);
  const seen = new Set();
  let rowsShown = false;
  const keyGroups = new Map();
  const skippedRows = new Map();
  const sharedKey = (key) => (keyGroups.get(key)?.size ?? 0) > 1;
  const elsewhere = new Set();
  const buttons = () => {
    if (!on) return [];
    const hits = deepQueryAll(document, withAdapter('a, button, [role=button]', 'buttons')).filter((el) => el.getClientRects().length && re.test(buttonText(el)));
    return hits.filter((el) => !hits.some((x) => x !== el && el.contains(x))).map((el) => ({
      el, text: oneLine(buttonText(el)),
      current: !!/** @type {HTMLButtonElement} */ (el).disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('tabindex') === '-1' || (!!pager.current && !!el.closest(pager.current)),
    }));
  };
  const shownGroup = () => buttons().find((b) => b.current)?.text ?? null;
  const startGroup = shownGroup();
  const shown = new Set(startGroup ? [startGroup] : []);
  const paged = [];
  let cameBack = false;
  const unitLabel = (unit) => `${unit.list === 'trailers' ? 'Trailer' : 'Vehicle'} ${unit.index + 1}`;
  return {
    on,
    paged,
    noteRound(controls, pairs, skipped) {
      if (!on) return;
      const group = shownGroup() ?? '';
      for (const c of controls) {
        const key = fieldKey(c);
        if (!keyGroups.has(key)) keyGroups.set(key, new Set());
        keyGroups.get(key).add(group);
      }
      for (const p of pairs) {
        const id = unitId(p.step);
        if (!units.has(id)) continue;
        rowsShown = true;
        if (skipped(p.control)) skippedRows.set(p.step.id, { step: p.step, label: p.control.label, key: fieldKey(p.control), unit: id });
        else seen.add(id);
      }
      if (startGroup && group !== startGroup) for (const c of controls) elsewhere.add(fieldKey(c));
    },
    next() {
      if (!on || !rowsShown) return null;
      const all = buttons();
      if (all.length < 2) return null;
      let turn = null;
      if ([...units.keys()].some((u) => !seen.has(u))) turn = all.find((b) => !b.current && !shown.has(b.text)) ?? null;
      if (!turn && !cameBack && startGroup && paged.length) {
        cameBack = true;
        const back = all.find((b) => b.text === startGroup);
        turn = back && !back.current ? back : null;
      }
      if (turn) { shown.add(turn.text); paged.push(turn.text); }
      return turn;
    },
    shows: (text) => !startGroup || shownGroup() === text,
    readElsewhere: (key) => elsewhere.has(key),
    missing() {
      if (!on || !rowsShown) return [];
      const out = [];
      const named = new Set();
      for (const row of skippedRows.values()) {
        if (!sharedKey(row.key)) continue;
        const unit = units.get(row.unit);
        named.add(row.unit);
        out.push({ stepId: row.step.id, label: row.label, path: row.step.path, name: `${row.step.name}: ${unitLabel(unit)}`, unit: unitLabel(unit), key: null, q: null, controlKind: null,
          note: `Not answered for ${unitLabel(unit)}${unit.name ? ` (${unit.name})` : ''}: you changed this coverage on a row of one group of vehicles, and each group's rows share their field names, so the fill can't tell whose row it was and left both. Check it, or answer it yourself.` });
      }
      for (const [id, unit] of units) {
        if (seen.has(id) || named.has(id) || [...skippedRows.values()].some((r) => r.unit === id && !sharedKey(r.key))) continue;
        const label = unitLabel(unit);
        const where = paged.length || buttons().length > 1 ? 'in any group of vehicles on this page' : 'on this page';
        out.push({ label, path: `${unit.list}[${unit.index}]`, name: label, unit: label, key: null, q: null, controlKind: null,
          note: `No row ${where} reads as ${label}${unit.name ? ` (${unit.name})` : ''}: none of its coverages was answered. Check it is on the quote, then answer its coverages yourself.` });
      }
      return out;
    },
  };
}
