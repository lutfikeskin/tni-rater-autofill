// @ts-check
// Pure string, amount, and value comparison helpers with zero DOM dependencies.

import { STATES } from '../states.js';

export const STATE_NAMES = Object.fromEntries(Object.entries(STATES).map(([code, name]) => [code, name.toLowerCase()]));

/**
 * Sleeps for the specified milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalizes text to lower-case alphanumeric words joined by a single space.
 * @param {any} s
 * @returns {string}
 */
export const squash = (s) => String(s ?? '').toLowerCase().replace(/['’*]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Converts camelCase and delimited identifiers into humanized squashed words.
 * @param {any} s
 * @returns {string}
 */
export const humanize = (s) => squash(String(s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]$:]+/g, ' '));

/**
 * Normalizes any whitespace runs into a single space and trims.
 * @param {any} s
 * @returns {string}
 */
export const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Same answer, different formatting: 45000 / "45,000" / "$45,000", 02/03/1988 / 1988-02-03.
 * @param {any} v
 * @returns {string}
 */
export function loose(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/) ?? s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // 1/5/1980, 01/05/1980 and 1980-01-05 are the same date.
  if (m) return m[1].length === 4 ? `d${m[2]}${m[3]}${m[1]}` : `d${m[1].padStart(2, '0')}${m[2].padStart(2, '0')}${m[3]}`;
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A several-choice answer's option texts ("a; b": W43-23). Parts joined by "; " that make one
 * offered option's text are that option (its own text has "; " in it).
 * @param {any} v
 * @param {Array<{ text: string }>} [options]
 * @returns {string[]}
 */
export const multiValue = (v, options = []) => {
  const parts = String(v ?? '').split(/;\s*/).map(oneLine).filter(Boolean);
  const offered = new Set(options.map((o) => oneLine(o.text).toLowerCase()));
  const out = [];
  for (let i = 0; i < parts.length;) {
    let j = parts.length;
    while (j > i + 1 && !offered.has(parts.slice(i, j).join('; ').toLowerCase())) j--;
    out.push(parts.slice(i, j).join('; '));
    i = j;
  }
  return out;
};

/**
 * Whether text represents a placeholder dropdown option.
 * @param {any} text
 * @returns {boolean}
 */
export const isPlaceholderOption = (text) => /^(-+|select\b|choose\b|please\b|\s*$)/i.test(oneLine(text));
