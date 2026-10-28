// normalize.js imports this module too: both only call each other's functions, never at load.
import { toMoney, otherNotes } from './normalize.js';

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

// A cargo limit with no deductible on the intake: the deductible is the client's, so on every
// carrier the cargo limit and deductible are the agent's, told what it usually is (TNI, 2026-10-27;
// before, Progressive and AmWINS took $1,000).
export const noCargoDeductible = (record) => !!record.coverage?.cargoLimit && record.coverage?.cargoDeductible == null;
// General freight is Consumer Goods, and Other Consumer Goods where a carrier asks which, on every
// carrier (TNI). Misspelled ("General Fright", "Frieght", "freigt") or cut ("Gen. Freight") too
// (TNI, 2026-10-27: a live intake's "General Fright" was left to the agent).
export const GENERAL_FREIGHT = /\bgen(?:eral|\.)?\s*f[re]{1,3}[ie]{0,2}g?h?t\b/i;
// What they haul names general freight, or, left blank, the business class does.
export const haulsGeneralFreight = (record) => GENERAL_FREIGHT.test(String(record.operations?.whatHaul ?? '').trim() || String(record.operations?.businessClass ?? ''));
export const CARGO_DEDUCTIBLE_NOTE = 'The intake gives a cargo limit but no deductible: choose the cargo limit and deductible yourself (the deductible is usually $1,000 or $2,500).';

// General liability the intake asks for (Requested coverage: coverage.gl, never coverage.hasGl, GL
// the client already has), on every carrier. GL added on a quote whose intake doesn't ask for it:
// its questions are the agent's.
export const glRequested = (record) => record?.coverage?.gl === true;
export const glUnrequested = (record) => (glRequested(record) ? null : 'The intake doesn\'t ask for general liability: answer its questions yourself.');
// GL's trucking questions (TNI, general.gl: set on Progressive 2026-10-20, for GEICO too 2026-10-28,
// after an FL run where the agent answered GEICO's by hand), for a for-hire trucker with nothing else
// on the intake: all income from for-hire trucking Yes; a warehouse or premises customers visit,
// set-up or installation, and other businesses No; oil and gas No unless what they haul or the notes
// mention oil or gas fields, fracking or the like, then the agent's. Without the request each is the
// agent's (a fact, never Luna's). Carriers spread one into a rule: `glAnswer(true)`, `GL_OIL_GAS`.
export const glAnswer = (answer) => ({ tni: 'general.gl', source: (record) => (glRequested(record) ? 'standard' : 'fact'), value: () => answer, note: glUnrequested });
const OIL_GAS = /\b(?:oil ?field|oil and gas|oil & gas|oil\/gas|frac(?:k|king)?|fracing|crude|drilling|(?:oil|drilling) rig|pipe ?line|well ?site)s?\b/i;
const oilGasMention = (record) => [record?.operations?.whatHaul, otherNotes(record)].map((x) => String(x ?? ''))
  .flatMap((x) => x.split(/[\n.;]+/)).map((s) => s.trim()).find((s) => OIL_GAS.test(s))?.slice(0, 80) ?? null;
export const oilGasNote = (record) => glUnrequested(record) ?? (oilGasMention(record) ? `The intake mentions oil or gas work ("${oilGasMention(record)}"): answer it yourself.` : null);
export const GL_OIL_GAS = { tni: 'general.gl', source: (record) => (oilGasNote(record) ? 'fact' : 'standard'), value: () => false, note: oilGasNote };

// Trailer interchange the intake asks for (trailerInfo.interchange Yes), on every carrier (TNI, the
// maintainer, 2026-10-28, general.trailer-interchange: Progressive, then GEICO): the interchange
// agreement Yes (the intake's), giving a copy of it on request Yes; the number of non-owned
// trailers TNI's default 1 and the trailer type from the intake's trailer type (never its hitch),
// both filled and marked to confirm with the client; the limit the intake's with a $1,000
// deductible, or, where the carrier doesn't list it, the next limit up it lists (marked to
// confirm); no limit, or one above the highest listed, is the agent's. Without the request nothing
// is answered.
export const interchangeRequested = (record) => record?.trailerInfo?.interchange === true;
export const interchangeUnrequested = (record) => (interchangeRequested(record) ? null : 'The intake doesn\'t ask for trailer interchange: answer it yourself.');
export const INTERCHANGE_TRAILERS = '1';
const thousands = (n) => `$${n.toLocaleString('en-US')}`;
// The limit picked among the carrier's (`listed`, in dollars, each offered with a $1,000
// deductible): the intake's, else the next one up; `raised` when it isn't the intake's. Null
// without a request or a limit, or with one above the highest listed.
export function interchangeLimitPick(record, listed) {
  const asked = toMoney(record?.trailerInfo?.interchangeLimit);
  if (!interchangeRequested(record) || asked == null) return null;
  const amount = [...listed].sort((a, b) => a - b).find((x) => x >= asked);
  return amount == null ? null : { amount, asked, raised: amount !== asked };
}
// Why the limit is the agent's (null when the fill picks it). `carrier`: its name.
export const interchangeLimitNote = (record, listed, carrier) => interchangeUnrequested(record) ?? (interchangeLimitPick(record, listed) ? null
  : !record.trailerInfo?.interchangeLimit ? 'The intake asks for trailer interchange without a limit: choose it yourself.'
    : toMoney(record.trailerInfo.interchangeLimit) == null
      ? `The intake's trailer interchange limit (${String(record.trailerInfo.interchangeLimit).slice(0, 20)}) isn't an amount: choose it yourself.`
      : `The intake asks for a ${String(record.trailerInfo.interchangeLimit).slice(0, 20)} trailer interchange limit, above the highest ${carrier} lists (${thousands(Math.max(...listed))}): choose it yourself.`);
