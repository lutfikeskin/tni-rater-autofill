// Patterns that must never appear in anything committed from real quotes (test fixtures, layouts):
// VINs, emails, phone numbers, SSNs, street addresses, USDOT numbers. The extension already
// replaces client names and numbers with "[client]" when it records; this is the second check.

export const PII_PATTERNS = {
  vin: /\b(?=[A-HJ-NPR-Z0-9]{17}\b)(?=[A-HJ-NPR-Z0-9]*\d)[A-HJ-NPR-Z0-9]{17}\b/,
  email: /[\w.+-]+@(?!example\.test\b)[\w-]+\.[a-z]{2,}/i,
  phone: /\(?\b[2-9]\d{2}\)?[-. ]\d{3}[-. ]\d{4}\b/,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/,
  street: /\b\d{2,6} (?:[NSEW]\.? )?[A-Z][a-z]+ (?:St|Ave|Rd|Dr|Blvd|Ln|Way|Ct|Hwy|Pkwy)\b/,
  usdot: /\bUSDOT\D{0,5}\d{5,8}\b/i,
};

// Allowed on purpose: the synthetic values used in fixtures and mocks.
const ALLOWED = [/\b555[-. )]*01\d/, /\b1 (Test|Sample|Agency) (Way|Garage Rd)\b/, /54DC4W1B5KS800000|1FTBR3X8[07]MKA12(345|399)/];

export function findPii(text) {
  const hits = [];
  for (const [kind, re] of Object.entries(PII_PATTERNS)) {
    for (const m of String(text).matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))) {
      if (!ALLOWED.some((a) => a.test(m[0]))) hits.push({ kind, match: m[0] });
    }
  }
  return hits;
}
