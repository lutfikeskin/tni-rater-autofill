// @ts-check
// Shared personal-auto answer helpers for all PA carriers (Progressive PA, GEICO PA, …).
// Product-isolated: imports only shared modules (src/shared/, src/states.js) and sibling
// src/products/personal-auto/* modules — never commercial-auto modules (test/boundaries.test.mjs).

import { STATES } from '../../states.js';

/** @import { ClientRecord } from '../../../types.js' */

/** Notes mentioning rideshare (TNC) or app-based food/package delivery. */
export const RIDESHARE_OR_DELIVERY = /\b(uber|lyft|rideshare|ride[\s-]*share|tnc|doordash|door\s*dash|instacart|grubhub|ubereats|uber\s*eats|postmates|shipt|spark\s*driver|amazon\s*flex|delivery)\b/i;

/** Notes mentioning SR-22, FR-44, or a state financial-responsibility filing. */
export const SR22_NOTES = /\b(sr[\s-]*22|fr[\s-]*44|state\s+filing)\b/i;

/** License box or notes mentioning an excluded driver. */
export const EXCLUDED_WORD = /\bexclud(?:e|ed|ing)\b/i;

/** Notes mentioning unlisted household residents (roommates, additional residents). */
export const EXTRA_RESIDENTS = /\b(roommate|additional\s+resident|other\s+resident|lives?\s+in\s+(?:the\s+)?home|unlisted\s+(?:adult|child|kid|resident))\b/i;

/** Notes mentioning accidents, tickets, violations, DUI/DWI, license suspensions/revocations, claims, or citations. */
export const INCIDENT_NOTES = /\b(accidents?|tickets?|violations?|dui|dwi|suspensions?|suspended|revocations?|revoked|claims?|citations?|speeding|reckless\s+driv(?:ing|er)|at[\s-]*fault)\b/i;

const COMMUTE_DAYS = /** @type {const} */ (['1', '2', '3', '4', '5', '6', '7']);
const GLASS_DEDUCTIBLE_BASE = new Set(['$100', '$250', '$500', '$1,000']);

/**
 * Trimmed additional notes text from the client record (empty string when absent).
 * @param {ClientRecord | null | undefined} r
 * @returns {string}
 */
export const notesOf = (r) => String(r?.notes?.text ?? '').trim();

/**
 * Full US state name from a 2-letter postal code (`DC` -> `'Dist of Columbia'`), else input or null.
 * @param {string | null | undefined} code
 * @returns {string | null}
 */
export const stateFullName = (code) => {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return null;
  if (c === 'DC') return 'Dist of Columbia';
  return STATES[c] ?? code ?? null;
};

/**
 * Calendar date formatted as `MM/DD/YYYY` (defaults to today).
 * @param {Date} [d]
 * @returns {string}
 */
export const todayMmDdYyyy = (d = new Date()) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

/**
 * The driver marked `Insured`, else the first listed driver, else null.
 * @param {ClientRecord | null | undefined} r
 * @returns {any}
 */
export const insuredDriver = (r) => {
  const list = r?.drivers ?? [];
  return list.find((d) => /^insured$/i.test(d?.relation ?? '')) ?? list[0] ?? null;
};

/**
 * Drivers ordered so index 0 is the Named Insured, followed by the remaining household members in
 * intake order.
 * @param {ClientRecord | null | undefined} r
 * @returns {any[]}
 */
export const orderedDrivers = (r) => {
  const list = r?.drivers ?? [];
  const primary = insuredDriver(r);
  if (!primary) return [];
  return [primary, ...list.filter((d) => d !== primary)];
};

/**
 * Driver at index `i` in Named-Insured-first order, or null.
 * @param {ClientRecord | null | undefined} r
 * @param {number} i
 * @returns {any}
 */
export const driverAt = (r, i) => orderedDrivers(r)[i] ?? null;

/**
 * Vehicle at index `i` in intake order, or null.
 * @param {ClientRecord | null | undefined} r
 * @param {number} i
 * @returns {any}
 */
export const vehicleAt = (r, i) => r?.vehicles?.[i] ?? null;

/**
 * General personal-auto rule: when a driver or named insured has a second name in `first` and no
 * separate `middle`, keep the first word as First Name and use the second word's first letter as
 * Middle Initial (so both newly read intakes and panel-edited/cached records follow the same rule).
 * @param {any} d
 * @returns {{ first: string | null, middle: string | null }}
 */
