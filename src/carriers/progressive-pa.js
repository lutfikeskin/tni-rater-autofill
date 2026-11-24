// @ts-check
// Progressive Personal Auto on ForAgentsOnly (quoting.foragentsonly.com/Quote/Index/).
//
// An Angular single-page app whose steps share /Quote/Index/ (or /Quote before redirect). Its page
// adapter (src/content/carriers/progressive-pa.js) reads the active step from the top navigation
// bar, extracts clean question captions, and keys controls by stable data-model paths + 1-based
// row indices. Every repeating vehicle and driver row also carries deterministic 0-based element
// IDs (`ProductsAA_Vehicles_List_<n>_Embedded_Questions_List_<Field>`,
// `People_Drivers_List_<n>_...`, `CoveragesAA_Vehicles_List_<n>_...`), so per-unit rules target
// each row directly by exact selector.
//
// Quote workflow (TNI, 2026-11-24):
// - /home/ stays manual; automatic filling starts on quoting.foragentsonly.com/Quote(/Index).
// - Auto-advance moves across Named Insured -> Products -> Household Members -> Additional Details
//   -> Coverages -> Portfolio when a step has no blockers, clicking Progressive's forward button
//   (#btnNextId) and stopping at Portfolio (Email/Print finishes the quote).
// - Point of Sale and Final Sale are stopSteps (nothing is filled or clicked there).
// - Premium is read on Coverages and Portfolio.

import { sameCarrier } from '../util.js';
import { STATES } from '../states.js';

/** @import { CarrierAction, CarrierConfig, CarrierRule, ClientRecord } from '../../types.js' */

const MAX_VEHICLES = 4;
const MAX_DRIVERS = 5;

const RIDESHARE_OR_DELIVERY = /\b(uber|lyft|rideshare|ride[\s-]*share|tnc|doordash|door\s*dash|instacart|grubhub|ubereats|uber\s*eats|postmates|shipt|spark\s*driver|amazon\s*flex|delivery)\b/i;
const SR22_NOTES = /\b(sr[\s-]*22|fr[\s-]*44|state\s+filing)\b/i;
const EXCLUDED_WORD = /\bexclud(?:e|ed|ing)\b/i;
const EXTRA_RESIDENTS = /\b(roommate|additional\s+resident|other\s+resident|lives?\s+in\s+(?:the\s+)?home|unlisted\s+(?:adult|child|kid|resident))\b/i;

const notesOf = (/** @type {ClientRecord} */ r) => String(r?.notes?.text ?? '').trim();
const stateFullName = (/** @type {string | null | undefined} */ code) => {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return null;
  if (c === 'DC') return 'Dist of Columbia';
  return STATES[c] ?? code ?? null;
};

/** @param {Date} [d] */
const todayMmDdYyyy = (d = new Date()) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

/** The driver marked Insured, else the first listed driver. @param {ClientRecord} r */
const insuredDriver = (r) => {
  const list = r?.drivers ?? [];
  return list.find((d) => /^insured$/i.test(d?.relation ?? '')) ?? list[0] ?? null;
};

/**
 * Drivers ordered so index 0 matches Progressive's Driver 0 (the Named Insured), followed by the
 * remaining household members in intake order.
 * @param {ClientRecord} r
 */
const orderedDrivers = (r) => {
  const list = r?.drivers ?? [];
  const primary = insuredDriver(r);
  if (!primary) return [];
  return [primary, ...list.filter((d) => d !== primary)];
};

/** @param {ClientRecord} r @param {number} i */
const driverAt = (r, i) => orderedDrivers(r)[i] ?? null;
/** @param {ClientRecord} r @param {number} i */
const vehicleAt = (r, i) => r?.vehicles?.[i] ?? null;

/**
 * General personal-auto rule: when a driver or named insured has a second name in `first` and no
 * separate `middle`, keep the first word as First Name and use the second word's first letter as
 * Middle Initial (so both newly read intakes and panel-edited/cached records follow the same rule).
 * @param {any} d
 */
