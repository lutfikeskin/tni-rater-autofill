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

// The driver rows the owner's name matches (ownerIsDriver), and how many of them the intake marks
// excluded ("Excluded" in the license-number box, normalize.js licenseBox: `drivers[].excluded`).
const ownerRows = (r) => {
  const rows = (r?.drivers ?? []).filter((d) => ownerIsDriver(r?.applicant?.owner1, d));
  return { rows: rows.length, excluded: rows.filter((d) => d?.excluded === true).length };
};

// The intake marks the owner's driver row excluded: every driver row the owner's name matches is
// marked so. No row matching the owner is no exclusion.
export function ownerExcluded(r) {
  const { rows, excluded } = ownerRows(r);
  return rows > 0 && excluded === rows;
}

// The owner's name matches two or more driver rows (a Sr and a Jr) and only some of them are marked
// excluded: which row is the owner, and so whether the owner drives, isn't on the intake. TNI,
// 2026-10-26 (answer to PR question): the agent's, with the reason (ownerDrivesNote); none of them
// excluded keeps the standard Yes, all of them excluded the No (ownerExcluded).
export function ownerRowsMixed(r) {
  const { rows, excluded } = ownerRows(r);
  return excluded > 0 && excluded < rows;
}

// Whether the owner is a driver on the policy, wherever a carrier asks it (GEICO's Business & Owner
// Info and Add Driver, Progressive's Business Owner Info; AmWINS doesn't ask). TNI, 2026-10-26
// (W44-25): "Owner Drivers if not excluded, in every case". The intake's No stays No; an owner
// whose driver row the intake marks excluded is not a driver, No, also over the intake's Yes, with a
// warning the agent confirms (ownerDrivesWarn; TNI, 2026-10-26: answer to PR question); otherwise
// Yes: the intake's, or TNI's standard for a blank box. null (the agent's) when the owner's name
// matches several driver rows and only some are excluded (ownerRowsMixed). The record keeps the box
// as read (null when blank), so the answer's source stays right (ownerDrivesSource).
/** @returns {boolean | null} */
export function ownerDrives(r) {
  if (r?.applicant?.ownerDrives === false) return false;
  if (ownerRowsMixed(r)) return null;
  return !ownerExcluded(r);
}

// Where ownerDrives' answer comes from (plan.js `source`): the intake's box when it answers and the
// answer stands; the agent's (`fact`) when the owner's rows are only partly excluded; the exclusion
// when it makes the owner not a driver over a blank box or a Yes (`derived`); TNI's standard for a
// blank box.
export function ownerDrivesSource(r) {
  const said = r?.applicant?.ownerDrives;
  if (said === false) return 'intake';
  if (ownerRowsMixed(r)) return 'fact';
  if (ownerExcluded(r)) return 'derived';
  return said === true ? 'intake' : 'standard';
}

// Why ownerDrives leaves the question to the agent: the owner's name on several driver rows, only
// some excluded (TNI, 2026-10-26: answer to PR question).
export function ownerDrivesNote(r) {
  if (r?.applicant?.ownerDrives === false || !ownerRowsMixed(r)) return null;
  const { rows, excluded } = ownerRows(r);
  return `The owner's name matches ${rows} of the intake's drivers and only ${excluded} of them ${excluded === 1 ? 'is' : 'are'} marked excluded, so the intake doesn't show whether the owner drives: answer it yourself.`;
}

// The intake says the owner drives but marks their driver row excluded: ownerDrives is No, and the
// agent confirms it.
export function ownerDrivesWarn(r) {
  return r?.applicant?.ownerDrives === true && ownerExcluded(r)
    ? 'The intake says the owner drives, but marks their driver row excluded: answered No (TNI: an excluded owner isn\'t a driver). Confirm it with the client.' : null;
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
