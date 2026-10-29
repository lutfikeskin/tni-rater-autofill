// @ts-check
// TNI's standard coverage answers that every carrier fills, decided once here (TNI; the standards
// are recorded in docs/intake-and-rules.md). Each carrier's rule writes the amount in the words its
// own options use (usd, usdK), so a change of a standard is made here and every carrier follows;
// test/standards.test.mjs reads each carrier's answer back. What one carrier alone does differently
// stays in its own file (GEICO's Texas split UM limits, Progressive's South Carolina BI & PD).

export const STANDARDS = Object.freeze({
  // Uninsured / underinsured motorist bodily injury: a combined single limit.
  umCsl: 100_000,
  // Medical payments, per person, wherever the carrier offers it.
  medPay: 5_000,
  // Comprehensive and collision deductibles.
  deductible: 1_000,
  // Rental reimbursement.
  rental: Object.freeze({ perDay: 40, max: 1_200 }),
});

// An amount as most options write it: $1,000.
export const usd = (/** @type {number} */ amount) => `$${amount.toLocaleString('en-US')}`;

// An amount in thousands, as some options write it: $100k (or $100K, with `k`).
export const usdK = (/** @type {number} */ amount, k = 'k') => `$${amount / 1000}${k}`;
