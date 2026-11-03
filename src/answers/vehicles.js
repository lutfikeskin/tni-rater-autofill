// @ts-check
// TNI's decisions about the client's vehicles and trailers, for any carrier: the answer, null when
// the intake doesn't settle it, and the agent's note then. A carrier writes the answer in its own
// options (Progressive: src/carriers/progressive.js).

/** @import { Financing } from '../../types.js' */

// "Had the vehicle less than one year": TNI's standard No (2026-10-19), except for a vehicle of this
// model year or later, likely bought within the year: that one is the agent's to ask the client.
// The step's vehicle when it is that recent, else null.
export const recentModel = (r, a) => {
  const v = r.vehicles?.[a.vehicles ?? 0];
  return Number(v?.year) >= new Date().getFullYear() ? v : null;
};

// Loan / lease from the intake's ownership answer (also read from the claims-box notes). No answer
// is not No: a missing ownership, or one that is none of owned / financed / leased (Rented), is
// the agent's (2026-10-09; until then a blank was filled as No).
/** @returns {Financing | null} */
export const financing = (own) => {
  const o = String(own ?? '').trim();
  return /financ|loan/i.test(o) ? 'loan' : /leas/i.test(o) ? 'lease' : /^owned?$/i.test(o) ? 'owned' : null;
};
const financingNote = (own, what) => (financing(own) != null ? null
  : own ? `The intake's ${what} ownership "${own}" isn't owned, financed or leased: answer the loan / lease question yourself.`
    : `The intake has no ${what} ownership answer: answer the loan / lease question yourself.`);
export const vehicleFinancing = (r) => financing(r.operations?.vehicleOwnership);
export const vehicleFinancingNote = (r) => financingNote(r.operations?.vehicleOwnership, 'vehicle');
// Trailers: the intake's trailer ownership (one answer for all of them). TNI's 2026-10-07 reading
// of a blank as owned was reversed on 2026-10-09: a blank is the agent's.
export const trailerFinancing = (r) => financing(r.trailerInfo?.ownership);
export const trailerFinancingNote = (r) => financingNote(r.trailerInfo?.ownership, 'trailer');
