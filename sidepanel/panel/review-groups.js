// @ts-check
// Grouping a page report's rows into the Review screen's visible groups ("Needs you",
// "Worth a look", and the remaining filled answers shown right underneath) plus the untouched
// intake answers counted on the "See all N answers" link.
// Pure decision logic: imports only report-rows.js, with no DOM and no browser globals.

import { rowHead, worthRank } from './report-rows.js';

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
 * Partitions a report's `list` into `{ needs, worth, rest, intakeCount, all }`.
 * - `needs`: every non-gone unsettled need (including pending AI picks), in page order, uncapped.
 * - `worth`: Q1 default rows (`edited`, `changed`, `own`, settled `answered`/`picked`/`ai`,
 *   settled `marked`, `standard`), stably ordered by rank while preserving page order per tier.
 *   `intake` and `derived` stay out of `worth`.
 * - `rest`: every other non-gone answered row (`intake`, `derived`, `page`, `clicked`, `yours`,
 *   etc.), in page order, uncapped, rendered beneath `worth` in the same inline-disclosure style.
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
  /** @type {Array<Record<string, any>>} */
  const rest = [];
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
    } else {
      rest.push(rec);
      if (rec.type === 'answer' && rec.kind === 'intake' && !rec.changed) {
        intakeCount += 1;
      }
    }
  }

  worthRanked.sort((a, b) => a.rank - b.rank);
  const worth = worthRanked.map((entry) => entry.rec);

  return { needs, worth, rest, intakeCount, all: list };
}

export { reviewGroups, reviewRowHead };
