// The premium a carrier's page quotes, for the quoting history (step 1 of the sales-analysis plan):
// read from the page's text whenever the panel reads the page's layout, and logged as a
// `quote_premium` event when it is current and differs from the last one logged for that quote,
// tab and carrier. Nothing about the client: amounts, the term and the payments only.
//
// Removable as one piece: this file, its import and the one call in sidepanel.js (captureLayout),
// `quote_premium` in server/index.mjs (EVENT_FIELDS and its check), and `quote_premiums` in
// scripts/lib/warehouse.mjs. Nothing else reads the event.

export const PREMIUM_EVENT = 'quote_premium';

const AMOUNT = String.raw`\$\s*([1-9][\d,]*(?:\.\d{2})?)`;
const money = (s) => (s == null ? null : Math.round(Number(String(s).replace(/,/g, '')) * 100) / 100);

// Rates the page itself says are out of date: no premium. A copy of pagekit.js ratesStale (kept
// apart so this file can go alone): change both together.
const STALE = /\*{4}|\$\s*--\.--|(?:must|please|need to)\W+recalculate|recalculate to see|premium.*(?:out of date|not current)|chang\w*.*recalculate/i;

// GEICO: "12 Month Total Premium: $101,287.00 Due Today $16,908.71 10 Additional Payments of
// $8,437.83". Progressive: "Total premium amount $12,815.00 per year including Electronic Funds
// Transfer (EFT) discount". Else any "total/annual/policy/estimated premium $…" (its term unknown).
const GEICO = new RegExp(String.raw`(\d{1,2})\s*month\s+total\s+premium\s*:?\s*${AMOUNT}(?:[^$]{0,80}?due today\s*${AMOUNT})?(?:[^$]{0,80}?(\d{1,2})\s+additional payments of\s*${AMOUNT})?`, 'i');
const PROGRESSIVE = new RegExp(String.raw`total\s+premium\s+amount\s*${AMOUNT}\s*per\s+(year|6 months|six months|month)`, 'i');
const ANY = new RegExp(String.raw`(?:total|annual|policy|estimated)\s+premium(?:\s+amount)?\s*:?\s*${AMOUNT}`, 'i');
const TERMS = { year: 12, '6 months': 6, 'six months': 6, month: 1 };

// Where each carrier quotes its premium (a page, or a step on one-address carriers): the page's text
// is read only there. AmWINS: not known yet.
const PREMIUM_PAGES = { geico: ['Quote & Coverages'], progressive: ['CoveragesRates'] };
export const premiumHere = (carrier, page, step) => (PREMIUM_PAGES[carrier] ?? []).some((p) => p === page || p === step);

// What the page quotes: { total, termMonths, dueToday, payments, payment } (null where the page
// doesn't say), or null when it shows no current premium.
export function readPremium(text) {
  // Tested line by line, as the kit does: `.*` must not reach from one line of the page to another.
  if (STALE.test(String(text ?? ''))) return null;
  const s = String(text ?? '').replace(/\s+/g, ' ');
  let m = s.match(GEICO);
  if (m) return { total: money(m[2]), termMonths: Number(m[1]), dueToday: money(m[3]), payments: m[4] ? Number(m[4]) : null, payment: money(m[5]) };
  m = s.match(PROGRESSIVE);
  if (m) return { total: money(m[1]), termMonths: TERMS[m[2].toLowerCase()], dueToday: null, payments: null, payment: null };
  m = s.match(ANY);
  return m ? { total: money(m[1]), termMonths: null, dueToday: null, payments: null, payment: null } : null;
}

// Logs the page's premium once per change: `read` gives the page's text, `log` takes the event
// (false: not logged, so it is tried again next time),
// `seen` keeps the last one logged per `key` (quote, tab and carrier). Any failure is ignored: the
// premium is never worth a fill or the panel.
export async function notePremium({ key, read, log, step = null, seen }) {
  try {
    const p = readPremium(await read());
    if (!p) return false;
    const sig = JSON.stringify(p);
    if (seen.get(key) === sig) return false;
    // A step only where the page has one (the server refuses an empty one).
    if (log({ type: PREMIUM_EVENT, ...(step ? { step } : {}), ...p }) === false) return false;
    seen.set(key, sig);
    return true;
  } catch {
    return false;
  }
}