export function driverFirstMiddle(d) {
  if (!d) return { first: null, middle: null };
  const rawFirst = String(d.first ?? '').trim();
  const rawMiddle = String(d.middle ?? '').trim();
  if (!rawFirst) return { first: null, middle: rawMiddle ? rawMiddle[0].toUpperCase() : null };
  if (!rawMiddle) {
    const words = rawFirst.split(/\s+/);
    if (words.length >= 2 && (words[0].match(/\p{L}/gu) ?? []).length >= 2) {
      const letter = words[1].match(/\p{L}/u)?.[0] ?? null;
      if (letter) return { first: words[0], middle: letter.toUpperCase() };
    }
  }
  return { first: rawFirst, middle: rawMiddle ? rawMiddle[0].toUpperCase() : null };
}

/**
 * Format a 10-digit US phone as `XXX-XXX-XXXX` (stripping leading country code `1` when 11 digits).
 * Returns trimmed input unchanged if it is not 10 digits, or null when blank.
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function dashedPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : s;
}

/**
 * One-line garaging address (`street, city, ST ZIP`) for carrier address-autocomplete inputs.
 * @param {ClientRecord | null | undefined} r
 * @returns {string | null}
 */
export function oneLineAddress(r) {
  const g = r?.garaging ?? {};
  if (!g.street) return null;
  return [g.street, g.city, [g.state, g.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/**
 * Sum explicit duration components ("1 year 6 months", "0 years 6 months", "6 weeks", "45 days")
 * into months, or null if none matched.
 * @param {string} s
 * @returns {number | null}
 */
export function exactDurationMonths(s) {
  const yr = s.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?|y\b)/);
  const mo = s.match(/(\d+(?:\.\d+)?)\s*\+?\s*(?:months?|mos?|m\b)/);
  const wk = s.match(/(\d+(?:\.\d+)?)\s*(?:weeks?|wks?)/);
  const dy = s.match(/(\d+(?:\.\d+)?)\s*days?/);
  if (!yr && !mo && !wk && !dy) return null;
  return (yr ? Number(yr[1]) * 12 : 0)
    + (mo ? Number(mo[1]) : 0)
    + (wk ? Number(wk[1]) / 4.3 : 0)
    + (dy ? Number(dy[1]) / 30 : 0);
}

/**
 * Parse intake "time at address" into months when unambiguous for the 2-month move check,
 * or null if blank, unreadable, or an ambiguous bound (e.g. "less than 1 year", "under 6 months").
 * @param {string | null | undefined} text
 * @returns {number | null}
 */
export function addressMonths(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\btwo\b/g, '2').replace(/\bone\b/g, '1');
  if (!s) return null;
  if (/\bjust\s+moved\b/.test(s)) return 1;
  // Upper-bound phrases ("less than ...", "under ...", "< ...", "<= ...", "up to ...", "at most ..."):
  // only unambiguous when the bound guarantees < 2 months; wider bounds ("less than 1 year") stay null.
  const upper = s.match(/^(less\s+than|under|up\s+to|at\s+most|<=|<)\s*(.+)$/);
  if (upper) {
    const strict = upper[1] === 'less than' || upper[1] === 'under' || upper[1] === '<';
    const d = exactDurationMonths(upper[2]);
    if (d == null) return null;
    return (strict ? d <= 2 : d < 2) ? 1 : null;
  }
  // Lower-bound phrases ("more than ...", "over ...", "at least ...", "> ...", ">= ..."):
  // only unambiguous when the bound guarantees >= 2 months ("over 1 month" stays null).
  const lower = s.match(/^(more\s+than|over|at\s+least|>=|>)\s*(.+)$/);
  if (lower) {
    const d = exactDurationMonths(lower[2]);
    if (d == null || d < 2) return null;
    return Math.max(d, 3);
  }
  const exact = exactDurationMonths(s);
  if (exact != null) return exact;
  const since = s.match(/\bsince\s+((?:19|20)\d{2})\b/);
  if (since) {
    const yrs = new Date().getFullYear() - Number(since[1]);
    return yrs > 0 ? yrs * 12 : null;
  }
  // A bare number >= 2 (e.g. "2+", "5") is >= 2 months whether the writer meant months or years.
  const bare = s.match(/^(\d+(?:\.\d+)?)\s*\+?$/);
  if (bare && Number(bare[1]) >= 2) return Number(bare[1]);
  return null;
}

/**
 * Determine whether the insured moved within the last 2 months, with its answer source and note.
 * @param {ClientRecord | null | undefined} r
 * @returns {{ value: 'Yes' | 'No' | null, source: 'derived' | 'standard' | 'fact', note: string | null }}
 */
