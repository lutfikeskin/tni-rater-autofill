// @ts-check
// TNI's decisions about the client's current insurance, for any carrier: the answer, its source
// (plan.js), and the agent's note when the intake doesn't settle it. A carrier asks them in its own
// words (Progressive: src/carriers/progressive.js).

import { priorPolicyExpired, priorInsuranceAssumed } from '../util.js';

// "Is the customer currently insured?" Yes for a policy on the intake with a limit and an
// expiration not passed (derived), and, TNI's assumption, whenever any box of an auto or untyped
// policy is filled (TNI, 2026-10-26, W44-29: proof of prior insurance, 1-3 years; the Intake step
// names the blank boxes). Nothing filled, no prior insurance or an expired policy: No, as before.
const PRIOR_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
export const currentlyInsured = (r) => !!r.priorInsurance?.some((p) => p.limit && p.expiration && !priorPolicyExpired(r, p)) || priorInsuranceAssumed(r);
export const currentlyInsuredSource = (r) => (currentlyInsured(r) && !r.priorInsurance?.some((p) => p.limit && PRIOR_DATE.test(p.expiration ?? '') && !priorPolicyExpired(r, p)) ? 'standard' : 'derived');
// The current policy's limit and expiration date, asked once currently insured: a blank box (or a
// remark in the date box) is the agent's, named, never typed.
// The intake's current limit, unless it is the form's "Other" (a limit it doesn't list): that names
// no amount, so the limit is the agent's (W45-06: the fill looked for a Progressive option "Other").
const OTHER_LIMIT = /^other$/i;
export const priorLimit = (r) => {
  const limit = String(r.priorInsurance?.[0]?.limit ?? '').trim();
  return limit && !OTHER_LIMIT.test(limit) ? limit : null;
};
// `key` is the intake's box: 'limit' or 'expiration'.
export const priorBoxNote = (r, key) => (!currentlyInsured(r) ? null
  : key === 'limit' && OTHER_LIMIT.test(String(r.priorInsurance?.[0]?.limit ?? '').trim()) ? 'The intake\'s current insurance limit is "Other", with no amount: answer it yourself.'
  : key === 'limit' && !r.priorInsurance?.[0]?.limit ? 'The intake\'s current insurance has no limit: answer it yourself.'
    : key === 'expiration' && !PRIOR_DATE.test(r.priorInsurance?.[0]?.expiration ?? '') ? 'The intake\'s current insurance has no expiration date: enter it yourself.' : null);
