// @ts-check
// TNI's rules for every carrier, as Luna reads them: decided once for all carriers. Luna gets this
// part and its own carrier's (src/ai/tni-rules.js). A `standard` entry is a TNI answer some carrier
// rule fills with `source: 'standard'` and names in `tni`; test/rulebook.test.mjs checks both ways.

/** @import { RulebookPart } from '../../../types.js' */

/** @type {RulebookPart} */
export const general = {
  title: 'TNI (Truckers National Insurance) quoting rules for every carrier',
  sections: [
    { heading: 'Every carrier', rules: [
      { id: 'general.intake-truth', kind: 'intake', text: 'The intake (the client\'s TNI Commercial Insurance Quote Application) is the source of truth for facts about the client. Never invent a fact the intake doesn\'t give.' },
      { id: 'general.standards-first', kind: 'workflow', text: 'Coverage and workflow questions the intake doesn\'t cover use TNI\'s standard answers in these rules. The page\'s own pre-selected answer is not always right: prefer the TNI rule.' },
      { id: 'general.client-facts', kind: 'agent', text: 'A fact about the client that the intake doesn\'t give (a driver\'s marital status, when the business was established, who a vehicle is registered to) is the agent\'s: leave it. There is no standard answer for a client fact, except the TNI standards these rules name.' },
      { id: 'general.agent-decides', kind: 'agent', text: 'The agent decides: MVR and CLUE report orders, anything the client must sign, attest or authorise, payment or bank details, and moving to another page.' },
      { id: 'general.cargo-deductible', kind: 'agent', text: 'Cargo with a limit but no deductible on the intake: the deductible is the client\'s, so the cargo limit and deductible are the agent\'s (the deductible is usually $1,000 or $2,500). AmWINS\' disclosure leaves the deductible out of its cargo line for the agent to add.' },
      { id: 'general.no-prior', kind: 'intake', text: 'A current-insurance carrier of "No", "None", "N/A" or "no POP" without an expiration date is no prior insurance, whatever type or limit the form shows; nothing about it is disclosed.' },
    ] },
    { heading: 'Drivers', rules: [
      { id: 'general.gender', kind: 'standard', text: 'A driver\'s gender: MALE (TNI standard) unless the client details set the driver\'s gender, then that.' },
      { id: 'general.year-licensed', kind: 'standard', text: 'The year a driver was first licensed: the birth year + 17 (TNI standard); with no readable date of birth it is the agent\'s.' },
      { id: 'general.owner-drives', kind: 'standard', text: 'Owner is a driver on the policy: the intake\'s answer. Left blank: Yes (TNI standard), unless the intake marks the owner\'s driver row excluded ("Excluded" in their license-number box); an excluded owner is not a driver (No), also when the intake says the owner drives (the agent confirms it). The owner\'s driver row is the first; another row\'s "Excluded" mark, even with the owner\'s name, changes nothing here. When the intake says the owner doesn\'t drive, the owner is an excluded driver: the owner\'s own driver row, the first, is treated as excluded, as an "Excluded" mark is.' },
      { id: 'general.owner-daily-ops', kind: 'standard', text: 'Owner involved in the daily operations of the business: Yes when the owner drives and is not excluded (same as "owner is a driver on the policy", so Yes when the intake leaves that blank: TNI standard); No when the owner does not drive or is excluded.' },
      { id: 'general.cdl-blank', kind: 'standard', text: 'Has a CDL: the intake\'s answer; left blank it is No (TNI standard), unless the intake gives a CDL year (then the agent\'s).' },
    ] },
    { heading: 'Operations', rules: [
      { id: 'general.hazmat-placard', kind: 'standard', text: 'Hazardous material placard: the intake\'s answer. Left blank: No (TNI standard), unless the intake says they haul hazardous material, or what they haul may need a placard (fuel, propane, chemicals and the like; on GEICO also a line of the intake\'s notes naming them); then the agent\'s.' },
    ] },
    { heading: 'Non-trucking liability', rules: [
      { id: 'general.ntl', kind: 'standard', text: 'Non-trucking liability (NTL): only when coverage.ntl is Yes (the intake\'s auto liability Non-Trucking, or the agent\'s answer); a claims-box mention alone is not a request. On an NTL quote the intake\'s liability limit goes to the carrier\'s NTL limit, never the auto liability limit, and "Is the customer under permanent lease to a motor carrier" is Yes (TNI standard).' },
    ] },
  ],
};