// The next limit up, said to confirm with the client.
export const interchangeLimitRaised = (record, listed, carrier) => {
  const pick = interchangeLimitPick(record, listed);
  return pick?.raised ? `${carrier} doesn't list the intake's ${thousands(pick.asked)} trailer interchange limit: the next one up, ${thousands(pick.amount)} with a $1,000 deductible, is picked. Confirm it with the client.` : null;
};
// Left to the agent: a fact, never Luna's; the intake's: derived; the next one up: TNI's rule.
export const interchangeLimitSource = (record, listed) => {
  const pick = interchangeLimitPick(record, listed);
  return !pick ? 'fact' : pick.raised ? 'standard' : 'derived';
};
// The intake's trailer types, each once. The carrier's trailer type for them (`types`: the intake's
// type to the carrier's): one type the map has; none, two, or one it doesn't have is the agent's.
export const interchangeTrailerTypes = (record) => [...new Set((record?.trailers ?? []).map((t) => t?.type).filter(Boolean))];
export const interchangeTrailerType = (record, types) => {
  const listed = interchangeTrailerTypes(record);
  return listed.length === 1 ? types[listed[0]] ?? null : null;
};
// What was picked for the trailer type, or why nothing was (`what`: "the Dry Freight Trailer tile").
export const interchangeTypeSaid = (record, types, { carrier, what, shown = (x) => x }) => {
  const listed = interchangeTrailerTypes(record);
  const pick = interchangeTrailerType(record, types);
  if (pick) return `the ${shown(pick)} ${what} for the intake's ${listed[0]} trailer`;
  return `no trailer type ${what} picked (${!listed.length ? 'the intake has no trailer type' : listed.length > 1 ? `the intake has ${listed.join(', ')} trailers` : `${listed[0]} isn't matched to a ${carrier} trailer ${what}`}): pick it yourself`;
};

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

// Proof of prior insurance (POP) assumed (TNI, 2026-10-26, W44-29: "if any of the policy type,
// date, carrier or limit boxes is filled, assume POP of 1-3 years directly, and tell the agent at
// the start which details are missing"): the intake's current insurance is a current policy when
// any of its four boxes is filled. Not settled by the decision, so as before: no prior insurance
// (noPriorInsurance), an expiration date already passed, and a policy typed as something other than
// auto insurance (General Liability, Cargo, Other). TNI, 2026-10-26 (answer to PR question): an
// expired policy is not current, the agent's; a General Liability, Cargo or Other policy is not POP.
const AUTO_POLICY = /^(?:commercial|personal)\s+auto$/i;
export function priorInsuranceAssumed(record, policy = record?.priorInsurance?.[0]) {
  const filled = (v) => v != null && String(v).trim() !== '';
  if (!policy || noPriorInsurance(policy) || !['type', 'carrier', 'limit', 'expiration'].some((k) => filled(policy[k]))) return false;
  if (filled(policy.type) && !AUTO_POLICY.test(String(policy.type).trim())) return false;
  return !priorPolicyExpired(record, policy);
}
// The intake's current insurance typed as something other than auto insurance (General Liability,
// Cargo, Other): not proof of prior insurance (TNI, 2026-10-26: answer to PR question 8). An
// untyped policy isn't one.
export function priorPolicyNotAuto(policy) {
  const type = String(policy?.type ?? '').trim();
  return type !== '' && !noPriorInsurance(policy) && !AUTO_POLICY.test(type);
}

// A person's name as lowercase words without accents ("Campelo Kraychete" -> ["campelo", "kraychete"]).
export function nameWords(name) {
  return String(name ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}+/gu) ?? [];
}

