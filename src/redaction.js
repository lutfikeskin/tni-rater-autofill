// @ts-check
// A client term's pattern for redaction, shared by the usage log (src/usage.js redactor) and the
// fill engine's page capture (src/kit/pagekit.js capture). One word (a name word such as "Ann", or
// a city) is replaced only as a whole word, so "Ann" leaves "Annual" and "Car" leaves "Cargo" alone;
// any other term (a full name, date of birth, phone, VIN, street) is replaced wherever it appears
// exactly as written. No imports: the fill engine builds it in.

const ONE_WORD = /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u;

/** @param {string} term */
export function redactionPattern(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ONE_WORD.test(term) ? new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'giu') : new RegExp(escaped, 'gi');
}
