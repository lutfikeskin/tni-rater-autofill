export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Paths look like "applicant.dot" or "drivers[0].first".
function splitPath(path) {
  return path.split('.').flatMap((part) => {
    const m = part.match(/^(\w+)\[(\d+)\]$/);
    return m ? [m[1], Number(m[2])] : [part];
  });
}

export function get(obj, path) {
  let cur = obj;
  for (const key of splitPath(path)) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function set(obj, path, value) {
  const keys = splitPath(path);
  let cur = obj;
  keys.slice(0, -1).forEach((key, i) => {
    if (cur[key] == null) cur[key] = typeof keys[i + 1] === 'number' ? [] : {};
    cur = cur[key];
  });
  cur[keys.at(-1)] = value;
}

// "drivers[].first" -> "drivers"
export function listOf(path) {
  const m = path.match(/^(\w+)\[\]/);
  return m ? m[1] : null;
}

// "No", "NO POP" (no proof of prior), "None", "No prior", "N/A" as the carrier, without an
// expiration date: the client has no current insurance, whatever type or limit the form shows
// (TNI, 2026-10-09). The policy stays on the record so the panel shows what the intake said,
// but nothing is filled or disclosed from it.
export function noPriorInsurance(policy) {
  return !!policy && /^(no|none|n\/?a)\b/i.test(String(policy.carrier ?? '').trim()) && !policy.expiration;
}

// The names a carrier being quoted goes by as an intake's current carrier (sameCarrier): one word
// matched with spelling slips, or words all present. AmWINS, a wholesaler, has none: the client's
// current carrier is the insurer, never AmWINS.
const CARRIER_NAMES = {
  geico: { name: 'GEICO', word: 'geico', words: [['government', 'employees']] },
  progressive: { name: 'Progressive', word: 'progressive' },
};

// Edits between two words (insert, delete, substitute, or swap two neighbours: "gieco").
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// The intake's current carrier (`name`, priorInsurance[0].carrier) is the carrier being quoted
// (`carrierId`), as written or misspelled (TNI, 2026-10-26, W44-06, W44-27): a word of the name is
// the carrier's word, starts with it ("GeicoCommercial"), or is one slip from it, two for a word
// of eight letters or more ("GICO", "Gieco", "Progresive"); suffixes don't matter ("Geico
// Commercial", "GEICO Ins.", "Progressive Casualty": Progressive's own insurers all carry its
// name). Another insurer with a similar name is further than that ("Gainsco", "Gateway", "GAIC",
// "Protective"). A carrier with no names (AmWINS, the test page) is never one.
export function sameCarrier(name, carrierId) {
  const names = Object.hasOwn(CARRIER_NAMES, carrierId ?? '') ? CARRIER_NAMES[carrierId] : null;
  if (!names) return false;
  const words = nameWords(name);
  const { word } = names;
  const slips = word.length >= 8 ? 2 : 1;
  return words.some((w) => w.startsWith(word) || editDistance(w, word) <= slips)
    || (names.words ?? []).some((all) => all.every((w) => words.includes(w)));
}

// The intake's current policy is one the carrier being quoted may decline or route (W44-27): with
// that carrier (sameCarrier), not no prior insurance, and a commercial auto policy (TNI, 2026-10-26:
// answer to PR question 18: a personal auto, GL-only, cargo or other policy with it is not). A policy
// of no type is said too: it is only a warning, and the carrier's own question for it is the agent's
// (untypedCarrierPolicy). Expired or undated, it is said, as before. The side panel's red card on the
// carrier's pages and the intake check (prior.carrier-is-quoted, normalize.js) both read it.
export function quotedCarrierPolicy(policy, carrierId) {
  if (!policy || noPriorInsurance(policy) || !sameCarrier(policy.carrier, carrierId)) return false;
  const type = String(policy.type ?? '').trim();
  return !type || /commercial\s+auto/i.test(type);
}

// The intake's current policy is with the carrier being quoted (quotedCarrierPolicy) but its policy
// type is left blank. The carrier's own question (GEICO's current GEICO commercial auto policy,
// Progressive's "insured with Progressive Commercial Auto") is then the agent's on both carriers, a
// `fact` with a note that the type isn't on the intake, dated, undated or expired (TNI, 2026-10-26:
// answer to PR question R9). Progressive used to answer No; GEICO already left it to the agent.
// Progressive answers an expired one No again, as any expired policy (TNI, 2026-10-26: answer to PR
// question T10: priorPolicyCurrent, in progressive.js); GEICO's expired policies stay the agent's.
export function untypedCarrierPolicy(policy, carrierId) {
  return quotedCarrierPolicy(policy, carrierId) && !String(policy?.type ?? '').trim();
}

// The carriers the panel quotes that the intake's current policy is with (quotedCarrierPolicy), by
// name, for the intake check: an intake isn't tied to one carrier.
export function quotedCarriersOf(policy) {
  return Object.entries(CARRIER_NAMES).filter(([id]) => quotedCarrierPolicy(policy, id)).map(([, c]) => c.name);
}

// The intake's current policy is current, a usable expiration date or not (TNI, 2026-10-26: answer
// to PR question 9, by W44-29's reading of proof of prior insurance): any of its type, carrier,
// limit or expiration boxes filled, not no prior insurance, and no expiration date already passed
// (a blank date, or a remark in the date box, passes nothing). GEICO's current GEICO policy and
// Progressive's "insured with Progressive Commercial Auto" read it for a commercial auto policy with
// themselves. PR #194's priorInsuranceAssumed states W44-29 for every policy (and leaves out a
// GL, cargo or other one): the two become one helper once both are merged.
export function priorPolicyCurrent(record, policy = record?.priorInsurance?.[0]) {
  const filled = (v) => v != null && String(v).trim() !== '';
  if (!policy || noPriorInsurance(policy) || !['type', 'carrier', 'limit', 'expiration'].some((k) => filled(policy[k]))) return false;
  return !priorPolicyExpired(record, policy);
}

// Compare calendar dates using the application date, so an archived intake stays reproducible.
// An absent/invalid date does not establish that a policy expired.
export function priorPolicyExpired(record, policy = record.priorInsurance?.[0]) {
  const parse = (value) => {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? '');
    if (!m) return null;
    const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    return d.getUTCFullYear() === +m[3] && d.getUTCMonth() === +m[1] - 1 && d.getUTCDate() === +m[2] ? +d : null;
  };
  const expiry = parse(policy?.expiration);
  const now = new Date();
  const reference = parse(record.applicant?.applicationDate) ?? Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return expiry != null && expiry < reference;
}