// The intake's owner name is this driver: the same words across the name boxes (the suffix
// too: "SAMPLE EXAMPLO JR"), or the owner's last word is the driver's surname or one of its words
// (two-word surnames: "CAMPELO KRAYCHETE") and the owner's first name is one of the driver's given
// names. A surname alone is a family, not a person: owner "Alice Sample" is not driver "Bob
// Sample" (nor "Bob Jones Sample"). It says whether a row carries the owner's name, not which row is
// the owner's: that is the first (ownerRow).
export function ownerIsDriver(ownerName, d) {
  const owner = nameWords(ownerName);
  if (!owner.length || !d) return false;
  const driver = nameWords(`${d.first ?? ''} ${d.middle ?? ''} ${d.last ?? ''} ${d.suffix ?? ''}`);
  if (owner.length === driver.length && [...owner].sort().join(' ') === [...driver].sort().join(' ')) return true;
  return nameWords(d.last).includes(owner.at(-1)) && nameWords(`${d.first ?? ''} ${d.middle ?? ''}`).includes(owner[0]);
}

// The owner's own driver row: the first row of the intake's driver list. TNI, 2026-10-27 (answer to
// PR question V4): "The owner is always the first driver on the intake's driver list", Sr or Jr
// regardless. The owner's details (date of birth, marital status, license state, CDL), the
// "Excluded" mark and, on GEICO, the relationship Owner come from it; the rows after it are ordinary
// drivers and employees, even with the owner's name. Its name differing from the owner box's keeps
// it the owner, with an Intake-step check (ownerRowNameDiffers). This replaces the owner's row by
// name (T2's exact full name of several, and the agent's with none). null with no driver rows.
/** @returns {any} */
export function ownerRow(r) {
  return r?.drivers?.[0] ?? null;
}

// The owner's row (the first, ownerRow) whose name isn't the owner box's (ownerIsDriver), nor the
// owner box's single word as its first name (an owner box holding only the first name): the row is
// still the owner (TNI, 2026-10-27: answer to PR question V4), and the Intake step says it was taken
// as the owner (normalize.js `drivers.owner-name-differs`). A Sr or Jr, or a middle name, on the row
// is the owner's name. false for a blank owner box (no name to compare) or no driver rows.
/** @param {any} r @returns {boolean} */
export function ownerRowNameDiffers(r) {
  const d = ownerRow(r);
  const owner = nameWords(r?.applicant?.owner1);
  if (!d || !owner.length || ownerIsDriver(r.applicant.owner1, d)) return false;
  return !(owner.length === 1 && nameWords(d.first)[0] === owner[0]);
}

// The "owner drives" box as the quote reads it: true, false, or null for a blank box. The
// maintainer, 2026-10-28: "Does the owner drive?" decides it the same way on every carrier: Yes, the
// owner drives and isn't excluded; No, the owner is an excluded driver. So an agent's Excluded driver
// No on the owner's row (the first: ownerRow) while the box says No is that Yes: the owner is on the
// quote as a driver. Before, the box stayed No while the row wasn't excluded, and no row gave the
// owner's name or date of birth (Progressive's Business Owner Info, 2026-10-28 runs). The record
// keeps both as set (the agent's correction stands); the Intake step asks the question on the box
// itself (normalize.js `drivers.owner-excluded`, on `applicant.ownerDrives`).
/** @param {any} r @returns {boolean | null} */
export function ownerDrivesSaid(r) {
  const said = r?.applicant?.ownerDrives;
  if (said === false && ownerRow(r)?.excluded === false) return true;
  return typeof said === 'boolean' ? said : null;
}

// The owner's row while the owner doesn't drive (ownerDrivesSaid No): the first row (ownerRow; TNI,
// 2026-10-27: answer to PR question V4). It is excluded (driverExcluded: R1), and the owner's details
// come from it (progressive.js owner, geico.js ownerDetails: T3, and V2 on Progressive and AmWINS).
// null for none.
/** @returns {any} */
export function nonDrivingOwnerRow(r) {
  return ownerDrivesSaid(r) === false ? ownerRow(r) : null;
}

// A driver row the quote treats as excluded, on every carrier (Progressive's exclude question Yes,
// AmWINS' "(Excluded)" after the license number; GEICO's quote leaves the owner's row out and asks
// nothing about another's):
// - the intake marks it ("Excluded" in the license-number box, normalize.js licenseBox:
//   `drivers[].excluded` true), or the agent sets it in client details;
// - or it is the owner's row and the intake says the owner doesn't drive (`applicant.ownerDrives`
//   No). TNI, 2026-10-26 (answer to PR question, R1): "owner drives" says only whether the owner
//   drives; if the owner's row is marked Excluded, or the answer is No, the owner is excluded. The
//   owner's row is the first (TNI, 2026-10-27: answer to PR question V4: nonDrivingOwnerRow; before,
//   T2's row by the owner's exact full name). The Intake step names it (normalize.js
//   `drivers.owner-excluded`). GEICO's quote leaves the owner's row out (T1, V3: geico.js
//   omittedDriver).
// Derived here rather than marked on the record at reading, so the record keeps the intake as read
// (the panel, the usage log and the warehouse show what the intake says) and an edit of either box
// in client details applies at quote time. A row's own No (`excluded` false, which only the agent
// sets: the intake leaves it null) is the agent's correction and stands; on the owner's row it also
// makes the owner a driver (ownerDrivesSaid), so the quote never has the owner neither excluded nor
// driving. Other drivers are never affected.
/** @param {any} r @param {any} d @returns {boolean} */
export function driverExcluded(r, d) {
  if (!d) return false;
  if (d.excluded != null) return d.excluded === true;
  return d === nonDrivingOwnerRow(r);
}

