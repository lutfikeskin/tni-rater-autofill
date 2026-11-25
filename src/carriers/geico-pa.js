// @ts-check
// GEICO Personal Auto on sales.geico.com/quote.
//
// A React + GDS web-components single-page app whose 14 steps share /quote and document.title === "GEICO".
// Its page adapter (src/content/carriers/geico-pa.js) reads the active step from the left-drawer
// vertical stepper (plus the unlisted Vehicle Prefill interstitial), tracks in-flight /api/lookup/*
// and /api/conversation/* XHR/fetch requests in MAIN world, assigns 1-based entity `row` keys across
// .ssp-grid tables (Vehicle Information, Driver Information), stacked License History driver sections,
// and Quote Summary per-vehicle coverage blocks, and orders .ssp-grid controls column-first with
// within-column dependency priority (Primary Use before Annual Mileage; Marital Status early).
//
// Quote workflow (TNI, 2026-11-24 — Phase 3):
// - Automatic filling runs on gateway2.geico.com (ZIP + Auto product checkbox via fillOnDraw;
//   Search Products / Start Quote stay agent-clicked) and on sales.geico.com/quote.
// - Pre-quote steps auto-advance (`Next` / `Save and Continue`) when clear: Policyholder Information
//   -> Vehicle Prefill (auto-selects "Quote a different vehicle") -> Current Insurance -> Vehicle
//   Information -> Driver Information -> License History -> Select Drivers with Incidents ->
//   Groups or Organizations -> Quote Summary.
// - Quote Summary expands coverages once (Edit), lowers UMBI/UMPD to match BI/PD when higher,
//   adds ERS + Rental ($50/day, $1,500 max) on every full-coverage vehicle, re-rates via the
//   sticky-bar Recalculate with post-recalculate verification (`keepAnswers` + `reopen: '^edit$'`),
//   checks PrimaryHeader, and opens Print Quote Proposal (/PrintQuote PDF preview) to finish;
//   `newQuestionsOnlySteps` and `keepTakenBack` protect Quote Summary after the initial fill.
// - Finalize (Vehicle Details, Driver Details, Communication Options) and Payment (Payment Plan,
//   Payment Type) are agent-only stopSteps (nothing is filled or clicked there).

import { STATES } from '../states.js';
import {
  EXCLUDED_WORD,
  INCIDENT_NOTES,
  commuteDaysValue,
  commuteMilesValue,
  driverAt,
  driverFirstMiddle,
  driverLooksExcluded,
  insuredDriver,
  notesOf,
  oneLineAddress,
  orderedDrivers,
  parseAnnualMiles,
  parseNonEmployedCategory,
  parseSplitLiability,
  parseVehicleUse,
  resolveVehicleDeductible,
  stripGlassDeductible,
  todayMmDdYyyy,
  vehicleAt,
} from '../products/personal-auto/answers.js';

/** @import { CarrierAction, CarrierConfig, CarrierRule, ClientRecord } from '../../types.js' */

const MAX_VEHICLES = 4;
const MAX_DRIVERS = 5;

const POLICYHOLDER = 'Policyholder Information';
const PREFILL = 'Vehicle Prefill';
const CURRENT_INS = 'Current Insurance';
const VEHICLES = 'Vehicle Information';
const DRIVERS = 'Driver Information';
const LICENSE_HISTORY = 'License History';
const INCIDENTS = 'Select Drivers with Incidents';
const GROUPS = 'Groups or Organizations';
const QUOTE_SUMMARY = 'Quote Summary';

