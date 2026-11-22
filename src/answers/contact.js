// @ts-check
// TNI's reading of the client's phone, for every carrier: the intake's one phone box as a 10-digit
// US number. normalizeIntake, and an agent's edit in the panel, keep such a number as
// "(555) 010-0100"; a box that isn't one keeps its text, with the Intake step's check
// (phone.invalid). Read here with the same reading (toPhone), so a number kept in another form
// (an edit made on an older build) is still one. A carrier writes the number in its own boxes
// (src/carriers/<carrier>.js): whole, or in the parts it asks for.

import { toPhone } from '../shared/parse.js';

// The intake's phone as its ten digits; null with no phone, or one that isn't a 10-digit US number.
/** @returns {string | null} */
export function phoneDigits(r) {
  return toPhone(r?.applicant?.phone)?.replace(/\D/g, '') ?? null;
}

// What the panel says of a phone that isn't a 10-digit US number: never typed, the agent's. Null
// with no phone (nothing to say), or a number that is one.
/** @returns {string | null} */
export function phoneNote(r) {
  return r?.applicant?.phone && !toPhone(r.applicant.phone) ? 'The intake\'s phone isn\'t a 10-digit number: enter it yourself.' : null;
}
