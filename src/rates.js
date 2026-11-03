// @ts-check
// A carrier page whose rates it says are out of date (a premium to recalculate): the fill engine
// (src/kit/pagekit.js ratesStale) waits for Recalculate, and the quoting history (src/premium.js)
// logs no premium. "The coverages have changed, please "recalculate" to see your rate." /
// "Recalculate to see coverage cost" (Progressive), or a premium of ****. GEICO: "Please Recalculate
// Due To Coverage Change", and "$ --.--" in place of the amounts. No imports: the fill engine
// builds it in.
export const RATES_STALE = /\*{4}|\$\s*--\.--|(?:must|please|need to)\W+recalculate|recalculate to see|premium.*(?:out of date|not current)|chang\w*.*recalculate/i;
