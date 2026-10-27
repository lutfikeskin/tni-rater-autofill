// @ts-check
// GEICO's part of TNI's rulebook (src/carriers/geico.js): its steps, options and GEICO-only
// standards, only those GEICO's rules fill as `standard` and docs/intake-and-rules.md records as
// TNI's (2026-10-21 and later). TNI's rules for every carrier are in general.js.

/** @import { RulebookPart } from '../../../types.js' */

/** @type {RulebookPart} */
export const geico = {
  title: 'GEICO Commercial Auto',
  sections: [
    { heading: 'Gateway (Start New Quote, Search Products)', rules: [
      { id: 'geico.product', kind: 'standard', text: 'On the gateway\'s Search Products window, the product is Commercial Auto/Trucking: its box is ticked, and no other product is touched.' },
    ] },
    { heading: 'Business Class & USDOT', rules: [
      { id: 'geico.business-description', kind: 'standard', text: 'An expediter or a general freight hauler (the business class: "Expediter", "Freight Hauler", "General Freight Hauler", "General Freight Hauling") is For Hire Trucking, and the more detailed description Other For-Hire Trucking (TNI standard); any other class is the agent\'s pick.' },
      { id: 'geico.team-driving', kind: 'standard', text: 'Team driving or slip seating: the intake\'s answer; blank is No (TNI standard), unless a line of the intake\'s notes mentions a team, slip seating or co-drivers: then the agent\'s.' },
      { id: 'geico.usdot-record', kind: 'agent', text: 'Whether GEICO\'s USDOT record is the client\'s business: Yes only when the record shows the intake\'s house number, every word of its street name and ZIP (code checks it); otherwise the agent\'s.' },
    ] },
    { heading: 'Vehicles', rules: [
      { id: 'geico.vehicle-type', kind: 'standard', text: 'Vehicle type: a cargo van (the intake\'s "Van" or "Cargo Van") is GEICO\'s Delivery Van, and a Semi Truck its Tractor (TNI standard); any other type is the agent\'s pick.' },
      { id: 'geico.customizations', kind: 'standard', text: 'Customizations: no attached equipment value on the intake (blank, or one that couldn\'t be read) is no customizations (TNI standard), and the customization value, wherever GEICO asks it (the vehicle form, each vehicle on Quote & Coverages, and the trailer form with the trailer equipment value), is 0. Both are the agent\'s when a line of the intake\'s notes mentions customizations, modifications to the vehicle, aftermarket parts, an upfit, custom-built work, or attached, installed or mounted equipment; freight wording such as "hauls construction equipment" isn\'t one.' },
      { id: 'geico.comp-coll', kind: 'standard', text: 'Comprehensive and collision are wanted on every vehicle and trailer (Yes), and each vehicle\'s comprehensive and collision rows on Quote & Coverages are a $1,000 deductible (TNI standard), unless a line of the intake\'s notes says no comp, no collision, no physical damage or liability only: then they are the agent\'s.' },
    ] },
    { heading: 'Drivers & Incidents', rules: [
      { id: 'geico.sr22', kind: 'standard', text: 'SR-22 (the owner\'s form and each Add Driver form): the intake\'s answer; blank is No (TNI standard), unless the intake\'s filings or a line of its notes name an SR-22, an FR-44 or financial responsibility: then the agent\'s.' },
      { id: 'geico.relationship', kind: 'standard', text: 'A driver\'s relationship to the business: Owner for one of the intake\'s owners; any other driver is an Employee (TNI standard).' },
    ] },
    { heading: 'Additional Business Info', rules: [
      { id: 'geico.employees', kind: 'standard', text: 'The number of employees is the intake\'s drivers besides the owner(s), as GEICO\'s band (none, 1, 2-3, …) (TNI standard).' },
      { id: 'geico.years-with-insurer', kind: 'standard', text: 'Years with the current auto insurer: 1-3 Years (TNI standard) when the intake shows a current auto policy (proof of prior insurance); otherwise the agent\'s.' },
      { id: 'geico.other-liability', kind: 'standard', text: 'The other liability insurance the business has: None (TNI standard), unless the intake shows a current GL policy (then GL) or the agent marked that the client has GL (then the agent\'s: GL or a business owner\'s policy).' },
      { id: 'geico.additional-insured', kind: 'standard', text: 'A named additional insured or waiver of subrogation, and a contract needing a blanket additional insured or blanket waiver of subrogation endorsement: No (TNI standard).' },
      { id: 'geico.filings', kind: 'standard', text: 'Whether the customer must provide proof of insurance or filings to a state or federal agency: the intake\'s answer; blank is No (TNI standard), unless the intake names filings or a line of its notes mentions one (BMC, MCS-90, Form E or H, or a filing): then the agent\'s. An SR-22 or FR-44 doesn\'t count there (GEICO\'s question excludes them).' },
    ] },
    { heading: 'Quote & Coverages', rules: [
      { id: 'geico.medpay-pip', kind: 'standard', text: 'In Florida, Medical Payments is Not Included (PIP covers it) and the PIP lists are left as GEICO has them. Elsewhere, where Basic Personal Injury Protection offers a limit (a choice with an amount, not "I decline"), it is $2,500 and Medical Payments is Not Included, PIP instead (TNI standard). A Basic PIP list with limits but not $2,500 is the agent\'s. With no PIP limit on the page, Medical Payments is Not Included where it offers no limit, and otherwise its limit is the agent\'s. The other PIP lists are the agent\'s.' },
      { id: 'geico.um', kind: 'standard', text: 'Uninsured motorist bodily injury (includes underinsured): $100,000 Combined Single Limit, in place of GEICO\'s pre-selection (TNI standard). Texas, which usually lists only split limits: $100,000/$300,000, or $100,000 Combined Single Limit when GEICO lists CSL limits only. Georgia and South Carolina\'s "Uninsured Motorist Bodily Injury (UMBI)" and South Carolina\'s "Underinsured Motorist Bodily Injury (UIMBI)": $100,000 Combined Single Limit. A state without that option leaves it to the agent.' },
      { id: 'geico.road-service', kind: 'standard', text: 'Road service is accepted on every vehicle (emergency road service, and heavy vehicle road service on a heavy truck: "I accept this coverage").' },
      { id: 'geico.fire-theft', kind: 'standard', text: 'Fire and theft: Not Included on every vehicle.' },
      { id: 'geico.rental', kind: 'standard', text: 'Rental reimbursement: $40 Per Day, $1,200 Max on every vehicle; it follows comprehensive and collision: with the intake\'s notes declining them it is the agent\'s.' },
      { id: 'geico.rental-downtime', kind: 'standard', text: 'Rental reimbursement with downtime: Not Included on every vehicle, unless a line of the intake\'s notes mentions downtime or rental: then the agent\'s.' },
      { id: 'geico.pay-plan', kind: 'standard', text: 'Pay plan: 11 Payments, one of the plans View More Payment Plans shows; where GEICO doesn\'t offer 11 Payments, the plan with the most payments it offers.' },
      { id: 'geico.cargo-questions', kind: 'standard', text: 'With cargo: mobile or modular homes, business documents or securities No, and live animals No, unless the intake\'s business class or what they haul names them as whole words (then the agent\'s).' },
      { id: 'geico.household-goods', kind: 'standard', text: 'Household goods or cotton ginned within 72 hours: Yes for a Household Goods Mover, and otherwise No, unless the business class, what they haul or a line of the notes mentions household goods, household moving (a home, residential or office move, a moving company) or cotton: then the agent\'s.' },
      { id: 'geico.reefer-breakdown', kind: 'standard', text: 'Refrigeration breakdown: Yes with a reefer on the intake\'s vehicles or trailers and No without one, when the intake doesn\'t answer it; an intake No with a reefer listed is the agent\'s.' },
      { id: 'geico.commodities', kind: 'intake', text: 'Cargo commodities (up to four) come from the business class and what they haul: a reefer (one listed, or refrigerated freight) is Consumer Goods - Pharmaceuticals (Over The Counter), Food & Beverage - Other Food & Beverages, Refrigerated Goods - Dairy and Refrigerated Goods - Frozen Seafood; an auto hauler (autos or cars, never their parts or accessories) Aircraft/Auto/Boats - Automobiles; general freight (General Freight Hauler, Consumer Goods, General Freight, Dry Freight, General) Consumer Goods - Other Consumer Goods. With no match they are the agent\'s, and the assistant may suggest one for the agent\'s approval.' },
      { id: 'geico.ntl', kind: 'workflow', text: 'Non-trucking liability: GEICO\'s Liability Coverage is Non-Trucking Liability, "Yes, under permanent lease" is clicked in the window GEICO opens, and the intake\'s limit goes in "Non Trucking Liability (NTL)" ($300,000 to $1,000,000 CSL). NTL mentioned in the notes and not yet answered leaves Liability Coverage and its limit to the agent.' },
      { id: 'geico.recalculate', kind: 'workflow', text: 'The Motor Truck Cargo card is opened when the intake asks for cargo. Once nothing on the step is left for the agent, the fill clicks Recalculate once a quote, then View More Payment Plans, picks the pay plan and clicks Print Quote Proposal. Next is the agent\'s.' },
    ] },
    { heading: 'The agent\'s', rules: [
      { id: 'geico.stop-steps', kind: 'agent', text: 'TNI stops a GEICO quote at Quote & Coverages and prints the quote proposal there: Final Quote Details, MVR & CLUE (whose reports cost the agency) and Payment Information are the agent\'s steps. The owner\'s Social Security number is never filled.' },
      { id: 'geico.not-carried-over', kind: 'agent', text: 'Progressive\'s and AmWINS\' other standards don\'t carry over: on GEICO a blank years in business, cargo deductible or GL limit is the agent\'s, and so are cost new, medical payments outside Florida where GEICO lists limits for it and no PIP, the uninsured motorist deductible, UM/UIM type, property damage liability, uninsured motorist property damage, the hired and non-owned auto questions and the GL follow-ups.' },
    ] },
  ],
};
