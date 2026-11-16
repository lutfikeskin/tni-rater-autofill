// @ts-check
// Grouping a page report's rows into the Review screen's two visible groups ("Needs you" and
// "Worth a look") plus the untouched intake answers counted on the "See all N answers" link.
// Pure decision logic: imports only report-rows.js, with no DOM and no browser globals.

import { rowHead } from './report-rows.js';

/**
 * Returns the display rank inside "Worth a look" (0..3), or -1 when `rec` stays out of
 * "Worth a look" (such as straight-from-intake and derived answers).
 *
 * @param {Record<string, any>} rec
 * @returns {number}
 */
function worthRank(rec) {
  if (rec.kind === 'edited' || rec.kind === 'changed' || Boolean(rec.changed)) return 0;
  if (rec.kind === 'own') return 1;
  if (rec.type === 'need' && (rec.settled === 'answered' || rec.settled === 'picked' || rec.settled === 'ai')) return 1;
  if (rec.type === 'need' && rec.settled === 'marked') return 2;
  if (rec.kind === 'standard') return 3;
  return -1;
}

/**
 * Computes the head summary (`{ icon, value, tag }`) for a row on the Review screen.
 * A need settled as `'marked'` keeps `value` ("Marked done" from `settleRow`) and drops the
 * `'You'` tag so a marked-done item is never presented as an answered value.
 *
 * @param {Record<string, any>} rec
 */
function reviewRowHead(rec) {
  const head = rowHead(rec, rec.source?.tag ?? null);
  if (rec.type === 'need' && rec.settled === 'marked') {
    return { ...head, tag: null };
  }
  return head;
}

/**
 * Partitions a report's `list` into `{ needs, worth, intakeCount, all }`.
 * - `needs`: every non-gone unsettled need (including pending AI picks), in page order, uncapped.
 * - `worth`: Q1 default rows (`edited`, `changed`, `own`, settled `answered`/`picked`/`ai`,
 *   settled `marked`, `standard`), stably ordered by rank while preserving page order per tier.
 *   `intake` and `derived` stay out of `worth`.
 * - `intakeCount`: non-gone `intake` answers unchanged on the page.
 * - `all`: `list` (`all.length === list.length` for "See all N").
 *
 * @param {Array<Record<string, any>>} [list]
 */
function reviewGroups(list = []) {
  /** @type {Array<Record<string, any>>} */
  const needs = [];
  /** @type {Array<{ rec: Record<string, any>, rank: number }>} */
  const worthRanked = [];
  let intakeCount = 0;

  for (const rec of list) {
    if (!rec || rec.gone) continue;
    if ((rec.type === 'need' && !rec.settled) || Boolean(rec.pending)) {
      needs.push(rec);
      continue;
    }
    const rank = worthRank(rec);
    if (rank >= 0) {
      worthRanked.push({ rec, rank });
    } else if (rec.type === 'answer' && rec.kind === 'intake' && !rec.changed) {
      intakeCount += 1;
    }
  }

  worthRanked.sort((a, b) => a.rank - b.rank);
  const worth = worthRanked.map((entry) => entry.rec);

  return { needs, worth, intakeCount, all: list };
}

export { reviewGroups, reviewRowHead };
