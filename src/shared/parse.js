// @ts-check
// Shared value parsers: blank answers, amounts, yes/no, numbers, dates, phones, VINs, names and
// license numbers, as an intake writes them. Every product reads its own intake with these (the
// commercial-auto normalizer, src/normalize.js, today), so they import no product's code: a module
// here imports only src/shared/ and src/states.js (test/boundaries.test.mjs). Some still read a
// value the way TNI decided for commercial auto, where they were written: a two-digit year above
// 40 is 19xx, else 20xx (toDate), a license number keeps a leading state code (parseLicense), and a
// lone letter after a first name is the middle initial (splitName). A product that needs otherwise
// reads that value its own way, in its own code; something only one product means never goes here
// behind a product check.

import { STATES } from '../states.js';

const BLANK = /^(n\/?a|none|null|nil|unknown|-+|\.+|select\*?)$/i;

export function clean(v) {
  if (v == null || typeof v !== 'string') return v ?? null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s === '' || BLANK.test(s) ? null : s;
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

// What is wrong with a VIN in the client record (the intake's, or an agent's edit in the panel), read
// as normalizeIntake reads one (spaces and dashes dropped, upper case): vinProblem's reason, the
// intake's vin.invalid check. null for a VIN that looks right, and for none (vin.missing).
/** @param {unknown} vin @returns {string | null} */
export function vinUnreadable(vin) {
  if (vin == null) return null;
  const s = String(vin).replace(/[\s-]/g, '').toUpperCase();
  return s ? vinProblem(s) : null;
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

// License numbers are entered plain: letters (rare) and digits only, never dashes or spaces.
export const plainLicense = (s) => String(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

// "MD - 10123456789" -> { state: 'MD', number: 'MD10123456789' }: a leading state code tells us
// the license state, but it stays in the number (agents enter it that way).
export function parseLicense(v) {
  const s = clean(v);
  if (s == null) return { state: null, number: null };
  const m = s.match(/^([A-Za-z]{2})\s*[-:#]\s*(.+)$|^([A-Za-z]{2})\s+(.*\d.*)$/);
  if (m) {
    const st = (m[1] ?? m[3]).toUpperCase();
    const rest = m[2] ?? m[4];
    if (STATES[st] && plainLicense(rest).length >= 5) return { state: st, number: plainLicense(s) };
  }
  return { state: null, number: plainLicense(s) };
}