export function recentlyMoved(r) {
  if (r?.residence?.priorAddress) return { value: 'Yes', source: 'derived', note: null };
  const raw = r?.residence?.timeAtAddress;
  if (!raw) return { value: 'No', source: 'standard', note: null };
  const months = addressMonths(raw);
  if (months == null) return { value: null, source: 'fact', note: `Time at address "${raw}" isn't clear: confirm whether the insured moved in the last 2 months.` };
  return { value: months < 2 ? 'Yes' : 'No', source: 'derived', note: null };
}

/**
 * True when driver `i` looks excluded from the policy (either in their license box or via notes).
 * Scopes to named driver(s) when notes name any listed driver; holds all drivers when unnamed.
 * @param {ClientRecord | null | undefined} r
 * @param {number} i
 * @returns {boolean}
 */
export function driverLooksExcluded(r, i) {
  const d = driverAt(r, i);
  if (!d) return false;
  if (EXCLUDED_WORD.test(String(d.licenseNumber ?? ''))) return true;
  const notes = notesOf(r);
  if (!notes || !EXCLUDED_WORD.test(notes)) return false;
  /** @param {any} drv */
  const namedInNotes = (drv) => {
    const first = driverFirstMiddle(drv).first;
    return !!first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(notes);
  };
  const anyNamed = orderedDrivers(r).some(namedInNotes);
  return anyNamed ? namedInNotes(d) : true;
}

/**
 * Canonicalize intake vehicle primary use so each carrier maps to its own option wording.
 * @param {string | null | undefined} use
 * @returns {'pleasure' | 'commute' | 'business' | null}
 */
export function parseVehicleUse(use) {
  const s = String(use ?? '').trim();
  if (!s) return null;
  if (/^pleasure/i.test(s)) return 'pleasure';
  if (/^commute/i.test(s)) return 'commute';
  if (/^business$/i.test(s)) return 'business';
  return null;
}

/**
 * Whole days per week commuting (`'1'`..`'7'`) from a vehicle object (or numeric value), or null.
 * @param {any} v
 * @returns {'1' | '2' | '3' | '4' | '5' | '6' | '7' | null}
 */
export function commuteDaysValue(v) {
  const raw = v != null && typeof v === 'object' ? v.commuteDays : v;
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  const d = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(d) || d < 1 || d > 7) return null;
  return COMMUTE_DAYS[Math.round(d) - 1] ?? null;
}

/**
 * Positive whole one-way commute miles from a vehicle object (or numeric value), or null.
 * @param {any} v
 * @returns {string | null}
 */
export function commuteMilesValue(v) {
  const raw = v != null && typeof v === 'object' ? v.commuteMiles : v;
  if (raw == null || raw === '' || typeof raw === 'boolean') return null;
  const m = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  return Number.isFinite(m) && m > 0 && Math.round(m) > 0 ? String(Math.round(m)) : null;
}

/**
 * Parse intake annual mileage into a numeric value or the `"50,000+"` sentinel so each carrier
 * can map into its own mileage bands.
 * @param {number | string | null | undefined} miles
 * @returns {{ miles: number | null, over50k: boolean }}
 */
export function parseAnnualMiles(miles) {
  if (miles == null || miles === '') return { miles: null, over50k: false };
  if (typeof miles === 'string' && /50,?000\+/.test(miles)) return { miles: null, over50k: true };
  const s = typeof miles === 'number' ? miles : String(miles).trim().replace(/,/g, '');
  if (s === '') return { miles: null, over50k: false };
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return { miles: null, over50k: false };
  return { miles: n, over50k: false };
}

/**
 * Categorize clear non-employed intake occupations so each carrier maps to its own wording;
 * specific employed occupations return null (left for the agent).
 * @param {string | null | undefined} occ
 * @returns {'student' | 'retired' | 'homemaker' | 'disabled' | 'unemployed' | null}
 */
export function parseNonEmployedCategory(occ) {
  const s = String(occ ?? '').trim();
  if (!s) return null;
  if (/\b(student|college|high\s*school|university)\b/i.test(s)) return 'student';
  if (/\bretired\b/i.test(s)) return 'retired';
  if (/\b(home[\s-]*mak(?:er|ing)|house[\s-]*(?:wife|husband|spouse)|stay[\s-]*at[\s-]*home|household\s*manager)\b/i.test(s)) return 'homemaker';
  if (/\bdisabled\b/i.test(s)) return 'disabled';
  if (/\b(unemployed|not\s+employed|not\s+currently\s+employed)\b/i.test(s)) return 'unemployed';
  return null;
}

/**
 * Normalize an intake deductible string (`"No Coverage"` -> `'None'`), or null when blank.
 * @param {string | null | undefined} ded
 * @returns {string | null}
 */
export const normalizeDeductible = (ded) => {
  const s = String(ded ?? '').trim();
  if (!s) return null;
  if (/^no coverage$/i.test(s)) return 'None';
  return s;
};

