// @ts-check
// TNI's reading of the client's phone, for every carrier: the intake's one phone box as a 10-digit
// US number. normalizeIntake keeps such a number as "(555) 010-0100"; a box that isn't one keeps
// its text, with the Intake step's check (phone.invalid). A carrier writes the number in its own
// boxes (src/carriers/<carrier>.js): whole, or in the parts it asks for.

const US_PHONE = /^\((\d{3})\) (\d{3})-(\d{4})$/;

// The intake's phone as its ten digits; null with no phone, or one that isn't a 10-digit US number.
/** @returns {string | null} */
export function phoneDigits(r) {
  const parts = US_PHONE.exec(String(r?.applicant?.phone ?? ''));
  return parts ? parts.slice(1).join('') : null;
}

// What the panel says of a phone that isn't a 10-digit US number: never typed, the agent's. Null
// with no phone (nothing to say), or a number that is one.
/** @returns {string | null} */
export function phoneNote(r) {
  return r?.applicant?.phone && !US_PHONE.test(r.applicant.phone) ? 'The intake\'s phone isn\'t a 10-digit number: enter it yourself.' : null;
}