function driverFirstMiddle(d) {
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
 * Format a 10-digit US phone as XXX-XXX-XXXX for Progressive PA's <phone-input> mask
 * (placeholder="XXX-XXX-XXXX"; "(XXX) XXX-XXXX" is rejected and cleared by CurrentWorkflowState).
 * @param {string | null | undefined} raw
 */
function dashedPhone(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : s;
}

/** One-line garaging address for Progressive PA's Smarty <mat-autocomplete> input. @param {ClientRecord} r */
function oneLineAddress(r) {
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
function exactDurationMonths(s) {
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
function addressMonths(text) {
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

/** @param {ClientRecord} r */
function recentlyMoved(r) {
  if (r?.residence?.priorAddress) return { value: 'Yes', source: /** @type {const} */ ('derived'), note: null };
  const raw = r?.residence?.timeAtAddress;
  if (!raw) return { value: 'No', source: /** @type {const} */ ('standard'), note: null };
  const months = addressMonths(raw);
  if (months == null) return { value: null, source: /** @type {const} */ ('fact'), note: `Time at address "${raw}" isn't clear: confirm whether the insured moved in the last 2 months.` };
  return { value: months < 2 ? 'Yes' : 'No', source: /** @type {const} */ ('derived'), note: null };
}

/** Map intake vehicle ownership duration to Progressive PA's 6 options (D7). @param {string | null | undefined} ownedFor */
function ownershipBucket(ownedFor) {
  const s = String(ownedFor ?? '').trim();
  if (!s) return { value: null, source: /** @type {const} */ ('fact'), note: 'Length of vehicle ownership is blank on the intake.' };
  if (/^less than 6 months$/i.test(s)) return { value: 'At least 1 month but less than 6 months', source: /** @type {const} */ ('standard'), note: null };
  if (/^6 months\s*-\s*1 year$/i.test(s)) return { value: 'At least 6 months but less than 1 year', source: /** @type {const} */ ('derived'), note: null };
  if (/^1 year\s*-\s*3 years$/i.test(s)) return { value: 'At least 1 year but less than 3 years', source: /** @type {const} */ ('derived'), note: null };
  if (/^3\+?\s*years$/i.test(s)) return { value: 'At least 3 years but less than 5 years', source: /** @type {const} */ ('standard'), note: null };
  return { value: null, source: /** @type {const} */ ('fact'), note: `Length of ownership "${s}" didn't match Progressive's options.` };
}

/** Map intake vehicle use to Progressive PA's options. @param {string | null | undefined} use */
function vehicleUseValue(use) {
  const s = String(use ?? '').trim();
  if (!s) return null;
  if (/^pleasure/i.test(s)) return 'Pleasure/Personal';
  if (/^commute/i.test(s)) return 'Commute';
  if (/^business$/i.test(s)) return 'Business';
  return null;
}

/** Map intake annual miles to Progressive PA's 14 mileage bands. @param {number | string | null | undefined} miles */
function annualMileageBand(miles) {
  if (miles == null || miles === '') return null;
  if (typeof miles === 'string' && /50,?000\+/.test(miles)) return '30,000 - 99,999';
  const n = typeof miles === 'number' ? miles : Number(String(miles).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 3999) return '0 - 3,999';
  if (n <= 5999) return '4,000 - 5,999';
  if (n <= 7999) return '6,000 - 7,999';
  if (n <= 9999) return '8,000 - 9,999';
  if (n <= 11999) return '10,000 - 11,999';
  if (n <= 13999) return '12,000 - 13,999';
  if (n <= 15999) return '14,000 - 15,999';
  if (n <= 17999) return '16,000 - 17,999';
  if (n <= 19999) return '18,000 - 19,999';
  if (n <= 21999) return '20,000 - 21,999';
  if (n <= 23999) return '22,000 - 23,999';
  if (n <= 26999) return '24,000 - 26,999';
  if (n <= 29999) return '27,000 - 29,999';
  return '30,000 - 99,999';
}

/** Map intake yearLicensed to Progressive PA's 4 buckets (D12: blank stays agent's). @param {number | null | undefined} yr */
function yearsLicensedBand(yr) {
  if (yr == null || !Number.isFinite(yr)) return null;
  const diff = new Date().getFullYear() - yr;
  if (diff >= 3) return '3 years or more';
  if (diff === 2) return 'At least 2 years, but less than 3 years';
  if (diff === 1) return 'At least 1 year, but less than 2 years';
  return 'Less than 1 year';
}

/** Map clear non-employed occupations (D15); specific occupations stay with the agent. @param {string | null | undefined} occ */
function nonEmployedStatus(occ) {
  const s = String(occ ?? '').trim();
  if (!s) return null;
  if (/\b(student|college|high\s*school|university)\b/i.test(s)) return 'Full time student (not employed or part-time employed)';
  if (/\bretired\b/i.test(s)) return 'Retired (not employed)';
  if (/\b(homemaker|housewife|stay[\s-]*at[\s-]*home|household\s*manager)\b/i.test(s)) return 'Household Manager/Stay-at-home duties (full-time)';
  if (/\bdisabled\b/i.test(s)) return 'Disabled (not employed)';
  if (/\b(unemployed|not\s+employed|not\s+currently\s+employed)\b/i.test(s)) return 'Not currently employed';
  return null;
}

/** @param {ClientRecord} r @param {number} i */
function driverLooksExcluded(r, i) {
  const d = driverAt(r, i);
  if (!d) return false;
  if (EXCLUDED_WORD.test(String(d.licenseNumber ?? ''))) return true;
  const notes = notesOf(r);
  if (!notes || !EXCLUDED_WORD.test(notes)) return false;
  const namedInNotes = (drv) => {
    const first = driverFirstMiddle(drv).first;
    return !!first && new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(notes);
  };
  // Scope to named driver(s) when the notes name any listed driver; fall back to holding every
  // driver for the agent only when the exclusion note names no driver.
  const anyNamed = orderedDrivers(r).some(namedInNotes);
  return anyNamed ? namedInNotes(d) : true;
}

/** Map intake prior BI limit to Progressive PA's 4 tiers. @param {string | null | undefined} limit */
function priorBiTier(limit) {
  const s = String(limit ?? '').trim();
  if (!s) return null;
  if (/^state minimum/i.test(s)) return 'State Minimum Limits';
  if (/^\$?(?:25k?\/\$?50k?|50k?\/\$?100k?)$/i.test(s)) return 'Greater than State Minimum, Less than 100/300 or 100 CSL';
  if (/^\$?(?:100k?\/\$?300k?|100k?\s*csl)$/i.test(s)) return 'Greater than or Equal to 100/300 or 100 CSL, Less than 250/500 or 300 CSL';
  if (/^\$?(?:250k?\/\$?500k?|300k?\s*csl|350k?\s*csl|500k?\s*csl|750k?\s*csl|1,?000,?000\s*csl)$/i.test(s)) return 'Greater than or Equal to 250/500 or 300 CSL';
  return null;
}

/** Map intake prior insurer duration to Progressive PA's 4 bands. @param {string | null | undefined} raw */
function priorTenureBand(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const mo = s.match(/^(\d+(?:\.\d+)?)\s*(?:months?|mos?)$/);
  if (mo) {
    const n = Number(mo[1]);
    if (n < 12) return 'Less than 1 year';
    if (n < 36) return 'At least 1 year but less than 3 years';
    if (n < 60) return 'At least 3 years but less than 5 years';
    return '5 years or more';
  }
  if (/^less than 1 year$|^under 1\b/.test(s)) return 'Less than 1 year';
  if (/^1\s*-\s*3\s*years?$|^[12]\s*years?$/.test(s)) return 'At least 1 year but less than 3 years';
  if (/^3\s*-\s*5\s*years?$|^[34]\s*years?$/.test(s)) return 'At least 3 years but less than 5 years';
  if (/^5\+?\s*years?$|^(?:[5-9]|[1-9]\d)\s*years?$/.test(s)) return '5 years or more';
  return null;
}

/** @param {string | null | undefined} ded */
const normalizeDeductible = (ded) => {
  const s = String(ded ?? '').trim();
  if (!s) return null;
  if (/^no coverage$/i.test(s)) return 'None';
  return s;
};

/** @param {ClientRecord} r @param {number} i @param {'compDeductible' | 'collDeductible'} field */
function vehicleDeductible(r, i, field) {
  const v = vehicleAt(r, i);
  if (!v) return { value: null, source: /** @type {const} */ ('derived'), note: null, ignore: true };
  const ded = normalizeDeductible(r?.coverage?.[field]);
  if (v.fullCoverage === false) return { value: 'None', source: /** @type {const} */ ('derived'), note: null, ignore: false };
  if (v.fullCoverage === true) {
    if (ded && ded !== 'None') return { value: ded, source: /** @type {const} */ ('derived'), note: null, ignore: false };
    return { value: null, source: /** @type {const} */ ('fact'), note: `Vehicle ${i + 1} asks for Full Coverage, but ${field === 'compDeductible' ? 'Comprehensive' : 'Collision'} deductible is blank or No Coverage.`, ignore: false };
  }
  // Full coverage not specified on this vehicle (e.g. old intake form): only fill None when the
  // quote explicitly says No Coverage; otherwise leave for the agent to confirm per vehicle.
  if (ded === 'None') return { value: 'None', source: /** @type {const} */ ('derived'), note: null, ignore: false };
  return { value: null, source: /** @type {const} */ ('fact'), note: `Vehicle ${i + 1}: intake doesn't specify Full Coverage vs Liability Only — confirm deductible.`, ignore: false };
}

const NI = 'NamedInsured_Embedded_Questions_List_';
const PA = 'ProductsAA_Embedded_Questions_List_';
const AD = 'AdditionalDetails_Embedded_Questions_List_';
const ADP = 'AdditionalDetails_ProductSpecificInformation_List_0_Embedded_Questions_List_';
const PC = 'CoveragesAA_PolicyCoverage_Embedded_Questions_List_';

const QUOTE_STEPS = ['Named Insured', 'Products', 'Household Members', 'Additional Details', 'Coverages', 'Portfolio'];

/** @returns {CarrierRule[]} */
function namedInsuredRules() {
  return [
    { concept: 'quote.agency', steps: ['Named Insured'], selector: `#${NI}AgentCode`, name: 'PGR Agent Code (preserve prefilled)', ignore: true },
    { concept: 'quote.agency', steps: ['Named Insured'], selector: `#${NI}QuoteOrigin`, name: 'Quote Origin (preserve prefilled)', ignore: true },
    { concept: 'quote.navigation', steps: QUOTE_STEPS, selector: 'input[type="checkbox"][aria-labelledby="helpTextToggleLabel"]', name: 'Keyboard access toggle', kind: 'bool', ignore: true },
    { concept: 'owner.name', steps: ['Named Insured'], selector: `#${NI}FirstName`, name: 'Named insured first name', source: 'derived', value: (r) => driverFirstMiddle(insuredDriver(r)).first },
    { concept: 'owner.name', steps: ['Named Insured'], selector: `#${NI}MiddleInitial`, name: 'Named insured middle initial', optional: true, source: 'derived', value: (r) => driverFirstMiddle(insuredDriver(r)).middle, ignore: (r) => !driverFirstMiddle(insuredDriver(r)).middle },
    { concept: 'owner.name', steps: ['Named Insured'], selector: `#${NI}LastName`, name: 'Named insured last name', source: 'derived', value: (r) => insuredDriver(r)?.last ?? null },
    { concept: 'owner.name', steps: ['Named Insured'], selector: `#${NI}Suffix`, name: 'Named insured suffix', kind: 'choice', optional: true, source: 'derived', value: (r) => insuredDriver(r)?.suffix ?? null, ignore: (r) => !insuredDriver(r)?.suffix },
    { concept: 'owner.dob', steps: ['Named Insured'], selector: `#${NI}DateOfBirth`, name: 'Named insured date of birth', kind: 'date', source: 'derived', value: (r) => insuredDriver(r)?.dob ?? null },
    {
      concept: 'driver.gender', steps: ['Named Insured'], selector: `#${NI}Gender`, name: 'Named insured gender', kind: 'choice',
      source: (r) => (/^(male|female)$/i.test(insuredDriver(r)?.gender ?? '') ? 'derived' : 'fact'),
      value: (r) => (/^(male|female)$/i.test(insuredDriver(r)?.gender ?? '') ? insuredDriver(r)?.gender : null),
      note: (r) => (/^(male|female)$/i.test(insuredDriver(r)?.gender ?? '') ? null : `Named insured gender "${insuredDriver(r)?.gender ?? 'blank'}" must be chosen by the agent.`),
    },
    { concept: 'business.contact', steps: ['Named Insured'], selector: `#${NI}PrimaryEmailAddress`, name: 'Customer email', path: 'applicant.email', optional: true },
    {
      concept: 'business.contact', steps: ['Named Insured'], selector: '#NamedInsured_PhoneNumbers_List_0_Embedded_Questions_List_PhoneType',
      name: 'Phone type (standard: Cell)', kind: 'choice', source: 'standard', tni: 'progressive-pa.phone-type',
      value: (r) => (r?.applicant?.phone ? 'Cell' : null),
      ignore: (r) => !r?.applicant?.phone,
    },
    {
      concept: 'business.contact', steps: ['Named Insured'], selector: '#NamedInsured_PhoneNumbers_List_0_Embedded_Questions_List_PhoneNumber',
      name: 'Customer phone number', path: 'applicant.phone', kind: 'phone',
      source: 'derived', value: (r) => dashedPhone(r?.applicant?.phone),
    },
    {
      concept: 'business.address', steps: ['Named Insured'], selector: `#${NI}MailingAddress`,
      name: 'Mailing address line 1 (with suggestion)', path: 'garaging.street', kind: 'address-suggest',
      source: 'derived', value: oneLineAddress, fallback: (r) => r?.garaging?.street ?? null, checkNumber: true,
    },
    { concept: 'business.address', steps: ['Named Insured'], selector: `#${NI}ApartmentUnit`, name: 'Mailing address line 2', path: 'garaging.unit', optional: true, ignore: (r) => !r?.garaging?.unit },
    { concept: 'business.address', steps: ['Named Insured'], selector: `#${NI}City`, name: 'Mailing city', path: 'garaging.city' },
    { concept: 'business.address', steps: ['Named Insured'], selector: `#${NI}State`, name: 'Mailing state', kind: 'choice', source: 'derived', value: (r) => stateFullName(r?.garaging?.state) },
    { concept: 'business.address', steps: ['Named Insured'], selector: `#${NI}ZipCode`, name: 'Mailing ZIP code', path: 'garaging.zip' },
    { concept: 'business.address', steps: ['Named Insured'], selector: `#${NI}MailingZipType`, name: 'P.O. Box or Military Address checkbox', kind: 'bool', ignore: true },
    {
      concept: 'residence.moved', steps: ['Named Insured'], selector: `#${NI}RecentlyMoved`, name: 'Has the insured moved in the last 2 months?', kind: 'choice',
      tni: 'progressive-pa.recently-moved',
      source: (r) => recentlyMoved(r).source,
      value: (r) => recentlyMoved(r).value,
      note: (r) => recentlyMoved(r).note,
    },
    {
      concept: 'quote.disclosure', steps: ['Named Insured'], selector: `#${NI}DisclosureProvided`, name: 'Disclosure read or provided (standard: Yes)',
      kind: 'choice', source: 'standard', tni: 'progressive-pa.disclosure', value: () => 'Yes',
    },
  ];
}

/** @param {number} i @returns {CarrierRule[]} */
function productVehicleRules(i) {
  const p = `#ProductsAA_Vehicles_List_${i}_Embedded_Questions_List_`;
  const missing = (/** @type {ClientRecord} */ r) => !vehicleAt(r, i);
  const rideshareFlag = (/** @type {ClientRecord} */ r) => RIDESHARE_OR_DELIVERY.test(notesOf(r));
  return [
    {
      concept: 'vehicle.type', steps: ['Products'], selector: `${p}TypeCode`, name: `Vehicle ${i + 1}: vehicle type`, kind: 'choice',
      source: 'standard', tni: 'progressive-pa.vehicle-type', ignore: missing,
      value: (r) => {
        const v = vehicleAt(r, i);
        if (!v) return null;
        return v.year != null && v.year < 1981
          ? 'Pre 1981 - Autos, Pickups, Vans, and Utility Vehicles'
          : '1981 & Newer - Autos, Pickups, Vans, and Utility Vehicles';
      },
    },
    { concept: 'vehicle.vin', steps: ['Products'], selector: `${p}Vin`, name: `Vehicle ${i + 1}: VIN`, path: `vehicles[${i}].vin`, ignore: (r) => !vehicleAt(r, i)?.vin },
    { concept: 'vehicle.year', steps: ['Products'], selector: `select${p}Year`, name: `Vehicle ${i + 1}: year`, path: `vehicles[${i}].year`, kind: 'choice', ignore: (r) => missing(r) || !!vehicleAt(r, i)?.vin },
    { concept: 'vehicle.make', steps: ['Products'], selector: `select${p}Make`, name: `Vehicle ${i + 1}: make`, path: `vehicles[${i}].make`, kind: 'choice', ignore: (r) => missing(r) || !!vehicleAt(r, i)?.vin },
    { concept: 'vehicle.model', steps: ['Products'], selector: `select${p}Model`, name: `Vehicle ${i + 1}: model`, path: `vehicles[${i}].model`, kind: 'choice', ignore: (r) => missing(r) || !!vehicleAt(r, i)?.vin },
    { concept: 'vehicle.type', steps: ['Products'], selector: `select${p}BodyStyle`, name: `Vehicle ${i + 1}: body style (from VIN decode)`, ignore: true },
    { concept: 'vehicle.year', steps: ['Products'], selector: `input${p}Year`, name: `Vehicle ${i + 1}: decoded year`, ignore: true },
    { concept: 'vehicle.make', steps: ['Products'], selector: `input${p}Make`, name: `Vehicle ${i + 1}: decoded make`, ignore: true },
    { concept: 'vehicle.model', steps: ['Products'], selector: `input${p}Model`, name: `Vehicle ${i + 1}: decoded model`, ignore: true },
    { concept: 'vehicle.type', steps: ['Products'], selector: `input${p}BodyStyle`, name: `Vehicle ${i + 1}: decoded body style`, ignore: true },
    { concept: 'vehicle.garaging', steps: ['Products'], selector: `${p}GaragingZip`, name: `Vehicle ${i + 1}: garaging ZIP`, path: 'garaging.zip', ignore: missing },
    {
      concept: 'vehicle.ownership-length', steps: ['Products'], selector: `${p}LengthOfOwnership`, name: `Vehicle ${i + 1}: length of ownership`, kind: 'choice',
      tni: 'progressive-pa.ownership-length', ignore: missing,
      source: (r) => ownershipBucket(vehicleAt(r, i)?.ownedFor).source,
      value: (r) => ownershipBucket(vehicleAt(r, i)?.ownedFor).value,
      note: (r) => ownershipBucket(vehicleAt(r, i)?.ownedFor).note,
    },
    {
      concept: 'vehicle.use', steps: ['Products'], selector: `${p}VehicleUse`, name: `Vehicle ${i + 1}: primary use`, kind: 'choice', ignore: missing,
      source: (r) => (vehicleUseValue(vehicleAt(r, i)?.use) ? 'derived' : 'fact'),
      value: (r) => vehicleUseValue(vehicleAt(r, i)?.use),
      note: (r) => (vehicleUseValue(vehicleAt(r, i)?.use) ? null : `Vehicle ${i + 1} use "${vehicleAt(r, i)?.use ?? 'blank'}": pick the Progressive vehicle use.`),
    },
    {
      concept: 'vehicle.use', steps: ['Products'], selector: `${p}CommuteDaysPerWk`, name: `Vehicle ${i + 1}: days commuting per week`, kind: 'choice',
      path: `vehicles[${i}].commuteDays`, ignore: missing,
      source: (r) => {
        const d = vehicleAt(r, i)?.commuteDays;
        return d != null && Number.isFinite(d) && d >= 1 && d <= 7 ? 'derived' : 'fact';
      },
      value: (r) => {
        const d = vehicleAt(r, i)?.commuteDays;
        return d != null && Number.isFinite(d) && d >= 1 && d <= 7 ? String(Math.round(d)) : null;
      },
      note: (r) => {
        const d = vehicleAt(r, i)?.commuteDays;
        return d != null && Number.isFinite(d) && d >= 1 && d <= 7 ? null : `Vehicle ${i + 1}: days commuting per week is blank on the intake.`;
      },
    },
    {
      concept: 'vehicle.use', steps: ['Products'], selector: `${p}OneWayCommuteMiles`, name: `Vehicle ${i + 1}: miles driven one-way`,
      path: `vehicles[${i}].commuteMiles`, ignore: missing,
      source: (r) => {
        const m = vehicleAt(r, i)?.commuteMiles;
        return m != null && Number.isFinite(m) && m > 0 ? 'derived' : 'fact';
      },
      value: (r) => {
        const m = vehicleAt(r, i)?.commuteMiles;
        return m != null && Number.isFinite(m) && m > 0 ? String(Math.round(m)) : null;
      },
      note: (r) => {
        const m = vehicleAt(r, i)?.commuteMiles;
        return m != null && Number.isFinite(m) && m > 0 ? null : `Vehicle ${i + 1}: one-way commute miles is blank on the intake.`;
      },
    },
    {
      concept: 'vehicle.rideshare', steps: ['Products'], selector: `${p}VehicleTransportNetworkCompanyIndicator`, name: `Vehicle ${i + 1}: rideshare / TNC`, kind: 'choice',
      tni: 'progressive-pa.rideshare-delivery', ignore: missing,
      source: (r) => (rideshareFlag(r) ? 'fact' : 'standard'),
      value: (r) => (rideshareFlag(r) ? null : 'No'),
      note: (r) => (rideshareFlag(r) ? 'Notes mention rideshare/delivery — confirm Rideshare/TNC for this vehicle.' : null),
    },
    {
      concept: 'operations.delivery', steps: ['Products'], selector: `${p}VehicleUseDelivery`, name: `Vehicle ${i + 1}: delivery`, kind: 'choice',
      tni: 'progressive-pa.rideshare-delivery', ignore: missing,
      source: (r) => (rideshareFlag(r) ? 'fact' : 'standard'),
      value: (r) => (rideshareFlag(r) ? null : 'No'),
      note: (r) => (rideshareFlag(r) ? 'Notes mention rideshare/delivery — confirm Delivery use for this vehicle.' : null),
    },
    {
      concept: 'vehicle.annual-mileage', steps: ['Products'], selector: `${p}AnnualMileageForRate`, name: `Vehicle ${i + 1}: annual miles`, kind: 'choice',
      tni: 'progressive-pa.annual-mileage', ignore: missing,
      source: (r) => {
        const raw = vehicleAt(r, i)?.annualMiles;
        if (raw == null || raw === '') return 'standard';
        return annualMileageBand(raw) ? 'derived' : 'fact';
      },
      value: (r) => {
        const raw = vehicleAt(r, i)?.annualMiles;
        if (raw == null || raw === '') return '8,000 - 9,999';
        return annualMileageBand(raw);
      },
      note: (r) => {
        const raw = vehicleAt(r, i)?.annualMiles;
        if (raw == null || raw === '' || annualMileageBand(raw)) return null;
        return `Vehicle ${i + 1}: annual mileage "${raw}" couldn't be mapped to Progressive's bands.`;
      },
    },
  ];
}

/** @returns {CarrierRule[]} */
function productsRules() {
  return [
    {
      concept: 'quote.effective-date', steps: ['Products'], selector: `#${PA}PolicyEffectiveDate`,
      name: 'Policy effective date (keep default; fill today if empty)', kind: 'date',
      source: 'standard', tni: 'progressive-pa.effective-date', trustPage: true, value: () => todayMmDdYyyy(),
    },
    {
      concept: 'quote.effective-date', steps: ['Products'], selector: 'question[property="PolicyEffectiveDate"] input[name="pickerInput"]',
      name: 'Policy effective date picker mirror', ignore: true,
    },
    {
      concept: 'quote.named-non-owner', steps: ['Products'], selector: `input[id^="${PA}NamedOperatorIndicator_"]`,
      name: 'Named operator / non-owner indicator (standard: No when vehicles listed)', kind: 'bool',
      source: (r) => (r?.vehicles?.length ? 'standard' : 'fact'),
      tni: 'progressive-pa.named-operator',
      value: (r) => (r?.vehicles?.length ? false : null),
      note: (r) => (r?.vehicles?.length ? null : 'No vehicles on intake: confirm Named Operator indicator.'),
    },
    ...Array.from({ length: MAX_VEHICLES }, (_, i) => productVehicleRules(i)).flat(),
    // Lienholder & Additional Interest modals on Products: recognize & leave for the agent when opened.
    { concept: 'vehicle.loan-lease', steps: ['Products'], selector: '[id^="VehicleLienholdersViewModel_Lienholders_List_"]', name: 'Lienholder modal fields (agent decides)', ignore: true, every: true },
    { concept: 'coverage.additional-insured', steps: ['Products'], selector: '[id^="AdditionalInterestViewModel_AdditionalInterests_List_"]', name: 'Additional Interest modal fields (agent decides)', ignore: true, every: true },
  ];
}

/** @param {number} i @returns {CarrierRule[]} */
function driverRowRules(i) {
  const p = `#People_Drivers_List_${i}_Embedded_Questions_List_`;
  const psi = `#People_Drivers_List_${i}_ProductSpecificInformation_List_0_Embedded_Questions_List_`;
  const missing = (/** @type {ClientRecord} */ r) => !driverAt(r, i);
  const sr22Flag = (/** @type {ClientRecord} */ r) => SR22_NOTES.test(notesOf(r));
  return [
    { concept: 'driver.name', steps: ['Household Members'], selector: `${p}FirstName`, name: `Driver ${i + 1}: first name`, source: 'derived', value: (r) => driverFirstMiddle(driverAt(r, i)).first, ignore: missing },
    { concept: 'driver.name', steps: ['Household Members'], selector: `${p}MiddleInitial`, name: `Driver ${i + 1}: middle initial`, optional: true, source: 'derived', value: (r) => driverFirstMiddle(driverAt(r, i)).middle, ignore: (r) => !driverFirstMiddle(driverAt(r, i)).middle },
    { concept: 'driver.name', steps: ['Household Members'], selector: `${p}LastName`, name: `Driver ${i + 1}: last name`, source: 'derived', value: (r) => driverAt(r, i)?.last ?? null, ignore: missing },
    { concept: 'driver.name', steps: ['Household Members'], selector: `${p}Suffix`, name: `Driver ${i + 1}: suffix`, kind: 'choice', optional: true, source: 'derived', value: (r) => driverAt(r, i)?.suffix ?? null, ignore: (r) => !driverAt(r, i)?.suffix },
    { concept: 'driver.marital-status', steps: ['Household Members'], selector: `${p}MaritalStatus`, name: `Driver ${i + 1}: marital status`, kind: 'choice', source: (r) => (driverAt(r, i)?.maritalStatus ? 'derived' : 'fact'), value: (r) => driverAt(r, i)?.maritalStatus ?? null, note: (r) => (driverAt(r, i)?.maritalStatus ? null : `Driver ${i + 1}: marital status is blank on the intake.`), ignore: missing },
    {
      concept: 'driver.relationship', steps: ['Household Members'], selector: `select${p}Relationship`, name: `Driver ${i + 1}: relationship`, kind: 'choice',
      source: (r) => (driverAt(r, i)?.relation && !/^insured$/i.test(driverAt(r, i)?.relation ?? '') ? 'derived' : 'fact'),
      value: (r) => (driverAt(r, i)?.relation && !/^insured$/i.test(driverAt(r, i)?.relation ?? '') ? driverAt(r, i)?.relation : null),
      note: (r) => (driverAt(r, i)?.relation && !/^insured$/i.test(driverAt(r, i)?.relation ?? '') ? null : `Driver ${i + 1}: confirm relationship to named insured.`),
      ignore: (r) => missing(r) || i === 0,
    },
    { concept: 'driver.relationship', steps: ['Household Members'], selector: `input${p}Relationship`, name: `Driver ${i + 1}: relationship (read-only)`, ignore: true },
    {
      concept: 'driver.second-named-insured', steps: ['Household Members'], selector: `select${psi}SecondNamedInsured`,
      name: `Driver ${i + 1}: second named insured (Spouse: Yes, else No)`, kind: 'choice',
      source: 'standard', tni: 'progressive-pa.second-named-insured', ignore: (r) => missing(r) || i === 0,
      value: (r) => (/^spouse$/i.test(driverAt(r, i)?.relation ?? '') ? 'Yes' : 'No'),
    },
    { concept: 'driver.second-named-insured', steps: ['Household Members'], selector: `input${psi}SecondNamedInsured`, name: `Driver ${i + 1}: second named insured (read-only)`, ignore: true },
    { concept: 'driver.dob', steps: ['Household Members'], selector: `${p}DateOfBirth`, name: `Driver ${i + 1}: date of birth`, kind: 'date', source: 'derived', value: (r) => driverAt(r, i)?.dob ?? null, ignore: missing },
    { concept: 'owner.ssn', steps: ['Household Members'], selector: `${p}SocialSecurityNumber`, name: `Driver ${i + 1}: SSN (never filled)`, ignore: true },
    {
      concept: 'driver.gender', steps: ['Household Members'], selector: `${p}Gender`, name: `Driver ${i + 1}: gender`, kind: 'choice', ignore: missing,
      source: (r) => (/^(male|female)$/i.test(driverAt(r, i)?.gender ?? '') ? 'derived' : 'fact'),
      value: (r) => (/^(male|female)$/i.test(driverAt(r, i)?.gender ?? '') ? driverAt(r, i)?.gender : null),
      note: (r) => (/^(male|female)$/i.test(driverAt(r, i)?.gender ?? '') ? null : `Driver ${i + 1}: confirm gender.`),
    },
    {
      concept: 'driver.employment', steps: ['Household Members'], selector: `${p}EmploymentStatus`, name: `Driver ${i + 1}: employment`, kind: 'choice', ignore: missing,
      source: (r) => (nonEmployedStatus(driverAt(r, i)?.occupation) ? 'derived' : 'fact'),
      value: (r) => nonEmployedStatus(driverAt(r, i)?.occupation),
      note: (r) => {
        if (nonEmployedStatus(driverAt(r, i)?.occupation)) return null;
        const occ = driverAt(r, i)?.occupation;
        return occ ? `Driver ${i + 1} occupation is "${occ}": pick the matching Employment and Occupation.` : `Driver ${i + 1}: occupation is blank on the intake.`;
      },
    },
    {
      concept: 'driver.employment', steps: ['Household Members'], selector: `select${p}Occupation`, name: `Driver ${i + 1}: occupation`, kind: 'choice',
      source: 'fact', value: () => null, ignore: (r) => missing(r) || !!nonEmployedStatus(driverAt(r, i)?.occupation),
      note: (r) => {
        const occ = driverAt(r, i)?.occupation;
        return occ ? `Driver ${i + 1} occupation is "${occ}": pick the Progressive occupation.` : `Driver ${i + 1}: confirm occupation.`;
      },
    },
    { concept: 'driver.employment', steps: ['Household Members'], selector: `input${p}Occupation`, name: `Driver ${i + 1}: occupation (read-only)`, ignore: true },
    {
      concept: 'driver.excluded', steps: ['Household Members'], selector: `${psi}DriverIncluded`, name: `Driver ${i + 1}: auto driver status`, kind: 'choice',
      tni: 'progressive-pa.driver-status', ignore: missing,
      source: (r) => (driverLooksExcluded(r, i) ? 'fact' : 'standard'),
      value: (r) => (driverLooksExcluded(r, i) ? null : 'Rated'),
      note: (r) => (driverLooksExcluded(r, i) ? `Driver ${i + 1}: intake or notes mention excluded — confirm Rated vs Excluded.` : null),
    },
    {
      concept: 'driver.license-type', steps: ['Household Members'], selector: `${p}LicenseType`, name: `Driver ${i + 1}: license type`, kind: 'choice',
      tni: 'progressive-pa.license-type-status', ignore: missing,
      source: (r) => (driverAt(r, i)?.licenseNumber ? 'standard' : 'fact'),
      value: (r) => (driverAt(r, i)?.licenseNumber ? 'Personal Auto' : null),
      note: (r) => (driverAt(r, i)?.licenseNumber ? null : `Driver ${i + 1}: no license number on intake — confirm license type.`),
    },
    {
      concept: 'driver.license-status', steps: ['Household Members'], selector: `${p}LicenseStatus`, name: `Driver ${i + 1}: license status`, kind: 'choice',
      tni: 'progressive-pa.license-type-status', ignore: missing,
      source: (r) => (driverAt(r, i)?.licenseNumber ? 'standard' : 'fact'),
      value: (r) => (driverAt(r, i)?.licenseNumber ? 'Valid' : null),
      note: (r) => (driverAt(r, i)?.licenseNumber ? null : `Driver ${i + 1}: no license number on intake — confirm license status.`),
    },
    { concept: 'driver.license-state', steps: ['Household Members'], selector: `${p}LicenseState`, name: `Driver ${i + 1}: license state`, kind: 'choice', source: 'derived', value: (r) => stateFullName(driverAt(r, i)?.licenseState), ignore: missing },
    { concept: 'driver.license-number', steps: ['Household Members'], selector: `${p}LicenseNumber`, name: `Driver ${i + 1}: license number`, source: 'derived', trustPage: true, masked: true, value: (r) => driverAt(r, i)?.licenseNumber ?? null, ignore: missing },
    {
      concept: 'driver.sr22', steps: ['Household Members'], selector: `input[id^="People_Drivers_List_${i}_Embedded_Questions_List_StateFiling_"]`,
      name: `Driver ${i + 1}: state filing (SR-22 / FR-44)`, kind: 'bool',
      tni: 'progressive-pa.state-filing', ignore: missing,
      source: (r) => (sr22Flag(r) ? 'fact' : 'standard'),
      value: (r) => (sr22Flag(r) ? null : false),
      note: (r) => (sr22Flag(r) ? 'Notes mention SR-22 / FR-44 / state filing — confirm for this driver.' : null),
    },
    {
      concept: 'driver.year-licensed', steps: ['Household Members'], selector: `${psi}DriverYearsLicensed`, name: `Driver ${i + 1}: years licensed`, kind: 'choice', ignore: missing,
      source: (r) => (yearsLicensedBand(driverAt(r, i)?.yearLicensed) ? 'derived' : 'fact'),
      value: (r) => yearsLicensedBand(driverAt(r, i)?.yearLicensed),
      note: (r) => (yearsLicensedBand(driverAt(r, i)?.yearLicensed) ? null : `Driver ${i + 1}: year licensed is blank on the intake — confirm years licensed.`),
    },
    {
      concept: 'driver.defensive-course', steps: ['Household Members'], selector: `select${psi}SeniorDriver`, name: `Driver ${i + 1}: mature driver course`, kind: 'choice',
      tni: 'progressive-pa.driver-discounts', ignore: missing,
      source: (r) => (driverAt(r, i)?.matureCourse === true ? 'derived' : 'standard'),
      value: (r) => (driverAt(r, i)?.matureCourse === true ? 'Yes' : 'No'),
    },
    { concept: 'driver.defensive-course', steps: ['Household Members'], selector: `input${psi}SeniorDriver`, name: `Driver ${i + 1}: mature driver course (read-only)`, ignore: true },
    {
      concept: 'driver.student-discount', steps: ['Household Members'], selector: `select${psi}StudentLocation`, name: `Driver ${i + 1}: distant student`, kind: 'choice',
      tni: 'progressive-pa.driver-discounts', ignore: missing,
      source: (r) => (driverAt(r, i)?.distantStudent === true ? 'derived' : 'standard'),
      value: (r) => (driverAt(r, i)?.distantStudent === true ? 'Yes' : 'No'),
    },
    { concept: 'driver.student-discount', steps: ['Household Members'], selector: `input${psi}StudentLocation`, name: `Driver ${i + 1}: distant student (read-only)`, ignore: true },
    {
      concept: 'driver.student-discount', steps: ['Household Members'], selector: `select${psi}GoodStudent`, name: `Driver ${i + 1}: good student`, kind: 'choice',
      tni: 'progressive-pa.driver-discounts', ignore: missing,
      source: (r) => (driverAt(r, i)?.goodStudent === true ? 'derived' : 'standard'),
      value: (r) => (driverAt(r, i)?.goodStudent === true ? 'Yes' : 'No'),
    },
    { concept: 'driver.student-discount', steps: ['Household Members'], selector: `input${psi}GoodStudent`, name: `Driver ${i + 1}: good student (read-only)`, ignore: true },
    { concept: 'driver.claims', steps: ['Household Members'], selector: `[id^="People_Drivers_List_${i}_Violations_List_"][id$="_Embedded_Questions_List_Code"]`, name: `Driver ${i + 1}: incident code (agent enters if applicable)`, ignore: true },
    { concept: 'driver.claims', steps: ['Household Members'], selector: `[id^="People_Drivers_List_${i}_Violations_List_"][id$="_Embedded_Questions_List_Date"]`, name: `Driver ${i + 1}: incident date (agent enters if applicable)`, ignore: true },
  ];
}

/** @returns {CarrierRule[]} */
function additionalDetailsRules() {
  const prior = (/** @type {ClientRecord} */ r) => r?.priorInsurance?.[0] ?? null;
  const isInsured = (/** @type {ClientRecord} */ r) => prior(r)?.currentlyInsured === true;
  const residenceValue = (/** @type {ClientRecord} */ r) => {
    const o = r?.residence?.ownership;
    if (!o) return null;
    if (/^own$/i.test(o)) return 'Own Home/Condo';
    if (/^rent$/i.test(o)) return 'Rent';
    return null;
  };
  const extraResidents = (/** @type {ClientRecord} */ r) => EXTRA_RESIDENTS.test(notesOf(r));
  return [
    {
      concept: 'prior.currently-insured', steps: ['Additional Details'], selector: `#${ADP}InsuranceToday`, name: 'Currently insured (6 months, <=31 days lapse)', kind: 'choice',
      source: (r) => (prior(r)?.currentlyInsured != null ? 'derived' : 'fact'),
      value: (r) => (prior(r)?.currentlyInsured === true ? 'Yes, currently insured' : prior(r)?.currentlyInsured === false ? 'No' : null),
      note: (r) => (prior(r)?.currentlyInsured != null ? null : 'Currently insured is blank on the intake.'),
    },
    {
      concept: 'prior.same-carrier', steps: ['Additional Details'], selector: `#${ADP}PriorCarrierIsProgressive`, name: 'Is Progressive the prior insurance company?', kind: 'choice',
      ignore: (r) => prior(r)?.currentlyInsured === false,
      source: (r) => (prior(r)?.carrier ? 'derived' : 'fact'),
      value: (r) => (prior(r)?.carrier ? (sameCarrier(prior(r)?.carrier, 'progressive') ? 'Yes' : 'No') : null),
      note: (r) => (prior(r)?.carrier ? null : 'Prior auto insurance carrier is blank on the intake.'),
    },
    // Prior/current policy BI limits: intentionally omit `replace: true` so Progressive's prefilled
    // prior limit (from history/CLUE, often more accurate/higher than an uncertain intake guess) is kept.
    {
      concept: 'prior.limit', steps: ['Additional Details'], selector: `#${ADP}BodilyInjuryLimits`, name: 'Prior bodily injury limits', kind: 'choice',
      ignore: (r) => prior(r)?.currentlyInsured === false,
      source: (r) => (priorBiTier(prior(r)?.limit) ? 'derived' : 'fact'),
      value: (r) => priorBiTier(prior(r)?.limit),
      note: (r) => (priorBiTier(prior(r)?.limit) ? null : `Prior BI limits "${prior(r)?.limit ?? 'blank'}": pick the matching Progressive tier.`),
    },
    {
      concept: 'prior.tenure', steps: ['Additional Details'], selector: `#${ADP}RecentAutoInsuranceCompanyPeriod`, name: 'Years with most recent auto insurer', kind: 'choice',
      ignore: (r) => prior(r)?.currentlyInsured === false && !isInsured(r),
      source: (r) => (priorTenureBand(prior(r)?.insuredFor) ? 'derived' : 'fact'),
      value: (r) => priorTenureBand(prior(r)?.insuredFor),
      note: (r) => (priorTenureBand(prior(r)?.insuredFor) ? null : `Years with prior carrier "${prior(r)?.insuredFor ?? 'blank'}": confirm with the client.`),
    },
    {
      concept: 'quote.all-drivers', steps: ['Additional Details'], selector: `#${ADP}AllDriversAcknowledgement`,
      name: 'Included all required drivers (standard: Yes)', kind: 'choice',
      source: 'standard', tni: 'progressive-pa.all-drivers', value: () => 'Yes',
    },
    {
      concept: 'quote.paperless', steps: ['Additional Details'], selector: `#${AD}PaperlessPreference`,
      name: 'Paperless preference (standard: Yes)', kind: 'choice',
      source: 'standard', tni: 'progressive-pa.paperless', value: () => 'Yes',
    },
    {
      concept: 'residence.total-residents', steps: ['Additional Details'], selector: `#${AD}TotalResidents`,
      name: 'Total number of residents in home', kind: 'choice',
      tni: 'progressive-pa.total-residents',
      source: (r) => (!extraResidents(r) && (r?.drivers?.length ?? 0) > 0 ? 'standard' : 'fact'),
      value: (r) => {
        if (extraResidents(r) || !(r?.drivers?.length > 0)) return null;
        return r.drivers.length >= 9 ? '9+' : String(r.drivers.length);
      },
      note: (r) => (extraResidents(r) ? 'Notes mention additional household residents — confirm total residents.' : r?.drivers?.length ? null : 'No drivers listed to count total residents.'),
    },
    {
      concept: 'residence.ownership', steps: ['Additional Details'], selector: `#${AD}PrimaryResidenceDisplay`, name: 'Primary residence', kind: 'choice',
      source: (r) => (residenceValue(r) ? 'derived' : 'fact'),
      value: (r) => residenceValue(r),
      note: (r) => (residenceValue(r) ? null : 'Own or rent home is blank on the intake.'),
    },
    // Multi-policy / other products checkboxes: leave specific product boxes untouched, and check
    // "No additional risks apply" (MultiPolInd) as TNI standard so Additional Details validates.
    ...['Renters', 'Motorcycle', 'Boat', 'MobileHome', 'MotorHome', 'TravelTrailer', 'CommercialAuto'].map(/** @returns {CarrierRule} */ (field) => ({
      concept: 'prior.other-coverages',
      steps: ['Additional Details'],
      selector: `#${AD}${field}`,
      name: `Other product checkbox (${field}: leave untouched)`,
      kind: 'bool',
      ignore: true,
    })),
    {
      concept: 'prior.other-coverages',
      steps: ['Additional Details'],
      selector: `#${AD}MultiPolInd`,
      name: 'No additional risks apply (standard: checked)',
      kind: 'bool',
      source: 'standard',
      tni: 'progressive-pa.no-additional-risks',
      value: () => true,
    },
  ];
}

/** @param {number} i @returns {CarrierRule[]} */
function coverageVehicleRules(i) {
  const p = `#CoveragesAA_Vehicles_List_${i}_Embedded_Questions_List_`;
  const missing = (/** @type {ClientRecord} */ r) => !vehicleAt(r, i);
  return [
    { concept: 'coverage.liability', steps: ['Coverages'], selector: `${p}veh_liab`, name: `Vehicle ${i + 1}: liability display`, ignore: true },
    {
      concept: 'coverage.liability', steps: ['Coverages'], selector: `select${p}BIPD`, name: `Vehicle ${i + 1}: BI/PD liability limit`,
      kind: (r) => (/^state minimum/i.test(r?.coverage?.liabilityLimit ?? '') ? 'pick-not' : 'choice'),
      replace: true,
      ignore: missing,
      source: (r) => (r?.coverage?.liabilityLimit ? 'derived' : 'fact'),
      value: (r) => {
        const lim = String(r?.coverage?.liabilityLimit ?? '').trim();
        if (!lim) return null;
        if (/^state minimum/i.test(lim)) return { not: '^(?:select|none)$' };
        return lim;
      },
      note: (r) => (r?.coverage?.liabilityLimit ? null : 'Requested liability limit is blank on the intake.'),
    },
    { concept: 'coverage.liability', steps: ['Coverages'], selector: `input${p}BIPD`, name: `Vehicle ${i + 1}: BI/PD display`, ignore: true },
    // D20 & D21: Leave Progressive's defaults untouched for UMBI, UMPD, MEDPAY, RENT, ROADSD, PVP, Custom Parts, PAYOFF.
    { concept: 'coverage.um', steps: ['Coverages'], selector: `${p}UMBI`, name: `Vehicle ${i + 1}: UMBI (keep Progressive default)`, ignore: true },
    { concept: 'coverage.umpd', steps: ['Coverages'], selector: `${p}UMPD`, name: `Vehicle ${i + 1}: UMPD (keep Progressive default)`, ignore: true },
    { concept: 'coverage.medpay', steps: ['Coverages'], selector: `${p}MEDPAY`, name: `Vehicle ${i + 1}: Medical Payment (keep Progressive default)`, ignore: true },
    {
      concept: 'coverage.comp-coll', steps: ['Coverages'], selector: `select${p}COMP`, name: `Vehicle ${i + 1}: Comprehensive deductible`, kind: 'choice',
      replace: true,
      ignore: (r) => vehicleDeductible(r, i, 'compDeductible').ignore,
      source: (r) => vehicleDeductible(r, i, 'compDeductible').source,
      value: (r) => vehicleDeductible(r, i, 'compDeductible').value,
      note: (r) => vehicleDeductible(r, i, 'compDeductible').note,
    },
    {
      concept: 'coverage.comp-coll', steps: ['Coverages'], selector: `select${p}COLL`, name: `Vehicle ${i + 1}: Collision deductible`, kind: 'choice',
      replace: true,
      ignore: (r) => vehicleDeductible(r, i, 'collDeductible').ignore,
      source: (r) => vehicleDeductible(r, i, 'collDeductible').source,
      value: (r) => vehicleDeductible(r, i, 'collDeductible').value,
      note: (r) => vehicleDeductible(r, i, 'collDeductible').note,
    },
    { concept: 'coverage.comp-coll', steps: ['Coverages'], selector: `input${p}COLL`, name: `Vehicle ${i + 1}: Collision deductible (read-only)`, ignore: true },
    { concept: 'coverage.rental', steps: ['Coverages'], selector: `${p}RENT`, name: `Vehicle ${i + 1}: Rental (keep Progressive default)`, ignore: true },
    { concept: 'coverage.roadside', steps: ['Coverages'], selector: `${p}ROADSD`, name: `Vehicle ${i + 1}: Roadside (keep Progressive default)`, ignore: true },
    {
      concept: 'coverage.vehicle-protection', steps: ['Coverages'], selector: `select${p}PVP`,
      name: `Vehicle ${i + 1}: Progressive Vehicle Protection (standard: None)`, kind: 'choice',
      source: 'standard', tni: 'progressive-pa.pvp', replace: true, ignore: missing,
      value: () => 'None',
    },
    { concept: 'coverage.vehicle-protection', steps: ['Coverages'], selector: `input${p}PVP`, name: `Vehicle ${i + 1}: Progressive Vehicle Protection (read-only)`, ignore: true },
    { concept: 'vehicle.equipment', steps: ['Coverages'], selector: `${p}veh_aoe_valu`, name: `Vehicle ${i + 1}: Custom Parts & Equipment (keep default)`, ignore: true },
    { concept: 'coverage.loan-payoff', steps: ['Coverages'], selector: `${p}PAYOFF`, name: `Vehicle ${i + 1}: Payoff (keep default)`, ignore: true },
    {
      concept: 'quote.snapshot', steps: ['Coverages'], selector: `${p}SnapshotEnrollmentType`,
      name: `Vehicle ${i + 1}: Snapshot enrollment (standard: Do Not Participate)`, kind: 'choice',
      source: 'standard', tni: 'progressive-pa.snapshot', replace: true, ignore: missing,
      value: () => 'Do Not Participate',
    },
  ];
}

/** @returns {CarrierRule[]} */
function coveragesAndPortfolioRules() {
  return [
    ...Array.from({ length: MAX_VEHICLES }, (_, i) => coverageVehicleRules(i)).flat(),
    {
      concept: 'coverage.policy-addons', steps: ['Coverages'], selector: `input[id^="${PC}AccidentForgiveness_"]`,
      name: 'Accident Forgiveness (standard: No)', kind: 'bool',
      source: 'standard', tni: 'progressive-pa.policy-addons', replace: true, value: () => false,
    },
    {
      concept: 'coverage.policy-addons', steps: ['Coverages'], selector: `input[id^="${PC}DeductibleSavingsBank_"]`,
      name: 'Deductible Savings Bank (standard: No)', kind: 'bool',
      source: 'standard', tni: 'progressive-pa.policy-addons', replace: true, value: () => false,
    },
    {
      concept: 'quote.payment', steps: ['Coverages'], selector: 'input[type="radio"][name="billplanGroup"]',
      name: 'Bill plan selection (standard: Pay With EFT)', kind: 'choice',
      source: 'standard', tni: 'progressive-pa.bill-plan', replace: true,
      value: () => 'Pay With EFT',
      choiceAliases: ['Pay With EFT From Checking', 'Pay With EFTFrom Checking'],
    },
    { concept: 'quote.print', steps: ['Portfolio'], selector: '[id^="Portfolio_"]', name: 'Portfolio print/selection checkboxes (agent decides)', kind: 'bool', ignore: true, every: true },
  ];
}

/** @returns {CarrierAction[]} */
function progressivePaActions() {
  return [
    // Add extra vehicle rows on Products sequentially when the intake has more than 1 vehicle.
    ...Array.from({ length: MAX_VEHICLES - 1 }, (_, k) => {
      const idx = k + 1;
      /** @type {CarrierAction} */
      return {
        id: `addVehicle${idx + 1}`,
        steps: ['Products'],
        text: '^add a new vehicle$',
        immediate: true,
        afterActions: idx > 1 ? [`addVehicle${idx}`] : [],
        when: (r) => (r?.vehicles?.length ?? 0) > idx,
        unlessSelector: `#ProductsAA_Vehicles_List_${idx}_Embedded_Questions_List_Vin`,
        label: `Add vehicle ${idx + 1}`,
        missing: `Click "ADD A NEW VEHICLE" so vehicle ${idx + 1} can be filled.`,
        verify: { appears: `#ProductsAA_Vehicles_List_${idx}_Embedded_Questions_List_Vin` },
      };
    }),
    // Verify each entered VIN on Products right after typing it so Progressive decodes Year/Make/Model/Body Style (D6).
    ...Array.from({ length: MAX_VEHICLES }, (_, idx) => /** @type {CarrierAction} */ ({
      id: `verifyVin${idx + 1}`,
      steps: ['Products'],
      token: `vinSearchButton_${idx}`,
      immediate: true,
      after: [`vehicles[${idx}].vin`],
      when: (r) => !!vehicleAt(r, idx)?.vin,
      unlessSelector: `.vin-input.verified #ProductsAA_Vehicles_List_${idx}_Embedded_Questions_List_Vin`,
      label: `Verify VIN for vehicle ${idx + 1}`,
      missing: `Click the VIN verify icon on vehicle ${idx + 1} to decode Year/Make/Model.`,
    })),
    // Add extra household member rows on Household Members sequentially when the intake has more than 1 driver.
    ...Array.from({ length: MAX_DRIVERS - 1 }, (_, k) => {
      const idx = k + 1;
      /** @type {CarrierAction} */
      return {
        id: `addDriver${idx + 1}`,
        steps: ['Household Members'],
        text: '^add more people$',
        immediate: true,
        afterActions: idx > 1 ? [`addDriver${idx}`] : [],
        when: (r) => orderedDrivers(r).length > idx,
        unlessSelector: `#People_Drivers_List_${idx}_Embedded_Questions_List_FirstName`,
        label: `Add household member ${idx + 1}`,
        missing: `Click "ADD MORE PEOPLE" so driver ${idx + 1} can be filled.`,
        verify: { appears: `#People_Drivers_List_${idx}_Embedded_Questions_List_FirstName` },
      };
    }),
    // Coverages: click Recalculate whenever edits make it appear so the updated rate & bill plans load.
    // Omit `missing`: when rates are already current, Progressive hides Recalculate, so its absence is normal.
    {
      id: 'recalculate',
      steps: ['Coverages'],
      text: '^recalculate$',
      whenClear: true,
      verify: 'gone',
      label: 'Recalculate',
    },
    // Portfolio: open the quote PDF via Email/Print once the step is clear (never binds or submits).
    {
      id: 'emailPrint',
      steps: ['Portfolio'],
      text: '^email/print$',
      whenClear: true,
      once: true,
      verify: 'download',
      label: 'Email/Print',
    },
  ];
}

/** @type {CarrierConfig} */
export const progressivePa = {
  id: 'progressive-pa',
  name: 'Progressive Personal Auto',
  product: 'personal-auto',
  hosts: [/(^|\.)foragentsonly\.com$/, /(^|\.)progressive\.com$/],
  world: 'MAIN',
  pageAdapter: 'src/content/carriers/progressive-pa.js',
  // Automatic fills start on quoting.foragentsonly.com/Quote(/Index), never on /home/ (D0).
  autoFillUrl: /^https?:\/\/quoting\.foragentsonly\.com\/Quote(?:\/Index)?(?:\/|[?#]|$)/i,
  layoutUrl: /^https?:\/\/[^/]+\/Quote(?:\/Index)?(?:\/|[?#]|$)/i,
  layoutSteps: ['Named Insured', 'Products', 'Household Members', 'Additional Details', 'Coverages', 'Portfolio', 'Point of Sale', 'Final Sale'],
  quoteSteps: [
    { name: 'Named Insured', step: 'Named Insured' },
    { name: 'Products', step: 'Products' },
    { name: 'Household Members', step: 'Household Members' },
    { name: 'Additional Details', step: 'Additional Details' },
    { name: 'Coverages', step: 'Coverages' },
    { name: 'Portfolio', step: 'Portfolio' },
  ],
  premiumPages: ['Coverages', 'Portfolio'],
  // Auto-advance across the 5 quoting steps up to Portfolio once a step is clear. Never on
  // Portfolio (whose forward button leads to Point of Sale), Point of Sale, or Final Sale.
  // Progressive's forward button carries an accessibility-only "(submit and move to next step)"
  // suffix stripped by cleanAdvanceLabel() for non-sale steps; a.navigation-link tabs are excluded
  // by the adapter's stepLinks selector so only the forward button (#btnNextId) is clicked.
  advance: {
    text: '^(products|household members|additional details|coverages/bill plans|portfolio)$',
    steps: ['Named Insured', 'Products', 'Household Members', 'Additional Details', 'Coverages'],
  },
  // Server-backed Continue waits for NextWorkflowState and detects client-side refusal directly,
  // so never click the forward button a second time automatically if the step stays unchanged.
  continueRetry: false,
  finishedBy: 'emailPrint',
  finishedSaid: 'Email/Print was clicked',
  stopSteps: {
    'Point of Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
    'Final Sale': 'This step is yours: nothing is filled or clicked. The quote stops at Portfolio.',
  },
  display: {
    logo: 'assets/raters/progressive.svg',
    portalUrl: 'https://www.foragentsonly.com/home/',
    product: 'Personal auto',
    classesSaid: 'personal auto quotes',
  },
  rules: [
    ...namedInsuredRules(),
    ...productsRules(),
    ...Array.from({ length: MAX_DRIVERS }, (_, i) => driverRowRules(i)).flat(),
    ...additionalDetailsRules(),
    ...coveragesAndPortfolioRules(),
  ],
  actions: progressivePaActions(),
  useGenericRules: false,
};
