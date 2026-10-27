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
      { id: 'amwins.years', kind: 'standard', text: 'Years in business: the intake\'s years in business, else its years under own authority (5 or more is "5+"). Year established from the intake, else this year. When the form gives no year established, the intake reads the years in business its notes state ("in Biz for 3+ years" is 3, "over 3 years" or "about 3 years" is 3, "less than 1 year" or "under 1 year" is 0, months are whole years rounded down: "18 months" is 1, "less than 6 months" or "under 6 months" (up to 12) is 0, a number in words is its digits: "two years" is 2, "less than a year" or "under a year" is 0, years plus months are the whole years: "1 year 6 months" is 1, "a year" is 1, "half a year" is 0, "a year and a half" is 1, "less than a month" or "under a month" is 0, "first year in business" is 0, "a month" or "about a month" is 0, "1st year" is 0, "less than half a year" is 0, "second year in business" is 1, "one and a half years", "1 year and a half" or "1.5 years" is 1, rounded down, "a year-old business" is 1, "3-year-old business" is 3), which win over years under own authority, and the agent is asked to check them. A range gives an answer only when both ends give the same one ("18-20 months" is 1); otherwise ("2-3 years in business", "two to three years") the agent answers it. So does the agent when the notes state years in business in a way the intake doesn\'t read as one number ("a few years", "a couple of years", "almost 3 years", "less than 3 years", two figures that disagree, or such a statement beside a figure, as "In business for 3 years" with "several years in business"). None anywhere: 0 years ("New Venture"), established this year, and the agent is warned.' },
      { id: 'amwins.entity-type', kind: 'intake', text: 'Entity type from the company name: LLC, CORPORATION (Inc/Corp), or SOLE PROPRIETOR when there is no company name; a company name without a suffix is the agent\'s.' },
      { id: 'amwins.retail-nonprofit', kind: 'standard', text: 'Retail/service operations: 0%. Non-profit: No.' },
    ] },
    { heading: 'Business and prior insurance', rules: [
      { id: 'amwins.freight-class', kind: 'intake', text: 'Expediters and general freight haulers (cargo vans, box trucks): nature of business TRANSPORTATION, classification "484122 - General freight trucking, long-distance, less-than-truckload (LTL)" (AmWINS lists several 484122 results; this exact one), description of operations "Trucking for Hire - Other for hire trucking", vehicle usage FOR HIRE. Any other business class: all four are the agent\'s.' },
      { id: 'amwins.prior-carrier', kind: 'standard', text: 'Prior carrier: NO PRIOR for every prior year shown, also when the intake shows prior insurance (TNI standard, 2026-10-26); the prior policy goes in the disclosure details ("POP Commercial - <carrier> - <limit> - Exp Date <date>", a part the intake lacks left out; no "Exp Date" when the date box holds a remark, not a date).' },
      { id: 'amwins.filings', kind: 'intake', text: 'Filing counts: skipped. DOT / MC numbers from the intake. With filings required: federal authority active for = the years under own authority ("NEW", "New authority", "Brand new" or "New venture" there is LESS THAN 1 YEAR); BMC-91 and MCS-90 Yes for a federal liability filing; BMC-32 Yes only for a cargo filing.' },
      { id: 'amwins.federal-filing', kind: 'standard', text: 'Is a Federal Filing Required: the intake\'s Yes or No. Left blank: No (TNI standard), also when the intake says an SR-22 is needed, or its filings or notes name only state filings: an SR-22 or FR-44, also beside a Form E or H, the client\'s MC number or a bare or "additional" "filings" before or after it ("SR-22 and filings", "Filings and SR-22"); a Form E or H alone; a lone "State" in the which-filings box; or a state filing or intrastate, alone or beside the client\'s MC number; unless the intake names another filing or its notes mention one (anything federal: MCS-90, BMC-91, BMC-34, BMC-32, federal, ICC, an MC filing); then the agent\'s.' },
      { id: 'amwins.ntl', kind: 'standard', text: 'Non-trucking liability (NTL) quote (coverage.ntl Yes, unless the intake\'s auto liability is Yes too): Filing required No, and "Does the insured have a DOT or MC number?" without the DOT box and no DOT number (NONE when there is no MC number either), whatever the intake says (TNI standard), also when the client has a USDOT number (TNI, 2026-10-26).' },
      { id: 'amwins.ntl-undecided', kind: 'agent', text: 'NTL with primary auto liability too (auto liability Yes), or NTL mentioned in the claims box or notes and not answered yet: Filing required, the DOT box, the DOT number, NONE (without an MC number) and the federal filings are the agent\'s, never suggested (TNI, 2026-10-26).' },
      { id: 'amwins.current-carrier-tenure', kind: 'standard', text: 'How long with the current carrier (shown with a federal filing required, with or without a DOT or MC number): 1 TO 2 YEARS (TNI standard), unless the intake\'s notes give 2 years or more with the insurer: then its band (2 TO 3 YEARS from 2 up to 3 years, since a time on a band edge takes the upper band; MORE THAN 3 YEARS beyond; "about N years", "roughly N years" and hedges such as "~N", "approx. N", "Nish" or "N or so" count as N, while ">N", "N plus" and "N+" mean over N and "<N" under N; TNI, 2026-10-26 and 2026-10-27), or the agent\'s when either could fit; a range ("3-5 years") gets a band only when both ends fall in the same one, else it is the agent\'s (TNI, 2026-10-27). An expired policy, or a General Liability, Cargo or Other policy, with a time with the insurer in the notes: the agent\'s (TNI, 2026-10-26 and 2026-10-27).' },
      { id: 'amwins.loss-runs', kind: 'standard', text: 'Claim-free loss runs: No (TNI standard). Valued loss runs: No (TNI standard).' },
    ] },
    { heading: 'Drivers', rules: [
      { id: 'amwins.drivers', kind: 'intake', text: 'Marital status from the intake; none there is the agent\'s. AmWINS has no question for excluding a driver: a driver the intake marks excluded, or the owner\'s own driver row, the first, when the intake says the owner doesn\'t drive, gets "(Excluded)" after their license number ("12345678 (Excluded)"); with no license number on the intake, the agent types it.' },
    ] },
    { heading: 'Vehicles', rules: [
      { id: 'amwins.vehicle-import', kind: 'workflow', text: 'Vehicles: VIN list, Import Data, then Import Valid Records (that adds the vehicle: VIN, year, make, model, GVW from the VIN). Body type as on the intake (Van is Cargo Van), even when Import Data wrote something else; radius band from the intake ("Unlimited" is 201+ MILES); vehicle value from the intake.' },
      { id: 'amwins.vehicle-location', kind: 'standard', text: 'Vehicle location: the first location offered, the insured\'s.' },
      { id: 'amwins.equipment', kind: 'standard', text: 'Permanently attached equipment: No when the intake gives no equipment value, otherwise the agent\'s.' },
    ] },
    { heading: 'Coverages', rules: [
      { id: 'amwins.csl', kind: 'intake', text: 'CSL limit from the intake.' },
      { id: 'amwins.auto-symbol', kind: 'standard', text: 'Liability auto symbol 6 only.' },
      { id: 'amwins.medpay-pip', kind: 'standard', text: 'Medical payments $5,000. Personal Injury Protection (some states): No, because Medical Payments ($5,000) is offered and preferred; in every state, no-fault states too, since AmWINS, as the broker, picks the right coverage when it prepares the quote.' },
      { id: 'amwins.um', kind: 'standard', text: 'Uninsured motorists Yes with $100K.' },
      { id: 'amwins.comp-coll', kind: 'standard', text: 'Comprehensive and collision $1,000.' },
      { id: 'amwins.waiver-collision', kind: 'standard', text: 'Waiver of collision No.' },
      { id: 'amwins.towing', kind: 'standard', text: 'Towing and labor $75.' },
      { id: 'amwins.rental', kind: 'standard', text: 'Rental $40 day / $1,200 total.' },
      { id: 'amwins.no-exclusions', kind: 'standard', text: 'Nothing excluded (every "Exclude …" box unticked).' },
    ] },
    { heading: 'Underwriting', rules: [
      { id: 'amwins.underwriting-general', kind: 'standard', text: 'Underwriting questions: General Information via "Default all answers to No" (hazard exposure as below).' },
      { id: 'amwins.underwriting-second', kind: 'standard', text: 'The second underwriting section is No (vehicles not owned, vehicles leased, MVR verification, owned unscheduled vehicles, convictions / moving violations), whatever the intake says about ownership or claims; transporting hazardous material as below.' },
      { id: 'amwins.hazmat', kind: 'standard', text: 'Transporting hazardous material (underwriting): from the intake. Left blank: No (TNI standard), unless the intake says a hazardous material placard is required, or what they haul or its notes name something that may be hazardous (fuel, propane, chemicals and the like); then the agent\'s.' },
      { id: 'amwins.hazard-exposure', kind: 'standard', text: 'Hazard exposure (General Information: storing, treating, disposing or transporting hazardous material): Yes when the intake\'s hazmat answer is Yes; otherwise No (TNI standard), also when the hazmat box is blank and what they haul or the notes name hazardous goods.' },
      { id: 'amwins.disclose', kind: 'standard', text: '"Any other topics to disclose": Yes, with the disclosure details built from the intake (cargo, radius, trailers, proof of prior insurance).' },
    ] },
    { heading: 'Finishing', rules: [
      { id: 'amwins.save-continue', kind: 'workflow', text: 'Each step ends with Save & Continue once nothing is left for the agent. Never Save & Exit or Submit.' },
      { id: 'amwins.declaration', kind: 'agent', text: 'The declaration ("I declare that the information provided is true…") is always the agent\'s; the quote stops there.' },
    ] },
  ],
};
