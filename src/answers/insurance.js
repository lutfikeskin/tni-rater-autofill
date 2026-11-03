// @ts-check
// TNI's decisions about the client's current insurance, for any carrier: the answer, its source
// (plan.js), and the agent's note when the intake doesn't settle it. A carrier asks them in its own
// words (Progressive: src/carriers/progressive.js).

import { priorPolicyExpired, priorPolicyNotAuto, priorInsuranceAssumed } from '../util.js';

// "Is the customer currently insured?" Yes for a policy on the intake with a limit and an
// expiration not passed (derived), and, TNI's assumption, whenever any box of an auto or untyped
// policy is filled (TNI, 2026-10-26, W44-29: proof of prior insurance, 1-3 years; the Intake step
// names the blank boxes). Nothing filled, no prior insurance or an expired policy: No, as before.
// A General Liability, Cargo or Other policy is not auto insurance (TNI, 2026-10-26: not proof of
// prior insurance), whatever its limit and date: alone it leaves the question the agent's, as on
// GEICO (until 2026-11-03 its limit and date made it Yes, and its limit the current auto BI limit).
const PRIOR_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const datedPolicy = (r, p) => !priorPolicyNotAuto(p) && p.limit && p.expiration && !priorPolicyExpired(r, p);
export const currentlyInsured = (r) => !!r.priorInsurance?.some((p) => datedPolicy(r, p)) || priorInsuranceAssumed(r);
// The intake's only current insurance is a non-auto policy: the question is the agent's.
export const onlyNotAuto = (r) => !currentlyInsured(r) && priorPolicyNotAuto(r.priorInsurance?.[0]);
export const currentlyInsuredAnswer = (r) => (onlyNotAuto(r) ? null : currentlyInsured(r));
export const currentlyInsuredSource = (r) => (onlyNotAuto(r) ? 'fact'
  : currentlyInsured(r) && !r.priorInsurance?.some((p) => datedPolicy(r, p) && PRIOR_DATE.test(p.expiration ?? '')) ? 'standard' : 'derived');
// The non-auto policy's type as the intake names it, for the agent's notes.
export const notAutoType = (r) => String(r.priorInsurance[0].type).trim().slice(0, 30);
export const currentlyInsuredNote = (r) => (onlyNotAuto(r)
  ? `The intake's current insurance is ${notAutoType(r)}, not an auto policy: answer whether the customer is currently insured yourself.` : null);
// The current policy's limit and expiration date, asked once currently insured: a blank box (or a
// remark in the date box) is the agent's, named, never typed. With only a non-auto policy on the
// intake its limit and date aren't the auto policy's, so both are the agent's.
// The intake's current limit, unless it is the form's "Other" (a limit it doesn't list): that names
// no amount, so the limit is the agent's (W45-06: the fill looked for a Progressive option "Other").
const OTHER_LIMIT = /^other$/i;
export const priorLimit = (r) => {
  const limit = String(r.priorInsurance?.[0]?.limit ?? '').trim();
  return limit && !OTHER_LIMIT.test(limit) ? limit : null;
};
// `key` is the intake's box: 'limit' or 'expiration'.
export const priorBoxValue = (key) => (r) => (onlyNotAuto(r) ? null : key === 'limit' ? priorLimit(r) : r.priorInsurance?.[0]?.expiration ?? null);
export const priorBoxIgnored = (r) => !currentlyInsured(r) && !onlyNotAuto(r);
export const priorBoxNote = (r, key) => (onlyNotAuto(r) ? `The intake's current insurance is ${notAutoType(r)}, not an auto policy: if the customer has auto insurance, enter its ${key === 'limit' ? 'limit' : 'expiration date'} yourself.`
  : !currentlyInsured(r) ? null
  : key === 'limit' && OTHER_LIMIT.test(String(r.priorInsurance?.[0]?.limit ?? '').trim()) ? 'The intake\'s current insurance limit is "Other", with no amount: answer it yourself.'
  : key === 'limit' && !r.priorInsurance?.[0]?.limit ? 'The intake\'s current insurance has no limit: answer it yourself.'
    : key === 'expiration' && !PRIOR_DATE.test(r.priorInsurance?.[0]?.expiration ?? '') ? 'The intake\'s current insurance has no expiration date: enter it yourself.' : null);