// Excluded only because the owner doesn't drive (driverExcluded), not by the row's own mark: what
// the carriers' notes and warnings say then.
/** @param {any} r @param {any} d @returns {boolean} */
export function ownerRowExcluded(r, d) {
  return driverExcluded(r, d) && d.excluded !== true;
}

// The owner is an excluded driver: the owner's row (the first: TNI, 2026-10-27, answer to PR
// question V4) is excluded, marked so or because the intake says the owner doesn't drive. No driver
// rows is no exclusion. A later row with the owner's name, marked or not, is an ordinary driver: it
// never makes the owner excluded, nor leaves whether the owner drives to the agent (V4 replaces the
// 2026-10-26 answer for the owner's name on several rows, only some excluded: the first row decides).
export function ownerExcluded(r) {
  return driverExcluded(r, ownerRow(r));
}

// Whether the owner is a driver on the policy, wherever a carrier asks it (GEICO's Business & Owner
// Info and Add Driver, Progressive's Business Owner Info; AmWINS doesn't ask). TNI, 2026-10-26
// (W44-25): "Owner Drivers if not excluded, in every case". The intake's No stays No, and makes the
// owner's driver row an excluded driver (driverExcluded; TNI, 2026-10-26: answer to PR question,
// R1); an owner whose driver row (the first: TNI, 2026-10-27, V4) the intake marks excluded is not a
// driver, No, also over the intake's Yes, with a warning the agent confirms (ownerDrivesWarn; TNI,
// 2026-10-26: answer to PR question); otherwise Yes: the intake's, or TNI's standard for a blank box.
// The record keeps the box as read (null when blank), so the answer's source stays right
// (ownerDrivesSource). The box's No with the agent's Excluded driver No on the owner's row is Yes
// (ownerDrivesSaid).
/** @returns {boolean} */
export function ownerDrives(r) {
  if (ownerDrivesSaid(r) === false) return false;
  return !ownerExcluded(r);
}

// Where ownerDrives' answer comes from (plan.js `source`): the intake's box when it answers and the
// answer stands; the exclusion when it makes the owner not a driver over a blank box or a Yes, or
// the agent's not-excluded owner's row over the box's No (`derived`); TNI's standard for a blank box.
export function ownerDrivesSource(r) {
  const said = r?.applicant?.ownerDrives;
  if (said === false) return ownerDrivesSaid(r) === false ? 'intake' : 'derived';
  if (ownerExcluded(r)) return 'derived';
  return said === true ? 'intake' : 'standard';
}

// The intake says the owner drives but marks their driver row excluded: ownerDrives is No, and the
// agent confirms it. The other way round, the box's No read as Yes because the owner's row is set
// not excluded (ownerDrivesSaid), is never silent either: the agent confirms that Yes (PR #216
// review, 2026-10-28).
export function ownerDrivesWarn(r) {
  if (r?.applicant?.ownerDrives === false && ownerDrivesSaid(r) === true) {
    return 'The intake says the owner doesn\'t drive, but their driver row is set not excluded, so the owner is quoted as a driver: Yes. Confirm it with the client.';
  }
  return r?.applicant?.ownerDrives === true && ownerExcluded(r)
    ? 'The intake says the owner drives, but marks their driver row excluded: answered No (TNI: an excluded owner isn\'t a driver). Confirm it with the client.' : null;
}

// Whether the owner is involved in daily operations (Progressive's president/CEO checkbox;
// GEICO's owner Yes/No). TNI, 2026-10-27: Yes when the owner drives and isn't excluded
// (`ownerDrives`); No when they don't drive or are excluded.
/** @returns {boolean} */
export function ownerDailyOps(r) {
  return ownerDrives(r) === true;
}

// Where ownerDailyOps' answer comes from: TNI's standard when the owner-drives box is blank and
// nothing excludes the owner (ownerDrivesSource), else derived from the intake's box or exclusion.
// The intake's "owner drives, but excluded" warning goes with the No (ownerDrivesWarn).
/** @returns {'standard' | 'derived'} */
export function ownerDailyOpsSource(r) {
  return ownerDrivesSource(r) === 'standard' ? 'standard' : 'derived';
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
