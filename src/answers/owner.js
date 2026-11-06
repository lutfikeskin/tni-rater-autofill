// @ts-check
// TNI's decisions about the business owner, for every carrier: which driver row is the owner's
// (the first), whether the owner drives and is excluded, the panel's answer to the intake's
// "Owner drives: No", the owner's name and date of birth, and their part in daily operations.
// A carrier writes the answer in its own options (src/carriers/<carrier>.js).

// A person's name as lowercase words without accents ("Campelo Kraychete" -> ["campelo", "kraychete"]).
/** @returns {string[]} */
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
  if (ownerNoPending(r)) return true;
  return typeof said === 'boolean' ? said : null;
}

// The intake's own "owner drives" No, which the agent hasn't answered yet. TNI, 2026-11-05 (W46-02):
// that No is a red check on the Intake step (normalize.js `drivers.owner-excluded`), and the owner
// stays a driver until the agent answers it: agents reversed the intake's No on the carrier's page in
// 6 of 7 quotes (Progressive's exclude question, GEICO's owner driver), and in the panel in more.
// It replaces R1 (2026-10-26: the intake's No alone excluded the owner). The agent answers by setting
// Owner drives themselves (Yes or No), or Looks right on the check, which confirms the No: the panel
// marks either on the record (`applicant.ownerDrivesAnswered`, record.js), and the No then excludes
// the owner as before. An owner's row the intake marks "Excluded" is excluded as before, and one the
// agent sets not excluded is a driver (above); with no driver rows nothing changes.
// The panel's answer to "Does the owner drive?" (sidepanel/panel/record.js), on the loaded intake
// (`{ record, warnings, done, agentEdited }`), after either:
// - `edit`: the agent's edit of a field. Owner drives (Yes or No) answers it: the owner's answer is
//   theirs, and the check is marked done (the review of PR #292: its card said "Until you answer"
//   under the agent's answer).
// - `check`: Looks right (`done` true) or Undo (false) on the warning at index `i`. Looks right on
//   `drivers.owner-excluded` confirms the intake's No (and puts it back in a box the agent cleared);
//   Undo takes it back, unless the agent set Owner drives (Yes or No) themselves.
// Changes `intake` in place; true when the owner's answer changed (a quote's plans follow it).
/** @param {any} intake @param {{ edit?: string, check?: { i: number, done: boolean } }} what @returns {boolean} */
export function ownerDrivesAnswered(intake, { edit, check }) {
  const applicant = intake?.record?.applicant;
  if (!applicant) return false;
  const item = (intake.warnings ?? []).findIndex((w) => w.code === 'drivers.owner-excluded');
  const before = applicant.ownerDrivesAnswered === true;
  if (edit === 'applicant.ownerDrives' && typeof applicant.ownerDrives === 'boolean') {
    applicant.ownerDrivesAnswered = true;
    if (item >= 0 && !(intake.done ?? []).includes(item)) intake.done = [...(intake.done ?? []), item];
  } else if (edit === 'applicant.ownerDrives') {
    // The box cleared: no answer to the intake's No (blank is not No). The check stays, or is again,
    // open for the agent (the review of PR #292).
    applicant.ownerDrivesAnswered = false;
    if (item >= 0) intake.done = (intake.done ?? []).filter((i) => i !== item);
  } else if (check && check.i === item && item >= 0) {
    const edited = !!intake.agentEdited?.includes('applicant.ownerDrives');
    if (check.done && applicant.ownerDrives == null) {
      // Looks right after the agent cleared the box confirms the intake's No, as the check says: the
      // box gets it back and is the intake's again, so Undo reopens it (the review of PR #292).
      applicant.ownerDrives = false;
      if (edited) intake.agentEdited = intake.agentEdited.filter((p) => p !== 'applicant.ownerDrives');
      applicant.ownerDrivesAnswered = true;
      return true;
    }
    applicant.ownerDrivesAnswered = check.done || (edited && typeof applicant.ownerDrives === 'boolean');
  } else return false;
  return applicant.ownerDrivesAnswered !== before;
}

