// @ts-check
// Client-data redaction shared by the usage log (src/usage.js redactor) and the fill engine's page
// capture (src/kit/capture.js). One word (a name word such as "Ann", or a city) is replaced only
// as a whole word, so "Ann" leaves "Annual" and "Car" leaves "Cargo" alone; any other term (a full
// name, date of birth, phone, VIN, street) is replaced wherever it appears exactly as written.
// Non-intake 17-character VINs and US street addresses are also scrubbed by pattern, and controls
// whose labels or options carry dynamic client lists are scrubbed by control identity (W49-03).
// No imports: the fill engine builds it in.

const ONE_WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u;

// A 17-character VIN (ISO 3779 alphabet, excluding I/O/Q), requiring at least one letter and one
// digit so 17-letter prose words ("misrepresentation") and 17-digit numbers stay intact.
const VIN_LIKE = /(?<![A-Za-z0-9])(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])/gi;

// Carrier radio options that prefix an address with "(USDOT Address)" etc.
const TAGGED_ADDRESS = /^.+?(?=\((?:USDOT|Primary Business|Mailing|Garaging) Address\))/i;

// GEICO's USDOT verification legend embeds the FMCSA business name and address before the question.
const USDOT_VERIFY_RECORD = /\bUSDOT Information\b[\s\S]+?(?=Is this the customer['’]?s business\??)/i;

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const CITY_STATE_ZIP = String.raw`[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2},?\s+(?:${US_STATES}),?\s+\d{5}(?:-\d{4})?\b`;
const UNIT_PART = String.raw`(?:(?:apartment|apt|suite|ste|unit|building|bldg|floor|fl|room|rm|lot)\.?\s*#?\s*[\w-]*\d[\w-]*|(?:apartment|apt|suite|ste|unit)\.?\s+[A-Za-z]\b|#\s*[\w-]+)`;
const STREET_WORD = String.raw`(?:[A-Za-z][A-Za-z.'-]*|\d+(?:st|nd|rd|th))`;
const NOT_QTY = String.raw`(?!(?:hours?|hrs?|days?|weeks?|months?|years?|yrs?|miles?|mi|lbs?|tons?|axles?|wheels?|passengers?|seats?|cylinders?|doors?|ft|feet|inches?|in|pct|percent|dollars?|million|thousand|hundred|to|or|and|of|per|for|more|less|than|up|over|under)\b)`;
const CORE_STREET_TYPE = String.raw`(?:street|st|avenue|ave|road(?!\s+(?:service|assist))|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl|circle|cir|parkway|pkwy|(?:highway|hwy)(?:\s+\d+[A-Za-z]?)?|terrace|ter|pike|expressway|expy|freeway|fwy|turnpike|tpke)`;
const AMBIG_STREET_TYPE = String.raw`(?:way|trail|trl|loop|pass|square|sq|run|path|row|point|pt|crossing|xing|cove|cv|route|rte|alley|aly)`;
const STREET_END = String.raw`(?:(?:\.(?![A-Za-z])|\b)(?:[,\s]+(?:N|S|E|W|NE|NW|SE|SW)\b)?(?:[,\s]+${UNIT_PART})?(?:[,\s]+${CITY_STATE_ZIP})?)`;
const STREET_END_REQUIRED = String.raw`(?:(?:\.(?![A-Za-z])|\b)(?:[,\s]+(?:N|S|E|W|NE|NW|SE|SW)\b)?(?:[,\s]+${UNIT_PART}(?:[,\s]+${CITY_STATE_ZIP})?|[,\s]+${CITY_STATE_ZIP}))`;

// US street addresses (core street types standalone; ambiguous words like "Way"/"Trail" only when
// followed by a unit or city/state/ZIP so vehicle names like "2020 Load Trail" stay intact).
const STREET_ADDRESS = new RegExp(
  String.raw`(?<![A-Za-z0-9$,/.-])\d{1,6}(?:-\d{1,4})?[A-Za-z]?\s+${NOT_QTY}(?:${STREET_WORD}\s+){1,4}(?:${CORE_STREET_TYPE}${STREET_END}|${AMBIG_STREET_TYPE}${STREET_END_REQUIRED})`,
  'gi',
);
const PO_BOX = new RegExp(String.raw`\bP\.?\s*O\.?\s*Box\s+\d+[A-Za-z0-9-]*(?:,\s*${CITY_STATE_ZIP})?`, 'gi');
const STANDALONE_CITY_STATE_ZIP = new RegExp(String.raw`(?<![A-Za-z0-9$])\b[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2},\s*(?:${US_STATES}),?\s+\d{5}(?:-\d{4})?\b`, 'gi');

// Dynamic client-list controls whose options/picks name clients, owners, or other agency accounts.
const PRIVATE_OPTIONS_CONTROL = /(?:^|[:_.#])(?:GiveRegisteredOwner|product-copy)(?=$|[_@#\s])/i;
const USDOT_VERIFY_CONTROL = /(?:^|[:_.])GiveExtendUsDotVerifyBusinessAddress(?=$|[_@#\s])/i;
const DRIVER_LICENSE_CONTROL = /(?:^|[:_.])GiveDriverLicenseNumber(?=$|[_@#\s])/i;
const PRODUCT_COPY_CONTROL = /(?:^|[:#.])product-copy(?=$|[@#\s])/i;

/** @param {string} term */
export function redactionPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ONE_WORD.test(term) ? new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'giu') : new RegExp(escaped, 'gi');
}

/**
 * Scrubs non-intake 17-character VINs, carrier-tagged addresses, USDOT verification records, and
 * US street addresses/PO boxes from labels, options and other log prose.
 * @param {string} s
 * @returns {string}
 */
export function scrubPatterns(s) {
  return s
    .replace(TAGGED_ADDRESS, '[client] ')
    .replace(USDOT_VERIFY_RECORD, 'USDOT Information [client] ')
    .replace(VIN_LIKE, '[client]')
    .replace(PO_BOX, '[client]')
    .replace(STREET_ADDRESS, '[client]')
    .replace(STANDALONE_CITY_STATE_ZIP, '[client]');
}

/**
 * @param {string | { key?: string | null, ref?: string | null, id?: string | null, name?: string | null, el?: { id?: string | null, name?: string | null } } | null | undefined} target
 * @returns {string}
 */
function controlTokens(target) {
  if (!target) return '';
  if (typeof target === 'string') return target;
  return [target.key, target.ref, target.id, target.name, target.el?.id, target.el?.name].filter(Boolean).join(' ');
}

/**
 * True when a control's options/values list client/owner names or other agency clients and must
 * not be logged as choice text (GEICO GiveRegisteredOwner, AmWINS product-copy).
 * @param {string | { key?: string | null, ref?: string | null, id?: string | null, name?: string | null, el?: { id?: string | null, name?: string | null } } | null | undefined} target
 * @returns {boolean}
 */
export function hasPrivateOptions(target) {
  return PRIVATE_OPTIONS_CONTROL.test(controlTokens(target));
}

/**
 * Strips dynamic client names/addresses embedded in labels of specific controls (GEICO USDOT
 * verification, GEICO driver license number, AmWINS product-copy) while preserving generic wording.
 * @param {string | null | undefined} label
 * @param {string | { key?: string | null, ref?: string | null, id?: string | null, name?: string | null, el?: { id?: string | null, name?: string | null } } | null | undefined} target
 * @returns {string | null | undefined}
 */
export function sanitizeFieldLabel(label, target) {
  if (label == null) return label;
  const clean = String(label).trim();
  if (!clean) return label;
  const tokens = controlTokens(target);
  if (USDOT_VERIFY_CONTROL.test(tokens)) {
    if (/^(?:USDOT Information\s+)?Is this the customer['’]?s business\??$/i.test(clean)) return clean;
    return "USDOT Information [client] Is this the customer's business?";
  }
  if (DRIVER_LICENSE_CONTROL.test(tokens)) {
    if (/^(?:driver['’]?s?\s+)?licen[cs]e\s+number$/i.test(clean)) return clean;
    if (/\S['’]s\s+(?:driver['’]?s?\s+)?licen[cs]e\s+number\b/i.test(clean)) {
      return clean.replace(/^.+?['’]s\s+/i, "[client]'s ");
    }
    return "Driver's License Number";
  }
  if (PRODUCT_COPY_CONTROL.test(tokens)) return 'Product';
  return label;
}