// A person's name as lowercase words without accents ("Campelo Kraychete" -> ["campelo", "kraychete"]).
export function nameWords(name) {
  return String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}+/gu) ?? [];
}

// The intake's owner name is this driver: the same words across the name boxes (the suffix
// too: "SAMPLE EXAMPLO JR"), or the owner's last word is the driver's surname or one of its words
// (two-word surnames: "CAMPELO KRAYCHETE") and the owner's first name is one of the driver's given
// names. A surname alone is a family, not a person: owner "Alice Sample" is not driver "Bob
// Sample" (nor "Bob Jones Sample").
export function ownerIsDriver(ownerName, d) {
  const owner = nameWords(ownerName);
  if (!owner.length || !d) return false;
  const driver = nameWords(`${d.first ?? ''} ${d.middle ?? ''} ${d.last ?? ''} ${d.suffix ?? ''}`);
  if (owner.length === driver.length && [...owner].sort().join(' ') === [...driver].sort().join(' ')) return true;
  return nameWords(d.last).includes(owner.at(-1)) && nameWords(`${d.first ?? ''} ${d.middle ?? ''}`).includes(owner[0]);
}

// A company-name box saying there is no company ("NO", "N/A", "N.A.", "None.", "No company"): the
// owner is a sole proprietor (TNI, 2026-10-20). Only for that box: "NO" elsewhere is an answer.
const NO_COMPANY = /^(?:no(?:ne)?|n\s*[\/.]?\s*a\.?|nil|null|unknown|not applicable|no (?:company|business|name)(?: name)?|-+|\.+)\.?$/i;

// The company name, or null when the box is blank or says there is none. Read again at quote time,
// so a name the agent edits is held to the same rule as the PDF's.
export function companyName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  return !s || NO_COMPANY.test(s) ? null : s;
}

// The business structure from the company name (TNI, 2026-10-20), shared by the carriers:
// - no company: 'sole' (a sole proprietor);
// - the last word decides: LLC ('llc'), or Inc / Incorporated / Corp / Corporation / Company / Co
//   ('corp');
// - LLC only inside the name ("SAMPLE LLC DBA EXAMPLE"): 'llc', with `mid` set so the carrier
//   warns;
// - anything else ("Express Freight"): null, the agent's. Partnerships are never guessed.
export function companyStructure(name) {
  const company = companyName(name);
  if (!company) return { structure: 'sole', mid: false };
  const words = company.toLowerCase().replace(/\./g, '').match(/[a-z0-9]+/g) ?? [];
  const last = words.at(-1);
  if (last === 'llc') return { structure: 'llc', mid: false };
  if (['inc', 'incorporated', 'corp', 'corporation', 'company', 'co'].includes(last)) return { structure: 'corp', mid: false };
  if (words.includes('llc')) return { structure: 'llc', mid: true };
  return { structure: null, mid: false };
}

// The warning and note the carriers give with companyStructure.
export const companyStructureWarn = (name) => (companyStructure(name).mid
  ? `The company name "${companyName(name)}" has LLC inside it, not at the end: confirm it is an LLC.` : null);
export const companyStructureNote = (name) => (companyStructure(name).structure == null
  ? `The company name "${companyName(name)}" doesn't end in LLC, Inc or Corp, so its structure isn't known: answer it yourself.` : null);
