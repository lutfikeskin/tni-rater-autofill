// What the review scripts know of each carrier's pages, in one place: which pages are the quote,
// which are its portal, where a quote is done, its login page and its mock. Every carrier in
// src/carriers.js has an entry with every key (test/carrier-reports.test.mjs), so a new carrier
// fails the tests until the reports are told how its quotes go, rather than its quotes never
// reading as done or its portal reaching the suggestions (audit 2026-11-07, LEARN-17). A key that
// doesn't apply is null, with why beside it. docs/new-carrier.md lists them.
//
// For the reports only: the extension's own knowledge of a carrier (steps, stop steps, actions) is
// its config in src/carriers/, which `finalPage` reads where the two agree (GEICO's stop steps).

import { CARRIERS } from '../../src/carriers.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stopSteps = (id) => Object.keys(CARRIERS.find((c) => c.id === id)?.stopSteps ?? {});
// A carrier's sign-in page, reached in the middle of a quote when its session ran out.
const LOGIN = /\/(auth\/)?login\b|\/login\//i;

/**
 * @typedef {object} CarrierReports
 * @property {(page: string) => boolean} quotePage  a page of the quote itself (the answer key's and the learner's), a login aside
 * @property {((page: string) => boolean) | null} portalPage  a page outside the quote that is never filled, whose layouts the reports leave out (scripts/lib/layouts.mjs); null: none is told apart
 * @property {RegExp} finalPage  the page (or `page › step`) where a quote is done: a heuristic for the weekly numbers (signals.mjs), not the carrier's definition
 * @property {{ page: RegExp, text: RegExp } | null} finalClick  the agent's own click that ends a quote, on its page; null: none
 * @property {RegExp} loginPage
 * @property {string | null} mock  a static copy of its quote page, whose ids coverage.mjs compares with live layouts; null: none to compare
 */

/** @type {Record<string, CarrierReports>} */
export const CARRIER_REPORTS = {
  progressive: {
    // Its quote pages are named (pageName); its portal (home, quote search) is recorded by path.
    quotePage: (p) => !p.startsWith('/'),
    portalPage: (p) => p.startsWith('/'),
    // The quote summary, the print confirmation or the printed quote PDF. A printed quote is done
    // (TNI, 2026-10-20): Print/Send opens the PDF in a tab the panel then follows, so the
    // confirmation page in the quote tab may not be logged after it.
    finalPage: /^(Quote|PrintEmailFaxConfirm|\/Express\/PDFHandler\.ashx)$/i,
    // Print/Send, the agent's since 2026-10-07; logged in the quote tab, whether or not the PDF's page is.
    finalClick: { page: /^PrintEmailFax$/, text: /^print\s*\/\s*send$/i },
    loginPage: LOGIN,
    // Its fixtures are recorded layouts (test/fixtures/progressive), not a page.
    mock: null,
  },
  amwins: {
    // The business-auto application, not another product's (commercial property).
    quotePage: (p) => p.startsWith('/application/businessauto'),
    // Its pages are all paths, and none outside the application is told apart.
    portalPage: null,
    // Its last application step (Underwriting) or its submission notice.
    finalPage: /› (Underwriting|Thank you for the submission)/,
    finalClick: null,
    loginPage: LOGIN,
    mock: 'test/fixtures/amwins/application.html',
  },
  geico: {
    // Every step is sales.geico.com/quote (a step after ' › '); its gateway's search and dashboard
    // ('/', '/dashboard') are not the quote.
    quotePage: (p) => /^\/quote(?:\/|$)/i.test(p.split(' › ')[0]),
    portalPage: null,
    // The printed quote proposal (/PrintQuote, opened by Print Quote Proposal on a rated Quote &
    // Coverages), where TNI's quote ends (geico.js finishedBy), as Progressive's printed quote is
    // done (W48-03, W44-19: 0 of 53 GEICO quotes read as done though about 12 printed); or the
    // steps after Quote & Coverages: its stop steps, reached with a rated quote, the agent's from there.
    finalPage: new RegExp(`^/PrintQuote$|› (${stopSteps('geico').map(escape).join('|')})$`),
    finalClick: null,
    loginPage: LOGIN,
    // Its mock draws the quote with a script (test/fixtures/geico/mock.js): no static ids to compare.
    mock: null,
  },
};

export const REPORT_KEYS = ['quotePage', 'portalPage', 'finalPage', 'finalClick', 'loginPage', 'mock'];

/** The carrier's entry, or null for one the reports don't know (the local test page). */
export const reportsOf = (carrier) => CARRIER_REPORTS[carrier] ?? null;

/**
 * A fill run's blocker that says the carrier refused the quote: `stop: <name>` (the panel's, on a
 * carrier's stop) where the carrier's config marks that stop as its own: a stop page (Progressive's
 * DeclinationNotice) or a stop screen marked `stopped` (GEICO's referral). A stop step (GEICO's MVR &
 * CLUE) or a screen that is the agent's (GEICO's Add USDOT Number / Skip, an answer the intake lacks)
 * is no refusal (W48-03).
 * @param {string} carrier
 * @param {unknown} blocker
 */
export function carrierRefusal(carrier, blocker) {
  const name = /^stop: (.+)$/.exec(String(blocker ?? ''))?.[1];
  const config = name ? CARRIERS.find((c) => c.id === carrier) : null;
  if (!config) return false;
  return Object.hasOwn(config.stopPages ?? {}, name) || config.stopButtons?.[name]?.stopped === true;
}
