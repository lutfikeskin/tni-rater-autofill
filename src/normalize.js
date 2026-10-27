// @ts-check
// Turns the raw field map from the TNI "Commercial Insurance Quote Application" PDF into a clean
// client record, plus a list of things the agent should double-check before quoting.
//
// Rule of thumb: clean up formatting, never guess at meaning. Anything ambiguous stays as the
// client wrote it and gets a warning instead.

import { STATES, noPriorInsurance, ownerIsDriver, set, companyName } from './util.js';

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
// to be inferred from where the street part seems to end.
export function parseAddress(raw) {
  const s = clean(raw);
  if (s == null) return null;
  const out = { street: s, unit: null, city: null, state: null, zip: null, confident: false };
  // What follows the ZIP: a comma or period ("…, MN 55447,"), or the country ("…, MN 55447, USA").
  const body = s.replace(/[\s,.;]+(?:(?:USA|U\.S\.A\.?|US|U\.S\.?|United States(?: of America)?)[\s,.;]*)?$/i, '');
  const m = body.match(/^(.*?)[,\s]+([A-Za-z]{2})\.?[,\s]+(\d{5})(?:-?(\d{4}))?\s*$/);
  if (!m || !STATES[m[2].toUpperCase()]) return out;
  out.state = m[2].toUpperCase();
  out.zip = m[4] ? `${m[3]}-${m[4]}` : m[3];
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

// The form's auto liability answer Non-Trucking (Select / Yes / No / Non-Trucking): the client asks
// for non-trucking liability (the maintainer, 2026-10-26). Also as written on older forms.
export const nonTruckingAnswer = (v) => /^\s*non[\s-]*trucking\s*$/i.test(String(v ?? ''));
// "Does this driver have a CDL?": the intake's answer; a blank box is No (TNI's standard, the
// maintainer, 2026-10-26), unless a CDL year is filled in: then the agent's (`cdl.blank-with-year`).
// No driver: nothing.
export const cdlStandard = (driver) => !!driver && typeof driver.cdl !== 'boolean' && driver.cdlYear == null;
export const cdlAnswer = (driver) => (cdlStandard(driver) ? false : typeof driver?.cdl === 'boolean' ? driver.cdl : null);
export const ntlMention = (text) => String(text ?? '').split('\n').find((line) => NTL_WORDS.test(line))?.trim() || null;
// What the filler does on an NTL quote, carrier by carrier (the NTL items below and Luna's).
export const NTL_FILLS = 'On Progressive the filler adds it on Rates, answers the permanent lease question Yes, puts the limit in the NTL limit and leaves Bodily Injury and Property Damage Liability Not selected, then does the rest of Rates through Print, Email, Fax; with cargo or general liability too, the rest of Rates is yours. On GEICO it picks Non-Trucking Liability, answers "Yes, under permanent lease" and puts the limit in the NTL list. On AmWINS it is written in the disclosure details on Underwriting.';
export const ntlCheckMessage = (line) => `The claims box or Additional Notes mention non-trucking liability (NTL): "${line}". If the client wants NTL, set Non-trucking liability to Yes. ${NTL_FILLS}`;
// The intake's info item when the form's auto liability is Non-Trucking (coverage.ntl-form).
export const NTL_FORM_MESSAGE = `Auto liability is Non-Trucking on the intake: Non-trucking liability is set to Yes. ${NTL_FILLS}`;
// NTL and cargo both asked for (the maintainer, 2026-10-26): an NTL client is leased on to a motor
// carrier, which covers the cargo, so the agent confirms it with the client. Every carrier.
export const ntlWithCargo = (record) => record?.coverage?.ntl === true && record?.coverage?.cargo === true;
export const NTL_CARGO_MESSAGE = 'Non-trucking liability (NTL) and cargo coverage are both asked for. An NTL client is leased on to a motor carrier, which usually covers the cargo: confirm with the client whether they want cargo, and set Cargo coverage to No if not.';

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
// claims, and with no negation. Two figures that disagree settle nothing: the agent's, as when the
// notes say nothing.
// A word before the figure: "over", "about", "around", "more than" and "approximately" (or
// "approx.") read as the figure itself, "over 3 years" is 3, with the check quoting the phrase
// (TNI, 2026-10-26: answer to PR question). "less than 1 year" and "under 1 year" are 0, a new
// venture (TNI, 2026-10-26: answer to PR question, R10); any other "less than N" or "under N"
// settles nothing, nor do "almost", "nearly" and ~ < >, as a figure that isn't whole ("2.5 years").
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
// ("a month in business" isn't named: unread). "a few years", "several years", "a couple of years",
// "one and a half years" and "second year" settle nothing.
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS_WORDS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const UNIT_WORDS = NUMBER_WORDS.slice(1, 10);
const WORD_NUMBER = `(?:(?:${TENS_WORDS.join('|')})(?:[\\s-]+(?:${UNIT_WORDS.join('|')}))?|${NUMBER_WORDS.join('|')})`;
const RANGE_SEP = '\\s*(?:[-–—]|\\b(?:to|or|and)\\b)\\s*';
const RANGE_END = `(?<!(?:\\d|\\b(?:${[...NUMBER_WORDS, ...TENS_WORDS].join('|')}))\\s*\\+?${RANGE_SEP})`;
const IN_WORDS = `(?<![\\w-])${RANGE_END}${WORD_NUMBER}(?![\\w-])`;
const A_YEAR = '(?=\\s+(?:year|yr)\\b(?!-)(?!\\.?\\s+ago\\b))';
const NUMBER = `\\d{1,3}|${IN_WORDS}|(?<![\\w-])half\\s+a${A_YEAR}|(?<![\\w-])(?<!\\b(?:half|once|twice)\\s+)a${A_YEAR}`
  + '|(?<=\\b(?:less\\s+than|under)\\s+)a(?=\\s+(?:months?|mos?)\\b)';
const numberValue = (s) => {
  if (/^\d+$/.test(s)) return Number(s);
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
// "a year and a half" (V11): 1.
const AND_A_HALF = '(?:(?<=\\ba\\s+(?:year|yr)\\.?)(?<half>\\s+and\\s+a\\s+half)\\b)?';
const YEARS = `(?:(?<word>${QUALIFIER})\\s*)?(?<n>${NUMBER})\\s*\\+?\\s*(?<unit>${YEARS_UNIT}|${MONTHS_UNIT})\\b\\.?${AND_A_HALF}(?:(?<=${YEARS_UNIT}\\.?)${AND_MONTHS})?`;
// A range (TNI, 2026-10-27: answer to PR question V7): an answer only when both ends give the same
// one. Years in business is a number, so "2-3 years in business" is the agent's, with the check
// naming the line (before, it read the last figure, 3), in words too ("two to three years"); ends
// that round to the same whole years ("18-20 months", both 1) give that number.
const RANGE_FIRST = `\\d{1,3}|(?<![\\w-])${WORD_NUMBER}(?!\\w)`;
const RANGE_SECOND = `\\d{1,3}|(?<![\\w])${WORD_NUMBER}(?![\\w-])`;
const RANGE = `(?<span>(?:(?<word>${QUALIFIER})\\s*)?(?:between\\s+)?(?<a>${RANGE_FIRST})\\s*\\+?(?<sep>${RANGE_SEP})(?<b>${RANGE_SECOND})\\s*\\+?\\s*(?<unit>${YEARS_UNIT}|${MONTHS_UNIT})\\b)\\.?`;
// "twenty-five" and "twenty five" are one number, not a range from twenty to five.
const TENS_WORD = new RegExp(`^(?:${TENS_WORDS.join('|')})$`, 'i');
const ONES_WORD = new RegExp(`^(?:${UNIT_WORDS.join('|')})$`, 'i');
const compound = (a, sep, b) => TENS_WORD.test(a) && /^\s*-?\s*$/.test(sep) && ONES_WORD.test(b);
// "first year in business" (V11): 0.
const FIRST_YEAR = /(?<![\w-])(?<reading>first\s+(?:year|yr))\s+in\s+(?:business|biz)\b/i;
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
  new RegExp(`(?<![\\w.,])${YEARS}\\s+in\\s+${BIZ}`, 'i'),
  new RegExp(`\\bin\\s+${BIZ}\\s+(?:for\\s+)?${YEARS}`, 'i'),
];
const RANGE_PHRASES = [
  new RegExp(`(?<![\\w.,])${RANGE}\\s+in\\s+${BIZ}`, 'i'),
  new RegExp(`\\bin\\s+${BIZ}\\s+(?:for\\s+)?${RANGE}`, 'i'),
];
const BIZ_START = new RegExp(`\\b(?:established|founded|in\\s+${BIZ}\\s+since)\\s+(?:in\\s+)?(\\d{4})\\b`, 'i');
const NOT_THE_BUSINESS = /\b(?:not|never|no)\b|n't\b|\b(?:driv\w*|cdl|licen[cs]\w*|experienced?|authority|mc|dot|usdot|insur\w*|polic(?:y|ies)|pop|coverage|carriers?|claims?|accidents?|tickets?|violations?)\b/i;
// A qualifier just before the match that the match itself doesn't hold (",less than 3 years").
const QUALIFIED = new RegExp(`(?:^|[^\\w])${QUALIFIER}\\s*$`, 'i');
const MAX_BUSINESS_YEARS = 100;

/**
 * Years in business the notes state, from the boxes given in order ([form field, text]): one
 * statement, or several that agree. None, an undecided qualifier ("less than 3") or figures that
 * disagree give null. `reading`: the figure as written when it isn't plain whole years in digits
 * ("over 3 years", "less than 1 year", "18 months", "two years", "1 year 6 months"), for the first one.
 * A range whose ends give different years (V7) gives `years` null and `range` true, quoting it: the
 * agent's, whatever else the notes say.
 * @param {[string, string|null|undefined][]} boxes
 * @param {number} year  this year, for a start year
 * @returns {{ years: number|null, range?: true, established: number|null, quote: string, fields: string[], reading: string|null } | null}
 */
export function yearsInBusinessFromNotes(boxes, year) {
  const found = [];
  for (const [field, text] of boxes) {
    for (const line of String(text ?? '').split('\n')) {
      const yearsThenMonths = YEARS_THEN_MONTHS.test(line);
      // The years one figure gives, with the word before it, or null when it settles nothing.
      const yearsOf = (word, figure, unit, more, before) => {
        const months = MONTHS.test(unit);
        // "less than 1 year", "under 1 year": 0 (R10); "less than N months", N up to 12: 0 (T8),
        // and "under N months" alike (U1). Not with more after the year ("less than 1 year 6
        // months", "under 1 year 6 months" and "under a year and a half" are more than a year).
        const belowOne = Boolean(word) && BELOW.test(word) && !months && !more && figure === 1;
        const belowAYear = Boolean(word) && BELOW.test(word) && months && figure >= 1 && figure <= MAX_MONTHS_BELOW_A_YEAR;
        const read = word ? AS_THE_FIGURE.test(word) || belowOne || belowAYear : !QUALIFIED.test(before);
        return !read || (months && yearsThenMonths) ? null : belowOne || belowAYear ? 0 : Math.floor(months ? figure / 12 : figure);
      };
      for (const clause of clausesOf(line)) {
        const quote = clause.trim();
        if (!quote || NOT_THE_BUSINESS.test(quote)) continue;
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
        const first = quote.match(FIRST_YEAR);
        if (first?.groups) found.push({ years: 0, established: null, quote, field, reading: first.groups.reading.replace(/\s+/g, ' ') });
        for (const re of BIZ_PHRASES) {
          const m = quote.match(re);
          if (!m?.groups) continue;
          const { word, n, unit, months: andMonths, monthsUnit, half } = m.groups;
          const years = yearsOf(word, numberValue(n) + (half ? 0.5 : 0), unit, andMonths || half, quote.slice(0, m.index));
          // How it was read, when it isn't plain whole years in digits.
          const reading = word || MONTHS.test(unit) || andMonths || !/^\d+$/.test(n)
            ? `${word ? `${word} ` : ''}${n.replace(/\s+/g, ' ')} ${unit}${half ? ' and a half' : ''}${andMonths ? ` ${andMonths} ${monthsUnit}` : ''}` : null;
          found.push({ years, established: null, quote, field, reading });
        }
        const start = quote.match(BIZ_START);
        if (start) found.push({ years: year - Number(start[1]), established: Number(start[1]), quote, field, reading: null });
      }
    }
  }
  // A range whose ends differ is the agent's, whatever else the notes say (V7).
  const open = found.find((f) => f.range);
  if (open) return { years: null, range: true, established: null, quote: open.quote, fields: [open.field], reading: open.reading };
  const settled = found.every((f) => Number.isInteger(f.years) && f.years >= 0 && f.years <= MAX_BUSINESS_YEARS);
  if (!found.length || !settled || new Set(found.map((f) => f.years)).size > 1) return null;
  return {
    years: found[0].years, established: found.find((f) => f.established != null)?.established ?? null,
    quote: found[0].quote, fields: [...new Set(found.map((f) => f.field))], reading: found[0].reading,
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
    if (!pattern.test(digits)) { check('id.invalid', path, `${label} "${s}" doesn't look like a valid number.`); return s; }
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
    else { a.fein = txt('fein'); check('fein.invalid', 'applicant.fein', `FEIN "${a.fein}" should be 9 digits.`); }
  }
  const est = toInt(raw.year_established);
  if (est != null) {
    if (est >= 1900 && est <= year) { a.yearEstablished = est; a.yearsInBusiness = year - est; }
    else check('year-established.invalid', 'applicant.yearEstablished', `Year established "${txt('year_established')}" isn't a valid year.`);
  }
  if (txt('phone_number')) {
    a.phone = toPhone(raw.phone_number);
    if (!a.phone) { a.phone = txt('phone_number'); check('phone.invalid', 'applicant.phone', `Phone "${a.phone}" isn't a 10-digit US number.`); }
  }
  if (a.email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(a.email)) check('email.invalid', 'applicant.email', `Email "${a.email}" looks malformed.`);
  if (!a.dot && !a.mc && a.mcDotWithin60Days === true) {
    info('dot.pending', 'applicant.dot', 'No DOT/MC yet — client says they will have one within 60 days.');
  }
  if (a.noDot) info('dot.none', 'applicant.dot', `USDOT # "${asWritten('dot_number')}": the client has no USDOT number.`);
  if (a.noMc) info('mc.none', 'applicant.mc', `MC # "${asWritten('mc_number')}": the client has no MC number.`);
  if (NEW_AUTHORITY.test(txt('years_experience') ?? '')) info('years-experience.new', 'applicant.yearsExperience', `Years under own authority "${txt('years_experience')}": 0 years, a new authority.`);
  else if (txt('years_experience') && a.yearsExperience == null) check('years-experience.invalid', 'applicant.yearsExperience', `Years of experience "${txt('years_experience')}" isn't a number.`);
  // No year established on the form: the years in business the claims box or Additional Notes state,
  // with a check quoting them (TNI, 2026-10-26, W44-09). They win over years under own authority
  // for years in business (TNI, 2026-10-26: answer to PR question); the authority years are another
  // fact and stay as the form gives them, for their own questions. Never read from a business phrase.
  const stated = a.yearsInBusiness == null
    ? yearsInBusinessFromNotes([['claims_details', record.claims.text], ['additional_notes', record.notes.text]], year) : null;
  if (stated) {
    readFrom['applicant.yearsInBusiness'] = stated.fields;
    const box = stated.fields[0] === 'additional_notes' ? 'Additional Notes box' : 'claims box';
    const quote = stated.quote.length > 80 ? `${stated.quote.slice(0, 79).trimEnd()}…` : stated.quote;
    const form = a.yearsExperience == null ? 'The form gives no years in business'
      : `The form gives no year established, only years under own authority (${a.yearsExperience}), which stay for the authority questions`;
    if (stated.range) {
      // A range whose ends differ (TNI, 2026-10-27: answer to PR question V7): the agent's on every
      // carrier, neither the blank standard nor the authority years; the check names the line.
      a.yearsInBusinessRange = true;
      check('years-in-business.notes', 'applicant.yearsInBusiness', `${form}, and the ${box} says "${quote}": a range ("${stated.reading}"), so years in business is left to you. Enter Years in business or Year established here.`);
    } else {
      a.yearsInBusiness = stated.years;
      if (stated.established != null) { a.yearEstablished = stated.established; readFrom['applicant.yearEstablished'] = stated.fields; }
      // How a figure that isn't plain years was read: "over 3 years" as 3, "18 months" as 1 (R11).
      const reading = stated.reading ? ` ("${stated.reading}" read as ${stated.years})` : '';
      check('years-in-business.notes', 'applicant.yearsInBusiness', `${form}, and the ${box} says "${quote}": years in business is ${stated.years}${reading}${stated.established != null ? `, established ${stated.established}` : ''}. Check it (a plus counts as at least that many); a corrected answer here replaces it.`);
    }
  }
  // TNI's standard for a blank (2026-10-09): 0 years, established this year (AmWINS' rules fill
  // it, GEICO's leave it to the agent; the record stays blank, so a later answer here replaces it).
  // Not for a range in the notes (V7), which is the agent's.
  if (a.yearsInBusiness == null && a.yearsExperience == null && !a.yearsInBusinessRange) {
    check('years-in-business.default', 'applicant.yearsInBusiness', `Years in business and year established are blank: the AmWINS quote gets 0 years (New Venture), established ${year}; GEICO's question about it is left to you. If the client has been in business longer, enter Years in business or Year established.`);
  }

  // --- Garaging address -----------------------------------------------------------------------
  const addr = parseAddress(raw.garaging_address);
  if (addr) {
    const { confident, ...parts } = addr;
    record.garaging = parts;
    if (!addr.state || !addr.zip) check('address.unparsed', 'garaging.street', `Couldn't split the garaging address "${txt('garaging_address')}" into street / city / state / ZIP — fill those in.`);
    else if (!addr.city) check('address.no-city', 'garaging.city', `Couldn't tell where the street ends and the city starts in "${txt('garaging_address')}".`);
    else if (!confident) check('address.no-commas', 'garaging.city', `Address had no commas; split it as street "${[addr.street, addr.unit].filter(Boolean).join(' ')}", city "${addr.city}". Confirm.`);
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
      if (!d.dob) { d.dob = rawDob; check('dob.invalid', p('dob'), `${who}: date of birth "${rawDob}" isn't a valid MM/DD/YYYY date.`); }
      else {
        const age = year - Number(d.dob.slice(6));
        if (age < 18 || age > 90) check('dob.unusual-age', p('dob'), `${who}: date of birth ${d.dob} gives age ~${age}. Typo?`);
      }
    } else check('dob.missing', p('dob'), `${who}: no date of birth.`);

    if (rawLic) {
      const lic = parseLicense(rawLic);
      d.licenseNumber = lic.number;
      if (lic.state && !d.licenseState) d.licenseState = lic.state;
      if (lic.state && d.licenseState && lic.state !== d.licenseState) {
        check('license.state-mismatch', p('licenseState'), `${who}: license box says ${lic.state} but DL state dropdown says ${d.licenseState}.`);
      }
    } else check('license.missing', p('licenseNumber'), `${who}: no driver's license number.`);
    if (!d.licenseState) check('license-state.missing', p('licenseState'), `${who}: no license state.`);
    if (rawLic && plain(rawLic) !== rawLic.toUpperCase()) {
      info('license.cleaned', p('licenseNumber'), `${who}: license number written as "${rawLic}", entered as ${d.licenseNumber} (letters and digits only).`);
    }
    if (excluded) {
      // What the carriers do with it (TNI 2026-10-20): Progressive's exclude question is Yes; AmWINS
      // has none, and the license number gets "(Excluded)" after it. GEICO's Add Driver form asks
      // nothing about it (the driver is filled, with a warning).
      const amwins = d.licenseNumber ? 'their license number gets "(Excluded)" after it' : 'type "(Excluded)" after the license number you enter';
      check('license.excluded', p('excluded'), `${who}: license-number box "${licBox}": the driver is to be excluded, and ${d.licenseNumber ? `the license number is ${d.licenseNumber}` : 'it has no license number'}. Progressive's exclude question gets Yes; on AmWINS, which has no such question, ${amwins}. GEICO asks nothing about it: the driver's answers are filled with a warning, and the exclusion is yours. An exclusion usually needs the insured's signed form.`);
    }

    if (name.suffix) {
      const box = name.suffixIn === 'first' ? 'first-name' : 'last-name';
      info('name.suffix', p('suffix'), `${who}: ${box} box "${boxes[name.suffixIn]}" read as ${name.suffixIn === 'first' ? 'first' : 'last'} name ${d[name.suffixIn]} and suffix ${d.suffix}. Progressive's and AmWINS' driver pages have no suffix box, so it is left out there; GEICO's Add Driver form gets it.`);
    }
    if (name.middle) info('name.middle-initial', p('middle'), `${who}: first-name box "${boxes.first}" read as first name ${d.first} and middle initial ${d.middle}.`);
    if (d.first && /\s/.test(d.first)) {
      check('name.multi-word-first', p('first'), `${who}: first-name box has more than one word ("${d.first}"). Check the license for which part is the middle name.`);
    }
    if (!d.first || !d.last) check('name.missing-part', p(d.first ? 'last' : 'first'), `${who}: missing ${d.first ? 'last' : 'first'} name.`);
    if (d.cdl && !d.cdlYear) check('cdl-year.missing', p('cdlYear'), `${who}: has a CDL but no year it was issued.`);
    if (d.cdl === false && d.cdlYear) check('cdl-year.without-cdl', p('cdlYear'), `${who}: marked no CDL but a CDL year is filled in.`);
    if (d.cdl == null && d.cdlYear) check('cdl.blank-with-year', p('cdl'), `${who}: the CDL box is blank but a CDL year is filled in: answer whether they have a CDL (a blank box alone is No).`);
    record.drivers.push(d);
    rows.drivers.push(n);
  });
  if (companyAsWritten && !companyName(companyAsWritten)) info('company.none', 'applicant.name', `Company name "${companyAsWritten}": no company, so a sole proprietor.`);
  if (!record.drivers.length) check('drivers.none', 'drivers', 'No drivers listed.');
  if (a.ownerDrives && a.owner1) {
    if (!record.drivers.some((d) => ownerIsDriver(a.owner1, d))) {
      check('drivers.owner-not-listed', 'drivers', `Owner drives, but "${a.owner1}" isn't in the driver list.`);
    }
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
    check('vehicle-type.no-tractor', 'vehicles[0].type', `The intake lists a ${semiTrailer.type} trailer, but no vehicle is a Semi Truck (or Pickup Truck) to pull it (vehicle types: ${record.vehicles.map((v) => v.type ?? 'none').join(', ')}). Check the vehicle types.`);
  }
  if (record.vehicles.length > 1 && ops.licensePlate) info('plate.ambiguous', 'operations.licensePlate', 'The form has one license-plate box but lists several vehicles; the plate may belong to only one of them.');

  // --- Operations -----------------------------------------------------------------------------
  // "Unlimited", long haul, OTR, 48 states: no mileage; the carrier rules pick their widest band.
  const radius = parseRadius(ops.radius);
  ops.radiusMiles = radius.miles;
  if (radius.kind === 'missing') check('radius.missing', 'operations.radius', 'No radius of operations.');
  else if (radius.kind === 'range') check('radius.range', 'operations.radiusMiles', `Radius is "${ops.radius}", a range. Raters ask for the farthest one-way distance: enter it in miles.`);
  else if (radius.kind === 'unit') check('radius.unit', 'operations.radiusMiles', `Radius is "${ops.radius}", not in miles. Convert it and enter the miles.`);
  else if (radius.kind === 'text') check('radius.not-miles', 'operations.radius', `Radius is "${ops.radius}", not a number of miles. Raters usually want miles or a band (e.g. 500+).`);
  if (ops.usesEld && !ops.eldBrand) check('eld-brand.missing', 'operations.eldBrand', 'Uses an ELD but brand not given.');
  if (ops.filingsRequired && !ops.filingsWhich) check('filings-which.missing', 'operations.filingsWhich', 'Needs filings but did not say which.');
  // Filings are made under a USDOT or MC number (the maintainer, 2026-10-26: a wrong intake).
  if (ops.filingsRequired === true && !record.applicant.dot && !record.applicant.mc) {
    check('filings.no-number', 'applicant.dot', `Needs filings but no USDOT or MC number is given${record.applicant.mcDotWithin60Days === true ? ' (the client says they will have one within 60 days)' : ''}. Filings are made under a number: check with the client.`);
  }
  if (ops.hazmat) check('hazmat.yes', 'operations.hazmat', 'Hauls hazmat, tobacco or prescription drugs — confirm which, most raters treat these differently.');

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
    if (prior.type === 'Personal Auto') info('prior.personal-auto', 'priorInsurance[0].type', 'Current insurance is a personal auto policy — no prior commercial coverage.');
    const missing = [
      ['type', prior.type], ['carrier', prior.carrier], ['limit', prior.limit], ['expiration', prior.expiration],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) check('prior.incomplete', 'priorInsurance[0]', `Current insurance is missing ${missing.join(', ')}; confirm the policy details before quoting.`);
    if (prior.expiration && /^\d{2}\/\d{2}\/\d{4}$/.test(prior.expiration)) {
      const [mm, dd, yyyy] = prior.expiration.split('/').map(Number);
      const expiry = Date.UTC(yyyy, mm - 1, dd);
      const current = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
      if (expiry < current) check('prior-expiration.expired', 'priorInsurance[0].expiration', `Current policy expiration ${prior.expiration} is before today; use the intake date and have an agent review it.`);
    }
  }

  // --- Coverage -------------------------------------------------------------------------------
  const cargo = parseLimitDeductible(raw.cargo_limit_ded);
  record.coverage.cargoLimit = cargo.limit;
  record.coverage.cargoDeductible = cargo.deductible;
  if (record.coverage.cargo && !cargo.limit) check('cargo-limit.missing', 'coverage.cargoLimit', 'Wants cargo coverage but no limit chosen.');
  // Non-Trucking asks for a limit too: the carrier's NTL limit (the review of PR #176).
  if ((record.coverage.autoLiability === 'Yes' || nonTruckingAnswer(record.coverage.autoLiability)) && !record.coverage.autoLiabLimit) check('auto-limit.missing', 'coverage.autoLiabLimit', 'Wants auto liability but no limit chosen.');
  if (record.coverage.gl && !record.coverage.glLimit) check('gl-limit.missing', 'coverage.glLimit', 'Wants general liability but no limit chosen: TNI\'s default is $1M/$2M ($1M per occurrence, $2M aggregate). Confirm it with the client.');

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
    else if (own) check('ownership.notes', 'operations.vehicleOwnership', `The claims box or Additional Notes mention ownership ("${own.lines}") but don't settle it for the vehicles. Set Vehicle ownership (owned / leased / financed) yourself.`);
  }
  // Non-trucking liability (NTL) is named only in the notes: "NTL", "non-trucking" (also written
  // "non tracking"), "bobtail". A mention is not a request ("no bobtail", "asked about NTL"): the
  // agent decides, and nothing is added until they set it to Yes.
  // Decided by the form's Non-Trucking answer: said, and no question about the notes.
  const ntlLine = ntlMention(intakeNotes(record));
  if (record.coverage.ntl === true) info('coverage.ntl-form', 'coverage.ntl', NTL_FORM_MESSAGE);
  else if (ntlLine) check('coverage.ntl', 'coverage.ntl', ntlCheckMessage(ntlLine));
  if (ntlWithCargo(record)) check('coverage.ntl-cargo', 'coverage.cargo', NTL_CARGO_MESSAGE);
  if (record.vehicles.length && !ops.vehicleOwnership && !warnings.some((w) => w.path === 'operations.vehicleOwnership')) {
    check('ownership.missing', 'operations.vehicleOwnership', 'Vehicle ownership (owned / leased / financed) not selected.');
  }

  const unknown = Object.keys(raw).filter((k) => !KNOWN_FIELDS.has(k) && clean(raw[k]) != null && raw[k] !== false);
  if (unknown.length) info('form.unknown-fields', '', `The PDF has filled fields this tool doesn't read yet: ${unknown.join(', ')}.`);

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