/** @param {any} r @returns {boolean} */
export function ownerNoPending(r) {
  const row = ownerRow(r);
  return r?.applicant?.ownerDrives === false && r.applicant.ownerDrivesAnswered !== true && !!row && row.excluded == null;
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
  // The intake's No not yet answered (W46-02): quoted as a driver until the agent answers.
  if (ownerNoPending(r)) {
    return 'The intake says the owner doesn\'t drive. Until you answer "Does the owner drive?" in the intake checks, the owner is quoted as a driver: Yes. Confirm it with the client.';
  }
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

// The business owner and their driver row (for date of birth and a clean name split). TNI,
// 2026-10-27 (answer to PR question V4): "The owner is always the first driver on the intake's driver
// list", Sr or Jr regardless, so the owner's row is the first (ownerRow), whatever its name;
// the rows after it are ordinary drivers, even with the owner's name. This replaces finding the row
// by the owner's name (and, of several, T2's exact full name), and the 2026-10-20 rule that an owner
// no row's name matched got no date of birth: a first row with another name is still the owner's,
// and the Intake step says so (normalize.js `drivers.owner-name-differs`).
// - `driver`: the owner's row while the owner drives (as their driver row); none when the intake
//   says the owner doesn't drive (ownerDrivesSaid: the box's No, unless the agent set the
//   owner's row not excluded, which is the owner driving: the maintainer, 2026-10-28).
// - `dob` from `dobDriver`: that row, or with the intake's No the owner's row all the same
//   (nonDrivingOwnerRow; TNI, 2026-10-26: answer to PR question, T3, asked of GEICO, and V2,
//   2026-10-27: confirmed here and on AmWINS). None with no driver rows: the agent's (ownerDobNote).
// - The name parts come from the row only when it carries the owner box's name (`named`: the same
//   words, the owner's first name and surname by ownerIsDriver, the first name repeated in the
//   sole driver's last-name box, or an owner box holding only the first name); otherwise, and when the
//   owner doesn't drive, from the owner box (never another person's name: the FL run that put the
//   first driver in the owner boxes, the 2026-10-08 audit's "Alice Sample" and "Bob Sample").
export function owner(r) {
  const full = r.applicant.owner1 ?? '';
  const nameKey = (name) => (String(name ?? '').toLowerCase().match(/\p{L}+/gu) ?? []).sort().join(' ');
  const row = ownerRow(r);
  const driver = ownerDrivesSaid(r) === false ? null : row;
  const fullMatch = !!driver && !!nameKey(full) && nameKey(`${driver.first ?? ''} ${driver.middle ?? ''} ${driver.last ?? ''} ${driver.suffix ?? ''}`) === nameKey(full);
  // Some intakes repeat the first name in the sole driver's last-name box. Only connect
  // that row's name when the intake explicitly says the owner drives and the owner's first name agrees.
  // A blank box, TNI's Yes for the owner-driver question (W44-25), is no evidence of the name.
  const sole = r.drivers.length === 1 ? r.drivers[0] : null;
  const repeatedFirst = !!driver && driver === sole && ownerDrivesSaid(r) === true && !!nameKey(sole.first)
    && nameKey(sole.first) === nameKey(sole.last)
    && nameKey(sole.first) === nameKey(full.split(/\s+/).slice(0, -1).join(' '));
  // The owner box sometimes holds only the first name ("IBRAHIM"): the row whose first name starts
  // with it gives the rest of the name.
  const firstOnly = !!driver && !/\s/.test(full.trim()) && !!full.trim()
    && (driver.first ?? '').trim().split(/\s+/)[0].toLowerCase() === full.trim().toLowerCase();
  const named = driver && (fullMatch || ownerIsDriver(full, driver) || repeatedFirst || firstOnly) ? driver : null;
  const first = named?.first ?? full.split(/\s+/).slice(0, -1).join(' ');
  const dobDriver = ownerDrivesSaid(r) === false ? nonDrivingOwnerRow(r) : driver;
  return { driver, named, dob: dobDriver?.dob ?? null, dobDriver, first: first || null, middle: named?.middle ?? null, last: repeatedFirst ? full.split(/\s+/).at(-1) : named?.last ?? full.split(/\s+/).at(-1) ?? null };
}

// The owner's date of birth left to the agent, and why (every carrier).
export function ownerDobNote(r) {
  const o = owner(r);
  if (o.dob) return null;
  if (o.dobDriver) return 'The owner\'s driver row has no date of birth: enter it yourself.';
  // The owner's row is the first (V4), so only an intake with no driver rows gets here.
  if (ownerDrivesSaid(r) === false) return 'The intake says the owner doesn\'t drive and lists no drivers, so no driver row gives their date of birth: enter it yourself.';
  return 'The intake lists no drivers, so no driver row gives the owner\'s date of birth: enter it yourself.';
}
