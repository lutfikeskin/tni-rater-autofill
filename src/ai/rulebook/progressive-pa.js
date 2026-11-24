// @ts-check
// TNI's Progressive Personal Auto (ForAgentsOnly /Quote/Index/) quoting rules (decided 2026-11-24).
// Every `standard` entry is named by the progressive-pa carrier rule that fills it (tni);
// test/rulebook.test.mjs checks both ways.

/** @import { RulebookPart } from '../../../types.js' */

/** @type {RulebookPart} */
export const progressivePa = {
  title: 'TNI quoting rules for Progressive Personal Auto',
  sections: [
    { heading: 'Named Insured', rules: [
      { id: 'progressive-pa.phone-type', kind: 'standard', text: 'Phone type on Named Insured: Cell (TNI standard) whenever the intake provides a phone number.' },
      { id: 'progressive-pa.recently-moved', kind: 'standard', text: 'Has the insured moved in the last 2 months: Yes when the intake gives a prior address or time at address under 2 months; No when time at address is 2 months or more, or No (TNI standard) when both are blank.' },
      { id: 'progressive-pa.disclosure', kind: 'standard', text: 'Was the disclosure read or provided to the consumer: Yes (TNI standard).' },
    ] },
    { heading: 'Products', rules: [
      { id: 'progressive-pa.effective-date', kind: 'standard', text: 'Policy effective date: keep Progressive\'s prefilled default; if the box is empty, enter today\'s date (TNI standard).' },
      { id: 'progressive-pa.named-operator', kind: 'standard', text: 'Named operator / non-owner indicator: No (TNI standard) whenever vehicles are listed on the intake.' },
      { id: 'progressive-pa.vehicle-type', kind: 'standard', text: 'Vehicle type: "1981 & Newer - Autos, Pickups, Vans, and Utility Vehicles" when model year is 1981 or newer, or "Pre 1981 - Autos, Pickups, Vans, and Utility Vehicles" when older than 1981 (TNI standard).' },
      { id: 'progressive-pa.ownership-length', kind: 'standard', text: 'How long the customer has had the vehicle: exact match for 6 months - 1 year and 1 year - 3 years; "Less than 6 months" maps to "At least 1 month but less than 6 months" and "3+ years" maps to "At least 3 years but less than 5 years" (TNI standard).' },
      { id: 'progressive-pa.rideshare-delivery', kind: 'standard', text: 'Vehicle used for Rideshare/TNC and Vehicle used for Delivery (excluding Rideshare): No (TNI standard) unless the intake notes mention Uber, Lyft, rideshare, DoorDash, Instacart or delivery, in which case leave it for the agent.' },
      { id: 'progressive-pa.annual-mileage', kind: 'standard', text: 'Annual miles: map the intake mileage to Progressive\'s mileage band; when annual miles is blank on the intake, pick "8,000 - 9,999" (TNI standard).' },
    ] },
    { heading: 'Household Members', rules: [
      { id: 'progressive-pa.driver-status', kind: 'standard', text: 'Auto driver status: Rated (TNI standard) for every listed driver unless the intake notes or license box mark the driver excluded.' },
      { id: 'progressive-pa.second-named-insured', kind: 'standard', text: 'Auto second named insured: Yes for a Spouse and No for every other household member (TNI standard).' },
      { id: 'progressive-pa.license-type-status', kind: 'standard', text: 'Driver license type and status: Personal Auto and Valid (TNI standard) whenever the intake provides a driver\'s license number; leave both for the agent when the license number is blank.' },
      { id: 'progressive-pa.prefilled-license', kind: 'workflow', text: 'Driver license number: if Progressive prefills a license number automatically, leave it untouched; fill from the intake only when the box is empty.' },
      { id: 'progressive-pa.state-filing', kind: 'standard', text: 'State filing (SR-22 / FR-44): No (TNI standard) unless the intake notes mention SR-22, FR-44 or a state filing.' },
      { id: 'progressive-pa.driver-discounts', kind: 'standard', text: 'Good student, distant student and mature driver course: Yes when the driver\'s intake box is ticked; No (TNI standard) when unticked and the question is offered on screen.' },
      { id: 'progressive-pa.years-licensed', kind: 'agent', text: 'Years licensed comes from the intake\'s year licensed; when blank, leave it for the agent (never estimate from date of birth).' },
      { id: 'progressive-pa.employment', kind: 'agent', text: 'Employment and occupation: clear non-employed statuses (Student, Retired, Homemaker, Unemployed, Disabled) map from the intake\'s occupation; specific jobs stay with the agent.' },
    ] },
    { heading: 'Additional Details', rules: [
      { id: 'progressive-pa.all-drivers', kind: 'standard', text: 'Included all required drivers acknowledgement: Yes (TNI standard).' },
      { id: 'progressive-pa.paperless', kind: 'standard', text: 'Paperless documents and bills preference: Yes (TNI standard).' },
      { id: 'progressive-pa.total-residents', kind: 'standard', text: 'Total number of residents living in the home: the count of drivers listed on the intake (TNI standard), unless the intake notes mention additional household residents.' },
      { id: 'progressive-pa.no-additional-risks', kind: 'standard', text: 'Additional Details multi-policy / other risks: check "No additional risks apply" (TNI standard) and leave specific product checkboxes untouched.' },
    ] },
    { heading: 'Coverages', rules: [
      { id: 'progressive-pa.pvp', kind: 'standard', text: 'Progressive Vehicle Protection (PVP): None for every vehicle where offered (TNI standard).' },
      { id: 'progressive-pa.snapshot', kind: 'standard', text: 'Snapshot enrollment: Do Not Participate (TNI standard).' },
      { id: 'progressive-pa.policy-addons', kind: 'standard', text: 'Accident Forgiveness and Deductible Savings Bank: No (TNI standard).' },
      { id: 'progressive-pa.bill-plan', kind: 'standard', text: 'Bill plan: Pay With EFT (Pay With EFT From Checking) (TNI standard).' },
      { id: 'progressive-pa.optional-coverages', kind: 'workflow', text: 'UMBI, UMPD, Medical Payment, Rental, Roadside, Custom Parts and Payoff stay at Progressive\'s defaults; the agent adjusts them as needed.' },
      { id: 'progressive-pa.stops', kind: 'agent', text: 'Point of Sale and Final Sale are the agent\'s steps: nothing is filled or clicked there. With auto-advance on, clear steps move forward automatically from Named Insured through Coverages to Portfolio; Coverages clicks Recalculate when shown and Portfolio opens Email/Print and stops there.' },
    ] },
  ],
};