const FILLED = /^https?:\/\/(?:sales\.geico\.com\/quote|gateway2\.geico\.com)(?:[?#/]|$)/i;
const GATEWAY = /^https?:\/\/gateway2\.geico\.com(?:[?#/]|$)/i;
const GATEWAY_OFF = ['/quote'];
const GATEWAY_PRODUCT = 'input[name="lob-selection"]';

const STOP_NOTE = 'This step is yours: nothing is filled or clicked. The quote stops at Quote Summary.';

/** @param {ClientRecord} r */
const zip5 = (r) => String(r?.garaging?.zip ?? '').trim().match(/^(\d{5})(?:-?\d{4})?$/)?.[1] ?? null;
/** @param {ClientRecord} r */
const zipNote = (r) => (r?.garaging?.zip && !zip5(r) ? `The intake's ZIP "${String(r.garaging.zip).trim().slice(0, 60)}" isn't a 5-digit ZIP: enter it yourself.` : null);
/** @param {ClientRecord} r @param {number} i */
const hasValidLicenseNumber = (r, i) => {
  const lic = String(driverAt(r, i)?.licenseNumber ?? '').trim();
  return !!lic && !EXCLUDED_WORD.test(lic);
};

const NO_INS_EXCEPTION_NOTES = /\b(deploy(?:ed|ment)|military|never\s+needed|haven'?t\s+needed|no\s+car|did\s+not\s+own\s+a\s+car)\b/i;
const MILITARY_GOV_WORDS = /\b(military|army|navy|air\s*force|marines?|marine\s*corps|coast\s*guard|national\s*guard|reserves?|veteran|active\s*duty|federal\s*(?:gov(?:ernment)?|employee)|state\s*(?:gov(?:ernment)?|employee)|local\s*(?:gov(?:ernment)?|employee)|postal\s*service|usps|post\s*office)\b/i;
const GROUP_ORG_NOTES = /\b(berkshire|boatus|boat\s*u\.?s\.?|alumni|chamber\s+of\s+commerce|naacp|seiu|fraternity|sorority|honor\s+society|navy\s+league|realtors?\s+assoc|teachers?\s+assoc|nurses?\s+assoc|firefighters?\s+assoc|peace\s+officers?)\b/i;

const GEICO_DEDUCTIBLES = new Set(['$50', '$100', '$250', '$500', '$1,000', '$2,500']);

// GEICO PA's exact 90 provider names on Current Insurance (GiveCurrentAutoInsuranceProvider / GivePreviousAutoInsuranceProvider).
const GEICO_PROVIDERS = [
  'TENNESSEE FARMERS', '1st In Co HI/Tokio Marine', 'AAA/CSAA Auto Club', 'Acuity',
  'Agency Insurance Company', 'Alfa', 'Allied Group', 'Allstate/Encompass',
  'Allstate/Esuran/Encompass', 'American Access', 'American Family', 'American Independent',
  'American Natl/Farm Family', 'Amica', 'Arbella', 'Auto-Owners', 'Bear River',
  'Bristol West', 'Co-operative Insurance', 'Concord', 'Country Financial', 'CURE',
  'DB Insurance US Group', 'De Smet Insurance Group', 'Direct General', 'ELEPHANT',
  'EMC Insurance', 'Erie', 'Esurance', 'Fairfax Financial (USA) Group', 'Farm Bureau',
  'Farm Bureau/Tenn Farmers', 'Farmers & Mechanics Group', 'Farmers Mutual of NE',
  'Farmers/21st Century', 'First Acceptance', 'Fortegra P&C Group', 'GEICO',
  'GoAuto Insurance Company', 'Grange Mutual', 'Grinnell', 'Hanover', 'Hartford',
  'High Point', 'Home State', 'Horace Mann', 'IMT Insurance', 'Infinity',
  'Island Insurance', 'Kemper/Unitrin', 'Key Insurance Company', 'Liberty Mutual/Safeco',
  'Loya', 'MAPFRE/Commerce', 'Mercury', 'MetLife Auto & Home Group', 'MS&AD US Insurance Group',
  'National General/GMAC', 'Nationwide', 'NJ Manufacturers', 'Nodak', 'North Star Companies',
  'NY Central Mutual', 'Old American Capital Group', 'PEMCO', 'Plymouth Rock',
  'Producers National Group', 'Progressive', 'Providence Mutual Fire', 'QBE',
  'Quincy Mutual Group', 'Safe Auto', 'Safety', 'Safeway', 'Sentry/Peak/Viking',
  'Shelter', 'Southern Farm Bureau', 'State Auto', 'State Farm - Other', 'State Farm Mutual',
  'Traders Insurance Company', 'Travelers', 'United Auto Ins Co', 'USAA', 'Vermont Mutual',
  'West Bend', 'Western National', 'Westfield', 'Windhaven',
];

const normProvider = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const EXACT_PROVIDER = new Map(GEICO_PROVIDERS.map((p) => [normProvider(p), p]));

/** @type {[RegExp, string][]} */
const PROVIDER_ALIASES = [
  [/\bprogressive\b/i, 'Progressive'],
  [/\bgeico\b/i, 'GEICO'],
  [/\bstate\s*farm\b/i, 'State Farm Mutual'],
  [/\besurance\b/i, 'Esurance'],
  [/\b(allstate|encompass)\b/i, 'Allstate/Encompass'],
  [/\b(liberty\s*mutual|safeco)\b/i, 'Liberty Mutual/Safeco'],
  [/\b(tennessee\s*farmers|tn\s*farmers|farm\s*bureau.*tenn)/i, 'TENNESSEE FARMERS'],
  [/\b(farmers|21st\s*century)\b/i, 'Farmers/21st Century'],
  [/\b(national\s*general|nat\s*gen|gmac|integon)\b/i, 'National General/GMAC'],
  [/\bsouthern\s*farm\s*bureau\b/i, 'Southern Farm Bureau'],
  [/\bfarm\s*bureau\b/i, 'Farm Bureau'],
  [/\busaa\b/i, 'USAA'],
  [/\btravelers\b/i, 'Travelers'],
  [/\bnationwide\b/i, 'Nationwide'],
  [/\ballied\b/i, 'Allied Group'],
  [/\b(aaa|csaa|auto\s*club)\b/i, 'AAA/CSAA Auto Club'],
  [/\bamerican\s*family\b|\bamfam\b/i, 'American Family'],
  [/\bauto[\s-]*owners\b/i, 'Auto-Owners'],
  [/\berie\b/i, 'Erie'],
  [/\bamica\b/i, 'Amica'],
  [/\bhartford\b/i, 'Hartford'],
  [/\bhanover\b/i, 'Hanover'],
  [/\bmercury\b/i, 'Mercury'],
  [/\binfinity\b/i, 'Infinity'],
  [/\b(kemper|unitrin)\b/i, 'Kemper/Unitrin'],
  [/\bbristol\s*west\b/i, 'Bristol West'],
  [/\bdirect\s*(?:general|auto)\b/i, 'Direct General'],
  [/\bsafe\s*auto\b/i, 'Safe Auto'],
  [/\bcountry\s*financial\b/i, 'Country Financial'],
  [/\bshelter\b/i, 'Shelter'],
  [/\bhorace\s*mann\b/i, 'Horace Mann'],
  [/\bacuity\b/i, 'Acuity'],
  [/\bgrange\b/i, 'Grange Mutual'],
  [/\bwestfield\b/i, 'Westfield'],
  [/\belephant\b/i, 'ELEPHANT'],
  [/\b(?:fred\s+)?loya\b/i, 'Loya'],
  [/\bmetlife\b/i, 'MetLife Auto & Home Group'],
  [/\b(sentry|dairyland|peak|viking)\b/i, 'Sentry/Peak/Viking'],
  [/\b(mapfre|commerce\s+ins)\b/i, 'MAPFRE/Commerce'],
  [/\balfa\b/i, 'Alfa'],
  [/\bstate\s*auto\b/i, 'State Auto'],
  [/\bsafeway\b/i, 'Safeway'],
  [/\bplymouth\s*rock\b/i, 'Plymouth Rock'],
  [/\bnj\s*manufacturers\b|\bnjm\b/i, 'NJ Manufacturers'],
  [/\bfirst\s*acceptance\b/i, 'First Acceptance'],
  [/\bgo\s*auto\b/i, 'GoAuto Insurance Company'],
  [/\bamerican\s*access\b/i, 'American Access'],
  [/\bamerican\s*independent\b/i, 'American Independent'],
  [/\barbella\b/i, 'Arbella'],
  [/\bpemco\b/i, 'PEMCO'],
  [/\bwindhaven\b/i, 'Windhaven'],
];

/**
 * Map an intake carrier name to GEICO PA's 90-item provider list, falling back to "Not Listed"
 * (TNI standard, D8) when the intake names a carrier not on GEICO's list.
 * @param {string | null | undefined} carrier
 * @returns {{ value: string | null, source: 'derived' | 'standard' | 'fact', note: string | null }}
 */
export function geicoProviderChoice(carrier) {
  const s = String(carrier ?? '').trim();
  if (!s) return { value: null, source: 'fact', note: 'Current or prior auto insurance carrier is blank on the intake.' };
  if (/^not\s+listed$/i.test(s)) return { value: 'Not Listed', source: 'derived', note: null };
  const exact = EXACT_PROVIDER.get(normProvider(s));
  if (exact) return { value: exact, source: 'derived', note: null };
  for (const [re, name] of PROVIDER_ALIASES) {
    if (re.test(s)) return { value: name, source: 'derived', note: null };
  }
  return { value: 'Not Listed', source: 'standard', note: null };
}

/**
 * Map intake `priorInsurance[0].insuredFor` to GEICO PA's 12 discrete tenure choices
 * (`Less than 1`, `1`..`10`, `11 or more`).
 * - Exact integer years, `< 1 year` / `< 12 months`, and `11+ years` map as `derived`.
 * - Closed year ranges (`1-3 years`, `3-5 years`, `1 to 3 years`) use the lower bound integer year
 *   (`standard`, `geico-pa.years-with-insurer`).
 * - Open-ended plus / over ranges (`5+ years`, `5+`, `over 5 years`, `more than 5 years`,
 *   `5 years or more`) use the first whole year above N (`N + 1`, capped at `11 or more`; `derived`
 *   when `N >= 11`, `standard` when `N < 11`).
 * - Month-to-year / month ranges starting under 12 months map to `Less than 1` (`derived` when
 *   upper bound < 12 months, `standard` when upper bound >= 12 months).
 * - Blank or unreadable strings stay with the agent (`fact`).
 * @param {string | null | undefined} raw
 * @returns {{ value: string | null, source: 'derived' | 'standard' | 'fact', note: string | null }}
 */
export function geicoPriorYearsChoice(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return { value: null, source: 'fact', note: 'Years with current auto insurer is blank on the intake.' };
  const toYearsOption = (/** @type {number} */ yrs) => (yrs <= 0 ? 'Less than 1' : yrs >= 11 ? '11 or more' : String(yrs));

  if (/^(?:less\s+than\s+1|under\s+1|<\s*1)(?:\s*(?:years?|yrs?))?$|^0\s*(?:years?|yrs?)$/.test(s)) {
    return { value: 'Less than 1', source: 'derived', note: null };
  }
  const ltMo = s.match(/^(?:less\s+than|under|<)\s*(\d+)\s*(?:months?|mos?)$/);
  if (ltMo) {
    const m = Number(ltMo[1]);
    if (m >= 1 && m <= 12) return { value: 'Less than 1', source: 'derived', note: null };
    return { value: null, source: 'fact', note: `Years with current insurer "${raw}" couldn't be mapped — confirm on GEICO.` };
  }
  const mo = s.match(/^(\d+)\s*(?:months?|mos?)$/);
  if (mo) {
    const m = Number(mo[1]);
    if (m < 12) return { value: 'Less than 1', source: 'derived', note: null };
    if (m % 12 === 0) return { value: toYearsOption(m / 12), source: 'derived', note: null };
    return { value: null, source: 'fact', note: `Years with current insurer "${raw}" isn't a whole year — confirm on GEICO.` };
  }
  const exactYr = s.match(/^(\d+)\s*(?:years?|yrs?)?$/);
  if (exactYr) {
    return { value: toYearsOption(Number(exactYr[1])), source: 'derived', note: null };
  }
  const moRange = s.match(/^(\d+)\s*(?:months?|mos?)?\s*(?:[-–—]|to)\s*(\d+)\s*(?:months?|mos?)$/);
  if (moRange) {
    const lo = Number(moRange[1]);
    const hi = Number(moRange[2]);
    if (lo <= hi && lo < 12) {
      return { value: 'Less than 1', source: hi < 12 ? 'derived' : 'standard', note: null };
    }
    return { value: null, source: 'fact', note: `Years with current insurer "${raw}" couldn't be mapped — confirm on GEICO.` };
  }
  const moYrRange = s.match(/^(\d+)\s*(?:months?|mos?)\s*(?:[-–—]|to)\s*(\d+)\s*(?:years?|yrs?)$/);
  if (moYrRange) {
    const loMo = Number(moYrRange[1]);
    const hiYr = Number(moYrRange[2]);
    if (loMo < 12 && hiYr * 12 >= loMo) {
      return { value: 'Less than 1', source: hiYr * 12 < 12 ? 'derived' : 'standard', note: null };
    }
    return { value: null, source: 'fact', note: `Years with current insurer "${raw}" couldn't be mapped — confirm on GEICO.` };
  }
  const yrRange = s.match(/^(\d+)\s*(?:years?|yrs?)?\s*(?:[-–—]|to)\s*(\d+)\s*(?:years?|yrs?)$/);
  if (yrRange) {
    const lo = Number(yrRange[1]);
    const hi = Number(yrRange[2]);
    if (lo <= hi) {
      return { value: toYearsOption(lo), source: 'standard', note: null };
    }
    return { value: null, source: 'fact', note: `Years with current insurer "${raw}" couldn't be mapped — confirm on GEICO.` };
  }
  const openYr = s.match(/^(?:(\d+)\s*\+\s*(?:years?|yrs?)?|(?:(?:over|more\s+than)\s+|>\s*)(\d+)\s*(?:years?|yrs?)|(\d+)\s*(?:years?|yrs?)\s+or\s+more|(\d+)\s+or\s+more(?:\s*(?:years?|yrs?))?)$/);
  if (openYr) {
    const n = Number(openYr[1] ?? openYr[2] ?? openYr[3] ?? openYr[4]);
    return { value: toYearsOption(n + 1), source: n >= 11 ? 'derived' : 'standard', note: null };
  }
  return { value: null, source: 'fact', note: `Years with current insurer "${raw}" couldn't be mapped — confirm on GEICO.` };
}

// Options excluded when picking the lowest Current BI limit for intake "State Minimum" /
// "State Minimum or less" if GEICO does not list a "State Minimum" option.
const PRIOR_BI_STATE_MIN_NOT = "^(?:please\\s+select|select|choose|(?:i(?:['’]?m|\\s+am)\\s+)?not\\s+sure|(?:i\\s+)?(?:don['’]?t|do\\s+not)\\s+know|none|unknown|other|i\\s+decline)$";

/**
 * Map intake `priorInsurance[0].limit` to GEICO PA's current BI limit dropdown.
 * - Exact split limits (`$25k/$50k`..`$300k/$300k`, `$250k/$500k`+, `$500k+ CSL`) map as `derived` (`kind: 'choice'`).
 * - `"State Minimum"` / `"State Minimum or less"` (`/^state\s*min/i`) uses `kind: 'pick-not'`
 *   (`source: 'standard'`, `tni: 'geico-pa.prior-bi-state-min'`): prefers `"State Minimum"` if
 *   offered, otherwise picks the lowest non-placeholder, non-unsure option (e.g. `$25,000/$50,000`).
 * - Blank or unmappable values (e.g. `"Other"`, ambiguous CSL) stay with the agent (`fact`).
 * - GEICO's prefilled selection is kept when present (rule omits `replace: true`).
 * @param {string | null | undefined} limit
 * @returns {{ kind: 'choice' | 'pick-not', value: string | { not: string, prefer: string } | null, source: 'derived' | 'standard' | 'fact', note: string | null }}
 */
export function geicoPriorBiChoice(limit) {
  const s = String(limit ?? '').trim();
  if (!s) return { kind: 'choice', value: null, source: 'fact', note: 'Current bodily injury limits are blank on the intake.' };
  if (/^state\s*min/i.test(s)) {
    return {
      kind: 'pick-not',
      value: { not: PRIOR_BI_STATE_MIN_NOT, prefer: '^state\\s*min' },
      source: 'standard',
      note: null,
    };
  }
  if (/^\$?25k?\/\$?50k?$/i.test(s)) return { kind: 'choice', value: '$25,000/$50,000', source: 'derived', note: null };
  if (/^\$?50k?\/\$?100k?$/i.test(s)) return { kind: 'choice', value: '$50,000/$100,000', source: 'derived', note: null };
  if (/^\$?100k?\/\$?200k?$/i.test(s)) return { kind: 'choice', value: '$100,000/$200,000', source: 'derived', note: null };
  if (/^\$?100k?\/\$?300k?$/i.test(s)) return { kind: 'choice', value: '$100,000/$300,000', source: 'derived', note: null };
  if (/^\$?300k?\/\$?300k?$/i.test(s)) return { kind: 'choice', value: '$300,000/$300,000', source: 'derived', note: null };
  if (/^\$?(?:250k?\/\$?500k?|500k?\s*csl|750k?\s*csl|1,?000,?000\s*csl)$/i.test(s)) {
    return { kind: 'choice', value: '$250,000/$500,000 or higher', source: 'derived', note: null };
  }
  return { kind: 'choice', value: null, source: 'fact', note: `Current BI limit "${s}" doesn't map unambiguously to GEICO's split limits — confirm on screen.` };
}

/**
 * Derive "Have you had insurance within the last 30 days?" when `currentlyInsured === false` and
 * the intake provides a valid prior expiration date (`MM/DD/YYYY`).
 * @param {string | null | undefined} exp
 * @param {Date} [today]
 * @returns {{ value: 'Yes' | 'No' | null, source: 'derived' | 'fact', note: string | null }}
 */
export function hadInsuranceLast30Days(exp, today = new Date()) {
  const s = String(exp ?? '').trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return { value: null, source: 'fact', note: 'Confirm whether the client had auto insurance within the last 30 days.' };
  const mo = Number(m[1]), da = Number(m[2]), yr = Number(m[3]);
  const expUtc = new Date(Date.UTC(yr, mo - 1, da));
  if (expUtc.getUTCFullYear() !== yr || expUtc.getUTCMonth() !== mo - 1 || expUtc.getUTCDate() !== da) {
    return { value: null, source: 'fact', note: `Prior expiration "${s}" is not a valid calendar date — confirm last-30-days coverage.` };
  }
  const nowUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const diffDays = Math.round((nowUtc - expUtc.getTime()) / 86_400_000);
  if (diffDays < 0) return { value: null, source: 'fact', note: `Prior expiration "${s}" is in the future while currently insured is No — confirm last-30-days coverage.` };
  return { value: diffDays <= 30 ? 'Yes' : 'No', source: 'derived', note: null };
}

/**
 * Map intake `vehicles[i].ownedFor` to GEICO PA's live Length of Ownership options
 * (`Not yet purchased`, `Less than 2 months`, `2 months to 2 years`, `2 to 10 years`, `10 or more years`).
 * Unambiguous intervals strictly inside one GEICO bucket map as `derived`; intake `"3+ years"` /
 * `"3+years"` maps unconditionally to `"2 to 10 years"` (`derived` when vehicle age < 10 years;
 * TNI standard `geico-pa.ownership-length` when >= 10 years old or year blank). Other straddling
 * buckets stay with the agent.
 * @param {any} v
 * @param {Date} [today]
 * @returns {{ value: string | null, source: 'derived' | 'standard' | 'fact', note: string | null }}
 */
export function geicoOwnershipLength(v, today = new Date()) {
  const s = String(v?.ownedFor ?? '').trim();
  if (!s) return { value: null, source: 'fact', note: 'Length of vehicle ownership is blank on the intake.' };
  if (/^not\s+yet\s+purchased$/i.test(s)) return { value: 'Not yet purchased', source: 'derived', note: null };
  if (/^(?:less\s+than|under|<)\s*[12]\s*months?$/i.test(s) || /^1\s*month$/i.test(s)) {
    return { value: 'Less than 2 months', source: 'derived', note: null };
  }
  if (/^(?:2\s*months?\s*(?:-|to)\s*2\s*years?|6\s*months?\s*(?:-|to)\s*[12]\s*years?|1(?:\s*years?)?\s*(?:-|to)\s*2\s*years?)$/i.test(s)) {
    return { value: '2 months to 2 years', source: 'derived', note: null };
  }
  if (/^(?:[23]\s*(?:years?)?\s*(?:-|to)\s*(?:5|10)\s*years?|5\s*(?:years?)?\s*(?:-|to)\s*10\s*years?)$/i.test(s)) {
    return { value: '2 to 10 years', source: 'derived', note: null };
  }
  if (/^10(?:\+|\s+or\s+more)\s*years?$/i.test(s)) {
    return { value: '10 or more years', source: 'derived', note: null };
  }
  if (/^3\+\s*years?$/i.test(s)) {
    const under10 = Number.isFinite(v?.year) && (today.getFullYear() - Number(v.year)) < 10;
    return { value: '2 to 10 years', source: under10 ? 'derived' : 'standard', note: null };
  }
  const exactMo = s.match(/^(\d+)\s*(?:months?|mos?)$/i);
  if (exactMo) {
    const m = Number(exactMo[1]);
    if (m >= 0 && m < 2) return { value: 'Less than 2 months', source: 'derived', note: null };
    if (m >= 2 && m < 24) return { value: '2 months to 2 years', source: 'derived', note: null };
    if (m > 24 && m < 120) return { value: '2 to 10 years', source: 'derived', note: null };
    if (m >= 120) return { value: '10 or more years', source: 'derived', note: null };
  }
  const exactYr = s.match(/^(\d+)\s*(?:years?|yrs?)$/i);
  if (exactYr) {
    const y = Number(exactYr[1]);
    if (y === 1) return { value: '2 months to 2 years', source: 'derived', note: null };
    if (y >= 3 && y < 10) return { value: '2 to 10 years', source: 'derived', note: null };
    if (y >= 10) return { value: '10 or more years', source: 'derived', note: null };
  }
  return { value: null, source: 'fact', note: `Length of ownership "${s}" straddles GEICO's purchase-date buckets — pick the right option.` };
}

/**
 * Map intake vehicle primary use to GEICO PA's options (`Pleasure`, `Commute`, `Business`).
 * @param {string | null | undefined} use
 * @returns {'Pleasure' | 'Commute' | 'Business' | null}
 */
function geicoVehicleUse(use) {
  const kind = parseVehicleUse(use);
  if (kind === 'pleasure') return 'Pleasure';
  if (kind === 'commute') return 'Commute';
  if (kind === 'business') return 'Business';
  return null;
}

/**
 * Map intake annual mileage to GEICO PA's 1,000-mile bands (`1,000 - 1,999`..`29,000 - 29,999`, `30,000+`).
 * Blank intake mileage is ignored by the rule (keeps GEICO's auto-estimate, D9).
 * @param {number | string | null | undefined} raw
 * @returns {string | null}
 */
export function geicoAnnualMileageBand(raw) {
  const { miles, over50k } = parseAnnualMiles(raw);
  if (over50k) return '30,000+';
  if (miles == null || miles < 1000) return null;
  if (miles >= 30000) return '30,000+';
  const lo = Math.floor(miles / 1000) * 1000;
  return `${lo.toLocaleString('en-US')} - ${(lo + 999).toLocaleString('en-US')}`;
}

/**
 * Map intake `drivers[i].education` to GEICO PA's 12 Education Level choices.
 * `Some College` and `Currently in College` have no 1-to-1 GEICO option and stay with the agent (D12).
 * @param {string | null | undefined} edu
 * @returns {{ value: string | null, source: 'derived' | 'fact', note: string | null }}
 */
export function geicoEducationChoice(edu) {
  const s = String(edu ?? '').trim();
  if (!s) return { value: null, source: 'fact', note: 'Education level is blank on the intake.' };
  if (/^no high school diploma/i.test(s)) return { value: 'Less than High School', source: 'derived', note: null };
  if (/^high school diploma/i.test(s)) return { value: 'High School', source: 'derived', note: null };
  if (/^associate'?s?\s+degree$/i.test(s)) return { value: 'Associate', source: 'derived', note: null };
  if (/^bachelor'?s?\s+degree$/i.test(s)) return { value: 'Bachelors', source: 'derived', note: null };
  if (/^master'?s?\s+degree$/i.test(s)) return { value: 'Masters', source: 'derived', note: null };
  if (/^ph\.?d\.?$/i.test(s)) return { value: 'PhD', source: 'derived', note: null };
  return { value: null, source: 'fact', note: `Education "${s}" has no exact GEICO option — confirm Education Level.` };
}

/**
 * Map intake `drivers[i].occupation` to GEICO PA's Employment Status (D12).
 * Clear non-employed statuses map directly (except Disabled -> agent); specific non-military/gov
 * occupations select "A Private Company/Organization or Self Employed" while Industry/Occupation
 * stay with the agent.
 * @param {string | null | undefined} occ
 * @returns {{ value: string | null, source: 'derived' | 'fact', note: string | null }}
 */
export function geicoEmploymentChoice(occ) {
  const s = String(occ ?? '').trim();
  if (!s) return { value: null, source: 'fact', note: 'Occupation is blank on the intake — confirm Employment Status.' };
  const nonEmp = parseNonEmployedCategory(s);
  if (nonEmp === 'student') return { value: 'I am a Full Time Student', source: 'derived', note: null };
  if (nonEmp === 'homemaker') return { value: 'I am Currently a Homemaker', source: 'derived', note: null };
  if (nonEmp === 'unemployed') return { value: 'Not Currently Employed', source: 'derived', note: null };
  if (nonEmp === 'retired') {
    if (MILITARY_GOV_WORDS.test(s)) return { value: null, source: 'fact', note: `Occupation "${s}" mentions military/government — confirm Employment Status.` };
    return { value: 'Retired Private Company/Organization or Self Employed', source: 'derived', note: null };
  }
  if (nonEmp === 'disabled') return { value: null, source: 'fact', note: `Occupation is "${s}" (no Disabled option on GEICO) — confirm Employment Status.` };
  if (MILITARY_GOV_WORDS.test(s)) return { value: null, source: 'fact', note: `Occupation "${s}" mentions military/government — confirm Employment Status.` };
  return { value: 'A Private Company/Organization or Self Employed', source: 'derived', note: null };
}

/**
 * Determine whether driver `i` was unambiguously licensed in the U.S. before turning `age - 3`
 * (GEICO PA's dynamic 3-year substantial-license-history threshold on License History, D13).
 * Requires valid `dob`, valid `yearLicensed`, and a valid 2-letter US `licenseState`.
 * Boundary year (`yearLicensed === turnYear`) stays with the agent.
 * @param {any} d
 * @param {Date} [today]
 * @returns {{ value: 'Yes' | 'No' | null, source: 'derived' | 'fact', note: string | null }}
 */
export function substantialLicenseHistory(d, today = new Date()) {
  if (!d) return { value: null, source: 'fact', note: 'Confirm U.S. license history.' };
  const st = String(d.licenseState ?? '').trim().toUpperCase();
  if (!st || !Object.hasOwn(STATES, st)) {
    return { value: null, source: 'fact', note: 'License state is blank or non-US — confirm U.S. license history.' };
  }
  const dobM = String(d.dob ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!dobM || !Number.isFinite(d.yearLicensed)) {
    return { value: null, source: 'fact', note: 'Date of birth or year licensed is blank — confirm U.S. license history.' };
  }
  const dobMonth = Number(dobM[1]);
  const dobDay = Number(dobM[2]);
  const dobYear = Number(dobM[3]);
  const nowYear = today.getFullYear();
  const nowMonth = today.getMonth() + 1;
  const nowDay = today.getDate();
  let age = nowYear - dobYear;
  if (nowMonth < dobMonth || (nowMonth === dobMonth && nowDay < dobDay)) age--;
  // GEICO asks "licensed in the U.S. before turning X?" where X = age - 3 (checking >= 3 yrs licensed).
  const thresholdAge = age - 3;
  if (thresholdAge <= 0) return { value: null, source: 'fact', note: 'Confirm U.S. license history.' };
  const turnYear = dobYear + thresholdAge;
  const yr = Number(d.yearLicensed);
  if (yr < turnYear) return { value: 'Yes', source: 'derived', note: null };
  if (yr > turnYear) return { value: 'No', source: 'derived', note: null };
  return { value: null, source: 'fact', note: `Year licensed (${yr}) falls in the boundary year for age ${thresholdAge} — confirm U.S. license history.` };
}

/**
 * Calculate GEICO PA's "How old was this driver when they got their driver's license in the U.S.?"
 * (TNI standard, A3): `yearLicensed - birthYear`, subtracting 1 only when `yearLicensed` is the
 * current year and the driver's birthday has not yet occurred (so GEICO's Month/Year dropdown is
 * never empty or above their current age). Requires valid US `licenseState`, valid `dob`, valid
 * `yearLicensed`, and `14 <= age <= currentAge`; otherwise stays with the agent (`source: 'fact'`).
 * @param {any} d
 * @param {Date} [today]
 * @returns {{ value: string | null, source: 'standard' | 'fact', note: string | null }}
 */
export function geicoAgeFirstLicensed(d, today = new Date()) {
  if (!d) return { value: null, source: 'fact', note: 'Confirm age first licensed in the U.S.' };
  const st = String(d.licenseState ?? '').trim().toUpperCase();
  if (!st || !Object.hasOwn(STATES, st)) {
    return { value: null, source: 'fact', note: 'License state is blank or non-US — confirm age first licensed in the U.S.' };
  }
  const dobM = String(d.dob ?? '').trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!dobM || !Number.isFinite(d.yearLicensed)) {
    return { value: null, source: 'fact', note: 'Date of birth or year licensed is blank — confirm age first licensed in the U.S.' };
  }
  const dobMonth = Number(dobM[1]);
  const dobDay = Number(dobM[2]);
  const dobYear = Number(dobM[3]);
  if (dobMonth < 1 || dobMonth > 12 || dobDay < 1 || dobDay > 31 || dobYear < 1900) {
    return { value: null, source: 'fact', note: 'Date of birth is invalid — confirm age first licensed in the U.S.' };
  }
  const nowYear = today.getFullYear();
  const nowMonth = today.getMonth() + 1;
  const nowDay = today.getDate();
  let currentAge = nowYear - dobYear;
  if (nowMonth < dobMonth || (nowMonth === dobMonth && nowDay < dobDay)) currentAge--;
  const yr = Number(d.yearLicensed);
  let age = yr - dobYear;
  if (yr === nowYear && (dobMonth > nowMonth || (dobMonth === nowMonth && dobDay > nowDay))) age--;
  if (!Number.isInteger(age) || age < 14 || age > currentAge) {
    return { value: null, source: 'fact', note: `Calculated age first licensed (${age}) is out of range — confirm on GEICO.` };
  }
  return { value: String(age), source: 'standard', note: null };
}

/**
 * True when vehicle `i` is an explicit full-coverage vehicle on the intake (`fullCoverage === true`
 * with active Comprehensive and Collision deductibles).
 * @param {ClientRecord} r
 * @param {number} i
 * @returns {boolean}
 */
function isFullCoverageVehicle(r, i) {
  const v = vehicleAt(r, i);
  if (!v || v.fullCoverage !== true) return false;
  return resolveVehicleDeductible(r, i, 'compDeductible').kind === 'amount'
    && resolveVehicleDeductible(r, i, 'collDeductible').kind === 'amount';
}

/**
 * Format a vehicle's Comprehensive or Collision deductible into GEICO PA's exact dropdown option
 * (`I decline` or `$X deductible`, stripping ` w/$50 Glass` for `$100/$250/$500/$1,000`, D15).
 * Unoffered deductibles (`$750`, `$2,000`, `$2,000 w/$50 Glass`) stay with the agent.
 * @param {ClientRecord} r
 * @param {number} i
 * @param {'compDeductible' | 'collDeductible'} field
 */
function geicoVehicleDeductible(r, i, field) {
  const res = resolveVehicleDeductible(r, i, field);
  if (res.kind === 'ignore') return { value: null, source: /** @type {const} */ ('derived'), note: null, ignore: true };
  if (res.kind === 'none') return { value: 'I decline', source: /** @type {const} */ ('derived'), note: null, ignore: false };
  if (res.kind === 'missing') return { value: null, source: /** @type {const} */ ('fact'), note: res.note, ignore: false };
  const base = stripGlassDeductible(res.raw);
  if (base && GEICO_DEDUCTIBLES.has(base)) {
    return { value: `${base} deductible`, source: /** @type {const} */ ('derived'), note: null, ignore: false };
  }
  const label = field === 'compDeductible' ? 'Comprehensive' : 'Collision';
  return { value: null, source: /** @type {const} */ ('fact'), note: `Vehicle ${i + 1}: ${label} deductible "${res.raw}" isn't offered on GEICO — pick a deductible.`, ignore: false };
}

/** @returns {CarrierRule[]} */
function gatewayRules() {
  return [
    {
      concept: 'business.address', notPages: GATEWAY_OFF, selector: '#start-quote-zip',
      name: 'Start quote: ZIP (the garaging ZIP)', path: 'garaging.zip',
      source: (r) => (zip5(r) ? 'derived' : 'fact'), value: zip5,
      note: (r) => zipNote(r) ?? (zip5(r) ? null : 'Garaging ZIP is blank on the intake.'),
      replace: true,
    },
    {
      concept: 'quote.product', notPages: GATEWAY_OFF,
      selector: `${GATEWAY_PRODUCT}#auto, ${GATEWAY_PRODUCT}[value="auto"]`,
      name: 'Start quote: Auto (standard: checked)', q: 'gatewayAuto', tni: 'geico-pa.product',
      kind: 'bool', source: 'standard', value: () => true,
    },
    ...[
      ['input[name="header-search-type"]', 'Gateway: policy or quote search', false],
      ['#search-input-id', 'Gateway: search box', false],
      [GATEWAY_PRODUCT, 'Gateway: another product (never ticked)', true],
      ['[id^="alerts-pref"]', 'Gateway: alerts settings', false],
    ].map(/** @param {[string, string, boolean]} row @returns {CarrierRule} */ ([selector, name, every]) => ({
      concept: selector === GATEWAY_PRODUCT ? 'quote.product' : 'quote.navigation',
      notPages: GATEWAY_OFF, selector, name, q: 'gatewayDashboard', ignore: true, every,
    })),
  ];
}

/** @returns {CarrierRule[]} */
function policyholderRules() {
  return [
    {
      concept: 'owner.name', steps: [POLICYHOLDER], field: 'GiveFirstName',
      name: 'Policyholder first name', source: 'derived',
      value: (r) => driverFirstMiddle(insuredDriver(r)).first,
    },
    {
      concept: 'owner.name', steps: [POLICYHOLDER], field: 'GiveLastName',
      name: 'Policyholder last name', source: 'derived',
      value: (r) => insuredDriver(r)?.last ?? null,
    },
    {
      concept: 'owner.dob', steps: [POLICYHOLDER], field: 'GiveDateOfBirth',
      name: 'Policyholder date of birth', kind: 'date', source: 'derived',
      value: (r) => insuredDriver(r)?.dob ?? null,
    },
    {
      concept: 'owner.emancipated-minor', steps: [POLICYHOLDER], field: 'GiveEmancipatedMinorYesNoRequest',
      name: 'Emancipated minor (agent decides if shown)', kind: 'choice', source: 'fact',
      note: 'Applicant is under 18: confirm emancipated minor status and court order.',
    },
    {
      concept: 'business.address', steps: [POLICYHOLDER], field: 'GiveStreet',
      name: 'Residential street address (with suggestion)', path: 'garaging.street', kind: 'address-suggest',
      source: 'derived', value: oneLineAddress, fallback: (r) => r?.garaging?.street ?? null, checkNumber: true,
    },
    { concept: 'business.address', steps: [POLICYHOLDER], field: 'GiveCity', name: 'City (populated by address lookup)', ignore: true },
    {
      concept: 'business.address', steps: [POLICYHOLDER], field: 'GiveZip',
      name: '5-Digit ZIP Code', path: 'garaging.zip',
      source: (r) => (zip5(r) ? 'derived' : 'fact'), value: zip5,
      note: (r) => zipNote(r) ?? (zip5(r) ? null : 'Garaging ZIP is blank on the intake.'),
    },
    { concept: 'business.address', steps: [POLICYHOLDER], field: 'GiveUnitNumber', name: 'Apt #', path: 'garaging.unit', optional: true, ignore: (r) => !r?.garaging?.unit },
    {
      concept: 'residence.ownership', steps: [POLICYHOLDER], field: 'GiveOwnOrRent',
      name: 'Do you own or rent your home?', kind: 'choice',
      source: (r) => (/^(own|rent)$/i.test(r?.residence?.ownership ?? '') ? 'derived' : 'fact'),
      value: (r) => (/^own$/i.test(r?.residence?.ownership ?? '') ? 'Own' : /^rent$/i.test(r?.residence?.ownership ?? '') ? 'Rent' : null),
      note: (r) => (/^(own|rent)$/i.test(r?.residence?.ownership ?? '') ? null : 'Own or rent home is blank on the intake.'),
    },
    { concept: 'business.contact', steps: [POLICYHOLDER], field: 'GiveEmail', name: 'Email address', path: 'applicant.email', optional: true, ignore: (r) => !r?.applicant?.email },
    { concept: 'business.contact', steps: [POLICYHOLDER], field: 'GivePhoneNumber', name: 'Mobile phone number', path: 'applicant.phone', kind: 'phone' },
    {
      concept: 'quote.effective-date', steps: [POLICYHOLDER], field: 'GiveEffectiveDate',
      name: 'Coverage start date (keep default; fill today if empty)', kind: 'date',
      source: 'standard', tni: 'geico-pa.effective-date', trustPage: true, value: () => todayMmDdYyyy(),
    },
    { concept: 'owner.ssn', steps: [POLICYHOLDER], field: 'GiveSocialSecurityNumber', name: 'Social Security number (never filled)', ignore: true },
    {
      concept: 'quote.disclosure', steps: [POLICYHOLDER], field: 'GiveCreditAcknowledgement.Yes',
      name: 'Consumer-report / credit disclosure acknowledgement (standard: checked)', kind: 'bool',
      source: 'standard', tni: 'geico-pa.acknowledgements', value: () => true,
    },
    // Vehicle Prefill interstitial: always select "Quote a different vehicle" (TNI standard)
    // and ignore all prefilled vehicle cards so Next auto-advances cleanly.
    {
      concept: 'quote.unit-entry', steps: [PREFILL],
      selector: 'input[type="checkbox"][value="AddVehicle"]', q: 'vehiclePrefillAdd',
      name: 'Quote a different vehicle (standard: checked)', kind: 'bool',
      source: 'standard', tni: 'geico-pa.vehicle-prefill', value: () => true,
    },
    { concept: 'quote.unit-entry', steps: [PREFILL], selector: 'input[type="checkbox"]', name: 'Vehicle Prefill prefilled vehicle cards (never selected)', kind: 'bool', ignore: true, every: true },
  ];
}

/** @returns {CarrierRule[]} */
function currentInsuranceRules() {
  const prior = (/** @type {ClientRecord} */ r) => r?.priorInsurance?.[0] ?? null;
  const noInsFlag = (/** @type {ClientRecord} */ r) => NO_INS_EXCEPTION_NOTES.test(notesOf(r));
  return [
    {
      concept: 'prior.currently-insured', steps: [CURRENT_INS], field: 'GiveCurrentAutoInsuranceStatus',
      name: 'Do you currently have auto insurance?', kind: 'choice',
      source: (r) => {
        const cur = prior(r)?.currentlyInsured;
        if (cur === true) return 'derived';
        if (cur === false && !noInsFlag(r)) return 'derived';
        return 'fact';
      },
      value: (r) => {
        const cur = prior(r)?.currentlyInsured;
        if (cur === true) return 'Yes';
        if (cur === false && !noInsFlag(r)) return 'No';
        return null;
      },
      note: (r) => {
        const cur = prior(r)?.currentlyInsured;
        if (cur === true) return null;
        if (cur === false && !noInsFlag(r)) return null;
        if (cur === false) return 'Notes mention military deployment or not needing insurance — confirm Current Insurance status.';
        return 'Currently insured is blank on the intake.';
      },
    },
    {
      concept: 'prior.carrier', steps: [CURRENT_INS], field: 'GiveCurrentAutoInsuranceProvider',
      name: 'Current auto insurance provider', kind: 'choice', tni: 'geico-pa.prior-provider',
      ignore: (r) => prior(r)?.currentlyInsured === false,
      source: (r) => geicoProviderChoice(prior(r)?.carrier).source,
      value: (r) => geicoProviderChoice(prior(r)?.carrier).value,
      note: (r) => geicoProviderChoice(prior(r)?.carrier).note,
    },
    {
      concept: 'prior.carrier', steps: [CURRENT_INS], field: 'GivePreviousAutoInsuranceProvider',
      name: 'Prior auto insurance provider', kind: 'choice', tni: 'geico-pa.prior-provider',
      ignore: (r) => prior(r)?.currentlyInsured === true,
      source: (r) => geicoProviderChoice(prior(r)?.carrier).source,
      value: (r) => geicoProviderChoice(prior(r)?.carrier).value,
      note: (r) => geicoProviderChoice(prior(r)?.carrier).note,
    },
    {
      concept: 'prior.tenure', steps: [CURRENT_INS], field: 'GiveYearsWithCurrentAutoInsurer',
      name: 'Years with current auto provider', kind: 'choice', tni: 'geico-pa.years-with-insurer',
      ignore: (r) => prior(r)?.currentlyInsured === false,
      source: (r) => geicoPriorYearsChoice(prior(r)?.insuredFor).source,
      value: (r) => geicoPriorYearsChoice(prior(r)?.insuredFor).value,
      note: (r) => geicoPriorYearsChoice(prior(r)?.insuredFor).note,
    },
    // Current BI limits: omit `replace: true` so GEICO's 3rd-party prefilled limit is preserved.
    {
      concept: 'prior.limit', steps: [CURRENT_INS], field: 'GiveCurrentBodilyInjuryLimits',
      name: 'Current bodily injury limits', tni: 'geico-pa.prior-bi-state-min',
      kind: (r) => geicoPriorBiChoice(prior(r)?.limit).kind,
      ignore: (r) => prior(r)?.currentlyInsured === false,
      source: (r) => geicoPriorBiChoice(prior(r)?.limit).source,
      value: (r) => geicoPriorBiChoice(prior(r)?.limit).value,
      note: (r) => geicoPriorBiChoice(prior(r)?.limit).note,
    },
    {
      concept: 'prior.lapse-30-days', steps: [CURRENT_INS], field: 'YesNoLastThirtyDays',
      name: 'Had insurance within the last 30 days?', kind: 'choice',
      ignore: (r) => prior(r)?.currentlyInsured === true,
      source: (r) => hadInsuranceLast30Days(prior(r)?.expiration).source,
      value: (r) => hadInsuranceLast30Days(prior(r)?.expiration).value,
      note: (r) => hadInsuranceLast30Days(prior(r)?.expiration).note,
    },
  ];
}

/** @param {number} i @returns {CarrierRule[]} */
function vehicleColumnRules(i) {
  const row = i + 1;
  const missing = (/** @type {ClientRecord} */ r) => !vehicleAt(r, i);
  const hasVin = (/** @type {ClientRecord} */ r) => !!vehicleAt(r, i)?.vin;
  return [
    {
      concept: 'quote.unit-entry', steps: [VEHICLES], field: 'YesNoPreQuoteHaveFullVinActivity', row,
      name: `Vehicle ${row}: have VIN?`, kind: 'choice', ignore: missing,
      source: 'derived', value: (r) => (hasVin(r) ? 'Yes' : 'No'),
    },
    {
      concept: 'vehicle.vin', steps: [VEHICLES], field: 'GiveVinPreQuote', row,
      name: `Vehicle ${row}: VIN`, path: `vehicles[${i}].vin`,
      ignore: (r) => missing(r) || !hasVin(r),
    },
    {
      concept: 'vehicle.year', steps: [VEHICLES], field: 'GiveYear', row,
      name: `Vehicle ${row}: year`, path: `vehicles[${i}].year`, kind: 'choice',
      ignore: (r) => missing(r) || hasVin(r),
    },
    {
      concept: 'vehicle.make', steps: [VEHICLES], field: 'GiveMake', row,
      name: `Vehicle ${row}: make`, path: `vehicles[${i}].make`, kind: 'choice',
      ignore: (r) => missing(r) || hasVin(r),
    },
    {
      concept: 'vehicle.model', steps: [VEHICLES], field: 'GiveModel', row,
      name: `Vehicle ${row}: model`, path: `vehicles[${i}].model`, kind: 'choice',
      ignore: (r) => missing(r) || hasVin(r),
    },
    {
      concept: 'vehicle.safety-features', steps: [VEHICLES], field: 'YesNoAntiLockBrakes', row,
      name: `Vehicle ${row}: anti-lock brakes`, kind: 'choice',
      ignore: (r) => missing(r) || hasVin(r),
      source: 'fact', note: `Vehicle ${row}: confirm whether the vehicle has anti-lock brakes.`,
    },
    {
      concept: 'vehicle.type', steps: [VEHICLES], field: 'GiveBodyStyle', row,
      name: `Vehicle ${row}: body style`, kind: 'choice',
      ignore: (r) => missing(r) || hasVin(r),
      source: 'fact', note: `Vehicle ${row}: select body style.`,
    },
    {
      concept: 'vehicle.safety-features', steps: [VEHICLES], field: 'GivePassiveRestraintDevice', row,
      name: `Vehicle ${row}: safety restraint device`, kind: 'choice',
      ignore: (r) => missing(r) || hasVin(r),
      source: 'fact', note: `Vehicle ${row}: select safety restraint device.`,
    },
    {
      concept: 'vehicle.loan-lease', steps: [VEHICLES], field: 'GiveVehicleOwnerShip', row,
      name: `Vehicle ${row}: ownership`, kind: 'choice', ignore: missing,
      source: (r) => (/^(owned|financed|leased)$/i.test(vehicleAt(r, i)?.ownership ?? '') ? 'derived' : 'fact'),
      value: (r) => {
        const o = vehicleAt(r, i)?.ownership ?? '';
        if (/^owned$/i.test(o)) return 'Owned';
        if (/^financed$/i.test(o)) return 'Financed';
        if (/^leased$/i.test(o)) return 'Leased';
        return null;
      },
      note: (r) => (/^(owned|financed|leased)$/i.test(vehicleAt(r, i)?.ownership ?? '') ? null : `Vehicle ${row}: ownership is blank on the intake.`),
    },
    {
      concept: 'vehicle.ownership-length', steps: [VEHICLES], field: 'GiveLengthOfOwnership', row,
      name: `Vehicle ${row}: length of ownership`, kind: 'choice', tni: 'geico-pa.ownership-length', ignore: missing,
      source: (r) => geicoOwnershipLength(vehicleAt(r, i)).source,
      value: (r) => geicoOwnershipLength(vehicleAt(r, i)).value,
      note: (r) => geicoOwnershipLength(vehicleAt(r, i)).note,
    },
    {
      concept: 'vehicle.use', steps: [VEHICLES], field: 'GiveVehiclePrimaryUse', row,
      name: `Vehicle ${row}: primary use`, kind: 'choice', ignore: missing,
      source: (r) => (geicoVehicleUse(vehicleAt(r, i)?.use) ? 'derived' : 'fact'),
      value: (r) => geicoVehicleUse(vehicleAt(r, i)?.use),
      note: (r) => (geicoVehicleUse(vehicleAt(r, i)?.use) ? null : `Vehicle ${row} use "${vehicleAt(r, i)?.use ?? 'blank'}": pick the GEICO primary use.`),
    },
    {
      concept: 'vehicle.use', steps: [VEHICLES], field: 'GiveDaysPerWeekCommute', row,
      name: `Vehicle ${row}: commute days per week`, kind: 'choice', ignore: missing,
      source: (r) => (commuteDaysValue(vehicleAt(r, i)) ? 'derived' : 'fact'),
      value: (r) => commuteDaysValue(vehicleAt(r, i)),
      note: (r) => (commuteDaysValue(vehicleAt(r, i)) ? null : `Vehicle ${row}: commute days per week is blank on the intake.`),
    },
    {
      concept: 'vehicle.use', steps: [VEHICLES], field: 'GiveMilesOneWay', row,
      name: `Vehicle ${row}: one-way commute miles`, ignore: missing,
      source: (r) => (commuteMilesValue(vehicleAt(r, i)) ? 'derived' : 'fact'),
      value: (r) => commuteMilesValue(vehicleAt(r, i)),
      note: (r) => (commuteMilesValue(vehicleAt(r, i)) ? null : `Vehicle ${row}: one-way commute miles is blank on the intake.`),
    },
    {
      concept: 'vehicle.business-use-type', steps: [VEHICLES], field: 'GiveTypeOfBusinessUse', row,
      name: `Vehicle ${row}: type of business use`, kind: 'choice', ignore: missing,
      source: 'fact', note: `Vehicle ${row}: select the specific type of business use.`,
    },
    // D9: Replace GEICO's auto-estimated mileage when the intake gives annual miles (adapter orders
    // Primary Use before Annual Mileage); keep GEICO's estimate untouched when blank on the intake.
    {
      concept: 'vehicle.annual-mileage', steps: [VEHICLES], field: 'GiveAnnualMileage', row,
      name: `Vehicle ${row}: estimated annual mileage`, kind: 'choice', replace: true,
      ignore: (r) => missing(r) || vehicleAt(r, i)?.annualMiles == null || vehicleAt(r, i)?.annualMiles === '',
      source: (r) => (geicoAnnualMileageBand(vehicleAt(r, i)?.annualMiles) ? 'derived' : 'fact'),
      value: (r) => geicoAnnualMileageBand(vehicleAt(r, i)?.annualMiles),
      note: (r) => (geicoAnnualMileageBand(vehicleAt(r, i)?.annualMiles) ? null : `Vehicle ${row}: annual mileage "${vehicleAt(r, i)?.annualMiles}" couldn't be mapped to GEICO's 1,000-mile bands.`),
    },
  ];
}

/** @param {number} i @returns {CarrierRule[]} */
function driverColumnRules(i) {
  const row = i + 1;
  const missing = (/** @type {ClientRecord} */ r) => !driverAt(r, i);
  const milGovFlag = (/** @type {ClientRecord} */ r) => MILITARY_GOV_WORDS.test(String(driverAt(r, i)?.occupation ?? '')) || MILITARY_GOV_WORDS.test(notesOf(r));
  return [
    { concept: 'driver.name', steps: [DRIVERS], field: 'GiveFirstName', row, name: `Driver ${row}: first name`, source: 'derived', value: (r) => driverFirstMiddle(driverAt(r, i)).first, ignore: missing },
    { concept: 'driver.name', steps: [DRIVERS], field: 'GiveLastName', row, name: `Driver ${row}: last name`, source: 'derived', value: (r) => driverAt(r, i)?.last ?? null, ignore: missing },
    { concept: 'driver.dob', steps: [DRIVERS], field: 'GiveDateOfBirth', row, name: `Driver ${row}: date of birth`, kind: 'date', source: 'derived', value: (r) => driverAt(r, i)?.dob ?? null, ignore: missing },
    {
      concept: 'driver.gender', steps: [DRIVERS], field: 'GiveGender', row,
      name: `Driver ${row}: gender`, kind: 'choice', ignore: missing,
      source: (r) => (/^(male|female)$/i.test(driverAt(r, i)?.gender ?? '') ? 'derived' : 'fact'),
      value: (r) => (/^male$/i.test(driverAt(r, i)?.gender ?? '') ? 'Male' : /^female$/i.test(driverAt(r, i)?.gender ?? '') ? 'Female' : null),
      note: (r) => (/^(male|female)$/i.test(driverAt(r, i)?.gender ?? '') ? null : `Driver ${row}: confirm gender.`),
    },
    {
      concept: 'driver.marital-status', steps: [DRIVERS], field: 'GiveMaritalStatus', row,
      path: `drivers[${i}].maritalStatus`,
      name: `Driver ${row}: marital status`, kind: 'choice', ignore: missing,
      source: (r) => (driverAt(r, i)?.maritalStatus ? 'derived' : 'fact'),
      value: (r) => driverAt(r, i)?.maritalStatus ?? null,
      note: (r) => (driverAt(r, i)?.maritalStatus ? null : `Driver ${row}: marital status is blank on the intake.`),
    },
    ...(i > 0 ? [/** @type {CarrierRule} */ ({
      concept: 'driver.relationship', steps: [DRIVERS], field: 'GiveRelationshipToInsured', row,
      name: `Driver ${row}: relationship to insured`, kind: 'choice', ignore: missing,
      source: (r) => (driverAt(r, i)?.relation && !/^insured$/i.test(driverAt(r, i)?.relation ?? '') ? 'derived' : 'fact'),
      value: (r) => (driverAt(r, i)?.relation && !/^insured$/i.test(driverAt(r, i)?.relation ?? '') ? driverAt(r, i)?.relation : null),
      note: (r) => (driverAt(r, i)?.relation && !/^insured$/i.test(driverAt(r, i)?.relation ?? '') ? null : `Driver ${row}: confirm relationship to insured.`),
    })] : []),
    {
      concept: 'driver.education', steps: [DRIVERS], field: 'GiveEducationLevel', row,
      name: `Driver ${row}: education level`, kind: 'choice', ignore: missing,
      source: (r) => geicoEducationChoice(driverAt(r, i)?.education).source,
      value: (r) => geicoEducationChoice(driverAt(r, i)?.education).value,
      note: (r) => geicoEducationChoice(driverAt(r, i)?.education).note,
    },
    {
      concept: 'driver.military-gov', steps: [DRIVERS], field: 'GiveGovernmentMilitaryAffiliation', row,
      name: `Driver ${row}: government/military affiliations`, kind: 'choice',
      tni: 'geico-pa.military-gov', ignore: missing,
      source: (r) => (milGovFlag(r) ? 'fact' : 'standard'),
      value: (r) => (milGovFlag(r) ? null : 'Does Not Apply'),
      note: (r) => (milGovFlag(r) ? `Driver ${row}: occupation or notes mention military/government — confirm affiliation.` : null),
    },
    { concept: 'driver.military-gov', steps: [DRIVERS], field: 'GiveMilitaryAffiliation', row, name: `Driver ${row}: military affiliation`, kind: 'choice', ignore: missing, source: 'fact', note: `Driver ${row}: select military affiliation.` },
    { concept: 'driver.military-gov', steps: [DRIVERS], field: 'GiveMilitaryBranch', row, name: `Driver ${row}: military branch`, kind: 'choice', ignore: missing, source: 'fact', note: `Driver ${row}: select military branch.` },
    { concept: 'driver.military-gov', steps: [DRIVERS], field: 'GiveMilitaryGrade', row, name: `Driver ${row}: military grade`, kind: 'choice', ignore: missing, source: 'fact', note: `Driver ${row}: select military grade.` },
    { concept: 'driver.military-gov', steps: [DRIVERS], field: 'GiveActiveOrRetired', row, name: `Driver ${row}: active or retired`, kind: 'choice', ignore: missing, source: 'fact', note: `Driver ${row}: confirm active or retired.` },
    { concept: 'driver.military-gov', steps: [DRIVERS], field: 'GiveGovernmentGrade', row, name: `Driver ${row}: government grade`, kind: 'choice', ignore: missing, source: 'fact', note: `Driver ${row}: select government grade.` },
    {
      concept: 'driver.employment', steps: [DRIVERS], field: 'GiveEmploymentStatus', row,
      name: `Driver ${row}: employment status`, kind: 'choice', ignore: missing,
      source: (r) => geicoEmploymentChoice(driverAt(r, i)?.occupation).source,
      value: (r) => geicoEmploymentChoice(driverAt(r, i)?.occupation).value,
      note: (r) => geicoEmploymentChoice(driverAt(r, i)?.occupation).note,
    },
    {
      concept: 'driver.employment', steps: [DRIVERS], field: 'GiveIndustry', row,
      name: `Driver ${row}: industry`, kind: 'choice', ignore: missing, source: 'fact',
      note: (r) => {
        const occ = driverAt(r, i)?.occupation;
        return occ ? `Driver ${row} occupation is "${occ}": pick the matching GEICO industry.` : `Driver ${row}: select industry.`;
      },
    },
    {
      concept: 'driver.employment', steps: [DRIVERS], field: 'GiveOccupationByIndustry', row,
      name: `Driver ${row}: occupation`, kind: 'choice', ignore: missing, source: 'fact',
      note: (r) => {
        const occ = driverAt(r, i)?.occupation;
        return occ ? `Driver ${row} occupation is "${occ}": pick the matching GEICO occupation.` : `Driver ${row}: select occupation.`;
      },
    },
    { concept: 'driver.employment', steps: [DRIVERS], field: 'YesNoEmployedLastTwelveMonths', row, name: `Driver ${row}: employed within last 12 months?`, kind: 'choice', ignore: missing, source: 'fact', note: `Driver ${row}: confirm employment within the last 12 months.` },
    { concept: 'driver.employment', steps: [DRIVERS], field: 'GiveStudentType', row, name: `Driver ${row}: student type`, kind: 'choice', ignore: missing, source: 'fact', note: `Driver ${row}: select student type.` },
    {
      concept: 'driver.license-status', steps: [DRIVERS], field: 'GiveDriversLicenseStatus', row,
      name: `Driver ${row}: license status`, kind: 'choice',
      tni: 'geico-pa.license-status', ignore: missing,
      source: (r) => (hasValidLicenseNumber(r, i) ? 'standard' : 'fact'),
      value: (r) => (hasValidLicenseNumber(r, i) ? 'Active' : null),
      note: (r) => (hasValidLicenseNumber(r, i) ? null : `Driver ${row}: no license number on intake — confirm license status.`),
    },
    ...(i > 0 ? [
      /** @type {CarrierRule} */ ({
        concept: 'driver.excluded', steps: [DRIVERS], field: 'GiveDriverExclusionInsuredYesNo', row,
        name: `Driver ${row}: insure this person?`, kind: 'choice',
        tni: 'geico-pa.driver-insure', ignore: missing,
        source: (r) => (driverLooksExcluded(r, i) ? 'fact' : 'standard'),
        value: (r) => (driverLooksExcluded(r, i) ? null : 'Yes'),
        note: (r) => (driverLooksExcluded(r, i) ? `Driver ${row}: intake or notes mention excluded — confirm whether to insure.` : null),
      }),
      /** @type {CarrierRule} */ ({
        concept: 'driver.excluded', steps: [DRIVERS], field: 'GiveDriverStatus', row,
        name: `Driver ${row}: reason not insuring`, kind: 'choice', ignore: missing,
        source: 'fact', note: `Driver ${row}: select reason for excluding this driver.`,
      }),
    ] : []),
    {
      concept: 'driver.student-discount', steps: [DRIVERS], field: 'YesNoGoodStudentDiscount', row,
      name: `Driver ${row}: good student`, kind: 'choice',
      tni: 'geico-pa.driver-discounts', ignore: missing,
      source: (r) => (driverAt(r, i)?.goodStudent === true ? 'derived' : 'standard'),
      value: (r) => (driverAt(r, i)?.goodStudent === true ? 'Yes' : 'No'),
    },
    {
      concept: 'driver.student-discount', steps: [DRIVERS], field: 'GiveStudentAway', row,
      name: `Driver ${row}: student away from home`, kind: 'choice',
      tni: 'geico-pa.driver-discounts', ignore: missing,
      source: (r) => (driverAt(r, i)?.distantStudent === true ? 'derived' : 'standard'),
      value: (r) => (driverAt(r, i)?.distantStudent === true ? 'Yes' : 'No'),
    },
    {
      concept: 'driver.defensive-course', steps: [DRIVERS], field: 'YesNoDefensiveDriverCourse', row,
      name: `Driver ${row}: defensive driver course`, kind: 'choice',
      tni: 'geico-pa.driver-discounts', ignore: missing,
      source: (r) => (driverAt(r, i)?.matureCourse === true ? 'derived' : 'standard'),
      value: (r) => (driverAt(r, i)?.matureCourse === true ? 'Yes' : 'No'),
    },
  ];
}

/** @param {number} i @returns {CarrierRule[]} */
function licenseHistoryDriverRules(i) {
  const row = i + 1;
  const missing = (/** @type {ClientRecord} */ r) => !driverAt(r, i);
  return [
    {
      concept: 'driver.license-history', steps: [LICENSE_HISTORY], field: 'SubstantialLicenseHistoryYesNo', row,
      name: `Driver ${row}: substantial U.S. license history`, kind: 'choice', ignore: missing,
      source: (r) => substantialLicenseHistory(driverAt(r, i)).source,
      value: (r) => substantialLicenseHistory(driverAt(r, i)).value,
      note: (r) => substantialLicenseHistory(driverAt(r, i)).note,
    },
    {
      concept: 'driver.license-history', steps: [LICENSE_HISTORY], field: 'GiveAgeFirstLicensed', row,
      name: `Driver ${row}: age first licensed in the U.S.`, ignore: missing,
      tni: 'geico-pa.license-age',
      source: (r) => geicoAgeFirstLicensed(driverAt(r, i)).source,
      value: (r) => geicoAgeFirstLicensed(driverAt(r, i)).value,
      note: (r) => geicoAgeFirstLicensed(driverAt(r, i)).note,
    },
    {
      concept: 'driver.license-history', steps: [LICENSE_HISTORY], field: 'MonthYearAgeFirstLicensed', row,
      name: `Driver ${row}: month/year first licensed in the U.S. (standard: earliest option)`, kind: 'pick-not', ignore: missing,
      source: 'standard', tni: 'geico-pa.license-month',
      value: () => ({ not: '^(?:please select|select)$' }),
    },
  ];
}

/** @returns {CarrierRule[]} */
function groupsRules() {
  const hasGroupNote = (/** @type {ClientRecord} */ r) => GROUP_ORG_NOTES.test(notesOf(r));
  return [
    {
      concept: 'quote.groups-affiliations', steps: [GROUPS], field: 'GiveSponsoredMarketing',
      name: 'Groups or Organizations', kind: 'choice',
      tni: 'geico-pa.groups',
      source: (r) => (hasGroupNote(r) ? 'fact' : 'standard'),
      value: (r) => (hasGroupNote(r) ? null : 'Not a member of any of these organizations'),
      note: (r) => (hasGroupNote(r) ? 'Notes mention an organization or affiliation — confirm Groups or Organizations.' : null),
    },
  ];
}

/** @param {number} i @returns {CarrierRule[]} */
function quoteSummaryVehicleRules(i) {
  const row = i + 1;
  return [
    {
      concept: 'coverage.comp-coll', steps: [QUOTE_SUMMARY], label: '^Comprehensive\\b', row, control: 'select',
      name: `Vehicle ${row}: Comprehensive deductible`, kind: 'choice', replace: true,
      ignore: (r) => geicoVehicleDeductible(r, i, 'compDeductible').ignore,
      source: (r) => geicoVehicleDeductible(r, i, 'compDeductible').source,
      value: (r) => geicoVehicleDeductible(r, i, 'compDeductible').value,
      note: (r) => geicoVehicleDeductible(r, i, 'compDeductible').note,
    },
    {
      concept: 'coverage.comp-coll', steps: [QUOTE_SUMMARY], label: '^Collision\\b', row, control: 'select',
      name: `Vehicle ${row}: Collision deductible`, kind: 'choice', replace: true,
      ignore: (r) => geicoVehicleDeductible(r, i, 'collDeductible').ignore,
      source: (r) => geicoVehicleDeductible(r, i, 'collDeductible').source,
      value: (r) => geicoVehicleDeductible(r, i, 'collDeductible').value,
      note: (r) => geicoVehicleDeductible(r, i, 'collDeductible').note,
    },
    {
      concept: 'coverage.roadside', steps: [QUOTE_SUMMARY], label: '^Emergency Road Service\\b', row, control: 'select',
      name: `Vehicle ${row}: Emergency Road Service (standard: I accept on full-coverage vehicles)`, kind: 'choice',
      replace: true,
      ignore: (r) => !isFullCoverageVehicle(r, i),
      source: 'standard', tni: 'geico-pa.full-coverage-ers',
      value: (r) => (isFullCoverageVehicle(r, i) ? 'I accept this coverage' : null),
      choiceAliases: ['I accept'],
    },
    {
      concept: 'coverage.rental', steps: [QUOTE_SUMMARY], label: '^Rental Reimbursement\\b', row, control: 'select',
      name: `Vehicle ${row}: Rental Reimbursement (standard: $50/day, $1,500 max on full-coverage vehicles)`, kind: 'choice',
      replace: true,
      ignore: (r) => !isFullCoverageVehicle(r, i),
      source: 'standard', tni: 'geico-pa.full-coverage-rental',
      value: (r) => (isFullCoverageVehicle(r, i) ? '$50/day, $1,500 max per claim' : null),
    },
  ];
}

/** @returns {CarrierRule[]} */
function quoteSummaryRules() {
  return [
    {
      concept: 'quote.disclosure', steps: [QUOTE_SUMMARY], field: 'PrimaryHeader',
      name: 'Customer advised acknowledgement (standard: checked)', kind: 'bool',
      source: 'standard', tni: 'geico-pa.acknowledgements', value: () => true,
    },
    {
      concept: 'coverage.liability', steps: [QUOTE_SUMMARY], label: '^Bodily Injury Liability\\b', control: 'select',
      name: 'Bodily Injury Liability (BI)', replace: true,
      kind: (r) => (parseSplitLiability(r?.coverage?.liabilityLimit).kind === 'state-min' ? 'pick-not' : 'choice'),
      source: (r) => {
        const k = parseSplitLiability(r?.coverage?.liabilityLimit).kind;
        return k === 'split' || k === 'state-min' ? 'derived' : 'fact';
      },
      value: (r) => {
        const parsed = parseSplitLiability(r?.coverage?.liabilityLimit);
        if (parsed.kind === 'split') return parsed.bi;
        if (parsed.kind === 'state-min') return { not: '^(?:please select|select|i decline|none)$' };
        return null;
      },
      note: (r) => {
        const raw = r?.coverage?.liabilityLimit;
        const k = parseSplitLiability(raw).kind;
        if (k === 'split' || k === 'state-min') return null;
        return raw ? `Liability limit "${raw}" isn't a split limit offered by GEICO PA — select Bodily Injury Liability.` : 'Requested liability limit is blank on the intake.';
      },
    },
    {
      concept: 'coverage.liability', steps: [QUOTE_SUMMARY], label: '^Property Damage Liability\\b', control: 'select',
      name: 'Property Damage Liability (PD)', replace: true,
      kind: (r) => (parseSplitLiability(r?.coverage?.liabilityLimit).kind === 'state-min' ? 'pick-not' : 'choice'),
      source: (r) => {
        const k = parseSplitLiability(r?.coverage?.liabilityLimit).kind;
        return k === 'split' || k === 'state-min' ? 'derived' : 'fact';
      },
      value: (r) => {
        const parsed = parseSplitLiability(r?.coverage?.liabilityLimit);
        if (parsed.kind === 'split') return parsed.pd;
        if (parsed.kind === 'state-min') return { not: '^(?:please select|select|i decline|none)$' };
        return null;
      },
      note: (r) => {
        const raw = r?.coverage?.liabilityLimit;
        const k = parseSplitLiability(raw).kind;
        if (k === 'split' || k === 'state-min') return null;
        return raw ? `Liability limit "${raw}" isn't a split limit offered by GEICO PA — select Property Damage Liability.` : 'Requested liability limit is blank on the intake.';
      },
    },
    { concept: 'coverage.medpay', steps: [QUOTE_SUMMARY], label: '^Medical Payments\\b', control: 'select', name: 'Medical Payments (keep GEICO default)', ignore: true },
    // A1: Lower UMBI/UMPD to match BI/PD only when GEICO's current limit strictly exceeds the
    // requested BI/PD (replace: 'lower' never raises UMBI/UMPD and never turns "I decline" into coverage).
    {
      concept: 'coverage.um', steps: [QUOTE_SUMMARY], label: '^Uninsured Motorist Bodily Injury\\b', control: 'select',
      name: 'Uninsured Motorist Bodily Injury (lower to match BI when higher)',
      replace: 'lower',
      kind: (r) => (parseSplitLiability(r?.coverage?.liabilityLimit).kind === 'state-min' ? 'pick-not' : 'choice'),
      ignore: (r) => {
        const k = parseSplitLiability(r?.coverage?.liabilityLimit).kind;
        return k !== 'split' && k !== 'state-min';
      },
      source: 'derived',
      value: (r) => {
        const parsed = parseSplitLiability(r?.coverage?.liabilityLimit);
        if (parsed.kind === 'split') return parsed.bi;
        if (parsed.kind === 'state-min') return { not: '^(?:please select|select|i decline|none)$' };
        return null;
      },
    },
    {
      concept: 'coverage.umpd', steps: [QUOTE_SUMMARY], label: '^Uninsured Motorist Property Damage\\b', control: 'select',
      name: 'Uninsured Motorist Property Damage (lower to match PD when higher)',
      replace: 'lower',
      kind: (r) => (parseSplitLiability(r?.coverage?.liabilityLimit).kind === 'state-min' ? 'pick-not' : 'choice'),
      ignore: (r) => {
        const k = parseSplitLiability(r?.coverage?.liabilityLimit).kind;
        return k !== 'split' && k !== 'state-min';
      },
      source: 'derived',
      value: (r) => {
        const parsed = parseSplitLiability(r?.coverage?.liabilityLimit);
        if (parsed.kind === 'split') return parsed.pd;
        if (parsed.kind === 'state-min') return { not: '^(?:please select|select|i decline|none)$' };
        return null;
      },
    },
    {
      concept: 'coverage.policy-addons', steps: [QUOTE_SUMMARY], label: '^Purchased Claim Forgiveness\\b', control: 'select',
      name: 'Purchased Claim Forgiveness (standard: I decline)', kind: 'choice',
      source: 'standard', tni: 'geico-pa.claim-forgiveness', replace: true, value: () => 'I decline',
    },
    ...Array.from({ length: MAX_VEHICLES }, (_, i) => quoteSummaryVehicleRules(i)).flat(),
  ];
}

/** @returns {CarrierAction[]} */
function geicoPaActions() {
  return [
    // Vehicle Information: add extra vehicle columns sequentially (column 1 is row-header; vehicle k is td:nth-of-type(k+1)).
    ...Array.from({ length: MAX_VEHICLES - 1 }, (_, k) => {
      const idx = k + 1;
      const col = idx + 2;
      /** @type {CarrierAction} */
      return {
        id: `addVehicle${idx + 1}`,
        steps: [VEHICLES],
        text: '^add vehicle$',
        immediate: true,
        afterActions: idx > 1 ? [`addVehicle${idx}`] : [],
        when: (r) => (r?.vehicles?.length ?? 0) > idx,
        unlessSelector: `.ssp-grid table.table thead tr td:nth-of-type(${col})`,
        label: `Add vehicle ${idx + 1}`,
        missing: `Click "Add Vehicle" so vehicle ${idx + 1} can be filled.`,
        verify: { appears: `.ssp-grid table.table thead tr td:nth-of-type(${col})` },
      };
    }),
    // Driver Information: wait for Driver 1's Marital Status before clicking Add Driver for Driver 2,
    // because Married auto-spawns the Spouse column (td:nth-of-type(3)) without clicking Add Driver.
    // Deliberately NOT `immediate: true`: an `immediate` action whose `unlessSelector` is already
    // satisfied (revisiting a 2+ column grid) would add its `after` path (`drivers[0].maritalStatus`)
    // to `consumedPaths()` before the field loop, skipping a blank Marital Status on Driver 1.
    ...Array.from({ length: MAX_DRIVERS - 1 }, (_, k) => {
      const idx = k + 1;
      const col = idx + 2;
      /** @type {CarrierAction} */
      return {
        id: `addDriver${idx + 1}`,
        steps: [DRIVERS],
        text: '^add driver$',
        after: idx === 1 ? ['drivers[0].maritalStatus'] : [],
        afterActions: idx > 1 ? [`addDriver${idx}`] : [],
        when: (r) => orderedDrivers(r).length > idx,
        unlessSelector: `.ssp-grid table.table thead tr td:nth-of-type(${col})`,
        label: `Add driver ${idx + 1}`,
        missing: `Click "Add Driver" so driver ${idx + 1} can be filled.`,
        verify: { appears: `.ssp-grid table.table thead tr td:nth-of-type(${col})` },
      };
    }),
    // Select Drivers with Incidents: remind the agent when intake notes mention incidents/violations (D5).
    {
      id: 'incidentsReview',
      steps: [INCIDENTS],
      label: 'Review incidents',
      markable: true,
      onBlankPage: true,
      when: (r) => INCIDENT_NOTES.test(notesOf(r)),
      missing: 'Intake notes mention an accident, ticket, violation, DUI, or suspension — review and add incidents if applicable before clicking Next.',
    },
    // Quote Summary: expand coverages once (Edit), recalculate when clear, then open Print Quote Proposal (/PrintQuote).
    {
      id: 'editCoverages',
      steps: [QUOTE_SUMMARY],
      text: '^edit$',
      immediate: true,
      once: true,
      unlessSelector: '.coverage-form-field-wrapper select',
      verify: 'revealed',
      label: 'Edit coverages',
    },
    {
      id: 'recalculate',
      steps: [QUOTE_SUMMARY],
      text: '^recalculate$',
      within: 'gds-sticky-bar',
      whenClear: true,
      once: true,
      needsRecalculation: true,
      quietMs: 2000,
      keepAnswers: true,
      reopen: '^edit$',
      verify: 'premium',
      label: 'Recalculate',
    },
    {
      id: 'printProposal',
      steps: [QUOTE_SUMMARY],
      text: '^print quote proposal$',
      whenClear: true,
      once: true,
      kitClick: true,
      needsPremium: true,
      verify: 'download',
      label: 'Print Quote Proposal',
    },
  ];
}

/** @type {CarrierConfig} */
export const geicoPa = {
  id: 'geico-pa',
  name: 'GEICO Personal Auto',
  product: 'personal-auto',
  hosts: [/(^|\.)geico\.com$/],
  world: 'MAIN',
  pressInPage: true,
  pageAdapter: 'src/content/carriers/geico-pa.js',
  autoFillUrl: FILLED,
  fillOnDraw: GATEWAY,
  layoutUrl: /^https?:\/\/[^/]+\/quote(?:[/?#]|$)/i,
  layoutSteps: [
    POLICYHOLDER,
    PREFILL,
    CURRENT_INS,
    VEHICLES,
    DRIVERS,
    LICENSE_HISTORY,
    INCIDENTS,
    GROUPS,
    QUOTE_SUMMARY,
    'Vehicle Details',
    'Driver Details',
    'Communication Options',
    'Payment Plan',
    'Payment Type',
  ],
  quoteSteps: [
    { name: 'Policyholder', step: POLICYHOLDER },
    { name: 'Current Insurance', step: CURRENT_INS },
    { name: 'Vehicles', step: VEHICLES },
    { name: 'Drivers', step: DRIVERS },
    { name: 'License History', step: LICENSE_HISTORY },
    { name: 'Incidents', step: INCIDENTS },
    { name: 'Groups', step: GROUPS },
    { name: 'Quote Summary', step: QUOTE_SUMMARY },
  ],
  premiumPages: [QUOTE_SUMMARY],
  // Auto-advance across clear pre-quote steps (`Next` / `Save and Continue`), including Vehicle
  // Prefill once "Quote a different vehicle" is selected. Never on gateway2.geico.com, Quote
  // Summary (stops here with Print Quote Proposal), or any Finalize / Payment stopStep.
  advance: {
    text: '^(next|save and continue)$',
    steps: [POLICYHOLDER, PREFILL, CURRENT_INS, VEHICLES, DRIVERS, LICENSE_HISTORY, INCIDENTS, GROUPS],
  },
  newQuestionsOnlySteps: [QUOTE_SUMMARY],
  continueRetry: false,
  keepTakenBack: [QUOTE_SUMMARY],
  finishedBy: 'printProposal',
  finishedSaid: 'Print Quote Proposal was clicked',
  stopSteps: {
    'Vehicle Details': STOP_NOTE,
    'Driver Details': STOP_NOTE,
    'Communication Options': STOP_NOTE,
    'Payment Plan': STOP_NOTE,
    'Payment Type': STOP_NOTE,
  },
  display: {
    logo: 'assets/raters/geico.gif',
    portalUrl: 'https://gateway2.geico.com/',
    product: 'Personal auto',
    classesSaid: 'personal auto quotes',
  },
  rules: [
    ...gatewayRules(),
    ...policyholderRules(),
    ...currentInsuranceRules(),
    ...Array.from({ length: MAX_VEHICLES }, (_, i) => vehicleColumnRules(i)).flat(),
    ...Array.from({ length: MAX_DRIVERS }, (_, i) => driverColumnRules(i)).flat(),
    {
      concept: 'quote.all-drivers', steps: [DRIVERS], field: 'GiveAllDriversAcknowledgement.Yes',
      name: 'All drivers disclosure acknowledgement (standard: checked)', kind: 'bool',
      source: 'standard', tni: 'geico-pa.acknowledgements', value: () => true,
    },
    ...Array.from({ length: MAX_DRIVERS }, (_, i) => licenseHistoryDriverRules(i)).flat(),
    ...groupsRules(),
    ...quoteSummaryRules(),
  ],
  actions: geicoPaActions(),
  useGenericRules: false,
};
