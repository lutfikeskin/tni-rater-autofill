// @ts-check
// Turns the raw field map from the TNI "Commercial Insurance Quote Application" PDF into a clean
// client record, plus a list of things the agent should double-check before quoting.
//
// Rule of thumb: clean up formatting, never guess at meaning. Anything ambiguous stays as the
// client wrote it and gets a warning instead.

import { STATES, noPriorInsurance, ownerRow, ownerRowNameDiffers, set, companyName, quotedCarriersOf, priorInsuranceAssumed, priorPolicyExpired, priorPolicyNotAuto } from './util.js';

/** @import { IntakeResult } from '../types.js' */

export const ROWS = [1, 2, 3, 4];
// The marital-status dropdowns have odd hierarchical names; positions on the page put them on
// driver rows 1-4 in this order.
export const MARITAL_FIELDS = ['marital_stat_1.0', 'marital_stat_1.1', 'marital_stat_1.2.0', 'marital_stat_1.2.1'];

const BLANK = /^(n\/?a|none|null|nil|unknown|-+|\.+|select\*?)$/i;
// Radius answers that mean the widest band (the carrier rules map them to "more than 500 miles"):
// unlimited, long haul, nationwide, OTR, "48 states" / "lower 48", anywhere. Whole words only: a
// bare "48" is 48 miles, and "any" must not be found inside "company".
// "48 states" / "lower 48" name an area, and its 48 is not miles.
const STATES_48 = /\b(?:(?:lower|all|continental|contiguous)[\s-]*48|48(?:[\s-]+(?:continental|contiguous|u\.?s\.?))?[\s-]+states?)\b/i;
// The other words say how far in general; an explicit mileage beside them ("anywhere within 100
// miles", "OTR up to 500 miles") is the answer.
const LONG_HAUL_WORDS = /\b(?:unlimited|long(?:[\s-]*(?:haul|distance))?|nation(?:al|wide)?|otr|over[\s-]*the[\s-]*road|any(?:where)?)\b/i;
export const LONG_HAUL = new RegExp(`${STATES_48.source}|${LONG_HAUL_WORDS.source}`, 'i');
export const isLongHaul = (text) => parseRadius(String(text ?? '')).kind === 'long-haul';

// Other distance units need an agent conversion; never treat their number as miles.
const NON_MILE_UNITS = /^(k|km|kms|kilomet(?:er|re)s?|m|met(?:er|re)s?|cm|mm|ft|feet|foot|yds?|yards?|in|inch(?:es)?|nautical|nmi|nm)$/i;
const MILE_UNIT = /^(miles?|mi)$/i;
// A bare number can be followed by these radius descriptions, rather than a unit. With an
// explicit mile unit, other prose may follow too; another distance unit is still unresolved.
const RADIUS_PROSE = /^(radius|of|one|away|maximum|max|distance|round)$/i;
const NOT_DISTANCE = /^(states?|hrs?|hours?|mins?|minutes?|days?|weeks?|counties|cities)$/i;

/**
 * The intake's radius box, read as a number of miles. The 48 in "48 states" / "lower 48" is
 * geography, not mileage; read any other digits normally. A single mileage beats the other long-haul words ("anywhere within 100
 * miles" is 100); without one, those words are long haul. A range ("100-500 miles", "100 miles to 500 miles", "100mi-500mi"), a
 * non-mile unit ("250 km", "100 feet"), a mileage followed by another number, and text that isn't a distance
 * give no mileage, and the normalizer asks the agent for it.
 * @returns {{ miles: number|null, kind: 'missing'|'long-haul'|'miles'|'range'|'unit'|'text' }}
 */
export function parseRadius(v) {
  let s = clean(v);
  if (s == null) return { miles: null, kind: 'missing' };
  if (STATES_48.test(s)) {
    s = s.replace(new RegExp(STATES_48.source, 'gi'), '');
    if (!/\d/.test(s)) return { miles: null, kind: 'long-haul' };
  }
  const read = readMiles(s);
  if (!/\d/.test(s) && LONG_HAUL_WORDS.test(s)) return { miles: null, kind: 'long-haul' };
  return read;
}

/** @returns {ReturnType<typeof parseRadius>} */
function readMiles(s) {
  const digits = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const m = digits.match(/^\D*?(\d+(?:\.\d+)?)\s*\+?\s*(?:-?\s*(?:(?:in[\s-]+state|interstate)[\s-]+)?(miles?|mi)\b\.?\s*)?(?:(?:-|–|—|to|through|thru|and)\s*(\d+(?:\.\d+)?))?\s*(?:-\s*)?([a-z]+)?/i);
  if (!m) return { miles: null, kind: 'text' };
  const [, from, mileUnit, to, word] = m;
  if (word && NOT_DISTANCE.test(word)) return { miles: null, kind: 'text' };
  // After an explicit mile unit, 'in' introduces location prose; by itself it can mean inches.
  const nonMileUnit = word && NON_MILE_UNITS.test(word) && !(mileUnit && /^in$/i.test(word));
  if (word && (nonMileUnit || (!mileUnit && !MILE_UNIT.test(word) && !RADIUS_PROSE.test(word)))) return { miles: null, kind: 'unit' };
  if (to != null) return { miles: null, kind: 'range' };
  // One mileage only when no other number is left over ("100 miles / 500 miles" is not 100).
  if (/\d/.test(digits.slice(m.index + m[0].length))) return { miles: null, kind: 'text' };
  const miles = Math.round(Number(from));
  return miles > 0 ? { miles, kind: 'miles' } : { miles: null, kind: 'text' };
}

export function clean(v) {
  if (v == null || typeof v !== 'string') return v ?? null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s === '' || BLANK.test(s) ? null : s;
}

export function cleanMultiline(v) {
  if (typeof v !== 'string') return null;
  const lines = v.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

export function yesNo(v) {
  const s = clean(v);
  if (s == null) return null;
  if (/^(y|yes|true)$/i.test(s)) return true;
  if (/^(n|no|false)$/i.test(s)) return false;
  return null;
}

export function toInt(v) {
  const s = clean(v);
  if (s == null) return null;
  const m = s.match(/^\D*?(\d+)\b/);
  return m ? Number(m[1]) : null;
}

// "40,000$" -> 40000, "$100K" -> 100000, "1.5M" -> 1500000
export function toMoney(v) {
  if (typeof v === 'number') return v;
  const s = clean(v);
  if (s == null) return null;
  const m = s.replace(/[\s,$]/g, '').match(/^(\d+(?:\.\d+)?)(k|m)?(?:usd|dollars?)?$/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

// Returns "MM/DD/YYYY" or null.
export function toDate(v) {
  const s = clean(v);
  if (s == null) return null;
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})$/);
  if (!m) return null;
  let [, mm, dd, yy] = m;
  if (yy.length === 2) yy = (Number(yy) > 40 ? '19' : '20') + yy;
  const d = new Date(Number(yy), Number(mm) - 1, Number(dd));
  if (d.getMonth() !== Number(mm) - 1 || d.getDate() !== Number(dd)) return null;
  return `${mm.padStart(2, '0')}/${dd.padStart(2, '0')}/${yy}`;
}

export function toPhone(v) {
  const s = clean(v);
  if (s == null) return null;
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}

const VIN_MAP = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// Returns null when the VIN looks right, otherwise a short reason.
export function vinProblem(vin) {
  if (vin.length !== 17) return `has ${vin.length} characters (should be 17)`;
  if (/[IOQ]/.test(vin)) return 'contains I, O or Q, which VINs never use (often a typo for 1 or 0)';
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return 'contains characters that are not allowed in a VIN';
  const sum = [...vin].reduce((acc, ch, i) => acc + (/\d/.test(ch) ? Number(ch) : VIN_MAP[ch]) * VIN_WEIGHTS[i], 0);
  const check = sum % 11 === 10 ? 'X' : String(sum % 11);
  return vin[8] === check ? null : 'fails the check-digit test (likely a typo)';
}

