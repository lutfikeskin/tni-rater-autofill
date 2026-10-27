// @ts-check
// AmWINS' part of TNI's rulebook (src/carriers/amwins.js): its pages, options and AmWINS-only
// standards. TNI's rules for every carrier are in general.js.

/** @import { RulebookPart } from '../../../types.js' */

/** @type {RulebookPart} */
export const amwins = {
  title: 'AmWINS Admitted Placement (Business Auto)',
  sections: [
    { heading: 'Start and applicant', rules: [
      { id: 'amwins.start', kind: 'workflow', text: 'Start on the Commercial Lines dashboard: Auto, risk state = the garaging state, Open New Application.' },
      { id: 'amwins.agency', kind: 'workflow', text: 'Agency Information (agency name, contact name, phone, email: the agency\'s own), website, DBA and effective/expiration dates: leave as the page has them.' },
      { id: 'amwins.contact', kind: 'standard', text: 'Contact Information (the inspection contact): the client\'s name (the owner\'s full name) and office phone only; single contact stays Yes.' },
      { id: 'amwins.additional-interest', kind: 'standard', text: 'Additional interest: No, also for financed or leased vehicles (a lienholder or lessor is added after the quote).' },
      { id: 'amwins.waiver-type', kind: 'standard', text: 'Waiver type: NONE.' },
      { id: 'amwins.named-insured', kind: 'standard', text: 'Named insured: the company name; with no company, the owner\'s full name. Owner name: the owner\'s full name. Garage address: same as mailing, and the garage street, city, state and ZIP boxes are the intake\'s garaging address.' },
      { id: 'amwins.years', kind: 'standard', text: 'Years in business: the intake\'s years in business, else its years under own authority (5 or more is "5+"). Year established from the intake, else this year. Both blank: 0 years ("New Venture"), established this year, and the agent is warned.' },
      { id: 'amwins.entity-type', kind: 'intake', text: 'Entity type from the company name: LLC, CORPORATION (Inc/Corp), or SOLE PROPRIETOR when there is no company name; a company name without a suffix is the agent\'s.' },
      { id: 'amwins.retail-nonprofit', kind: 'standard', text: 'Retail/service operations: 0%. Non-profit: No.' },
    ] },
    { heading: 'Business and prior insurance', rules: [
      { id: 'amwins.freight-class', kind: 'intake', text: 'Expediters and general freight haulers (cargo vans, box trucks): nature of business TRANSPORTATION, classification "484122 - General freight trucking, long-distance, less-than-truckload (LTL)" (AmWINS lists several 484122 results; this exact one), description of operations "Trucking for Hire - Other for hire trucking", vehicle usage FOR HIRE. Any other business class: all four are the agent\'s.' },
      { id: 'amwins.prior-carrier', kind: 'standard', text: 'Prior carrier: NO PRIOR for every prior year shown.' },
      { id: 'amwins.filings', kind: 'intake', text: 'Filing counts: skipped. DOT / MC numbers from the intake. With filings required: federal authority active for = the years under own authority; BMC-91 and MCS-90 Yes for a federal liability filing; BMC-32 Yes only for a cargo filing.' },
      { id: 'amwins.current-carrier-tenure', kind: 'standard', text: 'How long with the current carrier: 1 TO 2 YEARS (TNI standard).' },
      { id: 'amwins.loss-runs', kind: 'standard', text: 'Claim-free loss runs: No (TNI standard). Valued loss runs: No (TNI standard).' },
    ] },
    { heading: 'Drivers', rules: [
      { id: 'amwins.drivers', kind: 'intake', text: 'Marital status from the intake; none there is the agent\'s. AmWINS has no question for excluding a driver: a driver the intake marks excluded gets "(Excluded)" after their license number ("12345678 (Excluded)"); with no license number on the intake, the agent types it.' },
    ] },
    { heading: 'Vehicles', rules: [
      { id: 'amwins.vehicle-import', kind: 'workflow', text: 'Vehicles: VIN list, Import Data, then Import Valid Records (that adds the vehicle: VIN, year, make, model, GVW from the VIN). Body type as on the intake (Van is Cargo Van), even when Import Data wrote something else; radius band from the intake ("Unlimited" is 201+ MILES); vehicle value from the intake.' },
      { id: 'amwins.vehicle-location', kind: 'standard', text: 'Vehicle location: the first location offered, the insured\'s.' },
      { id: 'amwins.equipment', kind: 'standard', text: 'Permanently attached equipment: No when the intake gives no equipment value, otherwise the agent\'s.' },
    ] },
    { heading: 'Coverages', rules: [
      { id: 'amwins.csl', kind: 'intake', text: 'CSL limit from the intake.' },
      { id: 'amwins.auto-symbol', kind: 'standard', text: 'Liability auto symbol 6 only.' },
      { id: 'amwins.medpay-pip', kind: 'standard', text: 'Medical payments $5,000. Personal Injury Protection (some states): No, because Medical Payments ($5,000) is offered and preferred.' },
      { id: 'amwins.um', kind: 'standard', text: 'Uninsured motorists Yes with $100K.' },
      { id: 'amwins.comp-coll', kind: 'standard', text: 'Comprehensive and collision $1,000.' },
      { id: 'amwins.waiver-collision', kind: 'standard', text: 'Waiver of collision No.' },
      { id: 'amwins.towing', kind: 'standard', text: 'Towing and labor $75.' },
      { id: 'amwins.rental', kind: 'standard', text: 'Rental $40 day / $1,200 total.' },
      { id: 'amwins.no-exclusions', kind: 'standard', text: 'Nothing excluded (every "Exclude …" box unticked).' },
    ] },
    { heading: 'Underwriting', rules: [
      { id: 'amwins.underwriting-general', kind: 'standard', text: 'Underwriting questions: General Information via "Default all answers to No".' },
      { id: 'amwins.underwriting-second', kind: 'standard', text: 'The second underwriting section is No (vehicles not owned, vehicles leased, MVR verification, owned unscheduled vehicles, convictions / moving violations), whatever the intake says about ownership or claims; hazardous material from the intake.' },
      { id: 'amwins.disclose', kind: 'standard', text: '"Any other topics to disclose": Yes, with the disclosure details built from the intake (cargo, radius, trailers, proof of prior insurance).' },
    ] },
    { heading: 'Finishing', rules: [
      { id: 'amwins.save-continue', kind: 'workflow', text: 'Each step ends with Save & Continue once nothing is left for the agent. Never Save & Exit or Submit.' },
      { id: 'amwins.declaration', kind: 'agent', text: 'The declaration ("I declare that the information provided is true…") is always the agent\'s; the quote stops there.' },
    ] },
  ],
};