/**
 * Resolve a vehicle's Comprehensive or Collision deductible intent from `vehicles[i].fullCoverage`
 * and `coverage[field]`, returning a carrier-neutral result that each carrier formats into its
 * own dropdown wording.
 * @param {ClientRecord | null | undefined} r
 * @param {number} i
 * @param {'compDeductible' | 'collDeductible'} field
 * @returns {{ kind: 'none' | 'amount' | 'missing' | 'ignore', raw: string | null, source: 'derived' | 'fact', note: string | null }}
 */
export function resolveVehicleDeductible(r, i, field) {
  const v = vehicleAt(r, i);
  if (!v) return { kind: 'ignore', raw: null, source: 'derived', note: null };
  const ded = normalizeDeductible(r?.coverage?.[field]);
  if (v.fullCoverage === false) return { kind: 'none', raw: 'None', source: 'derived', note: null };
  if (v.fullCoverage === true) {
    if (ded && ded !== 'None') return { kind: 'amount', raw: ded, source: 'derived', note: null };
    return {
      kind: 'missing',
      raw: null,
      source: 'fact',
      note: `Vehicle ${i + 1} asks for Full Coverage, but ${field === 'compDeductible' ? 'Comprehensive' : 'Collision'} deductible is blank or No Coverage.`,
    };
  }
  // Full coverage not specified on this vehicle (e.g. old intake form): only fill None when the
  // quote explicitly says No Coverage; otherwise leave for the agent to confirm per vehicle.
  if (ded === 'None') return { kind: 'none', raw: 'None', source: 'derived', note: null };
  return {
    kind: 'missing',
    raw: null,
    source: 'fact',
    note: `Vehicle ${i + 1}: intake doesn't specify Full Coverage vs Liability Only — confirm deductible.`,
  };
}

/**
 * Format a numeric liability part (short thousands like `"100"` / `"100k"` or full dollars like
 * `"100,000"`) as `$X,XXX`, or null if invalid.
 * @param {string} rawNum
 * @param {string | undefined} hasK
 * @returns {string | null}
 */
function liabilityDollars(rawNum, hasK) {
  const n = Number(rawNum.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const dollars = hasK || n < 1000 ? n * 1000 : n;
  return `$${dollars.toLocaleString('en-US')}`;
}

/**
 * Parse an intake requested liability limit for carriers with separate BI and PD controls.
 * Example: `'100/300/100'` -> `{ kind: 'split', bi: '$100,000/$300,000', pd: '$100,000' }`.
 * @param {string | null | undefined} limit
 * @returns {{ kind: 'split' | 'state-min' | 'csl' | 'none' | 'unknown', bi: string | null, pd: string | null }}
 */
export function parseSplitLiability(limit) {
  const s = String(limit ?? '').trim();
  if (!s) return { kind: 'unknown', bi: null, pd: null };
  if (/^none$/i.test(s)) return { kind: 'none', bi: null, pd: null };
  if (/^state\s+minimum\b/i.test(s)) return { kind: 'state-min', bi: null, pd: null };
  if (/\bcsl\b/i.test(s)) return { kind: 'csl', bi: null, pd: null };
  const m = s.match(/^\$?([\d,]+)(k)?\s*\/\s*\$?([\d,]+)(k)?\s*\/\s*\$?([\d,]+)(k)?$/i);
  if (m) {
    const biPerPerson = liabilityDollars(m[1], m[2]);
    const biPerAcc = liabilityDollars(m[3], m[4]);
    const pd = liabilityDollars(m[5], m[6]);
    if (biPerPerson && biPerAcc && pd) {
      return { kind: 'split', bi: `${biPerPerson}/${biPerAcc}`, pd };
    }
  }
  return { kind: 'unknown', bi: null, pd: null };
}

/**
 * Strip the ` w/$50 Glass` suffix for standard comprehensive deductibles (`$100`, `$250`, `$500`,
 * `$1,000`, per D15) so carriers without a glass option can map them to `$X deductible`.
 * Returns null for any other glass deductible (such as `$2,000 w/$50 Glass` or `$750 w/$50 Glass`)
 * or blank input; non-glass amounts are returned trimmed as-is so each carrier filters against
 * its own offered deductible set (keeping `$750` and `$2,000` unhandled on GEICO PA).
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function stripGlassDeductible(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\$[\d,]+)\s+w\/\s*\$50\s+glass$/i);
  if (m) return GLASS_DEDUCTIBLE_BASE.has(m[1]) ? m[1] : null;
  if (/\bglass\b/i.test(s)) return null;
  return s;
}