const STREET_SUFFIX = new Set(['st', 'street', 'ave', 'av', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'ct', 'court', 'cir', 'ci', 'circle', 'blvd', 'boulevard', 'way', 'pl', 'place', 'ter', 'terrace', 'pkwy', 'parkway', 'hwy', 'highway', 'trl', 'trail', 'loop', 'sq', 'pike', 'tpke', 'cv', 'cove', 'xing', 'plz', 'aly', 'row', 'run']);
const DIRECTIONAL = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'north', 'south', 'east', 'west']);
const UNIT_WORD = /^(apt|apartment|unit|ste|suite|lot|bldg|building|rm|room|trlr|#)\.?$/i;

// Splits a one-line US address. `confident` is false when there were no commas and the city had
// to be inferred from where the street part seems to end, or when trailing ZIP junk was dropped.
// A directional glued to the city ("SWCARTERSVILLE") stays in the city for the agent to confirm:
// without a list of cities it can't be told from NEWARK or SEATTLE (TNI, 2026-10-27).
export function parseAddress(raw) {
  const s = clean(raw);
  if (s == null) return null;
  const out = { street: s, unit: null, city: null, state: null, zip: null, confident: false };
  // What follows the ZIP: a comma or period ("…, MN 55447,"), the country ("…, MN 55447, USA"), or
  // leftover text the form glued on (a county: "… 30120-5877BARTOW"; TNI, 2026-10-27).
  const body = s.replace(/[\s,.;]+(?:(?:USA|U\.S\.A\.?|US|U\.S\.?|United States(?: of America)?)[\s,.;]*)?$/i, '');
  const m = body.match(/^(.*?)[,\s]+([A-Za-z]{2})\.?[,\s]+(\d{5})(?:-?(\d{4}))?(?![0-9])(?:\s*[A-Za-z].*)?$/);
  if (!m || !STATES[m[2].toUpperCase()]) return out;
  out.state = m[2].toUpperCase();
  out.zip = m[4] ? `${m[3]}-${m[4]}` : m[3];
  // Trailing letters after the ZIP were ignored (county / leftover).
  const zipEnd = body.search(/\b\d{5}(?:-?\d{4})?(?![0-9])/);
  const afterZip = zipEnd >= 0 ? body.slice(zipEnd).replace(/^\d{5}(?:-?\d{4})?/, '') : '';
  const repaired = /[A-Za-z]/.test(afterZip);
  const rest = m[1].replace(/,\s*$/, '');
  let streetPart = rest;
  if (rest.includes(',')) {
    const parts = rest.split(',').map((p) => p.trim()).filter(Boolean);
    out.city = parts.pop() ?? null;
    streetPart = parts.join(', ');
    out.confident = parts.length > 0;
  } else {
    const t = rest.split(/\s+/);
    let cut = -1;
    for (let i = 1; i < t.length - 1; i++) {
      if (UNIT_WORD.test(t[i])) { cut = i + 1; break; }
      if (/^#\w+/.test(t[i])) { cut = i; break; }
      if (cut < 0 && STREET_SUFFIX.has(t[i].toLowerCase().replace(/\.$/, ''))) {
        cut = DIRECTIONAL.has(t[i + 1]?.toLowerCase()) ? i + 1 : i;
      }
    }
    if (cut >= 0 && cut < t.length - 1) {
      streetPart = t.slice(0, cut + 1).join(' ');
      out.city = t.slice(cut + 1).join(' ');
    }
  }
  const u = streetPart.match(/^(.*?)[,\s]+((?:apt|apartment|unit|ste|suite|lot|bldg|building|rm|room|trlr)\.?\s*#?\s*[\w-]+|#\s*[\w-]+)$/i);
  if (u) { out.street = u[1]; out.unit = u[2]; } else out.street = streetPart;
  // "12 Main St, Apt 5 Orlando, FL": the unit written after the comma, in front of the city.
  // Its number needs a digit, so a city like "Ste Genevieve" stays whole.
  const lead = !out.unit && out.city?.match(/^((?:apt|apartment|unit|ste|suite|lot|bldg|building|rm|room|trlr)\.?\s*#?\s*[\w-]*\d[\w-]*|#\s*[\w-]+)\s+(\S.*)$/i);
  if (lead) { out.unit = lead[1]; out.city = lead[2]; }
  // "Ci" isn't a street suffix; clients mean "Cir" (and USDOT records say CIR).
  out.street = out.street.replace(/\bCi\.?$/i, 'Cir');
  if (repaired) out.confident = false;
  return out;
}

// "$100K/$1K Ded" -> { limit: 100000, deductible: 1000 }
export function parseLimitDeductible(v) {
  const s = clean(v);
  if (s == null) return { limit: null, deductible: null };
  const [a, b] = s.split('/');
  return { limit: toMoney(a?.replace(/ded.*/i, '')), deductible: b ? toMoney(b.replace(/ded.*/i, '')) : null };
}

// License numbers are entered plain: letters (rare) and digits only, never dashes or spaces.
const plain = (s) => String(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

// Words that name a non-trucking liability (NTL) customer in the claims box, and the line the
// intake's review item quotes (the first that has them).
export const NTL_WORDS = /\b(ntl|non[\s-]*tr[ua]ck(ing)?|bob[\s-]*tail(ing)?)\b/i;
// The intake's free text: the claims box and, on the form since 2026-10, the Additional Notes box.
// Clients answer other questions and ask for coverage in either, so notes are read from both.
export const intakeNotes = (record) => [record?.claims?.text, record?.notes?.text].filter(Boolean).join('\n') || null;
// The same without the claims box's own yes/no answer: its other lines and the Additional Notes box.
export const otherNotes = (record) => [record?.claims?.notes, record?.notes?.text].filter(Boolean).join('\n') || null;

// How long the client has been with their insurer, when a line of the intake's notes says so. TNI
// (2026-10-26, W44-29): "Prior Insurance is always assumed 1-3 years at least", so a longer time
// the intake gives isn't shortened, and a shorter one stays 1-3 years (W44-02). A line counts when
// it names insurance (insured, insurance, insurer, a policy, POP, proof of prior, or the current
// carrier by name) with a number of years ("6 years", "five yrs"; not a vehicle's age, the years
// in business or experience) or a start ("since 2019", "since March 2020", "started in December
// 2025"). The longest such time, in years to one decimal, its line, and the least it could mean
// (TNI, 2026-10-26: answer to PR question: the carriers pick the band a longer time falls in, so
// a year alone runs from its first day to its last, "over 10 years" has no end, "almost 5 years"
// is under 5); null when no line gives one. "About", "around" or "approximately" N is N (TNI,
// 2026-10-26: answer to PR question, round 2, R8, as "about N" is N for the intake's other
// figures), and "roughly N" too (TNI, 2026-10-26: answer to PR question, round 3, T5; until then
// half a year either side); "over N" (more than N) stays as before, with no end. Hedges read as their words (TNI, 2026-10-27: answer to PR question, round 5, V6): "~",
// "approx." / "approx" / "approximately", "abt", "est." / "estimated", "circa", "Nish" ("5ish"),
// "N or so" and "give or take" are "about N", so N; ">", "N plus" and "N+" are "over N" (until
// then "N+" was N or more, and ">5" was read as 5); "<" is "under N" (until then "<5" was read as
// 5). "Some" and "ca." are "about N" too, and "maybe N" and "up to N" give any time, so the line is
// the agent's (the maintainer, 2026-10-27: answer to PR question; until then all four were N), as
// do "perhaps N", "possibly N" and "N years maybe"; "N years or more" is "N+", over N (answer to
// PR follow-up, the same day; until then N). A word not named stays unread (the number alone). A range ("3-5 years", "3 to 5 years", "three to
// five years"; also "between 3 and 5 years", "3 or 4 years" and "1 year to 2 years", the
// maintainer, 2026-10-27: answer to PR question, until then each figure alone, the longest kept)
// runs from its first figure to its last, so a carrier answers it only when both ends give the
// same answer there (TNI, 2026-10-27: answer to PR question, round 5, V7; until then the last
// figure alone was read). The carriers place a time on a band edge (tenureBand).
const TENURE_NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const INSURANCE_WORDS = /\b(?:insur\w*|polic(?:y|ies)|pop|proof of prior)\b/i;
const OTHER_YEARS = /\b(?:claims?|accidents?|violations?|tickets?|cdl|licen[cs]ed?|driv(?:e|es|ing|er|ers)|experience|business|established|trucks?|vehicles?|vans?|trailers?|record|laps\w*|uninsured|no insurance|not insured|without insurance|ago|expir\w*|renew\w*)\b/i;
const NUMBER_SAID = String.raw`\d{1,2}(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty`;
// [1] a symbol before the number (~ > <), [2] a word before it, [3] a range's first figure after
// "between" ("between 3 and 5 years"), [4] a range's first figure ("3-5", "3 to 5", "3 or 4", "1
// year to 2 years"), [5] the number, [6]-[9] a hedge after it ("+", "plus", "ish", "or so"), [10] a
// hedge after "years" ("or so", "give or take", "maybe", "or more").
const YEARS_SAID = new RegExp(String.raw`(?:([~><])\s*|\b(over|more than|at least|almost|nearly|close to|under|less than|about|around|approximately|approx\.?|abt\.?|est\.?|estimated|circa|ca\.|some|roughly|give or take|maybe|perhaps|possibly|up to)\s+)?(?:\bbetween\s+(${NUMBER_SAID})(?:\s*(?:years?|yrs?))?\s+and\s+|\b(${NUMBER_SAID})(?:\s*(?:years?|yrs?))?\s*(?:[-–—]|to\b|or\b)\s*)?\b(${NUMBER_SAID})(?:\s*(\+)|\s+(plus)\b|-?(ish)\b|\s+(or so)\b)?\s*(?:years?|yrs?)\b(?:,?\s+(or so|give or take|maybe|or more)\b)?(?![\s-]*(?:old|in business|of experience|experience|exp\b))`, 'gi');
/** @param {string} s */
const yearsNumber = (s) => TENURE_NUMBER_WORDS[s.toLowerCase()] ?? Number(s);
const START_SAID = /\b(?:since|started|began|start(?:ing)?)\s+(?:(?:in|on)\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?|(\d{1,2})\/(?:(\d{1,2})\/)?)?((?:19|20)\d{2})\b/gi;
// The least and the most a number of years said with its qualifier ("over", "+", "almost", …) can
// mean. TNI, 2026-10-27 (answer to PR question, round 5, V6): a hedge reads as its word: ">", "+"
// and "plus" as "over", "<" as "under", the others named above as "about". The maintainer,
// 2026-10-27 (answer to PR follow-up): "N years or more" as "N+", so "over".
const OVER = new Set(['over', 'more than', '>', '+', 'plus', 'or more']);
const UNDER = new Set(['under', 'less than', '<']);
// The maintainer, 2026-10-27 (answers to PR question and follow-up): "maybe N", "up to N",
// "perhaps N", "possibly N" and "N years maybe" give any time, so no band fits and the line is the
// agent's.
const ANY_TIME = new Set(['maybe', 'up to', 'perhaps', 'possibly']);
/** @param {number} n @param {string | undefined} qualifier @returns {number[]} */
const saidSpan = (n, qualifier) => {
  const q = String(qualifier ?? '').toLowerCase().replace(/\s+/g, ' ');
  if (q === 'at least') return [n, Infinity];
  if (OVER.has(q)) return [n + 0.1, Infinity];
  if (q === 'almost' || q === 'nearly' || q === 'close to') return [n - 1, n - 0.1];
  if (UNDER.has(q)) return [0, n - 0.1];
  // The maintainer, 2026-10-27 (answer to PR question): "maybe N" and "up to N" make the line the
  // agent's, whatever N: any time, so no band fits it (until then N). So do "perhaps N", "possibly
  // N" and "N years maybe" (answer to PR follow-up, the same day).
  if (ANY_TIME.has(q)) return [0, Infinity];
  // TNI, 2026-10-26 (answer to PR question, round 2, R8): "about 3 years" counts as 3, as do
  // "around" and "approximately". TNI, 2026-10-26 (answer to PR question, round 3, T5): "roughly
  // N" counts as N, like "about N" (until then half a year either side). TNI, 2026-10-27 (answer
  // to PR question, round 5, V6): so do "~", "approx.", "abt", "est.", "estimated", "circa",
  // "Nish", "N or so" and "give or take". The maintainer, 2026-10-27 (answer to PR question): and
  // "some" and "ca." ("some 5 years", "ca. 5 years": 5, as the number alone gave before).
  return [n, n];
};
// A match of YEARS_SAID as [least, most]: its qualifier is the symbol or word before the number,
// else the hedge after it. A range spans its first figure's least to its last figure's most, so a
// carrier's band answers it only when both ends fall in it (TNI, 2026-10-27: answer to PR
// question, round 5, V7), also one said "between 3 and 5 years", "3 or 4 years" or "1 year to 2
// years" (the maintainer, 2026-10-27: answer to PR question).
/** @param {RegExpMatchArray} m @returns {number[]} */
const yearsSpan = (m) => {
  const qualifier = m[1] ?? m[2] ?? m[6] ?? m[7] ?? m[8] ?? m[9] ?? m[10];
  const last = saidSpan(yearsNumber(m[5]), qualifier);
  const first = m[3] ?? m[4];
  return first == null ? last : [saidSpan(yearsNumber(first), qualifier)[0], last[1]];
};
const tenth = (n) => Math.round(n * 10) / 10;
/** @param {any} record @returns {{ years: number, least: number, line: string } | null} */
export const insurerTenure = (record) => {
  const carrier = String(record?.priorInsurance?.[0]?.carrier ?? '').trim().toLowerCase();
  const applied = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(record?.applicant?.applicationDate ?? '');
  const now = applied ? Date.UTC(+applied[3], +applied[1] - 1, +applied[2]) : Date.now();
  const YEAR = 365.25 * 24 * 3600 * 1000;
  /** @type {{ years: number, least: number, line: string } | null} */
  let longest = null;
  for (const text of String(intakeNotes(record) ?? '').split('\n')) {
    const line = text.trim();
    if (!INSURANCE_WORDS.test(line) && !(carrier.length >= 3 && line.toLowerCase().includes(carrier))) continue;
    /** @type {number[][]} [least, most] */
    const spans = [...line.matchAll(YEARS_SAID)].map(yearsSpan);
    for (const m of line.matchAll(START_SAID)) {
      const month = m[1] ? MONTH_NAMES.indexOf(m[1].toLowerCase()) : m[3] ? Number(m[3]) - 1 : null;
      if (month != null && (month < 0 || month > 11)) continue;
      const year = Number(m[5]);
      const day = Number(m[2] ?? m[4]) || null;
      const first = Date.UTC(year, month ?? 0, day ?? 1);
      const last = day ? first : month != null ? Date.UTC(year, month + 1, 1) : Date.UTC(year + 1, 0, 1);
      spans.push([(now - last) / YEAR, (now - first) / YEAR]);
    }
    // A line that also names something else with years (claims, CDL or driving, the business, a
    // vehicle, a lapse, an expiration) may give that time, not the time with the insurer: any
    // time, so no band fits it and both carriers leave it to the agent, the line quoted (PR #194
    // review: "No insurance claims in 5 years" was GEICO's 5-10 Years).
    if (spans.length && OTHER_YEARS.test(line)) spans.splice(0, spans.length, [0, Infinity]);
    for (const [least, most] of spans) {
      if (!(most >= 0) || (longest && most <= longest.years)) continue;
      longest = { years: tenth(most), least: tenth(Math.max(least, 0)), line };
    }
  }
  return longest;
};
// The carrier's band for a time with the insurer read from the notes (insurerTenure), by its
// `band` (a number of years to its band's label; a time on the edge two bands share, as GEICO's
// 3-5 and 5-10 share 5, takes the upper one, TNI, 2026-10-26: answer to PR question, round 2, R5):
// the one band both the least and the most the time could mean fall in, else null (TNI,
// 2026-10-26: answer to PR question: a time the bands can't place stays the agent's).
/** @param {{ years: number, least: number }} tenure @param {(years: number) => string | null} band @returns {string | null} */
export const tenureBand = (tenure, band) => { const label = band(tenure.least); return label != null && label === band(tenure.years) ? label : null; };

// The form's auto liability answer Non-Trucking (Select / Yes / No / Non-Trucking): the client asks
// for non-trucking liability (the maintainer, 2026-10-26). Also as written on older forms.
export const nonTruckingAnswer = (v) => /^\s*non[\s-]*trucking\s*$/i.test(String(v ?? ''));
// "Does this driver have a CDL?": the intake's answer; a blank box is No (TNI's standard, the
// maintainer, 2026-10-26), unless a CDL year is filled in: then the agent's (`cdl.blank-with-year`).
// No driver: nothing.
export const cdlStandard = (driver) => !!driver && typeof driver.cdl !== 'boolean' && driver.cdlYear == null;
export const cdlAnswer = (driver) => (cdlStandard(driver) ? false : typeof driver?.cdl === 'boolean' ? driver.cdl : null);
export const ntlMention = (text) => String(text ?? '').split('\n').find((line) => NTL_WORDS.test(line))?.trim() || null;
export const NTL_RATES = 'On Progressive, with cargo or general liability too, the rest of Rates is yours.';
export const ntlCheckMessage = (line) => `Notes mention non-trucking liability (NTL): "${line}". If the client wants it, set it to Yes. ${NTL_RATES}`;
// The intake's info item when the form's auto liability is Non-Trucking (coverage.ntl-form).
export const NTL_FORM_MESSAGE = `Auto liability is Non-Trucking, so Non-trucking liability is set to Yes. ${NTL_RATES}`;
// NTL and cargo both asked for (the maintainer, 2026-10-26): an NTL client is leased on to a motor
// carrier, which covers the cargo, so the agent confirms it with the client. Every carrier.
export const ntlWithCargo = (record) => record?.coverage?.ntl === true && record?.coverage?.cargo === true;
export const NTL_CARGO_MESSAGE = 'NTL and cargo both asked for. The motor carrier usually covers cargo: confirm with the client, or set Cargo to No.';
// NTL mentioned in the claims box or the notes (or flagged by Luna, claims.aiNtl) and not answered
// yet, Yes or No: a mention is not a request, the agent decides on the Intake step. Every carrier.
export const ntlUndecided = (record) => record?.coverage?.ntl == null && (!!ntlMention(intakeNotes(record)) || record?.claims?.aiNtl === true);
// NTL and primary auto liability (auto liability Yes) both asked for.
export const ntlWithPrimary = (record) => record?.coverage?.ntl === true && /^\s*yes\s*$/i.test(String(record?.coverage?.autoLiability ?? ''));
// An NTL quote, as TNI's USDOT and filings answers read it (TNI, 2026-10-26, W44-28: "US DOT is not
// added and filings not added if its NTL, in every case"): NTL asked for, with or without cargo or
// general liability, and without primary auto liability (below). Every carrier.
export const ntlNoDotFilings = (record) => record?.coverage?.ntl === true && !ntlWithPrimary(record);
// (TNI, 2026-10-26: answer to PR question) NTL with primary auto liability too is an intake check
// naming the conflict (`coverage.ntl-primary`), and on every carrier its USDOT and filings questions
// are the agent's: no answer, with the note below.
export const NTL_PRIMARY_MESSAGE = 'Both non-trucking liability (NTL) and primary auto liability asked for. Confirm which one; until then USDOT and filings questions are yours.';
// (TNI, 2026-10-26: answers to PR questions) Why the carriers' USDOT and filings questions are left
// to the agent, or null: NTL with primary auto liability (the agent's), or NTL mentioned and not
// answered yet (they wait for the answer; once it is Yes or No, the next fill answers them).
export const ntlDotFilingsHold = (record) => (ntlWithPrimary(record)
  ? 'Non-trucking liability (NTL) and primary auto liability are both asked for, and TNI adds no USDOT number and no filings on an NTL quote alone: answer this yourself.'
  : ntlUndecided(record)
    ? 'The claims box or notes mention non-trucking liability (NTL), not answered yet: set it to Yes or No on the Intake step first, then fill this page again (TNI adds no USDOT number and no filings on an NTL quote).'
    : null);
// The intake's info item when an NTL intake asks for filings or gives a USDOT number (coverage.ntl-filings).
export const ntlFilingsMessage = (record) => `NTL quote: TNI adds no USDOT and no filings. ${record?.operations?.filingsRequired === true
  ? `Filings are answered No${record?.applicant?.dot ? ' and the USDOT number is left out' : ''}.`
  : 'The USDOT number is left out, and "has a USDOT number" is answered No.'}`;

// Words in the claims notes that answer the ownership question. Only the form's three answers
// are taken as the answer; the others count as mentions, so "on a lease, truck owned" is not
// read as owned.
const OWNERSHIP_WORDS = /\b(owned|leased?|leasing|financed?|financing|loan)\b/gi;
const OWNERSHIP_ANSWERS = { owned: 'Owned', leased: 'Leased', financed: 'Financed' };
const NEGATION = /\b(not|no|never|without|none)\b|n't\b/i;
const TRAILER_WORD = /\btrailers?\b/i;
const ownershipLines = (text) => String(text ?? '').split('\n').filter((line) => new RegExp(OWNERSHIP_WORDS.source, 'i').test(line));

// The claims box's first line saying the client's record is clean ("CLEAN", "Clean record",
// "all clean"): no claims, an explicit No like "No" (TNI, 2026-10-26, W44-32). Only as the line's
// whole answer: "Clean-up company" or "clean except one ticket" don't answer it.
const CLAIMS_CLEAN = /^(?:all\s+)?clean(?:\s+(?:record|mvr|driving\s+record))?\.?$/i;

// "NEW" as the whole answer in the years-under-own-authority box: 0 years, a new authority (TNI,
// 2026-10-26: answer to PR question). AmWINS' "federal authority active" is then LESS THAN 1 YEAR.
// Also "New authority", "Brand new" and "New venture", as the whole answer, in any case, with a
// final period (TNI, 2026-10-26: answer to PR question, R15); "new trucks" or "New authority
// pending" is not 0.
const NEW_AUTHORITY = /^(?:(?:brand[\s-]+)?new|new[\s-]+(?:authority|venture))\.?$/i;

// Years in business stated in the notes, read when the form gives no year established (TNI,
// 2026-10-26, W44-09: "the reader takes it from the notes"; also over years under own authority): "3+ years in business", "in Biz for 3+ years",
// "in business for 5 years" (a plus is at least that many: 3+ is 3), and a start year:
// "established 2019", "founded in 2019", "in business since 2019". Narrow on purpose: only a
// whole number of years or months, in digits or words (T8, below), right beside "in business" /
// "in biz" ("in the business" is a career in
// the trade), in a clause saying nothing about driving, a CDL, experience, authority, insurance or
// claims, and with no negation. Two figures that disagree settle nothing. What settles nothing is
// the agent's with the check naming the line (TNI, 2026-10-27: round-6 answer 4, like a
// range), not the blank standard, which is for notes that say nothing of the business's time.
// A word before the figure: "over", "about", "around", "more than" and "approximately" (or
// "approx.") read as the figure itself, "over 3 years" is 3, with the check quoting the phrase
// (TNI, 2026-10-26: answer to PR question). "less than 1 year" and "under 1 year" are 0, a new
// venture (TNI, 2026-10-26: answer to PR question, R10); any other "less than N" or "under N"
// settles nothing, nor do "almost", "nearly" and ~ < >. A decimal is rounded down ("1.5 years" is
// 1: round-6 answer 3, below).
const QUALIFIER = '(?:(?:less|more)\\s+than|over|under|almost|nearly|about|around|approx(?:imately|\\.)?|[~<>])';
const AS_THE_FIGURE = /^(?:over|about|around|more\s+than|approx(?:imately|\.)?)$/i;
const BELOW = /^(?:less\s+than|under)$/i;
// Months are whole years, rounded down: "18 months" is 1, "6 months" is 0 (TNI, 2026-10-26: answer
// to PR question, R11), also after a word read as the figure: "over 18 months" is 1, "about 6
// months" is 0 (TNI, 2026-10-26: answer to PR question, T7, confirmed).
// "less than N months" with N up to 12 is 0 (TNI, 2026-10-26: answer to PR question, T8); more
// than 12 months settles nothing. "under" reads exactly as "less than" does: "under 6 months" is 0
// (TNI, 2026-10-27: answer to PR question U1), "under 18 months" settles nothing.
const MAX_MONTHS_BELOW_A_YEAR = 12;
// A number in words reads as its digits (TNI, 2026-10-26: answer to PR question, T8): "two years
// in business" is 2, "less than one year" is 0, up to ninety-nine ("twenty-five"). A word
// right after a hyphen ("five" in "twenty-five") is never a figure of its own, nor is the end of a
// range ("two-three", "two to three", "two or three", "two and three years"): a range is read whole
// (V7, below).
// The definite phrases (TNI, 2026-10-27: answer to PR question V11): "a year" is 1, "half a year" 0,
// "a year and a half" 1, "less than a month" and "under a month" 0 (and "less than a year", "under a
// year" 0, U1), "first year in business" 0. "a" is a figure only before year (or yr), not in "a year
// ago", "once a year" or "a year-old truck", and before a month only after "less than" or "under"
// (until round-6 answer 3, below). "a few years" and "several years" settle nothing.
// The clear phrases V11 doesn't name (TNI, 2026-10-27: round-6 answer 3): "a month" and
// "about a month" in business are 0 ("a" before a month as before a year, not in "a month ago" or
// "once a month"), "1st year" 0 and "second year" 1, "less than half a year" 0 (and "under", U1), and
// "one and a half years", "1 year and a half" and "1.5 years" 1, rounded down like months (so "2.5
// years" is 2). "a couple of years" and "under a year and a half" settle nothing: the agent's
// (round-6 answer 4, below).
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_WORDS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const UNIT_WORDS = NUMBER_WORDS.slice(1, 10);
const WORD_NUMBER = `(?:(?:${TENS_WORDS.join('|')})(?:[\\s-]+(?:${UNIT_WORDS.join('|')}))?|${NUMBER_WORDS.join('|')})`;
const RANGE_SEP = '\\s*(?:[-–—]|\\b(?:to|or|and)\\b)\\s*';
const RANGE_END = `(?<!(?:\\d|\\b(?:${[...NUMBER_WORDS, ...TENS_WORDS].join('|')}))\\s*\\+?${RANGE_SEP})`;
const IN_WORDS = `(?<![\\w-])${RANGE_END}${WORD_NUMBER}(?![\\w-])`;
const A_YEAR = '(?=\\s+(?:year|yr)\\b(?!-)(?!\\.?\\s+ago\\b))';
const A_MONTH = '(?=\\s+(?:months?|mos?)\\b(?!-)(?!\\.?\\s+ago\\b))';
const DIGITS = '\\d{1,3}(?:\\.\\d{1,2})?';
const NUMBER = `${DIGITS}|${IN_WORDS}|(?<![\\w-])half\\s+a${A_YEAR}|(?<![\\w-])(?<!\\b(?:half|once|twice)\\s+)a${A_YEAR}`
  + `|(?<![\\w-])(?<!\\b(?:half|once|twice)\\s+)a${A_MONTH}`;
const numberValue = (s) => {
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (/^a$/i.test(s)) return 1;
  if (/^half/i.test(s)) return 0.5;
  const [tens, units] = s.toLowerCase().split(/[\s-]+/);
  const t = TENS_WORDS.indexOf(tens);
  return t < 0 ? NUMBER_WORDS.indexOf(tens) : 20 + t * 10 + (units ? NUMBER_WORDS.indexOf(units) : 0);
};
// Years plus months are the whole years, the months dropped: "1 year 6 months" and "2 years, 6
// months" in business are 1 and 2 (TNI, 2026-10-26: answer to PR question, T8), also after "over"
// or "about": "over 1 year 6 months" is 1 (TNI, 2026-10-27: answer to PR question V10, confirmed).
const MONTHS = /^mo/i;
const YEARS_UNIT = '(?:years?|yrs?)';
const MONTHS_UNIT = '(?:months?|mos?)';
const AND_MONTHS = `[\\s,&]*(?:and\\s+)?(?<months>${NUMBER})\\s*\\+?\\s*(?<monthsUnit>${MONTHS_UNIT})\\b\\.?`;
// "a year and a half" (V11): 1; also "1 year and a half" and "one and a half years" (round-6 answer 3).
const AND_A_HALF = '(?:(?<=(?:year|yr)s?\\.?)(?<half>\\s+and\\s+a\\s+half)\\b)?';
const YEARS = `(?:(?<word>${QUALIFIER})\\s*)?(?<n>${NUMBER})(?<halfBefore>\\s+and\\s+a\\s+half)?\\s*\\+?\\s*(?<unit>${YEARS_UNIT}|${MONTHS_UNIT})\\b\\.?${AND_A_HALF}(?:(?<=${YEARS_UNIT}\\.?)${AND_MONTHS})?`;
// A range (TNI, 2026-10-27: answer to PR question V7): an answer only when both ends give the same
// one. Years in business is a number, so "2-3 years in business" is the agent's, with the check
// naming the line (before, it read the last figure, 3), in words too ("two to three years"); ends
// that round to the same whole years ("18-20 months", both 1) give that number.
const RANGE_FIRST = `${DIGITS}|(?<![\\w-])${WORD_NUMBER}(?!\\w)`;
const RANGE_SECOND = `${DIGITS}|(?<![\\w])${WORD_NUMBER}(?![\\w-])`;
const RANGE = `(?<span>(?:(?<word>${QUALIFIER})\\s*)?(?:between\\s+)?(?<a>${RANGE_FIRST})\\s*\\+?(?<sep>${RANGE_SEP})(?<b>${RANGE_SECOND})\\s*\\+?\\s*(?<unit>${YEARS_UNIT}|${MONTHS_UNIT})\\b)\\.?`;
// "twenty-five" and "twenty five" are one number, not a range from twenty to five.
const TENS_WORD = new RegExp(`^(?:${TENS_WORDS.join('|')})$`, 'i');
const ONES_WORD = new RegExp(`^(?:${UNIT_WORDS.join('|')})$`, 'i');
const compound = (a, sep, b) => TENS_WORD.test(a) && /^\s*-?\s*$/.test(sep) && ONES_WORD.test(b);
// "first year in business" (V11): 0; "1st year" 0 and "second year" (or "2nd") 1 (round-6 answer 3).
const ORDINAL_YEAR = /(?<![\w-])(?<reading>(?<ordinal>first|1st|second|2nd)\s+(?:year|yr))\s+in\s+(?:business|biz)\b/i;
const ORDINAL_YEARS = { first: 0, '1st': 0, second: 1, '2nd': 1 };
// "a year-old business" is 1 and "3-year-old business" 3 (TNI, 2026-10-27: round-7 answer 3), in
// digits or words, rounded down like the other figures. A vehicle's age ("truck is 10 years old",
// "a year-old truck", "10-year-old business truck") is never one. A company, and up to two words
// before it that aren't a vehicle ("a 3-year-old trucking business"), too (the maintainer,
// 2026-10-27: answer to PR #191's open question).
const VEHICLE_WORD = '(?:trucks?|vehicles?|vans?|trailers?|cars?|tractors?)\\b';
// Between "old" and the business: industry-ish words only (trucking, family, hauling…). Glue or
// person words ("old and company", "old with company", "old for company") must not count — they
// used to turn a person's or equipment's age into years in business (Claude review on #203).
const AGE_FILLER_BLOCK = '(?:trucks?|vehicles?|vans?|trailers?|cars?|tractors?|with|and|at|in|of|for|since|to|by|from|on|as|or|the|a|an|driver|owner|person|people|man|woman|men|women)\\b';
const BUSINESS_NOT_VEHICLE = `(?:business|biz|company)\\b(?!\\s+${VEHICLE_WORD})`;
const AGE_OF_BUSINESS = `(?:(?!${AGE_FILLER_BLOCK})[a-z]+\\s+){0,2}${BUSINESS_NOT_VEHICLE}`;
const AGED_BUSINESS = new RegExp(`(?<![\\w-])(?<!\\bhalf\\s)(?<reading>(?<n>${DIGITS}|${WORD_NUMBER}|a)[\\s-]+(?:year|yr)s?[\\s-]+old)\\s+${AGE_OF_BUSINESS}`, 'i');
// Months right after years on a line, outside one figure read as above: a months figure there
// settles nothing.
const FIGURE = `(?:\\d{1,3}|${IN_WORDS})\\s*\\+?\\s*`;
const YEARS_THEN_MONTHS = new RegExp(`${FIGURE}${YEARS_UNIT}\\b\\.?[\\s,&]*(?:and\\s+)?${FIGURE}${MONTHS_UNIT}\\b`, 'i');
// Clauses: semicolons, commas, and full stops before a new sentence ("3 yrs. in biz" is one). A
// comma between years and months ("2 years, 6 months") joins one figure, not two clauses.
const ENDS_WITH_YEARS = new RegExp(`${FIGURE}${YEARS_UNIT}\\b\\.?$`, 'i');
const STARTS_WITH_MONTHS = new RegExp(`^(?:and\\s+)?${FIGURE}${MONTHS_UNIT}\\b`, 'i');
const clausesOf = (line) => {
  const parts = line.split(/(;|,\s|\.\s+(?=[A-Z]))/);
  const clauses = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i].startsWith(',') && ENDS_WITH_YEARS.test(clauses.at(-1)) && STARTS_WITH_MONTHS.test(parts[i + 1])) clauses.push(`${clauses.pop()}${parts[i]}${parts[i + 1]}`);
    else clauses.push(parts[i + 1]);
  }
  return clauses;
};
const BIZ = '(?:business|biz)\\b';
const BIZ_PHRASES = [
  new RegExp(`(?<![\\w.,])${YEARS}\\s+in\\s+${BIZ}`, 'gi'),
  new RegExp(`\\bin\\s+${BIZ}\\s+(?:for\\s+)?${YEARS}`, 'gi'),
];
const RANGE_PHRASES = [
  new RegExp(`(?<![\\w.,])${RANGE}\\s+in\\s+${BIZ}`, 'i'),
  new RegExp(`\\bin\\s+${BIZ}\\s+(?:for\\s+)?${RANGE}`, 'i'),
];
const BIZ_START = new RegExp(`\\b(?:established|founded|in\\s+${BIZ}\\s+since)\\s+(?:in\\s+)?(\\d{4})\\b`, 'i');
// A clause about something else than the business (driving, a CDL, insurance …), or negated.
const OTHER_SUBJECT = /\b(?:driv\w*|cdl|licen[cs]\w*|experienced?|authority|mc|dot|usdot|insur\w*|polic(?:y|ies)|pop|coverage|carriers?|claims?|accidents?|tickets?|violations?)\b/i;
const NEGATED = /\b(?:not|never|no)\b|n't\b/i;
// A statement of how long the business has run, read or not (TNI, 2026-10-27: round-6 answer 4):
// "in business" or "in biz" (also "into business", "established", "founded", "… old business") with
// a time in the same clause ("a few years", "almost 3 years", "since last year", "a long time",
// 2019). One the reader doesn't take is the agent's, like a range; notes with none are the blank
// standard.
const BIZ_MENTION = new RegExp(`\\b(?:in(?:to)?\\s+(?:business|biz)|established|founded)\\b|\\bold\\s+${AGE_OF_BUSINESS}`, 'i');
const BIZ_TIME = /\b(?:years?|yrs?|months?|mos?|decades?|since|ago|long|while|(?:19|20)\d{2})\b/i;
const statesBusinessTime = (clause) => BIZ_MENTION.test(clause) && BIZ_TIME.test(clause);
// A qualifier just before the match that the match itself doesn't hold (",less than 3 years").
const QUALIFIED = new RegExp(`(?:^|[^\\w])${QUALIFIER}\\s*$`, 'i');
const MAX_BUSINESS_YEARS = 100;

/**
 * Years in business the notes state, from the boxes given in order ([form field, text]): one
 * statement, or several that agree. `reading`: the figure as written when it isn't plain whole years
 * in digits ("over 3 years", "less than 1 year", "18 months", "two years", "1 year 6 months"), for
 * the first one. A range whose ends give different years (V7) gives `years` null and `range` true,
 * quoting it: the agent's, whatever else the notes say. A statement it doesn't read ("a few years",
 * "less than 3 years"), also beside one it reads (round-7 answer 2), or figures that disagree, give
 * `years` null and `unread` true, with `kind` and `quotes` (up to three): the agent's too (round-6
 * answer 4). Notes stating no time in business: null.
 * @param {[string, string|null|undefined][]} boxes
 * @param {number} year  this year, for a start year
 * @returns {{ years: number|null, range?: true, unread?: true, kind?: 'unread'|'disagree'|'mixed', quotes?: string[], established: number|null, quote: string, fields: string[], reading: string|null } | null}
 */
export function yearsInBusinessFromNotes(boxes, year) {
  const found = [];
  for (const [field, text] of boxes) {
    for (const line of String(text ?? '').split('\n')) {
      const yearsThenMonths = YEARS_THEN_MONTHS.test(line);
      // The years one figure gives, with the word before it, or null when it settles nothing.
      const yearsOf = (word, figure, unit, more, before) => {
        const months = MONTHS.test(unit);
        // "less than 1 year", "under 1 year": 0 (R10), and "less than half a year" (round-6 answer 3);
        // "less than N months", N up to 12: 0 (T8), and "under N months" alike (U1). Not with more
        // after the year ("less than 1 year 6 months", "under 1 year 6 months" and "under a year
        // and a half" are more than a year).
        const belowOne = Boolean(word) && BELOW.test(word) && !months && !more && figure > 0 && figure <= 1;
        const belowAYear = Boolean(word) && BELOW.test(word) && months && figure > 0 && figure <= MAX_MONTHS_BELOW_A_YEAR;
        const read = word ? AS_THE_FIGURE.test(word) || belowOne || belowAYear : !QUALIFIED.test(before);
        return !read || (months && yearsThenMonths) ? null : belowOne || belowAYear ? 0 : Math.floor(months ? figure / 12 : figure);
      };
      for (const clause of clausesOf(line)) {
        const quote = clause.trim();
        if (!quote || OTHER_SUBJECT.test(quote)) continue;
        // A statement of the business's time that gives no figure read below: the agent's (round-6
        // answer 4).
        const unread = () => { if (statesBusinessTime(quote)) found.push({ unread: true, years: null, established: null, quote, field, reading: null }); };
        // A negated one is never read ("Not in business for 3 years yet").
        if (NEGATED.test(quote)) { unread(); continue; }
        const before = found.length;
        const range = RANGE_PHRASES.map((re) => quote.match(re)).find((m) => m?.groups && !compound(m.groups.a, m.groups.sep, m.groups.b));
        if (range?.groups) {
          // Both ends read as one figure would be, with the same word and unit (V7).
          const { span, word, a, b, unit } = range.groups;
          const before = quote.slice(0, range.index);
          const ends = [a, b].map((n) => yearsOf(word, numberValue(n), unit, null, before));
          const same = ends[0] != null && ends[0] === ends[1];
          found.push({ years: same ? ends[0] : null, range: !same, established: null, quote, field, reading: span.replace(/\s+/g, ' ') });
          continue;
        }
        const ordinal = quote.match(ORDINAL_YEAR);
        if (ordinal?.groups) found.push({ years: ORDINAL_YEARS[ordinal.groups.ordinal.toLowerCase()], established: null, quote, field, reading: ordinal.groups.reading.replace(/\s+/g, ' ') });
        // "a 3-year-old business" (round-7 answer 3); after a qualifier ("almost a year-old"), not read.
        const aged = quote.match(AGED_BUSINESS);
        if (aged?.groups) {
          const years = QUALIFIED.test(quote.slice(0, aged.index).replace(/\ban?\s+$/i, '')) ? null : Math.floor(numberValue(aged.groups.n));
          found.push({ years, established: null, quote, field, reading: aged.groups.reading.replace(/\s+/g, ' ') });
        }
        // Every statement in the clause, so two that disagree settle nothing.
        for (const m of BIZ_PHRASES.flatMap((re) => [...quote.matchAll(re)])) {
          if (!m.groups) continue;
          const { word, n, unit, months: andMonths, monthsUnit, half, halfBefore } = m.groups;
          const years = yearsOf(word, numberValue(n) + (half || halfBefore ? 0.5 : 0), unit, andMonths || half || halfBefore, quote.slice(0, m.index));
          // How it was read, when it isn't plain whole years in digits.
          const reading = word || MONTHS.test(unit) || andMonths || half || halfBefore || !/^\d+$/.test(n)
            ? `${word ? `${word} ` : ''}${n.replace(/\s+/g, ' ')}${halfBefore ? ' and a half' : ''} ${unit}${half ? ' and a half' : ''}${andMonths ? ` ${andMonths} ${monthsUnit}` : ''}` : null;
          found.push({ years, established: null, quote, field, reading });
        }
        const start = quote.match(BIZ_START);
        if (start) found.push({ years: year - Number(start[1]), established: Number(start[1]), quote, field, reading: null });
        if (found.length === before) unread();
      }
    }
  }
  // A range whose ends differ is the agent's, whatever else the notes say (V7).
  const open = found.find((f) => f.range);
  if (open) return { years: null, range: true, established: null, quote: open.quote, fields: [open.field], reading: open.reading };
  // The figures read: one, or several that agree, is the answer, when nothing else the notes say of
  // the business's time is left unread (a statement with no figure, "several years", stops it too:
  // TNI, 2026-10-27, round-7 answer 2).
  const isRead = (f) => !f.unread && Number.isInteger(f.years) && f.years >= 0 && f.years <= MAX_BUSINESS_YEARS;
  if (!found.length) return null;
  if (found.every(isRead) && new Set(found.map((f) => f.years)).size === 1) {
    return {
      years: found[0].years, established: found.find((f) => f.established != null)?.established ?? null,
      quote: found[0].quote, fields: [...new Set(found.map((f) => f.field))], reading: found[0].reading,
    };
  }
  // Nothing settles (TNI, 2026-10-27: round-6 answer 4): a statement not read ("a few years",
  // "almost 3 years", a start year after this year), figures that disagree, or both, is the agent's,
  // each line quoted (`kind`: 'unread', 'disagree', or 'mixed' for statements read and not read).
  // Notes with no statement of the business's time give null: the blank standard.
  const read = found.filter(isRead).length;
  return {
    years: null, unread: true, kind: !read ? 'unread' : read === found.length ? 'disagree' : 'mixed', established: null, quote: found[0].quote,
    quotes: [...new Set(found.map((f) => f.quote))].slice(0, 3), fields: [...new Set(found.map((f) => f.field))], reading: null,
  };
}

// A generational suffix written into a driver's name box ("SAMPLE, JR", "EXAMPLO III"), and a
// lone letter after the first name ("JORDAN L"), its middle initial. Carriers' driver name boxes
// take letters, digits, spaces, hyphens and apostrophes only (Progressive refused the comma, AR
// 2026-10-19), and only GEICO's Add Driver form has a suffix box, so both are kept apart: the
// suffix in `suffix`, the initial in `middle`. A first name of one letter ("A J") is left as it is.
const NAME_SUFFIX = /^(.*?[^\s,])[\s,]+(jr|sr|ii|iii|iv)\.?$/i;
export function splitName(first, last) {
  const out = { first, middle: null, last, suffix: null, suffixIn: null };
  for (const box of ['first', 'last']) {
    const m = out.suffix ? null : String(out[box] ?? '').trim().match(NAME_SUFFIX);
    if (m) Object.assign(out, { [box]: m[1], suffix: m[2], suffixIn: box });
  }
  const words = String(out.first ?? '').trim().split(/\s+/);
  if (words.length >= 2 && /^\p{L}\.?$/u.test(words.at(-1)) && (words[0].match(/\p{L}/gu) ?? []).length >= 2) {
    out.middle = words.at(-1).replace('.', '');
    out.first = words.slice(0, -1).join(' ');
  }
  return out;
}

/**
 * The ownership answer written in the claims notes when the ownership box is blank ("Financed").
 * Only an unambiguous note is taken: exactly one ownership word, which is one of owned / leased
 * / financed, not negated in its sentence ("not leased" is not Leased) and with no trailer
 * mention anywhere ("Trailer.\nFinanced." can describe the trailer; mixed units stay ambiguous). Any
 * other mention is left to the agent with the lines quoted.
 * @returns {{ value: string|null, lines: string } | null}  null when the notes say nothing about ownership
 */
export function ownershipFromNotes(notes) {
  const text = String(notes ?? '');
  const mentions = [...text.matchAll(OWNERSHIP_WORDS)];
  if (!mentions.length) return null;
  const lines = ownershipLines(text).join(' / ');
  const unsettled = { value: null, lines };
  if (mentions.length !== 1) return unsettled;
  const [mention] = mentions;
  const value = OWNERSHIP_ANSWERS[mention[1].toLowerCase()];
  if (!value) return unsettled;
  // The sentence holding the word: from the previous full stop, semicolon or line break to the next.
  const start = Math.max(...[...text.slice(0, mention.index).matchAll(/[.;!?\n]/g)].map((m) => m.index + 1), 0);
  const end = text.slice(mention.index).search(/[.;!?\n]/);
  const sentence = text.slice(start, end < 0 ? undefined : mention.index + end);
  // A trailer can be the subject of a separate ownership sentence or line. Keep trailer-only
  // and mixed-unit notes unresolved rather than assigning their ownership to the vehicle.
  if (NEGATION.test(sentence) || TRAILER_WORD.test(text)) return unsettled;
  return { value, lines };
}

// "MD - 10123456789" -> { state: 'MD', number: 'MD10123456789' }: a leading state code tells us
// the license state, but it stays in the number (agents enter it that way).
export function parseLicense(v) {
  const s = clean(v);
  if (s == null) return { state: null, number: null };
  const m = s.match(/^([A-Za-z]{2})\s*[-:#]\s*(.+)$|^([A-Za-z]{2})\s+(.*\d.*)$/);
  if (m) {
    const st = (m[1] ?? m[3]).toUpperCase();
    const rest = m[2] ?? m[4];
    if (STATES[st] && plain(rest).length >= 5) return { state: st, number: plain(s) };
  }
  return { state: null, number: plain(s) };
}

// "Excluded" written in a driver's license-number box, as the whole box or after the number
// ("EXCLUDED", "12345678 EXCLUDED", "D1234567 excl."): the client wants that driver excluded (TNI,
// 2026-10-20, after a PA run where the box's "Excluded" was cleaned into a license number, typed
// and refused). Only these forms count, at the end of the box: Exc, Excl, Exclude and Excluded,
// with or without a period, or in parentheses ("EXCEPT", "EXCLUSION" or the word before the
// number don't).
const EXCLUDED_WORD = /(?:^|[^A-Za-z0-9]+)exc(?:l(?:uded?)?)?\.?\)?$/i;

/**
 * A license-number box with the "Excluded" at its end taken off. What is written before the word
 * is the license number when it has a digit; anything else ("DRIVER EXCLUDED") is no number.
 * @returns {{ license: string|null, excluded: boolean }}
 */
function licenseBox(box) {
  const m = box?.match(EXCLUDED_WORD);
  if (!m) return { license: box ?? null, excluded: false };
  const before = clean(box.slice(0, m.index));
  return { license: /\d/.test(before ?? '') ? before : null, excluded: true };
}

const KNOWN_FIELDS = new Set([
  'date_of_application', 'email', 'dot_number', 'mc_number', 'mc_dot_60days', 'phone_number', 'company_name',
  'year_established', 'owner_name_1', 'owner_name_2', 'owner_drives', 'years_experience', 'garaging_address',
  'fed_state_filings', 'filings_which', 'haul_hazmat', 'hazardous_placard', 'moving_state', 'biz_class',
  'what_haul', 'avg_radius', 'use_eld', 'eld_brand', 'vehicle_personal_use', 'fein', 'need_sr22',
  'license_plate', 'veh_ownership', 'trl_ownership', 'trl_hitch_type', 'trl_interchange', 'interchange_limit',
  'trl_interchange_limit', 'equip_trailer', 'equip_vehicle', 'ins_type_1', 'ins_carrier_1', 'ins_limit_1',
  'ins_exp_1', 'auto_liability', 'auto_liab_limit', 'cargo_cov', 'cargo_limit_ded', 'gen_liability',
  'gen_liab_limit', 'reefer_breakdown', 'claims_details', ...MARITAL_FIELDS,
  // Each form version has fields the others lack; every version is read. Before 2026-10-02: the
  // license plate. Before 2026-10-19: the other-insurance-products box (cross_*) and a second
  // interchange limit beside the hitch. From 2026-10-02: team driving / slip seating. From
  // 2026-10-19: the Additional Notes box and the Canada question.
  'cross_personal_auto', 'cross_life', 'cross_homeowners', 'cross_renters', 'cross_other', 'cross_other_text',
  'team_driving_or_slip_seating', 'additional_notes', 'loads_to_canada',
  ...ROWS.flatMap((n) => [
    `drv_first_${n}`, `drv_last_${n}`, `drv_dob_${n}`, `drv_lic_${n}`, `drv_state_${n}`, `drv_cdl_${n}`, `drv_cdl_yr_${n}`,
    `veh_type_${n}`, `veh_year_${n}`, `veh_make_${n}`, `veh_model_${n}`, `veh_vin_${n}`, `veh_value_${n}`,
    `trl_type_${n}`, `trl_year_${n}`, `trl_make_${n}`, `trl_model_${n}`, `trl_vin_${n}`, `trl_value_${n}`,
  ]),
]);

/**
 * @param {Record<string, string|boolean>} raw  field name -> value, from readIntakeFields()
 * @param {{ today?: Date }} [opts]
 * @returns {IntakeResult | { error: string }}
 */
export function normalizeIntake(raw, { today = new Date() } = {}) {
  const present = Object.keys(raw).filter((k) => KNOWN_FIELDS.has(k));
  if (present.length < KNOWN_FIELDS.size * 0.6) {
    return { error: "This PDF doesn't look like the TNI Commercial Quote Application (its form fields don't match)." };
  }

  const warnings = [];
  // `code` names the kind of problem without any client data, for the usage log.
  const check = (code, path, msg) => warnings.push({ code, path, level: 'check', msg });
  const info = (code, path, msg) => warnings.push({ code, path, level: 'info', msg });
  const txt = (k) => clean(raw[k]);
  const year = today.getFullYear();
  // "NO", "N.A.", "None." in the company-name box: no company (util.js companyName).
  const companyAsWritten = txt('company_name');

  // "No" in the FEIN, USDOT or MC box: the client has none, an explicit No, which a blank box is
  // not (FEIN: W44-15; USDOT and MC: TNI, 2026-10-26: answer to PR question). Not a malformed number.
  const saysNo = (k) => /^no\.?$/i.test(txt(k) ?? '');
  // The USDOT and MC boxes: "None" and "N/A" (any case, with or without a dot or slash: n/a, NA,
  // N.A.) are an explicit No too, exactly like "no" (TNI, 2026-10-26: answer to PR question, R14).
  // `txt` reads "N/A", "NA" and "None" as blank, so the box is read as written. A cut-off "N/" is
  // not one of them (W44-08, not decided): it stays a malformed number, as before.
  const asWritten = (k) => (typeof raw[k] === 'string' ? raw[k].replace(/\s+/g, ' ').trim() : '');
  const saysNoNumber = (k) => /^(?:no|none|n\s*[./]?\s*a)\.?$/i.test(asWritten(k));
  // Numbers that should be digits only: note when stray characters were dropped.
  const idNumber = (k, path, label, pattern) => {
    const s = txt(k);
    if (s == null || saysNoNumber(k)) return null;
    const digits = s.replace(/^(us\s*dot|dot|mc|mx)\b/i, '').replace(/\D/g, '');
    if (!pattern.test(digits)) { check('id.invalid', path, `"${s}" isn't a valid number.`); return s; }
    return digits;
  };

  // The form row (1-4) each driver, vehicle and trailer was read from: blank rows are skipped, so
  // drivers[1] can be the form's row 3 (the panel shows an answer where it is on the PDF).
  const rows = { drivers: [], vehicles: [], trailers: [] };
  // An answer read from another box than its own (years in business from the notes): its path and
  // the form fields it was read from, so the panel shows it there (intake-source.js sourcePlace).
  /** @type {Record<string, string[]>} */
  const readFrom = {};
  const record = {
    applicant: {
      name: companyName(companyAsWritten),
      dot: idNumber('dot_number', 'applicant.dot', 'USDOT #', /^\d{1,8}$/),
      mc: idNumber('mc_number', 'applicant.mc', 'MC #', /^\d{1,8}$/),
      // The USDOT or MC box says No (or None, N/A: R14): true; null for a blank box or a number
      // (unanswered is not No).
      noDot: saysNoNumber('dot_number') || null,
      noMc: saysNoNumber('mc_number') || null,
      mcDotWithin60Days: yesNo(raw.mc_dot_60days),
      fein: null,
      yearEstablished: null,
      yearsInBusiness: null,
      phone: null,
      email: txt('email')?.toLowerCase() ?? null,
      owner1: txt('owner_name_1'),
      owner2: txt('owner_name_2'),
      ownerDrives: yesNo(raw.owner_drives),
      // "NEW" in years under own authority: 0 years, a new authority (TNI, 2026-10-26: answer to PR question);
      // also "New authority", "Brand new" and "New venture" (R15).
      yearsExperience: NEW_AUTHORITY.test(txt('years_experience') ?? '') ? 0 : toInt(raw.years_experience),
      applicationDate: toDate(raw.date_of_application),
    },
    garaging: null,
    operations: {
      businessClass: txt('biz_class'),
      whatHaul: txt('what_haul'),
      radius: txt('avg_radius'),
      radiusMiles: null,
      usesEld: yesNo(raw.use_eld),
      eldBrand: txt('eld_brand'),
      needSr22: yesNo(raw.need_sr22),
      filingsRequired: yesNo(raw.fed_state_filings),
      filingsWhich: txt('filings_which'),
      hazmat: yesNo(raw.haul_hazmat),
      hazPlacard: yesNo(raw.hazardous_placard),
      movingState: yesNo(raw.moving_state),
      // Not on older intakes (team driving before 2026-10-02, Canada before 2026-10-19):
      // unanswered (null), never No.
      teamDriving: yesNo(raw.team_driving_or_slip_seating),
      canadaLoads: yesNo(raw.loads_to_canada),
      personalUse: yesNo(raw.vehicle_personal_use),
      vehicleOwnership: txt('veh_ownership'),
      licensePlate: txt('license_plate')?.toUpperCase() ?? null,
      equipVehicle: toMoney(raw.equip_vehicle),
    },
    drivers: [],
    vehicles: [],
    trailers: [],
    trailerInfo: {
      ownership: txt('trl_ownership'),
      hitch: txt('trl_hitch_type'),
      interchange: yesNo(raw.trl_interchange),
      interchangeLimit: txt('trl_interchange_limit') ?? txt('interchange_limit'),
      equipTrailer: toMoney(raw.equip_trailer),
    },
    priorInsurance: [],
    coverage: {
      autoLiability: txt('auto_liability'),
      autoLiabLimit: txt('auto_liab_limit'),
      cargo: yesNo(raw.cargo_cov),
      cargoLimit: null,
      cargoDeductible: null,
      gl: yesNo(raw.gen_liability),
      glLimit: txt('gen_liab_limit'),
      reeferBreakdown: yesNo(raw.reefer_breakdown),
      // Non-Trucking picked for auto liability on the form (nonTruckingAnswer), else the agent's,
      // after reading the claims box and the notes.
      ntl: nonTruckingAnswer(raw.auto_liability) ? true : null,
      // The client already has general liability elsewhere (not a GL request: that's `gl`). Not on
      // the form either: the agent sets it, after Luna flags the claims box.
      hasGl: null,
    },
    claims: { text: cleanMultiline(raw.claims_details), hasClaims: null, notes: null },
    // The Additional Notes box (2026-10 form), as written; null on older intakes.
    notes: { text: cleanMultiline(raw.additional_notes) },
    crossSell: [
      raw.cross_personal_auto && 'Personal auto', raw.cross_life && 'Life', raw.cross_homeowners && 'Homeowners',
      raw.cross_renters && 'Renters', raw.cross_other && (txt('cross_other_text') ?? 'Other'),
    ].filter(Boolean),
  };
  const a = record.applicant;
  const ops = record.operations;

  // --- Business -------------------------------------------------------------------------------
  // "No" in the FEIN box: no FEIN, as "N/A" is (W44-15), not a malformed number.
  if (saysNo('fein')) info('fein.none', 'applicant.fein', `FEIN "${txt('fein')}": no FEIN.`);
  else if (txt('fein')) {
    const d = txt('fein').replace(/\D/g, '');
    if (d.length === 9) a.fein = `${d.slice(0, 2)}-${d.slice(2)}`;
    else { a.fein = txt('fein'); check('fein.invalid', 'applicant.fein', `"${a.fein}" should be 9 digits.`); }
  }
  const est = toInt(raw.year_established);
  if (est != null) {
    if (est >= 1900 && est <= year) { a.yearEstablished = est; a.yearsInBusiness = year - est; }
    else check('year-established.invalid', 'applicant.yearEstablished', `"${txt('year_established')}" isn't a valid year.`);
  }
  if (txt('phone_number')) {
    a.phone = toPhone(raw.phone_number);
    if (!a.phone) { a.phone = txt('phone_number'); check('phone.invalid', 'applicant.phone', `"${a.phone}" isn't a 10-digit US number.`); }
  }
  if (a.email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a.email)) check('email.invalid', 'applicant.email', `"${a.email}" looks malformed.`);
  if (!a.dot && !a.mc && a.mcDotWithin60Days === true) {
    info('dot.pending', 'applicant.dot', 'No DOT/MC yet — client says they will have one within 60 days.');
  }
  if (a.noDot) info('dot.none', 'applicant.dot', `USDOT # "${asWritten('dot_number')}": the client has no USDOT number.`);
  if (a.noMc) info('mc.none', 'applicant.mc', `MC # "${asWritten('mc_number')}": the client has no MC number.`);
  if (NEW_AUTHORITY.test(txt('years_experience') ?? '')) info('years-experience.new', 'applicant.yearsExperience', `Years under own authority "${txt('years_experience')}": 0 years, a new authority.`);
  else if (txt('years_experience') && a.yearsExperience == null) check('years-experience.invalid', 'applicant.yearsExperience', `"${txt('years_experience')}" isn't a number.`);
  // No year established on the form: the years in business the claims box or Additional Notes state,
  // with a check quoting them (TNI, 2026-10-26, W44-09). They win over years under own authority
  // for years in business (TNI, 2026-10-26: answer to PR question); the authority years are another
  // fact and stay as the form gives them, for their own questions. Never read from a business phrase.
  const stated = a.yearsInBusiness == null
    ? yearsInBusinessFromNotes([['claims_details', record.claims.text], ['additional_notes', record.notes.text]], year) : null;
  if (stated) {
    readFrom['applicant.yearsInBusiness'] = stated.fields;
    const boxName = (field) => (field === 'additional_notes' ? 'Additional Notes box' : 'claims box');
    const box = boxName(stated.fields[0]);
    const short = (q) => (q.length > 80 ? `${q.slice(0, 79).trimEnd()}…` : q);
    const quote = short(stated.quote);
    const authority = a.yearsExperience == null ? '' : ` The years under own authority (${a.yearsExperience}) stay apart.`;
        if (stated.range) {
      // A range whose ends differ (TNI, 2026-10-27: answer to PR question V7): the agent's on every
      // carrier, neither the blank standard nor the authority years; the check names the line.
      a.yearsInBusinessRange = true;
      check('years-in-business.notes', 'applicant.yearsInBusiness', `The ${box} says "${quote}", a range ("${stated.reading}"), so years in business is left to you.${authority}`);
    } else if (stated.unread) {
      // A statement it doesn't read, or figures that disagree (TNI, 2026-10-27: round-6 answer 4):
      // the agent's like a range, neither the blank standard nor the authority years.
      a.yearsInBusinessUnread = true;
      const boxes = stated.fields.map(boxName).join(' and the ');
      const said = (stated.quotes ?? [stated.quote]).map((q) => `"${short(q)}"`).join(' and ');
      const why = { disagree: 'figures that disagree', mixed: 'not all read as a number of years' }[stated.kind ?? ''] ?? 'not read as a number of years';
      check('years-in-business.notes', 'applicant.yearsInBusiness', `The ${boxes} ${stated.fields.length > 1 ? 'say' : 'says'} ${said}: ${why}, so years in business is left to you.${authority}`);
    } else {
      a.yearsInBusiness = stated.years;
      if (stated.established != null) { a.yearEstablished = stated.established; readFrom['applicant.yearEstablished'] = stated.fields; }
      // How a figure that isn't plain years was read: "over 3 years" as 3, "18 months" as 1 (R11).
      const reading = stated.reading ? ` ("${stated.reading}" read as ${stated.years})` : '';
      check('years-in-business.notes', 'applicant.yearsInBusiness', `The ${box} says "${quote}": years in business is ${stated.years}${reading}${stated.established != null ? `, established ${stated.established}` : ''}. Confirm.${authority}`);
    }
  }
  // TNI's standard for a blank (2026-10-09): 0 years, established this year (AmWINS' rules fill
  // it, GEICO's leave it to the agent; the record stays blank, so a later answer here replaces it).
  // Not for a range in the notes (V7) or a statement of years in business they don't settle
  // (round-6 answer 4), which are the agent's: only for notes that say nothing of the business's time.
  if (a.yearsInBusiness == null && a.yearsExperience == null && !a.yearsInBusinessRange && !a.yearsInBusinessUnread) {
    check('years-in-business.default', 'applicant.yearsInBusiness', `Blank. AmWINS gets 0 years (New Venture), established ${year}; GEICO's question is yours.`);
  }

  // --- Garaging address -----------------------------------------------------------------------
  const addr = parseAddress(raw.garaging_address);
  if (addr) {
    const { confident, ...parts } = addr;
    record.garaging = parts;
    if (!addr.state || !addr.zip) check('address.unparsed', 'garaging.street', `Couldn't split "${txt('garaging_address')}". Fill in street, city, state and ZIP.`);
    else if (!addr.city) check('address.no-city', 'garaging.city', `Couldn't find the city in "${txt('garaging_address')}".`);
    else if (!confident) check('address.no-commas', 'garaging.city', `Split an address with no commas: street "${[addr.street, addr.unit].filter(Boolean).join(' ')}", city "${addr.city}". Confirm.`);
  } else {
    record.garaging = { street: null, unit: null, city: null, state: null, zip: null };
    check('address.missing', 'garaging.street', 'No garaging address on the form.');
  }

  // --- Drivers --------------------------------------------------------------------------------
  ROWS.forEach((n, i) => {
    const boxes = { first: txt(`drv_first_${n}`), last: txt(`drv_last_${n}`) };
    const name = splitName(boxes.first, boxes.last);
    const d = {
      first: name.first, middle: name.middle, last: name.last, suffix: name.suffix, dob: null, licenseNumber: null,
      licenseState: txt(`drv_state_${n}`), cdl: yesNo(raw[`drv_cdl_${n}`]), cdlYear: toInt(raw[`drv_cdl_yr_${n}`]),
      maritalStatus: txt(MARITAL_FIELDS[i]),
      // Not on the intake (schema NOT_ON_INTAKE): the agent's to set.
      gender: null,
      // True when the license-number box says "Excluded" (licenseBox); the intake asks nothing else
      // about it, so it is otherwise unanswered, not No.
      excluded: null,
    };
    const rawDob = txt(`drv_dob_${n}`);
    const licBox = txt(`drv_lic_${n}`);
    if (!d.first && !d.last && !rawDob && !licBox) return;
    const idx = record.drivers.length;
    const p = (k) => `drivers[${idx}].${k}`;
    const who = [d.first, d.last].filter(Boolean).join(' ') || `Driver ${n}`;
    // The license number is the box without an "Excluded" at its end, which marks the driver.
    const { license: rawLic, excluded } = licenseBox(licBox);
    if (excluded) d.excluded = true;

    if (rawDob) {
      d.dob = toDate(rawDob);
      if (!d.dob) { d.dob = rawDob; check('dob.invalid', p('dob'), `${who}: "${rawDob}" isn't a valid date.`); }
      else {
        const age = year - Number(d.dob.slice(6));
        if (age < 18 || age > 90) check('dob.unusual-age', p('dob'), `${who}: age ~${age}. Typo?`);
      }
    } else check('dob.missing', p('dob'), `${who}: no date of birth.`);

    if (rawLic) {
      const lic = parseLicense(rawLic);
      d.licenseNumber = lic.number;
      if (lic.state && !d.licenseState) d.licenseState = lic.state;
      if (lic.state && d.licenseState && lic.state !== d.licenseState) {
        check('license.state-mismatch', p('licenseState'), `${who}: license says ${lic.state}, state box says ${d.licenseState}.`);
      }
    } else check('license.missing', p('licenseNumber'), `${who}: no driver's license number.`);
    if (!d.licenseState) check('license-state.missing', p('licenseState'), `${who}: no license state.`);
    if (rawLic && plain(rawLic) !== rawLic.toUpperCase()) {
      info('license.cleaned', p('licenseNumber'), `${who}: license number written as "${rawLic}", entered as ${d.licenseNumber} (letters and digits only).`);
    }
    if (excluded) {
      // What the carriers do with it stays in their plans (TNI 2026-10-20): Progressive's exclude
      // question is Yes; AmWINS has none, and the license number gets "(Excluded)" after it; GEICO
      // asks nothing about it (the driver is filled, with a warning), and leaves the owner's row out
      // (T1, V3). The item stays short (the maintainer, 2026-10-28: no carrier-by-carrier
      // walkthrough), but says the one thing the fill can't do: GEICO has no exclusion question, so
      // another driver is the agent's to exclude there (the owner's row GEICO leaves out). And the
      // signed-form reminder (PR #216 review).
      const geico = record.drivers.length ? 'On GEICO, exclude them yourself.' : 'GEICO leaves them out, as the owner.';
      check('license.excluded', p('excluded'), `${who}: marked excluded ("${licBox}"). ${geico} Needs the insured's signed form.`);
    }

    if (name.suffix) {
      const box = name.suffixIn === 'first' ? 'first-name' : 'last-name';
      info('name.suffix', p('suffix'), `${who}: ${box} box "${boxes[name.suffixIn]}" read as ${name.suffixIn === 'first' ? 'first' : 'last'} name ${d[name.suffixIn]}, suffix ${d.suffix}. Only GEICO takes the suffix.`);
    }
    if (name.middle) info('name.middle-initial', p('middle'), `${who}: "${boxes.first}" read as ${d.first}, middle initial ${d.middle}.`);
    if (d.first && /\s/.test(d.first)) {
      check('name.multi-word-first', p('first'), `${who}: "${d.first}" has two words. Check the license for the middle name.`);
    }
    if (!d.first || !d.last) check('name.missing-part', p(d.first ? 'last' : 'first'), `${who}: missing ${d.first ? 'last' : 'first'} name.`);
    if (d.cdl && !d.cdlYear) check('cdl-year.missing', p('cdlYear'), `${who}: has a CDL but no year it was issued.`);
    if (d.cdl === false && d.cdlYear) check('cdl-year.without-cdl', p('cdlYear'), `${who}: no CDL, but a CDL year is given.`);
    if (d.cdl == null && d.cdlYear) check('cdl.blank-with-year', p('cdl'), `${who}: CDL blank, but a CDL year is given. Answer it.`);
    record.drivers.push(d);
    rows.drivers.push(n);
  });
  if (companyAsWritten && !companyName(companyAsWritten)) info('company.none', 'applicant.name', `Company name "${companyAsWritten}": sole proprietor.`);
  if (!record.drivers.length) check('drivers.none', 'drivers', 'No drivers listed.');
  // A blank "owner drives" box is TNI's Yes on the carriers (2026-10-26, W44-25: util.js
  // ownerDrives; the record keeps it blank): an owner missing from the driver list is then listed as a
  // driver whose details aren't on the intake, as with the intake's Yes. Since the owner is always the
  // first driver (TNI, 2026-10-27: answer to PR question V4), only with no driver rows (as before).
  if (a.ownerDrives !== false && a.owner1 && !record.drivers.length) {
    check('drivers.owner-not-listed', 'drivers', a.ownerDrives ? `Owner drives, but "${a.owner1}" isn't in the driver list.`
      : `Owner drives is blank (TNI standard Yes), but "${a.owner1}" isn't a driver. Add their details, or set Owner drives to No.`);
  }
  // TNI, 2026-10-27 (answer to PR question V4): "The owner is always the first driver on the intake's
  // driver list". A first row whose name isn't the owner box's (util.js ownerRowNameDiffers) is still
  // the owner, and this check says it was taken as the owner (in place of T2's `drivers.owner-unclear`).
  // It names no one: the row is its path.
  if (ownerRowNameDiffers(record)) {
    check('drivers.owner-name-differs', 'drivers[0]', 'The first driver is taken as the owner, though the names differ (TNI). If not, fix the driver list.');
  }
  // TNI, 2026-10-26 (answer to PR question, R1): "owner drives" says only whether the owner drives;
  // the intake's No makes the owner's driver row an excluded driver on every carrier, as an "Excluded"
  // mark does (util.js driverExcluded). The owner's row is the first (TNI, 2026-10-27: answer to PR
  // question V4; before, T2's row by the owner's exact full name, with `drivers.owner-unclear` when
  // none was). GEICO's quote leaves the owner's row out (T1), as it does when that row is marked
  // "Excluded" over a blank box or a Yes (V3). The record keeps the rows as read (`excluded` stays
  // null), so this item tells the agent; a row marked excluded already has its own (license.excluded).
  // The maintainer, 2026-10-28: the item asks "Does the owner drive?" on the Owner drives box itself
  // (`applicant.ownerDrives`), so the agent's answer sets it: Yes, the owner drives and isn't excluded;
  // No, the owner is excluded, the same on every carrier. Before, it was on the owner's row's Excluded
  // driver with a carrier-by-carrier walkthrough: agents read it as "does the owner drive?", answered
  // No (not excluded) and left the box No, and no row gave the owner's details (2026-10-28 runs; such a
  // record is now read as the owner driving: util.js ownerDrivesSaid).
  const own = ownerRow(record);
  if (own && own.excluded !== true && a.ownerDrives === false) {
    const who = [own.first, own.last].filter(Boolean).join(' ') || `Driver ${rows.drivers[0]}`;
    check('drivers.owner-excluded', 'applicant.ownerDrives', `Does the owner drive? The intake says No, so the owner (${who}, the first driver) is quoted as excluded.`);
  }

  // --- Vehicles and trailers ------------------------------------------------------------------
  const units = (prefix, list, label) => {
    ROWS.forEach((n) => {
      const u = {
        type: txt(`${prefix}_type_${n}`), year: null, make: txt(`${prefix}_make_${n}`), model: txt(`${prefix}_model_${n}`),
        vin: txt(`${prefix}_vin_${n}`)?.replace(/[\s-]/g, '').toUpperCase() ?? null, value: null,
      };
      const rawYear = txt(`${prefix}_year_${n}`);
      const rawValue = txt(`${prefix}_value_${n}`);
      if (!rawYear && !u.make && !u.model && !u.vin && !rawValue) return;
      const idx = record[list].length;
      const p = (k) => `${list}[${idx}].${k}`;
      const what = [rawYear, u.make, u.model].filter(Boolean).join(' ') || `${label} ${n}`;
      if (rawYear) {
        u.year = toInt(rawYear);
        if (!u.year || u.year < 1950 || u.year > year + 1) { u.year = rawYear; check('vehicle-year.invalid', p('year'), `${what}: year "${rawYear}" doesn't look right.`); }
      }
      if (rawValue) {
        u.value = toMoney(rawValue);
        if (u.value == null) { u.value = rawValue; check('vehicle-value.invalid', p('value'), `${what}: value "${rawValue}" isn't a dollar amount.`); }
      }
      if (u.vin) {
        const problem = vinProblem(u.vin);
        if (problem) check('vin.invalid', p('vin'), `${what}: VIN ${u.vin} ${problem}.`);
      } else check('vin.missing', p('vin'), `${what}: no VIN.`);
      if (!u.type) check('vehicle-type.missing', p('type'), `${what}: ${label.toLowerCase()} type not selected.`);
      record[list].push(u);
      rows[list].push(n);
    });
  };
  units('veh', 'vehicles', 'Vehicle');
  units('trl', 'trailers', 'Trailer');
  if (!record.vehicles.length) check('vehicles.none', 'vehicles', 'No vehicles listed.');
  // A semi trailer needs something to pull it: a truck tractor (or a pickup for a hotshot flatbed).
  // An intake listing one with only vans or box trucks has likely mistyped a vehicle (TN 2026-10-08).
  const semiTrailer = record.trailers.find((t) => /^(dry van|reefer|flatbed|tanker|lowboy|step deck)$/i.test(t.type ?? ''));
  if (semiTrailer && record.vehicles.length && !record.vehicles.some((v) => /^(semi truck|pickup truck)$/i.test(v.type ?? ''))) {
    check('vehicle-type.no-tractor', 'vehicles[0].type', `A ${semiTrailer.type} trailer, but no Semi or Pickup Truck to pull it (${record.vehicles.map((v) => v.type ?? 'none').join(', ')}).`);
  }
  if (record.vehicles.length > 1 && ops.licensePlate) info('plate.ambiguous', 'operations.licensePlate', 'One plate for several vehicles: it may belong to one.');

  // --- Operations -----------------------------------------------------------------------------
  // "Unlimited", long haul, OTR, 48 states: no mileage; the carrier rules pick their widest band.
  const radius = parseRadius(ops.radius);
  ops.radiusMiles = radius.miles;
  if (radius.kind === 'missing') check('radius.missing', 'operations.radius', 'No radius of operations.');
  else if (radius.kind === 'range') check('radius.range', 'operations.radiusMiles', `"${ops.radius}" is a range. Enter the farthest one-way miles.`);
  else if (radius.kind === 'unit') check('radius.unit', 'operations.radiusMiles', `"${ops.radius}" isn't in miles. Enter the miles.`);
  else if (radius.kind === 'text') check('radius.not-miles', 'operations.radius', `"${ops.radius}" isn't miles. Enter miles or a band (e.g. 500+).`);
  if (ops.usesEld && !ops.eldBrand) check('eld-brand.missing', 'operations.eldBrand', 'Uses an ELD but brand not given.');
  // (TNI, 2026-10-26: answer to PR question) Neither check on an NTL quote, which gets no filings:
  // the `coverage.ntl-filings` info item below says why the carriers answer No instead.
  const ntlQuote = ntlNoDotFilings(record);
  if (ops.filingsRequired && !ops.filingsWhich && !ntlQuote) check('filings-which.missing', 'operations.filingsWhich', 'Needs filings but did not say which.');
  // Filings are made under a USDOT or MC number (the maintainer, 2026-10-26: a wrong intake).
  if (ops.filingsRequired === true && !record.applicant.dot && !record.applicant.mc && !ntlQuote) {
    check('filings.no-number', 'applicant.dot', `Needs filings but has no USDOT or MC${record.applicant.mcDotWithin60Days === true ? ' (one due within 60 days)' : ''}. Check with the client.`);
  }
  if (ops.hazmat) check('hazmat.yes', 'operations.hazmat', 'Hazmat, tobacco or prescription drugs: confirm which.');

  // --- Current insurance ----------------------------------------------------------------------
  const prior = {
    type: txt('ins_type_1'), carrier: txt('ins_carrier_1'), limit: txt('ins_limit_1'), expiration: toDate(raw.ins_exp_1),
  };
  if (txt('ins_exp_1') && !prior.expiration) { prior.expiration = txt('ins_exp_1'); check('prior-expiration.invalid', 'priorInsurance[0].expiration', `Current policy expiration "${prior.expiration}" isn't a valid date.`); }
  // "No", "NO POP", "None" as the carrier without an expiration date is no prior insurance (TNI,
  // 2026-10-09: "Personal Auto", "no POP", "State Minimum" is no prior). It stays on the record,
  // as written, so the panel's Current insurance shows it; carriers fill and disclose nothing
  // from it (noPriorInsurance).
  // As written: "None" and "N/A" read as blank otherwise, and a blank carrier is no answer.
  const carrierAsWritten = String(raw.ins_carrier_1 ?? '').replace(/\s+/g, ' ').trim();
  const noPrior = noPriorInsurance({ carrier: carrierAsWritten, expiration: prior.expiration });
  if (noPrior) {
    record.priorInsurance.push({ ...prior, carrier: carrierAsWritten });
    info('prior.none', 'priorInsurance', `Current insurance says "${carrierAsWritten}": treated as not currently insured.`);
  } else if (prior.type || prior.carrier || prior.limit || prior.expiration) {
    record.priorInsurance.push(prior);
    // The current commercial auto policy is with a carrier the panel quotes (TNI, 2026-10-26: answer
    // to PR question 9: said on the intake check screen, so the agent doesn't fill that carrier's
    // pages for nothing; question 18: commercial auto only, util.js quotedCarrierPolicy). Named,
    // since an intake isn't tied to one carrier; in red (`alert`), and a warning only (question 19):
    // filling goes on. The panel shows it only on that carrier's site (checkShown; TNI, 2026-10-27),
    // and the carrier's pages say it again (W44-27).
    const quoted = quotedCarriersOf(prior);
    if (quoted.length) {
      warnings.push({ code: 'prior.carrier-is-quoted', path: 'priorInsurance[0].carrier', level: 'check', alert: true,
        msg: `Current insurance is with ${quoted.join(' and ')}: a ${quoted.join(' or ')} quote may be declined or routed. Check with the client first.` });
    }
    if (prior.type === 'Personal Auto') info('prior.personal-auto', 'priorInsurance[0].type', 'Current insurance is a personal auto policy — no prior commercial coverage.');
    // TNI (2026-10-26, W44-29): any box filled is proof of prior insurance, 1-3 years (util.js
    // priorInsuranceAssumed), and the agent is told at the start which boxes are blank.
    const missing = [
      ['policy type', prior.type], ['carrier', prior.carrier], ['limit', prior.limit], ['expiration date', prior.expiration],
    ].filter(([, value]) => !value).map(([name]) => name);
    const named = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
    if (missing.length && priorInsuranceAssumed(record, prior)) check('prior.incomplete', 'priorInsurance[0]', `Current insurance: missing the ${named}. Proof of prior insurance (1-3 years) is assumed (TNI); get the rest from the client.`);
    else if (missing.length) check('prior.incomplete', 'priorInsurance[0]', `Current insurance: missing the ${named}. Confirm before quoting.`);
    if (prior.expiration && /^\d{2}\/\d{2}\/\d{4}$/.test(prior.expiration)) {
      const [mm, dd, yyyy] = prior.expiration.split('/').map(Number);
      const expiry = Date.UTC(yyyy, mm - 1, dd);
      const current = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
      if (expiry < current) check('prior-expiration.expired', 'priorInsurance[0].expiration', `Expired ${prior.expiration}. Uses the intake date; review it.`);
    }
  }

  // --- Coverage -------------------------------------------------------------------------------
  const cargo = parseLimitDeductible(raw.cargo_limit_ded);
  record.coverage.cargoLimit = cargo.limit;
  record.coverage.cargoDeductible = cargo.deductible;
  if (record.coverage.cargo && !cargo.limit) check('cargo-limit.missing', 'coverage.cargoLimit', 'Wants cargo coverage but no limit chosen.');
  // No deductible: the carriers leave the cargo limit to the agent (TNI, 2026-10-27).
  else if (record.coverage.cargo && cargo.deductible == null) check('cargo-deductible.missing', 'coverage.cargoDeductible', 'No cargo deductible: usually $1,000 or $2,500.');
  // Non-Trucking asks for a limit too: the carrier's NTL limit (the review of PR #176).
  if ((record.coverage.autoLiability === 'Yes' || nonTruckingAnswer(record.coverage.autoLiability)) && !record.coverage.autoLiabLimit) check('auto-limit.missing', 'coverage.autoLiabLimit', 'Wants auto liability but no limit chosen.');
  if (record.coverage.gl && !record.coverage.glLimit) check('gl-limit.missing', 'coverage.glLimit', 'No GL limit. TNI default is $1M/$2M: confirm with the client.');

  // --- Claims box -----------------------------------------------------------------------------
  // Clients use this box for answers to other questions too. A leading yes/no answers the claims
  // question ("CLEAN" is a No: CLAIMS_CLEAN); everything else is kept as notes (no warning) for
  // the agent and the AI assistant.
  const claims = record.claims.text;
  if (claims) {
    const lines = claims.split('\n');
    if (/^(no|none|no claims?)\.?$/i.test(lines[0]) || CLAIMS_CLEAN.test(lines[0])) record.claims.hasClaims = false;
    else if (/^yes\b/i.test(lines[0])) record.claims.hasClaims = true;
    const notes = (record.claims.hasClaims == null ? lines : lines.slice(1)).filter(Boolean);
    record.claims.notes = notes.length ? notes.join('\n') : null;
  } else check('claims.blank', 'claims.text', 'Claims question left blank.');
  // The claims box's other answers and the Additional Notes box are read alike.
  const notes = otherNotes(record);
  if (notes) {
    // A blank ownership answer that turns up in the notes ("Financed") is the ownership answer,
    // when the note is unambiguous (ownershipFromNotes); otherwise the agent reads it. The box
    // itself always wins over the notes.
    const own = ops.vehicleOwnership ? null : ownershipFromNotes(notes);
    if (own?.value) ops.vehicleOwnership = own.value;
    else if (own) check('ownership.notes', 'operations.vehicleOwnership', `Notes mention ownership ("${own.lines}"). Set it yourself.`);
  }
  // A time with the current insurer beyond the 1-3 years standard (AmWINS' 1 TO 2 YEARS): the
  // carriers' how-long questions take its band, the line shown here, where it was read (TNI,
  // 2026-10-26: answer to PR question, W44-29). From 2 years: AmWINS' 1 TO 2 and 2 TO 3 YEARS share
  // 2, and a time on a band edge takes the upper band (TNI, 2026-10-26: answer to PR question, round 2, R5).
  // An expired policy: both carriers leave the question to the agent (TNI, 2026-10-26: answer to PR
  // question, round 3, T6), so the check says that instead of a band. So does a General Liability,
  // Cargo or Other policy (TNI, 2026-10-27: answer to PR question, round 5, V8).
  const tenure = insurerTenure(record);
  if (tenure && tenure.years >= 2) {
    const inNotes = String(record.notes?.text ?? '').split('\n').map((s) => s.trim()).includes(tenure.line);
    const then = priorPolicyExpired(record)
      ? 'The policy has expired, so time with the insurer is yours (TNI).'
      : priorPolicyNotAuto(record.priorInsurance?.[0])
        ? 'The policy isn\'t auto, so time with the insurer is yours (TNI).'
        : 'Its band is filled, at least 1-3 years (TNI); between two bands, yours.';
    check('prior.tenure', inNotes ? 'notes.text' : 'claims.text', `Time with insurer: "${tenure.line.slice(0, 160)}". ${then}`);
  }
  // Non-trucking liability (NTL) is named only in the notes: "NTL", "non-trucking" (also written
  // "non tracking"), "bobtail". A mention is not a request ("no bobtail", "asked about NTL"): the
  // agent decides, and nothing is added until they set it to Yes.
  // Decided by the form's Non-Trucking answer: said, and no question about the notes.
  const ntlLine = ntlMention(intakeNotes(record));
  if (record.coverage.ntl === true) info('coverage.ntl-form', 'coverage.ntl', NTL_FORM_MESSAGE);
  else if (ntlLine) check('coverage.ntl', 'coverage.ntl', ntlCheckMessage(ntlLine));
  if (ntlWithCargo(record)) check('coverage.ntl-cargo', 'coverage.cargo', NTL_CARGO_MESSAGE);
  // NTL and primary auto liability both asked for (TNI, 2026-10-26: answer to PR question). Today's
  // form can't ask for both (Non-Trucking is its auto liability answer): the agent's NTL Yes with
  // auto liability Yes can, and the panel adds the check then (sidepanel ntlPrimaryEdited).
  if (ntlWithPrimary(record)) check('coverage.ntl-primary', 'coverage.autoLiability', NTL_PRIMARY_MESSAGE);
  // An NTL quote gets no USDOT number and no filings (W44-28): said where the intake asks otherwise.
  if (ntlNoDotFilings(record) && (ops.filingsRequired === true || record.applicant.dot)) {
    info('coverage.ntl-filings', ops.filingsRequired === true ? 'operations.filingsRequired' : 'applicant.dot', ntlFilingsMessage(record));
  }
  if (record.vehicles.length && !ops.vehicleOwnership && !warnings.some((w) => w.path === 'operations.vehicleOwnership')) {
    check('ownership.missing', 'operations.vehicleOwnership', 'Not selected.');
  }

  const unknown = Object.keys(raw).filter((k) => !KNOWN_FIELDS.has(k) && clean(raw[k]) != null && raw[k] !== false);
  if (unknown.length) info('form.unknown-fields', '', `Fields not read yet: ${unknown.join(', ')}.`);

  const filled = Object.values(raw).filter((v) => v === true || (typeof v === 'string' && clean(v) != null)).length;
  return { record, warnings, stats: { fields: Object.keys(raw).length, filled }, rows, readFrom };
}

// Parses a value typed into the review panel, according to the field's kind.
export function parseEdit(kind, text) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  switch (kind) {
    case 'bool': return s === 'true' ? true : s === 'false' ? false : null;
    case 'int': return toInt(s) ?? s;
    case 'money': return toMoney(s) ?? s;
    case 'date': return toDate(s) ?? s;
    case 'state': return s.toUpperCase();
    default: return s;
  }
}

// The scalars normalizeIntake derives from another field, recomputed after the agent corrects
// the source in the panel (set first, then rederive). Only the source triggers it: an edit to
// the derived field itself ("Radius (miles)") is the agent's value and is left as typed, also
// when the source is edited afterwards (the panel passes the paths the agent edited as `keep`).
const DERIVED = {
  // Non-Trucking on auto liability is an NTL request; another answer leaves NTL to the agent.
  'coverage.autoLiability': ['coverage.ntl', (record) => (nonTruckingAnswer(record.coverage?.autoLiability) ? true : null)],
  'operations.radius': ['operations.radiusMiles', (record) => parseRadius(record.operations?.radius).miles],
  'applicant.yearEstablished': ['applicant.yearsInBusiness', (record, year) => {
    const est = record.applicant?.yearEstablished;
    return Number.isInteger(est) && est >= 1900 && est <= year ? year - est : null;
  }],
};

/**
 * @param {object} record  the client record, already holding the edit at `path`
 * @param {string} path  the edited field
 * @param {{ today?: Date, keep?: Set<string> }} [options]  keep: derived paths the agent set
 *   directly, never recomputed
 * @returns {string[]} the derived paths that were recomputed
 */
export function rederive(record, path, { today = new Date(), keep } = {}) {
  const derived = DERIVED[path];
  if (!derived) return [];
  const [target, compute] = derived;
  if (keep?.has(target)) return [];
  set(record, target, compute(record, today.getFullYear()));
  return [target];
}
