// @ts-check
// TNI's GEICO Personal Auto (sales.geico.com/quote) quoting rules (decided 2026-11-24).
// Every `standard` entry is named by the geico-pa carrier rule that fills it (`tni`);
// test/rulebook.test.mjs checks both ways.

/** @import { RulebookPart } from '../../../types.js' */

/** @type {RulebookPart} */
export const geicoPa = {
  title: 'TNI quoting rules for GEICO Personal Auto',
  sections: [
    { heading: 'Gateway', rules: [
      { id: 'geico-pa.product', kind: 'standard', text: 'Start quote on gateway2.geico.com: fill the 5-digit garaging ZIP and tick the Auto product box (TNI standard); Search Products and Start Quote stay with the agent.' },
    ] },
    { heading: 'Policyholder Information and Vehicle Prefill', rules: [
      { id: 'geico-pa.effective-date', kind: 'standard', text: 'Coverage start date on Policyholder Information: keep GEICO\'s prefilled default; if the box is empty, enter today\'s date (TNI standard).' },
      { id: 'geico-pa.acknowledgements', kind: 'standard', text: 'Required agent disclosure checkboxes (credit/consumer-report disclosure on Policyholder Information, All Drivers acknowledgement on Driver Information, and customer-advised checkbox on Quote Summary): checked (TNI standard).' },
      { id: 'geico-pa.vehicle-prefill', kind: 'standard', text: 'Vehicle Prefill: always select "Quote a different vehicle" and leave prefilled vehicle cards unchecked so intake vehicles are entered cleanly (TNI standard).' },
    ] },
    { heading: 'Current Insurance', rules: [
      { id: 'geico-pa.prior-provider', kind: 'standard', text: 'Current or prior auto insurance provider: map known carriers to GEICO\'s exact dropdown wording; when the intake names a carrier not on GEICO\'s list, select "Not Listed" (TNI standard).' },
      { id: 'geico-pa.years-with-insurer', kind: 'standard', text: 'Years with current auto provider (GiveYearsWithCurrentAutoInsurer): exact years and < 1 year map directly; closed year ranges use the lower bound (1-3 years -> 1, 3-5 years -> 3, 0 -> Less than 1, 11+ -> 11 or more), open-ended plus/over ranges use the first whole year above N capped at 11 or more (5+ years -> 6, 10+ years -> 11 or more), and month-to-year ranges starting under 12 months map to Less than 1 (TNI standard).' },
      { id: 'geico-pa.prior-bi-state-min', kind: 'standard', text: 'Current bodily injury limits (GiveCurrentBodilyInjuryLimits): keep GEICO\'s prefilled limit when present; when empty and the intake says "State Minimum" or "State Minimum or less", pick "State Minimum" if offered, otherwise pick the lowest offered split limit (skipping placeholders and "Not Sure" / unsure options) (TNI standard).' },
    ] },
    { heading: 'Vehicle Information', rules: [
      { id: 'geico-pa.ownership-length', kind: 'standard', text: 'Length of vehicle ownership: map intake "3+ years" to "2 to 10 years" regardless of vehicle age (TNI standard when the vehicle is 10 or more years old or its year is blank).' },
      { id: 'geico-pa.annual-mileage', kind: 'workflow', text: 'Estimated Annual Mileage: when the intake states annual miles, replace GEICO\'s estimate with the matching 1,000-mile band (after Primary Use settles); when blank on the intake, keep GEICO\'s auto-estimated mileage.' },
    ] },
    { heading: 'Driver Information', rules: [
      { id: 'geico-pa.military-gov', kind: 'standard', text: 'Government/Military Affiliations: "Does Not Apply" (TNI standard) unless the intake notes or driver occupation mention military, government, or postal employment.' },
      { id: 'geico-pa.license-status', kind: 'standard', text: 'Driver license status: "Active" (TNI standard) whenever the intake provides a driver\'s license number; leave for the agent when blank.' },
      { id: 'geico-pa.driver-insure', kind: 'standard', text: 'Insure this person? ("Do you want to insure [driver]?"): "Yes" (TNI standard) for listed household drivers unless the driver\'s license box or intake notes mark them excluded.' },
      { id: 'geico-pa.driver-discounts', kind: 'standard', text: 'Good student, student away from home, and voluntary defensive driver course (from mature driving course): "Yes" when the driver\'s intake box is ticked; "No" (TNI standard) when unticked and offered on screen.' },
      { id: 'geico-pa.employment', kind: 'agent', text: 'Employment status: clear non-employed statuses (Student, Homemaker, Unemployed, Retired) map to GEICO\'s wording, and specific employed occupations select "A Private Company/Organization or Self Employed" while Industry and Occupation stay with the agent; Disabled stays with the agent.' },
    ] },
    { heading: 'License History and Incidents', rules: [
      { id: 'geico-pa.license-history', kind: 'agent', text: 'License History: "licensed in the U.S. before turning X?" is derived only when date of birth, year licensed, and a US license state answer it unambiguously; boundary-year cases and non-US/missing/out-of-range drivers stay with the agent.' },
      { id: 'geico-pa.license-age', kind: 'standard', text: 'Age first licensed in the U.S. (GiveAgeFirstLicensed): year licensed minus birth year, subtracting 1 only when year licensed is the current year and the driver\'s birthday has not yet passed (TNI standard, guarded by US license state and 14 <= age <= current age).' },
      { id: 'geico-pa.license-month', kind: 'standard', text: 'Month/year first licensed in the U.S. (MonthYearAgeFirstLicensed): pick the earliest (top) non-placeholder month option offered after age first licensed loads (TNI standard).' },
      { id: 'geico-pa.incidents', kind: 'workflow', text: 'Select Drivers with Incidents has no form fields; when intake notes mention accidents, tickets, violations, DUIs, or suspensions, remind the agent to add them before advancing.' },
    ] },
    { heading: 'Groups or Organizations', rules: [
      { id: 'geico-pa.groups', kind: 'standard', text: 'Groups or Organizations: "Not a member of any of these organizations" (TNI standard) unless the intake notes mention a listed organization.' },
    ] },
    { heading: 'Quote Summary and Stops', rules: [
      { id: 'geico-pa.claim-forgiveness', kind: 'standard', text: 'Purchased Claim Forgiveness: "I decline" (TNI standard).' },
      { id: 'geico-pa.full-coverage-ers', kind: 'standard', text: 'Emergency Road Service (ERS): "I accept this coverage" on every full-coverage vehicle (TNI standard); keep GEICO\'s default on liability-only vehicles.' },
      { id: 'geico-pa.full-coverage-rental', kind: 'standard', text: 'Rental Reimbursement (RR): "$50/day, $1,500 max per claim" on every full-coverage vehicle (TNI standard); keep GEICO\'s default on liability-only vehicles.' },
      { id: 'geico-pa.optional-coverages', kind: 'workflow', text: 'Medical Payments stays at GEICO\'s default. Uninsured Motorist Bodily Injury (UMBI) and Property Damage (UMPD) are lowered to match BI and PD only when GEICO\'s current limit is higher than the requested BI/PD (never raised and never turned on from "I decline").' },
      { id: 'geico-pa.stops', kind: 'agent', text: 'Clear pre-quote steps (Policyholder Information through Groups or Organizations, including Vehicle Prefill) auto-advance via Next / Save and Continue; gateway2.geico.com never auto-advances. Vehicle Details, Driver Details, Communication Options, Payment Plan, and Payment Type are agent-only stop steps: nothing is filled or clicked there. On Quote Summary, Edit expands coverages once, the sticky-bar Recalculate re-rates when clear and verifies persisted values before Print Quote Proposal opens the proposal PDF (/PrintQuote) and ends the quote.' },
    ] },
  ],
};
